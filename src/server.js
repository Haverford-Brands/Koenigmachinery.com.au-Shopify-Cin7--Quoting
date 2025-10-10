import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const {
	SHOPIFY_WEBHOOK_SECRET,
	SHOPIFY_WEBHOOK_ALLOWED_SHOP,
	CIN7_BASE_URL,
	CIN7_USERNAME,
	CIN7_API_KEY,
	CIN7_BRANCH_ID,
	CIN7_DEFAULT_INCLUSIVE_TAX_RATE,
	CIN7_DEFAULT_CURRENCY = "AUD",
	PORT = 3000,
} = process.env;

if (!SHOPIFY_WEBHOOK_SECRET) throw new Error("Missing SHOPIFY_WEBHOOK_SECRET");
if (!CIN7_USERNAME || !CIN7_API_KEY)
	throw new Error("Missing Cin7 credentials");

const CIN7_AUTH_HEADER = `Basic ${Buffer.from(
	`${CIN7_USERNAME}:${CIN7_API_KEY}`
).toString("base64")}`;

const branchIdEnv = (() => {
	const raw = typeof CIN7_BRANCH_ID === "string" ? CIN7_BRANCH_ID.trim() : "";
	if (!raw || raw.toLowerCase() === "all") return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : undefined;
})();

function normalizeState(value) {
	const raw = typeof value === "string" ? value.trim() : "";
	if (!raw) return "";
	if (raw.toLowerCase() === "disabled") return "";
	return raw;
}

function cin7TaxRate(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric * 100 : undefined;
}

function normalizeTaxRateInput(rawValue) {
	const numeric = Number(rawValue);
	if (!Number.isFinite(numeric)) return undefined;
	if (numeric === 0) return 0;
	return Math.abs(numeric) > 1 ? numeric / 100 : numeric;
}

const fallbackInclusiveTaxRateInfo = (() => {
	const raw =
		typeof CIN7_DEFAULT_INCLUSIVE_TAX_RATE === "string"
			? CIN7_DEFAULT_INCLUSIVE_TAX_RATE.trim()
			: "";
	const effective = raw === "" ? "10" : raw;
	const decimal = normalizeTaxRateInput(effective);
	return {
		decimal: decimal != null ? decimal : 0.1,
		source: raw === "" ? "default" : "env",
	};
})();

const fallbackInclusiveTaxRate = cin7TaxRate(
	fallbackInclusiveTaxRateInfo.decimal
);

function extractRateFromLines(taxLines) {
	if (!Array.isArray(taxLines)) return undefined;
	for (const line of taxLines) {
		if (line?.rate != null) {
			const numeric = Number(line.rate);
			if (Number.isFinite(numeric)) return numeric;
		}
	}
	return undefined;
}

function taxRateFromLines(taxLines) {
	const rate = extractRateFromLines(taxLines);
	return rate != null ? cin7TaxRate(rate) : undefined;
}

function resolveDefaultInclusiveTaxRate(draft) {
	if (!draft?.taxes_included)
		return { rate: undefined, source: "exclusive" };

	const quoteLevel = taxRateFromLines(draft.tax_lines);
	if (quoteLevel != null) return { rate: quoteLevel, source: "order" };

	for (const item of draft.line_items || []) {
		const itemRate = taxRateFromLines(item?.tax_lines);
		if (itemRate != null) return { rate: itemRate, source: "line-item" };
	}

	const freight = taxRateFromLines(draft.shipping_line?.tax_lines);
	if (freight != null) return { rate: freight, source: "freight" };

	return { rate: fallbackInclusiveTaxRate, source: "fallback" };
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

function parseNoteFields(noteValue) {
	if (noteValue && typeof noteValue === "object") return { ...noteValue };
	const raw = typeof noteValue === "string" ? noteValue.trim() : "";
	if (!raw) return {};
	try {
		const o = JSON.parse(raw);
		return o && typeof o === "object" ? o : {};
	} catch (_) {}
	try {
		const o = JSON.parse(`{${raw}}`);
		return o && typeof o === "object" ? o : {};
	} catch (_) {}
	const pairs = Array.from(raw.matchAll(/"([^\"]+)"\s*:\s*"([^\"]*)"/g));
	if (!pairs.length) return {};
	const out = {};
	for (const [, k, v] of pairs) out[k] = v;
	return out;
}

// --- Your function with minimal changes -----------------------------------
export function mapDraftOrderToCin7Quote(draft) {
	const noteobjects = parseNoteFields(draft?.note); // <- new, non-mutating

	const cust = draft.customer || {};
	const ship = draft.shipping_address || {};
	const bill = draft.billing_address || {};
	const isTaxInclusive = !!draft.taxes_included;
	const {
		rate: defaultTaxRate,
		source: taxRateSource,
	} = resolveDefaultInclusiveTaxRate(draft);
	const freightTaxRate =
		isTaxInclusive
			? taxRateFromLines(draft.shipping_line?.tax_lines) ?? defaultTaxRate
			: undefined;
	const quoteLevelTaxRate = isTaxInclusive ? defaultTaxRate : undefined;

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
			deliveryState:
				normalizeState(ship.province) ||
				normalizeState(ship.province_code) ||
				normalizeState(cust.default_address?.province) ||
				normalizeState(cust.default_address?.province_code) ||
				"",
			deliveryPostalCode: ship.zip || "",
			deliveryCountry: ship.country || "",

			billingFirstName: bill.first_name || "",
			billingLastName: bill.last_name || "",
		billingCompany: bill.company || "",
		billingAddress1: bill.address1 || "",
			billingAddress2: bill.address2 || "",
			billingCity: bill.city || "",
			billingPostalCode: bill.zip || "",
			billingState:
				normalizeState(bill.province) ||
				normalizeState(bill.province_code) ||
				normalizeState(cust.default_address?.province) ||
				normalizeState(cust.default_address?.province_code) ||
				"",
			billingCountry: bill.country || "",

		...(branchIdEnv != null ? { branchId: branchIdEnv } : {}),

		// Keep as string; your inbound draft.note is a string already
		internalComments:
			typeof draft.note === "string" ? draft.note : JSON.stringify(draft.note),

		currencyCode: draft.currency || CIN7_DEFAULT_CURRENCY,
		taxStatus: draft.taxes_included ? "Incl" : "Excl",

		discountTotal: draft.applied_discount?.amount
			? Number(draft.applied_discount.amount)
			: 0,
		discountDescription: noteobjects.discounts || null,

		...(draft.shipping_line?.price != null
			? {
					freightTotal: Number(draft.shipping_line.price),
					...(freightTaxRate != null ? { freightTaxRate } : {}),
			  }
			: {}),

		freightDescription: draft.shipping_line.title || null,
		deliveryInstructions: noteobjects.note || null,

		...(quoteLevelTaxRate != null ? { taxRate: quoteLevelTaxRate } : {}),

		lineItems: (draft.line_items || []).map((li, idx) => ({
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

	if (quote.lineItems.length) {
		quote.lineItems = quote.lineItems.map((item, idx) => {
			const source = draft.line_items?.[idx];
			const itemTaxRate =
				isTaxInclusive
					? taxRateFromLines(source?.tax_lines) ?? defaultTaxRate
					: undefined;
			if (itemTaxRate != null) item.taxRate = itemTaxRate;
			return item;
		});
	}

	if (isTaxInclusive && taxRateSource === "fallback") {
		console.warn(
			"cin7.taxRate.fallback:",
			JSON.stringify({
				tag: "cin7.taxRate.fallback",
				reference: quote.reference,
				source: fallbackInclusiveTaxRateInfo.source,
				percent: Number(
					(fallbackInclusiveTaxRateInfo.decimal * 100).toFixed(3)
				),
			})
		);
	}

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
