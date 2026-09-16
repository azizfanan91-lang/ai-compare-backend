const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./database');

const router = express.Router();

router.post('/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'خاصك تعمر الإيميل وكلمة السر' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'كلمة السر خاصها تكون 6 حروف/أرقام على الأقل' });
  }
  try {
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'هاد الإيميل مسجل من قبل' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [email, passwordHash]
    );
    const token = jwt.sign({ userId: result.rows[0].id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, email, is_premium: false });
  } catch (err) {
    console.error('خطأ فـ التسجيل:', err);
    res.status(500).json({ error: 'وقع مشكل فالسيرفر، جرب مرة أخرى' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'خاصك تعمر الإيميل وكلمة السر' });
  }
  try {
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'الإيميل ولا كلمة السر غالطين' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'الإيميل ولا كلمة السر غالطين' });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, email: user.email, is_premium: !!user.is_premium });
  } catch (err) {
    console.error('خطأ فـ الدخول:', err);
    res.status(500).json({ error: 'وقع مشكل فالسيرفر، جرب مرة أخرى' });
  }
});

module.exports = router;
