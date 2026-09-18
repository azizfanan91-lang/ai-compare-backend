const express = require('express');
const multer = require('multer');
const db = require('./database');
const { requireAuth } = require('./authMiddleware');

const router = express.Router();
// Gumroad كايبعت الـ Ping بصيغة multipart/form-data، خاصنا multer باش نقراوه
const upload = multer();

// GET /api/payment/config
// كايرجع رابط المنتج ديال Gumroad باش الفرونت يوجه المستخدم ليه
router.get('/config', (req, res) => {
  if (!process.env.GUMROAD_PRODUCT_URL) {
    return res.status(500).json({ error: 'الدفع ماشي معمر مزيان فالسيرفر' });
  }
  res.json({ productUrl: process.env.GUMROAD_PRODUCT_URL });
});

// GET /api/payment/my-subscription
// كايرجع الحالة ديال الاشتراك للمستخدم الحالي
router.get('/my-subscription', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT is_premium, gumroad_subscription_id FROM users WHERE id = $1',
      [req.userId]
    );
    res.json(result.rows[0] || { is_premium: false, gumroad_subscription_id: null });
  } catch (err) {
    console.error('خطأ فـ my-subscription:', err);
    res.status(500).json({ error: 'وقع مشكل فالسيرفر' });
  }
});

// POST /api/payment/gumroad-webhook
// هادي نقطة النهاية اللي Gumroad كايبعت ليها Ping تلقائي كل مرة يوقع شي حدث
// (بيع جديد، إلغاء، تجديد...). ماشي محتاجة auth حيت Gumroad هو اللي كايبعت ليها.
router.post('/gumroad-webhook', upload.none(), async (req, res) => {
  try {
    const body = req.body || {};

    // 1) نتحققو بلي الطلب جاي فعلا من الحساب ديالنا فـ Gumroad، ماشي من حد آخر
    if (!process.env.GUMROAD_SELLER_ID || body.seller_id !== process.env.GUMROAD_SELLER_ID) {
      console.warn('Ping مرفوض: seller_id ماشي مطابق');
      return res.status(403).send('Forbidden');
    }

    const email = (body.email || '').toLowerCase().trim();
    const subscriptionId = body.subscription_id || null;
    // resource_name كايبين نوع الحدث: sale, cancellation, subscription_ended,
    // subscription_updated, subscription_restarted, refund, dispute...
    const resourceName = body.resource_name || 'sale';

    if (!email) {
      console.warn('Ping بلا إيميل، تجاهلناه');
      return res.status(200).send('OK'); // نرجعو 200 باش Gumroad ما يعاودش يبعت
    }

    // 2) نحددو واش هاد الحدث كيفعل ولا كيلغي الاشتراك
    const deactivatingEvents = ['cancellation', 'subscription_ended', 'refund', 'dispute'];
    const activatingEvents = ['sale', 'subscription_updated', 'subscription_restarted'];

    if (activatingEvents.includes(resourceName)) {
      const result = await db.query(
        'UPDATE users SET is_premium = 1, gumroad_subscription_id = $1 WHERE LOWER(email) = $2',
        [subscriptionId, email]
      );
      if (result.rowCount === 0) {
        console.warn('Ping تفعيل بلا مستخدم مطابق للإيميل:', email);
      } else {
        console.log('تفعل الاشتراك بنجاح لـ:', email);
      }
    } else if (deactivatingEvents.includes(resourceName)) {
      const result = await db.query(
        'UPDATE users SET is_premium = 0 WHERE LOWER(email) = $1',
        [email]
      );
      if (result.rowCount === 0) {
        console.warn('Ping إلغاء بلا مستخدم مطابق للإيميل:', email);
      } else {
        console.log('تلغى الاشتراك لـ:', email);
      }
    } else {
      console.log('Ping بحدث ماشي معروف، تجاهلناه:', resourceName);
    }

    // خاصنا نرجعو 200 ديما باش Gumroad ما يعاودش يبعت نفس الـ Ping
    res.status(200).send('OK');
  } catch (err) {
    console.error('خطأ فـ gumroad-webhook:', err);
    // كنرجعو 200 حتى فحالة الخطأ الداخلي باش Gumroad ما يبقاش يعاود بلا داعي
    res.status(200).send('OK');
  }
});

module.exports = router;
