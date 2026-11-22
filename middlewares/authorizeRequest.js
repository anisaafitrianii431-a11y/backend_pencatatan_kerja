const { isAdminRole } = require('../utils/roles');
const db = require('../config/database');

function forbid(res) {
  return res.status(403).json({ success: false, message: 'Akses ditolak untuk peran akun Anda.' });
}

function isAdminOnlyExpenseAction(action) {
  return [
    'summary', 'dana_kantor', 'kas_list', 'rekap', 'rekap_uang_kantor',
    'reimbursement_list', 'riwayat_bayar_reimbursement', 'verifikasi',
    'bayar_reimbursement', 'tambah_dana', 'hapus_dana', 'create_kas', 'update_kas', 'delete_kas', 'verifikasi_kas',
    'konfirmasi_pengembalian', 'verifikasi_pengembalian', 'hapus_pengembalian',
  ].includes(action);
}

function getResource(path) {
  if (path === '/api/users' || path.startsWith('/api/users/')) return 'users';
  if (path === '/api/karyawan' || path.startsWith('/api/karyawan/') || path === '/api/pekerja' || path.startsWith('/api/pekerja/')) return 'karyawan';
  if (path === '/api/pekerjaan' || path.startsWith('/api/pekerjaan/')) return 'pekerjaan';
  if (path === '/api/penugasan' || path.startsWith('/api/penugasan/')) return 'penugasan';
  if (path === '/api/absensi' || path.startsWith('/api/absensi/')) return 'absensi';
  if (path === '/api/pengeluaran' || path.startsWith('/api/pengeluaran/')) return 'pengeluaran';
  if (path === '/api/gaji' || path.startsWith('/api/gaji/')) return 'gaji';
  if (path === '/api/rekap' || path.startsWith('/api/rekap/')) return 'rekap';
  return null;
}

function getPermissionAction(method, path, action) {
  if (method === 'GET' || method === 'HEAD') return 'can_read';
  if (method === 'DELETE') return 'can_delete';
  if (method === 'PUT' || method === 'PATCH') return 'can_update';
  if (method !== 'POST') return null;

  if (['pulang', 'verifikasi', 'verifikasi_kas', 'update', 'edit_pengeluaran', 'status_ganti', 'baca', 'mark_read', 'bayar', 'bayar_reimbursement', 'bayar_reimburse', 'tetapkan', 'penyesuaian', 'konfirmasi_pengembalian', 'verifikasi_pengembalian', 'update_kas', 'update_status'].includes(action)) {
    return 'can_update';
  }
  if (['delete', 'hapus_pengeluaran', 'hapus_dana', 'hapus_pengembalian', 'delete_kas'].includes(action)) {
    return 'can_delete';
  }
  if (path.includes('/laporan/') && (path.endsWith('/setujui') || path.endsWith('/tolak'))) return 'can_update';
  return 'can_create';
}

async function hasPermission(role, resource, action) {
  const [rows] = await db.query(
    'SELECT ?? AS allowed FROM role_permissions WHERE role_name = ? AND resource_key = ? LIMIT 1',
    [action, role, resource],
  );
  return rows.length > 0 && Number(rows[0].allowed) === 1;
}

async function authorizeRequest(req, res, next) {
  if (req.path === '/api/health' || req.path.startsWith('/uploads/') || req.path.startsWith('/api/uploads/')) return next();
  if (req.path === '/api/auth/ping' || req.path === '/api/auth/ntp-time') return next();
  if (req.path === '/api/auth/login' && req.method === 'POST') return next();
  if (req.path === '/api/auth/register' && req.method === 'POST') return next();
  const user = req.user;
  if (!user) return res.status(401).json({ success: false, message: 'Silakan login untuk melanjutkan.' });

  const path = req.path.toLowerCase();
  const method = req.method.toUpperCase();
  const action = String(req.query?.action || req.body?.action || '').toLowerCase();
  if (user.peran === 'super_admin') return next();
  if (path === '/api/role-permissions/mine' && method === 'GET') return next();
  if (path === '/api/role-permissions' || path.startsWith('/api/role-permissions/')) return forbid(res);

  const resource = getResource(path);
  const permissionAction = resource ? getPermissionAction(method, path, action) : null;
  if (!['admin', 'karyawan'].includes(user.peran)) return forbid(res);
  if (resource && (!permissionAction || !(await hasPermission(user.peran, resource, permissionAction)))) {
    return forbid(res);
  }

  if (isAdminRole(user.peran)) return next();

  const workerId = Number(user.id_karyawan);

  if (!workerId) return forbid(res);

  if (path === '/api/karyawan/me' && method === 'GET') return next();

  // Semua query karyawan dipaksa ke identitas sesi server, tidak menerima ID kiriman browser.
  req.query = { ...req.query };
  req.query.id_karyawan = String(workerId);
  if (req.body && typeof req.body === 'object') req.body.id_karyawan = workerId;

  if (/(^|\/)(users?|karyawan|pekerja)(\/|$)/.test(path)) return forbid(res);

  if (path.includes('/gaji')) {
    if (method !== 'GET') return forbid(res);
    return next();
  }

  if (path.includes('/pekerjaan')) {
    delete req.query.admin_view;
    if (method === 'GET') return next();
    const isTakeJob = action === 'ambil' || /\/ambil\/?$/.test(path);
    const isWorkerReport = /\/laporan\/?$/.test(path) && method === 'POST';
    if (isTakeJob || isWorkerReport) return next();
    return forbid(res);
  }

  if (path.includes('/penugasan')) {
    if (method === 'GET') return next();
    if (method === 'POST' && ['baca', 'mark_read'].includes(action)) return next();
    return forbid(res);
  }

  if (path.includes('/absensi')) {
    if (method === 'GET') return next();
    if (method === 'POST' && ['masuk', 'pulang'].includes(action)) return next();
    if ((method === 'POST' || method === 'PUT') && /\/(masuk|pulang)\/?$/.test(path)) return next();
    return forbid(res);
  }

  if (path.includes('/pengeluaran')) {
    if (isAdminOnlyExpenseAction(action)) return forbid(res);
    if (/\/pengeluaran\/(summary|dana-kantor|kas-list)(\/|$)/.test(path)) return forbid(res);
    if (/\/pengeluaran\/\d+\/(verifikasi|bayar-reimburse)(\/|$)/.test(path)) return forbid(res);
    if (/\/pengeluaran\/pengembalian-dana\/\d+\/verifikasi(\/|$)/.test(path)) return forbid(res);
    if (/\/pengeluaran\/reimbursement(\/|$)/.test(path) && method !== 'GET') return forbid(res);
    if (/\/pengeluaran\/reimbursement\/\d+/.test(path)) return forbid(res);
    if (method === 'GET') {
      req.query.id_penanggung_jawab = String(workerId);
      return next();
    }
    if (method === 'POST' && ['pengembalian', 'tambah_pengembalian', 'create', 'tambah_pengeluaran'].includes(action)) return next();
    if (method === 'POST' && ['update', 'edit_pengeluaran'].includes(action)) return next();
    if (method === 'POST' && !action) return next();
    if (method === 'PUT') return next();
    // Penghapusan transaksi dan perubahan dana tetap membutuhkan admin.
    return forbid(res);
  }

  if (path.includes('/rekap')) {
    delete req.query.admin_view;
    return next();
  }

  if (path.includes('/auth')) return next();
  return forbid(res);
}

module.exports = authorizeRequest;
