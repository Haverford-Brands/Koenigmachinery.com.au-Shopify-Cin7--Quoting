import crypto from "crypto";
import { mapDraftOrderToCin7Quote } from "../webhooks/shopify/draft_orders/create.js";

const { DEBUG_TOKEN } = process.env;

export default async function handler(req, res) {
	if (req.method !== "POST")
		return res.status(405).json({ error: "Method Not Allowed" });
	if (!DEBUG_TOKEN || req.query.token !== DEBUG_TOKEN)
		return res.status(403).json({ error: "Forbidden" });

	// Read body (works with raw streams on Vercel)
	const chunks = [];
	for await (const chunk of req)
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	const raw = Buffer.concat(chunks);

	let payload;
	try {
		payload = JSON.parse(raw.toString("utf8"));
	} catch {
		return res.status(400).json({ error: "invalid json" });
	}
	const draft = payload.draft_order || payload;

	const quote = mapDraftOrderToCin7Quote(draft);

	const summary = {
		draft: {
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
		},
		quotePreview: {
			reference: quote.reference,
			currencyCode: quote.currencyCode,
			taxStatus: quote.taxStatus,
			lineItems: (quote.lineItems || []).map((l) => ({
				code: l.code,
				name: l.name,
				qty: l.qty,
				unitPrice: l.unitPrice,
				discount: l.discount,
			})),
		},
	};

	return res.status(200).json(summary);
}
