const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

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
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|gif|pdf|svg/i;
    const ext = path.extname(file.originalname || '').toLowerCase().replace('.', '');
    const mime = (file.mimetype || '').toLowerCase();
    if (allowed.test(ext) || allowed.test(mime)) {
      cb(null, true);
    } else {
      cb(new Error('Format file tidak didukung. Harap upload gambar (JPG, PNG, WEBP) atau PDF.'));
    }
  }
});

// Middleware Global
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',').map((origin) => origin.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length > 0 ? allowedOrigins : true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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

const userResolver = require('./middlewares/userResolver');
const authorizeRequest = require('./middlewares/authorizeRequest');
app.use(userResolver);
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
      message: 'Koneksi database gagal',
      error: err.message
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
app.use('/api/master-role', require('./routes/masterRoleRoutes'));
app.use('/api/master_role', require('./routes/masterRoleRoutes'));
app.use('/api/role-permissions', require('./routes/rolePermissionRoutes'));

// ==========================================
// ALIAS KOMPATIBILITAS FRONTEND REACT
// ==========================================
app.all('/api/auth.php', (req, res) => {
  const action = req.query.action || req.body?.action || (req.method === 'POST' ? 'login' : '');
  if (action === 'ping') return res.json({ success: true, message: 'pong' });
  if (action === 'login' || (req.method === 'POST' && !req.query.action && !req.body?.action)) {
    return require('./controllers/authController').login(req, res);
  }
  if (action === 'logout') return res.json({ success: true, message: 'logout berhasil' });
  if (action === 'me') return require('./controllers/authController').getMe(req, res);
  return res.json({ success: true });
});

app.use('/api/pekerja.php', require('./routes/karyawanRoutes'));
app.use('/api/karyawan.php', require('./routes/karyawanRoutes'));
app.use('/api/pekerjaan.php', require('./routes/pekerjaanRoutes'));
app.use('/api/penugasan.php', require('./routes/penugasanRoutes'));
app.use('/api/absensi.php', require('./routes/absensiRoutes'));
app.use('/api/pengeluaran.php', require('./routes/pengeluaranRoutes'));
app.use('/api/gaji.php', require('./routes/gajiRoutes'));
app.use('/api/users.php', require('./routes/userRoutes'));
app.use('/api/rekap.php', (req, res) => require('./controllers/rekapController').getDashboardRekap(req, res));
app.use('/api/rekap', (req, res) => require('./controllers/rekapController').getDashboardRekap(req, res));

// 404 JSON Handler untuk seluruh endpoint API agar selalu merespons JSON
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: `Endpoint API tidak ditemukan: ${req.method} ${req.originalUrl}` });
});

// Jalankan Server
app.listen(PORT, () => {
  console.log(`Server Express berjalan di http://localhost:${PORT}`);
});
