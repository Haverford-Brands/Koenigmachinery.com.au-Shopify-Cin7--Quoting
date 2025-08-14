import express from "express";
import crypto from "crypto";
import axios from "axios";
import dotenv from "dotenv";

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
	throw new Error("Missing CIN7 credentials");

// Basic Auth header for Cin7 Omni
const CIN7_AUTH_HEADER = `Basic ${Buffer.from(
	`${CIN7_USERNAME}:${CIN7_API_KEY}`
).toString("base64")}`;

// In-memory idempotency store (use Redis/DB in production)
const processedEvents = new Map(); // eventId -> epoch ms
const EVENT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function markProcessed(eventId) {
	processedEvents.set(eventId, Date.now());
}

function isProcessed(eventId) {
	if (!eventId) return false;
	const ts = processedEvents.get(eventId);
	if (!ts) return false;
	if (Date.now() - ts > EVENT_TTL_MS) {
		processedEvents.delete(eventId);
		return false;
	}
	return true;
}

function sweepProcessed() {
	const now = Date.now();
	for (const [id, ts] of processedEvents.entries()) {
		if (now - ts > EVENT_TTL_MS) processedEvents.delete(id);
	}
}
setInterval(sweepProcessed, 60 * 60 * 1000).unref();

// Verify HMAC using raw body bytes
function verifyShopifyHmac(req) {
	const receivedHmac =
		req.get("X-Shopify-Hmac-Sha256") || req.get("x-shopify-hmac-sha256");
	if (!receivedHmac) return false;
	const digest = crypto
		.createHmac("sha256", SHOPIFY_APP_SECRET)
		.update(req.body)
		.digest("base64");
	// timing safe compare
	const a = Buffer.from(digest, "utf8");
	const b = Buffer.from(receivedHmac, "utf8");
	return a.length === b.length && crypto.timingSafeEqual(a, b);
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
		email: draft.email || cust.email || "",
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

		// Stage is optional; defaults to "New" in Cin7. You may set it via environment/config if needed.
		// stage: 'New',

		lineItems: (draft.line_items || []).map((li, idx) => ({
			// NOTE: Cin7 prefers Code or ProductOptionId to link to products.
			// Ensure Cin7 product codes match Shopify SKUs.
			code: li.sku || "",
			name: li.title || "",
			option1: li.variant_title || "",
			qty: Number(li.quantity || 0),
			unitPrice: li.price != null ? Number(li.price) : 0,
			discount: li.applied_discount?.amount
				? Number(li.applied_discount.amount)
				: 0,
			sort: idx + 1,
		})),
	};

	// Remove undefined/null top-level keys that Cin7 may not like
	Object.keys(quote).forEach((k) => {
		if (quote[k] === undefined || quote[k] === null || quote[k] === "")
			delete quote[k];
	});
	return quote;
}

async function sendQuoteToCin7(quote) {
	const url = `${CIN7_BASE_URL}/v1/Quotes?loadboms=false`;
	const payload = [quote]; // Cin7 expects a list for POST
	const res = await axios.post(url, payload, {
		headers: {
			Authorization: CIN7_AUTH_HEADER,
			"Content-Type": "application/json",
		},
		// Cin7 limits: 3/sec, 60/min, 5000/day (single call here)
		timeout: 15000,
	});
	return res.data;
}

function validateShopHeader(req) {
	if (!SHOPIFY_ALLOWED_SHOP) return true;
	const shop =
		req.get("X-Shopify-Shop-Domain") || req.get("x-shopify-shop-domain");
	return shop && shop.toLowerCase() === SHOPIFY_ALLOWED_SHOP.toLowerCase();
}

// Build Express app
const app = express();

// Use raw parser only for Shopify webhook routes to preserve body for HMAC
const rawJson = express.raw({ type: "application/json" });

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Draft Orders → Create → push to Cin7 Quote
app.post("/webhooks/shopify/draft_orders/create", rawJson, async (req, res) => {
	try {
		if (!validateShopHeader(req)) {
			return res.status(401).send("invalid shop");
		}
		if (!verifyShopifyHmac(req)) {
			return res.status(401).send("invalid hmac");
		}

		// Dedupe via Event-Id header (recommended by Shopify)
		const eventId =
			req.get("X-Shopify-Event-Id") || req.get("x-shopify-event-id");
		if (isProcessed(eventId)) {
			// Already handled, ack quickly
			return res.status(200).send("duplicate ignored");
		}

		// Parse after HMAC check
		const draft =
			JSON.parse(req.body.toString("utf8")).draft_order ||
			JSON.parse(req.body.toString("utf8"));

		// Acknowledge within 5s, then process out-of-band
		res.status(200).send("ok");

		// Process asynchronously
		try {
			const quote = mapDraftOrderToCin7Quote(draft);
			const cin7Response = await sendQuoteToCin7(quote);
			markProcessed(eventId);
			console.log("Cin7 Quote created:", JSON.stringify(cin7Response));
		} catch (err) {
			// NOTE: implement retry/queue here in production
			console.error(
				"Failed to send quote to Cin7:",
				err.response?.status,
				err.response?.data || err.message
			);
		}
	} catch (err) {
		// If anything unexpected happens before ack, still try to ack fast
		try {
			res.status(200).send("ok");
		} catch (_) {}
		console.error("Webhook handler error:", err);
	}
});

app.listen(Number(PORT), () => {
	console.log(`Webhook server listening on :${PORT}`);
});
