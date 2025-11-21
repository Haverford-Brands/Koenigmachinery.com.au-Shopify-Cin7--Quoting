import crypto from "crypto";
import axios from "axios";

const {
        SHOPIFY_WEBHOOK_SECRET,
        SHOPIFY_WEBHOOK_ALLOWED_SHOP,
        CIN7_BASE_URL,
        CIN7_USERNAME,
        CIN7_API_KEY,
	CIN7_BRANCH_ID,
	CIN7_DEFAULT_INCLUSIVE_TAX_RATE,
	CIN7_DEFAULT_CURRENCY = "AUD",
} = process.env;

const CIN7_TAX_STATUS = "Excl";
const REQUIRED_DRAFT_TAG = "qteedy";

if (!SHOPIFY_WEBHOOK_SECRET) console.error("Missing SHOPIFY_WEBHOOK_SECRET");
if (!CIN7_USERNAME || !CIN7_API_KEY) console.error("Missing Cin7 credentials");

const CIN7_AUTH_HEADER = `Basic ${Buffer.from(
	`${CIN7_USERNAME}:${CIN7_API_KEY}`
).toString("base64")}`;

const CIN7_RATE_LIMITS = { perSecond: 3, perMinute: 60 };
const cin7RecentRequests = [];
const cin7Queue = [];
let cin7QueueProcessing = false;

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

function toNumber(value, fallback = 0) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : fallback;
}

function convertInclusiveAmount(amount, taxRatePercent) {
	const ratePercent = Number(taxRatePercent);
	if (!Number.isFinite(ratePercent)) return toNumber(amount);
	const rateDecimal = ratePercent / 100;
	if (!Number.isFinite(rateDecimal) || rateDecimal <= -1) return toNumber(amount);
	return Math.round((toNumber(amount) / (1 + rateDecimal)) * 100) / 100;
}

function normalizeTaxRateInput(rawValue) {
	const numeric = Number(rawValue);
	if (!Number.isFinite(numeric)) return undefined;
	if (numeric === 0) return 0;
	return Math.abs(numeric) > 1 ? numeric / 100 : numeric;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pruneCin7Recent(now = Date.now()) {
	while (cin7RecentRequests.length && now - cin7RecentRequests[0] > 60000) {
		cin7RecentRequests.shift();
	}
}

function cin7DelayUntilAllowed(now = Date.now()) {
	pruneCin7Recent(now);
	const secCutoff = now - 1000;
	const minuteCutoff = now - 60000;
	const secWindow = cin7RecentRequests.filter((t) => t > secCutoff);
	const minuteWindow = cin7RecentRequests.filter((t) => t > minuteCutoff);

	let delay = 0;
	if (secWindow.length >= CIN7_RATE_LIMITS.perSecond) {
		delay = Math.max(delay, 1000 - (now - secWindow[0]));
	}
	if (minuteWindow.length >= CIN7_RATE_LIMITS.perMinute) {
		delay = Math.max(delay, 60000 - (now - minuteWindow[0]));
	}
	return delay;
}

async function runCin7Queue() {
	if (cin7QueueProcessing) return;
	cin7QueueProcessing = true;
	while (cin7Queue.length) {
		const now = Date.now();
		const waitMs = cin7DelayUntilAllowed(now);
		if (waitMs > 0) {
			await sleep(waitMs);
			continue;
		}
		const task = cin7Queue.shift();
		cin7RecentRequests.push(Date.now());
		try {
			const result = await task.fn();
			task.resolve(result);
		} catch (err) {
			task.reject(err);
		}
	}
	cin7QueueProcessing = false;
}

function scheduleCin7Request(fn) {
	return new Promise((resolve, reject) => {
		cin7Queue.push({ fn, resolve, reject });
		runCin7Queue();
	});
}

async function cin7Request(config, context) {
	const maxAttempts = 4;
	let attempt = 0;
	let lastErr;
	while (attempt < maxAttempts) {
		attempt += 1;
		try {
			return await scheduleCin7Request(() => axios(config));
		} catch (err) {
			lastErr = err;
			const status = err.response?.status;
			const retryAfterHeader =
				err.response?.headers?.["retry-after"] ||
				err.response?.headers?.["Retry-After"];
			const retryAfterSeconds = Number(retryAfterHeader);
			const retryAfterMs = Number.isFinite(retryAfterSeconds)
				? retryAfterSeconds * 1000
				: null;
			const backoff =
				retryAfterMs ??
				Math.min(5000, 500 * attempt + Math.floor(Math.random() * 250));
			if (status === 429 || status >= 500) {
				if (attempt < maxAttempts) {
					console.warn(
						"cin7.retrying.error:",
						JSON.stringify({
							tag: "cin7.retrying",
							context,
							attempt,
							status,
							backoff,
						})
					);
					await sleep(backoff);
					continue;
				}
			}
			break;
		}
	}
	throw lastErr;
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
	const pairs = Array.from(raw.matchAll(/"([^"]+)"\s*:\s*"([^"]*)"/g));
	if (!pairs.length) return {};
	const out = {};
	for (const [, k, v] of pairs) out[k] = v;
	return out;
}

function parseTags(value) {
	if (Array.isArray(value)) return value.map((t) => String(t || "").trim());
	if (typeof value !== "string") return [];
	return value
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
}

function draftHasTag(draft, tag) {
	const target = typeof tag === "string" ? tag.trim().toLowerCase() : "";
	if (!target) return true;
	return parseTags(draft?.tags).some((t) => t.toLowerCase() === target);
}

export function mapDraftOrderToCin7Quote(draft) {
	const noteobjects = parseNoteFields(draft?.note);
	const cust = draft.customer || {};
	const ship = draft.shipping_address || {};
	const bill = draft.billing_address || {};
	const rawInternalComment =
		typeof draft.note === "string"
			? draft.note.trim()
			: draft.note != null
			? JSON.stringify(draft.note)
			: "";
	const deliveryNote =
		typeof noteobjects.note === "string" ? noteobjects.note.trim() : "";
	// ensure the order note (from Shopify) appears before the API note text
	const internalCommentsValue = [deliveryNote, rawInternalComment]
		.filter((value, index, arr) => value && arr.indexOf(value) === index)
		.join("\n\n");
        const primaryEmail =
                draft.email || cust.email || bill.email || ship.email || null;
	const sourceIsTaxInclusive = !!draft.taxes_included;
	const isTaxInclusive =
		sourceIsTaxInclusive && CIN7_TAX_STATUS === "Incl";
	const shouldConvertToExclusive =
		sourceIsTaxInclusive && CIN7_TAX_STATUS === "Excl";
	const {
		rate: defaultTaxRate,
		source: taxRateSource,
	} = resolveDefaultInclusiveTaxRate(draft);
	const shippingTaxRate =
		sourceIsTaxInclusive
			? taxRateFromLines(draft.shipping_line?.tax_lines) ?? defaultTaxRate
			: undefined;
	const freightTaxRate = isTaxInclusive ? shippingTaxRate : undefined;
	const quoteLevelTaxRate = isTaxInclusive ? defaultTaxRate : undefined;
	const orderDiscountRaw =
		draft.applied_discount?.amount != null
			? Number(draft.applied_discount.amount)
			: 0;
	const discountTotal =
		shouldConvertToExclusive &&
		orderDiscountRaw &&
		defaultTaxRate != null
			? convertInclusiveAmount(orderDiscountRaw, defaultTaxRate)
			: orderDiscountRaw;
	const freightSourceAmount =
		draft.shipping_line?.price != null
			? Number(draft.shipping_line.price)
			: undefined;
	const freightTotal =
		freightSourceAmount != null
			? shouldConvertToExclusive && shippingTaxRate != null
				? convertInclusiveAmount(freightSourceAmount, shippingTaxRate)
				: freightSourceAmount
			: undefined;
	const lineItems = (draft.line_items || []).map((li, idx) => {
		const sourceItemTaxRate =
			sourceIsTaxInclusive
				? taxRateFromLines(li?.tax_lines) ?? defaultTaxRate
				: undefined;
		const priceRaw = li.price != null ? Number(li.price) : 0;
		const discountRaw =
			li.applied_discount?.amount != null
				? Number(li.applied_discount.amount)
				: 0;
		const unitPrice =
			shouldConvertToExclusive && sourceItemTaxRate != null
				? convertInclusiveAmount(priceRaw, sourceItemTaxRate)
				: priceRaw;
		const discount =
			shouldConvertToExclusive &&
			discountRaw &&
			sourceItemTaxRate != null
				? convertInclusiveAmount(discountRaw, sourceItemTaxRate)
				: discountRaw;
		const item = {
			code: li.sku || "",
			name: li.title || "",
			option1: li.variant_title || "",
			qty: Number(li.quantity || 0),
			unitPrice,
			discount,
			sort: idx + 1,
		};
		if (isTaxInclusive && sourceItemTaxRate != null) {
			item.taxRate = sourceItemTaxRate;
		}
		return item;
	});
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
		internalComments: internalCommentsValue || undefined,
		currencyCode: draft.currency || CIN7_DEFAULT_CURRENCY,
		taxStatus: CIN7_TAX_STATUS,
		discountTotal,
                discountDescription:
                        draft.applied_discount?.title ||
                        draft.applied_discount?.description ||
                        null,
                ...(freightTotal != null
                        ? {
                                freightTotal,
                                ...(freightTaxRate != null
                                        ? { freightTaxRate }
                                        : {}),
                          }
                        : {}),
                freightDescription: draft.shipping_line?.title || null,
                ...(quoteLevelTaxRate != null ? { taxRate: quoteLevelTaxRate } : {}),
                lineItems,
	};
	if (sourceIsTaxInclusive && taxRateSource === "fallback") {
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
		if (!draftHasTag(draft, REQUIRED_DRAFT_TAG)) {
			console.warn(
				"shopify.draft.skip.missingTag:",
				JSON.stringify({
					tag: "shopify.draft.skip.missingTag",
					reqId,
					requiredTag: REQUIRED_DRAFT_TAG,
					reference: draft.name || draft.id || "",
					tags: draft.tags,
				})
			);
			return res.status(200).send("ok");
		}

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
			const r = await cin7Request(
				{
					method: "get",
					url: `${CIN7_BASE_URL}/v1/Contacts`,
					params: {
						fields: "id,email",
						where: `email='${quote.memberEmail}'`,
						rows: 1,
					},
					headers: { Authorization: CIN7_AUTH_HEADER },
					timeout: 8000,
				},
				{ action: "contact-lookup", reqId, reference: quote.reference }
			);
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

                const cin7Res = await cin7Request(
                        {
                                method: "post",
                                url: `${CIN7_BASE_URL}/v1/Quotes?loadboms=false`,
                                data: [quote],
                                headers: {
                                        Authorization: CIN7_AUTH_HEADER,
                                        "Content-Type": "application/json",
                                },
                                timeout: 10000,
                        },
                        { action: "create-quote", reqId, reference: quote.reference }
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
