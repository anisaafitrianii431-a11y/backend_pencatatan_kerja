const db = require('../config/database');

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

    const [result] = await db.query(
      `INSERT INTO karyawan 
        (kode_karyawan, nama, jabatan, email, nomor_hp, no_hp, jenis_upah, nominal_upah, tarif_per_jam, alamat, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [kode_karyawan, nama, jabatan || 'Teknisi', email || null, hp, hp, jenis_upah, tarif, tarif, alamat || null, status]
    );

    return res.status(201).json({
      success: true,
      message: 'Karyawan berhasil ditambahkan',
      data: {
        id_karyawan: result.insertId,
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
  getKaryawanById,
  createKaryawan,
  updateKaryawan,
  deleteKaryawan
};