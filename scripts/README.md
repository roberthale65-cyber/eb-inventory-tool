# scripts/

One-off maintenance scripts. Not part of the running server (`server.js`).

## backfill-ship-weight.js

Retroactively sets every live Shopify variant's **weight** to the synthetic
shipping-tier key stored in Airtable's **"Shopify Ship Weight (lb)"** formula
(`fldQvj1c5tZBVDRAe` → always one of **5 / 15 / 28 / 45 lb**). That value drives
the store's weight-based flat-rate shipping tiers — it is *not* a physical weight.
Same source the publish path now writes (see `server.js` `/create-product`).

```bash
# dry-run (DEFAULT — writes nothing; prints a diff table + audit CSV)
SHOPIFY_STORE=… SHOPIFY_TOKEN=… AIRTABLE_TOKEN=… node scripts/backfill-ship-weight.js

# apply the changes
… node scripts/backfill-ship-weight.js --apply

# options
… node scripts/backfill-ship-weight.js --apply --csv /tmp/audit.csv
… node scripts/backfill-ship-weight.js --limit 25     # cap variants scanned (testing)
```

Env vars are the same ones the server uses (set them in the Render service, or
export locally). Matches Shopify ⇄ Airtable strictly by **SKU**.

**Guarantees**
- Idempotent — re-running after `--apply` reports 0 changes.
- Touches **only** the variant weight (never price, inventory, status, metafields).
- Blank Airtable weight → skipped + listed in a "needs estimate" report.
- Duplicate SKU in Airtable → skipped (never guessed); resolve, then re-run.
- SKU live on Shopify but absent from Airtable → reported, left untouched.
- Every row is written to `backfill-ship-weight-audit.csv`.

### backfill-ship-weight-audit.csv

Committed dry-run audit from **2026-08-12** (read-only, before any `--apply`).
Columns: `sku, action, variant_id, current_weight, new_weight_lb, tier,
effective_net_charge, note`. `action` is one of `update-planned`, `no-change`,
`needs-estimate-blank`, `ambiguous-duplicate-airtable`, `orphan-not-in-airtable`,
`unexpected-weight`. Regenerate any time by re-running the dry-run above.
