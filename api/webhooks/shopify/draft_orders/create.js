// api/webhooks/shopify/draft_orders/create.js
import crypto from 'crypto';
import axios from 'axios';

const {
  SHOPIFY_APP_SECRET,
  SHOPIFY_ALLOWED_SHOP,
  CIN7_BASE_URL = 'https://api.cin7.com/api',
  CIN7_USERNAME,
  CIN7_API_KEY,
  CIN7_BRANCH_ID,
  CIN7_DEFAULT_CURRENCY = 'USD',
} = process.env;

if (!SHOPIFY_APP_SECRET) console.error('Missing SHOPIFY_APP_SECRET');
if (!CIN7_USERNAME || !CIN7_API_KEY) console.error('Missing Cin7 credentials');

const CIN7_AUTH_HEADER = `Basic ${Buffer.from(`${CIN7_USERNAME}:${CIN7_API_KEY}`).toString('base64')}`;

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

  Object.keys(quote).forEach((k) => {
    if (quote[k] === undefined || quote[k] === null || quote[k] === '') delete quote[k];
  });
  return quote;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  if (!allowedShop(req.headers)) return res.status(401).send('invalid shop');

  // Read raw body for HMAC validation (why: Shopify signs the exact raw bytes)
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const rawBody = Buffer.concat(chunks);

  if (!verifyShopifyHmac(rawBody, req.headers)) return res.status(401).send('invalid hmac');

  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return res.status(400).send('invalid json'); }
  const draft = payload.draft_order || payload;

  try {
    const quote = mapDraftOrderToCin7Quote(draft);
    await axios.post(`${CIN7_BASE_URL}/v1/Quotes?loadboms=false`, [quote], {
      headers: { Authorization: CIN7_AUTH_HEADER, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    return res.status(200).send('ok');
  } catch (err) {
    // why: avoid leaking secrets; log minimal info
    console.error('Cin7 error', err.response?.status, err.response?.data?.message || err.message);
    return res.status(502).send('cin7 error');
  }
}
