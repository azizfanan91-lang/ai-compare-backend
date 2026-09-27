const express = require('express');
const db = require('./database');
const { requireAuth } = require('./authMiddleware');

const router = express.Router();

const MODELS = {
  flux: {
    id: 'flux',
    name: 'FLUX',
    description: 'جودة عالية'
  },
  turbo: {
    id: 'turbo',
    name: 'SDXL Turbo',
    description: 'سريع جداً'
  },
  dreamshaper: {
    id: 'dreamshaper',
    name: 'DreamShaper',
    description: 'إبداعي وسلس'
  }
};

const IMAGE_DAILY_LIMIT = parseInt(process.env.IMAGE_DAILY_LIMIT || '15', 10);

const BLOCKED_KEYWORDS = [
  'child', 'kid', 'minor', 'طفل', 'أطفال', 'صغير السن',
  'naked', 'nude', 'nsfw', 'porn', 'sex', 'عاري', 'عارية'
];

function containsBlockedContent(text) {
  const lower = text.toLowerCase();
  return BLOCKED_KEYWORDS.some(k => lower.includes(k));
}

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
    const used = result.rows[0]?.count || 0;
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

  const selectedModel = MODELS[modelKey] || MODELS.flux;

  try {
    const today = new Date().toISOString().split('T')[0];
    const usageResult = await db.query(
      'SELECT count FROM image_usage_log WHERE user_id = $1 AND date = $2',
      [req.userId, today]
    );
    const used = usageResult.rows[0]?.count || 0;

    if (used >= IMAGE_DAILY_LIMIT) {
      return res.status(429).json({
        error: `وصلتي للحد اليومي ديال توليد الصور (${IMAGE_DAILY_LIMIT} فالنهار). عاود جرب غدا.`,
        limit_reached: true
      });
    }

    const encodedPrompt = encodeURIComponent(prompt);
    const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?model=${selectedModel.id}&width=1024&height=1024&nologo=true`;

    const response = await fetch(pollinationsUrl, {
      headers: { 'User-Agent': 'QueryMix/1.0' }
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'وقع مشكل فتوليد الصورة، عاود جرب' });
    }

    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const dataUri = `data:${contentType};base64,${base64}`;

    await db.query(`
      INSERT INTO image_usage_log (user_id, date, count) VALUES ($1, $2, 1)
      ON CONFLICT (user_id, date) DO UPDATE SET count = image_usage_log.count + 1
    `, [req.userId, today]);

    res.json({
      image: dataUri,
      model: selectedModel.name,
      remaining: Math.max(0, IMAGE_DAILY_LIMIT - (used + 1))
    });
  } catch (err) {
    console.error('خطأ فتوليد الصورة:', err);
    res.status(500).json({ error: 'وقع مشكل فالسيرفر، عاود جرب' });
  }
});

module.exports = router;
