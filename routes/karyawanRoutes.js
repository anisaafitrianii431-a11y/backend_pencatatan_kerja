const express = require('express');
const router = express.Router();
const {
  getAllKaryawan,
  getKaryawanById,
  createKaryawan,
  updateKaryawan,
  deleteKaryawan
} = require('../controllers/karyawanController');

// Daftar endpoint rute
router.get('/', getAllKaryawan);
router.get('/:id', getKaryawanById);
router.post('/', createKaryawan);
router.put('/:id', updateKaryawan);
router.delete('/:id', deleteKaryawan);

module.exports = router;