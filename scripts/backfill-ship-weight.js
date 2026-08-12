#!/usr/bin/env node
/**
 * backfill-ship-weight.js — one-off, PR-documented migration.
 *
 * Retroactively sets every live Shopify variant's WEIGHT to the synthetic
 * shipping-tier key stored in Airtable's "Shopify Ship Weight (lb)" formula
 * (field fldQvj1c5tZBVDRAe → always one of 5 / 15 / 28 / 45 lb). That value is
 * what drives the store's weight-based flat-rate shipping tiers; it is NOT a
 * physical weight. See PR notes / server.js /create-product for the full rationale.
 *
 * This is NOT wired into the normal publish flow — run it by hand:
 *
 *   # dry-run (DEFAULT — writes nothing, prints a diff table + audit CSV)
 *   node scripts/backfill-ship-weight.js
 *
 *   # actually apply the changes
 *   node scripts/backfill-ship-weight.js --apply
 *
 *   node scripts/backfill-ship-weight.js --apply --csv /tmp/audit.csv
 *   node scripts/backfill-ship-weight.js --limit 25        # cap Shopify variants scanned (testing)
 *
 * Env (same names the server uses): SHOPIFY_STORE, SHOPIFY_TOKEN, AIRTABLE_TOKEN.
 *
 * Guarantees:
 *   • Idempotent — re-running after --apply reports 0 changes.
 *   • Touches ONLY the variant weight — never price, inventory, status, or metafields.
 *   • Matches Shopify ⇄ Airtable strictly by SKU.
 *   • Blank Airtable weight → skipped and collected into a "needs estimate" report.
 *   • Every row (change / no-change / blank / orphan) is written to the audit CSV.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;         // e.g. zdzva0-tj.myshopify.com
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';

const AT_BASE_ID = process.env.AT_BASE_ID || 'appHw4SEE5RNT8tCV';
const AT_INVENTORY_TBL = process.env.AT_INVENTORY_TBL || 'tbl29ndzXDXXU8f7x';

// Read Airtable by FIELD ID (returnFieldsByFieldId=true) so renames can't break us.
const FLD_SKU = 'fldEdGcrOsdyuz0jN';          // SKU (EB Number) — the match key
const FLD_SHIP_WEIGHT = 'fldQvj1c5tZBVDRAe';  // Shopify Ship Weight (lb) — the value we write
const FLD_SHIP_TIER = 'flddmStofRVVCJMut';    // Shipping Tier (text, QA)
const FLD_EFF_NET = 'fld3CGtgQMiE02SMR';      // Effective Net Charge (currency, QA driver)

const VALID_TIER_WEIGHTS = new Set([5, 15, 28, 45]);
// Known-blank SKUs today (per the migration spec) — surfaced explicitly in the report.
const KNOWN_BLANKS = ['EB-26SU-WR-003', 'EB-26SP-CP-003'];

// ── CLI ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const csvIdx = args.indexOf('--csv');
const CSV_PATH = csvIdx !== -1 && args[csvIdx + 1]
  ? args[csvIdx + 1]
  : path.join(__dirname, 'backfill-ship-weight-audit.csv');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx !== -1 && args[limitIdx + 1] ? Number(args[limitIdx + 1]) : Infinity;

function die(msg) { console.error('✗ ' + msg); process.exit(1); }
if (!SHOPIFY_STORE) die('SHOPIFY_STORE not set');
if (!SHOPIFY_TOKEN) die('SHOPIFY_TOKEN not set');
if (!AIRTABLE_TOKEN) die('AIRTABLE_TOKEN not set');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Weight helpers ────────────────────────────────────────────
// Normalize any Shopify weight measurement to pounds for comparison.
function toLb(value, unit) {
  const v = Number(value);
  switch (unit) {
    case 'POUNDS': return v;
    case 'OUNCES': return v / 16;
    case 'GRAMS': return v / 453.592;
    case 'KILOGRAMS': return v * 2.2046226218;
    default: return v; // unknown unit — treat as-is; will read as "differs" and get corrected
  }
}
// A variant is already correct ONLY when it's stored in POUNDS at the exact tier value.
// This forces conversion of legacy oz/gram weights even if numerically coincidental,
// and guarantees a re-run after --apply produces zero diffs.
function alreadyCorrect(current, targetLb) {
  return current && current.unit === 'POUNDS' && Math.abs(Number(current.value) - targetLb) < 0.001;
}

// ── Airtable ──────────────────────────────────────────────────
async function airtableFetchAll() {
  const bySku = new Map();
  const duplicateSkus = new Set(); // SKU present on >1 Airtable record — ambiguous, never guessed
  let offset = null;
  do {
    const url = new URL(`https://api.airtable.com/v0/${AT_BASE_ID}/${AT_INVENTORY_TBL}`);
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('returnFieldsByFieldId', 'true');
    for (const fld of [FLD_SKU, FLD_SHIP_WEIGHT, FLD_SHIP_TIER, FLD_EFF_NET]) {
      url.searchParams.append('fields[]', fld);
    }
    if (offset) url.searchParams.set('offset', offset);

    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + AIRTABLE_TOKEN } });
    if (!res.ok) die('Airtable error ' + res.status + ': ' + (await res.text().catch(() => '')));
    const data = await res.json();

    for (const rec of data.records || []) {
      const f = rec.fields || {};
      const sku = f[FLD_SKU];
      if (!sku) continue;
      const wRaw = f[FLD_SHIP_WEIGHT];
      const shipWeightLb = (wRaw === '' || wRaw == null) ? null : Number(wRaw);
      const key = String(sku).trim();
      if (bySku.has(key)) duplicateSkus.add(key); // more than one record for this SKU
      bySku.set(key, {
        recordId: rec.id,
        shipWeightLb,
        tier: f[FLD_SHIP_TIER] != null ? String(f[FLD_SHIP_TIER]) : '',
        effNet: f[FLD_EFF_NET] != null ? f[FLD_EFF_NET] : ''
      });
    }
    offset = data.offset || null;
  } while (offset);
  return { bySku, duplicateSkus };
}

// ── Shopify ───────────────────────────────────────────────────
async function shopifyGraphql(query, variables) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables })
    });
    if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    const json = await res.json();

    // Cost-based throttle: back off before we hit the ceiling.
    const cost = json.extensions && json.extensions.cost;
    if (cost && cost.throttleStatus) {
      const { currentlyAvailable, restoreRate } = cost.throttleStatus;
      const need = (cost.requestedQueryCost || 100);
      if (currentlyAvailable < need + 50) {
        const wait = Math.ceil(((need + 100) - currentlyAvailable) / Math.max(1, restoreRate)) * 1000;
        await sleep(Math.min(wait, 5000));
      }
    }
    // Retry transient THROTTLED top-level errors.
    if (json.errors && json.errors.some((e) => (e.extensions && e.extensions.code) === 'THROTTLED')) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    return json;
  }
  die('Shopify GraphQL: exhausted retries (throttled)');
}

async function fetchAllVariants() {
  const variants = [];
  let cursor = null;
  const query = `
    query($after: String) {
      products(first: 50, after: $after) {
        edges {
          node {
            id
            title
            variants(first: 100) {
              edges {
                node {
                  id
                  sku
                  inventoryItem { measurement { weight { value unit } } }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;
  do {
    const json = await shopifyGraphql(query, { after: cursor });
    if (json.errors) die('Shopify product fetch error: ' + JSON.stringify(json.errors));
    const conn = json.data.products;
    for (const pe of conn.edges) {
      const p = pe.node;
      for (const ve of p.variants.edges) {
        const v = ve.node;
        const m = v.inventoryItem && v.inventoryItem.measurement && v.inventoryItem.measurement.weight;
        variants.push({
          productId: p.id,
          productTitle: p.title,
          variantId: v.id,
          sku: v.sku ? String(v.sku).trim() : '',
          current: m ? { value: m.value, unit: m.unit } : null
        });
        if (variants.length >= LIMIT) return variants;
      }
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return variants;
}

const BULK_UPDATE = `
  mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors { field message }
    }
  }`;

async function applyUpdatesByProduct(updates) {
  // Group by product so productVariantsBulkUpdate can set several variants at once.
  const byProduct = new Map();
  for (const u of updates) {
    if (!byProduct.has(u.productId)) byProduct.set(u.productId, []);
    byProduct.get(u.productId).push(u);
  }
  let ok = 0, failed = 0;
  for (const [productId, ups] of byProduct) {
    const variants = ups.map((u) => ({
      id: u.variantId,
      inventoryItem: { measurement: { weight: { value: u.newLb, unit: 'POUNDS' } } }
    }));
    const json = await shopifyGraphql(BULK_UPDATE, { productId, variants });
    const errs = (json.data && json.data.productVariantsBulkUpdate && json.data.productVariantsBulkUpdate.userErrors) || [];
    if (json.errors || errs.length) {
      failed += ups.length;
      console.error(`  ✗ ${ups.map((u) => u.sku).join(', ')} — ${JSON.stringify(json.errors || errs)}`);
    } else {
      ok += ups.length;
      for (const u of ups) console.log(`  ✓ ${u.sku}: ${u.currentStr} → ${u.newLb} lb (${u.tier || 'no tier'})`);
    }
    await sleep(350); // gentle pacing on top of the cost-based throttle handling
  }
  return { ok, failed };
}

// ── CSV ───────────────────────────────────────────────────────
function csvEscape(s) {
  const str = s == null ? '' : String(s);
  return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}
function writeCsv(rows) {
  const header = ['sku', 'action', 'product_id', 'variant_id', 'current_weight', 'new_weight_lb', 'tier', 'effective_net_charge', 'note'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.sku, r.action, r.productId || '', r.variantId || '', r.currentStr || '', r.newLb != null ? r.newLb : '', r.tier || '', r.effNet != null ? r.effNet : '', r.note || ''].map(csvEscape).join(','));
  }
  fs.writeFileSync(CSV_PATH, lines.join('\n') + '\n');
}

// ── Main ──────────────────────────────────────────────────────
(async () => {
  console.log(`\nEB ship-weight backfill — ${APPLY ? 'APPLY (writing to Shopify)' : 'DRY-RUN (no writes)'}`);
  console.log(`Store ${SHOPIFY_STORE} · API ${API_VERSION}\n`);

  const [{ bySku: airtable, duplicateSkus }, variants] = await Promise.all([airtableFetchAll(), fetchAllVariants()]);
  console.log(`Loaded ${airtable.size} distinct Airtable SKUs and ${variants.length} Shopify variants.\n`);

  const updates = [];      // {productId, variantId, sku, currentStr, newLb, tier, effNet}
  const noChange = [];
  const needsEstimate = []; // in Shopify + in Airtable but blank ship weight
  const duplicates = [];    // SKU on >1 Airtable record — ambiguous, left untouched
  const orphans = [];       // in Shopify, not in Airtable
  const noSku = [];         // Shopify variant without a SKU
  const auditRows = [];

  for (const v of variants) {
    const currentStr = v.current ? `${v.current.value} ${v.current.unit}` : '(none)';
    if (!v.sku) {
      noSku.push(v);
      auditRows.push({ sku: '', action: 'skip-no-sku', productId: v.productId, variantId: v.variantId, currentStr, note: v.productTitle });
      continue;
    }
    const at = airtable.get(v.sku);
    if (!at) {
      orphans.push(v);
      auditRows.push({ sku: v.sku, action: 'orphan-not-in-airtable', productId: v.productId, variantId: v.variantId, currentStr, note: v.productTitle });
      continue;
    }
    if (duplicateSkus.has(v.sku)) {
      // Guardrail: this SKU is on more than one Airtable record — don't guess which weight is right.
      duplicates.push({ sku: v.sku, ...at });
      auditRows.push({ sku: v.sku, action: 'ambiguous-duplicate-airtable', productId: v.productId, variantId: v.variantId, currentStr, newLb: at.shipWeightLb, tier: at.tier, effNet: at.effNet, note: 'SKU on multiple Airtable records — resolve the duplicate, then re-run' });
      continue;
    }
    if (at.shipWeightLb == null) {
      needsEstimate.push({ sku: v.sku, ...at });
      auditRows.push({ sku: v.sku, action: 'needs-estimate-blank', productId: v.productId, variantId: v.variantId, currentStr, tier: at.tier, effNet: at.effNet, note: 'blank Shopify Ship Weight (lb)' });
      continue;
    }
    const target = Number(at.shipWeightLb);
    if (!VALID_TIER_WEIGHTS.has(target)) {
      // Defensive: the formula should only ever emit 5/15/28/45. Flag anything else, don't write it.
      needsEstimate.push({ sku: v.sku, ...at, weird: target });
      auditRows.push({ sku: v.sku, action: 'unexpected-weight', productId: v.productId, variantId: v.variantId, currentStr, newLb: target, tier: at.tier, effNet: at.effNet, note: 'ship weight not in {5,15,28,45} — skipped' });
      continue;
    }
    if (alreadyCorrect(v.current, target)) {
      noChange.push(v.sku);
      auditRows.push({ sku: v.sku, action: 'no-change', productId: v.productId, variantId: v.variantId, currentStr, newLb: target, tier: at.tier, effNet: at.effNet });
      continue;
    }
    const u = { productId: v.productId, variantId: v.variantId, sku: v.sku, currentStr, newLb: target, tier: at.tier, effNet: at.effNet };
    updates.push(u);
    auditRows.push({ sku: v.sku, action: APPLY ? 'update-applied' : 'update-planned', productId: v.productId, variantId: v.variantId, currentStr, newLb: target, tier: at.tier, effNet: at.effNet });
  }

  // Airtable SKUs that have a ship weight but no matching live Shopify variant.
  const liveSkus = new Set(variants.map((v) => v.sku).filter(Boolean));
  const airtableNotLive = [];
  for (const [sku, at] of airtable) {
    if (at.shipWeightLb != null && !liveSkus.has(sku)) airtableNotLive.push({ sku, ...at });
  }

  // ── Diff table ──
  if (updates.length) {
    console.log('Planned weight changes:');
    console.log('  SKU               current →   new    tier');
    console.log('  ' + '-'.repeat(52));
    for (const u of updates) {
      console.log('  ' + u.sku.padEnd(17) + ' ' + u.currentStr.padEnd(11) + '→ ' + String(u.newLb + ' lb').padEnd(7) + (u.tier || ''));
    }
    console.log('');
  } else {
    console.log('No weight changes needed — every matched variant is already at its tier weight.\n');
  }

  // ── Totals ──
  console.log('Totals:');
  console.log(`  ${updates.length} to update`);
  console.log(`  ${noChange.length} already correct`);
  console.log(`  ${needsEstimate.length} needs estimate (blank / unexpected ship weight)`);
  console.log(`  ${duplicates.length} ambiguous (SKU on >1 Airtable record — left untouched)`);
  console.log(`  ${orphans.length} in Shopify but not in Airtable`);
  console.log(`  ${noSku.length} Shopify variants without a SKU`);
  console.log(`  ${airtableNotLive.length} in Airtable (with weight) but not live on Shopify\n`);

  if (needsEstimate.length) {
    console.log('Needs estimate (pending — should not go live until fixed):');
    for (const n of needsEstimate) console.log('  • ' + n.sku + (n.tier ? ' (' + n.tier + ')' : ''));
    console.log('');
  }
  // Sanity note on the known blanks from the spec.
  const seenBlanks = new Set(needsEstimate.map((n) => n.sku));
  const missingKnown = KNOWN_BLANKS.filter((s) => !seenBlanks.has(s));
  if (missingKnown.length) {
    console.log('Note: expected-blank SKU(s) not seen as blank this run: ' + missingKnown.join(', ') + ' (may now have an estimate, or not be live).\n');
  }
  if (duplicates.length) {
    console.log('Ambiguous — SKU on more than one Airtable record (left untouched, resolve then re-run):');
    for (const d of duplicates) console.log('  • ' + d.sku);
    console.log('');
  }
  if (orphans.length) {
    console.log('In Shopify but not in Airtable (left untouched):');
    for (const o of orphans) console.log('  • ' + o.sku + ' — ' + o.productTitle);
    console.log('');
  }

  writeCsv(auditRows);
  console.log('Audit CSV written to ' + CSV_PATH + '\n');

  if (!APPLY) {
    console.log('DRY-RUN complete — nothing was written. Re-run with --apply to write the ' + updates.length + ' change(s).');
    return;
  }
  if (!updates.length) { console.log('Nothing to apply.'); return; }

  console.log('Applying ' + updates.length + ' change(s)…');
  const { ok, failed } = await applyUpdatesByProduct(updates);
  console.log(`\nDone: ${ok} updated, ${failed} failed. Re-run without --apply to confirm 0 diffs.`);
})().catch((e) => die(e && e.stack ? e.stack : String(e)));
