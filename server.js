const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const db = require('./config/database');

const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

// Konfigurasi Multer untuk menangani multipart/form-data (FormData)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let subfolder = 'kwitansi';
    const fn = (file.fieldname || '').toLowerCase();
    if (fn.includes('absensi')) subfolder = 'absensi';
    else if (fn.includes('kwitansi') || fn.includes('nota')) subfolder = 'kwitansi';
    else if (fn.includes('dana')) subfolder = 'dana_kantor';
    else if (fn.includes('kembali') || fn.includes('pengembalian')) subfolder = 'pengembalian';
    else if (fn.includes('reimburse') || fn.includes('bukti_bayar')) subfolder = 'bukti_bayar';
    else if (fn.includes('gaji')) subfolder = 'bukti_gaji';

    const uploadPath = path.join(__dirname, 'uploads', subfolder);
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    let ext = path.extname(file.originalname || '').toLowerCase();
    if (!ext || ext === '.') ext = '.jpg';
    if (ext === '.jpeg') ext = '.jpg';
    const hash = crypto.randomBytes(16).toString('hex');
    cb(null, `${file.fieldname}_${hash}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

// Middleware Global
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',').map((origin) => origin.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const { userResolver } = require('./middlewares/userResolver');
const authorizeRequest = require('./middlewares/authorizeRequest');
app.use(userResolver);

// Middleware Multipart Form-Data (Mendukung upload FormData dan file bukti/kuitansi)
app.use((req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    upload.any()(req, res, (err) => {
      if (err) {
        console.error('Multer upload error:', err);
        return res.status(400).json({ success: false, message: 'Gagal memproses form data: ' + err.message });
      }
      if (req.files && Array.isArray(req.files)) {
        req.files.forEach(f => {
          const subfolder = path.basename(path.dirname(f.path));
          const relativePath = `uploads/${subfolder}/${f.filename}`.replace(/\\/g, '/');
          req.body[f.fieldname] = relativePath;
        });
      }
      next();
    });
  } else {
    next();
  }
});

app.use(authorizeRequest);

// Akses publik untuk folder foto upload (absensi & nota)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/api/uploads', express.static(path.join(__dirname, 'uploads')));

// Endpoint Cek Kesehatan Server & Koneksi Database
app.get('/api/health', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT 1 + 1 AS hasil_cek');
    res.json({
      status: 'success',
      message: 'Server Node.js & Database MySQL Berhasil Terhubung!',
      data: rows[0]
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: err.code === 'ECONNREFUSED'
        ? 'MySQL belum berjalan atau alamat/port database tidak sesuai.'
        : 'Koneksi database gagal. Periksa konfigurasi backend.',
      error: err.code || 'DATABASE_CONNECTION_FAILED'
    });
  }
});

// ==========================================
// RUTE REST API MODERN
// ==========================================
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/karyawan', require('./routes/karyawanRoutes'));
app.use('/api/pekerja', require('./routes/karyawanRoutes'));
app.use('/api/pekerjaan', require('./routes/pekerjaanRoutes'));
app.use('/api/penugasan', require('./routes/penugasanRoutes'));
app.use('/api/absensi', require('./routes/absensiRoutes'));
app.use('/api/pengeluaran', require('./routes/pengeluaranRoutes'));
app.use('/api/gaji', require('./routes/gajiRoutes'));
app.use('/api/users', require('./routes/userRoutes'));
app.use('/api/role-permissions', require('./routes/rolePermissionRoutes'));

app.get('/api/rekap', (req, res) => require('./controllers/rekapController').getDashboardRekap(req, res));

// 404 JSON Handler untuk seluruh endpoint API agar selalu merespons JSON
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: `Endpoint API tidak ditemukan: ${req.method} ${req.originalUrl}` });
});

// Jalankan Server
app.listen(PORT, () => {
  console.log(`Server Express berjalan di http://localhost:${PORT}`);
});
