# Product Lookup UI — Build Specification (handoff)

## 1. Goal

Build a **simple, read-only** web UI where the client can look up a product by
**barcode, SKU, or name** and see its **pipeline journey** — either:

- it's **live** (status `promoted`), or
- it was **filtered out** (status `rejected`) and **exactly which filter + why**.

This UI is a **consumer of existing data**. It does **not** run the pipeline,
and it must **never write** to the database.

## 2. Where the data lives

The CBBC pipeline writes one row per product per run into a Postgres table named
**`product_pipeline_status`**. The UI just queries that table.

## 3. Database connection (important)

- The DB is **Postgres hosted on Railway**.
- Deploy this UI **as a service in the *same* Railway project** as the DB, so it
  can use the **private internal URL** (no egress fees).
- Connection string: read **`DATABASE_URL`** from the environment. Railway
  auto-injects this when the Postgres plugin is in the same project. It resolves
  to `*.railway.internal` (private network only).
- **Do NOT use `DATABASE_PUBLIC_URL`** — that's the public/external URL: it costs
  egress fees and exposes the DB. (Use it *only* for local development, and only
  temporarily.)

## 4. Schema — `product_pipeline_status`

```sql
id           BIGINT       PRIMARY KEY (generated identity)
run_id       TEXT         -- which weekly run produced this row
product_code TEXT         -- SKU
model_code   TEXT         -- nullable
barcode      TEXT         -- nullable
vendor_name  TEXT         -- nullable
name_en      TEXT         -- nullable
status       TEXT         -- 'promoted' | 'rejected'
journey      JSONB        -- array of steps (see below)
created_at   TIMESTAMPTZ
```

Indexes exist on `barcode`, `product_code`, and `run_id`.

### `journey` JSONB shape

An ordered array of steps (usually a single step). Each step:

```jsonc
// rejection step:
{ "stage": "eligibility", "outcome": "rejected", "reason": "no_stock" }

// rejection with extra detail (validation failures):
{
  "stage": "eligibility",
  "outcome": "rejected",
  "reason": "validation_errors",
  "details": { "validation_errors": [ { "field": "barcode", "value": "...", "reason": "..." } ] }
}

// success step:
{ "stage": "promoted", "outcome": "passed" }
```

Rule of thumb for the UI: **the rejection step IS the answer** — render its
`stage` + `reason` in plain language.

## 5. Stage & reason reference (exact strings)

| stage | meaning | possible `reason` values |
|---|---|---|
| `brand_filter` | dropped — vendor not in the approved brand list | `brand_not_whitelisted` |
| `parent_pre_screen` | a parent row that wasn't sellable on its own | `no_product_code`, `no_name`, `no_brand`, `no_vendor`, `no_categories`, `invalid_barcode`, `no_price`, `no_stock`, `no_image` |
| `consistency` | variant conflicted with its parent model's brand/vendor/category | `inconsistent_variant` |
| `eligibility` | failed a final eligibility check | `no_name`, `no_brand`, `no_vendor`, `no_categories`, `invalid_barcode`, `no_price`, `no_stock`, `no_image`, `validation_errors` |
| `model_cap` | model beyond the (dev-only) model limit | `model_cap` |
| `stale_cleanup` | was live, removed because no longer in the feed | `removed_stale` |
| `promoted` | passed everything, went live | (none — `outcome: "passed"`) |

## 6. Search semantics

- Search by **barcode** (exact), **SKU** (`product_code`, exact), or **name**
  (partial, case-insensitive).
- The last **8 runs** are retained, so a product may appear in several `run_id`s.
  Show the **most recent** first (`ORDER BY created_at DESC`), and consider
  collapsing to the latest run per product.
- A product may be **absent** entirely (new, or older than 8 runs). Handle
  "no results" gracefully.

## 7. Recommended queries

```sql
-- by barcode (exact)
SELECT * FROM product_pipeline_status
WHERE barcode = $1
ORDER BY created_at DESC;

-- by SKU (exact)
SELECT * FROM product_pipeline_status
WHERE product_code = $1
ORDER BY created_at DESC;

-- by name (partial, case-insensitive)
SELECT * FROM product_pipeline_status
WHERE name_en ILIKE '%' || $1 || '%'
ORDER BY created_at DESC
LIMIT 50;

-- latest run's row per product
SELECT DISTINCT ON (product_code) *
FROM product_pipeline_status
ORDER BY product_code, created_at DESC;
```

## 8. UI requirements (keep it simple)

- One search box (barcode / SKU / name).
- Results list: barcode, SKU, name, `status` badge, latest run.
- Detail view: `LIVE` (promoted) vs `FILTERED OUT` (rejected) + the journey steps
  with plain-language reasons.
- Read-only. Auth is optional — a simple shared token or basic auth is fine, but
  not required for v1.

## 9. Tech stack (suggestions)

Anything that runs as a **Railway web service** works. Simplest:

- **Node + Express/Fastify** serving a static page + a `GET /api/search?q=…`
  endpoint, using the `pg` (node-postgres) driver. No ORM needed.
- Or Next.js / Remix if you prefer.

Requirements: it must expose an HTTP server (so Railway assigns a public URL)
and read `DATABASE_URL` from env.

## 10. Deployment (Railway)

1. New **web service** in the **same Railway project** as the DB.
2. Connect the fresh repo; set build + start command.
3. Confirm `DATABASE_URL` is present (Railway auto-injects the Postgres private
   URL when the DB is in the same project).
4. Railway auto-assigns a public URL; optionally attach a custom domain.
5. **Do not** set a Cron Schedule — this is an always-on web service, unlike the
   pipeline worker.

## 11. Gotchas

- The private `DATABASE_URL` only resolves **inside** Railway. Local dev needs
  `DATABASE_PUBLIC_URL` (the egress path — dev only).
- `barcode`, `model_code`, `vendor_name`, `name_en` can be **NULL** (e.g.,
  stale-cleanup rows for models).
- `journey` is JSONB — parse it server- or client-side.
- Only **8 runs** are kept; older data is pruned by the pipeline.
- **Never write** to the DB from this UI.

## 12. Acceptance criteria

- [ ] Search by barcode shows the product's `status` + the rejection stage/reason
      (or "live").
- [ ] Search by SKU and partial name both work.
- [ ] "Not found" renders gracefully.
- [ ] In prod it connects via the **private** `DATABASE_URL` (no egress).