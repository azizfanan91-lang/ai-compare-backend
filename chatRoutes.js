// هاد الـ route هو القلب ديال التطبيق:
// نظام جديد: 7 أيام تجربة مجانية بلا حدود من يوم التسجيل، بعدها خاصو الاشتراك

const express = require('express');
const db = require('./database');
const { requireAuth } = require('./authMiddleware');

const router = express.Router();

const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '7', 10);
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_TOKENS = 500;
const REQUEST_TIMEOUT_MS = 30 * 1000; // 30 ثانية

// قائمة النماذج المسموح بها (باش ما يبعثش المستخدم أي model عشوائي)
const ALLOWED_MODELS = new Set([
  'openai/gpt-4o-mini',
  'openai/gpt-3.5-turbo',
  'anthropic/claude-3-haiku',
  'google/gemini-flash-1.5',
  'meta-llama/llama-3.1-8b-instruct'
]);

// حماية بسيطة من الإساءة: rate limit فالذاكرة
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // دقيقة
const RATE_LIMIT_MAX = 20; // 20 طلب فالدقيقة

function checkRateLimit(userId) {
  const now = Date.now();
  const entry = rateLimitMap.get(userId) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  entry.count++;
  rateLimitMap.set(userId, entry);

  return {
    allowed: entry.count <= RATE_LIMIT_MAX,
    remaining: Math.max(0, RATE_LIMIT_MAX - entry.count),
    resetAt: entry.resetAt
  };
}

// تنظيف دوري للـ map باش ما تكبرش فالذاكرة
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap.entries()) {
    if (now > val.resetAt) rateLimitMap.delete(key);
  }
}, 5 * 60 * 1000).unref();

function getTrialInfo(user) {
  // SQLite datetime بدون timezone → كنزيدو 'Z' باش نتعاملو معاه كـ UTC
  const createdAt = new Date(user.created_at.replace(' ', 'T') + 'Z');
  const trialEnd = new Date(createdAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
  const now = new Date();
  const msLeft = trialEnd - now;
  const daysLeft = Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
  const trialActive = msLeft > 0;
  return { trialActive, daysLeft, trialEnd };
}

// GET /api/usage - كيرجع حالة التجربة/الاشتراك
router.get('/usage', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) {
    return res.status(404).json({ error: 'المستخدم ما كاينش' });
  }

  const isPremium = !!user.is_premium;
  const trial = getTrialInfo(user);

  res.json({
    is_premium: isPremium,
    trial_active: trial.trialActive,
    trial_days_left: trial.daysLeft,
    trial_ends_at: trial.trialEnd.toISOString(),
    can_use: isPremium || trial.trialActive
  });
});

// POST /api/chat - كيبعت السؤال لنموذج واحد
router.post('/chat', requireAuth, async (req, res) => {
  const { model, prompt } = req.body || {};

  // 1) تحقق من المدخلات
  if (!model || typeof model !== 'string') {
    return res.status(400).json({ error: 'خاص model يكون نص' });
  }
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'خاص prompt يكون نص' });
  }
  if (prompt.trim().length === 0) {
    return res.status(400).json({ error: 'prompt ما يمكنش يكون خاوي' });
  }
  if (prompt.length > 8000) {
    return res.status(400).json({ error: 'prompt طويل بزاف (الحد 8000 حرف)' });
  }
  if (!ALLOWED_MODELS.has(model)) {
    return res.status(400).json({ error: 'هاد الموديل ماشي مسموح' });
  }

  // 2) rate limiting
  const rl = checkRateLimit(req.userId);
  res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX);
  res.setHeader('X-RateLimit-Remaining', rl.remaining);
  if (!rl.allowed) {
    return res.status(429).json({
      error: 'طلباتك بزاف. تسنى شوية وعاود.',
      retry_after_ms: rl.resetAt - Date.now()
    });
  }

  // 3) تحقق من المستخدم والاشتراك
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) {
    return res.status(404).json({ error: 'المستخدم ما كاينش' });
  }

  const isPremium = !!user.is_premium;
  const trial = getTrialInfo(user);

  if (!isPremium && !trial.trialActive) {
    return res.status(403).json({
      error: 'خلصت التجربة المجانية ديال 7 أيام. اشترك باش تكمل بلا حدود.',
      limit_reached: true
    });
  }

  // 4) تحقق من مفتاح API
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('[chat] OPENROUTER_API_KEY ماشي موجود فـ .env');
    return res.status(500).json({ error: 'خطأ فالإعدادات ديال السيرفر' });
  }

  // 5) النداء لـ OpenRouter مع timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY,
        'HTTP-Referer': process.env.APP_URL || 'http://localhost',
        'X-Title': process.env.APP_NAME || 'MyApp'
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: MAX_TOKENS
      })
    });

    clearTimeout(timeoutId);

    // إلا كان رد HTTP ماشي 2xx
    if (!response.ok) {
      let errBody = null;
      try { errBody = await response.json(); } catch (_) {}
      const msg = errBody?.error?.message || `HTTP ${response.status}`;
      console.error('[chat] OpenRouter error:', response.status, msg);
      return res.status(502).json({ error: 'خطأ من OpenRouter: ' + msg });
    }

    const data = await response.json();

    if (data.error) {
      console.error('[chat] OpenRouter data.error:', data.error.message);
      return res.status(502).json({ error: data.error.message });
    }

    const text = data.choices?.[0]?.message?.content?.trim() || 'ما جاش جواب';
    res.json({ text, model, usage: data.usage || null });

  } catch (err) {
    clearTimeout(timeoutId);

    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'OpenRouter تأخر بزاف فالجواب' });
    }

    console.error('[chat] fetch error:', err);
    res.status(500).json({ error: 'خطأ فالاتصال بـ OpenRouter' });
  }
});

module.exports = router;
