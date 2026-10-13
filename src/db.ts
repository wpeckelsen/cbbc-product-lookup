import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export interface TraceStep {
  stage: string;
  outcome: 'passed' | 'rejected';
  reason?: string;
  details?: unknown;
}

export interface ProductStatusRow {
  id: string;
  run_id: string;
  product_code: string;
  model_code: string | null;
  barcode: string | null;
  vendor_name: string | null;
  name_en: string | null;
  status: 'promoted' | 'rejected';
  journey: TraceStep[];
  created_at: string;
}

export interface WhitelistBrandRow {
  brand_key: string;
  display_name: string;
  in_catalog: boolean;
}

export interface CatalogBrandRow {
  brand_key: string;
  display_name: string;
  whitelisted: boolean;
}

export interface WhitelistEventRow {
  id: number;
  brand_key: string;
  display_name: string;
  action: 'add' | 'remove';
  actor: string;
  created_at: string;
}

/**
 * Canonicalize a brand name to its identity key. This MUST match the pipeline's
 * canonicalizer exactly: lowercase, underscores → spaces, collapse whitespace,
 * trim. Hyphens, ampersands and other characters are left untouched.
 */
export function canonicalizeBrand(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Human-facing brand name: underscores/whitespace normalized, case preserved. */
export function displayBrand(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * node-postgres parses JSONB into JS objects already, but be tolerant of a
 * string value just in case.
 */
function normalizeRows(rows: any[]): ProductStatusRow[] {
  return rows.map((r) => ({
    ...r,
    journey:
      typeof r.journey === 'string' ? JSON.parse(r.journey) : (r.journey ?? []),
  }));
}

/** node-postgres returns BIGINT as a string; convert the id back to a number. */
function normalizeEventRows(rows: any[]): WhitelistEventRow[] {
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/**
 * Search the pipeline trace table. A numeric query is treated as a barcode or
 * SKU (exact match on either); anything else is a partial name match.
 */
export async function search(q: string): Promise<ProductStatusRow[]> {
  const needle = q.trim();
  if (needle === '') return [];

  if (/^\d+$/.test(needle)) {
    const result = await pool.query(
      `SELECT * FROM product_pipeline_status
       WHERE barcode = $1 OR product_code = $1
       ORDER BY created_at DESC`,
      [needle],
    );
    return normalizeRows(result.rows);
  }

  const result = await pool.query(
    `SELECT * FROM product_pipeline_status
     WHERE name_en ILIKE '%' || $1 || '%'
     ORDER BY created_at DESC
     LIMIT 50`,
    [needle],
  );
  return normalizeRows(result.rows);
}

/** List whitelisted brands, preferring the catalog's display name when present. */
export async function listWhitelist(): Promise<WhitelistBrandRow[]> {
  const result = await pool.query(
    `SELECT w.brand_key,
            COALESCE(c.display_name, w.display_name) AS display_name,
            (c.brand_key IS NOT NULL) AS in_catalog
     FROM brand_whitelist w
     LEFT JOIN brand_catalog c ON c.brand_key = w.brand_key
     ORDER BY display_name`,
  );
  return result.rows;
}

/** List all brands in the catalog, flagging which are currently whitelisted. */
export async function listCatalog(): Promise<CatalogBrandRow[]> {
  const result = await pool.query(
    `SELECT c.brand_key,
            c.display_name,
            (w.brand_key IS NOT NULL) AS whitelisted
     FROM brand_catalog c
     LEFT JOIN brand_whitelist w ON w.brand_key = c.brand_key
     ORDER BY c.display_name`,
  );
  return result.rows;
}

/** Add a brand to the whitelist and record an audit event, atomically. */
export async function addBrand(
  input: string,
  actor: string,
): Promise<WhitelistBrandRow> {
  const brandKey = canonicalizeBrand(input);
  if (brandKey === '') throw new Error('Empty brand key');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const catalogRes = await client.query(
      'SELECT display_name FROM brand_catalog WHERE brand_key = $1',
      [brandKey],
    );
    const inCatalog = catalogRes.rows.length > 0;
    const displayName = inCatalog
      ? catalogRes.rows[0].display_name
      : displayBrand(input);

    await client.query(
      `INSERT INTO brand_whitelist (brand_key, display_name)
       VALUES ($1, $2)
       ON CONFLICT (brand_key) DO NOTHING`,
      [brandKey, displayName],
    );

    await client.query(
      `INSERT INTO brand_whitelist_events (brand_key, display_name, action, actor)
       VALUES ($1, $2, 'add', $3)`,
      [brandKey, displayName, actor],
    );

    await client.query('COMMIT');

    return { brand_key: brandKey, display_name: displayName, in_catalog: inCatalog };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Remove a brand from the whitelist and record an audit event, atomically.
 * Returns null when the brand was not whitelisted (caller should 404, no event).
 */
export async function removeBrand(
  brandKeyInput: string,
  actor: string,
): Promise<{ brand_key: string; display_name: string } | null> {
  const brandKey = canonicalizeBrand(brandKeyInput);
  if (brandKey === '') throw new Error('Empty brand key');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const current = await client.query(
      'SELECT display_name FROM brand_whitelist WHERE brand_key = $1',
      [brandKey],
    );
    if (current.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const displayName = current.rows[0].display_name;

    await client.query('DELETE FROM brand_whitelist WHERE brand_key = $1', [
      brandKey,
    ]);

    await client.query(
      `INSERT INTO brand_whitelist_events (brand_key, display_name, action, actor)
       VALUES ($1, $2, 'remove', $3)`,
      [brandKey, displayName, actor],
    );

    await client.query('COMMIT');

    return { brand_key: brandKey, display_name: displayName };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Read-only audit history, newest first. */
export async function listEvents(options: {
  brandKey?: string;
  limit: number;
  offset: number;
}): Promise<WhitelistEventRow[]> {
  const { brandKey, limit, offset } = options;
  const result = await pool.query(
    `SELECT id, brand_key, display_name, action, actor, created_at
     FROM brand_whitelist_events
     WHERE ($1::text IS NULL OR brand_key = $1)
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [brandKey ?? null, limit, offset],
  );
  return normalizeEventRows(result.rows);
}

export async function close(): Promise<void> {
  await pool.end();
}
