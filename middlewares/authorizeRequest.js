const { isAdminRole, isBuiltInAdminRole } = require('../utils/roles');
const { grants } = require('../config/defaultRolePermissions');
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
  if (path === '/api/users' || path.startsWith('/api/users/') || path.startsWith('/api/users.php')) return 'users';
  if (path === '/api/karyawan' || path.startsWith('/api/karyawan/') || path.startsWith('/api/karyawan.php') ||
      path === '/api/pekerja' || path.startsWith('/api/pekerja/') || path.startsWith('/api/pekerja.php')) return 'karyawan';
  if (path === '/api/pekerjaan' || path.startsWith('/api/pekerjaan/') || path.startsWith('/api/pekerjaan.php')) return 'pekerjaan';
  if (path === '/api/penugasan' || path.startsWith('/api/penugasan/') || path.startsWith('/api/penugasan.php')) return 'penugasan';
  if (path === '/api/absensi' || path.startsWith('/api/absensi/') || path.startsWith('/api/absensi.php')) return 'absensi';
  if (path === '/api/pengeluaran' || path.startsWith('/api/pengeluaran/') || path.startsWith('/api/pengeluaran.php')) return 'pengeluaran';
  if (path === '/api/gaji' || path.startsWith('/api/gaji/') || path.startsWith('/api/gaji.php')) return 'gaji';
  if (path === '/api/rekap' || path.startsWith('/api/rekap/') || path.startsWith('/api/rekap.php')) return 'rekap';
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
  // Gunakan izin bawaan jika role/resource belum memiliki baris konfigurasi.
  // Ini menjaga akun karyawan yang sudah ada tetap dapat absen sebelum
  // konfigurasi role_permissions disinkronkan.
  if (rows.length === 0) {
    const actionIndex = { can_create: 0, can_read: 1, can_update: 2, can_delete: 3 }[action];
    return actionIndex !== undefined && Number(grants[role]?.[resource]?.[actionIndex] || 0) === 1;
  }
  return Number(rows[0].allowed) === 1;
}

async function authorizeRequest(req, res, next) {
  if (req.path === '/api/health' || req.path.startsWith('/uploads/') || req.path.startsWith('/api/uploads/')) return next();
  if (req.path === '/api/auth/ping' || req.path === '/api/auth/ntp-time' || req.path === '/api/auth.php') return next();
  if (req.path === '/api/auth/login' && req.method === 'POST') return next();
  if (req.path === '/api/auth/register' && req.method === 'POST') return next();
  
  const user = req.user;
  if (!user) return res.status(401).json({ success: false, message: 'Silakan login untuk melanjutkan.' });

  const path = req.path.toLowerCase();
  const method = req.method.toUpperCase();
  const action = String(req.query?.action || req.body?.action || '').toLowerCase();
  const userRole = String(user.peran || user.role || '').toLowerCase();
  
  // Super Admin dan Admin memiliki hak akses penuh ke seluruh sistem
  if (userRole === 'super_admin' || userRole === 'superadmin') return next();
  if (isAdminRole(userRole)) return next();

  if (path === '/api/role-permissions/mine' && method === 'GET') return next();
  if (path === '/api/role-permissions' || path.startsWith('/api/role-permissions/')) return forbid(res);

  // Akses Master Role diperbolehkan untuk Admin & Super Admin bawaan
  if (path === '/api/master-role' || path.startsWith('/api/master-role/') || path === '/api/master_role' || path.startsWith('/api/master_role/')) {
    if (isAdminRole(userRole)) return next();
    return forbid(res);
  }

  const resource = getResource(path);
  const permissionAction = resource ? getPermissionAction(method, path, action) : null;
  if (!['admin', 'karyawan'].includes(userRole)) return forbid(res);
  if (!String(user.peran || '').trim()) return forbid(res);
  // Pencatatan absensi adalah alur inti karyawan. Nilai can_create/can_update
  // yang tersimpan dari konfigurasi lama tidak boleh memblokir absen masuk/pulang.
  // Di bawah, ID karyawan pada request tetap ditimpa dengan ID dari sesi login.
  const isWorkerAttendanceWrite = user.peran === 'karyawan' && resource === 'absensi' && (
    (method === 'POST' && ['masuk', 'pulang'].includes(action)) ||
    ((method === 'POST' || method === 'PUT') && /\/(masuk|pulang)\/?$/.test(path))
  );
  // Karyawan harus dapat membaca data transaksinya sendiri. Endpoint di bawah
  // akan memaksa id_karyawan dari sesi server sebelum query dijalankan.
  // Izin role_permissions yang belum disinkronkan (atau bernilai 0 dari versi
  // lama) tidak boleh memblokir riwayat milik sendiri.
  const isScopedWorkerRead = user.peran === 'karyawan' && method === 'GET' &&
    ['absensi', 'pengeluaran'].includes(resource) &&
    !(resource === 'pengeluaran' && isAdminOnlyExpenseAction(action));
  if (resource && (!permissionAction || (!isScopedWorkerRead && !isWorkerAttendanceWrite && !(await hasPermission(user.peran, resource, permissionAction))))) {
    return forbid(res);
  }

  const workerId = Number(user.id_karyawan);

  if (!workerId) return forbid(res);

  const isOwnProfile =
    method === 'GET' &&
    (path === '/api/karyawan/me' ||
     path === '/api/pekerja/me' ||
     path === `/api/karyawan/${workerId}` ||
     path === `/api/pekerja/${workerId}` ||
     ((path === '/api/karyawan.php' || path === '/api/pekerja.php') &&
      (!req.query.id_karyawan || req.query.id_karyawan === 'me' || req.query.action === 'me' || String(req.query.id_karyawan) === String(workerId))));

  if (isOwnProfile) {
    req.query.id_karyawan = String(workerId);
    return next();
  }

  // Semua query karyawan dipaksa ke identitas sesi server, tidak menerima ID kiriman browser.
  req.query = { ...req.query };
  req.query.id_karyawan = String(workerId);
  if (req.body && typeof req.body === 'object') req.body.id_karyawan = workerId;

  if (/(^|\/)(users?|karyawan|pekerja)(\/|$|\.php)/.test(path)) return forbid(res);

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
    // Verifikasi absensi hanya diperbolehkan untuk Admin & Super Admin.
    const isVerifikasi = action === 'verifikasi' || path.includes('/verifikasi') ||
      Boolean(req.body && (req.body.status_verifikasi || req.body.status));
    if (isVerifikasi) return forbid(res);
    return next();
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
