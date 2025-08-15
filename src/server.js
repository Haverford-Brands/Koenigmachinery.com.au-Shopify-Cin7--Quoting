import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const {
        SHOPIFY_APP_SECRET,
        SHOPIFY_ALLOWED_SHOP,
        CIN7_BASE_URL = "https://api.cin7.com/api",
        CIN7_USERNAME,
        CIN7_API_KEY,
        CIN7_BRANCH_ID,
        CIN7_DEFAULT_CURRENCY = "USD",
        PORT = 3000,
} = process.env;

if (!SHOPIFY_APP_SECRET) throw new Error("Missing SHOPIFY_APP_SECRET");
if (!CIN7_USERNAME || !CIN7_API_KEY)
	throw new Error("Missing Cin7 credentials");

const CIN7_AUTH_HEADER = `Basic ${Buffer.from(
	`${CIN7_USERNAME}:${CIN7_API_KEY}`
).toString("base64")}`;

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
		.createHmac("sha256", SHOPIFY_APP_SECRET)
		.update(rawBody)
		.digest("base64");
	return timingSafeEqual(digest, received);
}

function allowedShop(headers) {
	if (!SHOPIFY_ALLOWED_SHOP) return true;
	const shop =
		headers["x-shopify-shop-domain"] || headers["X-Shopify-Shop-Domain"];
	return shop && shop.toLowerCase() === SHOPIFY_ALLOWED_SHOP.toLowerCase();
}

function mapDraftOrderToCin7Quote(draft) {
	const cust = draft.customer || {};
	const ship = draft.shipping_address || {};
	const bill = draft.billing_address || {};
	const quote = {
		reference: draft.name || String(draft.id || ""),
		firstName: cust.first_name || bill.first_name || ship.first_name || "",
		lastName: cust.last_name || bill.last_name || ship.last_name || "",
		company:
			bill.company || ship.company || (cust.default_address?.company ?? ""),
                memberEmail: draft.email || cust.email || "",
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
                freightDescription: draft.shipping_line.title || null,
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

async function sendQuoteToCin7(quote) {
        const url = `${CIN7_BASE_URL}/v1/Quotes?loadboms=false`;
        const payload = [quote];
        console.log(
                "cin7.quote.request:",
                JSON.stringify({
                        tag: "cin7.quote.request",
                        payload: quote,
                })
        );

        const res = await axios.post(url, payload, {
                headers: {
                        Authorization: CIN7_AUTH_HEADER,
                        "Content-Type": "application/json",
                },
                timeout: 15000,
        });
        console.log(
                "cin7.quote.response:",
                JSON.stringify({
                        tag: "cin7.quote.response",
                        data: res.data,
                })
        );

        return res.data;
}

const app = express();
const rawJson = express.raw({ type: "application/json" });

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.post("/webhooks/shopify/draft_orders/create", rawJson, async (req, res) => {
	try {
		if (!allowedShop(req.headers)) return res.status(401).send("invalid shop");
		if (!verifyShopifyHmac(req.body, req.headers))
			return res.status(401).send("invalid hmac");

                const draft =
                        JSON.parse(req.body.toString("utf8")).draft_order ||
                        JSON.parse(req.body.toString("utf8"));


                console.log(
                        "shopify.draft.summary:",
                        JSON.stringify({
                                tag: "shopify.draft.summary",
                                draft: summarizeDraft(draft),
                        })
                );

                console.log(
                        "shopify.draft.full:",
                        JSON.stringify({

                                tag: "shopify.draft.full",
                                draft,
                        })
                );

		const quote = mapDraftOrderToCin7Quote(draft);

                if (!quote.memberEmail) {
                        console.warn(
                                "cin7.precondition.missingEmail:",
                                JSON.stringify({
                                        tag: "cin7.precondition.missingEmail",
                                        reference: quote.reference,
                                        note: "No email found on draft/customer; Cin7 requires email when memberId is not provided.",
                                })
                        );
			return res.status(200).send("ok");
                }

                // Try to resolve memberId by email
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
                                        status: e.response?.status,
                                        message: e.message,
                                })
                        );
                }

                console.log(
                        "cin7.quote.preview:",
                        JSON.stringify({
                                tag: "cin7.quote.preview",
                                reference: quote.reference,
                                hasEmail: !!quote.memberEmail,
                                memberId: quote.memberId || 0,
                                lineCount: quote.lineItems?.length || 0,
                                codes: (quote.lineItems || []).map((l) => l.code).filter(Boolean),
                        })
                );


                const data = await sendQuoteToCin7(quote);
                const result = Array.isArray(data) ? data[0] : data;
                if (result?.success) {
                        console.log(
                                "cin7.quote.created:",
                                JSON.stringify({
                                        tag: "cin7.quote.created",
                                        reference: quote.reference,
                                        id: result.id,
                                })
                        );
                } else {
                        console.warn(
                                "cin7.quote.error:",
                                JSON.stringify({
                                        tag: "cin7.quote.error",
                                        reference: quote.reference,
                                        errors: result?.errors || [],
                                })
                        );
                }

                return res.status(200).send("ok");
        } catch (err) {
                console.error(
                        "Webhook handler error:",
                        err.response?.status,

			err.response?.data || err.message
		);
		return res.status(200).send("ok");
	}
});

app.listen(Number(PORT), () => {
	console.log(`Webhook server listening on :${PORT}`);
});
