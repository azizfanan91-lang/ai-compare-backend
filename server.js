require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./authRoutes');
const chatRoutes = require('./chatRoutes');
const adminRoutes = require('./adminRoutes');
const paymentRoutes = require('./paymentRoutes');
const imageRoutes = require('./imageRoutes');
const savedRoutes = require('./savedRoutes');

const app = express();

// Render كيحط proxy قدام السيرفر: بلا هادي rate limit والمعاينة كيشوفو IP ديال Render
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// CORS: غير الدومينات ديالنا (+ localhost للتجربة)
const allowedOrigins = [
  'https://usequerymix.com',
  'https://www.usequerymix.com',
  'https://azizfanan91-lang.github.io',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Origin غير مسموح'));
  }
}));

// الحجم كيسع النصوص الطويلة + النتائج المحفوظة (100000 حرف)
app.use(express.json({ limit: '1mb' }));

const mk = (windowMs, max) => rateLimit({
  windowMs, max, standardHeaders: true, legacyHeaders: false,
  message: { error: 'طلبات بزاف، عاود جرب من بعد شوية' }
});
app.use('/api/auth', mk(15 * 60 * 1000, 30));
app.use('/api/admin', mk(15 * 60 * 1000, 30));
app.use('/api', mk(60 * 1000, 120));

app.use('/api/auth', authRoutes);
app.use('/api', chatRoutes);                 // /usage /preview /chat
app.use('/api/admin', adminRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/images', imageRoutes);         // /models /usage /generate
app.use('/api/saved-results', savedRoutes);

// خفيف: لـ cron-job / UptimeRobot، ما كيمس DB
app.get('/health', (req, res) => res.status(200).send('ok'));

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'AI Compare Backend خدام' });
});

app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(err.message === 'Origin غير مسموح' ? 403 : 500).json({ error: 'وقع مشكل فالسيرفر' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`السيرفر خدام على http://localhost:${PORT}`));
