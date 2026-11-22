const express = require('express');
const router = express.Router();
const {
  getAllKaryawan,
  getMyKaryawan,
  getKaryawanById,
  createKaryawan,
  updateKaryawan,
  deleteKaryawan
} = require('../controllers/karyawanController');
const { resetKaryawanPassword } = require('../controllers/userController');

// Daftar endpoint rute
router.get('/me', getMyKaryawan);
router.get('/', getAllKaryawan);
router.get('/:id', getKaryawanById);
router.post('/', createKaryawan);
router.put('/:id', updateKaryawan);
router.post('/:id/reset-password', resetKaryawanPassword);
router.delete('/:id', deleteKaryawan);

module.exports = router;
