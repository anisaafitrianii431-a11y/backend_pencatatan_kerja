const resources = [
  { key: 'users', label: 'Akun pengguna' },
  { key: 'karyawan', label: 'Data karyawan' },
  { key: 'pekerjaan', label: 'Data pekerjaan' },
  { key: 'penugasan', label: 'Penugasan' },
  { key: 'absensi', label: 'Absensi' },
  { key: 'pengeluaran', label: 'Pengeluaran & dana' },
  { key: 'gaji', label: 'Penggajian' },
  { key: 'rekap', label: 'Rekap & laporan' },
];

const grants = {
  admin: {
    users: [0, 1, 1, 0],
    karyawan: [1, 1, 1, 1],
    pekerjaan: [1, 1, 1, 1],
    penugasan: [1, 1, 1, 1],
    absensi: [0, 1, 1, 0],
    pengeluaran: [1, 1, 1, 1],
    gaji: [1, 1, 1, 1],
    rekap: [0, 1, 0, 0],
  },
  karyawan: {
    users: [0, 0, 0, 0],
    karyawan: [0, 1, 0, 0],
    pekerjaan: [1, 1, 0, 0],
    penugasan: [0, 1, 1, 0],
    absensi: [1, 1, 1, 0],
    pengeluaran: [1, 1, 1, 1],
    gaji: [0, 1, 0, 0],
    rekap: [0, 1, 0, 0],
  },
};

const defaults = Object.entries(grants).flatMap(([role, byResource]) =>
  resources.map(({ key }) => {
    const [create, read, update, del] = byResource[key];
    return {
      role_name: role,
      resource_key: key,
      can_create: create,
      can_read: read,
      can_update: update,
      can_delete: del,
    };
  }),
);

async function getRolePermissionsMap(role, db) {
  const map = {};
  if (role === 'super_admin') {
    for (const res of resources) {
      map[res.key] = { can_create: 1, can_read: 1, can_update: 1, can_delete: 1 };
    }
    return map;
  }

  for (const res of resources) {
    const fallback = grants[role]?.[res.key] || [0, 0, 0, 0];
    map[res.key] = {
      can_create: fallback[0] || 0,
      can_read: fallback[1] || 0,
      can_update: fallback[2] || 0,
      can_delete: fallback[3] || 0,
    };
  }

  if (!db) return map;

  try {
    const [rows] = await db.query(
      'SELECT resource_key, can_create, can_read, can_update, can_delete FROM role_permissions WHERE role_name = ?',
      [role],
    );
    for (const row of rows) {
      map[row.resource_key] = {
        can_create: Number(row.can_create) === 1 ? 1 : 0,
        can_read: Number(row.can_read) === 1 ? 1 : 0,
        can_update: Number(row.can_update) === 1 ? 1 : 0,
        can_delete: Number(row.can_delete) === 1 ? 1 : 0,
      };
    }
  } catch (error) {
    console.error('Gagal mengambil role_permissions map:', error);
  }

  return map;
}

module.exports = { resources, defaults, grants, getRolePermissionsMap };
