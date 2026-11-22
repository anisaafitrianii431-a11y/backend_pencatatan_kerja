const express = require('express');
const router = express.Router();
const {
  getAllAbsensi,
  getAbsensiById,
  absenMasuk,
  absenPulang,
  verifikasiAbsensi
} = require('../controllers/absensiController');

// Dispatcher endpoint aksi absensi pada Express.
router.all('/', (req, res, next) => {
  const action = req.query.action || req.body?.action;
  if (action === 'masuk') return absenMasuk(req, res);
  if (action === 'pulang') return absenPulang(req, res);
  if (action === 'verifikasi') return verifikasiAbsensi(req, res);
  if (req.method === 'POST') return absenMasuk(req, res);
  if (req.method === 'GET') return getAllAbsensi(req, res);
  next();
});

// Endpoint REST spesifik
router.post('/masuk', absenMasuk);
router.post('/pulang', absenPulang);
router.put('/pulang', absenPulang);
router.post('/verifikasi', verifikasiAbsensi);
router.put('/verifikasi', verifikasiAbsensi);
router.get('/:id', getAbsensiById);

router.put('/:id/pulang', absenPulang);
router.post('/:id/pulang', absenPulang);
router.put('/:id/verifikasi', verifikasiAbsensi);
router.post('/:id/verifikasi', verifikasiAbsensi);

// Endpoint fleksibel PUT / POST /:id (menangani checkout / verifikasi)
router.put('/:id', (req, res) => {
  if (req.body?.status_verifikasi || req.body?.status) {
    return verifikasiAbsensi(req, res);
  }
  return absenPulang(req, res);
});

router.post('/:id', (req, res) => {
  if (req.body?.status_verifikasi || req.body?.status) {
    return verifikasiAbsensi(req, res);
  }
  return absenPulang(req, res);
});

module.exports = router;
