const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('./database');

const router = express.Router();

// صلاحية الجلسة: 7 أيام بدل 30 (تقدر تبدلها من Render بـ JWT_EXPIRES_IN، مثلا 14d)
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 72;          // bcrypt كيقطع كلمات السر لـ 72 بايت
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// hash وهمي: كنقارنو بيه ملي الإيميل ماكاينش، باش وقت الجواب ما يكشفش واش الإيميل مسجل
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function signToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256' });
}

router.post('/signup', async (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  const password = req.body && req.body.password;
  if (!email || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'خاصك تعمر الإيميل وكلمة السر' });
  }
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'الإيميل ماشي صحيح' });
  }
  if (password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `كلمة السر خاصها تكون ${MIN_PASSWORD} حروف/أرقام على الأقل` });
  }
  if (Buffer.byteLength(password) > MAX_PASSWORD) {
    return res.status(400).json({ error: 'كلمة السر طويلة بزاف' });
  }
  try {
    const existing = await db.query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'هاد الإيميل مسجل من قبل' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [email, passwordHash]
    );
    res.json({ token: signToken(result.rows[0].id), email, is_premium: false });
  } catch (err) {
    // تسجيلين فـ نفس اللحظة بنفس الإيميل
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'هاد الإيميل مسجل من قبل' });
    }
    console.error('خطأ فـ التسجيل:', err.message);
    res.status(500).json({ error: 'وقع مشكل فالسيرفر، جرب مرة أخرى' });
  }
});

router.post('/login', async (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  const password = req.body && req.body.password;
  if (!email || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'خاصك تعمر الإيميل وكلمة السر' });
  }
  if (Buffer.byteLength(password) > MAX_PASSWORD) {
    return res.status(401).json({ error: 'الإيميل ولا كلمة السر غالطين' });
  }
  try {
    const result = await db.query(
      'SELECT id, email, password_hash, is_premium FROM users WHERE LOWER(email) = $1',
      [email]
    );
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !valid) return res.status(401).json({ error: 'الإيميل ولا كلمة السر غالطين' });
    res.json({ token: signToken(user.id), email: user.email, is_premium: !!user.is_premium });
  } catch (err) {
    console.error('خطأ فـ الدخول:', err.message);
    res.status(500).json({ error: 'وقع مشكل فالسيرفر، جرب مرة أخرى' });
  }
});

// ================= نسيت كلمة السر =================
const RESET_TTL_MIN = 60;              // صلاحية الرابط: ساعة
const RESET_MAX_PER_HOUR = 3;          // 3 طلبات فالساعة لكل حساب
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://usequerymix.com').replace(/\/+$/, '');
const MAIL_FROM = process.env.MAIL_FROM || 'QueryMix <onboarding@resend.dev>';

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

const MAIL = {
  ar: { subject: 'إعادة تعيين كلمة السر ديال QueryMix',
        body: (url) => `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;line-height:1.8"><p>توصلنا بطلب باش تبدل كلمة السر ديالك فـ QueryMix.</p><p><a href="${url}" style="display:inline-block;background:#4A2490;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:bold">بدل كلمة السر</a></p><p>الرابط صالح لمدة ساعة وحدة. إلا ما طلبتيش هادشي، تجاهل هاد الرسالة وكلمة السر ديالك ما غاديش تتبدل.</p></div>` },
  fr: { subject: 'Réinitialisation de votre mot de passe QueryMix',
        body: (url) => `<div style="font-family:Arial,sans-serif;line-height:1.7"><p>Nous avons reçu une demande de réinitialisation de votre mot de passe QueryMix.</p><p><a href="${url}" style="display:inline-block;background:#4A2490;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:bold">Changer le mot de passe</a></p><p>Ce lien est valable 1 heure. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe ne sera pas modifié.</p></div>` },
  en: { subject: 'Reset your QueryMix password',
        body: (url) => `<div style="font-family:Arial,sans-serif;line-height:1.7"><p>We received a request to reset your QueryMix password.</p><p><a href="${url}" style="display:inline-block;background:#4A2490;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:bold">Reset password</a></p><p>This link is valid for 1 hour. If you didn't request this, ignore this email and your password will not change.</p></div>` }
};

async function sendResetEmail(to, url, lang) {
  if (!process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY ماشي معرّف: ما تصيفطش الإيميل');
    return;
  }
  const m = MAIL[lang] || MAIL.ar;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject: m.subject, html: m.body(url) }),
      signal: ctrl.signal
    });
    if (!r.ok) console.error('Resend رفض الإرسال:', r.status, (await r.text()).slice(0, 200));
  } catch (err) {
    console.error('خطأ فإرسال الإيميل:', err.message);
  } finally {
    clearTimeout(timer);
  }
}

// نفس الجواب دايما (باش ما نكشفوش واش الإيميل مسجل)
router.post('/forgot', async (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  const lang = ['ar', 'fr', 'en'].includes(req.body && req.body.lang) ? req.body.lang : 'ar';
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'الإيميل ماشي صحيح' });
  }
  try {
    const u = await db.query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
    const user = u.rows[0];
    if (user) {
      const recent = await db.query(
        "SELECT COUNT(*)::int AS n FROM password_resets WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'",
        [String(user.id)]
      );
      if (recent.rows[0].n < RESET_MAX_PER_HOUR) {
        const raw = crypto.randomBytes(32).toString('hex');
        await db.query(
          `INSERT INTO password_resets (user_id, token_hash, expires_at)
           VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)`,
          [String(user.id), sha256(raw), String(RESET_TTL_MIN)]
        );
        // بلا await: باش وقت الجواب يبقى نفسو سواء كان الإيميل مسجل ولا لا
        sendResetEmail(email, `${FRONTEND_URL}/#reset=${raw}`, lang);
      }
    }
  } catch (err) {
    console.error('خطأ فـ forgot:', err.message);
  }
  res.json({ ok: true });
});

router.post('/reset', async (req, res) => {
  const tokenRaw = String((req.body && req.body.token) || '');
  const password = req.body && req.body.password;
  if (!/^[a-f0-9]{64}$/.test(tokenRaw)) {
    return res.status(400).json({ error: 'الرابط ماشي صالح ولا سالا' });
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `كلمة السر خاصها تكون ${MIN_PASSWORD} حروف/أرقام على الأقل` });
  }
  if (Buffer.byteLength(password) > MAX_PASSWORD) {
    return res.status(400).json({ error: 'كلمة السر طويلة بزاف' });
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // كنستهلكو التوكن بشكل ذري: مرة وحدة فقط
    const used = await client.query(
      `UPDATE password_resets SET used_at = NOW()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
       RETURNING user_id`,
      [sha256(tokenRaw)]
    );
    if (used.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'الرابط ماشي صالح ولا سالا' });
    }
    const userId = used.rows[0].user_id;
    const hash = await bcrypt.hash(password, 10);
    await client.query('UPDATE users SET password_hash = $1 WHERE id::text = $2', [hash, userId]);
    await client.query('DELETE FROM password_resets WHERE user_id = $1', [userId]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    console.error('خطأ فـ reset:', err.message);
    res.status(500).json({ error: 'وقع مشكل فالسيرفر، جرب مرة أخرى' });
  } finally {
    client.release();
  }
});

module.exports = router;
