// Routes خاصة بيك أنت غير (Admin) — باش تفعل المشتركين يدويا بعد ما يخلصو عبر PayPal
// محمي بكلمة سر سرية (ADMIN_SECRET) خاصك تحطها فـ Environment Variables

const express = require('express');
const db = require('./database');

const router = express.Router();

function checkAdminSecret(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
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

// POST /api/admin/activate - فعل مستخدم كـ premium بالإيميل ديالو
router.post('/activate', checkAdminSecret, async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'خاص الإيميل' });
  }

  try {
    const result = await db.query(
      'UPDATE users SET is_premium = 1 WHERE email = $1',
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
      'UPDATE users SET is_premium = 0 WHERE email = $1',
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
