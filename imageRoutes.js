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

const { FREE_IMAGE_DAILY_LIMIT, PREMIUM_IMAGE_DAILY_LIMIT } = require('./usageLimits');

const IMAGE_TOTAL_BUDGET_MS = 80000;      // الفرونت كيوقف الطلب عند 90 ثانية
const IMAGE_ATTEMPT_TIMEOUT_MS = 35000;
const IMAGE_MAX_BYTES = 6 * 1024 * 1024;  // سقف حجم الصورة المقبولة
const MAX_FALLBACKS = 2;                  // ما كنجربوش جميع النماذج

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
    const userResult = await db.query('SELECT is_premium FROM users WHERE id = $1', [req.userId]);
    const isPremium = !!userResult.rows[0]?.is_premium;
    const limit = isPremium ? PREMIUM_IMAGE_DAILY_LIMIT : FREE_IMAGE_DAILY_LIMIT;
    const result = await db.query(
      'SELECT count FROM image_usage_log WHERE user_id = $1 AND date = $2',
      [req.userId, today]
    );
    const used = result.rows[0]?.count || 0;
    res.json({ used, limit, remaining: Math.max(0, limit - used), is_premium: isPremium });
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
    const userResult = await db.query('SELECT is_premium FROM users WHERE id = $1', [req.userId]);
    const isPremium = !!userResult.rows[0]?.is_premium;
    const imageLimit = isPremium ? PREMIUM_IMAGE_DAILY_LIMIT : FREE_IMAGE_DAILY_LIMIT;

    // حجز ذري للحصة قبل الاتصال بالمزود
    const reserve = await db.query(`
      INSERT INTO image_usage_log (user_id, date, count) VALUES ($1, $2, 1)
      ON CONFLICT (user_id, date) DO UPDATE SET count = image_usage_log.count + 1
      WHERE image_usage_log.count < $3
      RETURNING count
    `, [req.userId, today, imageLimit]);

    if (reserve.rowCount === 0) {
      return res.status(429).json({
        error: `وصلتي للحد اليومي (${imageLimit} صورة). عاود جرب غدا أو اشترك باش تكمل.`,
        limit_reached: true
      });
    }
    const used = reserve.rows[0].count; // العدد بعد الحجز

    const release = async () => {
      try {
        await db.query(
          'UPDATE image_usage_log SET count = GREATEST(count - 1, 0) WHERE user_id = $1 AND date = $2',
          [req.userId, today]
        );
      } catch (e) { console.error('release error:', e.message); }
    };

    let arrayBuffer = null;
    let imageContentType = 'image/png';
    let usedModel = selectedModel;
    const startedAt = Date.now();

    try {
      for (const candidate of imageCandidates.slice(0, 1 + MAX_FALLBACKS)) {
        const remaining = IMAGE_TOTAL_BUDGET_MS - (Date.now() - startedAt);
        if (remaining < 8000) break;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(IMAGE_ATTEMPT_TIMEOUT_MS, remaining));
        try {
          let response;
          if (candidate.provider === 'pollinations') {
            const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
              `?model=${encodeURIComponent(candidate.pollinationsModel)}&width=${w}&height=${h}` +
              `&seed=${Math.floor(Math.random() * 1e9)}&nologo=true`;
            const headers = { Referer: 'https://usequerymix.com/' };
            if (process.env.POLLINATIONS_TOKEN) headers.Authorization = `Bearer ${process.env.POLLINATIONS_TOKEN}`;
            response = await fetch(pollinationsUrl, { headers, signal: controller.signal });
          } else if (accountId && apiToken) {
            const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${candidate.cfModel}`;
            const body = candidate.params?.prompt ? { prompt } : { prompt, ...candidate.params };
            response = await fetch(cfUrl, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: controller.signal
            });
          } else {
            continue;
          }
          if (!response.ok) {
            console.warn(`Image model failed (${candidate.name}): HTTP ${response.status}`);
            continue;
          }
          const declared = parseInt(response.headers.get('content-length') || '0', 10);
          if (declared > IMAGE_MAX_BYTES) { console.warn('image too large (declared)'); continue; }
          const buf = await response.arrayBuffer();
          if (buf.byteLength > IMAGE_MAX_BYTES) { console.warn('image too large'); continue; }
          arrayBuffer = buf;
          imageContentType = response.headers.get('content-type') || imageContentType;
          usedModel = candidate;
          break;
        } catch (e) {
          console.warn(`Image model error (${candidate.name}):`, e.name === 'AbortError' ? 'timeout' : e.message);
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (e) {
      await release();
      throw e;
    }

    if (!arrayBuffer) {
      await release(); // الفشل ما كيتحسبش على المستخدم
      return res.status(502).json({ error: 'تعذّر توليد الصورة حاليا، جرب وصفاً آخر أو نموذجاً آخر بعد شوية.' });
    }
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    const dataUri = `data:${imageContentType};base64,${base64}`;

    res.json({
      image: dataUri,
      model: usedModel.name,
      remaining: Math.max(0, imageLimit - used),
      limit: imageLimit
    });
  } catch (err) {
    console.error('خطأ فتوليد الصورة:', err);
    res.status(500).json({ error: 'وقع مشكل فالسيرفر، عاود جرب' });
  }
});

module.exports = router;
