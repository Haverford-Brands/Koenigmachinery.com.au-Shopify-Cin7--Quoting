import crypto from "crypto";
import axios from "axios";

const {
        SHOPIFY_WEBHOOK_SECRET,
        SHOPIFY_WEBHOOK_ALLOWED_SHOP,
        CIN7_BASE_URL,
        CIN7_USERNAME,
        CIN7_API_KEY,
        CIN7_DEFAULT_CURRENCY = "AUD",
} = process.env;

if (!SHOPIFY_WEBHOOK_SECRET) console.error("Missing SHOPIFY_WEBHOOK_SECRET");
if (!CIN7_USERNAME || !CIN7_API_KEY) console.error("Missing Cin7 credentials");

const CIN7_AUTH_HEADER = `Basic ${Buffer.from(
	`${CIN7_USERNAME}:${CIN7_API_KEY}`
).toString("base64")}`;

const MAX_EVENTS = 20;
const recentEvents = [];
function recordEvent(evt) {
	recentEvents.push(evt);
	if (recentEvents.length > MAX_EVENTS) recentEvents.shift();
}

function timingSafeEqual(a, b) {
	const ab = Buffer.from(a, "utf8");
	const bb = Buffer.from(b, "utf8");
	return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function verifyShopifyHmac(rawBody, headers) {
	const received =
		headers["x-shopify-hmac-sha256"] || headers["X-Shopify-Hmac-Sha256"];
	if (!received) return false;
	const digest = crypto
		.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
		.update(rawBody)
		.digest("base64");
	return timingSafeEqual(digest, received);
}

function allowedShop(headers) {
	if (!SHOPIFY_WEBHOOK_ALLOWED_SHOP) return true;
	const shop =
		headers["x-shopify-shop-domain"] || headers["X-Shopify-Shop-Domain"];
	return shop && shop.toLowerCase() === SHOPIFY_WEBHOOK_ALLOWED_SHOP.toLowerCase();
}

export function mapDraftOrderToCin7Quote(draft) {
	const cust = draft.customer || {};
	const ship = draft.shipping_address || {};
	const bill = draft.billing_address || {};
        const primaryEmail =
                draft.email || cust.email || bill.email || ship.email || null;
	const quote = {
		reference: draft.name || String(draft.id || ""),
		firstName: cust.first_name || bill.first_name || ship.first_name || "",
		lastName: cust.last_name || bill.last_name || ship.last_name || "",
		company:
			bill.company || ship.company || (cust.default_address?.company ?? ""),
                memberEmail: primaryEmail || undefined,
		phone: ship.phone || bill.phone || cust.phone || "",
		deliveryFirstName: ship.first_name || "",
		deliveryLastName: ship.last_name || "",
		deliveryCompany: ship.company || "",
		deliveryAddress1: ship.address1 || "",
		deliveryAddress2: ship.address2 || "",
		deliveryCity: ship.city || "",
		deliveryState: ship.province || "",
		deliveryPostalCode: ship.zip || "",
		deliveryCountry: ship.country || "",
		billingFirstName: bill.first_name || "",
		billingLastName: bill.last_name || "",
		billingCompany: bill.company || "",
		billingAddress1: bill.address1 || "",
		billingAddress2: bill.address2 || "",
		billingCity: bill.city || "",
		billingPostalCode: bill.zip || "",
		billingState: bill.province || "",
		billingCountry: bill.country || "",
		branchId: CIN7_BRANCH_ID ? Number(CIN7_BRANCH_ID) : undefined,
		internalComments: draft.note || null,
		currencyCode: draft.currency || CIN7_DEFAULT_CURRENCY,
		taxStatus: draft.taxes_included ? "Incl" : "Excl",
		discountTotal: draft.applied_discount?.amount
			? Number(draft.applied_discount.amount)
			: 0,
                discountDescription:
                        draft.applied_discount?.title ||
                        draft.applied_discount?.description ||
                        null,
                ...(draft.shipping_line?.price != null
                        ? {
                                freightTotal: Number(draft.shipping_line.price),
                                freightTaxRate:
                                        draft.taxes_included &&
                                        draft.shipping_line.tax_lines?.[0]?.rate != null
                                                ? Number(
                                                          draft.shipping_line.tax_lines[0].rate
                                                  ) * 100
                                                : undefined,
                          }
                        : {}),
                freightDescription: draft.shipping_line.title  || null,
                deliveryInstructions: draft.note || null,
                taxRate:
                        draft.taxes_included && draft.tax_lines?.[0]?.rate != null
                                ? Number(draft.tax_lines[0].rate) * 100
                                : undefined,
                lineItems: (draft.line_items || []).map((li, idx) => ({
                        code: li.sku || "",
                        name: li.title || "",
                        option1: li.variant_title || "",
                        qty: Number(li.quantity || 0),
                        unitPrice: li.price != null ? Number(li.price) : 0,
                        discount: li.applied_discount?.amount
                                ? Number(li.applied_discount.amount)
                                : 0,
                        taxRate:
                                draft.taxes_included && li.tax_lines?.[0]?.rate != null
                                        ? Number(li.tax_lines[0].rate) * 100
                                        : undefined,
                        sort: idx + 1,
                })),
	};
	Object.keys(quote).forEach((k) => {
		if (quote[k] === undefined || quote[k] === null || quote[k] === "")
			delete quote[k];
	});
	return quote;
}

function summarizeDraft(draft) {
	return {
		id: draft.id,
		name: draft.name,
		currency: draft.currency,
		taxes_included: draft.taxes_included,
		line_items: (draft.line_items || []).map((li) => ({
			sku: li.sku,
			title: li.title,
			qty: li.quantity,
			price: li.price,
		})),
	};
}

export default async function handler(req, res) {
        // GET: return captured events
        if (req.method === "GET") {
                return res.status(200).json({ events: recentEvents });
        }

	if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
	if (!allowedShop(req.headers)) return res.status(401).send("invalid shop");

	const reqId = req.headers["x-shopify-event-id"] || crypto.randomUUID();
	const shop = req.headers["x-shopify-shop-domain"] || "unknown";
	const topic = req.headers["x-shopify-topic"] || "unknown";
	const triggeredAt =
		req.headers["x-shopify-triggered-at"] || new Date().toISOString();

	const chunks = [];
	for await (const chunk of req)
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	const rawBody = Buffer.concat(chunks);

	if (!verifyShopifyHmac(rawBody, req.headers))
		return res.status(401).send("invalid hmac");

	let payload;
	try {
		payload = JSON.parse(rawBody.toString("utf8"));
	} catch {
		return res.status(400).send("invalid json");
	}
	const draft = payload.draft_order || payload;

	const capture = {
		id: reqId,
		receivedAt: new Date().toISOString(),
		shop,
		topic,
		triggeredAt,
		headers: {
			"x-shopify-topic": req.headers["x-shopify-topic"],
			"x-shopify-shop-domain": req.headers["x-shopify-shop-domain"],
			"x-shopify-event-id": req.headers["x-shopify-event-id"],
			"x-shopify-triggered-at": req.headers["x-shopify-triggered-at"],
		},
		body: draft,
	};
        capture.raw = rawBody.toString("utf8");
	recordEvent(capture);

        console.log(
                "shopify.draft.summary:",
                JSON.stringify({
                        tag: "shopify.draft.summary",
                        reqId,
                        shop,
                        topic,
                        triggeredAt,
                        draft: summarizeDraft(draft),
                })
        );

        console.log(
                "shopify.draft.full:",
                JSON.stringify({
                        tag: "shopify.draft.full",
                        reqId,
                        shop,
                        topic,
                        triggeredAt,
                        draft,
                })
        );

	try {
		const quote = mapDraftOrderToCin7Quote(draft);

                if (!quote.memberEmail) {
                        console.warn(
                                "cin7.precondition.missingEmail:",
                                JSON.stringify({
                                        tag: "cin7.precondition.missingEmail",
                                        reqId,
                                        reference: quote.reference,
                                        note: "No email found on draft/customer; Cin7 requires email when memberId is not provided.",
                                })
                        );
			return res.status(200).send("ok");
		}

		try {
			const r = await axios.get(`${CIN7_BASE_URL}/v1/Contacts`, {
				params: {
                                        fields: "id,email",
                                        where: `email='${quote.memberEmail}'`,
					rows: 1,
				},
				headers: { Authorization: CIN7_AUTH_HEADER },
				timeout: 8000,
			});
			const contact = Array.isArray(r.data) ? r.data[0] : null;
			if (contact?.id) quote.memberId = contact.id;
		} catch (e) {
                        console.warn(
                                "cin7.contact.lookup.failed:",
                                JSON.stringify({
                                        tag: "cin7.contact.lookup.failed",
                                        reqId,
                                        status: e.response?.status,
                                        message: e.message,
                                })
                        );
		}

                console.log(
                        "cin7.quote.preview:",
                        JSON.stringify({
                                tag: "cin7.quote.preview",
                                reqId,
                                reference: quote.reference,
                                hasEmail: !!quote.memberEmail,
                                memberId: quote.memberId || 0,
                                lineCount: quote.lineItems?.length || 0,
                                codes: (quote.lineItems || []).map((l) => l.code).filter(Boolean),
                        })
                );


                console.log(
                        "cin7.quote.request:",
                        JSON.stringify({
                                tag: "cin7.quote.request",
                                reqId,
                                payload: quote,
                        })
                );

                const cin7Res = await axios.post(
                        `${CIN7_BASE_URL}/v1/Quotes?loadboms=false`,
                        [quote],
                        {
                                headers: {
                                        Authorization: CIN7_AUTH_HEADER,
                                        "Content-Type": "application/json",
                                },
                                timeout: 10000,
                        }
                );
                console.log(
                        "cin7.quote.response:",
                        JSON.stringify({
                                tag: "cin7.quote.response",
                                reqId,
                                data: cin7Res.data,
                        })
                );

                const result = Array.isArray(cin7Res.data)
                        ? cin7Res.data[0]
                        : cin7Res.data;
                if (result?.success) {
                        console.log(
                                "cin7.quote.created:",
                                JSON.stringify({
                                        tag: "cin7.quote.created",
                                        reqId,
                                        reference: quote.reference,
                                        id: result.id,
                                })
                        );
                } else {
                        console.warn(
                                "cin7.quote.error:",
                                JSON.stringify({
                                        tag: "cin7.quote.error",
                                        reqId,
                                        reference: quote.reference,
                                        errors: result?.errors || [],
                                })
                        );
                }

                return res.status(200).send("ok");
	} catch (err) {
		console.error(
			"Cin7 error",
			err.response?.status,
			err.response?.data?.message || err.message
		);
		return res.status(502).send("cin7 error");
	}
}
