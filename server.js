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
 
const SHOPIFY_API_KEY    = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_STORE      = process.env.SHOPIFY_STORE;      // zdzva0-tj.myshopify.com
const SERVER_URL         = process.env.SERVER_URL;         // https://eb-shopify-server.onrender.com
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY; // for AI description generation
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
 
  const params = Object.keys(req.query)
    .filter(k => k !== 'hmac')
    .sort()
    .map(k => `${k}=${req.query[k]}`)
    .join('&');
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(params).digest('hex');
 
  if (digest !== hmac) {
    return res.status(400).send('HMAC verification failed');
  }
 
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
 
// ── Helper: look up collection ID by handle ──────────────────
async function getCollectionId(handle) {
  // Try custom collections first
  const customRes = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2026-04/custom_collections.json?handle=${handle}`,
    { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } }
  );
  const customData = await customRes.json();
  if (customData.custom_collections && customData.custom_collections.length > 0) {
    return customData.custom_collections[0].id;
  }
  // Fall back to smart collections
  const smartRes = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2026-04/smart_collections.json?handle=${handle}`,
    { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } }
  );
  const smartData = await smartRes.json();
  if (smartData.smart_collections && smartData.smart_collections.length > 0) {
    return smartData.smart_collections[0].id;
  }
  return null;
}
 
// ── Generate description via Anthropic API ───────────────────
app.post('/generate-description', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server.' });
  }
 
  const { eb_number, type, season, holiday, colors, size, dimensions,
          materials, location, special, notes } = req.body;
 
  const prompt = `You write product descriptions for Eternal Blooms Designs, a small handmade artificial flower arrangement business in Omaha, Nebraska run by a local maker named Patti. The tone is warm, personal, and inviting — like buying from someone who genuinely loves what they make. Each piece is completely one of a kind.
 
Write a product description for this listing. Keep it to 3–4 punchy sentences. No fluff, no generic filler. Make the reader feel the quality and uniqueness of the piece. End with a subtle one-of-a-kind callout. Do NOT include dimensions in the description — they are shown separately on the listing.
 
Piece details:
- EB number: ${eb_number || 'not set'}
- Type: ${type || 'arrangement'}
- Season: ${season || 'all season'}
- Holiday: ${holiday && holiday !== 'None' ? holiday : 'none'}
- Colors: ${colors || 'not specified'}
- Size: ${size || 'not specified'}
- Dimensions: ${dimensions || 'not specified'}
- Key materials / flowers: ${materials || 'not specified'}
- Best display location: ${location || 'not specified'}
- Maker notes: ${(notes || '') + (special ? ' ' + special : '') || 'none'}
 
Write ONLY the product description paragraph. No title, no bullet points, no intro phrase like "Here is..." — just the description.`;
 
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data.error?.message || 'Anthropic API error' });
    }
    const description = data.content && data.content[0] && data.content[0].text
      ? data.content[0].text.trim()
      : '';
    res.json({ success: true, description });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
 
// ── Mark product as sold in Shopify ─────────────────────────
app.post('/mark-sold', async (req, res) => {
  if (!shopifyAccessToken) {
    return res.status(401).json({ error: 'Not authorized — complete OAuth first.' });
  }
  const { shopify_url, eb_number } = req.body;
  if (!shopify_url && !eb_number) {
    return res.status(400).json({ error: 'shopify_url or eb_number required' });
  }
  try {
    // Find product by SKU (EB number) or handle from URL
    let productId = null;
    if (eb_number) {
      const searchRes = await fetch(
        `https://${SHOPIFY_STORE}/admin/api/2026-04/products.json?fields=id,variants&limit=250`,
        { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } }
      );
      const searchData = await searchRes.json();
      for (const p of (searchData.products||[])) {
        if (p.variants && p.variants.some(v => v.sku === eb_number)) {
          productId = p.id; break;
        }
      }
    }
    if (!productId) {
      return res.json({ success: true, note: 'Product not found in Shopify — Airtable updated only' });
    }
 
    // Set inventory to 0
    const variantRes = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2026-04/products/${productId}.json`,
      { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } }
    );
    const variantData = await variantRes.json();
    const inventoryItemId = variantData.product?.variants?.[0]?.inventory_item_id;
    const locRes = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2026-04/locations.json`,
      { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } }
    );
    const locData = await locRes.json();
    const locationId = locData.locations?.[0]?.id;
    if (locationId && inventoryItemId) {
      await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/inventory_levels/set.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, inventory_item_id: inventoryItemId, available: 0 })
      });
    }
 
    // Add to Sold-Portfolio collection
    const soldCollectionId = await getCollectionId('sold-portfolio');
    if (soldCollectionId) {
      await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/collects.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ collect: { product_id: productId, collection_id: soldCollectionId } })
      });
    }
 
    res.json({ success: true, product_id: productId });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
 
// ── Create product ───────────────────────────────────────────
app.post('/create-product', async (req, res) => {
  if (!shopifyAccessToken) {
    return res.status(401).json({
      error: 'Not authorized. Visit ' + SERVER_URL + '/auth to complete Shopify OAuth first.'
    });
  }
 
  const {
    title,
    body_html,
    sku,
    price,
    tags,
    product_type,
    collections,
    weight_lbs,
    dimensions,        // formatted string e.g. '24" W × 18" H × 4" D'
    meta_description,
    requires_shipping,
    images
  } = req.body;
 
  if (!title || !sku) {
    return res.status(400).json({ error: 'title and sku are required' });
  }
 
  // Build variant — weight in grams (Shopify stores weight in grams internally)
  const variant = {
    sku,
    price: price || '0.00',
    inventory_management: 'shopify',
    inventory_policy: 'deny',
    fulfillment_service: 'manual',
    requires_shipping: requires_shipping !== false, // default true; false for outdoor pots
  };
  if (weight_lbs) {
    variant.weight = Math.round(weight_lbs * 453.592); // lbs to grams
    variant.weight_unit = 'g';
  }
 
  // Append dimensions to description if provided
  let fullDescription = body_html || '';
  if (dimensions) {
    fullDescription += '<p><strong>Dimensions:</strong> ' + dimensions + '</p>';
  }
 
  const productPayload = {
    product: {
      title,
      body_html: fullDescription,
      vendor: 'Eternal Blooms Designs',
      product_type: product_type || '',
      tags: tags || '',
      variants: [variant],
      images: (images || []).map((img, i) => ({
        attachment: img.data,
        filename: img.filename,
        position: i + 1
      }))
    }
  };
 
  // Add SEO meta description if provided
  if (meta_description) {
    productPayload.product.metafields_global_description_tag = meta_description;
  }
 
  try {
    // ── Step 1: Create the product ───────────────────────────
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
 
    const productId = data.product.id;
 
    // ── Step 2: Set inventory to 1 ───────────────────────────
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
 
    // ── Step 3: Assign collections ───────────────────────────
    // Shopify requires a separate /collects.json call per collection.
    // We look up each collection ID by handle then POST a collect.
    const collectionHandles = Array.isArray(collections) ? collections : [];
    const collectionResults = [];
 
    for (const handle of collectionHandles) {
      try {
        const collectionId = await getCollectionId(handle);
        if (!collectionId) {
          collectionResults.push({ handle, status: 'not found — check handle in Shopify' });
          console.warn(`Collection not found: ${handle}`);
          continue;
        }
        const collectRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/collects.json`, {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': shopifyAccessToken,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            collect: {
              product_id: productId,
              collection_id: collectionId
            }
          })
        });
        const collectData = await collectRes.json();
        if (collectRes.ok) {
          collectionResults.push({ handle, status: 'assigned' });
        } else {
          collectionResults.push({ handle, status: 'error', detail: collectData.errors });
          console.warn(`Collection assign error for ${handle}:`, collectData.errors);
        }
      } catch(e) {
        collectionResults.push({ handle, status: 'error', detail: e.message });
        console.warn(`Collection assign exception for ${handle}:`, e.message);
      }
    }
 
    // ── Step 4: Return result ────────────────────────────────
    const productUrl = `https://eternalbloomsbypatti.com/products/${data.product.handle}`;
    res.json({
      success: true,
      product_id: productId,
      handle: data.product.handle,
      shopify_url: productUrl,
      admin_url: `https://admin.shopify.com/store/zdzva0-tj/products/${productId}`,
      collections_assigned: collectionResults
    });
 
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
 
app.listen(PORT, () => console.log(`EB server running on port ${PORT}`));
 
