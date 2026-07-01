# Eternal Blooms — Inventory Tool & Data-Mapping Context Log
**Phase covered:** PR #15 → PR #46 (all merged) · **As of:** 2026-07-01

A handoff for anyone picking up the Eternal Blooms (EB) inventory tool and the Airtable→Shopify→Meta/Etsy data-mapping work. Read this first, then the linked Airtable tables and the code anchors at the end.

---

## 1. What this system is

EB is a handmade artificial-floral business (wreaths, centerpieces, planters, swags, wall decor). The **eb-inventory-tool** is a single-page web app that catalogs each one-of-a-kind piece in Airtable, assigns it an **EB number**, and publishes it to **Shopify** as a fully-attributed product. Meta (Facebook/Instagram) and Etsy are planned downstream channels.

- **Airtable is the source of truth.** Every piece is a row in the `Inventory` table; the app reads/writes it through a proxy server.
- **Shopify is the first live sales channel.** Publishing maps Airtable fields → Shopify product fields, native taxonomy metafields, and custom metafields.
- **Meta & Etsy are mapped-but-not-built.** Decisions are recorded (see the Channel Field Map) so the build is turnkey later.

## 2. Architecture & workflow

| Piece | Where |
|---|---|
| **Repo** | GitHub `roberthale65-cyber/eb-inventory-tool`. Only `master.html` (the app) + `server.js` (proxy/publish) matter for runtime. |
| **Front end** | `master.html` — served via GitHub Pages. A big single file: wizard UI + all client JS. |
| **Server** | `server.js` — Express app on **Render**, auto-deploys from `main`. Holds Shopify/Airtable/Anthropic tokens + Google Drive OAuth. Confirm deploys at `https://eb-shopify-server.onrender.com/version`. |
| **Live data tools** | Shopify MCP (store "Eternal Blooms Designs"), Airtable MCP (base `appHw4SEE5RNT8tCV`, `Inventory` table `tbl29ndzXDXXU8f7x`). |
| **AI** | Anthropic API — title/description/SEO generation (`/generate-description`, Sonnet) + spell/grammar cleanup (`/cleanup-text`, Haiku). |
| **Push flow** | Fresh `git clone` → edit → commit as `slinkywhat <nikihale00@gmail.com>` → branch → PR (never direct to `main`) → verify byte-exact blob → merge. |

**Current server version:** `2026-07-01-fixpack7`.

## 3. The two mapping tables (Airtable) — updated this phase

Both live in the same base. They are the canonical reference for how every field/value flows to each channel.

- **Channel Field Map** (`tbl5GLu5pigaxwR2F`) — one row per *attribute/concept*: which Airtable field → which Shopify destination (product field / variant / category metafield / custom metafield / tag / collection), the category condition (Wreaths vs Flowering Plants vs Both), the Meta and Etsy targets, transform logic, and **Build status** (Live / Planned / Needs build). Now **39 rows**, with everything shipped marked **Live**.
- **Value Crosswalk** (`tbljU1MH4KEQS8mtK`) — one row per *value* that needs reconciling (e.g. EB "Burgundy" → Shopify "Red"), with Match type (Exact / Mapped (nearest) / Custom value / No match → fallback) and where the exact value still lives (title/tags/description). Now **55 rows**.

## 4. The Shopify data model (how publishing actually works)

- **Product category is auto-set from Type:** Wreath → *Wreaths* (`hg-3-76-2`); every other Type → *Artificial Flowering Plants* / "AFP" (`hg-3-2-1`); Add-on left blank. This gates which metafields are valid — **setting a metafield invalid for the category fails the whole atomic `productUpdate`** (this caused the wreath-category-cascade bug, PR #35).
- **Taxonomy attributes publish as metaobject references.** The server holds hardcoded name→GID maps (`SHOPIFY_*_METAOBJECTS` in `server.js`) built from Shopify's taxonomy. Missing metaobjects are created lazily; non-taxonomy EB values **crosswalk to the nearest taxonomy value** but keep a **custom label** so they publish as themselves (e.g. decoration "Grapevine" → Wood taxonomy, label "Grapevine").
- **Category-specific splits:**
  - *AFP:* plant-name, suitable-location (rooms), arrangement, plant-container-type, stem-length, decoration-material, planter-material.
  - *Wreaths:* plant-name, suitable-space (Indoors/Outdoors), season, celebration-type, lighting-options, shape — **plus `material` = Synthetic + the decoration/planter materials folded in** (Wreaths have no decoration/planter attributes).
- **Universal custom metafields** (all products, any category): `custom.care_instructions`, `custom.indoor_outdoor`, `custom.suggested_display`.
- **Color + Pattern share one attribute** (`shopify.color-pattern`) — Shopify has no separate Pattern field.
- **Occasion / Season are universal via tags + collection**, with native metafields only on Wreaths.

## 5. Critical changes by theme (PR #15 → #46)

### Foundation & fields (#15–#21)
Renamed field keys (Product description / Internal notes), added Date-made picker (#15). **EB colors → Shopify native Color attribute** via color-pattern metaobjects (#16). Searchable multi-select component; Pattern + Plant name + Location publish mapping (#18, superseding the closed #17). Step 1 split into two screens + new fields + alphabetized (#21).

### Publish reliability (#20, #22–#28, #35)
The recurring saga: **inventory kept publishing as 0.** Root causes, in order: REST `set.json` deprecated in 2026-04 (#20); invalid `ignoreCompareQuantity` (#28); and the **real fix** — 2026-04 `inventorySetQuantities` needs the `@idempotent` directive + `changeFromQuantity:null` (#35). Also: metaobject mapping via hardcoded GID maps (#22), AFP/shared metafield gating (#23), publish crash on multi-value Occasion arrays (#26), always set plant-material=Artificial (#27).

### Full taxonomy mapping (#29–#37)
Wreath enablement — Shape, Lighting, Celebration, Material=Synthetic (#29). **Re-sync** feature (add-only attribute merge + inventory reset) for already-listed pieces (#30, #32). Complete value maps: Colors + Pattern (#31), Decoration + Planter material (#33), plant names/locations/arrangement/container/stem (#34). Wreath `material` derived from decoration+planter (#36). **Custom metaobject labels preserved** + season/suitable-space/plant-name wired on wreaths (#37).

### Data integrity (#38–#40)
Locked multi-selects to curated options (no free-typed values that won't map) (#38). **Stopped wiping Draft Title/Description** from Airtable on publish — they *are* the record of what went live + the Meta/Etsy source (#39). Removed "Everyday" from Occasion (#40).

### Step 1 restructure + cross-field intelligence (#42–#44)
Step 1 rebuilt into **sub-screens 1.1–1.5** (basics → shared details → "publishes to Shopify" (own category) → "optional, not published" (other category) → assign EB number), category-aware and re-bucketing on Type change (#42). **Indoor/Outdoor consolidated** to one input and made universal via `custom.indoor_outdoor` (#42/#43). **Bidirectional cross-field auto-fill** (#43): Occasion ↔ Celebration type, holiday → Season, Season↔Celebration "Summer", Decoration→Lighting, Arrangement↔Container — additive, non-destructive, delta-based. Wreath lighting default, Arrangement value cleanup, folder search, sentence-case Fix, and **AI copy no longer references Omaha** (#44).

### New attributes & UX (#45–#46)
**Suggested display** — new custom metafield for the display surface/spot (mantle, shelf, table…), 15 values, distinct from room-level Suitable location (#45). Drive folder picker rebuilt as a **unified single-select searchable combobox** (#46).

## 6. Meta / Etsy decisions recorded this phase

- **Care instructions:** structured on Shopify (`custom.care_instructions`); **Meta & Etsy have no care field → fold into the description** there.
- **Florals (Real-Feel/Silk) & Greenery (Premium/Standard):** **NOT structured data anywhere.** Real-Feel florals and Premium greenery are **touted as benefits in the AI description**; Silk/Standard are baseline and never mentioned (#44).
- **Colors:** exact shade kept in title/tags (and Meta/Etsy free text); nearest standard taxonomy color used for the structured attribute.
- **Occasion:** universal via tags + holiday-and-seasonal collection on all types; native celebration_type only on Wreaths; Thanksgiving/Sympathy/Funeral have no celebration value (tag/collection only). Etsy *does* have Thanksgiving / July-4th holiday values (noted for the Etsy build).
- **Category → Meta:** product.category drives `google_product_category` / `fb_product_category`.
- **SKU = EB Number** is the universal cross-platform key (sync tools like Trunk/LitCommerce match on it).

## 7. Hard-won discoveries / gotchas (don't relearn these)

1. **Category cascade:** a metafield invalid for the product's category fails the *entire* atomic `productUpdate`, silently rolling back the category too. Always gate metafields by category (`CATEGORY_METAFIELD_KEYS`).
2. **`shopify--material` is unique per taxonomy value** (reuse-by-taxonomy-reference, not create-by-label). Creating a 2nd material metaobject for a claimed value fails silently → the value drops. color-pattern & decoration-material are *not* unique (multiple labels per value OK).
3. **Reserved `shopify.*` namespace:** `metafieldsDelete` is **blocked** on it — clear a list metafield by `productUpdate` with value `"[]"` instead.
4. **Airtable connector can't edit select-option *definitions*** (only formulas + record values). Retiring options = clear record values via API, then delete the option definitions by hand in the Airtable field editor.
5. **The Airtable `Shopify tags` field is a formula derived from Occasion** — it can't recover lost Occasion data; the live Shopify `Holiday_*` tags are the recoverable snapshot.
6. **Live product is the post-publish snapshot** for anything wiped from Airtable (title→Draft Title, descriptionHtml→Draft Description; match by SKU=EB Number).
7. **PR hygiene:** PR #42 was merged with only its first commit — a follow-up commit pushed to the branch *after* merge got stranded and needed re-doing in #43. **Merge a PR before pushing follow-ups**, or open the follow-up as its own PR.
8. **Programmatic `npSetChecks` doesn't fire `change`** — that's *why* the cross-field auto-fill (listeners on real user `change` only) doesn't churn during edit-load/WIP-restore.

## 8. Current state

- **Live & working:** the full publish path for Wreaths + AFP — category, colors/pattern, plant-name, materials (incl. wreath Material), arrangement/container/stem, celebration/lighting/shape/season, suitable-location/space, inventory, title/description/SEO/images/tags/collections/price/weight, care_instructions, indoor_outdoor, suggested_display. Re-sync for existing listings. Cross-field auto-fill. Drive photo linking.
- **Airtable is fully mapped;** both mapping tables reflect reality as of #46.

## 9. Open backlog (not yet done)

- **Manual:** delete the now-unused Arrangement option *definitions* in the Airtable field editor (record values already cleared).
- Add more **Care instruction** options (Airtable field + `CARE_OPTIONS` currently has ~1).
- **Skip-photo-checklist → Step 2 auto-select bug** (new piece not auto-selected without a refresh).
- **Re-sync inventory behavior** — currently resets qty; revisit once Airtable is a bidirectional source of truth (sales syncing back from Shopify/Meta/Etsy).
- **Meta & Etsy builds** — mapped but not implemented (Etsy needs `when_made`, its own SEO tags, Thanksgiving/July-4th holiday values; Meta needs the catalog feed).
- **Style** — Airtable-only today; candidate custom metafield/tag later.

## 10. Where things live

- **Code anchors (`master.html`):** `NP_OPTIONS` (curated value lists), `NP_INFER` (cross-field auto-fill rules), `msInit` (multi-select component), `npApplyCategoryBuckets` (1.3/1.4 bucketing), `npFolderCombo*` (folder picker), Step 2.1 publish payload (`/create-product` fetch).
- **Code anchors (`server.js`):** `SHOPIFY_*_METAOBJECTS` maps, `CATEGORY_METAFIELD_KEYS`, `mapIndoorOutdoorList`, `resolveWreathMaterialGids`, `/create-product`, `/resync-attributes`, `/generate-description`, `/cleanup-text`, `/version`.
- **Airtable:** `Inventory` (pieces), **Channel Field Map** + **Value Crosswalk** (the mapping reference), Costs, Sales, Bins.
- **Deep project memory** (assistant's persistent notes) covers: comprehensive metaobject mapping + all custom-metafield details, inventory-zero root cause, Airtable integration audit, color mapping, re-sync behavior, and the outstanding backlog.

## Appendix — PR index (#15–#46)

| # | Title |
|---|---|
| 15 | Rename field keys (Product description / Internal notes) + Date made picker |
| 16 | Publish EB colors to Shopify's native Color attribute |
| 17 | (closed) Searchable multi-select + Pattern/Plant name |
| 18 | Recover master.html + searchable multi-select + Pattern/Plant/Location mapping |
| 19 | Suppress Chrome print headers/footers on hang tags & bin labels |
| 20 | Fix inventory quantity not setting (REST set.json deprecated 2026-04) |
| 21 | Step 1 split into two screens + new fields + alphabetize |
| 22 | Fix metaobject mapping (hardcoded GID maps) + inventory logging + /version |
| 23 | Inventory scope fix + AFP/shared metafield mapping |
| 24 | Report granted Shopify scopes in /health |
| 25 | Fix dead Publish button (unguarded lp-meta access) |
| 26 | Fix publish crash on multi-value Occasion (array) |
| 27 | Always set plant-material = Artificial on categorised products |
| 28 | Fix inventory always 0 (remove invalid ignoreCompareQuantity) |
| 29 | Wreath enablement: Shape, Lighting, Celebration, Material=Synthetic |
| 30 | Re-sync attributes & inventory (add-only) for existing listings |
| 31 | Full Colors + Pattern mapping |
| 32 | Move Re-sync to its own home card (published pieces only) |
| 33 | Full Decoration + Planter material mapping |
| 34 | Complete build (plant names, locations, arrangement/container/stem) |
| 35 | Fix inventory=0 (2026-04 inventorySetQuantities) + wreath category cascade + lighting GID swap |
| 36 | Wreaths: populate shopify.material from Decoration + Planter materials |
| 37 | Preserve custom metaobject labels + wire plant-name/season/suitable-space on wreaths |
| 38 | Step 1 form: Indoor/Outdoor selector, lock multi-selects, default wreath Shape=Round |
| 39 | Stop wiping Draft Title/Description from Airtable on publish |
| 40 | Remove 'Everyday' from Occasion options |
| 41 | Step 2.1: Care instructions + Indoor/Outdoor; publish care to custom.care_instructions |
| 42 | Step 1 restructure (1.1–1.5) + Indoor/Outdoor consolidation & universal metafield |
| 43 | Indoor/Outdoor universal metafield + Occasion/Decoration → Celebration/Lighting auto-fill |
| 44 | Wreath lighting default · Arrangement cleanup · description tweaks · folder search · sentence-case Fix |
| 45 | Add 'Suggested display' field (Airtable + custom.suggested_display + Step 2.1) |
| 46 | Drive folder picker: unified single-select searchable combobox |
