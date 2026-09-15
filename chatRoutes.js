// ظ‡ط§ط¯ ط§ظ„ظ€ route ظ‡ظˆ ط§ظ„ظ‚ظ„ط¨ ط¯ظٹط§ظ„ ط§ظ„طھط·ط¨ظٹظ‚

const express = require('express');
const db = require('./database');
const { requireAuth } = require('./authMiddleware');

const router = express.Router();

const DAILY_FREE_LIMIT = parseInt(process.env.DAILY_FREE_LIMIT || '5', 10);

function getTodayString() {
  return new Date().toISOString().split('T')[0];
}

router.get('/usage', requireAuth, (req, res) => {
  const user = db.prepare('SELECT is_premium FROM users WHERE id = ?').get(req.userId);
  const today = getTodayString();
  const row = db.prepare(
    'SELECT count FROM usage_log WHERE user_id = ? AND date = ?'
  ).get(req.userId, today);

  const used = row ? row.count : 0;
  const isPremium = !!user.is_premium;

  res.json({
    is_premium: isPremium,
    used_today: used,
    daily_limit: isPremium ? null : DAILY_FREE_LIMIT,
    remaining: isPremium ? null : Math.max(0, DAILY_FREE_LIMIT - used)
  });
});

router.post('/chat', requireAuth, async (req, res) => {
  const { model, prompt } = req.body;

  if (!model || !prompt) {
    return res.status(400).json({ error: 'ط®ط§طµ model ظˆ prompt' });
  }

  const user = db.prepare('SELECT is_premium FROM users WHERE id = ?').get(req.userId);
  const isPremium = !!user.is_premium;
  const today = getTodayString();

  if (!isPremium) {
    const row = db.prepare(
      'SELECT count FROM usage_log WHERE user_id = ? AND date = ?'
    ).get(req.userId, today);
    const used = row ? row.count : 0;

    if (used >= DAILY_FREE_LIMIT) {
      return res.status(429).json({
        error: 'ظˆطµظ„طھظٹ ظ„ظ„ط­ط¯ ط§ظ„ظٹظˆظ…ظٹ ط§ظ„ظ…ط¬ط§ظ†ظٹ (' + DAILY_FREE_LIMIT + ' ط£ط³ط¦ظ„ط©). ط§ط´طھط±ظƒ ط¨ط§ط´ طھظƒظ…ظ„ ط¨ظ„ط§ ط­ط¯ظˆط¯.',
        limit_reached: true
      });
    }
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

    if (!isPremium) {
      db.prepare(`
        INSERT INTO usage_log (user_id, date, count) VALUES (?, ?, 1)
        ON CONFLICT(user_id, date) DO UPDATE SET count = count + 1
      `).run(req.userId, today);
    }

    const text = data.choices?.[0]?.message?.content || 'ظ…ط§ ط¬ط§ط´ ط¬ظˆط§ط¨';
    res.json({ text });

  } catch (err) {
    res.status(500).json({ error: 'ط®ط·ط£ ظپظ€ ط§ظ„ط§طھطµط§ظ„ ط¨ظ€ OpenRouter: ' + err.message });
  }
});

module.exports = router;
