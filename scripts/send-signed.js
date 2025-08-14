// scripts/send-signed.js
// Quick local/Vercel test: computes X-Shopify-Hmac-Sha256 and sends a sample Draft Order
import crypto from 'crypto';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const url = process.argv[2];
if (!url) { console.error('Usage: node --env-file=.env scripts/send-signed.js <url>'); process.exit(1); }

const payload = {
  draft_order: {
    id: 994118539,
    name: '#D1',
    email: 'bob.norman@mail.example.com',
    taxes_included: false,
    currency: 'USD',
    note: 'rush order',
    shipping_address: { first_name: 'Bob', last_name: 'Norman', address1: '1 Street', city: 'NYC', province: 'NY', zip: '10001', country: 'US' },
    billing_address: { first_name: 'Bob', last_name: 'Norman', address1: '1 Street', city: 'NYC', province: 'NY', zip: '10001', country: 'US' },
    line_items: [ { title: 'IPod Nano - 8GB', variant_title: 'green', sku: 'IPOD2008GREEN', quantity: 1, price: '199.00' } ]
  }
};

const raw = Buffer.from(JSON.stringify(payload));
const hmac = crypto.createHmac('sha256', process.env.SHOPIFY_APP_SECRET).update(raw).digest('base64');

(async () => {
  try {
    const r = await axios.post(url, raw, {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': hmac,
        'X-Shopify-Event-Id': `local-${Date.now()}`,
        'X-Shopify-Shop-Domain': process.env.SHOPIFY_ALLOWED_SHOP || 'test.myshopify.com'
      },
      timeout: 10000,
    });
    console.log('Status:', r.status, r.data);
  } catch (e) {
    console.error('Request failed', e.response?.status, e.response?.data || e.message);
    process.exit(1);
  }
})();

# src/server.js
import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const {
  SHOPIFY_APP_SECRET,
  SHOPIFY_ALLOWED_SHOP,
  CIN7_BASE_URL = 'https://api.cin7.com/api',
  CIN7_USERNAME,
  CIN7_API_KEY,
  CIN7_BRANCH_ID,
  CIN7_DEFAULT_CURRENCY = 'USD',
  LOG_SHOPIFY_SUMMARY = '0',
  LOG_SHOPIFY_DRAFT = '0',
  DEBUG_DRY_RUN = '0',
  LOG_SHOPIFY_RAW = '0',
  WEBHOOK_DUMP_DIR = '.webhook_dumps',
  DEBUG_TOKEN,
  PORT = 3000,
} = process.env;

if (!SHOPIFY_APP_SECRET) throw new Error('Missing SHOPIFY_APP_SECRET');
if (!CIN7_USERNAME || !CIN7_API_KEY) throw new Error('Missing Cin7 credentials');

const CIN7_AUTH_HEADER = `Basic ${Buffer.from(`${CIN7_USERNAME}:${CIN7_API_KEY}`).toString('base64')}`;

const MAX_EVENTS = 50;
const recentEvents = [];
function recordEvent(evt) { recentEvents.push(evt); if (recentEvents.length > MAX_EVENTS) recentEvents.shift(); }

function ensureDumpDir() {
  try { fs.mkdirSync(WEBHOOK_DUMP_DIR, { recursive: true }); } catch {}
}
function dumpToFile(evt) {
  if (!WEBHOOK_DUMP_DIR) return;
  ensureDumpDir();
  const fp = path.join(WEBHOOK_DUMP_DIR, `${evt.id}.json`);
  try { fs.writeFileSync(fp, JSON.stringify(evt, null, 2), 'utf8'); } catch (e) { console.warn('dump failed', e.message); }
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function verifyShopifyHmac(rawBody, headers) {
  const received = headers['x-shopify-hmac-sha256'] || headers['X-Shopify-Hmac-Sha256'];
  if (!received) return false;
  const digest = crypto.createHmac('sha256', SHOPIFY_APP_SECRET).update(rawBody).digest('base64');
  return timingSafeEqual(digest, received);
}

function allowedShop(headers) {
  if (!SHOPIFY_ALLOWED_SHOP) return true;
  const shop = headers['x-shopify-shop-domain'] || headers['X-Shopify-Shop-Domain'];
  return shop && shop.toLowerCase() === SHOPIFY_ALLOWED_SHOP.toLowerCase();
}

function mapDraftOrderToCin7Quote(draft) {
  const cust = draft.customer || {};
  const ship = draft.shipping_address || {};
  const bill = draft.billing_address || {};
  const quote = {
    reference: draft.name || String(draft.id || ''),
    firstName: cust.first_name || bill.first_name || ship.first_name || '',
    lastName: cust.last_name || bill.last_name || ship.last_name || '',
    company: bill.company || ship.company || (cust.default_address?.company ?? ''),
    email: draft.email || cust.email || '',
    phone: ship.phone || bill.phone || cust.phone || '',
    deliveryFirstName: ship.first_name || '',
    deliveryLastName: ship.last_name || '',
    deliveryCompany: ship.company || '',
    deliveryAddress1: ship.address1 || '',
    deliveryAddress2: ship.address2 || '',
    deliveryCity: ship.city || '',
    deliveryState: ship.province || '',
    deliveryPostalCode: ship.zip || '',
    deliveryCountry: ship.country || '',
    billingFirstName: bill.first_name || '',
    billingLastName: bill.last_name || '',
    billingCompany: bill.company || '',
    billingAddress1: bill.address1 || '',
    billingAddress2: bill.address2 || '',
    billingCity: bill.city || '',
    billingPostalCode: bill.zip || '',
    billingState: bill.province || '',
    billingCountry: bill.country || '',
    branchId: CIN7_BRANCH_ID ? Number(CIN7_BRANCH_ID) : undefined,
    internalComments: draft.note || null,
    currencyCode: draft.currency || CIN7_DEFAULT_CURRENCY,
    taxStatus: draft.taxes_included ? 'Incl' : 'Excl',
    discountTotal: draft.applied_discount?.amount ? Number(draft.applied_discount.amount) : 0,
    discountDescription: draft.applied_discount?.title || draft.applied_discount?.description || null,
    lineItems: (draft.line_items || []).map((li, idx) => ({
      code: li.sku || '',
      name: li.title || '',
      option1: li.variant_title || '',
      qty: Number(li.quantity || 0),
      unitPrice: li.price != null ? Number(li.price) : 0,
      discount: li.applied_discount?.amount ? Number(li.applied_discount.amount) : 0,
      sort: idx + 1,
    })),
  };
  Object.keys(quote).forEach((k) => { if (quote[k] === undefined || quote[k] === null || quote[k] === '') delete quote[k]; });
  return quote;
}

function summarizeDraft(draft) {
  return {
    id: draft.id,
    name: draft.name,
    currency: draft.currency,
    taxes_included: draft.taxes_included,
    line_items: (draft.line_items || []).map((li) => ({ sku: li.sku, title: li.title, qty: li.quantity, price: li.price })),
  };
}

async function sendQuoteToCin7(quote) {
  const url = `${CIN7_BASE_URL}/v1/Quotes?loadboms=false`;
const payload = [quote];
console.log(
JSON.stringify({
tag: "cin7.quote.request",
payload,
})
);
try {
const res = await axios.post(url, payload, {
headers: {
Authorization: CIN7_AUTH_HEADER,
"Content-Type": "application/json",
},
timeout: 15000,
});
console.log(
JSON.stringify({
tag: "cin7.quote.response",
data: res.data,
})
);
return res.data;
} catch (e) {
console.error(
JSON.stringify({
tag: "cin7.quote.error",
status: e.response?.status,
data: e.response?.data,
message: e.message,
})
);
throw e;
}
}

const app = express();
const rawJson = express.raw({ type: 'application/json' });

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// Return last captured events (debug)
app.get('/debug/last', (req, res) => {
  if (!DEBUG_TOKEN || req.query.token !== DEBUG_TOKEN) return res.status(403).json({ error: 'Forbidden' });
  return res.status(200).json({ events: recentEvents });
});
app.get('/debug/last/:id', (req, res) => {
  if (!DEBUG_TOKEN || req.query.token !== DEBUG_TOKEN) return res.status(403).json({ error: 'Forbidden' });
  const evt = recentEvents.find(e => e.id === req.params.id);
  if (!evt) return res.status(404).json({ error: 'Not Found' });
  return res.status(200).json(evt);
});

app.post('/webhooks/shopify/draft_orders/create', rawJson, async (req, res) => {
  try {
    if (!allowedShop(req.headers)) return res.status(401).send('invalid shop');
    if (!verifyShopifyHmac(req.body, req.headers)) return res.status(401).send('invalid hmac');

    const bodyStr = req.body.toString('utf8');
    let payload; try { payload = JSON.parse(bodyStr); } catch { return res.status(400).send('invalid json'); }
    const draft = payload.draft_order || payload;

    const capture = {
      id: req.get('X-Shopify-Event-Id') || crypto.randomUUID(),
      receivedAt: new Date().toISOString(),
      shop: req.get('X-Shopify-Shop-Domain') || 'unknown',
      topic: req.get('X-Shopify-Topic') || 'unknown',
      triggeredAt: req.get('X-Shopify-Triggered-At') || new Date().toISOString(),
      headers: {
        'x-shopify-topic': req.get('X-Shopify-Topic'),
        'x-shopify-shop-domain': req.get('X-Shopify-Shop-Domain'),
        'x-shopify-event-id': req.get('X-Shopify-Event-Id'),
        'x-shopify-triggered-at': req.get('X-Shopify-Triggered-At'),
      },
      body: draft,
    };
    if (LOG_SHOPIFY_RAW === '1') capture.raw = bodyStr; // why: exact body as received
    recordEvent(capture);
    if (LOG_SHOPIFY_RAW === '1') dumpToFile(capture);

    if (LOG_SHOPIFY_SUMMARY === '1') console.log(JSON.stringify({ tag: 'shopify.draft.summary', draft: summarizeDraft(draft) }));
    if (LOG_SHOPIFY_DRAFT === '1') console.log(JSON.stringify({ tag: 'shopify.draft.full', draft }));

    const quote = mapDraftOrderToCin7Quote(draft);

    if (!quote.email) {
      console.warn(JSON.stringify({ tag: 'cin7.precondition.missingEmail', reference: quote.reference, note: 'No email found on draft/customer; Cin7 requires email when memberId is not provided.' }));
      return res.status(200).send('ok');
    }

    // Try to resolve memberId by email
    try {
      const r = await axios.get(`${CIN7_BASE_URL}/v1/Contacts`, {
        params: { fields: 'id,email', where: `email='${quote.email}'`, rows: 1 },
        headers: { Authorization: CIN7_AUTH_HEADER },
        timeout: 8000,
      });
      const contact = Array.isArray(r.data) ? r.data[0] : null;
      if (contact?.id) quote.memberId = contact.id;
    } catch (e) {
      console.warn(JSON.stringify({ tag: 'cin7.contact.lookup.failed', status: e.response?.status, message: e.message }));
    }

    if (DEBUG_DRY_RUN === '1') return res.status(200).send('ok');

    await sendQuoteToCin7(quote);

    if (LOG_SHOPIFY_SUMMARY === '1') console.log(JSON.stringify({ tag: 'cin7.quote.created', reference: quote.reference }));

    return res.status(200).send('ok');
  } catch (err) {
    console.error('Webhook handler error:', err.response?.status, err.response?.data || err.message);
    return res.status(200).send('ok');
  }
});

app.listen(Number(PORT), () => { console.log(`Webhook server listening on :${PORT}`); });