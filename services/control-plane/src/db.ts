import pg from 'pg';

const url = process.env['DATABASE_URL'];
if (!url) throw new Error('[control-plane] DATABASE_URL is required');

export const pool = new pg.Pool({ connectionString: url, max: 5 });

pool.on('error', (err) => {
  console.error('[control-plane] pg pool error', err);
});
