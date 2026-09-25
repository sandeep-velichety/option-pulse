import pg from 'pg';

const { Pool } = pg;

const url = process.env['EXEC_DATABASE_URL'];
if (!url) {
  throw new Error('[execution] EXEC_DATABASE_URL is required');
}

export const pool = new Pool({
  connectionString: url,
  max: 5,
});

pool.on('error', (err) => {
  console.error('[execution] idle client error', err);
});
