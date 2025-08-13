// api\flow-draft-to-core.ts
// This API endpoint converts a Shopify Draft Order to a Core Sale
// https://api.cin7.com/api
export const config = { runtime: "edge" } as const;

type AnyObj = Record<string, any>;

function json(status: number, data: unknown) {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function fmtDateYYYYMMDD(iso?: string): string | undefined {
	if (!iso) return undefined;
	const d = new Date(iso);
	if (isNaN(d.getTime())) return undefined;
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	return `${y}/${m}/${day}`;
}

function round(n: number, dp = 2) {
        const f = Math.pow(10, dp);
        return Math.round((n + Number.EPSILON) * f) / f;
}

function num(value: any): number | undefined {
        const n = Number(value);
        return isNaN(n) ? undefined : n;
}

function num(value: any): number | undefined {
	const n = Number(value);
	return isNaN(n) ? undefined : n;
}

function mapDraftToCoreSale(draft: AnyObj): AnyObj {
        const env = (k: string, def?: any) =>
                typeof process.env[k] === "string" && process.env[k]!.length
                        ? process.env[k]
			: def;

        const taxRule = env("CORE_TAX_RULE", "Tax on Sales");
        const taxRate = num(process.env.CORE_TAX_RATE); // e.g. 0.10
	const orderDate =
		fmtDateYYYYMMDD(draft?.created_at) ||
		fmtDateYYYYMMDD(new Date().toISOString());

	const ship = draft?.shipping_address || {};
	const bill = draft?.billing_address || {};

	const customerName =
		[bill?.first_name, bill?.last_name].filter(Boolean).join(" ") ||
		draft?.email ||
		"Draft Customer";
	const contact =
		[ship?.first_name, ship?.last_name].filter(Boolean).join(" ") ||
		customerName;

        const lines = (draft?.line_items || []).map((li: AnyObj, idx: number) => {
                const qty = num(li?.quantity) ?? 0;
                const price = num(li?.price) ?? 0;
                const baseTotal = round(price * qty, 2);
                const tax =
                        typeof taxRate === "number" ? round(baseTotal * taxRate, 2) : undefined;
                return {
                        SKU: li?.sku || li?.variant_id?.toString?.() || `LINE-${idx + 1}`,
                        Quantity: qty,
                        Price: price,
                        ...(tax !== undefined ? { Tax: tax } : {}),
                        Total: baseTotal, // API accepts Total per sample
                        TaxRule: taxRule,
                        DropShip: false,
                        Discount: 0,
                        Comment: li?.title || undefined,
                };
        });

        const currencyRate = num(env("CORE_CURRENCY_RATE"));

	const payload: AnyObj = {
		Customer: customerName,
		Contact: contact,
		Phone: draft?.phone || draft?.customer?.phone || "",
		OrderDate: orderDate,
		SaleAccount: env("CORE_SALE_ACCOUNT"),
		BillingAddress: {
			Line1: bill?.address1 || "",
			Line2: bill?.address2 || "",
			City: bill?.city || "",
			State: bill?.province || "",
			Postcode: bill?.zip || "",
			Country: bill?.country_code || bill?.country || "",
		},
		ShippingAddress: {
			Line1: ship?.address1 || "",
			Line2: ship?.address2 || "",
			City: ship?.city || "",
			State: ship?.province || "",
			Postcode: ship?.zip || "",
			Country: ship?.country_code || ship?.country || "",
		},
		TaxRule: taxRule,
		TaxInclusive: Boolean(draft?.taxes_included),
		Terms: env("CORE_TERMS"),
		PriceTier: env("CORE_PRICE_TIER"),
		Location: env("CORE_LOCATION"),
		Note: env("CORE_NOTE"),
		CustomerReference: draft?.name || draft?.id?.toString?.(),
		...(env("CORE_ORDERSTATUS_MODE", "BOOLEAN_FALSE") === "NOTAUTHORISED"
			? { OrderStatus: "NOTAUTHORISED", InvoiceStatus: "NOTAUTHORISED" }
			: { OrderStatus: false, InvoiceStatus: "NOTAUTHORISED" }),
		AutoPickPackShipMode: env("CORE_AUTOPPS_MODE"),
		SalesRepresentative: env("CORE_SALES_REP"),
                InvoiceDate: orderDate,
                InvoiceDueDate: orderDate,
                ...(currencyRate !== undefined ? { CurrencyRate: currencyRate } : {}),
                OrderMemo: env("CORE_ORDER_MEMO"),
                InvoiceMemo: env("CORE_INVOICE_MEMO"),
		Payments: [],
		Lines: lines,
		AdditionalAttributes: undefined,
	};

	Object.keys(payload).forEach(
		(k) => (payload[k] == null || payload[k] === "") && delete payload[k]
	);
	if (Array.isArray(payload.Lines) && payload.Lines.length === 0)
		delete payload.Lines;

	return payload;
}

async function postCoreSale(payload: AnyObj) {
	const base = (
		process.env.CORE_BASE_URL || "https://api.cin7.com/api"
	).replace(/\/$/, "");
	const acct = process.env.CORE_ACCOUNT_ID;
	const key = process.env.CORE_APP_KEY;
	if (!acct || !key)
		return {
			status: 500,
			body: { error: "Missing CORE_ACCOUNT_ID or CORE_APP_KEY" },
		};

	const url = `${base}/Sale`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"api-auth-accountid": acct,
			"api-auth-applicationkey": key,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(payload),
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

	const wantSecret = process.env.FLOW_SHARED_SECRET;
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
			error: "Body does not look like a Shopify Draft Order JSON",
		});
	}

	try {
		const salePayload = mapDraftToCoreSale(draft);
		const core = await postCoreSale(salePayload);

		if (core.status >= 200 && core.status < 300)
			return json(200, { ok: true, core });
		if ([429, 500, 502, 503, 504].includes(core.status))
			return json(core.status, { error: "Core temporary error", core });
		return json(400, {
			error: "Core rejected request",
			core,
			sent: salePayload,
		});
	} catch (e: any) {
		return json(500, { error: e?.message || String(e) });
	}
}
