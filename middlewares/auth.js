// userResolver telah memverifikasi JWT dan memuat ulang role dari database.
function verifyToken(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Silakan login untuk melanjutkan.' });
  }
  return next();
}

module.exports = { verifyToken };
