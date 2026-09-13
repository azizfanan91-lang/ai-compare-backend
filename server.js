require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./authRoutes');
const chatRoutes = require('./chatRoutes');
const adminRoutes = require('./adminRoutes');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api', chatRoutes);
app.use('/api/admin', adminRoutes);

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'AI Compare Backend خدام' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`السيرفر خدام على http://localhost:${PORT}`);
});
