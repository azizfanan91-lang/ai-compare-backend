const express = require('express');
const db = require('./database');
const { requireAuth } = require('./authMiddleware');
const {
  TRIAL_DAYS,
  FREE_CHAT_DAILY_LIMIT,
  PREMIUM_CHAT_HARD_LIMIT
} = require('./usageLimits');

const router = express.Router();

const FREE_CHAT_FALLBACKS = [
  'openrouter/free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3.5-lightning:free'
];

const MAX_PROMPT_CHARS = 20000;       // الفرونت كيرسل حتى ~14000 + التعليمات
const CHAT_TOTAL_BUDGET_MS = 55000;   // الفرونت كيوقف الطلب عند 60 ثانية
const CHAT_ATTEMPT_TIMEOUT_MS = 25000;

// مسموح غير النماذج المجانية (وإلا أي مستخدم يقدر يطلب نموذج مدفوع على حسابك)
const FREE_MODEL_RE = /^[A-Za-z0-9._\-\/]{1,100}:free$/;
function isAllowedModel(model) {
  return typeof model === 'string' && (model === 'openrouter/free' || FREE_MODEL_RE.test(model));
}

function getTrialStatus(createdAt) {
  const createdDate = new Date(createdAt);
  const now = new Date();
  const diffDays = (now - createdDate) / (1000 * 60 * 60 * 24);
  const daysLeft = Math.max(0, TRIAL_DAYS - diffDays);
  return { inTrial: diffDays < TRIAL_DAYS, daysLeft: Math.ceil(daysLeft) };
}

async function callOpenRouter(model, prompt, maxTokens, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    const text = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : null;
    if (!response.ok || data.error || !text) {
      const msg = data && data.error && data.error.message ? String(data.error.message).slice(0, 200) : '';
      return { ok: false, error: msg || ('HTTP ' + response.status) };
    }
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

router.get('/usage', requireAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT is_premium, created_at FROM users WHERE id = $1', [req.userId]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'الحساب ماعادش موجود، عاود سجل الدخول' });
    const isPremium = !!user.is_premium;
    const trial = getTrialStatus(user.created_at);
    const today = new Date().toISOString().split('T')[0];
    const usageResult = await db.query(
      'SELECT count FROM usage_log WHERE user_id = $1 AND date = $2',
      [req.userId, today]
    );
    const chatUsed = usageResult.rows[0]?.count || 0;
    res.json({
      is_premium: isPremium,
      in_trial: !isPremium && trial.inTrial,
      trial_days_left: !isPremium ? trial.daysLeft : null,
      trial_total_days: TRIAL_DAYS,
      unlimited: isPremium,
      chat_used: chatUsed,
      chat_limit: isPremium ? null : FREE_CHAT_DAILY_LIMIT,
      chat_remaining: isPremium ? null : Math.max(0, FREE_CHAT_DAILY_LIMIT - chatUsed)
    });
  } catch (err) {
    console.error('usage error:', err.message);
    res.status(500).json({ error: 'وقع مشكل فالسيرفر' });
  }
});

// ---------- Free Playground Preview (بلا تسجيل: مرة فـ النهار لكل IP) ----------
const previewUsage = new Map();
const PREVIEW_MODELS = [
  'openrouter/free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3.5-lightning:free'
];
const PREVIEW_MAX_PROMPT = 1200;

function previewKey(req) {
  // كنعتمدو على req.ip (trust proxy مفعّل فـ server.js)، ماشي على header يقدر المستخدم يزوّرو
  return String(req.ip || 'unknown');
}

router.post('/preview', async (req, res) => {
  const prompt = String(req.body?.prompt || '').trim();
  const requestedModels = Array.isArray(req.body?.models) ? req.body.models : [];
  if (!prompt) return res.status(400).json({ error: 'كتب السؤال ديالك أولا' });
  if (prompt.length > PREVIEW_MAX_PROMPT) {
    return res.status(400).json({ error: `السؤال طويل بزاف (الحد ${PREVIEW_MAX_PROMPT} حرف)` });
  }

  const key = previewKey(req);
  const today = new Date().toISOString().slice(0, 10);
  if (previewUsage.get(key) === today) {
    return res.status(429).json({
      error: 'استعملتي التجربة المجانية. سجل حساب باش تكمل المقارنة.',
      preview_used: true
    });
  }

  const models = [...new Set(requestedModels.filter(m => PREVIEW_MODELS.includes(m)))].slice(0, 3);
  const candidates = models.length ? models : PREVIEW_MODELS.slice(0, 2);

  try {
    // بالتوازي: الوقت = أبطأ نموذج، ماشي مجموع النماذج
    const results = await Promise.all(candidates.map(async (model) => {
      const r = await callOpenRouter(model, prompt, 900, 30000);
      return {
        model,
        text: r.ok ? r.text : 'هاد النموذج مشغول حاليا، جرب المقارنة من بعد التسجيل.',
        ok: r.ok
      };
    }));

    // ما كنحسبوش التجربة إلا نجح على الأقل نموذج واحد
    if (results.some(r => r.ok)) {
      if (previewUsage.size > 5000) {
        for (const [k, d] of previewUsage) if (d !== today) previewUsage.delete(k);
      }
      previewUsage.set(key, today);
    }
    res.json({ preview: true, results: results.map(({ model, text }) => ({ model, text })) });
  } catch (err) {
    console.error('خطأ فـ Free Playground:', err.message);
    res.status(502).json({ error: 'تعذر تشغيل التجربة المجانية حاليا، عاود جرب من بعد.' });
  }
});

async function releaseReservation(userId, date) {
  try {
    await db.query(
      'UPDATE usage_log SET count = GREATEST(count - 1, 0) WHERE user_id = $1 AND date = $2',
      [userId, date]
    );
  } catch (e) {
    console.error('release error:', e.message);
  }
}

router.post('/chat', requireAuth, async (req, res) => {
  const { model, prompt } = req.body || {};
  if (!model || !prompt) return res.status(400).json({ error: 'خاص model و prompt' });
  if (typeof prompt !== 'string') return res.status(400).json({ error: 'الطلب غير صالح' });
  if (prompt.length > MAX_PROMPT_CHARS) return res.status(400).json({ error: 'النص طويل بزاف، قصرو شوية' });
  if (!isAllowedModel(model)) return res.status(400).json({ error: 'هاد النموذج ماشي مسموح' });

  const today = new Date().toISOString().split('T')[0];
  let reserved = false;

  try {
    const result = await db.query('SELECT is_premium, created_at FROM users WHERE id = $1', [req.userId]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'الحساب ماعادش موجود، عاود سجل الدخول' });

    const isPremium = !!user.is_premium;
    const trial = getTrialStatus(user.created_at);

    if (!isPremium && !trial.inTrial) {
      return res.status(429).json({
        error: 'خلصات التجربة المجانية ديالك (' + TRIAL_DAYS + ' أيام). اشترك باش تكمل تستعمل الموقع.',
        trial_ended: true
      });
    }

    // حجز ذري للحصة قبل ما نتصلو بـ OpenRouter
    const cap = isPremium ? PREMIUM_CHAT_HARD_LIMIT : FREE_CHAT_DAILY_LIMIT;
    const reserve = await db.query(`
      INSERT INTO usage_log (user_id, date, count) VALUES ($1, $2, 1)
      ON CONFLICT (user_id, date) DO UPDATE SET count = usage_log.count + 1
      WHERE usage_log.count < $3
      RETURNING count
    `, [req.userId, today, cap]);

    if (reserve.rowCount === 0) {
      return res.status(429).json({
        error: isPremium
          ? `وصلتي للسقف اليومي (${cap} طلب). عاود جرب غدا.`
          : `وصلتي للحد المجاني اليومي (${FREE_CHAT_DAILY_LIMIT} محادثات). عاود جرب غدا أو اشترك باش تكمل.`,
        limit_reached: true,
        chat_used: cap,
        chat_limit: isPremium ? null : FREE_CHAT_DAILY_LIMIT
      });
    }
    reserved = true;

    // النموذج المطلوب أولا، ومن بعد البدائل المجانية، فـ حدود 55 ثانية
    const candidates = [model, ...FREE_CHAT_FALLBACKS].filter((v, i, arr) => v && arr.indexOf(v) === i);
    const startedAt = Date.now();
    let text = null;
    let usedModel = null;
    let lastError = 'النموذج غير متاح حاليا';

    for (const candidate of candidates) {
      const remaining = CHAT_TOTAL_BUDGET_MS - (Date.now() - startedAt);
      if (remaining < 5000) break;
      const r = await callOpenRouter(candidate, prompt, 1500, Math.min(CHAT_ATTEMPT_TIMEOUT_MS, remaining));
      if (r.ok) { text = r.text; usedModel = candidate; break; }
      lastError = r.error;
      console.warn('chat candidate failed:', candidate, r.error);
    }

    if (!text) {
      // الفشل ما كيتحسبش على المستخدم
      await releaseReservation(req.userId, today);
      reserved = false;
      return res.status(502).json({ error: 'النموذج مشغول حاليا، جرب مرة أخرى بعد شوية' });
    }

    res.json({ text, model_used: usedModel, fallback: usedModel !== model });
  } catch (err) {
    if (reserved) await releaseReservation(req.userId, today);
    console.error('chat error:', err.message);
    res.status(500).json({ error: 'وقع مشكل فالسيرفر، عاود جرب' });
  }
});

module.exports = router;
