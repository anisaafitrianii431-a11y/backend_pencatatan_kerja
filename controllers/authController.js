const db = require('../config/database');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { saveBase64Image } = require('../utils/uploadHelper');
const { getRolePermissionsMap } = require('../config/defaultRolePermissions');

function issueAuthCookie(res, userId) {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('Konfigurasi autentikasi backend belum lengkap.');
  const token = jwt.sign({ id_user: Number(userId) }, secret, { expiresIn: '7d' });
  res.cookie('pencatatan_auth', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

// Fungsi Login
async function login(req, res) {
  try {
    const { identifier, username, email, password, kata_sandi } = req.body;
    const inputId = (identifier || username || email || '').trim();
    const inputPass = (password || kata_sandi || '').trim();

    if (!inputId || !inputPass) {
      return res.status(400).json({
        success: false,
        status: 'error',
        message: 'Email / ID Karyawan dan kata sandi wajib diisi.'
      });
    }

    // Admin maupun karyawan harus memiliki akun aktif di database.
    const cleanInput = inputId.toLowerCase().trim();

    let [rows] = await db.query(
      `SELECT 
         u.id_user,
         u.username,
         u.email AS user_email,
         u.kata_sandi,
         u.peran,
         u.aktif AS user_aktif,
         k.id_karyawan,
         k.kode_karyawan,
         k.nama,
         k.jabatan,
         k.email AS karyawan_email,
         k.nominal_upah,
         k.tarif_per_jam,
         k.jenis_upah,
         k.status AS status_karyawan
       FROM user u
       LEFT JOIN karyawan k ON u.id_karyawan = k.id_karyawan
       WHERE LOWER(u.username) = ?
          OR LOWER(u.email) = ?
          OR LOWER(k.kode_karyawan) = ?
          OR LOWER(k.email) = ?
          OR LOWER(k.nama) = ?
       LIMIT 1`,
      [cleanInput, cleanInput, cleanInput, cleanInput, cleanInput, cleanInput]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        status: 'error',
        message: 'Akun karyawan tidak ditemukan. Periksa kembali ID / Email Anda.'
      });
    }

    const account = rows[0];
    if (Number(account.user_aktif) !== 1 || (account.status_karyawan && account.status_karyawan !== 'aktif')) {
      return res.status(403).json({ success: false, status: 'error', message: 'Akun Anda tidak aktif. Hubungi administrator.' });
    }

    // Hash PHP memakai awalan $2y$; kredensial teks biasa ditolak.
    let validPassword = false;
    if (account.kata_sandi && /^\$2[aby]\$/.test(account.kata_sandi)) {
      try {
        validPassword = bcrypt.compareSync(inputPass, account.kata_sandi.replace(/^\$2y\$/, '$2b$'));
      } catch {
        validPassword = false;
      }
    }

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        status: 'error',
        message: 'Kata sandi yang Anda masukkan salah.'
      });
    }

    const permissions = await getRolePermissionsMap(account.peran, db);

    const workerUser = {
      id: account.id_karyawan || account.id_user,
      id_user: account.id_user,
      id_karyawan: account.id_karyawan,
      employeeId: account.id_karyawan,
      kode_karyawan: account.kode_karyawan || account.username,
      nama: account.nama || account.username,
      name: account.nama || account.username,
      email: account.karyawan_email || account.user_email || `${(account.kode_karyawan || 'user').toLowerCase()}@jamkerja.com`,
      jabatan: account.jabatan || 'Teknisi',
      role: account.peran || 'karyawan',
      peran: account.peran || 'karyawan',
      tarif_per_jam: Number(account.nominal_upah || account.tarif_per_jam) || 0,
      jenis_upah: account.jenis_upah || 'per_jam',
      nominal_upah: Number(account.nominal_upah) || 0,
      permissions
    };

    issueAuthCookie(res, account.id_user);

    return res.json({
      success: true,
      status: 'success',
      message: 'Login karyawan berhasil',
      user: workerUser,
      data: workerUser
    });

  } catch (error) {
    console.error('Error login:', error);
    return res.status(500).json({
      success: false,
      status: 'error',
      message: 'Terjadi kesalahan pada server saat login.',
      error: error.message
    });
  }
}

// Fungsi Cek Profil User yang sedang Login (GET /me)
async function getMe(req, res) {
  if (!req.user) return res.status(401).json({ success: false, message: 'Sesi login tidak ditemukan.' });
  return res.json({ success: true, status: 'success', user: req.user, data: req.user });
}

function logout(req, res) {
  res.clearCookie('pencatatan_auth', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api',
  });
  return res.json({ success: true, message: 'Logout berhasil.' });
}

async function register(req, res) {
  const nama = String(req.body?.nama || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const jabatan = String(req.body?.jabatan || 'Pekerja').trim();
  const password = String(req.body?.kata_sandi || req.body?.password || '');
  if (nama.length < 3 || nama.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) {
    return res.status(400).json({ success: false, message: 'Nama, email valid, dan kata sandi minimal 8 karakter wajib diisi.' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [duplicate] = await connection.query('SELECT id_user FROM user WHERE email = ? LIMIT 1', [email]);
    if (duplicate.length) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'Email sudah digunakan.' });
    }
    const [worker] = await connection.query(
      'INSERT INTO karyawan (nama, jabatan, tarif_per_jam) VALUES (?, ?, 0)',
      [nama, jabatan || 'Pekerja']
    );
    const passwordHash = await bcrypt.hash(password, 12);
    const [account] = await connection.query(
      'INSERT INTO user (id_karyawan, email, kata_sandi, peran, aktif) VALUES (?, ?, ?, \'karyawan\', 1)',
      [worker.insertId, email, passwordHash]
    );
    await connection.commit();
    issueAuthCookie(res, account.insertId);
    const user = {
      id: worker.insertId,
      id_user: account.insertId,
      id_karyawan: worker.insertId,
      employeeId: worker.insertId,
      nama,
      name: nama,
      email,
      jabatan,
      role: 'karyawan',
      peran: 'karyawan',
    };
    return res.status(201).json({ success: true, message: 'Pendaftaran berhasil.', user, data: user });
  } catch (error) {
    await connection.rollback();
    console.error('Error registration:', error);
    return res.status(500).json({ success: false, message: 'Pendaftaran gagal diproses.' });
  } finally {
    connection.release();
  }
}

async function updateProfile(req, res) {
  try {
    const user = req.user;
    const email = String(req.body?.email || '').trim().toLowerCase();
    const nama = String(req.body?.nama || '').trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || nama.length < 3 || nama.length > 100) {
      return res.status(400).json({ success: false, message: 'Nama dan format email harus valid.' });
    }
    const [duplicates] = await db.query('SELECT id_user FROM user WHERE email = ? AND id_user <> ? LIMIT 1', [email, user.id_user]);
    if (duplicates.length) return res.status(409).json({ success: false, message: 'Email sudah digunakan akun lain.' });
    await db.query('UPDATE user SET email = ? WHERE id_user = ?', [email, user.id_user]);

    if (user.id_karyawan) {
      const foto = req.body?.hapus_foto_profil ? null : saveBase64Image(req.body?.foto_profil, 'profil', 'profil_');
      await db.query(`UPDATE karyawan SET
        nama = ?, no_hp = ?, alamat = ?, kontak_darurat = ?, nama_bank = ?, no_rekening = ?,
        foto_profil = COALESCE(?, foto_profil)
        WHERE id_karyawan = ?`, [
        nama,
        req.body?.no_hp || req.body?.telepon || null,
        req.body?.alamat || null,
        req.body?.kontak_darurat || null,
        req.body?.nama_bank || null,
        req.body?.no_rekening || null,
        foto,
        user.id_karyawan,
      ]);
    }
    const [fresh] = await db.query(`SELECT u.id_user, u.id_karyawan, u.email, u.peran, k.nama, k.jabatan,
      k.tarif_per_jam, k.no_hp, k.alamat, k.foto_profil, k.kontak_darurat, k.nama_bank, k.no_rekening
      FROM user u LEFT JOIN karyawan k ON k.id_karyawan = u.id_karyawan WHERE u.id_user = ?`, [user.id_user]);
    const updated = { ...fresh[0], role: fresh[0].peran };
    return res.json({ success: true, message: 'Profil berhasil diperbarui.', user: updated, data: updated });
  } catch (error) {
    console.error('Error update profile:', error);
    return res.status(500).json({ success: false, message: 'Gagal memperbarui profil.' });
  }
}

async function changePassword(req, res) {
  try {
    const oldPassword = String(req.body?.password_lama || '');
    const newPassword = String(req.body?.password_baru || '');
    if (newPassword.length < 8) return res.status(400).json({ success: false, message: 'Kata sandi baru minimal 8 karakter.' });
    const [rows] = await db.query('SELECT kata_sandi FROM user WHERE id_user = ? LIMIT 1', [req.user.id_user]);
    const stored = rows[0]?.kata_sandi || '';
    const hash = stored.replace(/^\$2y\$/, '$2b$');
    if (!/^\$2[ab]\$/.test(hash) || !(await bcrypt.compare(oldPassword, hash))) {
      return res.status(400).json({ success: false, message: 'Kata sandi lama tidak sesuai.' });
    }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db.query('UPDATE user SET kata_sandi = ? WHERE id_user = ?', [passwordHash, req.user.id_user]);
    res.clearCookie('pencatatan_auth', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api',
    });
    return res.json({ success: true, message: 'Kata sandi berhasil diperbarui. Silakan login kembali.' });
  } catch (error) {
    console.error('Error change password:', error);
    return res.status(500).json({ success: false, message: 'Gagal mengubah kata sandi.' });
  }
}

module.exports = { login, getMe, logout, register, updateProfile, changePassword };
