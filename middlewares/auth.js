const jwt = require('jsonwebtoken');

// Middleware untuk memverifikasi token JWT user
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Format: Bearer <TOKEN>

  if (!token) {
    return res.status(401).json({
      status: 'error',
      message: 'Akses ditolak. Token otentikasi tidak ditemukan.'
    });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'rahasia_kunci_jwt_12345', (err, decodedUser) => {
    if (err) {
      return res.status(403).json({
        status: 'error',
        message: 'Token tidak valid atau sudah kadaluarsa.'
      });
    }
    req.user = decodedUser;
    next();
  });
}

module.exports = { verifyToken };