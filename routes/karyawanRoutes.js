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

// Endpoint profil saya
router.get('/me', getMyKaryawan);

// Dispatcher root untuk kompatibilitas /api/karyawan, /api/pekerja, /api/karyawan.php, dan /api/pekerja.php
router.all('/', (req, res, next) => {
  const id = req.query.id_karyawan || req.query.id || req.body?.id_karyawan;
  if (req.method === 'GET') {
    if (id === 'me' || req.query.action === 'me' || (req.user?.peran === 'karyawan' && (!id || String(id) === String(req.user?.id_karyawan)))) {
      return getMyKaryawan(req, res);
    }
    if (id) return getKaryawanById(req, res);
    return getAllKaryawan(req, res);
  }
  if (req.method === 'POST') return createKaryawan(req, res);
  if (req.method === 'PUT') return updateKaryawan(req, res);
  if (req.method === 'DELETE') return deleteKaryawan(req, res);
  next();
});

// Daftar endpoint RESTful dengan path parameter /:id
router.get('/:id', getKaryawanById);
router.post('/:id/reset-password', resetKaryawanPassword);
router.put('/:id', updateKaryawan);
router.delete('/:id', deleteKaryawan);

module.exports = router;