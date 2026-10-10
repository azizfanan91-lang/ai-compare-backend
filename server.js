require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./authRoutes');
const chatRoutes = require('./chatRoutes');
const adminRoutes = require('./adminRoutes');
const paymentRoutes = require('./paymentRoutes');
const savedRoutes = require('./savedRoutes');
const db = require('./database');

// جديد
const imageRoutes = require('./imageRoutes');

const app = express();
app.set('trust proxy', 1);

const rateBuckets = new Map();
function rateLimit({ windowMs, max, name }) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      rateBuckets.set(key, { startedAt: now, count: 1 });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.set('Retry-After', String(Math.ceil((windowMs - (now - bucket.startedAt)) / 1000)));
      return res.status(429).json({ error: 'طلبات كثيرة بزاف، عاود جرب من بعد شوية.' });
    }
    next();
  };
}

// CORS: كنسمحو غير للدومين الحقيقي ديال الموقع، ماشي لأي موقع فالعالم
// ALLOWED_ORIGINS فـ Render: دومينات مفصولة بفاصلة، مثلاً:
// https://usequerymix.com,https://www.usequerymix.com
const defaultOrigins = ['https://usequerymix.com', 'https://www.usequerymix.com'];
const envOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);
const allowedOrigins = envOrigins.length ? envOrigins : defaultOrigins;

app.use(cors({
  origin(origin, callback) {
    // بلا origin (Postman، curl، تطبيقات الهاتف) كنسمحو ليها
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    console.warn('CORS رفض الأصل:', origin);
    callback(new Error('غير مسموح من هاد الأصل (CORS)'));
  }
}));
app.use(express.json());

app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, name: 'auth' }), authRoutes);
app.use('/api/chat', rateLimit({ windowMs: 60 * 1000, max: 20, name: 'chat' }));
app.use('/api/images/generate', rateLimit({ windowMs: 60 * 1000, max: 10, name: 'images' }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 120, name: 'api' }), chatRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/saved-results', rateLimit({ windowMs: 60 * 1000, max: 60, name: 'saved' }), savedRoutes);

// جديد
app.use('/api/images', imageRoutes);

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'AI Compare Backend خدام',
    features: [
      'chat',
      'compare',
      'images',
      'payments'
    ]
  });
});

const PORT = process.env.PORT || 3000;

// معالج أخطاء عام (يشمل رفض CORS) — كيرجع JSON نظيف بدل صفحة HTML مخيفة
app.use((err, req, res, next) => {
  if (err && err.message === 'غير مسموح من هاد الأصل (CORS)') {
    return res.status(403).json({ error: 'الطلب مرفوض (أصل غير مسموح)' });
  }
  console.error('خطأ غير متوقع:', err);
  res.status(500).json({ error: 'وقع مشكل فالسيرفر' });
});

db.ready
  .then(() => {
    app.listen(PORT, () => {
      console.log(`السيرفر خدام على http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('تعذر تشغيل الخادم: قاعدة البيانات غير جاهزة:', err.message);
    process.exit(1);
  });
