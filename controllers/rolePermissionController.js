const db = require('../config/database');
const { resources } = require('../config/defaultRolePermissions');

const actions = ['can_create', 'can_read', 'can_update', 'can_delete'];
const RESERVED_ROLES = new Set(['super_admin', 'admin', 'karyawan', 'pekerja']);

function slugifyRoleName(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

async function getRoleListFromDb() {
  const [roleRows] = await db.query(
    'SELECT role_name, display_name, description, is_system FROM custom_roles ORDER BY is_system DESC, created_at ASC, role_name ASC',
  );
  if (roleRows.length > 0) return roleRows;
  return [
    { role_name: 'admin', display_name: 'Admin', description: 'Administrator operasional harian', is_system: 1 },
    { role_name: 'karyawan', display_name: 'Karyawan', description: 'Pekerja lapangan / pelaksana tugas', is_system: 1 },
  ];
}

async function getRolePermissions(req, res) {
  try {
    if (req.user?.peran !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Hanya super admin yang dapat mengatur hak akses.' });
    }
    const roleDetails = await getRoleListFromDb();
    const roles = roleDetails.map((r) => r.role_name);
    const [rows] = await db.query(
      'SELECT role_name, resource_key, can_create, can_read, can_update, can_delete FROM role_permissions ORDER BY role_name, resource_key',
    );
    return res.json({
      success: true,
      data: { roles, roleDetails, resources, permissions: rows },
    });
  } catch (error) {
    console.error('Error getRolePermissions:', error);
    return res.status(500).json({ success: false, message: 'Gagal memuat pengaturan hak akses.' });
  }
}

async function listAvailableRoles(req, res) {
  try {
    if (req.user?.peran !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Hanya super admin yang dapat melihat daftar role.' });
    }
    const roleDetails = await getRoleListFromDb();
    return res.json({ success: true, data: roleDetails });
  } catch (error) {
    console.error('Error listAvailableRoles:', error);
    return res.status(500).json({ success: false, message: 'Gagal memuat daftar role.' });
  }
}

async function createCustomRole(req, res) {
  if (req.user?.peran !== 'super_admin') {
    return res.status(403).json({ success: false, message: 'Hanya super admin yang dapat menambahkan role baru.' });
  }

  const displayName = String(req.body?.display_name || req.body?.role_name || '').trim();
  const roleName = slugifyRoleName(req.body?.role_name || displayName);
  const description = String(req.body?.description || '').trim().slice(0, 255);
  const initialPermissions = req.body?.permissions && typeof req.body.permissions === 'object' ? req.body.permissions : {};

  if (!displayName || roleName.length < 2) {
    return res.status(400).json({ success: false, message: 'Nama role wajib diisi minimal 2 huruf/angka.' });
  }
  if (RESERVED_ROLES.has(roleName)) {
    return res.status(400).json({ success: false, message: `Nama role "${roleName}" sudah digunakan sebagai role bawaan sistem.` });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [existing] = await connection.query('SELECT role_name FROM custom_roles WHERE role_name = ? LIMIT 1', [roleName]);
    if (existing.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: `Role "${roleName}" sudah ada.` });
    }

    await connection.query(
      'INSERT INTO custom_roles (role_name, display_name, description, is_system) VALUES (?, ?, ?, 0)',
      [roleName, displayName, description || null],
    );

    for (const { key } of resources) {
      const rp = initialPermissions[key] || {};
      await connection.query(
        `INSERT INTO role_permissions (role_name, resource_key, can_create, can_read, can_update, can_delete)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          roleName,
          key,
          rp.can_create ? 1 : 0,
          rp.can_read ? 1 : 0,
          rp.can_update ? 1 : 0,
          rp.can_delete ? 1 : 0,
        ],
      );
    }

    await connection.commit();
    return res.status(201).json({
      success: true,
      message: `Role "${displayName}" berhasil dibuat.`,
      data: { role_name: roleName, display_name: displayName, description, is_system: 0 },
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error createCustomRole:', error);
    return res.status(500).json({ success: false, message: 'Gagal membuat role baru.' });
  } finally {
    connection.release();
  }
}

async function deleteCustomRole(req, res) {
  if (req.user?.peran !== 'super_admin') {
    return res.status(403).json({ success: false, message: 'Hanya super admin yang dapat menghapus role.' });
  }

  const roleName = slugifyRoleName(req.params.roleName);
  if (!roleName || RESERVED_ROLES.has(roleName)) {
    return res.status(400).json({ success: false, message: 'Role bawaan sistem tidak dapat dihapus.' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [roleRows] = await connection.query('SELECT is_system, display_name FROM custom_roles WHERE role_name = ? LIMIT 1', [roleName]);
    if (roleRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Role tidak ditemukan.' });
    }
    if (Number(roleRows[0].is_system) === 1) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Role bawaan sistem tidak dapat dihapus.' });
    }

    const [usedRows] = await connection.query('SELECT COUNT(*) AS total FROM `user` WHERE peran = ?', [roleName]);
    const usedCount = Number(usedRows[0]?.total || 0);
    if (usedCount > 0) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: `Role "${roleRows[0].display_name}" masih dipakai oleh ${usedCount} akun pengguna. Ubah peran akun tersebut terlebih dahulu.`,
      });
    }

    await connection.query('DELETE FROM role_permissions WHERE role_name = ?', [roleName]);
    await connection.query('DELETE FROM custom_roles WHERE role_name = ?', [roleName]);
    await connection.commit();

    return res.json({ success: true, message: `Role "${roleRows[0].display_name}" berhasil dihapus.` });
  } catch (error) {
    await connection.rollback();
    console.error('Error deleteCustomRole:', error);
    return res.status(500).json({ success: false, message: 'Gagal menghapus role.' });
  } finally {
    connection.release();
  }
}

async function updateRolePermissions(req, res) {
  if (req.user?.peran !== 'super_admin') {
    return res.status(403).json({ success: false, message: 'Hanya super admin yang dapat mengatur hak akses.' });
  }

  const roleDetails = await getRoleListFromDb();
  const editableRoles = roleDetails.map((r) => r.role_name);
  const submitted = req.body?.permissions;
  const expected = editableRoles.flatMap((role_name) => resources.map(({ key }) => `${role_name}:${key}`)).sort();
  if (!Array.isArray(submitted)) {
    return res.status(400).json({ success: false, message: 'Format hak akses tidak valid.' });
  }

  const normalized = [];
  for (const item of submitted) {
    if (!editableRoles.includes(item?.role_name) || !resources.some((resource) => resource.key === item?.resource_key)) {
      return res.status(400).json({ success: false, message: 'Role atau modul hak akses tidak dikenali.' });
    }
    const entry = { role_name: item.role_name, resource_key: item.resource_key };
    for (const action of actions) {
      if (![true, false, 0, 1, '0', '1'].includes(item[action])) {
        return res.status(400).json({ success: false, message: 'Nilai izin CRUD harus berupa aktif atau nonaktif.' });
      }
      entry[action] = item[action] === true || Number(item[action]) === 1 ? 1 : 0;
    }
    normalized.push(entry);
  }

  const received = normalized.map((item) => `${item.role_name}:${item.resource_key}`).sort();
  if (received.length !== expected.length || received.some((key, index) => key !== expected[index])) {
    return res.status(400).json({ success: false, message: 'Semua kombinasi role dan modul harus dikirim tepat satu kali.' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('DELETE FROM role_permissions WHERE role_name IN (?)', [editableRoles]);
    for (const item of normalized) {
      await connection.query(`
        INSERT INTO role_permissions
          (role_name, resource_key, can_create, can_read, can_update, can_delete)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [item.role_name, item.resource_key, ...actions.map((action) => item[action])]);
    }
    await connection.commit();
    return res.json({ success: true, message: 'Hak akses role berhasil diperbarui.' });
  } catch (error) {
    await connection.rollback();
    console.error('Error updateRolePermissions:', error);
    return res.status(500).json({ success: false, message: 'Gagal menyimpan pengaturan hak akses.' });
  } finally {
    connection.release();
  }
}

module.exports = {
  getRolePermissions,
  listAvailableRoles,
  createCustomRole,
  deleteCustomRole,
  updateRolePermissions,
};
