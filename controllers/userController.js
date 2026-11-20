const db = require('../config/database');

async function getAllUsers(req, res) {
  try {
    const [rows] = await db.query(`
      SELECT 
        u.id_user,
        u.kode_user,
        u.id_karyawan,
        u.username,
        u.email,
        u.peran,
        u.aktif,
        u.created_at,
        k.nama,
        k.jabatan,
        k.kode_karyawan,
        k.nomor_hp,
        k.status AS status_karyawan
      FROM user u
      LEFT JOIN karyawan k ON u.id_karyawan = k.id_karyawan
      ORDER BY u.id_user ASC
    `);

    return res.json({
      success: true,
      message: 'Data pengguna berhasil dimuat',
      data: rows
    });
  } catch (error) {
    console.error('Error getAllUsers:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal mengambil data pengguna',
      error: error.message
    });
  }
}

async function getUserById(req, res) {
  try {
    const { id } = req.params;
    const [rows] = await db.query(`
      SELECT 
        u.id_user,
        u.kode_user,
        u.id_karyawan,
        u.username,
        u.email,
        u.peran,
        u.aktif,
        u.created_at,
        k.nama,
        k.jabatan,
        k.kode_karyawan,
        k.nomor_hp,
        k.status AS status_karyawan
      FROM user u
      LEFT JOIN karyawan k ON u.id_karyawan = k.id_karyawan
      WHERE u.id_user = ?
    `, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Pengguna tidak ditemukan' });
    }

    return res.json({
      success: true,
      data: rows[0]
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

async function resetPassword(req, res) {
  try {
    const { id } = req.params;
    const { kata_sandi } = req.body;
    const pass = kata_sandi || 'karyawan123';
    
    await db.query('UPDATE user SET kata_sandi = ? WHERE id_user = ?', [pass, id]);
    const [uRows] = await db.query('SELECT id_karyawan FROM user WHERE id_user = ?', [id]);
    if (uRows.length > 0 && uRows[0].id_karyawan) {
      await db.query('UPDATE karyawan SET kata_sandi = ? WHERE id_karyawan = ?', [pass, uRows[0].id_karyawan]);
    }

    return res.json({
      success: true,
      message: 'Kata sandi berhasil direset'
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

async function toggleStatus(req, res) {
  try {
    const { id } = req.params;
    const { status, aktif } = req.body;
    const isAktif = (aktif === 1 || aktif === true || status === 'aktif') ? 1 : 0;

    await db.query('UPDATE user SET aktif = ? WHERE id_user = ?', [isAktif, id]);
    const [uRows] = await db.query('SELECT id_karyawan FROM user WHERE id_user = ?', [id]);
    if (uRows.length > 0 && uRows[0].id_karyawan) {
      await db.query('UPDATE karyawan SET status = ? WHERE id_karyawan = ?', [isAktif ? 'aktif' : 'nonaktif', uRows[0].id_karyawan]);
    }

    return res.json({
      success: true,
      message: `Status pengguna berhasil diubah menjadi ${isAktif ? 'aktif' : 'nonaktif'}`
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

module.exports = {
  getAllUsers,
  getUserById,
  resetPassword,
  toggleStatus
};
