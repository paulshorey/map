import pg from 'pg';

const globalForPg = globalThis as unknown as { pool?: pg.Pool };

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/poi_map';

export const pool =
  globalForPg.pool ?? new pg.Pool({ connectionString: DATABASE_URL });

if (process.env.NODE_ENV !== 'production') {
  globalForPg.pool = pool;
}
