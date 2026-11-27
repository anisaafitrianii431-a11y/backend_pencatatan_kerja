const express = require('express');
const router = express.Router();
const {
  getAllUsers,
  getUserById,
  createUser,
  updateUserRole,
  resetPassword,
  toggleStatus
} = require('../controllers/userController');

// Helper untuk kompatibilitas /users.php?action=... atau REST /users/:id
router.all('/', (req, res) => {
  const action = req.query.action || req.body?.action;
  const id = req.query.id_user;
  if (req.method === 'POST' && !id && (!action || action === 'create')) {
    return createUser(req, res);
  }
  if (action === 'role' && id) {
    req.params.id = id;
    return updateUserRole(req, res);
  }
  if (action === 'reset_password' && id) {
    req.params.id = id;
    return resetPassword(req, res);
  }
  if (action === 'status' && id) {
    req.params.id = id;
    return toggleStatus(req, res);
  }
  if (id) {
    req.params.id = id;
    return getUserById(req, res);
  }
  return getAllUsers(req, res);
});

router.post('/', createUser);
router.get('/:id', getUserById);
router.put('/:id/role', updateUserRole);
router.post('/:id/role', updateUserRole);
router.post('/:id/reset-password', resetPassword);
router.put('/:id/status', toggleStatus);
router.post('/:id/status', toggleStatus);

module.exports = router;
