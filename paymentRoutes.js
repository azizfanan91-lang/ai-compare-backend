const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const db = require('./database');
const { requireAuth } = require('./authMiddleware');

const limits = require('./usageLimits');

const router = express.Router();
// Gumroad كايبعت الـ Ping بصيغة multipart/form-data
const upload = multer();

const GUMROAD_API = 'https://api.gumroad.com/v2';
// حالات الاشتراك اللي كتعني أن المشترك مازال خالص (حسب توثيق Gumroad)
const ACTIVE_STATUSES = new Set(['alive', 'pending_cancellation', 'pending_failure']);

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// كنسولو Gumroad مباشرة: الـ Ping وحدو ما كيتصدقش (ما فيهش توقيع)
async function gumroadGet(path) {
  if (!process.env.GUMROAD_ACCESS_TOKEN) throw new Error('GUMROAD_ACCESS_TOKEN ناقص');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(GUMROAD_API + path, {
      headers: { Authorization: 'Bearer ' + process.env.GUMROAD_ACCESS_TOKEN },
      signal: controller.signal
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.success) throw new Error('Gumroad API ' + r.status);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function productMatches(productId) {
  // إلا حطيتي GUMROAD_PRODUCT_ID فـ Render كنفرضو المنتج الصحيح غير
  const expected = process.env.GUMROAD_PRODUCT_ID;
  return !expected || productId === expected;
}

// GET /api/payment/config
router.get('/config', (req, res) => {
  const usageLimits = {
    trialDays: limits.TRIAL_DAYS,
    freeChatDailyLimit: limits.FREE_CHAT_DAILY_LIMIT,
    freeImageDailyLimit: limits.FREE_IMAGE_DAILY_LIMIT,
    premiumImageDailyLimit: limits.PREMIUM_IMAGE_DAILY_LIMIT
  };
  if (!process.env.GUMROAD_PRODUCT_URL) {
    return res.status(500).json({ error: 'الدفع ماشي معمر مزيان فالسيرفر', usageLimits });
  }
  res.json({ productUrl: process.env.GUMROAD_PRODUCT_URL, usageLimits });
});

// GET /api/payment/my-subscription
router.get('/my-subscription', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT is_premium, gumroad_subscription_id FROM users WHERE id = $1',
      [req.userId]
    );
    res.json(result.rows[0] || { is_premium: false, gumroad_subscription_id: null });
  } catch (err) {
    console.error('خطأ فـ my-subscription:', err.message);
    res.status(500).json({ error: 'وقع مشكل فالسيرفر' });
  }
});

async function setPremium(email, on, subscriptionId) {
  if (on) {
    return db.query(
      'UPDATE users SET is_premium = 1, gumroad_subscription_id = $1 WHERE LOWER(email) = $2',
      [subscriptionId, email]
    );
  }
  // الإلغاء كيمس غير الاشتراك المطابق (ولا اللي ما مسجلش ليه معرف)
  return db.query(
    `UPDATE users SET is_premium = 0
     WHERE LOWER(email) = $1 AND (gumroad_subscription_id = $2 OR gumroad_subscription_id IS NULL)`,
    [email, subscriptionId]
  );
}

// POST /api/payment/gumroad-webhook
router.post('/gumroad-webhook', upload.none(), async (req, res) => {
  const body = req.body || {};

  // 1) الفحص الأول: seller_id (ماشي كافي وحدو، كنتحققو من Gumroad من بعد)
  if (!process.env.GUMROAD_SELLER_ID || !safeEqual(body.seller_id, process.env.GUMROAD_SELLER_ID)) {
    console.warn('Ping مرفوض: seller_id ماشي مطابق');
    return res.status(403).send('Forbidden');
  }

  const event = body.resource_name || 'sale';

  try {
    // 2) refund / dispute: كنتحققو من البيع نفسو عند Gumroad
    if (event === 'refund' || event === 'dispute' || event === 'dispute_won') {
      if (!body.sale_id) return res.status(200).send('OK');
      const { sale } = await gumroadGet('/sales/' + encodeURIComponent(body.sale_id));
      if (!sale || !productMatches(sale.product_id)) return res.status(200).send('OK');
      const bad = sale.refunded || sale.chargedback || (sale.disputed && !sale.dispute_won);
      const email = String(sale.email || '').toLowerCase().trim();
      if (bad && email) {
        const r = await setPremium(email, false, sale.subscription_id || null);
        console.log('إلغاء بسبب', event, 'لـ', email, 'rows:', r.rowCount);
      }
      return res.status(200).send('OK');
    }

    // 3) باقي الأحداث (sale, cancellation, ...): الحالة الحقيقية كتجي من Gumroad
    const subscriptionId = body.subscription_id;
    if (!subscriptionId) {
      console.log('Ping بلا subscription_id، تجاهلناه:', event);
      return res.status(200).send('OK');
    }

    const { subscriber } = await gumroadGet('/subscribers/' + encodeURIComponent(subscriptionId));
    if (!subscriber || !productMatches(subscriber.product_id)) {
      console.warn('اشتراك ماشي ديال المنتج ديالنا، تجاهلناه');
      return res.status(200).send('OK');
    }

    const email = String(subscriber.email || subscriber.user_email || '').toLowerCase().trim();
    if (!email) return res.status(200).send('OK');

    const active = ACTIVE_STATUSES.has(subscriber.status);
    const r = await setPremium(email, active, subscriptionId);
    if (r.rowCount === 0) console.warn('ما لقيناش مستخدم مطابق للإيميل ديال الاشتراك');
    else console.log(active ? 'تفعل الاشتراك' : 'تلغى الاشتراك', '| status:', subscriber.status);

    res.status(200).send('OK');
  } catch (err) {
    // 500 باش Gumroad يعاود يبعت الـ Ping بدل ما نضيعو الحدث
    console.error('خطأ فـ gumroad-webhook:', err.message);
    res.status(500).send('Error');
  }
});

module.exports = router;
