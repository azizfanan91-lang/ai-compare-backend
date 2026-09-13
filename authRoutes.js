// Routes ديال التسجيل وتسجيل الدخول

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

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(409).json({ error: 'هاد الإيميل مسجل من قبل' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const result = db.prepare(
    'INSERT INTO users (email, password_hash) VALUES (?, ?)'
  ).run(email, passwordHash);

  const token = jwt.sign({ userId: result.lastInsertRowid }, process.env.JWT_SECRET, {
    expiresIn: '30d'
  });

  res.json({ token, email, is_premium: false });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'خاصك تعمر الإيميل وكلمة السر' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    return res.status(401).json({ error: 'الإيميل ولا كلمة السر غالطين' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'الإيميل ولا كلمة السر غالطين' });
  }

  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
    expiresIn: '30d'
  });

  res.json({ token, email: user.email, is_premium: !!user.is_premium });
});

module.exports = router;
