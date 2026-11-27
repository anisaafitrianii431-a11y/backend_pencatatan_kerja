const express = require('express');
const {
  getRolePermissions,
  listAvailableRoles,
  createCustomRole,
  deleteCustomRole,
  updateRolePermissions,
} = require('../controllers/rolePermissionController');

const router = express.Router();
router.get('/', getRolePermissions);
router.get('/roles', listAvailableRoles);
router.post('/roles', createCustomRole);
router.delete('/roles/:roleName', deleteCustomRole);
router.get('/mine', (req, res) => res.json({ success: true, permissions: req.user?.permissions || {} }));
router.put('/', updateRolePermissions);

module.exports = router;
