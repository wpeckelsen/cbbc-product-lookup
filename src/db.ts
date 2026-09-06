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

export async function close(): Promise<void> {
  await pool.end();
}
