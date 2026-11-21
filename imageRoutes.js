const express = require('express');
const db = require('./database');
const { requireAuth } = require('./authMiddleware');
const crypto = require('crypto');
const chatRouter = require('./chatRoutes');

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
const MAX_FALLBACKS = 3;                  // ما كنجربوش جميع النماذج

const BLOCKED_KEYWORDS = [
  'child', 'kid', 'minor', 'طفل', 'أطفال',
  'naked', 'nude', 'nsfw', 'porn', 'sex', 'عاري', 'عارية'
];

function containsBlockedContent(text) {
  const lower = text.toLowerCase();
  return BLOCKED_KEYWORDS.some(k => lower.includes(k));
}


// نماذج الصور كتفهم الإنجليزية مزيان؛ الوصف بالعربية/الفرنسية كيعطي صور ما عندها علاقة. كنترجمو الوصف قبل التوليد.
const translationCache = new Map(); // hash -> Promise<string>
const TRANSLATE_CACHE_MAX = 200;
const TRANSLATE_TIMEOUT_MS = 10000;
async function toEnglishPrompt(prompt) {
  if (/^[\x00-\x7F]+$/.test(prompt)) return prompt; // إنجليزي/ASCII: ما كنترجموش
  const key = crypto.createHash('sha256').update(prompt).digest('hex');
  if (translationCache.has(key)) return translationCache.get(key);

  const clean = (t) => {
    const out = String(t || '').trim().replace(/^["'\s]+|["'\s]+$/g, '');
    return out.length >= 3 && out.length <= 800 && !/^\s*[{<]/.test(out) ? out : '';
  };
  const instr = 'Translate the following image description into English for an AI image generator. ' +
    'Output ONLY the English description (one short paragraph, no quotes, no notes). ' +
    'Keep every detail; if the text is very short you may add a few concrete visual details (lighting, style).\n\n' +
    'Description:\n' + prompt;

  // مترجمين فـ نفس الوقت: أول واحد كيرجع ترجمة صالحة كيربح (كيخفف التأخير)
  const viaChat = async () => {
    const ask = chatRouter.askWithFailover;
    if (typeof ask !== 'function') throw new Error('no chat');
    const r = await ask('openrouter/free', instr, 200);
    const out = r && r.ok ? clean(r.text) : '';
    if (!out) throw new Error('chat: empty');
    return out;
  };
  const viaPollinations = async () => {
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), TRANSLATE_TIMEOUT_MS);
    try {
      const rr = await fetch('https://text.pollinations.ai/' + encodeURIComponent(instr) + '?model=openai-fast', { signal: ctl.signal });
      if (!rr.ok) throw new Error('pollinations HTTP ' + rr.status);
      const out = clean(await rr.text());
      if (!out) throw new Error('pollinations: empty');
      return out;
    } finally { clearTimeout(tm); }
  };
  const anyOf = (fns) => new Promise((resolve, reject) => {
    let failed = 0;
    fns.forEach((fn) => fn().then(resolve, (e) => { console.warn('translate attempt failed:', e.message); if (++failed === fns.length) reject(e); }));
  });

  const p = Promise.race([
    anyOf([viaChat, viaPollinations]),
    new Promise((_, reject) => setTimeout(() => reject(new Error('translate timeout')), TRANSLATE_TIMEOUT_MS))
  ]).catch((e) => {
    console.warn('translate: using original prompt (' + e.message + ')');
    translationCache.delete(key);
    return prompt;
  });
  if (translationCache.size >= TRANSLATE_CACHE_MAX) translationCache.clear();
  translationCache.set(key, p);
  return p;
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

  const englishPrompt = await toEnglishPrompt(prompt.trim());
  console.log('[image] prompt sent:', englishPrompt.slice(0, 150));
  if (englishPrompt !== prompt.trim() && containsBlockedContent(englishPrompt)) {
    return res.status(400).json({ error: 'الوصف مخالف لسياسة الاستخدام' });
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  const selectedModel = MODELS[modelKey] || MODELS.flux;
  // ترتيب الاحتياط
  const fallbackOrder = [
    MODELS['pollinations-flux'], MODELS.flux, MODELS.sdxl,
    ...Object.values(MODELS)
  ];
  const imageCandidates = [selectedModel, ...fallbackOrder]
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
            const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(englishPrompt)}` +
              `?model=${encodeURIComponent(candidate.pollinationsModel)}&width=${w}&height=${h}` +
              `&seed=${Math.floor(Math.random() * 1e9)}&nologo=true`;
            const headers = { Referer: 'https://usequerymix.com/' };
            if (process.env.POLLINATIONS_TOKEN) headers.Authorization = `Bearer ${process.env.POLLINATIONS_TOKEN}`;
            response = await fetch(pollinationsUrl, { headers, signal: controller.signal });
          } else if (candidate.provider === 'huggingface') {
            if (!process.env.HF_TOKEN) continue; // بلا توكن: نتخطاو هاد المزود
            response = await fetch(`https://router.huggingface.co/hf-inference/models/${candidate.hfModel}`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${process.env.HF_TOKEN}`, 'Content-Type': 'application/json', Accept: 'image/png' },
              body: JSON.stringify({ inputs: englishPrompt, parameters: { width: Math.min(w, 1024), height: Math.min(h, 1024) } }),
              signal: controller.signal
            });
          } else if (accountId && apiToken) {
            const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${candidate.cfModel}`;
            const body = candidate.params?.prompt ? { prompt: englishPrompt } : { prompt: englishPrompt, ...candidate.params };
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
            let detail = '';
            try { detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 300); } catch (e) {}
            console.warn(`Image model failed (${candidate.name}): HTTP ${response.status} ${detail}`);
            continue;
          }
          const declared = parseInt(response.headers.get('content-length') || '0', 10);
          if (declared > IMAGE_MAX_BYTES) { console.warn('image too large (declared)'); continue; }
          const ctype = (response.headers.get('content-type') || '').toLowerCase();
          let buf;
          if (ctype.includes('application/json')) {
            // Cloudflare FLUX كيرجع JSON: { result: { image: base64 } }
            const j = await response.json();
            const b64 = j && j.result && j.result.image;
            if (!b64 || typeof b64 !== 'string') { console.warn(`Image model returned no image (${candidate.name})`); continue; }
            buf = Buffer.from(b64, 'base64');
          } else {
            buf = Buffer.from(await response.arrayBuffer());
          }
          if (buf.byteLength > IMAGE_MAX_BYTES) { console.warn('image too large'); continue; }
          if (buf.byteLength < 1000) { console.warn(`image too small (${candidate.name})`); continue; }
          // نوع الصورة كيتحدد من الـ magic bytes (ماشي من الـ header)
          let outType = '';
          if (buf[0] === 0x89 && buf[1] === 0x50) outType = 'image/png';
          else if (buf[0] === 0xff && buf[1] === 0xd8) outType = 'image/jpeg';
          else if (buf.slice(0, 4).toString() === 'RIFF') outType = 'image/webp';
          else { console.warn(`Not an image (${candidate.name}, ${ctype})`); continue; }
          arrayBuffer = buf;
          imageContentType = outType;
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
      prompt_used: englishPrompt,
      remaining: Math.max(0, imageLimit - used),
      limit: imageLimit
    });
  } catch (err) {
    console.error('خطأ فتوليد الصورة:', err);
    res.status(500).json({ error: 'وقع مشكل فالسيرفر، عاود جرب' });
  }
});

module.exports = router;
