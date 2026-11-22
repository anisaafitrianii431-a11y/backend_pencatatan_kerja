const express = require('express');
const router = express.Router();
const { login, getMe, logout, register, updateProfile, changePassword } = require('../controllers/authController');
const { verifyToken } = require('../middlewares/auth');

// Endpoint: POST /api/auth/login
router.post('/login', login);
router.post('/register', register);
router.post('/logout', logout);
router.post('/profile', updateProfile);
router.put('/profile', updateProfile);
router.post('/change-password', changePassword);
router.get('/ping', (req, res) => res.json({ success: true, message: 'pong' }));
router.get('/ntp-time', (req, res) => res.json({
  success: true,
  data: { epoch_ms: Date.now(), source: 'server_fallback', ntp_server: null },
}));

// Endpoint: GET /api/auth/me (butuh token)
router.get('/me', verifyToken, getMe);

module.exports = router;
