const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(express.json({limit: '50mb'}));
app.use(cors({
  origin: [
    'https://roberthale65-cyber.github.io',
    'https://eternalbloomsbypatti.com',
    'https://eternalbloomsdesigns.com'
  ]
}));

const SHOPIFY_STORE   = process.env.SHOPIFY_STORE;   // zdzva0-tj.myshopify.com
const SHOPIFY_TOKEN   = process.env.SHOPIFY_TOKEN;   // Admin API access token
const PORT            = process.env.PORT || 3000;

// ── Health check ─────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const checks = { server: 'ok', shopify: 'unknown', timestamp: new Date().toISOString() };
  try {
    const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/shop.json`, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
    });
    checks.shopify = r.ok ? 'ok' : 'error ' + r.status;
  } catch(e) {
    checks.shopify = 'error: ' + e.message;
  }
  res.json(checks);
});

// ── Create product ────────────────────────────────────────────
app.post('/create-product', async (req, res) => {
  const { title, body_html, sku, price, tags, vendor, product_type, images } = req.body;

  if (!title || !sku) {
    return res.status(400).json({ error: 'title and sku are required' });
  }

  const productPayload = {
    product: {
      title,
      body_html: body_html || '',
      vendor: vendor || 'Eternal Blooms Designs',
      product_type: product_type || '',
      tags: tags || '',
      variants: [{
        sku,
        price: price || '0.00',
        inventory_management: 'shopify',
        inventory_policy: 'deny',
        fulfillment_service: 'manual',
        requires_shipping: true
      }],
      images: (images || []).map((img, i) => ({
        attachment: img.data,
        filename: img.filename,
        position: i + 1
      }))
    }
  };

  try {
    const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/products.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(productPayload)
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data.errors || 'Shopify error' });
    }

    // Set inventory to 1 at the default location
    const variantId  = data.product.variants[0].id;
    const inventoryItemId = data.product.variants[0].inventory_item_id;

    // Get default location
    const locRes  = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/locations.json`, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
    });
    const locData = await locRes.json();
    const locationId = locData.locations && locData.locations[0] && locData.locations[0].id;

    if (locationId) {
      await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/inventory_levels/set.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ location_id: locationId, inventory_item_id: inventoryItemId, available: 1 })
      });
    }

    const productUrl = `https://eternalbloomsbypatti.com/products/${data.product.handle}`;
    res.json({
      success: true,
      product_id: data.product.id,
      handle: data.product.handle,
      shopify_url: productUrl,
      admin_url: `https://admin.shopify.com/store/zdzva0-tj/products/${data.product.id}`
    });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`EB server running on port ${PORT}`));
