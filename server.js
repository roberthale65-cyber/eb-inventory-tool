const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const fetch   = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const FormData = require('form-data'); // streaming multipart for staged video uploads
 
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
const AIRTABLE_TOKEN     = process.env.AIRTABLE_TOKEN;
const PORT               = process.env.PORT || 3000;

// ── Airtable config ───────────────────────────────────────────
const AT_BASE_ID       = 'appHw4SEE5RNT8tCV';
const AT_INVENTORY_TBL = 'tbl29ndzXDXXU8f7x';
const AT_COSTS_TBL     = 'Costs';

// ── Token stores ─────────────────────────────────────────────
let shopifyAccessToken = process.env.SHOPIFY_TOKEN || null;
let googleAccessToken  = null;
let googleRefreshToken = process.env.GOOGLE_REFRESH_TOKEN || null;
let googleTokenExpiry  = 0;

// ── Airtable helper ───────────────────────────────────────────
async function airtableReq(tablePath, opts = {}) {
  if (!AIRTABLE_TOKEN) throw new Error('AIRTABLE_TOKEN not configured on server');
  const url = tablePath.startsWith('https://')
    ? tablePath
    : `https://api.airtable.com/v0/${AT_BASE_ID}/${tablePath}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': 'Bearer ' + AIRTABLE_TOKEN,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error('Airtable error ' + res.status + ': ' + JSON.stringify(err));
  }
  return res.json();
}

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
    airtable_token: !!AIRTABLE_TOKEN,
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
      console.log('✓ Shopify OAuth complete. Set this in Render → SHOPIFY_TOKEN =', shopifyAccessToken);
      res.send(`<html><head><meta charset="utf-8">
        <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Poppins:wght@300;400;500&display=swap" rel="stylesheet">
        <style>body{font-family:'Poppins',system-ui,sans-serif;background:#fbfaf9;color:#2b2622;padding:48px 40px;max-width:560px;margin:0 auto;line-height:1.7}h2{font-family:'DM Serif Display',Georgia,serif;font-weight:400;color:#bb8588;font-size:28px;margin-bottom:10px}p{color:#5b5248;font-size:14px}code{display:block;word-break:break-all;background:#f3f3f6;border:1px solid #e9e6e2;padding:10px 12px;border-radius:6px;font-size:13px;margin:8px 0;font-family:ui-monospace,Menlo,monospace}.warn{font-size:12px;color:#7a4a0a;background:#fefbec;border:1px solid #eea211;border-radius:6px;padding:10px 12px;margin-top:16px}</style>
        </head><body>
        <h2>✓ Shopify connected</h2>
        <p><strong>Make it permanent:</strong> copy the value below into Render as the <code style="display:inline;padding:2px 6px;margin:0">SHOPIFY_TOKEN</code> environment variable, then redeploy. After that, Shopify stays connected across server restarts and you won't need to do this again.</p>
        <code>${shopifyAccessToken}</code>
        <div class="warn">⚠ This is a secret — don't share or screenshot it for anyone. Once SHOPIFY_TOKEN is set in Render you can ignore this page.</div>
        <p style="margin-top:16px">You can close this tab and return to the Studio.</p>
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
      if (d.refresh_token) googleRefreshToken = d.refresh_token;  // prompt=consent returns one each time; never overwrite with undefined
      googleTokenExpiry  = Date.now() + (d.expires_in || 3600) * 1000;
      console.log('✓ Google Drive OAuth complete. Set this in Render → GOOGLE_REFRESH_TOKEN =', googleRefreshToken);
      res.send(`<html><head><meta charset="utf-8">
        <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Poppins:wght@300;400;500&display=swap" rel="stylesheet">
        <style>body{font-family:'Poppins',system-ui,sans-serif;background:#fbfaf9;color:#2b2622;padding:48px 40px;max-width:560px;margin:0 auto;line-height:1.7}h2{font-family:'DM Serif Display',Georgia,serif;font-weight:400;color:#bb8588;font-size:28px;margin-bottom:10px}p{color:#5b5248;font-size:14px}code{display:block;word-break:break-all;background:#f3f3f6;border:1px solid #e9e6e2;padding:10px 12px;border-radius:6px;font-size:13px;margin:8px 0;font-family:ui-monospace,Menlo,monospace}.warn{font-size:12px;color:#7a4a0a;background:#fefbec;border:1px solid #eea211;border-radius:6px;padding:10px 12px;margin-top:16px}.muted{font-size:12px;color:#aea498;margin-top:20px}a{color:#bb8588}</style>
        </head><body>
        <h2>✓ Google Drive connected</h2>
        <p><strong>Make it permanent:</strong> copy the value below into Render as the <code style="display:inline;padding:2px 6px;margin:0">GOOGLE_REFRESH_TOKEN</code> environment variable, then redeploy. After that, Drive stays connected across server restarts.</p>
        <code>${googleRefreshToken || '(no refresh token returned — visit /drive-auth again)'}</code>
        <div class="warn">⚠ This is a secret — don't share or screenshot it for anyone. Once GOOGLE_REFRESH_TOKEN is set in Render you can ignore this page.</div>
        <p style="margin-top:16px">You can close this tab and return to the Studio.</p>
        <p class="muted">Health check: <a href="/health">/health</a></p>
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
app.get('/drive-list-unsorted', async (req, res) => {
  const { folderId } = req.query;
  if (!folderId) return res.status(400).json({ error: 'folderId required' });
  try {
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
async function ensureFolder(parentId, folderName) {
  const query = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and name = '${folderName.replace(/'/g, "\\'")}' and trashed = false`;
  const data = await driveRequest('/files?q=' + encodeURIComponent(query) + '&fields=files(id,name)');
  if (data.files && data.files.length > 0) return data.files[0].id;
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
app.post('/drive-sort-files', async (req, res) => {
  const { rootFolderId, fileIds, season, type, holiday } = req.body;
  if (!rootFolderId || !fileIds || !fileIds.length || !season || !type) {
    return res.status(400).json({ error: 'rootFolderId, fileIds, season, and type are required' });
  }

  try {
    const seasonFolderId = await ensureFolder(rootFolderId, season);
    const typeFolderId   = await ensureFolder(seasonFolderId, type);

    const results = [];
    for (const fileId of fileIds) {
      try {
        const meta = await driveRequest(`/files/${fileId}?fields=parents,name`);
        const currentParents = (meta.parents || []).join(',');

        const properties = { sorted: 'true', season, type };
        if (holiday && holiday !== 'None') properties.holiday = holiday;

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
        const meta = await driveRequest(`/files/${fileId}?fields=name,properties`);
        const ext = meta.name.includes('.') ? '.' + meta.name.split('.').pop().toLowerCase() : '';
        const seq = String(i + 1).padStart(2, '0');
        const newName = `${ebNumber}_${seq}${ext}`;

        const updated = await driveRequest(`/files/${fileId}?fields=id,name,properties`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: newName,
            properties: { ...(meta.properties || {}), eb_number: ebNumber }
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

// ── Drive: list subfolders under a parent (for the stepped-workflow folder picker) ──
app.get('/drive-list-subfolders', async (req, res) => {
  const { parentId } = req.query;
  if (!parentId) return res.status(400).json({ error: 'parentId required' });
  try {
    const query = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    let folders = [], pageToken = null;
    do {
      let url = '/files?pageSize=100&q=' + encodeURIComponent(query)
        + '&fields=nextPageToken,files(id,name)&orderBy=name';
      if (pageToken) url += '&pageToken=' + pageToken;
      const data = await driveRequest(url);
      folders = folders.concat(data.files || []);
      pageToken = data.nextPageToken || null;
    } while (pageToken);
    res.json({ folders, total: folders.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Drive: list image files in a specific folder ──
app.get('/drive-folder-images', async (req, res) => {
  const { folderId } = req.query;
  if (!folderId) return res.status(400).json({ error: 'folderId required' });
  try {
    const query = `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`;
    let files = [], pageToken = null;
    do {
      let url = '/files?pageSize=100&q=' + encodeURIComponent(query)
        + '&fields=nextPageToken,files(id,name,mimeType,thumbnailLink)&orderBy=name';
      if (pageToken) url += '&pageToken=' + pageToken;
      const data = await driveRequest(url);
      files = files.concat(data.files || []);
      pageToken = data.nextPageToken || null;
    } while (pageToken);
    res.json({ files, total: files.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Drive: fetch full file content as base64 (for the Shopify upload / AI vision) ──
app.get('/drive-file-content', async (req, res) => {
  const { fileId } = req.query;
  if (!fileId) return res.status(400).json({ error: 'fileId required' });
  try {
    const token = await getValidGoogleToken();
    const meta = await driveRequest(`/files/${fileId}?fields=mimeType,name`);
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!r.ok) return res.status(r.status).json({ error: 'Drive download error ' + r.status });
    const buf = Buffer.from(await r.arrayBuffer());
    res.json({ data: buf.toString('base64'), mime: meta.mimeType || 'image/jpeg', name: meta.name });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Airtable: inventory endpoints ────────────────────────────

// GET /airtable/inventory — fetch all inventory records (paginated)
app.get('/airtable/inventory', async (req, res) => {
  const { offset } = req.query;
  try {
    let path = `${AT_INVENTORY_TBL}?pageSize=100`;
    if (offset) path += '&offset=' + encodeURIComponent(offset);
    const data = await airtableReq(path);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /airtable/inventory/:id — fetch single inventory record
app.get('/airtable/inventory/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const data = await airtableReq(`${AT_INVENTORY_TBL}/${id}`);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /airtable/inventory — create new inventory record
app.post('/airtable/inventory', async (req, res) => {
  const { fields } = req.body;
  if (!fields) return res.status(400).json({ error: 'fields required' });
  try {
    const data = await airtableReq(AT_INVENTORY_TBL, {
      method: 'POST',
      body: JSON.stringify({ fields, typecast: true })
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /airtable/inventory/:id — update inventory record
app.patch('/airtable/inventory/:id', async (req, res) => {
  const { id } = req.params;
  const { fields } = req.body;
  if (!id || !fields) return res.status(400).json({ error: 'id and fields required' });
  try {
    const data = await airtableReq(`${AT_INVENTORY_TBL}/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields, typecast: true })
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Airtable: costs endpoints ─────────────────────────────────

// GET /airtable/costs — fetch all cost records (paginated, newest first)
app.get('/airtable/costs', async (req, res) => {
  const { offset } = req.query;
  try {
    let path = encodeURIComponent(AT_COSTS_TBL) + '?pageSize=100&sort%5B0%5D%5Bfield%5D=Date&sort%5B0%5D%5Bdirection%5D=desc';
    if (offset) path += '&offset=' + encodeURIComponent(offset);
    const data = await airtableReq(path);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /airtable/costs — create new cost record
app.post('/airtable/costs', async (req, res) => {
  const { fields } = req.body;
  if (!fields) return res.status(400).json({ error: 'fields required' });
  try {
    const data = await airtableReq(encodeURIComponent(AT_COSTS_TBL), {
      method: 'POST',
      body: JSON.stringify({ fields, typecast: true })
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /airtable/costs/:id — update cost record
app.patch('/airtable/costs/:id', async (req, res) => {
  const { id } = req.params;
  const { fields } = req.body;
  if (!id || !fields) return res.status(400).json({ error: 'id and fields required' });
  try {
    const data = await airtableReq(`${encodeURIComponent(AT_COSTS_TBL)}/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields, typecast: true })
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Airtable: Bins registry ─────────────────────────────────
// GET /airtable/bins — list all printed bin records
app.get('/airtable/bins', async (req, res) => {
  try {
    const url = `https://api.airtable.com/v0/${AT_BASE_ID}/Bins?sort%5B0%5D%5Bfield%5D=Bin+Number&sort%5B0%5D%5Bdirection%5D=asc`;
    const data = await airtableReq(url);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /airtable/bins — register a newly printed bin
app.post('/airtable/bins', async (req, res) => {
  try {
    const { fields } = req.body;
    if (!fields) return res.status(400).json({ error: 'fields required' });
    const data = await airtableReq('Bins', {
      method: 'POST',
      body: JSON.stringify({ fields })
    });
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
  const { eb_number, reference_name, type, season, holiday, colors, dimensions, materials, location, special, notes, images } = req.body;
  const textPrompt = `You write product listings for Eternal Blooms Designs, a handmade artificial flower arrangement business in Omaha, Nebraska. Each piece is handmade and one of a kind.

Write a Shopify product listing for this piece: a TITLE, a DESCRIPTION, and an SEO_META.

TITLE — a Shopify-SEO-optimized product title, BETWEEN 60 AND 80 CHARACTERS long (count the characters; this range optimizes for SEO and avoids search-result truncation — never go under 60 or over 80).
- Begin with the clearest PRIMARY KEYWORD — the exact term a shopper is most likely to search for (usually the arrangement type with its standout descriptor, e.g. "Fall Door Wreath", "Floral Centerpiece"). It must come at the very beginning.
- Use the Maker's working name / Reference name (in the piece details below) as your BASE, then refine and expand it into a polished, keyword-led title that satisfies these rules.
- Use Title Case (capitalize the first letter of every significant word).
- Write any numbers as digits (e.g. "3", never "three").
- Do NOT include any EB/SKU code, quotation marks, or the word "title".

DESCRIPTION — return as clean, minimal HTML; it is published directly as the Shopify product description. Aim for 150–400 words of scannable, engaging, boutique-style copy. Write ABOUT the piece, not the maker — no first person ("I", "my"), and no mention of Patti or any maker.
- FRONT-LOAD the single most compelling benefit in the first one or two sentences so mobile shoppers see it immediately, and include the PRIMARY KEYWORD in that opening sentence.
- Keep every paragraph to 2–3 sentences maximum to avoid walls of text on mobile.
- Use ONE short bold sub-header before the detail list (and optionally one more) to break up sections and create white space.
- Include a structured BULLET LIST of concrete details: colors, key flowers/materials, best display location, and seasonal or occasion fit. (Exact dimensions are appended automatically after your description — do NOT list them.)
- Naturally weave in keyword synonyms throughout for SEO, without keyword-stuffing.
- Allowed HTML tags ONLY, and with NO attributes: <p>, <strong>, <ul>, <li>, <br>. Use <p><strong>Sub-header</strong></p> for a bold header. Do NOT use markdown, heading tags, inline styles, classes, or any tag attributes.
- You may describe the piece as handmade and one-of-a-kind, but do NOT claim or imply it cannot be reproduced, recreated, or replicated. Never use phrasing such as "can never be exactly duplicated," "no two are ever the same," "impossible to recreate," or any similar wording suggesting the item is unrepeatable.
- Return the HTML as a SINGLE LINE with no literal line breaks inside the JSON string.${images && images.length > 0 ? '\n\nPhoto(s) of the actual piece are attached — use what you can see in the photos to write the most accurate, keyword-rich title and description possible.' : ''}

Piece details:
- Type: ${type || 'arrangement'}
- Season: ${season || 'all season'}
- Occasion: ${holiday && holiday !== 'None' ? holiday : 'none'}
- Colors: ${colors || 'not specified'}
- Dimensions: ${dimensions || 'not specified'}
- Key materials / flowers: ${materials || 'not specified'}
- Best display location: ${location || 'not specified'}
- Maker notes: ${(notes || '') + (special ? ' ' + special : '') || 'none'}
- Maker's working name / Reference name (use this as the BASE for the title, refined and expanded for SEO; you may also draw on it for the description): ${reference_name || 'none'}

SEO_META — a Google meta description for search results, 140-160 characters. Must include 2-3 of the strongest keywords from the title. Describe the piece enticingly as if coaxing a click. Do not open with the exact title text. Do not exceed 160 characters.

Return ONLY valid JSON in exactly this shape, with no markdown, no code fences, and no text before or after:
{"title": "...", "description": "...", "seo_meta": "..."}`;

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
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1200, messages: [{ role: 'user', content: messageContent }] })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Anthropic API error' });
    const raw = data.content && data.content[0] && data.content[0].text ? data.content[0].text.trim() : '';
    // Model is asked for {"title","description","seo_meta"} JSON; parse tolerantly and fall back to raw text.
    let title = '', description = '', seo_meta = '';
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    const jsonStr = (s >= 0 && e > s) ? raw.slice(s, e + 1) : raw;
    let parsed = null;
    try { parsed = JSON.parse(jsonStr); }
    catch(_) {
      // The HTML description can occasionally arrive with literal line breaks that
      // break JSON.parse — collapse them and retry before giving up.
      try { parsed = JSON.parse(jsonStr.replace(/\r?\n/g, ' ')); } catch(__) {}
    }
    if (parsed) {
      title = (parsed.title || '').trim();
      description = (parsed.description || '').trim();
      seo_meta = (parsed.seo_meta || '').trim();
    } else { description = raw; }
    res.json({ success: true, title, description, seo_meta });
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

// ── Spell-check reference name ───────────────────────────────
app.post('/spellcheck-name', async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured.' });
  const { text } = req.body;
  if (!text || !text.trim()) return res.json({ original: '', corrected: '', changed: false });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 100, messages: [{ role: 'user', content: `You are a spell-checker for handcrafted floral arrangement names. Fix any spelling errors in the name below. Preserve the original capitalization style and meaning exactly. Return ONLY the corrected name — no explanation, no quotes, no extra words. If there are no errors, return it unchanged.\n\nName: ${text.trim()}` }] })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Anthropic API error' });
    const corrected = data.content?.[0]?.text?.trim() || text.trim();
    res.json({ original: text.trim(), corrected, changed: corrected !== text.trim() });
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
  const { title, body_html, sku, price, tags, product_type, collections, weight_oz, weight_lbs, dimensions, meta_description, requires_shipping, images } = req.body;
  if (!title || !sku) return res.status(400).json({ error: 'title and sku are required' });
  const variant = { sku, price: price || '0.00', inventory_management: 'shopify', inventory_policy: 'deny', fulfillment_service: 'manual', requires_shipping: requires_shipping !== false };
  // Weight: prefer ounces (Shopify WeightUnit OUNCES) — exact, matches the Airtable "Item weight (oz)" field.
  if (weight_oz != null && weight_oz !== '') { variant.weight = Number(weight_oz); variant.weight_unit = 'oz'; }
  else if (weight_lbs) { variant.weight = Math.round(weight_lbs * 453.592); variant.weight_unit = 'g'; }
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
 
// ── Drive: list video files in a specific folder ─────────────
app.get('/drive-folder-videos', async (req, res) => {
  const { folderId } = req.query;
  if (!folderId) return res.status(400).json({ error: 'folderId required' });
  try {
    const query = `'${folderId}' in parents and mimeType contains 'video/' and trashed = false`;
    let files = [], pageToken = null;
    do {
      let url = '/files?pageSize=50&q=' + encodeURIComponent(query)
        + '&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime)&orderBy=modifiedTime desc';
      if (pageToken) url += '&pageToken=' + pageToken;
      const data = await driveRequest(url);
      files = files.concat(data.files || []);
      pageToken = data.nextPageToken || null;
    } while (pageToken);
    res.json({ files, total: files.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Shopify: add video to product — staged upload pipeline ────
// Flow: Drive (authenticated download) → Shopify GCS staged slot
// (multipart POST) → productCreateMedia(resourceUrl).
// NOTE: httpMethod must be POST for video — GCS signed URLs for
// video use form-field auth (x-goog-signature, policy, etc.) that
// only works as multipart POST.  PUT triggers MissingSecurityHeader
// because the signed URL is not a V4 query-param signed URL.
app.post('/shopify-add-video', async (req, res) => {
  if (!shopifyAccessToken) return res.status(401).json({ error: 'Shopify not authorized — visit /auth' });
  const { productId, fileId, fileName, position } = req.body;
  if (!productId || !fileId) return res.status(400).json({ error: 'productId and fileId required' });
  try {
    const token = await getValidGoogleToken();

    // 1. Get file metadata (size + MIME type) — required by stagedUploadsCreate
    const metaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=size,mimeType,name`,
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    if (!metaRes.ok) throw new Error('Drive metadata fetch failed: ' + metaRes.status);
    const meta = await metaRes.json();
    const fileSize = meta.size;
    const mimeType = meta.mimeType || 'video/quicktime';
    const name     = fileName || meta.name || 'product-video.mov';
    if (!fileSize) throw new Error('Could not determine file size from Drive');

    // 2. Ask Shopify for a GCS staged upload slot (POST = multipart form upload)
    const stageMutation = `mutation stagedUploadsCreate($input:[StagedUploadInput!]!){stagedUploadsCreate(input:$input){stagedTargets{url resourceUrl parameters{name value}}userErrors{field message}}}`;
    const stageRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: stageMutation, variables: {
        input: [{ filename: name, mimeType, resource: 'VIDEO', fileSize: String(fileSize), httpMethod: 'POST' }]
      }})
    });
    const stageData = await stageRes.json();
    const stageErrors = stageData?.data?.stagedUploadsCreate?.userErrors || [];
    if (stageErrors.length) throw new Error('Staged upload error: ' + stageErrors.map(e=>e.message).join(', '));
    const target = stageData?.data?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!target?.url || !target?.resourceUrl) throw new Error('No staged upload target returned from Shopify');

    // 3. Open the Drive download as a stream (server auth token, no public sharing).
    //    videoRes.body is a Node Readable — bytes are never buffered into memory.
    const videoRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    if (!videoRes.ok) throw new Error('Drive video download failed: ' + videoRes.status);

    // 4. Stream straight into the GCS multipart POST — parameters MUST come before
    //    the file field. knownLength (from Drive metadata) lets form-data set a correct
    //    Content-Length without measuring bytes, so peak memory stays flat regardless
    //    of video size. form.submit() pipes the Drive stream directly to GCS.
    const form = new FormData();
    for (const p of (target.parameters || [])) { form.append(p.name, p.value); }
    form.append('file', videoRes.body, { knownLength: Number(fileSize), contentType: mimeType, filename: name });

    await new Promise((resolve, reject) => {
      form.submit(target.url, (err, uploadRes) => {
        if (err) return reject(err);
        const status = uploadRes.statusCode;
        let errText = '';
        uploadRes.on('data', c => { if (status >= 300 && errText.length < 300) errText += c.toString(); });
        uploadRes.on('end', () => {
          if (status < 200 || status >= 300) {
            return reject(new Error(`GCS upload failed (${status}): ${errText.slice(0, 300)}`));
          }
          resolve();
        });
        uploadRes.on('error', reject);
      });
    });

    // 5. Attach the confirmed GCS resource to the Shopify product
    const gidProductId = String(productId).startsWith('gid://') ? String(productId) : `gid://shopify/Product/${productId}`;
    const mediaMutation = `mutation productCreateMedia($media:[CreateMediaInput!]!,$productId:ID!){productCreateMedia(media:$media,productId:$productId){media{id alt mediaContentType status}mediaUserErrors{field message}}}`;
    const mediaRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: mediaMutation, variables: {
        productId: gidProductId,
        media: [{ originalSource: target.resourceUrl, alt: name, mediaContentType: 'VIDEO' }]
      }})
    });
    const mediaData = await mediaRes.json();
    const mediaErrors = mediaData?.data?.productCreateMedia?.mediaUserErrors || [];
    if (mediaErrors.length) throw new Error(mediaErrors.map(e=>e.message).join(', '));
    const createdMedia = mediaData?.data?.productCreateMedia?.media || [];

    // 6. Optionally move the video right after the hero image (media position 1,
    //    0-indexed). Non-fatal: a reorder failure still leaves the video attached
    //    at the end, so we never fail the request over it.
    let reordered = false;
    const videoMediaId = createdMedia[0]?.id;
    if (position === 'after_hero' && videoMediaId) {
      try {
        const reorderMutation = `mutation productReorderMedia($id:ID!,$moves:[MoveInput!]!){productReorderMedia(id:$id,moves:$moves){mediaUserErrors{field message}}}`;
        const reorderRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/graphql.json`, {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: reorderMutation, variables: {
            id: gidProductId,
            moves: [{ id: videoMediaId, newPosition: '1' }]
          }})
        });
        const reorderData = await reorderRes.json();
        const reorderErrors = reorderData?.data?.productReorderMedia?.mediaUserErrors || [];
        if (reorderErrors.length) console.warn('Video reorder skipped:', reorderErrors.map(e=>e.message).join(', '));
        else reordered = true;
      } catch(reErr) { console.warn('Video reorder failed (non-fatal):', reErr.message); }
    }

    console.log(`Video uploaded: ${name} (${Math.round(Number(fileSize)/1024/1024)}MB) → product ${productId}${reordered ? ' (positioned after hero)' : ''}`);
    res.json({ success: true, media: createdMedia, reordered });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Drive: list subfolders with modifiedTime (ranked folder picker) ──
// Replaces the bare folder list with extra metadata for scoring.
app.get('/drive-list-subfolders-ranked', async (req, res) => {
  const { parentId } = req.query;
  if (!parentId) return res.status(400).json({ error: 'parentId required' });
  try {
    const query = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    let folders = [], pageToken = null;
    do {
      let url = '/files?pageSize=100&q=' + encodeURIComponent(query)
        + '&fields=nextPageToken,files(id,name,modifiedTime)&orderBy=name';
      if (pageToken) url += '&pageToken=' + pageToken;
      const data = await driveRequest(url);
      folders = folders.concat(data.files || []);
      pageToken = data.nextPageToken || null;
    } while (pageToken);
    res.json({ folders, total: folders.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── One-time recovery: backfill Listing Meta Description from Shopify ────────
// Fetches every listed Airtable record, looks up its Shopify product, pulls the
// saved SEO meta description, and writes it to the new Airtable field.
// Safe to run multiple times — skips any record that already has the field set.
app.post('/recovery/backfill-meta', async (req, res) => {
  if (!shopifyAccessToken) return res.status(401).json({ error: 'Shopify not authorized — visit /auth first' });
  try {
    // 1 ── Pull all Airtable inventory records (paginated)
    let atRecords = [], offset = null;
    do {
      let path = `${AT_INVENTORY_TBL}?pageSize=100`;
      if (offset) path += '&offset=' + encodeURIComponent(offset);
      const page = await airtableReq(path);
      atRecords = atRecords.concat(page.records || []);
      offset = page.offset || null;
    } while (offset);

    // 2 ── Filter to listed pieces that have a Shopify URL
    const listed = atRecords.filter(r =>
      r.fields['Status'] === 'Listed' && r.fields['Shopify URL']
    );

    const results = [];

    for (const record of listed) {
      const f      = record.fields;
      const ebRaw  = f['EB Number'] || '';
      const eb     = (ebRaw.match(/^(EB-\d{2}[A-Z]{2}-[A-Z]{2,3}-\d{3})/i) || [])[1] || ebRaw;
      const url    = f['Shopify URL'] || '';

      // Skip if already has a value
      if (f['Listing Meta Description']) {
        results.push({ eb, status: 'skipped', reason: 'already set' });
        continue;
      }

      // Extract product handle from Shopify storefront URL
      const handleMatch = url.match(/\/products\/([^/?#]+)/);
      if (!handleMatch) {
        results.push({ eb, status: 'error', reason: 'could not parse URL: ' + url });
        continue;
      }
      const handle = handleMatch[1];

      try {
        // Look up product ID by handle
        const prodRes  = await fetch(
          `https://${SHOPIFY_STORE}/admin/api/2026-04/products.json?handle=${encodeURIComponent(handle)}&fields=id`,
          { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } }
        );
        const prodData = await prodRes.json();
        const productId = prodData.products && prodData.products[0] && prodData.products[0].id;

        if (!productId) {
          results.push({ eb, status: 'not-found', reason: 'no Shopify product for handle: ' + handle });
          continue;
        }

        // Fetch the global description_tag metafield
        const mfRes  = await fetch(
          `https://${SHOPIFY_STORE}/admin/api/2026-04/products/${productId}/metafields.json?namespace=global&key=description_tag`,
          { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } }
        );
        const mfData = await mfRes.json();
        const meta   = mfData.metafields && mfData.metafields[0] && mfData.metafields[0].value;

        if (!meta) {
          results.push({ eb, status: 'no-meta', reason: 'product found but no SEO meta stored' });
          continue;
        }

        // Write back to Airtable
        await airtableReq(`${AT_INVENTORY_TBL}/${record.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ fields: { 'Listing Meta Description': meta } })
        });

        results.push({ eb, status: 'updated', meta });

        // Polite pause — avoids hitting Shopify rate limits
        await new Promise(r => setTimeout(r, 250));

      } catch(e) {
        results.push({ eb, status: 'error', reason: e.message });
      }
    }

    const counts = {
      total:    listed.length,
      updated:  results.filter(r => r.status === 'updated').length,
      skipped:  results.filter(r => r.status === 'skipped').length,
      no_meta:  results.filter(r => r.status === 'no-meta').length,
      not_found:results.filter(r => r.status === 'not-found').length,
      errors:   results.filter(r => r.status === 'error').length,
    };
    res.json({ success: true, ...counts, results });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Shopify: get numeric product ID from handle (for video add on already-listed pieces) ──
app.get('/shopify-product-id', async (req, res) => {
  if (!shopifyAccessToken) return res.status(401).json({ error: 'Shopify not authorized' });
  const { handle } = req.query;
  if (!handle) return res.status(400).json({ error: 'handle required' });
  try {
    const r = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2026-04/products.json?handle=${encodeURIComponent(handle)}&fields=id`,
      { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } }
    );
    const d = await r.json();
    const productId = d.products && d.products[0] && d.products[0].id;
    if (!productId) return res.status(404).json({ error: 'Product not found: ' + handle });
    res.json({ productId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Shopify: update SEO meta description on existing product ─────────────────
// Writes to both Airtable and the Shopify product metafield in one call.
app.post('/shopify-update-meta', async (req, res) => {
  if (!shopifyAccessToken) return res.status(401).json({ error: 'Shopify not authorized — visit /auth' });
  const { productHandle, airtableRecordId, metaDescription } = req.body;
  if (!productHandle || !metaDescription) return res.status(400).json({ error: 'productHandle and metaDescription required' });
  try {
    // Resolve product ID from handle
    const prodRes = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2026-04/products.json?handle=${encodeURIComponent(productHandle)}&fields=id`,
      { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } }
    );
    const prodData = await prodRes.json();
    const productId = prodData.products && prodData.products[0] && prodData.products[0].id;
    if (!productId) return res.status(404).json({ error: 'Product not found: ' + productHandle });

    // Check for existing description_tag metafield
    const mfRes = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2026-04/products/${productId}/metafields.json?namespace=global&key=description_tag`,
      { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } }
    );
    const mfData = await mfRes.json();
    const existing = mfData.metafields && mfData.metafields[0];

    let shopifyRes;
    if (existing) {
      shopifyRes = await fetch(
        `https://${SHOPIFY_STORE}/admin/api/2026-04/products/${productId}/metafields/${existing.id}.json`,
        { method: 'PUT', headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ metafield: { id: existing.id, value: metaDescription } }) }
      );
    } else {
      shopifyRes = await fetch(
        `https://${SHOPIFY_STORE}/admin/api/2026-04/products/${productId}/metafields.json`,
        { method: 'POST', headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ metafield: { namespace: 'global', key: 'description_tag', value: metaDescription, type: 'single_line_text_field' } }) }
      );
    }
    const shopifyResult = await shopifyRes.json();
    if (!shopifyRes.ok) return res.status(shopifyRes.status).json({ error: shopifyResult.errors || 'Shopify metafield error' });

    // Write to Airtable if record ID provided
    if (airtableRecordId) {
      await airtableReq(`${AT_INVENTORY_TBL}/${airtableRecordId}`, {
        method: 'PATCH',
        body: JSON.stringify({ fields: { 'Listing Meta Description': metaDescription } })
      });
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Recovery: generate proper SEO metas for all listed pieces ─────────────────
// For each listed Airtable record: fetches the Shopify title + description,
// generates a 140-160 char SEO meta via AI, writes to Airtable and Shopify.
app.post('/recovery/generate-and-set-seo', async (req, res) => {
  if (!shopifyAccessToken) return res.status(401).json({ error: 'Shopify not authorized' });
  if (!ANTHROPIC_API_KEY)  return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  try {
    // Pull all Airtable inventory records
    let atRecords = [], offset = null;
    do {
      let path = `${AT_INVENTORY_TBL}?pageSize=100`;
      if (offset) path += '&offset=' + encodeURIComponent(offset);
      const page = await airtableReq(path);
      atRecords = atRecords.concat(page.records || []);
      offset = page.offset || null;
    } while (offset);

    const listed = atRecords.filter(r => r.fields['Status'] === 'Listed' && r.fields['Shopify URL']);
    const results = [];

    for (const record of listed) {
      const f   = record.fields;
      const eb  = ((f['EB Number'] || '').match(/^(EB-\d{2}[A-Z]{2}-[A-Z]{2,3}-\d{3})/i) || [])[1] || f['EB Number'] || '';
      const url = f['Shopify URL'] || '';
      const handleMatch = url.match(/\/products\/([^/?#]+)/);
      if (!handleMatch) { results.push({ eb, status: 'error', reason: 'bad URL' }); continue; }
      const handle = handleMatch[1];

      try {
        // Get Shopify product title + description
        const prodRes  = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/products.json?handle=${encodeURIComponent(handle)}&fields=id,title,body_html`,
          { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } });
        const prodData = await prodRes.json();
        const product  = prodData.products && prodData.products[0];
        if (!product) { results.push({ eb, status: 'not-found', reason: 'no Shopify product' }); continue; }

        const prodTitle = product.title || '';
        const prodDesc  = (product.body_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g,' ').trim().slice(0, 400);

        // Generate SEO meta via Claude
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001', max_tokens: 200,
            messages: [{ role: 'user', content:
              `Write a Google SEO meta description for this handmade floral product listing.\n` +
              `- Must be 140-160 characters (count carefully)\n` +
              `- Include 2-3 strong keywords from the title\n` +
              `- Describe the product enticingly, like a call to click\n` +
              `- Do NOT start with the exact title text\n` +
              `- Return ONLY the meta description text, nothing else\n\n` +
              `Product title: ${prodTitle}\n` +
              `Product description: ${prodDesc}`
            }]
          })
        });
        const aiData = await aiRes.json();
        const seoMeta = ((aiData.content && aiData.content[0] && aiData.content[0].text) || '').trim();
        if (!seoMeta) { results.push({ eb, status: 'ai-failed', reason: 'empty AI response' }); continue; }

        // Write to Airtable
        await airtableReq(`${AT_INVENTORY_TBL}/${record.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ fields: { 'Listing Meta Description': seoMeta } })
        });

        // Update Shopify metafield
        const mfRes     = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/products/${product.id}/metafields.json?namespace=global&key=description_tag`,
          { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } });
        const mfData    = await mfRes.json();
        const existingMf = mfData.metafields && mfData.metafields[0];
        if (existingMf) {
          await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/products/${product.id}/metafields/${existingMf.id}.json`,
            { method: 'PUT', headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
              body: JSON.stringify({ metafield: { id: existingMf.id, value: seoMeta } }) });
        } else {
          await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/products/${product.id}/metafields.json`,
            { method: 'POST', headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
              body: JSON.stringify({ metafield: { namespace: 'global', key: 'description_tag', value: seoMeta, type: 'single_line_text_field' } }) });
        }

        results.push({ eb, status: 'updated', seoMeta, title: prodTitle });
        await new Promise(r => setTimeout(r, 500)); // rate-limit padding

      } catch(e) { results.push({ eb, status: 'error', reason: e.message }); }
    }

    res.json({ success: true, total: listed.length,
      updated: results.filter(r=>r.status==='updated').length,
      errors:  results.filter(r=>['error','ai-failed','not-found'].includes(r.status)).length,
      results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`EB server running on port ${PORT}`));
