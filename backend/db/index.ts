import pg from "pg";

/**
 * Postgres connection pool (Neon).
 *
 * DATABASE_URL format:
 *   postgresql://<user>:<password>@<endpoint>.neon.tech/<db>?sslmode=require
 *
 * Store the URL in Secrets Manager and inject via `secrets`/valueFrom in the
 * ECS task definition (same pattern as ANTHROPIC/ALPACA keys, MUR-182).
 */
// Return numerics/bigints as JS numbers (routes expect numbers, not strings).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : parseFloat(v)));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : parseInt(v, 10)));

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  max: 10,                      // Neon free tier allows plenty; keep modest
  idleTimeoutMillis: 30_000,    // release idle conns so Neon can autosuspend
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err) => {
  console.error("[db] idle client error", err);
});

/** Typed query helper. */
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as any[]);
}

/** Run `fn` inside a transaction; rolls back on throw. */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export default pool;
