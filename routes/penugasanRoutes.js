const express = require('express');
const router = express.Router();
const {
  getAllPenugasan,
  getPenugasanById,
  createPenugasan,
  updatePenugasan,
  deletePenugasan
} = require('../controllers/penugasanController');

router.all('/', (req, res, next) => {
  if (req.method === 'POST') return createPenugasan(req, res);
  if (req.method === 'DELETE') return deletePenugasan(req, res);
  if (req.method === 'GET') return getAllPenugasan(req, res);
  next();
});

router.post('/baca', createPenugasan);
router.get('/notifikasi', getAllPenugasan);
router.get('/:id', getPenugasanById);
router.put('/:id', updatePenugasan);
router.delete('/:id', deletePenugasan);

module.exports = router;
