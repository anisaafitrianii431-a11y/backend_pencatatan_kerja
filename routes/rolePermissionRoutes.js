const express = require('express');
const { getRolePermissions, updateRolePermissions } = require('../controllers/rolePermissionController');

const router = express.Router();
router.get('/', getRolePermissions);
router.get('/mine', (req, res) => res.json({ success: true, permissions: req.user?.permissions || {} }));
router.put('/', updateRolePermissions);

module.exports = router;
