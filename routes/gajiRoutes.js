const express = require('express');
const router = express.Router();
const {
  getRekapGaji,
  kalkulasiGaji,
  getDetailGaji,
  tetapkanGaji,
  updatePenyesuaian,
  bayarGaji,
  getPembayaranList,
  getPembayaranHistory,
  getSlipGaji,
  getRiwayatGaji
} = require('../controllers/gajiController');

// Dispatcher untuk root kompatibilitas /api/gaji dan /api/gaji.php?action=...
router.all('/', (req, res, next) => {
  const action = req.query.action || req.body?.action;

  // GET Actions
  if (action === 'kalkulasi') return kalkulasiGaji(req, res);
  if (action === 'detail') return getDetailGaji(req, res);
  if (action === 'pembayaran_list') return getPembayaranList(req, res);
  if (action === 'pembayaran_history') return getPembayaranHistory(req, res);
  if (action === 'slip') return getSlipGaji(req, res);
  if (action === 'riwayat') return getRiwayatGaji(req, res);

  // POST Actions
  if (action === 'tetapkan' || action === 'hitung') return tetapkanGaji(req, res);
  if (action === 'penyesuaian') return updatePenyesuaian(req, res);
  if (action === 'bayar') return bayarGaji(req, res);

  if (req.method === 'POST') return tetapkanGaji(req, res);
  if (req.method === 'GET') return getRekapGaji(req, res);
  next();
});

// Endpoint REST Modern
router.get('/kalkulasi', kalkulasiGaji);
router.get('/detail', getDetailGaji);
router.get('/slip/:id', getSlipGaji);
router.get('/riwayat', getRiwayatGaji);
router.get('/pembayaran', getPembayaranList);
router.get('/pembayaran/:id', getPembayaranHistory);

router.post('/tetapkan', tetapkanGaji);
router.post('/penyesuaian', updatePenyesuaian);
router.post('/bayar', bayarGaji);
router.put('/:id/penyesuaian', updatePenyesuaian);
router.post('/:id/bayar', (req, res) => {
  req.body.id_gaji = req.params.id;
  return bayarGaji(req, res);
});

module.exports = router;
