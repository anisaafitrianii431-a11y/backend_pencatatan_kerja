const db = require('../config/database');
const { resources } = require('../config/defaultRolePermissions');

const editableRoles = ['admin', 'karyawan'];
const actions = ['can_create', 'can_read', 'can_update', 'can_delete'];

async function getRolePermissions(req, res) {
  try {
    if (req.user?.peran !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Hanya super admin yang dapat mengatur hak akses.' });
    }
    const [rows] = await db.query(
      'SELECT role_name, resource_key, can_create, can_read, can_update, can_delete FROM role_permissions ORDER BY role_name, resource_key',
    );
    return res.json({
      success: true,
      data: { roles: editableRoles, resources, permissions: rows },
    });
  } catch (error) {
    console.error('Error getRolePermissions:', error);
    return res.status(500).json({ success: false, message: 'Gagal memuat pengaturan hak akses.' });
  }
}

async function updateRolePermissions(req, res) {
  if (req.user?.peran !== 'super_admin') {
    return res.status(403).json({ success: false, message: 'Hanya super admin yang dapat mengatur hak akses.' });
  }

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
    await connection.query("DELETE FROM role_permissions WHERE role_name IN ('admin', 'karyawan')");
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

module.exports = { getRolePermissions, updateRolePermissions };
