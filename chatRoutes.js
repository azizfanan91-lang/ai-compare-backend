const express = require('express');
const crypto = require('crypto');
const db = require('./database');
const { requireAuth } = require('./authMiddleware');
const {
  TRIAL_DAYS,
  FREE_CHAT_DAILY_LIMIT,
  PREMIUM_CHAT_HARD_LIMIT
} = require('./usageLimits');

const router = express.Router();

const MAX_PROMPT_CHARS = 20000;       // الفرونت كيرسل حتى ~14000 + التعليمات
const CHAT_TOTAL_BUDGET_MS = 55000;   // الفرونت كيوقف الطلب عند 60 ثانية
const CHAT_ATTEMPT_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------------------
// المزودون: OpenRouter (الأول) ← Groq ← Cloudflare Workers AI
// المزودين البدلاء كيخدمو غير إلا كانو معرفين فـ Environment (ما كاين حتى تغيير إلا ما زدتيهمش)
// ---------------------------------------------------------------------------
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const CF_TEXT_MODEL = process.env.CF_TEXT_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

function nextUtcMidnight() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

async function postJson(url, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

const PROVIDERS = [
  {
    name: 'openrouter',
    label: (model) => model,
    blockedUntil: 0,
    enabled: () => !!process.env.OPENROUTER_API_KEY,
    usesRequestedModel: true,
    async run(model, prompt, maxTokens, timeoutMs) {
      const { response, data } = await postJson(
        'https://openrouter.ai/api/v1/chat/completions',
        { Authorization: 'Bearer ' + process.env.OPENROUTER_API_KEY },
        { model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens },
        timeoutMs
      );
      const text = data?.choices?.[0]?.message?.content || null;
      const msg = data?.error?.message ? String(data.error.message).slice(0, 200) : '';
      return { response, text, msg, dailyBlockUntil: nextUtcMidnight() };
    }
  },
  {
    name: 'groq',
    label: () => GROQ_MODEL,
    blockedUntil: 0,
    enabled: () => !!process.env.GROQ_API_KEY,
    async run(_model, prompt, maxTokens, timeoutMs) {
      const { response, data } = await postJson(
        'https://api.groq.com/openai/v1/chat/completions',
        { Authorization: 'Bearer ' + process.env.GROQ_API_KEY },
        { model: GROQ_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens },
        timeoutMs
      );
      const text = data?.choices?.[0]?.message?.content || null;
      const msg = data?.error?.message ? String(data.error.message).slice(0, 200) : '';
      return { response, text, msg, dailyBlockUntil: Date.now() + 60 * 60 * 1000 };
    }
  },
  {
    name: 'cloudflare',
    label: () => CF_TEXT_MODEL,
    blockedUntil: 0,
    enabled: () => !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN),
    async run(_model, prompt, maxTokens, timeoutMs) {
      const { response, data } = await postJson(
        `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${CF_TEXT_MODEL}`,
        { Authorization: 'Bearer ' + process.env.CLOUDFLARE_API_TOKEN },
        { messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens },
        timeoutMs
      );
      // Cloudflare كيغلف الجواب فـ result، وكنقبلو الشكلين
      const text = (data?.result?.response ?? data?.response) || null;
      const msg = Array.isArray(data?.errors) && data.errors[0]?.message
        ? String(data.errors[0].message).slice(0, 200) : '';
      return { response, text, msg, dailyBlockUntil: Date.now() + 60 * 60 * 1000 };
    }
  }
];

function modelDisplayName(id) {
  return String(id).replace(/^@cf\/[^/]+\//, '').replace(/:free$/, '');
}

// الفرونت كيبعت كل النماذج فـ نفس الوقت: كنشاركو نفس الطلب البديل (حتى وهو جاري) باش ما نصرفوش حصة المزود البديل بلا فايدة
const fallbackCache = new Map();
const FALLBACK_CACHE_TTL_MS = 2 * 60 * 1000;
function cacheKey(provider, prompt) {
  return provider + ':' + crypto.createHash('sha256').update(prompt).digest('hex');
}

async function tryProvider(p, model, prompt, maxTokens, timeoutMs) {
  try {
    const r = await p.run(model, prompt, maxTokens, timeoutMs);
    if (r.response.ok && r.text) return { ok: true, text: r.text };
    const limited = r.response.status === 429 || /rate limit/i.test(r.msg);
    if (limited) {
      const daily = /per[- ]day|per day|TPD|RPD|neurons/i.test(r.msg);
      p.blockedUntil = daily ? r.dailyBlockUntil : Date.now() + 60000;
      console.warn(`[${p.name}] rate limit (${daily ? 'daily' : 'minute'}) until`, new Date(p.blockedUntil).toISOString());
      return { ok: false, limited: true };
    }
    console.warn(`[${p.name}] failed:`, r.response.status, r.msg);
    return { ok: false, limited: false };
  } catch (err) {
    console.warn(`[${p.name}] error:`, err.name === 'AbortError' ? 'timeout' : err.message);
    return { ok: false, limited: false };
  }
}

/**
 * كيجرب المزودين بالترتيب. كيرجع:
 *  { ok:true, text, provider, modelUsed, fallback }
 *  { ok:false, rateLimited }   (rateLimited = المزودين محظورين مؤقتا، ماشي عطب آخر)
 */
async function askWithFailover(model, prompt, maxTokens) {
  const startedAt = Date.now();
  let sawRateLimit = false;
  let sawOtherError = false;

  for (const p of PROVIDERS) {
    if (!p.enabled()) continue;
    if (Date.now() < p.blockedUntil) { sawRateLimit = true; continue; }

    const remaining = CHAT_TOTAL_BUDGET_MS - (Date.now() - startedAt);
    if (remaining < 4000) break;
    const timeoutMs = Math.min(CHAT_ATTEMPT_TIMEOUT_MS, remaining);
    const isFallback = !p.usesRequestedModel;

    let attempt;
    if (isFallback) {
      const key = cacheKey(p.name, prompt);
      let entry = fallbackCache.get(key);
      if (!entry || Date.now() - entry.at > FALLBACK_CACHE_TTL_MS) {
        if (fallbackCache.size > 200) fallbackCache.clear();
        entry = { at: Date.now(), promise: tryProvider(p, model, prompt, maxTokens, timeoutMs) };
        fallbackCache.set(key, entry);
        const mine = entry;
        mine.promise.then((r) => { if (!r.ok && fallbackCache.get(key) === mine) fallbackCache.delete(key); });
      }
      attempt = await entry.promise;
    } else {
      attempt = await tryProvider(p, model, prompt, maxTokens, timeoutMs);
    }

    if (attempt.ok) {
      return { ok: true, text: attempt.text, provider: p.name, modelUsed: p.label(model), fallback: isFallback };
    }
    if (attempt.limited) sawRateLimit = true; else sawOtherError = true;
  }
  return { ok: false, rateLimited: sawRateLimit && !sawOtherError };
}

// ملاحظة شفافة: هاد الأداة كتقارن النماذج، فخاص المستخدم يعرف إلا الجواب ماشي من النموذج اللي اختار
function withFallbackNote(result, requestedModel) {
  if (!result.fallback) return result.text;
  // \u2066 ... \u2069 = عزل الاتجاه (LTR) باش أسماء النماذج ما تتبعثرش داخل الجملة العربية
  const ltr = (name) => '\u2066' + modelDisplayName(name) + '\u2069';
  return result.text +
    `\n\n— ملاحظة: النموذج المطلوب ${ltr(requestedModel)} كان مشغولا، وهاد الجواب جاء من نموذج بديل ${ltr(result.modelUsed)}.`;
}

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
  // req.ip (trust proxy مفعّل فـ server.js)، ماشي header يقدر المستخدم يزوّرو
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
    const results = await Promise.all(candidates.map(async (model) => {
      const r = await askWithFailover(model, prompt, 900);
      return {
        model,
        ok: r.ok,
        text: r.ok ? withFallbackNote(r, model)
          : (r.rateLimited ? 'النماذج المجانية وصلات للحد اليومي مؤقتا، عاود جرب من بعد.'
                           : 'هاد النموذج مشغول حاليا، جرب المقارنة من بعد التسجيل.')
      };
    }));

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

    // حجز ذري للحصة قبل الاتصال بأي مزود
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

    const r = await askWithFailover(model, prompt, 1500);

    if (!r.ok) {
      // الفشل ما كيتحسبش على المستخدم
      await releaseReservation(req.userId, today);
      reserved = false;
      if (r.rateLimited) {
        return res.status(503).json({
          error: 'النماذج المجانية وصلات للحد اليومي ديالها مؤقتا. عاود جرب من بعد (كيتجدد كل يوم).',
          provider_limit: true
        });
      }
      return res.status(502).json({ error: 'النموذج مشغول حاليا، جرب مرة أخرى بعد شوية' });
    }

    res.json({
      text: withFallbackNote(r, model),
      model_used: r.modelUsed,
      provider: r.provider,
      fallback: r.fallback
    });
  } catch (err) {
    if (reserved) await releaseReservation(req.userId, today);
    console.error('chat error:', err.message);
    res.status(500).json({ error: 'وقع مشكل فالسيرفر، عاود جرب' });
  }
});

module.exports = router;
