// هاد الـ middleware كيتحقق من الـ token ديال كل طلب

const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'خاصك تسجل الدخول أولا' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'الـ token غير صالح، سجل الدخول من جديد' });
  }
}

module.exports = { requireAuth };
