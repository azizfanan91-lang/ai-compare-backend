require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/authRoutes');
const chatRoutes = require('./routes/chatRoutes');

const app = express();

app.use(cors()); // كيسمح للـ frontend (اللي فـ Netlify) يتصل بهاد السيرفر
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api', chatRoutes);

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'AI Compare Backend خدام' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`السيرفر خدام على http://localhost:${PORT}`);
});
