const express = require('express');
const router = express.Router();
const { login, getMe } = require('../controllers/authController');
const { verifyToken } = require('../middlewares/auth');

// Endpoint: POST /api/auth/login
router.post('/login', login);

// Endpoint: GET /api/auth/me (butuh token)
router.get('/me', verifyToken, getMe);

module.exports = router;