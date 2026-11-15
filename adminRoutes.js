// Routes خاصة بيك أنت غير (Admin) — باش تفعل المشتركين يدويا بعد ما يخلصو عبر Gumroad
// محمي بكلمة سر سرية (ADMIN_SECRET) خاصك تحطها فـ Environment Variables

const crypto = require('crypto');
const express = require('express');
const db = require('./database');

const router = express.Router();

function checkAdminSecret(req, res, next) {
  const secret = String(req.headers['x-admin-secret'] || '');
  const expected = String(process.env.ADMIN_SECRET || '');
  const a = Buffer.from(secret), b = Buffer.from(expected);
  // مقارنة بوقت ثابت، ورفض كامل إلا ADMIN_SECRET ماشي معرّف
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'ما عندكش الصلاحية' });
  }
  next();
}

// GET /api/admin/users - عرض لائحة كل المستخدمين
router.get('/users', checkAdminSecret, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, email, is_premium, created_at FROM users ORDER BY created_at DESC'
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error('خطأ فـ جيب المستخدمين:', err);
    res.status(500).json({ error: 'وقع مشكل فالسيرفر' });
  }
});

// GET /api/admin/stats - إحصائيات عامة للموقع (للأدمن فقط)
router.get('/stats', checkAdminSecret, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const since = new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10);
    const one = async (sql, params) => (await db.query(sql, params || [])).rows[0] || {};

    const users = await one(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE is_premium = 1)::int AS premium,
             COUNT(*) FILTER (WHERE created_at >= now() - interval '1 day')::int AS new_1d,
             COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS new_7d,
             COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS new_30d
        FROM users`);
    const chatToday = await one(
      'SELECT COALESCE(SUM(count),0)::int AS total, COUNT(DISTINCT user_id)::int AS users FROM usage_log WHERE date = $1', [today]);
    const imgToday = await one(
      'SELECT COALESCE(SUM(count),0)::int AS total, COUNT(DISTINCT user_id)::int AS users FROM image_usage_log WHERE date = $1', [today]);
    const saved = await one('SELECT COUNT(*)::int AS total FROM saved_results');

    const chatDays = (await db.query(
      'SELECT date, COALESCE(SUM(count),0)::int AS messages, COUNT(DISTINCT user_id)::int AS users FROM usage_log WHERE date >= $1 GROUP BY date ORDER BY date DESC', [since])).rows;
    const imgDays = (await db.query(
      'SELECT date, COALESCE(SUM(count),0)::int AS images FROM image_usage_log WHERE date >= $1 GROUP BY date ORDER BY date DESC', [since])).rows;
    const signups = (await db.query(
      "SELECT to_char(created_at, 'YYYY-MM-DD') AS date, COUNT(*)::int AS signups FROM users WHERE created_at >= now() - interval '14 days' GROUP BY 1 ORDER BY 1 DESC")).rows;

    res.json({
      today,
      users,
      chat_today: chatToday,
      images_today: imgToday,
      saved_results: saved.total,
      chat_days: chatDays,
      image_days: imgDays,
      signup_days: signups
    });
  } catch (err) {
    console.error('خطأ فـ الإحصائيات:', err);
    res.status(500).json({ error: 'وقع مشكل فالسيرفر' });
  }
});

// POST /api/admin/activate - فعل مستخدم كـ premium بالإيميل ديالو
router.post('/activate', checkAdminSecret, async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'خاص الإيميل' });
  }

  try {
    const result = await db.query(
      'UPDATE users SET is_premium = 1 WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'ما لقيتش هاد الإيميل' });
    }

    res.json({ success: true, message: 'تفعّل بنجاح: ' + email });
  } catch (err) {
    console.error('خطأ فـ التفعيل:', err);
    res.status(500).json({ error: 'وقع مشكل فالسيرفر' });
  }
});

// POST /api/admin/deactivate - إلغاء تفعيل مستخدم
router.post('/deactivate', checkAdminSecret, async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'خاص الإيميل' });
  }

  try {
    const result = await db.query(
      'UPDATE users SET is_premium = 0 WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'ما لقيتش هاد الإيميل' });
    }

    res.json({ success: true, message: 'تلغى التفعيل: ' + email });
  } catch (err) {
    console.error('خطأ فـ إلغاء التفعيل:', err);
    res.status(500).json({ error: 'وقع مشكل فالسيرفر' });
  }
});

module.exports = router;
