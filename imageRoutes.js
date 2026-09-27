const express = require('express');
const db = require('./database');
const { requireAuth } = require('./authMiddleware');

const router = express.Router();

const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '7', 10);
// حصة Cloudflare المجانية كتتقاسمها كل المستخدمين، فخلي الرقم صغير
const IMAGE_DAILY_LIMIT = parseInt(process.env.IMAGE_DAILY_LIMIT || '10', 10);
const POLLINATIONS_REFERRER = process.env.POLLINATIONS_REFERRER || 'usequerymix.com';

// كيتخلق الجدول وحدو إلا ماكانش (بلا FK باش ما يتعطلش فقاعدة جديدة)
db.query(`
  CREATE TABLE IF NOT EXISTS image_usage_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    UNIQUE(user_id, date)
  )
`).catch(err => console.error('خطأ فتخليق image_usage_log:', err.message));

function getTrialStatus(createdAt) {
  const diffDays = (new Date() - new Date(createdAt)) / (1000 * 60 * 60 * 24);
  return { inTrial: diffDays < TRIAL_DAYS };
}

// ---------- المزودون ----------
async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Cloudflare Workers AI — FLUX.1 schnell (يحتاج CF_ACCOUNT_ID و CF_API_TOKEN)
async function generateWithCloudflare(prompt) {
  const { CF_ACCOUNT_ID, CF_API_TOKEN } = process.env;
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) throw new Error('Cloudflare غير مهيأ');

  const r = await fetchWithTimeout(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt, steps: 4 })
    },
    45000
  );
  const data = await r.json().catch(() => null);
  const b64 = data && data.result && data.result.image;
  if (!r.ok || !b64) {
    throw new Error(`Cloudflare ${r.status}: ${JSON.stringify((data && data.errors) || data).slice(0, 200)}`);
  }
  const mime = b64.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${b64}`;
}

// Pollinations — بلا مفتاح، لكن بلا ضمان ديال الاستقرار
async function generateWithPollinations(prompt, model) {
  const seed = Math.floor(Math.random() * 1e9);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?model=${encodeURIComponent(model)}&width=1024&height=1024&seed=${seed}&nologo=true` +
    `&referrer=${encodeURIComponent(POLLINATIONS_REFERRER)}`;

  const r = await fetchWithTimeout(url, {
    headers: { 'Referer': `https://${POLLINATIONS_REFERRER}/`, 'Accept': 'image/*' }
  }, 60000);
  const ct = r.headers.get('content-type') || '';
  if (!r.ok || !ct.startsWith('image/')) throw new Error(`Pollinations(${model}) ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return `data:${ct};base64,${buf.toString('base64')}`;
}

const PROVIDERS = {
  cloudflare: (p) => generateWithCloudflare(p),
  'pollinations-flux': (p) => generateWithPollinations(p, 'flux'),
  'pollinations-turbo': (p) => generateWithPollinations(p, 'turbo'),
  'pollinations-qwen': (p) => generateWithPollinations(p, 'qwen-image')
};

// كل نموذج عندو سلسلة: إلا فشل الأول كنجربو التاني تلقائياً
const MODELS = {
  flux: {
    name: 'FLUX.1 Schnell',
    description: 'الأكثر استقراراً وجودة',
    chain: ['cloudflare', 'pollinations-flux']
  },
  turbo: {
    name: 'Turbo',
    description: 'سريع وخفيف',
    chain: ['pollinations-turbo', 'pollinations-flux']
  },
  qwen: {
    name: 'Qwen Image',
    description: 'مناسب للنصوص داخل الصور',
    chain: ['pollinations-qwen', 'pollinations-flux']
  }
};

const BLOCKED_KEYWORDS = [
  'child', 'kid', 'minor', 'طفل', 'أطفال', 'صغير السن',
  'naked', 'nude', 'nsfw', 'porn', 'sex', 'عاري', 'عارية'
];

function containsBlockedContent(text) {
  const lower = text.toLowerCase();
  return BLOCKED_KEYWORDS.some(k => lower.includes(k));
}

// ---------- المسارات (نفس العقد القديم: /models و /usage و /generate) ----------
router.get('/models', (req, res) => {
  const list = Object.entries(MODELS).map(([key, val]) => ({
    key,
    name: val.name,
    description: val.description
  }));
  res.json({ models: list });
});

router.get('/usage', requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await db.query(
      'SELECT count FROM image_usage_log WHERE user_id = $1 AND date = $2',
      [req.userId, today]
    );
    const used = (result.rows[0] && result.rows[0].count) || 0;
    res.json({ used, limit: IMAGE_DAILY_LIMIT, remaining: Math.max(0, IMAGE_DAILY_LIMIT - used) });
  } catch (err) {
    console.error('خطأ فـ image usage:', err);
    res.status(500).json({ error: 'وقع مشكل فالسيرفر' });
  }
});

router.post('/generate', requireAuth, async (req, res) => {
  const { prompt, model: modelKey = 'flux' } = req.body;

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'خاصك تكتب وصف للصورة' });
  }
  if (prompt.length > 500) {
    return res.status(400).json({ error: 'الوصف طويل بزاف (حد أقصى 500 حرف)' });
  }
  if (containsBlockedContent(prompt)) {
    return res.status(400).json({ error: 'الوصف مخالف لسياسة الاستخدام، جرب وصف آخر' });
  }

  const selected = MODELS[modelKey] || MODELS.flux;

  try {
    const userResult = await db.query('SELECT is_premium, created_at FROM users WHERE id = $1', [req.userId]);
    const user = userResult.rows[0];
    if (!user) return res.status(401).json({ error: 'الحساب ماعادش موجود، عاود سجل الدخول' });

    // نفس شرط التجربة/الاشتراك ديال الدردشة
    if (!user.is_premium && !getTrialStatus(user.created_at).inTrial) {
      return res.status(429).json({
        error: 'خلصات التجربة المجانية ديالك (' + TRIAL_DAYS + ' أيام). اشترك باش تكمل تستعمل الموقع بلا حدود.',
        trial_ended: true
      });
    }

    const today = new Date().toISOString().split('T')[0];
    const usageResult = await db.query(
      'SELECT count FROM image_usage_log WHERE user_id = $1 AND date = $2',
      [req.userId, today]
    );
    const used = (usageResult.rows[0] && usageResult.rows[0].count) || 0;

    if (used >= IMAGE_DAILY_LIMIT) {
      return res.status(429).json({
        error: `وصلتي للحد اليومي ديال توليد الصور (${IMAGE_DAILY_LIMIT} فالنهار). عاود جرب غدا.`,
        limit_reached: true
      });
    }

    // نجربو المزودين بالترتيب حتى واحد ينجح
    let dataUri = null;
    let usedProvider = null;
    for (const providerName of selected.chain) {
      try {
        dataUri = await PROVIDERS[providerName](prompt);
        usedProvider = providerName;
        break;
      } catch (err) {
        console.error(`مزود الصور ${providerName} فشل:`, err.message);
      }
    }

    if (!dataUri) {
      return res.status(502).json({ error: 'خدمات توليد الصور مشغولة دابا، عاود جرب من بعد شوية' });
    }

    // كنحسبو غير الصور اللي نجحات
    await db.query(`
      INSERT INTO image_usage_log (user_id, date, count) VALUES ($1, $2, 1)
      ON CONFLICT (user_id, date) DO UPDATE SET count = image_usage_log.count + 1
    `, [req.userId, today]);

    res.json({
      image: dataUri,
      model: selected.name,
      provider: usedProvider,
      remaining: Math.max(0, IMAGE_DAILY_LIMIT - (used + 1))
    });
  } catch (err) {
    console.error('خطأ فتوليد الصورة:', err);
    res.status(500).json({ error: 'وقع مشكل فالسيرفر، عاود جرب' });
  }
});

module.exports = router;
