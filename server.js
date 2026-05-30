const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const fetch   = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(express.json({limit: '50mb'}));
app.use(cors({
  origin: [
    'https://roberthale65-cyber.github.io',
    'https://eternalbloomsbypatti.com',
    'https://eternalbloomsdesigns.com',
    'null' // allow local file testing
  ]
}));

const SHOPIFY_API_KEY    = process.env.SHOPIFY_API_KEY;    // Client ID from Dev Dashboard
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET; // Secret from Dev Dashboard
const SHOPIFY_STORE      = process.env.SHOPIFY_STORE;      // zdzva0-tj.myshopify.com
const SERVER_URL         = process.env.SERVER_URL;         // https://eb-shopify-server.onrender.com
const PORT               = process.env.PORT || 3000;

// In-memory token store (persists as long as server is running)
let shopifyAccessToken = process.env.SHOPIFY_TOKEN || null;

// ── Health check ─────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const checks = {
    server: 'ok',
    token_stored: !!shopifyAccessToken,
    shopify: 'unknown',
    timestamp: new Date().toISOString()
  };
  if (shopifyAccessToken) {
    try {
      const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/shop.json`, {
        headers: { 'X-Shopify-Access-Token': shopifyAccessToken }
      });
      checks.shopify = r.ok ? 'ok' : 'error ' + r.status;
      if (r.ok) {
        const d = await r.json();
        checks.shop_name = d.shop && d.shop.name;
      }
    } catch(e) {
      checks.shopify = 'error: ' + e.message;
    }
  } else {
    checks.shopify = 'no token — complete OAuth first';
  }
  res.json(checks);
});

// ── OAuth Step 1 — redirect to Shopify auth ──────────────────
app.get('/auth', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${SERVER_URL}/auth/callback`;
  const scopes = 'read_products,write_products';
  const authUrl = `https://${SHOPIFY_STORE}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  res.redirect(authUrl);
});

// ── OAuth Step 2 — receive token from Shopify ────────────────
app.get('/auth/callback', async (req, res) => {
  const { code, state, hmac, shop } = req.query;

  // Verify HMAC
  const params = Object.keys(req.query)
    .filter(k => k !== 'hmac')
    .sort()
    .map(k => `${k}=${req.query[k]}`)
    .join('&');
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(params).digest('hex');

  if (digest !== hmac) {
    return res.status(400).send('HMAC verification failed');
  }

  // Exchange code for token
  try {
    const tokenRes = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code
      })
    });
    const tokenData = await tokenRes.json();
    if (tokenData.access_token) {
      shopifyAccessToken = tokenData.access_token;
      console.log('✓ Shopify OAuth complete — token stored');
      res.send(`
        <html><body style="font-family:sans-serif;padding:40px;max-width:500px;margin:0 auto">
        <h2 style="color:#006688">✓ Connected!</h2>
        <p>Eternal Blooms Listing Tool is now authorized to publish to Shopify.</p>
        <p>You can close this tab and return to the listing assistant.</p>
        <p style="font-size:12px;color:#666;margin-top:20px">Token stored securely on server. Health check: <a href="/health">/health</a></p>
        </body></html>
      `);
    } else {
      res.status(400).send('Failed to get access token: ' + JSON.stringify(tokenData));
    }
  } catch(e) {
    res.status(500).send('OAuth error: ' + e.message);
  }
});

// ── Airtable proxy ────────────────────────────────────────────
app.get('/airtable-proxy', async (req, res) => {
  const { token, base, table, offset } = req.query;
  if (!token || !base || !table) {
    return res.status(400).json({ error: 'token, base, and table are required' });
  }
  try {
    let url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}?pageSize=100`;
    if (offset) url += `&offset=${offset}`;
    const r = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/create-product', async (req, res) => {
  if (!shopifyAccessToken) {
    return res.status(401).json({
      error: 'Not authorized. Visit ' + SERVER_URL + '/auth to complete Shopify OAuth first.'
    });
  }

  const { title, body_html, sku, price, tags, product_type, images } = req.body;
  if (!title || !sku) {
    return res.status(400).json({ error: 'title and sku are required' });
  }

  const productPayload = {
    product: {
      title,
      body_html: body_html || '',
      vendor: 'Eternal Blooms Designs',
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
        'X-Shopify-Access-Token': shopifyAccessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(productPayload)
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data.errors || 'Shopify error' });
    }

    // Set inventory to 1
    const inventoryItemId = data.product.variants[0].inventory_item_id;
    const locRes  = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/locations.json`, {
      headers: { 'X-Shopify-Access-Token': shopifyAccessToken }
    });
    const locData = await locRes.json();
    const locationId = locData.locations && locData.locations[0] && locData.locations[0].id;
    if (locationId) {
      await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/inventory_levels/set.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': shopifyAccessToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          location_id: locationId,
          inventory_item_id: inventoryItemId,
          available: 1
        })
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
