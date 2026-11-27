const express = require('express');
const router = express.Router();
const {
  getAllPekerjaan,
  getPekerjaanById,
  getPekerjaanTersedia,
  createPekerjaan,
  updatePekerjaan,
  deletePekerjaan,
  ambilPekerjaan,
  togglePengambilanPekerjaan,
  getPekerjaanPekerja,
  tambahPekerjaKePekerjaan,
  batalkanPenugasanPekerja,
  updatePekerjaanStatusPekerja,
  getPekerjaanLaporan,
  createPekerjaanLaporan,
  setujuiPekerjaanLaporan,
  tolakPekerjaanLaporan,
  // Fitur Fase 2
  getPekerjaanBlueprint,
  updatePekerjaanBlueprint,
  getPekerjaanBudgetSummary,
  getPekerjaanKandidatKaryawan
} = require('../controllers/pekerjaanController');

// Dispatcher root untuk kompatibilitas /api/pekerjaan dan /api/pekerjaan.php
router.all('/', (req, res, next) => {
  const action = req.query?.action || req.body?.action;
  const rawId = req.query?.id_pekerjaan || req.body?.id_pekerjaan;
  req.params = req.params || {};
  if (rawId && !req.params.id) {
    req.params.id = parseInt(rawId, 10);
  }

  if (action === 'tersedia') return getPekerjaanTersedia(req, res);
  if (action === 'ambil') return ambilPekerjaan(req, res);
  if (action === 'blueprint' && req.params.id) {
    if (req.method === 'PUT') return updatePekerjaanBlueprint(req, res);
    return getPekerjaanBlueprint(req, res);
  }
  if (action === 'budget-summary' && req.params.id) {
    return getPekerjaanBudgetSummary(req, res);
  }
  if (action === 'kandidat-karyawan' && req.params.id) {
    return getPekerjaanKandidatKaryawan(req, res);
  }

  if (req.method === 'POST') return createPekerjaan(req, res);
  if (req.method === 'PUT') return updatePekerjaan(req, res);
  if (req.method === 'DELETE') return deletePekerjaan(req, res);
  if (rawId) {
    if (String(rawId).includes('/pekerja')) {
      return getPekerjaanPekerja(req, res);
    }
    if (String(rawId).includes('/laporan')) {
      return getPekerjaanLaporan(req, res);
    }
    if (String(rawId).includes('/blueprint')) {
      if (req.method === 'PUT') return updatePekerjaanBlueprint(req, res);
      return getPekerjaanBlueprint(req, res);
    }
    if (String(rawId).includes('/budget-summary')) {
      return getPekerjaanBudgetSummary(req, res);
    }
    if (String(rawId).includes('/kandidat-karyawan')) {
      return getPekerjaanKandidatKaryawan(req, res);
    }
    const numId = parseInt(rawId, 10);
    if (!isNaN(numId) && numId > 0) {
      return getPekerjaanById(req, res, numId);
    }
  }
  if (req.method === 'GET') return getAllPekerjaan(req, res);
  next();
});

// Endpoint Spesifik Laporan & Approval
router.post('/laporan/:id/setujui', setujuiPekerjaanLaporan);
router.post('/laporan/:id/tolak', tolakPekerjaanLaporan);

// Endpoint Pekerjaan Tersedia & Ambil Mandiri
router.get('/tersedia', getPekerjaanTersedia);

// Endpoint Terkait Pekerjaan Tertentu (Fase 2 Blueprint, Budget Summary, Kandidat)
router.get('/:id/blueprint', getPekerjaanBlueprint);
router.put('/:id/blueprint', updatePekerjaanBlueprint);
router.get('/:id/budget-summary', getPekerjaanBudgetSummary);
router.get('/:id/kandidat-karyawan', getPekerjaanKandidatKaryawan);

// Endpoint Terkait Pekerjaan Tertentu (Fase Sebelumnya)
router.get('/:id/pekerja', getPekerjaanPekerja);
router.post('/:id/tambah-pekerja', tambahPekerjaKePekerjaan);
router.post('/:id/pekerja/:assignmentId/batalkan', batalkanPenugasanPekerja);
router.post('/:id/pekerja/:karyawanId/status', updatePekerjaanStatusPekerja);

router.get('/:id/laporan', getPekerjaanLaporan);
router.post('/:id/laporan', createPekerjaanLaporan);

router.post('/:id/status-pengambilan', togglePengambilanPekerjaan);
router.post('/:id/ambil', ambilPekerjaan);

router.get('/:id', (req, res) => getPekerjaanById(req, res));
router.put('/:id', updatePekerjaan);
router.delete('/:id', deletePekerjaan);

module.exports = router;
