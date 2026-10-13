# CBBC Product Lookup UI

A small web app that lets the client search for a product (by barcode, SKU, or
name) and see its pipeline status: either **live** (`promoted`) or **filtered
out** (`rejected`) with the exact filter stage + reason.

It also provides a **brand whitelist manager**: add/remove brands from the
`brand_whitelist` table (with an append-only audit log in
`brand_whitelist_events`). Product search reads `product_pipeline_status`;
brand management reads `brand_catalog` (read-only) and writes
`brand_whitelist` + `brand_whitelist_events`.

## Run locally

```bash
npm install
cp .env.example .env     # set DATABASE_URL (use the public URL locally for dev)
npm run dev              # http://localhost:3000
```

## Build & run (production)

```bash
npm run build
npm start                # node dist/server.js
```

## Deploy (Railway)

1. Create a **web service** in the **same Railway project** as the Postgres DB.
2. Connect this repo; Railway detects the Dockerfile.
3. Confirm `DATABASE_URL` is present — Railway auto-injects the Postgres
   **private** internal URL (no egress fees). Do **not** use the public URL.
4. Railway assigns a public URL; optionally attach a custom domain.

## Authentication

The UI is protected by **HTTP Basic Auth**. Provide one or more users via the
`AUTH_USERS` environment variable (comma-separated `user:password` pairs):

```
AUTH_USERS=alice:secret,bob:hunter2
```

The authenticated username is recorded as the `actor` in the brand audit log.

- If `AUTH_USERS` is empty, the legacy `AUTH_USER`/`AUTH_PASS` pair is used.
- If all auth vars are **empty**, auth is disabled (open access) — fine for
  local dev.
- If set, the browser prompts for a username/password before serving the page
  or any data.
- `/api/health` is always open (it returns nothing sensitive).

## API

- `GET /api/search?q=<barcode|sku|name>` → `{ query, results: [...] }`
- `GET /api/health` → `{ ok: true }`
- `GET /brands/whitelist` → whitelisted brands (array)
- `GET /brands/catalog` → all catalog brands (array)
- `POST /brands/whitelist` → add a brand (`{ "brand_key": "..." }`)
- `DELETE /brands/whitelist/:brand_key` → remove a brand
- `GET /brands/events?brand_key=&limit=&offset=` → audit history

See `instructions.md` for the full schema, stage/reason reference, and query
details.
