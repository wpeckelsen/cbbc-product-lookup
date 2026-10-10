# Frontend brief — Brand whitelist management

## 1. Context

There are two services in the same Railway project sharing one PostgreSQL
database:

- A Node/TypeScript **pipeline** (separate repo) that downloads the supplier
  (Duell) product feed, filters it to whitelisted brands, and syncs to Shopify.
  It runs on a schedule (cron) and exits — it is NOT an always-on server.
- This **frontend**, which already has authentication and a product-status
  search against the same database.

This brief adds a brand whitelist manager to the frontend. The backend data
model already exists (created by a migration in the pipeline repo). The
frontend must read/write those tables and add a small UI.

## 2. Data model (already exists — do NOT recreate or alter)

All tables are in the `public` schema of the shared Postgres DB.

### brand_catalog  — "all possible brands"  (READ-ONLY for the frontend)

| column | type | notes |
|---|---|---|
| `brand_key` | TEXT, PRIMARY KEY | canonical key (see §3) |
| `display_name` | TEXT NOT NULL | supplier's name, case preserved |

The pipeline refreshes this table every run from the supplier feed and also
removes brands no longer present. The FTP feed is the source of truth. The
frontend must never write to this table.

### brand_whitelist — "currently whitelisted brands"  (read + write)

| column | type | notes |
|---|---|---|
| `brand_key` | TEXT, PRIMARY KEY | canonical key |
| `display_name` | TEXT NOT NULL | snapshot name |
| `added_at` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

An empty table means "allow all brands" (the pipeline then filters nothing).

### brand_whitelist_events — append-only audit log  (write + read)

| column | type | notes |
|---|---|---|
| `id` | BIGINT identity, PRIMARY KEY | |
| `brand_key` | TEXT NOT NULL | canonical key |
| `display_name` | TEXT NOT NULL | snapshot at action time |
| `action` | TEXT NOT NULL | CHECK: only `'add'` or `'remove'` |
| `actor` | TEXT NOT NULL | authenticated user identity |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

Rows are NEVER updated or deleted. A brand that is added → removed → re-added
produces three separate rows.

## 3. Brand identity — canonicalization (MUST match the pipeline exactly)

A brand's identity is its `brand_key`. Both the frontend and the pipeline run
every brand name through the SAME transformation so spellings that differ only
in case / underscores / whitespace collapse to the same brand.

```
canonicalizeBrand(raw):
  if raw is not a string: return ''
  return raw
    .toLowerCase()
    .replace(/_/g, ' ')        // underscores → spaces
    .replace(/\s+/g, ' ')      // collapse runs of whitespace to one space
    .trim()

displayBrand(raw):
  if raw is not a string: return ''
  return raw
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()                    // preserves case (no title-casing)
```

Examples:

| Input        | brand_key        | display_name |
|--------------|------------------|--------------|
| `Yakk_exp`   | `yakk exp`       | `Yakk Exp`   |
| `Yakk Exp`   | `yakk exp`       | `Yakk Exp`   |
| `SENA`       | `sena`           | `SENA`       |
| `K&N`        | `k&n`            | `K&N`        |
| `Star_Brite` | `star brite`     | `Star Brite` |
| `Bike-Lift`  | `bike-lift`      | `Bike-Lift`  |

IMPORTANT:

- Hyphens, ampersands, and other characters are LEFT UNTOUCHED. Only
  lowercasing + underscore/whitespace handling is applied.
- `Metzler` and `Metzeler` are DIFFERENT keys (`metzler` vs `metzeler`).
  Canonicalization does not merge them — that is a real spelling difference.
- The canonicalizer must be implemented on the SERVER (the API), not just in
  the browser, because it decides what gets written to the database.

## 4. API endpoints to build

Authenticate all endpoints with the existing auth. The `actor` for audit events
must come from the authenticated session on the backend — NEVER from a value
the client submits.

### 4.1 List whitelisted brands

`GET /brands/whitelist?q=<optional search term>`

Response (array):

```
{ "brand_key": "yakk exp",
  "display_name": "Yakk Exp",
  "in_catalog": true }
```

- `display_name`: prefer `brand_catalog.display_name` (joined on `brand_key`);
  fall back to `brand_whitelist.display_name` when the brand is no longer in
  the catalog.
- `in_catalog`: whether the key currently exists in `brand_catalog` (lets the
  UI flag "no longer in supplier feed").

### 4.2 List all brands

`GET /brands/catalog?q=<optional search term>`

Response (array):

```
{ "brand_key": "yakk exp",
  "display_name": "Yakk Exp",
  "whitelisted": false }
```

- `whitelisted`: whether the key exists in `brand_whitelist` (so the UI can
  show "already whitelisted" vs "add").

### 4.3 Add a brand

`POST /brands/whitelist`

Body: `{ "brand_key": "yakk exp" }`  (a raw name is also acceptable — the
server must canonicalize it before use).

Behavior, in a single DB transaction:

1. `brand_key = canonicalizeBrand(input)`; reject if empty.
2. Resolve `display_name`: use `brand_catalog.display_name` for that key if
   present (source of truth); otherwise use `displayBrand(input)`.
3. Upsert into `brand_whitelist` (`ON CONFLICT (brand_key) DO NOTHING` is fine;
   adding an already-whitelisted brand is a no-op).
4. Insert one `brand_whitelist_events` row: `{ action: 'add', brand_key,
   display_name, actor }`.
5. Return the whitelist row.

### 4.4 Remove a brand

`DELETE /brands/whitelist/:brand_key`

Behavior, in a single DB transaction:

1. `brand_key = canonicalizeBrand(decodeURIComponent(:brand_key))`.
2. Read the current `display_name` from `brand_whitelist` (for the snapshot).
   If the brand is not whitelisted, return 404 and write NO event.
3. Delete the row from `brand_whitelist`.
4. Insert one `brand_whitelist_events` row: `{ action: 'remove', brand_key,
   display_name, actor }`.
5. Return 204 (or the removed row).

### 4.5 Audit history (read-only)

`GET /brands/events?brand_key=<optional>&limit=<optional, default 100>&offset=<optional>`

Response (array), ordered by `created_at DESC, id DESC`:

```
{ "id": 42, "brand_key": "yakk exp", "display_name": "Yakk Exp",
  "action": "remove", "actor": "you@client.com", "created_at": "..." }
```

No write/delete on this table.

## 5. UI behavior

- Two views/tabs: **Whitelisted brands** and **All brands**.
- **Fuzzy, realtime search**: the brand lists are small (a few hundred to low
  thousands). Recommended: fetch the full list once and fuzzy-filter in the
  browser on every keystroke (e.g. Fuse.js, or a small normalize+substring+
  Levenshtein matcher). This is not a heavy demand. Server-side `q` via
  `ILIKE`/trigram is an acceptable alternative but unnecessary.
- **Add**: from the "All brands" list, an "Add" action per brand (with the
  canonical key). Prefer a picker/type-ahead over free text to avoid typos;
  if free text is allowed, the server still canonicalizes.
- **Remove**: a confirm step that clearly warns: removing a brand means its
  products are dropped on the NEXT pipeline run and will be DELETED from the
  live Shopify store.
- **History**: a read-only "History" panel (newest first, filterable by brand)
  showing "X added Y / X removed Y" with timestamps.
- Show a visible indicator for whitelisted brands that are `in_catalog ===
  false` ("not currently in supplier feed").
- If the whitelist becomes empty, surface a warning that the pipeline will
  treat this as "allow all brands".

## 6. Rules / do NOTs

- Do NOT write to `brand_catalog` (pipeline owns it).
- Do NOT update or delete rows in `brand_whitelist_events` (append-only).
- Do NOT implement a "run now" button (out of scope).
- Do NOT use fuzzy matching to decide the actual whitelist action — the
  add/remove decision uses the exact canonical `brand_key`. Fuzzy is only for
  the search UX.
- Do NOT trust a client-supplied `actor` — read identity from the session.
- Keep add/remove + its audit event in ONE transaction.

## 7. Confirm with the codebase owner before starting

- Frontend stack/language and how auth exposes the current user identity
  (email/name) for the `actor` field.
- Where API routes/handlers and DB access live, and how the frontend connects
  to the shared Postgres (connection string / env var).

