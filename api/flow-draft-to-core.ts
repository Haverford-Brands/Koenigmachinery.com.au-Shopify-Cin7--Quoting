// api/flow-draft-to-omni.ts
// Convert a Shopify Draft Order/Order JSON to a Cin7 Omni Sales Order (v1)
// Omni base: https://api.cin7.com/api ; Endpoint: POST v1/SalesOrders
// Auth: HTTP Basic (username = Omni API Username, password = API Key)
// Rate limits: 3/sec, 60/min, 5000/day
// Dates: UTC "yyyy-MM-ddTHH:mm:ssZ" (no milliseconds)

export const config = { runtime: "edge" } as const;

type AnyObj = Record<string, any>;

function json(status: number, data: unknown) {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function toOmniUtc(iso?: string): string | undefined {
	if (!iso) return undefined;
	const d = new Date(iso);
	if (isNaN(d.getTime())) return undefined;
	// Trim milliseconds to match Omni sample format
	return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function round(n: unknown, dp = 4): number {
	const x = Number(n);
	if (!Number.isFinite(x)) return 0;
	const f = 10 ** dp;
	return Math.round((x + Number.EPSILON) * f) / f;
}

function safeStr(v: unknown): string | undefined {
	if (v == null) return undefined;
	const s = String(v).trim();
	return s ? s : undefined;
}

function env(k: string, def?: any) {
	return typeof process.env[k] === "string" && process.env[k]!.length
		? process.env[k]
		: def;
}

// --- Mapping ---
function mapShopifyDraftToOmniSO(draft: AnyObj): AnyObj {
	const bill = draft?.billing_address || {};
	const ship = draft?.shipping_address || {};
	const email = draft?.email || draft?.customer?.email || undefined;

	const firstName = bill?.first_name || ship?.first_name || undefined;
	const lastName = bill?.last_name || ship?.last_name || undefined;
	const company = bill?.company || ship?.company || undefined;

	const created =
		toOmniUtc(draft?.created_at) || toOmniUtc(new Date().toISOString());
	const taxesIncluded = Boolean(draft?.taxes_included);

	// Omni wants tax rate as percent (0..100). Prefer env, else try Shopify line tax_lines sum.
	let taxRatePct: number | undefined;
	if (process.env.OMNI_TAX_RATE) {
		const r = Number(process.env.OMNI_TAX_RATE); // decimal or percent accepted
		taxRatePct = r > 1 ? r : round(r * 100, 4);
	} else if (Array.isArray(draft?.line_items)) {
		const rates = draft.line_items.map((li: AnyObj) => {
			if (!Array.isArray(li?.tax_lines) || li.tax_lines.length === 0) return 0;
			const sum = li.tax_lines.reduce(
				(acc: number, t: AnyObj) => acc + Number(t?.rate || 0),
				0
			);
			return sum; // Shopify rate is decimal (e.g., 0.15)
		});
		const max = Math.max(0, ...rates);
		taxRatePct = round(max * 100, 4);
	}

	const lines = (draft?.line_items || []).map((li: AnyObj, idx: number) => {
		const code =
			safeStr(li?.sku) || safeStr(li?.variant_id) || `LINE-${idx + 1}`;
		return {
			// Minimal fields Omni accepts on insert
			code, // product option code (SKU)
			name: safeStr(li?.title),
			qty: round(li?.quantity, 4),
			unitPrice: round(li?.price, 4),
			barcode: safeStr(li?.barcode),
			styleCode: safeStr(li?.product_id), // fallback identifier
			sort: (idx + 1) * 10,
			// discount: 0, // uncomment if you want explicit per-line discount
		};
	});

	const so: AnyObj = {
		// Linking to a CRM member if present
		MemberEmail: email,
		// Contact on the order (display)
		FirstName: firstName,
		LastName: lastName,
		Company: company,
		Email: email,
		Phone: draft?.phone || draft?.customer?.phone || undefined,

		// Addresses (Delivery & Billing)
		DeliveryFirstName: ship?.first_name || undefined,
		DeliveryLastName: ship?.last_name || undefined,
		DeliveryCompany: ship?.company || undefined,
		DeliveryAddress1: ship?.address1 || undefined,
		DeliveryAddress2: ship?.address2 || undefined,
		DeliveryCity: ship?.city || undefined,
		DeliveryState: ship?.province || undefined,
		DeliveryPostalCode: ship?.zip || undefined,
		DeliveryCountry: ship?.country || ship?.country_code || undefined,

		BillingFirstName: bill?.first_name || undefined,
		BillingLastName: bill?.last_name || undefined,
		BillingCompany: bill?.company || undefined,
		BillingAddress1: bill?.address1 || undefined,
		BillingAddress2: bill?.address2 || undefined,
		BillingCity: bill?.city || undefined,
		BillingState: bill?.province || undefined,
		BillingPostalCode: bill?.zip || undefined,
		BillingCountry: bill?.country || bill?.country_code || undefined,

		// Order meta
		Reference: draft?.name || draft?.id?.toString?.(), // unique order ref; let Omni auto-gen if omitted
		CustomerOrderNo: draft?.name || undefined,
		CreatedDate: created,
		InvoiceDate: created,
		Stage: env("OMNI_STAGE", "New"),
		IsApproved: env("OMNI_IS_APPROVED", "true") !== "false",
		BranchId: env("OMNI_BRANCH_ID") ? Number(env("OMNI_BRANCH_ID")) : undefined,
		PaymentTerms: env("OMNI_PAYMENT_TERMS"),

		// Tax
		TaxStatus: taxesIncluded ? "Incl" : "Excl",
		TaxRate: typeof taxRatePct === "number" ? taxRatePct : undefined,

		// Currency (optional)
		CurrencyCode: env("OMNI_CURRENCY_CODE"),
		CurrencyRate: env("OMNI_CURRENCY_RATE")
			? Number(env("OMNI_CURRENCY_RATE"))
			: undefined,

		// Lines
		LineItems: lines,
	};

	// Remove empty/undefined
	Object.keys(so).forEach(
		(k) => (so as any)[k] == null && delete (so as any)[k]
	);
	return so;
}

function toBasicAuth(username?: string, password?: string): string | undefined {
	if (!username || !password) return undefined;
	const raw = `${username}:${password}`;
	// Edge-safe base64
	// @ts-ignore - btoa exists in edge runtime
	if (typeof btoa === "function") return `Basic ${btoa(raw)}`;
	// Fallback (Node):
	// @ts-ignore
	if (typeof Buffer !== "undefined")
		return `Basic ${Buffer.from(raw).toString("base64")}`;
	return undefined;
}

async function postOmniSalesOrders(list: AnyObj[]) {
	const base = (
		env("OMNI_BASE_URL", "https://api.cin7.com/api") as string
	).replace(/\/$/, "");
	const username = env("OMNI_USERNAME");
	const apiKey = env("OMNI_API_KEY") || env("OMNI_PASSWORD");
	const auth = toBasicAuth(username, apiKey);
	if (!auth)
		return {
			status: 500,
			body: { error: "Missing OMNI_USERNAME or OMNI_API_KEY" },
		};

	const loadboms = env("OMNI_LOAD_BOMS", "false");
	const url = `${base}/v1/SalesOrders?loadboms=${encodeURIComponent(loadboms)}`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: auth,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(list),
	});
	const text = await res.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {}
	return { status: res.status, body };
}

export default async function handler(req: Request) {
	if (req.method !== "POST") return json(405, { error: "Method Not Allowed" });

	// Optional shared secret (e.g., from Shopify Flow or internal callers)
	const wantSecret = env("FLOW_SHARED_SECRET");
	if (wantSecret) {
		const got = req.headers.get("X-Flow-Secret") || "";
		if (got !== wantSecret) return json(401, { error: "Unauthorized" });
	}

	let draft: AnyObj;
	try {
		draft = await req.json();
	} catch {
		return json(400, { error: "Invalid JSON body" });
	}

	if (!draft || !Array.isArray(draft?.line_items)) {
		return json(400, {
			error: "Body does not look like a Shopify Draft/Order JSON",
		});
	}

	try {
		const so = mapShopifyDraftToOmniSO(draft);
		const { status, body } = await postOmniSalesOrders([so]);

		if (status >= 200 && status < 300)
			return json(200, { ok: true, omni: body });
		if ([429, 500, 502, 503, 504].includes(status))
			return json(status, {
				error: "Omni temporary error",
				omni: body,
				sent: so,
			});
		return json(400, { error: "Omni rejected request", omni: body, sent: so });
	} catch (e: any) {
		return json(500, { error: e?.message || String(e) });
	}
}
