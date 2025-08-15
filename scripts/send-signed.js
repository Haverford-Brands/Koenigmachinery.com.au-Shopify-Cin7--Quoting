// scripts/send-signed.js
// Quick local/Vercel test: computes X-Shopify-Hmac-Sha256 and sends a sample Draft Order
import crypto from 'crypto';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const url = process.argv[2];
if (!url) {
  console.error('Usage: node --env-file=.env scripts/send-signed.js <url>');
  process.exit(1);
}


const payload = {
  draft_order: {
    id: 994118539,
    name: '#D1',
    email: 'bob.norman@mail.example.com',
    taxes_included: false,
    currency: 'USD',
    note: 'rush order',
    shipping_address: {
      first_name: 'Bob',
      last_name: 'Norman',
      address1: '1 Street',
      city: 'NYC',
      province: 'NY',
      zip: '10001',
      country: 'US'
    },
    billing_address: {
      first_name: 'Bob',
      last_name: 'Norman',
      address1: '1 Street',
      city: 'NYC',
      province: 'NY',
      zip: '10001',
      country: 'US'
    },
    line_items: [
      {
        title: 'IPod Nano - 8GB',
        variant_title: 'green',
        sku: 'IPOD2008GREEN',
        quantity: 1,
        price: '199.00'
      }
    ]
  }
};

const raw = Buffer.from(JSON.stringify(payload));
const hmac = crypto
  .createHmac('sha256', process.env.SHOPIFY_APP_SECRET)
  .update(raw)
  .digest('base64');

(async () => {
  try {
    const r = await axios.post(url, raw, {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': hmac,
        'X-Shopify-Event-Id': `local-${Date.now()}`,
        'X-Shopify-Shop-Domain':
          process.env.SHOPIFY_ALLOWED_SHOP || 'test.myshopify.com'
      },
      timeout: 10000
    });
    console.log('Status:', r.status, r.data);
  } catch (e) {
    console.error('Request failed', e.response?.status, e.response?.data || e.message);
    process.exit(1);
  }
})();
