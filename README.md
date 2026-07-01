# eb-inventory-tool

Inventory + listing tool for **Eternal Blooms Designs**, a handmade artificial-floral
business (wreaths, centerpieces, planters, swags, wall decor). It catalogs each
one-of-a-kind piece in Airtable, assigns an **EB number**, and publishes it to
**Shopify** as a fully-attributed product. Meta (Facebook/Instagram) and Etsy are
mapped and planned as downstream channels.

## Repo layout

Only two files matter at runtime:

| File | Role | Hosting |
|---|---|---|
| `master.html` | The single-page app (wizard UI + all client JS) | GitHub Pages |
| `server.js` | Express proxy + Shopify publishing server | Render (auto-deploys from `main`) |

Supporting files: `cheatsheet.html` (printable quick-reference for the operator),
`EB-CONTEXT-LOG.md` (developer/handoff context for the data-mapping work),
`index.html` / `dashboard.html` / `listing.html` (earlier standalone screens),
`package.json` (server deps).

## How it works

- **Airtable is the source of truth.** Every piece is a row in the `Inventory` table.
  The app never talks to Airtable directly — all calls proxy through `server.js`
  (the Airtable token lives on the server, not in the browser).
- **Publishing** maps Airtable fields → Shopify product fields, native taxonomy
  metaobjects (per product category), and custom metafields. Product category is
  auto-set from Type (Wreath → Wreaths; everything else → Artificial Flowering Plants).
- **AI** (Anthropic API, via the server) generates the listing title, description,
  and SEO meta, and cleans up free text.
- **Google Drive** holds product photos; the app links a piece to its Drive folder
  and pulls photos in at publish time.

The full field/value mapping across Shopify, Meta, and Etsy lives in two Airtable
tables — **Channel Field Map** and **Value Crosswalk** — and is narrated in
[`EB-CONTEXT-LOG.md`](EB-CONTEXT-LOG.md).

## Live URLs

- **App:** https://roberthale65-cyber.github.io/eb-inventory-tool/master.html
- **Server:** https://eb-shopify-server.onrender.com
- **Health check:** https://eb-shopify-server.onrender.com/health
- **Version:** https://eb-shopify-server.onrender.com/version

## Running the server locally

```bash
npm install
npm start        # node server.js
```

Requires **Node ≥ 18**. Configure via environment variables (set on Render in
production):

| Variable | Purpose |
|---|---|
| `AIRTABLE_TOKEN` | Airtable API token (Inventory base) |
| `SHOPIFY_TOKEN` | Shopify Admin API access token |
| `ANTHROPIC_API_KEY` | AI title/description/cleanup generation |
| `GOOGLE_REFRESH_TOKEN` | Google Drive access (photos/video) |

The front end (`master.html`) is static — open it directly or serve the folder;
it points at the Render server for all data operations.

## Deploying

- **Server:** merge to `main` → Render auto-deploys `server.js`. Confirm with `/version`.
- **App:** GitHub Pages serves `master.html` from `main` on merge.

Work on a branch and open a PR; never commit directly to `main`.

## Operator guide

Non-technical day-to-day steps (New Piece → List & Publish → Mark as Sold →
Craft Fair → Log a Cost) are in [`cheatsheet.html`](cheatsheet.html).
