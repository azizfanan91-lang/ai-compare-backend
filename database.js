const { Pool } = require('pg');
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
});
pool.on('error', (err) => {
  console.error('خطأ غير متوقع في اتصال PostgreSQL:', err.message);
});

async function init() {
  await pool.query('SELECT 1');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_premium INTEGER DEFAULT 0,
      stripe_customer_id TEXT,
      paypal_subscription_id TEXT,
      gumroad_subscription_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS gumroad_subscription_id TEXT;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      UNIQUE(user_id, date)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS image_usage_log (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      UNIQUE(user_id, date)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_results (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL DEFAULT 'text',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      model TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS saved_results_user_created_idx
    ON saved_results (user_id, created_at DESC);
  `);
  console.log('قاعدة البيانات (Postgres) جاهزة ✅');
}

pool.ready = init();

module.exports = pool;
