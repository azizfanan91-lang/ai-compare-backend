const express = require('express');
const db = require('./database');
const { requireAuth } = require('./authMiddleware');

const router = express.Router();
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '7', 10);

function getTrialStatus(createdAt) {
  const createdDate = new Date(createdAt);
  const now = new Date();
  const diffDays = (now - createdDate) / (1000 * 60 * 60 * 24);
  const daysLeft = Math.max(0, TRIAL_DAYS - diffDays);
  return { inTrial: diffDays < TRIAL_DAYS, daysLeft: Math.ceil(daysLeft) };
}

router.get('/usage', requireAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT is_premium, created_at FROM users WHERE id = $1', [req.userId]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'الحساب ماعادش موجود، عاود سجل الدخول' });
    const isPremium = !!user.is_premium;
    const trial = getTrialStatus(user.created_at);
    res.json({
      is_premium: isPremium,
      in_trial: !isPremium && trial.inTrial,
      trial_days_left: !isPremium ? trial.daysLeft : null,
      trial_total_days: TRIAL_DAYS,
      unlimited: isPremium || trial.inTrial
    });
  } catch (err) {
    res.status(500).json({ error: 'وقع مشكل فالسيرفر' });
  }
});

router.post('/chat', requireAuth, async (req, res) => {
  const { model, prompt } = req.body;
  if (!model || !prompt) return res.status(400).json({ error: 'خاص model و prompt' });

  try {
    const result = await db.query('SELECT is_premium, created_at FROM users WHERE id = $1', [req.userId]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'الحساب ماعادش موجود، عاود سجل الدخول' });
    const isPremium = !!user.is_premium;
    const trial = getTrialStatus(user.created_at);
    const hasAccess = isPremium || trial.inTrial;

    if (!hasAccess) {
      return res.status(429).json({
        error: 'خلصات التجربة المجانية ديالك (' + TRIAL_DAYS + ' أيام). اشترك باش تكمل تستعمل الموقع بلا حدود.',
        trial_ended: true
      });
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1500
      })
    });
    const data = await response.json();
    if (data.error) return res.status(502).json({ error: data.error.message });

    const today = new Date().toISOString().split('T')[0];
    await db.query(`
      INSERT INTO usage_log (user_id, date, count) VALUES ($1, $2, 1)
      ON CONFLICT (user_id, date) DO UPDATE SET count = usage_log.count + 1
    `, [req.userId, today]);

    res.json({ text: data.choices?.[0]?.message?.content || 'ما جاش جواب' });
  } catch (err) {
    res.status(500).json({ error: 'خطأ فـ الاتصال بـ OpenRouter: ' + err.message });
  }
});

// ---------- توليد الصور (Pollinations، بلا مفتاح API) ----------
const IMAGE_FALLBACK_MODELS = [
  { id: 'flux', label: 'Flux' },
  { id: 'turbo', label: 'Turbo' }
];

// كاش بسيط لقائمة النماذج باش ما نسولوش Pollinations فكل زيارة للصفحة
let imageModelsCache = { data: null, at: 0 };
const IMAGE_MODELS_TTL = 60 * 60 * 1000; // ساعة

router.get('/image/models', async (req, res) => {
  try {
    if (imageModelsCache.data && Date.now() - imageModelsCache.at < IMAGE_MODELS_TTL) {
      return res.json({ models: imageModelsCache.data });
    }

    const response = await fetch('https://image.pollinations.ai/models');
    const raw = await response.json();

    // الاستجابة عادة جدول من الأسماء (strings)، تنحولوها لكائنات {id, label}
    const list = Array.isArray(raw) ? raw : (raw.models || []);
    let models = list
      .map(m => {
        const id = typeof m === 'string' ? m : m.id || m.name;
        if (!id) return null;
        const label = id.charAt(0).toUpperCase() + id.slice(1).replace(/[-_]/g, ' ');
        return { id, label };
      })
      .filter(Boolean);

    if (!models.length) throw new Error('empty models list');

    imageModelsCache = { data: models, at: Date.now() };
    res.json({ models });
  } catch (err) {
    // إلا تعطل Pollinations، نرجعو قائمة احتياطية باش الأداة تبقى خدامة
    res.json({ models: IMAGE_FALLBACK_MODELS });
  }
});

router.post('/image', requireAuth, async (req, res) => {
  const { model, prompt, width, height } = req.body;
  if (!model || !prompt) return res.status(400).json({ error: 'خاص model و prompt' });

  const w = Math.min(Math.max(parseInt(width, 10) || 1024, 256), 1536);
  const h = Math.min(Math.max(parseInt(height, 10) || 1024, 256), 1536);

  try {
    const result = await db.query('SELECT is_premium, created_at FROM users WHERE id = $1', [req.userId]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'الحساب ماعادش موجود، عاود سجل الدخول' });
    const isPremium = !!user.is_premium;
    const trial = getTrialStatus(user.created_at);
    const hasAccess = isPremium || trial.inTrial;

    if (!hasAccess) {
      return res.status(429).json({
        error: 'خلصات التجربة المجانية ديالك (' + TRIAL_DAYS + ' أيام). اشترك باش تكمل تستعمل الموقع بلا حدود.',
        trial_ended: true
      });
    }

    const seed = Math.floor(Math.random() * 1e9);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
      `?model=${encodeURIComponent(model)}&width=${w}&height=${h}&seed=${seed}&nologo=true`;

    const imgResponse = await fetch(url);
    const contentType = imgResponse.headers.get('content-type') || '';

    if (!imgResponse.ok || !contentType.startsWith('image/')) {
      return res.status(502).json({ error: 'تعذّر توليد الصورة. جرّب وصفاً آخر أو نموذجاً آخر.' });
    }

    const buffer = Buffer.from(await imgResponse.arrayBuffer());

    const today = new Date().toISOString().split('T')[0];
    await db.query(`
      INSERT INTO usage_log (user_id, date, count) VALUES ($1, $2, 1)
      ON CONFLICT (user_id, date) DO UPDATE SET count = usage_log.count + 1
    `, [req.userId, today]);

    res.set('Content-Type', contentType);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'خطأ فـ الاتصال بخدمة توليد الصور: ' + err.message });
  }
});

module.exports = router;
