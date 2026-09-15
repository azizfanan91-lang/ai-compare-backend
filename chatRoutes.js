// هاد الـ route هو القلب ديال التطبيق

const express = require('express');
const db = require('./database');
const { requireAuth } = require('./authMiddleware');

const router = express.Router();

// فترة التجربة المجانية بالأيام (بدل الحد اليومي ديال 5 أسئلة)
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '7', 10);

// كيحسب شحال باقي من التجربة المجانية للمستخدم
function getTrialStatus(createdAt) {
  const createdDate = new Date(createdAt + 'Z'); // SQLite كيخزن UTC بلا Z، كنزيدوها باش نتأكدو
  const now = new Date();
  const diffMs = now - createdDate;
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  const daysLeft = Math.max(0, TRIAL_DAYS - diffDays);
  return {
    inTrial: diffDays < TRIAL_DAYS,
    daysLeft: Math.ceil(daysLeft)
  };
}

router.get('/usage', requireAuth, (req, res) => {
  const user = db.prepare('SELECT is_premium, created_at FROM users WHERE id = ?').get(req.userId);
  const isPremium = !!user.is_premium;
  const trial = getTrialStatus(user.created_at);

  res.json({
    is_premium: isPremium,
    in_trial: !isPremium && trial.inTrial,
    trial_days_left: !isPremium ? trial.daysLeft : null,
    trial_total_days: TRIAL_DAYS,
    // unlimited إلى كان مشترك أو مازال فـ التجربة، وإلا خاصو يشترك
    unlimited: isPremium || trial.inTrial
  });
});

router.post('/chat', requireAuth, async (req, res) => {
  const { model, prompt } = req.body;

  if (!model || !prompt) {
    return res.status(400).json({ error: 'خاص model و prompt' });
  }

  const user = db.prepare('SELECT is_premium, created_at FROM users WHERE id = ?').get(req.userId);
  const isPremium = !!user.is_premium;
  const trial = getTrialStatus(user.created_at);
  const hasAccess = isPremium || trial.inTrial;

  if (!hasAccess) {
    return res.status(429).json({
      error: 'خلصات التجربة المجانية ديالك (' + TRIAL_DAYS + ' أيام). اشترك باش تكمل تستعمل الموقع بلا حدود.',
      trial_ended: true
    });
  }

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
        max_tokens: 500
      })
    });

    const data = await response.json();

    if (data.error) {
      return res.status(502).json({ error: data.error.message });
    }

    // كنسجلو الاستعمال فقط للإحصائيات، بلا ما نحسبو عليه فالمنع
    const today = new Date().toISOString().split('T')[0];
    db.prepare(`
      INSERT INTO usage_log (user_id, date, count) VALUES (?, ?, 1)
      ON CONFLICT(user_id, date) DO UPDATE SET count = count + 1
    `).run(req.userId, today);

    const text = data.choices?.[0]?.message?.content || 'ما جاش جواب';
    res.json({ text });

  } catch (err) {
    res.status(500).json({ error: 'خطأ فـ الاتصال بـ OpenRouter: ' + err.message });
  }
});

module.exports = router;
