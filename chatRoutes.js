const express = require('express');
const db = require('./database');
const { requireAuth } = require('./authMiddleware');

const router = express.Router();
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '7', 10);
const FREE_CHAT_DAILY_LIMIT = parseInt(process.env.FREE_CHAT_DAILY_LIMIT || '10', 10);
const FREE_CHAT_FALLBACKS = [
  'openrouter/free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3.5-lightning:free'
];

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
    res.status(500).json({ error: 'وقع مشكل فالسيرفر' });
  }
});

// ---------- Free Playground Preview (سؤال واحد للزائر بلا تسجيل) ----------
const previewUsage = new Map();
const PREVIEW_MODELS = [
  'openrouter/free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3.5-lightning:free'
];
const PREVIEW_MAX_PROMPT = 1200;

function previewKey(req) {
  return String(req.ip || req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
}

router.post('/preview', async (req, res) => {
  const prompt = String(req.body?.prompt || '').trim();
  const requestedModels = Array.isArray(req.body?.models) ? req.body.models : [];
  if (!prompt) return res.status(400).json({ error: 'كتب السؤال ديالك أولا' });
  if (prompt.length > PREVIEW_MAX_PROMPT) return res.status(400).json({ error: `السؤال طويل بزاف (الحد ${PREVIEW_MAX_PROMPT} حرف)` });

  const key = previewKey(req);
  const today = new Date().toISOString().slice(0, 10);
  const used = previewUsage.get(key);
  if (used === today) {
    return res.status(429).json({
      error: 'استعملتي التجربة المجانية. سجل حساب باش تكمل المقارنة.',
      preview_used: true
    });
  }

  const models = [...new Set(requestedModels.filter(model => PREVIEW_MODELS.includes(model)))].slice(0, 3);
  const candidates = models.length ? models : PREVIEW_MODELS.slice(0, 2);
  const results = [];
  try {
    for (const model of candidates) {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY
        },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 900 })
      });
      const data = await response.json().catch(() => ({}));
      results.push({
        model,
        text: response.ok && data.choices?.[0]?.message?.content
          ? data.choices[0].message.content
          : 'هاد النموذج مشغول حاليا، جرب المقارنة من بعد التسجيل.'
      });
    }
    previewUsage.set(key, today);
    res.json({ preview: true, results });
  } catch (err) {
    console.error('خطأ فـ Free Playground:', err.message);
    res.status(502).json({ error: 'تعذر تشغيل التجربة المجانية حاليا، عاود جرب من بعد.' });
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

    const chatToday = new Date().toISOString().split('T')[0];
    const chatUsageResult = await db.query(
      'SELECT count FROM usage_log WHERE user_id = $1 AND date = $2',
      [req.userId, chatToday]
    );
    const chatUsed = chatUsageResult.rows[0]?.count || 0;
    if (!isPremium && chatUsed >= FREE_CHAT_DAILY_LIMIT) {
      return res.status(429).json({
        error: `وصلتي للحد المجاني اليومي (${FREE_CHAT_DAILY_LIMIT} محادثات). عاود جرب غدا أو اشترك باش تكمل.`,
        limit_reached: true,
        chat_used: chatUsed,
        chat_limit: FREE_CHAT
