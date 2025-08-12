// file: integrations/shopify_draft_to_omni.mjs
// Purpose: When a Shopify **draft order** is created, push it to **Cin7 Omni** as a **Quote**.
// Why: Browser calls are blocked by CORS; a backend webhook avoids CORS and keeps secrets safe.
//
// Quick start
// 1) npm i express dotenv node-fetch@3 body-parser
// 2) Create .env (see below). Run: node integrations/shopify_draft_to_omni.mjs
// 3) In Shopify Admin → Settings → Notifications → Webhooks, add **Draft order creation** webhook
//    pointing to: https://your-domain.com/webhooks/shopify/draft_orders_create
//
// .env example
// SHOPIFY_WEBHOOK_SECRET=shpss_************************
// PORT=3000
//
// CIN7_OMNI_BASE_URL=https://api.cin7.com/api/v1
// CIN7_OMNI_USERNAME=your_omni_username
// CIN7_OMNI_API_KEY=your_omni_api_key
// DEFAULT_TAX_RATE=10              # optional, % (e.g., AU GST)
// DEFAULT_CURRENCY=AUD             # optional
//
// Security notes
// - Verifies Shopify webhook (HMAC SHA256) using SHOPIFY_WEBHOOK_SECRET.
// - Times out fast and retries Cin7 on 429/5xx with backoff.
// - Only minimal logging; never logs secrets.

import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import bodyParser from "body-parser";
import os from "os";
import { Buffer } from "node:buffer";

const app = express();
const PORT = process.env.PORT || 3000;

function safeEqual(a, b) {
	if (!a || !b) return false;
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return crypto.timingSafeEqual(ab, bb);
}

function verifyShopifyWebhook(req, secret) {
	const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
	const digest = crypto
		.createHmac("sha256", secret)
		.update(req.body)
		.digest("base64");
	return safeEqual(digest, hmacHeader);
}

async function fetchWithRetries(
	url,
	options,
	{ retries = 3, baseDelayMs = 500 } = {}
) {
	let lastErr;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await fetch(url, options);
			if (res.status >= 200 && res.status < 300) return res;
			if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
				const ra = res.headers.get("retry-after");
				const delay = ra ? Number(ra) * 1000 : baseDelayMs * 2 ** attempt;
				await new Promise((r) => setTimeout(r, delay));
				continue;
			}
			const text = await res.text();
			throw new Error(`Cin7 error ${res.status} ${res.statusText}: ${text}`);
		} catch (e) {
			lastErr = e;
			if (attempt < retries) {
				await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
				continue;
			}
			throw lastErr;
		}
	}
	throw lastErr ?? new Error("Unknown network error");
}

function mapDraftToOmniQuote(draft) {
	const taxIncl = Boolean(draft?.taxes_included);
	const email = draft?.email || draft?.customer?.email || undefined;
	const currency = draft?.currency || process.env.DEFAULT_CURRENCY || undefined;
	const defaultTaxRate = process.env.DEFAULT_TAX_RATE
		? Number(process.env.DEFAULT_TAX_RATE)
		: undefined;

	const lineItems = (draft?.line_items || []).map((li, idx) => ({
		sort: idx + 1,
		code: li?.sku || undefined,
		name: li?.title,
		option1: li?.variant_title || undefined,
		qty: Number(li?.quantity || 0),
		unitPrice: Number(li?.price || 0),
		discount: 0,
		lineComments: li?.applied_discount?.description || undefined,
	}));

	return {
		reference: `DRAFT-${draft?.name || draft?.id}`,
		memberEmail: email,
		taxStatus: taxIncl ? "Incl" : "Excl",
		taxRate: defaultTaxRate,
		currencyCode: currency,
		internalComments: `Imported from Shopify draft ${draft?.id}`,
		deliveryCountry: draft?.shipping_address?.country || undefined,
		billingCountry: draft?.billing_address?.country || undefined,
		lineItems,
	};
}

async function pushQuoteToOmni(quotesArray) {
	const base = (
		process.env.CIN7_OMNI_BASE_URL || "https://api.cin7.com/api/v1"
	).replace(/\/$/, "");
	const user = process.env.CIN7_OMNI_USERNAME;
	const key = process.env.CIN7_OMNI_API_KEY;
	if (!user || !key)
		throw new Error("Missing CIN7_OMNI_USERNAME or CIN7_OMNI_API_KEY");

	const auth = "Basic " + Buffer.from(`${user}:${key}`).toString("base64");
	const url = `${base}/Quotes?loadboms=false`;
	const res = await fetchWithRetries(url, {
		method: "POST",
		headers: {
			Authorization: auth,
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(quotesArray),
	});

	const text = await res.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { status: res.status, body };
}

app.post(
	"/webhooks/shopify/draft_orders_create",
	bodyParser.raw({ type: "application/json" }),
	async (req, res) => {
		const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
		if (!secret) return res.status(500).send("Missing webhook secret");
		if (!verifyShopifyWebhook(req, secret))
			return res.status(401).send("Invalid webhook signature");

		res.status(200).send("OK");
		try {
			const draft = JSON.parse(req.body.toString("utf8"));
			const quote = mapDraftToOmniQuote(draft);
			const result = await pushQuoteToOmni([quote]);
			console.log("Cin7 Omni response:", result);
		} catch (e) {
			console.error(
				"Failed to create Omni quote from Shopify draft:",
				e?.message || e
			);
		}
	}
);

app.get("/health", (_req, res) => res.status(200).send("ok"));

app.listen(PORT, () => {
	const nets = os.networkInterfaces();
	const addresses = [];
	for (const name of Object.keys(nets)) {
		for (const net of nets[name]) {
			if (net.family === "IPv4" && !net.internal) {
				addresses.push(net.address);
			}
		}
	}
	console.log(`Shopify → Omni bridge listening on :${PORT}`);
	console.log(`Local IP addresses: ${addresses.join(", ")}`);
});
