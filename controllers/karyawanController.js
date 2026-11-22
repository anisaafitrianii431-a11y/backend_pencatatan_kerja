const db = require('../config/database');
const bcrypt = require('bcryptjs');

// 1. Ambil Semua Data Karyawan
async function getAllKaryawan(req, res) {
  try {
    const [rows] = await db.query(`
      SELECT 
        k.*,
        COALESCE(k.nomor_hp, k.no_hp) AS nomor_telepon,
        COALESCE(k.nominal_upah, k.tarif_per_jam, 0) AS upah_aktif
      FROM karyawan k
      ORDER BY k.id_karyawan DESC
    `);

    return res.json({
      success: true,
      message: 'Data karyawan berhasil dimuat',
      data: rows
    });
  } catch (error) {
    console.error('Error getAllKaryawan:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal mengambil data karyawan',
      error: error.message
    });
  }
}

async function getMyKaryawan(req, res) {
  try {
    const idKaryawan = Number(req.user?.id_karyawan);
    if (!Number.isInteger(idKaryawan) || idKaryawan <= 0) {
      return res.status(404).json({ success: false, message: 'Profil karyawan tidak ditemukan.' });
    }

    const [rows] = await db.query(`
      SELECT k.*, u.id_user, u.username, u.kode_user, u.aktif AS user_aktif,
             COALESCE(k.nomor_hp, k.no_hp) AS nomor_telepon,
             COALESCE(k.nominal_upah, k.tarif_per_jam, 0) AS upah_aktif
      FROM karyawan k
      LEFT JOIN user u ON u.id_karyawan = k.id_karyawan
      WHERE k.id_karyawan = ?
      LIMIT 1
    `, [idKaryawan]);

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Profil karyawan tidak ditemukan.' });
    }

    return res.json({ success: true, message: 'Profil karyawan berhasil dimuat.', data: rows[0] });
  } catch (error) {
    console.error('Error getMyKaryawan:', error);
    return res.status(500).json({ success: false, message: 'Gagal memuat profil karyawan.' });
  }
}

// 2. Ambil Detail 1 Karyawan Berdasarkan ID
async function getKaryawanById(req, res) {
  try {
    const { id } = req.params;
    const [rows] = await db.query('SELECT * FROM karyawan WHERE id_karyawan = ?', [id]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Karyawan tidak ditemukan'
      });
    }

    return res.json({
      success: true,
      data: rows[0]
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal memuat detail karyawan',
      error: error.message
    });
  }
}

// 3. Tambah Karyawan Baru
async function createKaryawan(req, res) {
  const nama = String(req.body.nama || '').trim();
  const password = String(req.body.kata_sandi || '');
  const confirmPassword = String(req.body.konfirmasi_kata_sandi || '');
  const jenisUpah = ['per_jam', 'per_hari', 'per_bulan'].includes(req.body.jenis_upah)
    ? req.body.jenis_upah : 'per_jam';
  const nominalUpah = Number(req.body.nominal_upah ?? req.body.tarif_per_jam ?? 0);
  if (nama.length < 2 || nama.length > 100 || password.length < 6 || password !== confirmPassword || !Number.isFinite(nominalUpah) || nominalUpah < 0) {
    return res.status(400).json({ success: false, message: 'Nama, upah, dan kata sandi valid wajib diisi. Konfirmasi kata sandi harus sama.' });
  }

  const kode = String(req.body.kode_karyawan || '').trim();
  if (!kode) return res.status(400).json({ success: false, message: 'Kode karyawan wajib diisi.' });
  const email = String(req.body.email || `${kode.toLowerCase()}@jamkerja.local`).trim().toLowerCase();
  const phone = String(req.body.nomor_hp || req.body.no_hp || '').trim() || null;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [duplicates] = await connection.query(
      'SELECT id_karyawan FROM karyawan WHERE kode_karyawan = ? LIMIT 1', [kode]
    );
    if (duplicates.length) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: `Kode karyawan ${kode} sudah digunakan.` });
    }
    const [employeeResult] = await connection.query(
      `INSERT INTO karyawan
        (kode_karyawan, nama, jabatan, email, nomor_hp, no_hp, jenis_upah, nominal_upah,
         tarif_per_jam, lembur_aktif, tarif_lembur, catatan_admin, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [kode, nama, req.body.jabatan || null, email, phone, phone, jenisUpah, nominalUpah,
        jenisUpah === 'per_jam' ? nominalUpah : 0, req.body.lembur_aktif ? 1 : 0,
        Number(req.body.tarif_lembur) || 0, req.body.catatan_admin || null,
        req.body.status === 'nonaktif' ? 'nonaktif' : 'aktif']
    );
    const passwordHash = await bcrypt.hash(password, 12);
    await connection.query(
      `INSERT INTO \`user\` (kode_user, id_karyawan, username, email, kata_sandi, peran, aktif)
       VALUES (?, ?, ?, ?, ?, 'karyawan', ?)`,
      [kode, employeeResult.insertId, kode, email, passwordHash, req.body.status === 'nonaktif' ? 0 : 1]
    );
    await connection.commit();
    const [rows] = await db.query(`
      SELECT k.*, u.id_user, u.aktif AS user_aktif, u.username, u.kode_user
      FROM karyawan k LEFT JOIN \`user\` u ON u.id_karyawan = k.id_karyawan
      WHERE k.id_karyawan = ? LIMIT 1
    `, [employeeResult.insertId]);
    return res.status(201).json({ success: true, message: 'Karyawan dan akun login berhasil dibuat.', data: rows[0] });
  } catch (error) {
    await connection.rollback();
    console.error('Error createKaryawan:', error);
    return res.status(500).json({ success: false, message: 'Gagal menambahkan karyawan.' });
  } finally {
    connection.release();
  }
}

// 4. Update Data Karyawan
async function updateKaryawan(req, res) {
  try {
    const { id } = req.params;
    const { 
      nama, 
      jabatan, 
      email, 
      nomor_hp, 
      no_hp,
      jenis_upah, 
      nominal_upah, 
      tarif_per_jam,
      alamat, 
      status 
    } = req.body;

    const hp = nomor_hp || no_hp;
    const tarif = nominal_upah || tarif_per_jam;

    await db.query(
      `UPDATE karyawan SET 
        nama = COALESCE(?, nama),
        jabatan = COALESCE(?, jabatan),
        email = COALESCE(?, email),
        nomor_hp = COALESCE(?, nomor_hp),
        no_hp = COALESCE(?, no_hp),
        jenis_upah = COALESCE(?, jenis_upah),
        nominal_upah = COALESCE(?, nominal_upah),
        tarif_per_jam = COALESCE(?, tarif_per_jam),
        alamat = COALESCE(?, alamat),
        status = COALESCE(?, status)
      WHERE id_karyawan = ?`,
      [nama, jabatan, email, hp, hp, jenis_upah, tarif, tarif, alamat, status, id]
    );

    return res.json({
      success: true,
      message: 'Data karyawan berhasil diperbarui'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal memperbarui data karyawan',
      error: error.message
    });
  }
}

// 5. Hapus Karyawan
async function deleteKaryawan(req, res) {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM karyawan WHERE id_karyawan = ?', [id]);

    return res.json({
      success: true,
      message: 'Karyawan berhasil dihapus'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal menghapus karyawan',
      error: error.message
    });
  }
}

module.exports = {
  getAllKaryawan,
  getMyKaryawan,
  getKaryawanById,
  createKaryawan,
  updateKaryawan,
  deleteKaryawan
};
