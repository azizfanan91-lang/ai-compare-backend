const express = require('express');
const { requireAuth } = require('./authMiddleware');
const db = require('./database');

const router = express.Router();

router.post('/generate', requireAuth, async (req, res) => {

  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({
      error: 'الرجاء إدخال وصف الصورة'
    });
  }

  try {

    const userResult = await db.query(
      'SELECT is_premium, created_at FROM users WHERE id = $1',
      [req.userId]
    );

    const user = userResult.rows[0];

    if (!user) {
      return res.status(401).json({
        error: 'المستخدم غير موجود'
      });
    }

    const response = await fetch(
      'https://openrouter.ai/api/v1/images/generations',
      {
        method: 'POST',
        headers: {
          'Authorization':
            `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: prompt,
          n: 1,
          size: '1024x1024'
        })
      }
    );

    const data = await response.json();

    res.json({
      image: data.data?.[0]?.url
    });

  } catch (err) {

    res.status(500).json({
      error: err.message
    });

  }

});

module.exports = router;
