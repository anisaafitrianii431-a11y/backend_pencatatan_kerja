const express = require('express');
const router = express.Router();
const {
  getAllPenugasan,
  getPenugasanById,
  createPenugasan,
  updatePenugasan,
  deletePenugasan,
  cekKetersediaanKaryawan,
  getPenugasanGajiRiwayat,
  updatePenugasanGajiRiwayat
} = require('../controllers/penugasanController');

// Dispatcher root untuk kompatibilitas /api/penugasan dan /api/penugasan.php
router.all('/', (req, res, next) => {
  const action = req.query.action || req.body?.action;
  const rawId = req.query.id_penugasan;

  if (action === 'cek-ketersediaan') return cekKetersediaanKaryawan(req, res);
  if (action === 'gaji-riwayat' && rawId) {
    const id = parseInt(rawId, 10);
    if (req.method === 'POST') return updatePenugasanGajiRiwayat({ ...req, params: { id } }, res);
    return getPenugasanGajiRiwayat({ ...req, params: { id } }, res);
  }

  if (req.method === 'POST') return createPenugasan(req, res);
  if (req.method === 'DELETE') return deletePenugasan(req, res);
  if (req.method === 'GET') return getAllPenugasan(req, res);
  next();
});

// Endpoint Spesifik Notifikasi & Cek Ketersediaan
router.post('/baca', createPenugasan);
router.get('/notifikasi', getAllPenugasan);
router.get('/cek-ketersediaan', cekKetersediaanKaryawan);

// Endpoint Riwayat Gaji & Perubahan Skema Gaji
router.get('/:id/gaji-riwayat', getPenugasanGajiRiwayat);
router.post('/:id/gaji-riwayat', updatePenugasanGajiRiwayat);

// Endpoint Detail & Hapus Penugasan per ID
router.get('/:id', getAllPenugasan);
router.put('/:id', updatePenugasan);
router.delete('/:id', deletePenugasan);

module.exports = router;
