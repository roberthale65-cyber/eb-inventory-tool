const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const fetch   = (...args) => import('node-fetch').then(({default: f}) => f(...args));
 
const app = express();
app.use(express.json({limit: '150mb'}));
app.use(cors({
  origin: [
    'https://roberthale65-cyber.github.io',
    'https://eternalbloomsbypatti.com',
    'https://eternalbloomsdesigns.com',
    'null'
  ]
}));
 
const SHOPIFY_API_KEY    = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_STORE      = process.env.SHOPIFY_STORE;
const SERVER_URL         = process.env.SERVER_URL;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const GOOGLE_CLIENT_ID   = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT               = process.env.PORT || 3000;

// ── Token stores ─────────────────────────────────────────────
let shopifyAccessToken = process.env.SHOPIFY_TOKEN || null;
let googleAccessToken  = null;
let googleRefreshToken = null;
let googleTokenExpiry  = 0;

// ── Google token helpers ──────────────────────────────────────
async function getValidGoogleToken() {
  if (googleAccessToken && Date.now() < googleTokenExpiry - 60000) {
    return googleAccessToken;
  }
  if (!googleRefreshToken) throw new Error('Google not connected — visit /drive-auth');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: googleRefreshToken,
      grant_type:    'refresh_token'
    })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Google token refresh failed: ' + JSON.stringify(d));
  googleAccessToken = d.access_token;
  googleTokenExpiry = Date.now() + (d.expires_in || 3600) * 1000;
  return googleAccessToken;
}

async function driveRequest(path, opts = {}) {
  const token = await getValidGoogleToken();
  const url = path.startsWith('http') ? path : 'https://www.googleapis.com/drive/v3' + path;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error('Drive API error ' + res.status + ': ' + JSON.stringify(err));
  }
  // 204 No Content — return empty object
  if (res.status === 204) return {};
  return res.json();
}

// ── Health check ─────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const checks = {
    server: 'ok',
    token_stored: !!shopifyAccessToken,
    google_connected: !!googleRefreshToken,
    shopify: 'unknown',
    timestamp: new Date().toISOString()
  };
  if (shopifyAccessToken) {
    try {
      const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/shop.json`, {
        headers: { 'X-Shopify-Access-Token': shopifyAccessToken }
      });
      checks.shopify = r.ok ? 'ok' : 'error ' + r.status;
      if (r.ok) { const d = await r.json(); checks.shop_name = d.shop && d.shop.name; }
    } catch(e) { checks.shopify = 'error: ' + e.message; }
  } else {
    checks.shopify = 'no token — complete OAuth first';
  }
  res.json(checks);
});
 
// ── Shopify OAuth ─────────────────────────────────────────────
app.get('/auth', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${SERVER_URL}/auth/callback`;
  const scopes = 'read_products,write_products';
  const authUrl = `https://${SHOPIFY_STORE}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  res.redirect(authUrl);
});
 
app.get('/auth/callback', async (req, res) => {
  const { code, hmac } = req.query;
  const params = Object.keys(req.query).filter(k => k !== 'hmac').sort().map(k => `${k}=${req.query[k]}`).join('&');
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(params).digest('hex');
  if (digest !== hmac) return res.status(400).send('HMAC verification failed');
  try {
    const tokenRes = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: SHOPIFY_API_KEY, client_secret: SHOPIFY_API_SECRET, code })
    });
    const tokenData = await tokenRes.json();
    if (tokenData.access_token) {
      shopifyAccessToken = tokenData.access_token;
      console.log('✓ Shopify OAuth complete');
      res.send(`<html><body style="font-family:sans-serif;padding:40px;max-width:500px;margin:0 auto">
        <h2 style="color:#006688">✓ Shopify Connected!</h2>
        <p>You can close this tab and return to the listing assistant.</p>
        </body></html>`);
    } else {
      res.status(400).send('Failed to get access token: ' + JSON.stringify(tokenData));
    }
  } catch(e) { res.status(500).send('OAuth error: ' + e.message); }
});

// ── Google Drive OAuth ────────────────────────────────────────
app.get('/drive-auth', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${SERVER_URL}/drive-auth/callback`;
  const scopes = 'https://www.googleapis.com/auth/drive';
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth'
    + '?client_id=' + encodeURIComponent(GOOGLE_CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(redirectUri)
    + '&response_type=code'
    + '&scope=' + encodeURIComponent(scopes)
    + '&access_type=offline'
    + '&prompt=consent'
    + '&state=' + state;
  res.redirect(authUrl);
});

app.get('/drive-auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send('Google auth error: ' + error);
  try {
    const redirectUri = `${SERVER_URL}/drive-auth/callback`;
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code'
      })
    });
    const d = await r.json();
    if (d.access_token) {
      googleAccessToken  = d.access_token;
      googleRefreshToken = d.refresh_token;
      googleTokenExpiry  = Date.now() + (d.expires_in || 3600) * 1000;
      console.log('✓ Google Drive OAuth complete');
      res.send(`<html><body style="font-family:sans-serif;padding:40px;max-width:500px;margin:0 auto">
        <h2 style="color:#5C7A5C">✓ Google Drive Connected!</h2>
        <p>The backlog catchup tool can now read and organize your Listing Photos folder.</p>
        <p>You can close this tab and return to the Studio.</p>
        <p style="font-size:12px;color:#666;margin-top:20px">Health check: <a href="/health">/health</a></p>
        </body></html>`);
    } else {
      res.status(400).send('Failed to get Google token: ' + JSON.stringify(d));
    }
  } catch(e) { res.status(500).send('Google OAuth error: ' + e.message); }
});

// ── Drive: check connection status ───────────────────────────
app.get('/drive-status', async (req, res) => {
  if (!googleRefreshToken) {
    return res.json({ connected: false });
  }
  try {
    await getValidGoogleToken();
    res.json({ connected: true });
  } catch(e) {
    res.json({ connected: false, error: e.message });
  }
});

// ── Drive: list unsorted files in Listing Photos folder root ──
// "Unsorted" = files directly in the folder (not in subfolders)
// that do NOT have the sorted=true property set
app.get('/drive-list-unsorted', async (req, res) => {
  const { folderId } = req.query;
  if (!folderId) return res.status(400).json({ error: 'folderId required' });
  try {
    // List only files (not folders) directly in the target folder
    // that don't yet have sorted=true in their properties
    const mimeFilter = "(mimeType contains 'image/' or mimeType contains 'video/')";
    const query = `'${folderId}' in parents and ${mimeFilter} and trashed = false`;

    let files = [];
    let pageToken = null;
    do {
      let url = '/files?pageSize=100'
        + '&q=' + encodeURIComponent(query)
        + '&fields=nextPageToken,files(id,name,mimeType,thumbnailLink,webViewLink,properties,size)'
        + '&orderBy=name%20desc';
      if (pageToken) url += '&pageToken=' + pageToken;
      const data = await driveRequest(url);
      files = files.concat(data.files || []);
      pageToken = data.nextPageToken || null;
    } while (pageToken);

    // Filter out files that already have sorted=true
    const unsorted = files.filter(f => {
      const props = f.properties || {};
      return props.sorted !== 'true';
    });

    res.json({ files: unsorted, total: unsorted.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Drive: ensure subfolder path exists, return folder ID ────
// Creates Season/Type hierarchy under the root listing folder
async function ensureFolder(parentId, folderName) {
  // Check if it already exists
  const query = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and name = '${folderName.replace(/'/g, "\\'")}' and trashed = false`;
  const data = await driveRequest('/files?q=' + encodeURIComponent(query) + '&fields=files(id,name)');
  if (data.files && data.files.length > 0) return data.files[0].id;
  // Create it
  const created = await driveRequest('/files', {
    method: 'POST',
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    })
  });
  return created.id;
}

// ── Drive: apply sort to one or more files ───────────────────
// Moves files into Season/Type subfolder and writes properties
app.post('/drive-sort-files', async (req, res) => {
  const { rootFolderId, fileIds, season, type, holiday } = req.body;
  if (!rootFolderId || !fileIds || !fileIds.length || !season || !type) {
    return res.status(400).json({ error: 'rootFolderId, fileIds, season, and type are required' });
  }

  try {
    // Ensure Season folder, then Type subfolder
    const seasonFolderId = await ensureFolder(rootFolderId, season);
    const typeFolderId   = await ensureFolder(seasonFolderId, type);

    const results = [];
    for (const fileId of fileIds) {
      try {
        // Get current parents so we can remove them
        const meta = await driveRequest(`/files/${fileId}?fields=parents,name`);
        const currentParents = (meta.parents || []).join(',');

        // Build properties object
        const properties = {
          sorted:  'true',
          season,
          type
        };
        if (holiday && holiday !== 'None') properties.holiday = holiday;

        // Move file (add new parent, remove old) + write properties in one PATCH
        const moveUrl = `/files/${fileId}`
          + '?addParents=' + typeFolderId
          + (currentParents ? '&removeParents=' + currentParents : '')
          + '&fields=id,name,parents,properties';

        const updated = await driveRequest(moveUrl, {
          method: 'PATCH',
          body: JSON.stringify({ properties })
        });

        results.push({ fileId, success: true, name: updated.name, folderId: typeFolderId });
      } catch(fileErr) {
        results.push({ fileId, success: false, error: fileErr.message });
      }
    }

    const allOk = results.every(r => r.success);
    res.json({ success: allOk, results, seasonFolderId, typeFolderId });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Drive: rename files with EB number ───────────────────────
// Called from List & Publish when an EB number is assigned to photos
app.post('/drive-assign-eb', async (req, res) => {
  const { fileIds, ebNumber } = req.body;
  if (!fileIds || !fileIds.length || !ebNumber) {
    return res.status(400).json({ error: 'fileIds and ebNumber are required' });
  }

  try {
    const results = [];
    for (let i = 0; i < fileIds.length; i++) {
      const fileId = fileIds[i];
      try {
        // Get current file to preserve extension
        const meta = await driveRequest(`/files/${fileId}?fields=name,properties`);
        const ext = meta.name.includes('.') ? '.' + meta.name.split('.').pop().toLowerCase() : '';
        const seq = String(i + 1).padStart(2, '0');
        const newName = `${ebNumber}-${seq}${ext}`;

        const updated = await driveRequest(`/files/${fileId}?fields=id,name,properties`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: newName,
            properties: { ...( meta.properties || {}), eb_number: ebNumber }
          })
        });

        results.push({ fileId, success: true, oldName: meta.name, newName: updated.name });
      } catch(fileErr) {
        results.push({ fileId, success: false, error: fileErr.message });
      }
    }
    res.json({ success: results.every(r => r.success), results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Airtable proxy ────────────────────────────────────────────
app.get('/airtable-proxy', async (req, res) => {
  const { token, base, table, offset } = req.query;
  if (!token || !base || !table) return res.status(400).json({ error: 'token, base, and table are required' });
  try {
    let url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}?pageSize=100`;
    if (offset) url += `&offset=${offset}`;
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await r.json();
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
 
// ── Helper: look up collection ID by handle ──────────────────
async function getCollectionId(handle) {
  const customRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/custom_collections.json?handle=${handle}`, { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } });
  const customData = await customRes.json();
  if (customData.custom_collections && customData.custom_collections.length > 0) return customData.custom_collections[0].id;
  const smartRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/smart_collections.json?handle=${handle}`, { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } });
  const smartData = await smartRes.json();
  if (smartData.smart_collections && smartData.smart_collections.length > 0) return smartData.smart_collections[0].id;
  return null;
}
 
// ── Generate description ──────────────────────────────────────
app.post('/generate-description', async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server.' });
  const { eb_number, type, season, holiday, colors, dimensions, materials, location, special, notes, images } = req.body;
  const textPrompt = `You write product descriptions for Eternal Blooms Designs, a handmade artificial flower arrangement business in Omaha, Nebraska. Each piece is completely one of a kind — no two are ever the same.

Write a product description for this listing. The tone is elegant and creative — like a boutique shop description. Write ABOUT the piece itself, not about the maker. No first person ("I", "my"), no mention of Patti or the maker at all. Focus entirely on the piece — its colors, textures, mood, and where it belongs in someone's home. Make the reader picture it and want it.

Keep it to 3–4 sentences. Be evocative but not overdone — professional and polished without being stiff or formal. End with a natural one-of-a-kind callout that creates gentle urgency.${images && images.length > 0 ? '\n\nPhoto(s) of the actual piece are attached — use what you can see in the photos to write the most accurate and evocative description possible.' : ''}

Piece details:
- Type: ${type || 'arrangement'}
- Season: ${season || 'all season'}
- Holiday: ${holiday && holiday !== 'None' ? holiday : 'none'}
- Colors: ${colors || 'not specified'}
- Dimensions: ${dimensions || 'not specified'}
- Key materials / flowers: ${materials || 'not specified'}
- Best display location: ${location || 'not specified'}
- Maker notes: ${(notes || '') + (special ? ' ' + special : '') || 'none'}

Write ONLY the product description. No title, no bullet points, no intro phrase — just the description.`;

  let messageContent;
  if (images && images.length > 0) {
    messageContent = [];
    for (const img of images) {
      const validTypes = ['image/jpeg','image/png','image/gif','image/webp'];
      const mime = validTypes.includes(img.mime) ? img.mime : 'image/jpeg';
      messageContent.push({ type: 'image', source: { type: 'base64', media_type: mime, data: img.data } });
    }
    messageContent.push({ type: 'text', text: textPrompt });
  } else {
    messageContent = textPrompt;
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 300, messages: [{ role: 'user', content: messageContent }] })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Anthropic API error' });
    const description = data.content && data.content[0] && data.content[0].text ? data.content[0].text.trim() : '';
    res.json({ success: true, description });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Clean up spelling/grammar ─────────────────────────────────
app.post('/cleanup-text', async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server.' });
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [{ role: 'user', content: `Fix any spelling and grammar errors in the text below. Keep the same meaning, tone, and style. Return ONLY the corrected text with no explanation, no quotes, no preamble.\n\n${text}` }] })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Anthropic API error' });
    const cleaned = data.content && data.content[0] && data.content[0].text ? data.content[0].text.trim() : text;
    res.json({ text: cleaned });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Parse receipt ─────────────────────────────────────────────
app.post('/parse-receipt', async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server.' });
  const { image_base64, mime_type, mode } = req.body;
  if (!image_base64) return res.status(400).json({ error: 'image_base64 is required' });
  const isMileage = mode === 'mileage';
  const isPdf = mime_type === 'application/pdf';

  const receiptPrompt = `You are reading a receipt image for a small business called Eternal Blooms Designs.
Extract the following information and return it as a JSON object with NO other text — no explanation, no markdown, just raw JSON.

Return exactly this structure:
{
  "vendor": "store or business name",
  "total": 0.00,
  "date": "YYYY-MM-DD",
  "description": "brief description of what was purchased",
  "payment_method": "Card" or "Cash" or "Venmo" or "Check" or "unknown",
  "suggested_category": one of: "Materials" or "Craft Show" or "Display" or "Tools" or "Business" or "Shipping" or "Other",
  "suggested_subcategory": one of these if category is Materials: "Flowers & stems" or "Ribbon & fabric" or "Containers & pots" or "Foam & structure" or "Wire & hardware" or "Rocks & fillers" or "Packaging" or "Other materials" — otherwise leave as ""
}

If you cannot read a value clearly, use null for numbers and "" for strings. If the date is unclear, use today's date in YYYY-MM-DD format.`;

  const mileagePrompt = `You are reading a handwritten mileage log or note for a small business called Eternal Blooms Designs.
Extract the trip information and return it as a JSON object with NO other text — no explanation, no markdown, just raw JSON.

Return exactly this structure:
{
  "description": "destination or trip description",
  "miles": 0,
  "date": "YYYY-MM-DD",
  "purpose": one of: "Craft show setup/breakdown" or "Client delivery" or "Materials pickup" or "Event/show day" or "Other business"
}

If multiple trips are visible, combine them into a total miles figure and summarize the description.
If you cannot read a value clearly, use null for numbers and "" for strings.`;

  let messageContent;
  if (isPdf) {
    messageContent = [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: image_base64 } }, { type: 'text', text: isMileage ? mileagePrompt : receiptPrompt }];
  } else {
    const validImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const effectiveMime = validImageTypes.includes(mime_type) ? mime_type : 'image/jpeg';
    messageContent = [{ type: 'image', source: { type: 'base64', media_type: effectiveMime, data: image_base64 } }, { type: 'text', text: isMileage ? mileagePrompt : receiptPrompt }];
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 500, messages: [{ role: 'user', content: messageContent }] })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Anthropic API error' });
    const rawText = data.content && data.content[0] && data.content[0].text ? data.content[0].text.trim() : '{}';
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch(parseErr) { return res.status(422).json({ error: 'Could not parse receipt — try a clearer photo or enter manually.', raw: rawText }); }
    res.json(parsed);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
 
// ── Mark product as sold ──────────────────────────────────────
app.post('/mark-sold', async (req, res) => {
  if (!shopifyAccessToken) return res.status(401).json({ error: 'Not authorized — complete OAuth first.' });
  const { shopify_url, eb_number } = req.body;
  if (!shopify_url && !eb_number) return res.status(400).json({ error: 'shopify_url or eb_number required' });
  try {
    let productId = null;
    if (eb_number) {
      const searchRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/products.json?fields=id,variants&limit=250`, { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } });
      const searchData = await searchRes.json();
      for (const p of (searchData.products||[])) {
        if (p.variants && p.variants.some(v => v.sku === eb_number)) { productId = p.id; break; }
      }
    }
    if (!productId) return res.json({ success: true, note: 'Product not found in Shopify — Airtable updated only' });
    const variantRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/products/${productId}.json`, { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } });
    const variantData = await variantRes.json();
    const inventoryItemId = variantData.product?.variants?.[0]?.inventory_item_id;
    const locRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/locations.json`, { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } });
    const locData = await locRes.json();
    const locationId = locData.locations?.[0]?.id;
    if (locationId && inventoryItemId) {
      await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/inventory_levels/set.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, inventory_item_id: inventoryItemId, available: 0 })
      });
    }
    const soldCollectionId = await getCollectionId('sold-portfolio');
    if (soldCollectionId) {
      await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/collects.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ collect: { product_id: productId, collection_id: soldCollectionId } })
      });
    }
    res.json({ success: true, product_id: productId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
 
// ── Create product ────────────────────────────────────────────
app.post('/create-product', async (req, res) => {
  if (!shopifyAccessToken) return res.status(401).json({ error: 'Not authorized. Visit ' + SERVER_URL + '/auth to complete Shopify OAuth first.' });
  const { title, body_html, sku, price, tags, product_type, collections, weight_lbs, dimensions, meta_description, requires_shipping, images } = req.body;
  if (!title || !sku) return res.status(400).json({ error: 'title and sku are required' });
  const variant = { sku, price: price || '0.00', inventory_management: 'shopify', inventory_policy: 'deny', fulfillment_service: 'manual', requires_shipping: requires_shipping !== false };
  if (weight_lbs) { variant.weight = Math.round(weight_lbs * 453.592); variant.weight_unit = 'g'; }
  let fullDescription = body_html || '';
  if (dimensions) fullDescription += '<p><strong>Dimensions:</strong> ' + dimensions + '</p>';
  const productPayload = {
    product: {
      title, body_html: fullDescription, vendor: 'Eternal Blooms Designs', product_type: product_type || '', tags: tags || '',
      variants: [variant],
      images: (images || []).map((img, i) => ({ attachment: img.data, filename: img.filename, position: i + 1 }))
    }
  };
  if (meta_description) productPayload.product.metafields_global_description_tag = meta_description;
  try {
    const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/products.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(productPayload)
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.errors || 'Shopify error' });
    const productId = data.product.id;
    const inventoryItemId = data.product.variants[0].inventory_item_id;
    const locRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/locations.json`, { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } });
    const locData = await locRes.json();
    const locationId = locData.locations && locData.locations[0] && locData.locations[0].id;
    if (locationId) {
      await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/inventory_levels/set.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, inventory_item_id: inventoryItemId, available: 1 })
      });
    }
    const collectionHandles = Array.isArray(collections) ? collections : [];
    const collectionResults = [];
    for (const handle of collectionHandles) {
      try {
        const collectionId = await getCollectionId(handle);
        if (!collectionId) { collectionResults.push({ handle, status: 'not found' }); continue; }
        const collectRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/collects.json`, {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ collect: { product_id: productId, collection_id: collectionId } })
        });
        const collectData = await collectRes.json();
        collectionResults.push({ handle, status: collectRes.ok ? 'assigned' : 'error', detail: collectData.errors });
      } catch(e) { collectionResults.push({ handle, status: 'error', detail: e.message }); }
    }
    const productUrl = `https://eternalbloomsbypatti.com/products/${data.product.handle}`;
    const heroImageUrl = data.product.images && data.product.images.length > 0 ? data.product.images[0].src : null;
    res.json({ success: true, product_id: productId, handle: data.product.handle, shopify_url: productUrl, admin_url: `https://admin.shopify.com/store/zdzva0-tj/products/${productId}`, hero_image_url: heroImageUrl, collections_assigned: collectionResults });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
 
app.listen(PORT, () => console.log(`EB server running on port ${PORT}`));
