const db = require('../config/database');

function formatRupiah(val) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0
  }).format(Number(val) || 0);
}

/**
 * Validasi Hierarki Master Role (Disederhanakan: Hapus ketergantungan rentang gaji)
 */
async function validateRoleHierarchy(targetRole, excludeId = null) {
  // Rentang gaji min-max tidak lagi membatasi hierarki jabatan
  return null;
}

// 1. GET /api/master-role (Daftar semua role)
async function getAllMasterRole(req, res) {
  try {
    const { include_inactive, status } = req.query;

    let query = `
      SELECT r.*,
        (SELECT COUNT(*) FROM pekerjaan_role_budget prb WHERE prb.id_role = r.id_role) AS total_penggunaan
      FROM master_role r
      WHERE 1=1
    `;
    const params = [];

    // Jika eksplisit minta hanya yang aktif
    if (include_inactive === 'false' || status === 'aktif') {
      query += ' AND r.is_active = 1';
    } else if (status === 'nonaktif') {
      query += ' AND r.is_active = 0';
    }

    query += ' ORDER BY r.hierarchy_level ASC, r.default_gaji_min_bulanan ASC';

    const [rows] = await db.query(query, params);

    const formatted = rows.map(r => ({
      ...r,
      id_role: Number(r.id_role),
      hierarchy_level: Number(r.hierarchy_level),
      default_gaji_min_bulanan: Number(r.default_gaji_min_bulanan),
      default_gaji_max_bulanan: Number(r.default_gaji_max_bulanan),
      is_active: Boolean(r.is_active),
      total_penggunaan: Number(r.total_penggunaan || 0)
    }));

    return res.json({
      success: true,
      message: 'Daftar master role berhasil dimuat',
      data: formatted
    });
  } catch (error) {
    console.error('Error getAllMasterRole:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal memuat master role: ' + error.message
    });
  }
}

// 2. GET /api/master-role/:id (Detail role)
async function getMasterRoleById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, message: 'ID Role tidak valid' });
    }

    const [rows] = await db.query(`
      SELECT r.*,
        (SELECT COUNT(*) FROM pekerjaan_role_budget prb WHERE prb.id_role = r.id_role) AS total_penggunaan
      FROM master_role r
      WHERE r.id_role = ?
    `, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Master role tidak ditemukan' });
    }

    const r = rows[0];
    return res.json({
      success: true,
      message: 'Detail master role berhasil dimuat',
      data: {
        ...r,
        id_role: Number(r.id_role),
        hierarchy_level: Number(r.hierarchy_level),
        default_gaji_min_bulanan: Number(r.default_gaji_min_bulanan),
        default_gaji_max_bulanan: Number(r.default_gaji_max_bulanan),
        is_active: Boolean(r.is_active),
        total_penggunaan: Number(r.total_penggunaan || 0)
      }
    });
  } catch (error) {
    console.error('Error getMasterRoleById:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

// 3. POST /api/master-role (Tambah role baru)
async function createMasterRole(req, res) {
  try {
    const {
      nama_role,
      hierarchy_level,
      default_gaji_min_bulanan,
      default_gaji_max_bulanan,
      deskripsi = '',
      is_active = 1
    } = req.body;

    const cleanNama = String(nama_role || '').trim();
    if (!cleanNama) {
      return res.status(400).json({ success: false, message: 'Nama role wajib diisi' });
    }

    const level = parseInt(hierarchy_level, 10);
    if (isNaN(level) || level < 1) {
      return res.status(400).json({
        success: false,
        message: 'Level hierarki harus bilangan bulat positif (minimal 1)'
      });
    }

    const minSalary = parseFloat(default_gaji_min_bulanan) || 0;
    const maxSalary = parseFloat(default_gaji_max_bulanan) || 0;

    // Cek duplikasi nama role (case-insensitive)
    const [existing] = await db.query(
      'SELECT id_role FROM master_role WHERE LOWER(TRIM(nama_role)) = LOWER(TRIM(?))',
      [cleanNama]
    );
    if (existing.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Role dengan nama "${cleanNama}" sudah ada.`
      });
    }

    const activeFlag = is_active === false || is_active === 0 || is_active === '0' ? 0 : 1;

    // Jika role aktif, jalankan validasi hierarki ketat
    if (activeFlag === 1) {
      const hierarchyError = await validateRoleHierarchy({
        nama_role: cleanNama,
        hierarchy_level: level,
        default_gaji_min_bulanan: minSalary,
        default_gaji_max_bulanan: maxSalary
      });

      if (hierarchyError) {
        return res.status(400).json({
          success: false,
          message: hierarchyError
        });
      }
    }

    const [result] = await db.query(
      `INSERT INTO master_role 
        (nama_role, hierarchy_level, default_gaji_min_bulanan, default_gaji_max_bulanan, deskripsi, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [cleanNama, level, minSalary, maxSalary, deskripsi ? String(deskripsi).trim() : null, activeFlag]
    );

    return res.status(201).json({
      success: true,
      message: `Master role "${cleanNama}" (Level ${level}) berhasil dibuat!`,
      data: {
        id_role: result.insertId,
        nama_role: cleanNama,
        hierarchy_level: level,
        default_gaji_min_bulanan: minSalary,
        default_gaji_max_bulanan: maxSalary,
        deskripsi,
        is_active: Boolean(activeFlag),
        total_penggunaan: 0
      }
    });
  } catch (error) {
    console.error('Error createMasterRole:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal membuat master role: ' + error.message
    });
  }
}

// 4. PUT /api/master-role/:id (Perbarui role)
async function updateMasterRole(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, message: 'ID Role tidak valid' });
    }

    const [currentRows] = await db.query('SELECT * FROM master_role WHERE id_role = ?', [id]);
    if (currentRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Master role tidak ditemukan' });
    }

    const current = currentRows[0];
    const {
      nama_role = current.nama_role,
      hierarchy_level = current.hierarchy_level,
      default_gaji_min_bulanan = current.default_gaji_min_bulanan,
      default_gaji_max_bulanan = current.default_gaji_max_bulanan,
      deskripsi = current.deskripsi,
      is_active = current.is_active
    } = req.body;

    const cleanNama = String(nama_role || '').trim();
    if (!cleanNama) {
      return res.status(400).json({ success: false, message: 'Nama role wajib diisi' });
    }

    const level = parseInt(hierarchy_level, 10);
    if (isNaN(level) || level < 1) {
      return res.status(400).json({
        success: false,
        message: 'Level hierarki harus bilangan bulat positif (minimal 1)'
      });
    }

    const minSalary = parseFloat(default_gaji_min_bulanan) || 0;
    const maxSalary = parseFloat(default_gaji_max_bulanan) || 0;

    // Cek duplikasi nama role terhadap role lain
    const [existing] = await db.query(
      'SELECT id_role FROM master_role WHERE LOWER(TRIM(nama_role)) = LOWER(TRIM(?)) AND id_role <> ?',
      [cleanNama, id]
    );
    if (existing.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Role dengan nama "${cleanNama}" sudah digunakan oleh role lain.`
      });
    }

    const activeFlag = is_active === false || is_active === 0 || is_active === '0' ? 0 : 1;

    // Jika role diaktifkan, jalankan validasi hierarki ketat (kecualikan diri sendiri)
    if (activeFlag === 1) {
      const hierarchyError = await validateRoleHierarchy({
        nama_role: cleanNama,
        hierarchy_level: level,
        default_gaji_min_bulanan: minSalary,
        default_gaji_max_bulanan: maxSalary
      }, id);

      if (hierarchyError) {
        return res.status(400).json({
          success: false,
          message: hierarchyError
        });
      }
    }

    await db.query(
      `UPDATE master_role SET
        nama_role = ?,
        hierarchy_level = ?,
        default_gaji_min_bulanan = ?,
        default_gaji_max_bulanan = ?,
        deskripsi = ?,
        is_active = ?
      WHERE id_role = ?`,
      [cleanNama, level, minSalary, maxSalary, deskripsi ? String(deskripsi).trim() : null, activeFlag, id]
    );

    return res.json({
      success: true,
      message: `Master role "${cleanNama}" berhasil diperbarui.`,
      data: {
        id_role: id,
        nama_role: cleanNama,
        hierarchy_level: level,
        default_gaji_min_bulanan: minSalary,
        default_gaji_max_bulanan: maxSalary,
        deskripsi,
        is_active: Boolean(activeFlag)
      }
    });
  } catch (error) {
    console.error('Error updateMasterRole:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal memperbarui master role: ' + error.message
    });
  }
}

// 5. DELETE /api/master-role/:id (Hapus atau Nonaktifkan role)
async function deleteMasterRole(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, message: 'ID Role tidak valid' });
    }

    const [rows] = await db.query('SELECT * FROM master_role WHERE id_role = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Master role tidak ditemukan' });
    }

    const role = rows[0];

    // Cek apakah role sudah digunakan dalam blueprint pekerjaan (pekerjaan_role_budget)
    const [usageRows] = await db.query(
      'SELECT COUNT(*) AS total FROM pekerjaan_role_budget WHERE id_role = ?',
      [id]
    );
    const totalPenggunaan = Number(usageRows[0]?.total || 0);

    if (totalPenggunaan > 0) {
      // Soft delete: Ubah status menjadi nonaktif (is_active = 0)
      await db.query('UPDATE master_role SET is_active = 0 WHERE id_role = ?', [id]);

      return res.json({
        success: true,
        message: `Role "${role.nama_role}" telah dinonaktifkan karena sudah digunakan dalam ${totalPenggunaan} blueprint proyek.`,
        data: {
          id_role: id,
          nama_role: role.nama_role,
          is_active: false,
          soft_deleted: true,
          total_penggunaan: totalPenggunaan
        }
      });
    }

    // Jika belum pernah digunakan, boleh dihapus permanen
    await db.query('DELETE FROM master_role WHERE id_role = ?', [id]);

    return res.json({
      success: true,
      message: `Role "${role.nama_role}" berhasil dihapus permanen.`,
      data: {
        id_role: id,
        nama_role: role.nama_role,
        deleted: true
      }
    });
  } catch (error) {
    console.error('Error deleteMasterRole:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal menghapus master role: ' + error.message
    });
  }
}

module.exports = {
  getAllMasterRole,
  getMasterRoleById,
  createMasterRole,
  updateMasterRole,
  deleteMasterRole
};
