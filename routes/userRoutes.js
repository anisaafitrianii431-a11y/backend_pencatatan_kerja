const express = require('express');
const router = express.Router();
const {
  getAllUsers,
  getUserById,
  resetPassword,
  toggleStatus
} = require('../controllers/userController');

// REST users endpoint.
router.all('/', (req, res) => {
  const action = req.query.action;
  const id = req.query.id_user;
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

router.get('/:id', getUserById);
router.post('/:id/reset-password', resetPassword);
router.put('/:id/status', toggleStatus);
router.post('/:id/status', toggleStatus);

module.exports = router;
