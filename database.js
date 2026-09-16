const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_premium INTEGER DEFAULT 0,
      stripe_customer_id TEXT,
      paypal_subscription_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
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
  console.log('قاعدة البيانات (Postgres) جاهزة ✅');
}

init().catch(err => console.error('خطأ فـ تجهيز قاعدة البيانات:', err));

module.exports = pool;
