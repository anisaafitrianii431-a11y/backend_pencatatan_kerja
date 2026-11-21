const express = require('express');
const router = express.Router();
const {
  getAllMasterRole,
  getMasterRoleById,
  createMasterRole,
  updateMasterRole,
  deleteMasterRole
} = require('../controllers/masterRoleController');

function requireAdmin(req, res, next) {
  if (req.user && req.user.peran && req.user.peran !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Akses ditolak. Pengelolaan Master Role hanya untuk Administrator.'
    });
  }
  next();
}

// Rute REST API Master Role
router.get('/', getAllMasterRole);
router.get('/:id', getMasterRoleById);
router.post('/', requireAdmin, createMasterRole);
router.put('/:id', requireAdmin, updateMasterRole);
router.delete('/:id', requireAdmin, deleteMasterRole);

module.exports = router;
