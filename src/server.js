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
        LOG_SHOPIFY_SUMMARY = "0",
        DEBUG_DRY_RUN = "0",
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

function logJson(level, tag, data) {
        console[level](`[${tag}]`, JSON.stringify({ tag, ...data }));
}

function mapDraftOrderToCin7Quote(draft) {
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
                email: primaryEmail || undefined,
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
                lineItems: (draft.line_items || []).map((li, idx) => {
                        const discountValue = li.applied_discount?.amount
                                ? Number(li.applied_discount.amount)
                                : 0;
                        const discountRate =
                                discountValue && li.price
                                        ? (discountValue / Number(li.price)) * 100
                                        : 0;
                        const line = {
                                code: li.sku || "",
                                name: li.title || "",
                                option1: li.variant_title || "",
                                qty: Number(li.quantity || 0),
                                unitPrice: li.price != null ? Number(li.price) : 0,
                                sort: idx + 1,
                        };
                        if (discountValue) {
                                line.discount = discountRate;
                                line.discountValue = discountValue;
                        }
                        return line;
                }),
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
	const res = await axios.post(url, payload, {
		headers: {
			Authorization: CIN7_AUTH_HEADER,
			"Content-Type": "application/json",
		},
		timeout: 15000,
	});
	return res.data;
}

const app = express();
const rawJson = express.raw({ type: "application/json" });

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.post("/webhooks/shopify/draft_orders/create", rawJson, async (req, res) => {
        const reqId = crypto.randomUUID();
        try {
                if (!allowedShop(req.headers)) return res.status(401).send("invalid shop");
                if (!verifyShopifyHmac(req.body, req.headers))
                        return res.status(401).send("invalid hmac");

                const draft =
                        JSON.parse(req.body.toString("utf8")).draft_order ||
                        JSON.parse(req.body.toString("utf8"));

                if (LOG_SHOPIFY_SUMMARY === "1") {
                        logJson("log", "shopify.draft.summary", {
                                reqId,
                                draft: summarizeDraft(draft),
                        });
                }

                logJson("log", "shopify.draft.full", { reqId, draft });

		const quote = mapDraftOrderToCin7Quote(draft);

                if (!quote.memberEmail) {
                        logJson("warn", "cin7.precondition.missingEmail", {
                                reqId,
                                reference: quote.reference,
                                note: "No email found on draft/customer; Cin7 requires email when memberId is not provided.",
                        });
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
                        logJson("warn", "cin7.contact.lookup.failed", {
                                reqId,
                                status: e.response?.status,
                                message: e.message,
                        });
                }

                if (LOG_SHOPIFY_SUMMARY === "1") {
                        logJson("log", "cin7.quote.preview", {
                                reqId,
                                reference: quote.reference,
                                hasEmail: !!quote.memberEmail,
                                memberId: quote.memberId || 0,
                                lineCount: quote.lineItems?.length || 0,
                                codes: (quote.lineItems || []).map((l) => l.code).filter(Boolean),
                        });
                }

                if (DEBUG_DRY_RUN === "1") return res.status(200).send("ok");

                await sendQuoteToCin7(quote);

                if (LOG_SHOPIFY_SUMMARY === "1") {
                        logJson("log", "cin7.quote.created", {
                                reqId,
                                reference: quote.reference,
                        });
                }

		return res.status(200).send("ok");
        } catch (err) {
                logJson("error", "webhook.handler.error", {
                        reqId,
                        status: err.response?.status,
                        message: err.response?.data || err.message,
                });
                return res.status(200).send("ok");
        }
});

app.listen(Number(PORT), () => {
        logJson("log", "server.listen", { port: Number(PORT) });
});
