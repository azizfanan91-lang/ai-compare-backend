const express = require('express');
const db = require('./database');
const { requireAuth } = require('./authMiddleware');

const router = express.Router();

const MODELS = {
  flux: {
    name: 'FLUX.1 Schnell',
    description: 'سريع وجودة عالية',
    cfModel: '@cf/black-forest-labs/flux-1-schnell',
    params: { prompt: true } // FLUX يقبل prompt فقط
  },
  sdxl: {
    name: 'Stable Diffusion XL',
    description: 'تفاصيل دقيقة',
    cfModel: '@cf/stabilityai/stable-diffusion-xl-base-1.0',
    params: { num_steps: 20 }
  },
  dreamshaper: {
    name: 'DreamShaper',
    description: 'إبداعي وسلس',
    cfModel: '@cf/lykon/dreamshaper-8-lcm',
    params: { num_steps: 8 }
  },
  'pollinations-flux': {
    name: 'Flux (Free)',
    description: 'بديل مجاني سريع',
    provider: 'pollinations',
    pollinationsModel: 'flux'
  },
  zimage: {
    name: 'Z-Image Turbo',
    description: 'سريع ومجاني',
    provider: 'pollinations',
    pollinationsModel: 'z-image'
  },
  sana: {
    name: 'Sana',
    description: 'إبداعي ومجاني',
    provider: 'pollinations',
    pollinationsModel: 'sana'
  },
  'flux-klein': {
    name: 'FLUX Klein',
    description: 'خفيف وسريع',
    provider: 'pollinations',
    pollinationsModel: 'flux-klein'
  },
  'sdxl-lightning': {
    name: 'SDXL Lightning',
    description: 'سريع بجودة جيدة',
    provider: 'pollinations',
    pollinationsModel: 'sdxl-lightning-free'
  }
};

const IMAGE_DAILY_LIMIT = parseInt(process.env.IMAGE_DAILY_LIMIT || '15', 10);

const BLOCKED_KEYWORDS = [
  'child', 'kid', 'minor', 'طفل', 'أطفال',
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
  const { prompt, model: modelKey = 'flux', width, height } = req.body;
  const w = Math.min(Math.max(parseInt(width, 10) || 1024, 256), 1536);
  const h = Math.min(Math.max(parseInt(height, 10) || 1024, 256), 1536);
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'خاصك تكتب وصف للصورة' });
  }
  if (prompt.length > 500) {
    return res.status(400).json({ error: 'الوصف طويل بزاف (حد أقصى 500 حرف)' });
  }
  if (containsBlockedContent(prompt)) {
    return res.status(400).json({ error: 'الوصف مخالف لسياسة الاستخدام' });
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  const selectedModel = MODELS[modelKey] || MODELS.flux;
  const imageCandidates = [selectedModel, ...Object.values(MODELS)]
    .filter((value, index, list) => value && list.indexOf(value) === index);

  try {
    const today = new Date().toISOString().split('T')[0];
    const usageResult = await db.query(
      'SELECT count FROM image_usage_log WHERE user_id = $1 AND date = $2',
      [req.userId, today]
    );
    const used = usageResult.rows[0]?.count || 0;

    if (used >= IMAGE_DAILY_LIMIT) {
      return res.status(429).json({
        error: `وصلتي للحد اليومي (${IMAGE_DAILY_LIMIT} صورة). عاود جرب غدا.`,
        limit_reached: true
      });
    }

    let arrayBuffer = null;
    let imageContentType = 'image/png';
    let usedModel = selectedModel;
    let lastError = null;
    for (const candidate of imageCandidates) {
      let response;
      if (candidate.provider === 'pollinations') {
        const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
          `?model=${encodeURIComponent(candidate.pollinationsModel)}&width=${w}&height=${h}` +
          `&seed=${Math.floor(Math.random() * 1e9)}&nologo=true`;
        const headers = { Referer: 'https://usequerymix.com/' };
        if (process.env.POLLINATIONS_TOKEN) headers.Authorization = `Bearer ${process.env.POLLINATIONS_TOKEN}`;
        response = await fetch(pollinationsUrl, { headers });
      } else if (accountId && apiToken) {
        const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${candidate.cfModel}`;
        const body = candidate.params?.prompt ? { prompt } : { prompt, ...candidate.params };
        response = await fetch(cfUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        });
      } else {
        continue;
      }
      if (response.ok) {
        arrayBuffer = await response.arrayBuffer();
        imageContentType = response.headers.get('content-type') || imageContentType;
        usedModel = candidate;
        break;
      }
      const errorText = await response.text().catch(() => '');
      lastError = errorText.slice(0, 160) || `HTTP ${response.status}`;
      console.warn(`Image model failed (${candidate.name}): ${lastError}`);
    }
    if (!arrayBuffer) {
      return res.status(502).json({ error: 'تعذّر توليد الصورة بالنماذج المجانية: ' + (lastError || 'حاول مرة أخرى') });
    }
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    const dataUri = `data:${imageContentType};base64,${base64}`;

    await db.query(`
      INSERT INTO image_usage_log (user_id, date, count) VALUES ($1, $2, 1)
      ON CONFLICT (user_id, date) DO UPDATE SET count = image_usage_log.count + 1
    `, [req.userId, today]);

    res.json({
      image: dataUri,
      model: usedModel.name,
      remaining: Math.max(0, IMAGE_DAILY_LIMIT - (used + 1))
    });
  } catch (err) {
    console.error('خطأ فتوليد الصورة:', err);
    res.status(500).json({ error: 'وقع مشكل فالسيرفر، عاود جرب' });
  }
});

module.exports = router;
