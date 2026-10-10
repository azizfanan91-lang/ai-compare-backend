const express = require('express');
const db = require('./database');
const { requireAuth } = require('./authMiddleware');

const router = express.Router();
const MAX_SAVED_RESULTS = 100;

router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, kind, title, content, model, created_at
       FROM saved_results
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [req.userId, MAX_SAVED_RESULTS]
    );
    res.json({ results: result.rows });
  } catch (err) {
    console.error('خطأ فـ جلب النتائج المحفوظة:', err);
    res.status(500).json({ error: 'تعذّر جلب النتائج المحفوظة' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  const { kind = 'text', title, content, model = null } = req.body || {};
  const cleanTitle = String(title || 'نتيجة محفوظة').trim().slice(0, 160);
  const cleanContent = String(content || '').trim();
  if (!cleanContent) return res.status(400).json({ error: 'ما كايناش نتيجة للحفظ' });
  if (cleanContent.length > 100000) return res.status(400).json({ error: 'النتيجة طويلة بزاف للحفظ' });

  try {
    const result = await db.query(
      `INSERT INTO saved_results (user_id, kind, title, content, model)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, kind, title, content, model, created_at`,
      [req.userId, String(kind).slice(0, 40), cleanTitle, cleanContent, model ? String(model).slice(0, 120) : null]
    );
    res.status(201).json({ result: result.rows[0] });
  } catch (err) {
    console.error('خطأ فـ حفظ النتيجة:', err);
    res.status(500).json({ error: 'تعذّر حفظ النتيجة' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'معرّف غير صالح' });
  try {
    const result = await db.query(
      'DELETE FROM saved_results WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.userId]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'النتيجة ما لقايناش' });
    res.json({ ok: true });
  } catch (err) {
    console.error('خطأ فـ حذف النتيجة المحفوظة:', err);
    res.status(500).json({ error: 'تعذّر حذف النتيجة' });
  }
});

module.exports = router;
