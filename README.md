# CBBC Product Lookup UI

A small, **read-only** web app that lets the client search for a product (by
barcode, SKU, or name) and see its pipeline status: either **live** (`promoted`)
or **filtered out** (`rejected`) with the exact filter stage + reason.

It reads the `product_pipeline_status` table written by the CBBC pipeline.
It never writes to the database.

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

## API

- `GET /api/search?q=<barcode|sku|name>` → `{ query, results: [...] }`
- `GET /api/health` → `{ ok: true }`

See `instructions.md` for the full schema, stage/reason reference, and query
details.
