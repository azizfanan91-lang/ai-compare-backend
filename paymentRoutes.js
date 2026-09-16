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

router.get('/setup-plan', async (req, res) => {
  if (req.query.secret !== process.env.SETUP_SECRET) return res.status(403).json({ error: 'ماعندكش الحق' });
  try {
    const accessToken = await getAccessToken();
    const productRes = await fetch('https://api-m.paypal.com/v1/catalogs/products', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Azizart AI Compare Premium', description: 'اشتراك شهري بلا حدود', type: 'SERVICE', category: 'SOFTWARE' })
    });
    const product = await productRes.json();
    if (!product.id) return res.status(500).json({ error: 'فشل صنع Product', details: product });

    const planRes = await fetch('https://api-m.paypal.com/v1/billing/plans', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id: product.id,
        name: 'اشتراك شهري - Premium',
        billing_cycles: [{ frequency: { interval_unit: 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: '10.00', currency_code: 'USD' } } }],
        payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 2 }
      })
    });
    const plan = await planRes.json();
    if (!plan.id) return res.status(500).json({ error: 'فشل صنع Plan', details: plan });
    res.json({ success: true, productId: product.id, planId: plan.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/debug-paypal', async (req, res) => {
  if (req.query.secret !== process.env.SETUP_SECRET) return res.status(403).json({ error: 'ماعندكش الحق' });
  const clientId = process.env.PAYPAL_CLIENT_ID || '';
  const clientSecret = process.env.PAYPAL_SECRET || '';
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  try {
    const tokenRes = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    const tokenData = await tokenRes.json();
    res.json({
      httpStatus: tokenRes.status,
      clientIdLength: clientId.length, clientIdStart: clientId.substring(0, 6), clientIdEnd: clientId.substring(clientId.length - 6),
      secretLength: clientSecret.length, secretStart: clientSecret.substring(0, 4), secretEnd: clientSecret.substring(clientSecret.length - 4),
      paypalResponse: tokenData
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
