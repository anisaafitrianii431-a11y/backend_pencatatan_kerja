const db = require('../config/database');
const bcrypt = require('bcryptjs');

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
      LEFT JOIN \`user\` u ON u.id_karyawan = k.id_karyawan
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

// 2. Ambil Detail 1 Karyawan Berdasarkan ID
async function getKaryawanById(req, res) {
  try {
    const id = req.params.id || req.query.id_karyawan || req.query.id;
    if (id === 'me' || req.query.action === 'me' || (req.user?.peran === 'karyawan' && String(id) === String(req.user?.id_karyawan))) {
      return getMyKaryawan(req, res);
    }
    if (!id) {
      return res.status(400).json({ success: false, message: 'ID Karyawan wajib disertakan' });
    }
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
  try {
    const { 
      nama, 
      jabatan, 
      email, 
      nomor_hp, 
      no_hp,
      jenis_upah = 'per_jam', 
      nominal_upah = 0,
      tarif_per_jam = 0,
      lembur_aktif = 0,
      tarif_lembur = 0,
      alamat, 
      status = 'aktif' 
    } = req.body;

    if (!nama) {
      return res.status(400).json({
        success: false,
        message: 'Nama karyawan wajib diisi'
      });
    }

    // Buat kode karyawan otomatis (contoh: KRY-014) jika tidak dikirim
    const [countRows] = await db.query('SELECT COUNT(*) AS total FROM karyawan');
    const nextNum = (countRows[0].total || 0) + 1;
    const kode_karyawan = req.body.kode_karyawan || `KRY-${String(nextNum).padStart(3, '0')}`;
    const hp = nomor_hp || no_hp || '';
    const tarif = nominal_upah || tarif_per_jam || 0;
    const isLembur = lembur_aktif ? 1 : 0;
    const nominalLembur = Number(tarif_lembur) || 0;

    const [result] = await db.query(
      `INSERT INTO karyawan 
        (kode_karyawan, nama, jabatan, email, nomor_hp, no_hp, jenis_upah, nominal_upah, tarif_per_jam, lembur_aktif, tarif_lembur, alamat, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [kode_karyawan, nama, jabatan || 'Teknisi', email || null, hp, hp, jenis_upah, tarif, tarif, isLembur, nominalLembur, alamat || null, status]
    );

    const newKaryawanId = result.insertId;

    // Otomatis sinkronisasi akun user di Manajemen Pengguna
    try {
      let defaultHash = '$2y$10$EkjiRpVsUqi02mqFUNwpPOJygzdSgCEBz1xafYErfOtox5K3tZABy'; // Default bcrypt hash untuk password 'karyawan123'
      if (req.body.kata_sandi && String(req.body.kata_sandi).trim()) {
        try {
          defaultHash = await bcrypt.hash(String(req.body.kata_sandi).trim(), 10);
        } catch (_) {}
      }
      const userEmail = email || `${kode_karyawan.toLowerCase().replace(/[^a-z0-9]/g, '')}@jamkerja.com`;
      const isAktif = status === 'nonaktif' ? 0 : 1;
      await db.query(
        `INSERT INTO user (kode_user, id_karyawan, username, email, kata_sandi, peran, aktif)
         VALUES (?, ?, ?, ?, ?, 'karyawan', ?)`,
        [kode_karyawan, newKaryawanId, kode_karyawan, userEmail, defaultHash, isAktif]
      );
    } catch (userErr) {
      console.warn('Auto-create user warning:', userErr.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Karyawan berhasil ditambahkan',
      data: {
        id_karyawan: newKaryawanId,
        kode_karyawan,
        nama,
        jabatan
      }
    });
  } catch (error) {
    console.error('Error createKaryawan:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal menambahkan karyawan',
      error: error.message
    });
  }
}

// 4. Update Data Karyawan
async function updateKaryawan(req, res) {
  try {
    const id = req.params.id || req.query.id_karyawan || req.query.id || req.body?.id_karyawan;
    if (!id) {
      return res.status(400).json({ success: false, message: 'ID Karyawan wajib disertakan' });
    }
    const { 
      nama, 
      jabatan, 
      email, 
      nomor_hp, 
      no_hp,
      jenis_upah, 
      nominal_upah, 
      tarif_per_jam,
      lembur_aktif,
      tarif_lembur,
      alamat, 
      status 
    } = req.body;

    const hp = nomor_hp || no_hp;
    const tarif = nominal_upah !== undefined ? Number(nominal_upah) : (tarif_per_jam !== undefined ? Number(tarif_per_jam) : null);
    const isLembur = lembur_aktif !== undefined ? (lembur_aktif ? 1 : 0) : null;
    const nominalLembur = tarif_lembur !== undefined ? Number(tarif_lembur) : null;

    const [updateResult] = await db.query(
      `UPDATE karyawan SET 
        nama = COALESCE(?, nama),
        jabatan = COALESCE(?, jabatan),
        email = COALESCE(?, email),
        nomor_hp = COALESCE(?, nomor_hp),
        no_hp = COALESCE(?, no_hp),
        jenis_upah = COALESCE(?, jenis_upah),
        nominal_upah = COALESCE(?, nominal_upah),
        tarif_per_jam = COALESCE(?, tarif_per_jam),
        lembur_aktif = COALESCE(?, lembur_aktif),
        tarif_lembur = COALESCE(?, tarif_lembur),
        alamat = COALESCE(?, alamat),
        status = COALESCE(?, status)
      WHERE id_karyawan = ?`,
      [nama, jabatan, email, hp, hp, jenis_upah, tarif, tarif, isLembur, nominalLembur, alamat, status, id]
    );

    if (updateResult.affectedRows === 0) {
      // Periksa apakah karyawan memang ada
      const [check] = await db.query('SELECT id_karyawan FROM karyawan WHERE id_karyawan = ?', [id]);
      if (check.length === 0) {
        return res.status(404).json({ success: false, message: 'Data karyawan tidak ditemukan' });
      }
    }

    // Sinkronisasi perubahan email / status ke akun user
    if (email !== undefined || status !== undefined) {
      try {
        const isAktif = status === 'nonaktif' ? 0 : 1;
        await db.query(
          `UPDATE user SET email = COALESCE(?, email), aktif = COALESCE(?, aktif) WHERE id_karyawan = ?`,
          [email || null, status !== undefined ? isAktif : null, id]
        );
      } catch (uErr) {
        console.warn('Sync user error:', uErr.message);
      }
    }

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
    const id = req.params.id || req.query.id_karyawan || req.query.id || req.body?.id_karyawan;
    if (!id) {
      return res.status(400).json({ success: false, message: 'ID Karyawan wajib disertakan' });
    }
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