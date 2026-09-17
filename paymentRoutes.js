const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('./database');

const router = express.Router();

function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'خاصك تدخل أولا' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'التوكن غير صالح، دخل مرة أخرى' });
  }
}

async function getAccessToken() {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64');
  const res = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const data = await res.json();
  return data.access_token;
}

router.get('/config', (req, res) => {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_PLAN_ID) {
    return res.status(500).json({ error: 'الدفع ماشي معمر مزيان فالسيرفر' });
  }
  res.json({ clientId: process.env.PAYPAL_CLIENT_ID, planId: process.env.PAYPAL_PLAN_ID });
});

router.post('/activate', requireAuth, async (req, res) => {
  const { subscriptionID } = req.body;
  if (!subscriptionID) return res.status(400).json({ error: 'ناقص subscriptionID' });
  try {
    const accessToken = await getAccessToken();
    const subRes = await fetch(`https://api-m.paypal.com/v1/billing/subscriptions/${subscriptionID}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const sub = await subRes.json();
    if (sub.status !== 'ACTIVE') return res.status(400).json({ error: 'الاشتراك ماشي فعال حاليا عند PayPal' });
    if (sub.plan_id !== process.env.PAYPAL_PLAN_ID) return res.status(400).json({ error: 'الاشتراك ماشي مطابق للخطة ديالنا' });

    await db.query('UPDATE users SET is_premium = 1, paypal_subscription_id = $1 WHERE id = $2', [subscriptionID, req.userId]);
    res.json({ success: true, message: 'تفعل الاشتراك بنجاح' });
  } catch (err) {
    console.error('خطأ فتفعيل الاشتراك:', err);
    res.status(500).json({ error: 'وقع مشكل فالتحقق من الدفع، جرب مرة أخرى' });
  }
});

router.get('/my-subscription', requireAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT is_premium, paypal_subscription_id FROM users WHERE id = $1', [req.userId]);
    res.json(result.rows[0] || { is_premium: false, paypal_subscription_id: null });
  } catch (err) {
    res.status(500).json({ error: 'وقع مشكل فالسيرفر' });
  }
});

// ملاحظة: /setup-plan و /debug-paypal تحيدو من هنا بعد ما خدمو مرة وحدة.
// إلا احتجتي تصاوب Plan جديد عند PayPal، استعمل setup-paypal-plan.js
// محليا (node setup-paypal-plan.js) بدل ما تبقى endpoint مفتوحة فالسيرفر الحي.

module.exports = router;
