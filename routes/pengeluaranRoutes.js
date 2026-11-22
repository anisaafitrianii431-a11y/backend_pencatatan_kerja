const express = require('express');
const router = express.Router();
const {
  getAllPengeluaran,
  getSummary,
  createPengeluaran,
  updatePengeluaran,
  verifikasiPengeluaran,
  deletePengeluaran,
  getDanaKantor,
  getDanaTersedia,
  getKasList,
  tambahDanaKantor,
  deleteDanaKantor,
  updateDanaKantor,
  getReimbursementList,
  bayarReimbursement,
  getRiwayatBayarReimbursement,
  getPengembalianDana,
  tambahPengembalianDana,
  verifikasiPengembalianDana,
  deletePengembalianDana,
  getRekapUangKantor
} = require('../controllers/pengeluaranController');

// Dispatcher untuk root kompatibilitas /api/pengeluaran dan /api/pengeluaran.php?action=...
router.all('/', (req, res, next) => {
  const action = req.query.action || req.body?.action;

  // GET Actions
  if (action === 'summary') return getSummary(req, res);
  if (action === 'dana_kantor') return getDanaKantor(req, res);
  if (action === 'kas_list') return getKasList(req, res);
  if (action === 'dana_tersedia') return getDanaTersedia(req, res);
  if (action === 'pengembalian_dana') return getPengembalianDana(req, res);
  if (action === 'reimbursement_list') return getReimbursementList(req, res);
  if (action === 'riwayat_bayar_reimbursement') return getRiwayatBayarReimbursement(req, res);
  if (action === 'rekap_uang_kantor') return getRekapUangKantor(req, res);

  // POST / PUT Actions
  if (action === 'update' || action === 'edit_pengeluaran') return updatePengeluaran(req, res);
  if (action === 'verifikasi') return verifikasiPengeluaran(req, res);
  if (action === 'bayar_reimbursement') return bayarReimbursement(req, res);
  if (action === 'tambah_dana') return tambahDanaKantor(req, res);
  if (action === 'update_kas' || action === 'edit_dana') return updateDanaKantor(req, res);
  if (action === 'tambah_pengembalian') return tambahPengembalianDana(req, res);
  if (action === 'verifikasi_pengembalian') return verifikasiPengembalianDana(req, res);
  if (action === 'create' || action === 'tambah_pengeluaran') return createPengeluaran(req, res);
  if (action === 'delete' || action === 'hapus_pengeluaran') return deletePengeluaran(req, res);
  if (action === 'hapus_dana') return deleteDanaKantor(req, res);
  if (action === 'hapus_pengembalian') return deletePengembalianDana(req, res);

  if (req.method === 'POST') return createPengeluaran(req, res);
  if (req.method === 'PUT') return updatePengeluaran(req, res);
  if (req.method === 'DELETE') return deletePengeluaran(req, res);
  if (req.method === 'GET') return getAllPengeluaran(req, res);
  next();
});

// Endpoint REST Modern
router.get('/summary', getSummary);
router.get('/dana-kantor', getDanaKantor);
router.get('/dana-tersedia', getDanaTersedia);
router.get('/kas-list', getKasList);
router.post('/dana-kantor', tambahDanaKantor);
router.put('/dana-kantor/:id', updateDanaKantor);
router.put('/kas-list/:id', updateDanaKantor);
router.delete('/dana-kantor/:id', deleteDanaKantor);

router.get('/pengembalian-dana', getPengembalianDana);
router.post('/pengembalian-dana', tambahPengembalianDana);
router.put('/pengembalian-dana/:id/verifikasi', verifikasiPengembalianDana);
router.delete('/pengembalian-dana/:id', deletePengembalianDana);

router.get('/reimbursement', getReimbursementList);
router.get('/reimbursement/:id/riwayat', getRiwayatBayarReimbursement);
router.post('/reimbursement/:id/bayar', bayarReimbursement);

router.put('/:id/verifikasi', verifikasiPengeluaran);
router.post('/:id/verifikasi', verifikasiPengeluaran);
router.put('/:id/bayar-reimburse', bayarReimbursement);
router.post('/:id/bayar-reimburse', bayarReimbursement);
router.put('/:id', updatePengeluaran);
router.post('/:id', updatePengeluaran);
router.delete('/:id', deletePengeluaran);

module.exports = router;
