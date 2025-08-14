# README.md
## Shopify → Cin7 Quote Webhook

This tiny service receives Shopify `draft_orders/create` webhooks and mirrors them into **Cin7 Omni** by creating a **Quote**.

### How it works
1. Shopify sends a webhook to `/webhooks/shopify/draft_orders/create`.
2. The service verifies the `X-Shopify-Hmac-Sha256` signature using your app secret, dedupes using `X-Shopify-Event-Id`, and immediately replies `200`.
3. It transforms the Draft Order payload into a Cin7 Quote payload and POSTs it to `POST /v1/Quotes` with **Basic Auth**.

### Setup
- Create a **custom app** in your Shopify admin and subscribe to **Draft order creation** (topic `draft_orders/create`) pointing to your public URL + `/webhooks/shopify/draft_orders/create`.
- Fill out `.env` from `.env.example`.
- `npm i` then `npm run dev`.
- Expose `localhost` (e.g., Cloudflare Tunnel, Ngrok) while testing.

### Notes
- Ensure your **Cin7 product codes** match **Shopify SKUs** so line items can link by `code`.
- Cin7 API limits are low (3/sec, 60/min, 5000/day). This service makes **one** API call per webhook.
- Replace the in-memory idempotency cache with Redis/DB for production.

### Test locally
Use a sample Draft Order payload to simulate a Shopify request:

```bash
curl -X POST http://localhost:3000/webhooks/shopify/draft_orders/create \
  -H 'Content-Type: application/json' \
  -H 'X-Shopify-Hmac-Sha256: <computed-signature>' \
  -H 'X-Shopify-Event-Id: test-123' \
  -d '{
    "draft_order": {
      "id": 994118539,
      "name": "#D1",
      "email": "bob.norman@mail.example.com",
      "taxes_included": false,
      "currency": "USD",
      "note": "rush order",
      "shipping_address": {"first_name": "Bob", "last_name": "Norman", "address1": "1 Street", "city": "NYC", "province": "NY", "zip": "10001", "country": "US"},
      "billing_address": {"first_name": "Bob", "last_name": "Norman", "address1": "1 Street", "city": "NYC", "province": "NY", "zip": "10001", "country": "US"},
      "line_items": [
        {"title": "IPod Nano - 8GB", "variant_title": "green", "sku": "IPOD2008GREEN", "quantity": 1, "price": "199.00"}
      ]
    }
  }'
```

> Compute the signature with your `SHOPIFY_APP_SECRET` exactly over the **raw** JSON bytes.
