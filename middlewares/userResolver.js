const jwt = require('jsonwebtoken');
const db = require('../config/database');
const { getRolePermissionsMap } = require('../config/defaultRolePermissions');

const AUTH_COOKIE = 'pencatatan_auth';

function isPublicRequest(req) {
  if (req.path === '/api/health') return true;
  if (req.path.startsWith('/uploads/') || req.path.startsWith('/api/uploads/')) return true;
  if (req.path === '/api/auth/ping' || req.path === '/api/auth/ntp-time') return true;
  if (req.path === '/api/auth/login' && req.method === 'POST') return true;
  if (req.path === '/api/auth/register' && req.method === 'POST') return true;

  return false;
}

function readToken(req) {
  const authorization = String(req.headers.authorization || '');
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();

  const cookieHeader = String(req.headers.cookie || '');
  const cookie = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${AUTH_COOKIE}=`));
  return cookie ? decodeURIComponent(cookie.slice(AUTH_COOKIE.length + 1)) : '';
}

async function userResolver(req, res, next) {
  if (isPublicRequest(req)) return next();

  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    return res.status(503).json({ success: false, message: 'Konfigurasi autentikasi backend belum lengkap.' });
  }

  const token = readToken(req);
  if (!token) return res.status(401).json({ success: false, message: 'Silakan login untuk melanjutkan.' });

  try {
    const claims = jwt.verify(token, secret);
    const userId = Number(claims.id_user || claims.sub);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({ success: false, message: 'Sesi login tidak valid.' });
    }

    const [rows] = await db.query(`
      SELECT u.id_user, u.id_karyawan, u.email, u.username, u.peran, u.aktif,
             k.kode_karyawan, k.nama, k.jabatan, k.tarif_per_jam, k.nominal_upah,
             k.jenis_upah, k.status AS status_karyawan
      FROM user u
      LEFT JOIN karyawan k ON k.id_karyawan = u.id_karyawan
      WHERE u.id_user = ? AND u.aktif = 1
      LIMIT 1
    `, [userId]);

    const account = rows[0];
    if (!account || (account.peran === 'karyawan' && account.status_karyawan && account.status_karyawan !== 'aktif')) {
      return res.status(401).json({ success: false, message: 'Akun tidak aktif atau sesi sudah berakhir.' });
    }

    const permissions = await getRolePermissionsMap(account.peran, db);

    req.user = {
      id: account.id_karyawan || account.id_user,
      id_user: Number(account.id_user),
      id_karyawan: account.id_karyawan ? Number(account.id_karyawan) : null,
      peran: account.peran,
      role: account.peran,
      username: account.username || '',
      kode_karyawan: account.kode_karyawan || '',
      nama: account.nama || account.username || account.email,
      email: account.email,
      jabatan: account.jabatan || '',
      tarif_per_jam: Number(account.tarif_per_jam || account.nominal_upah) || 0,
      nominal_upah: Number(account.nominal_upah) || 0,
      jenis_upah: account.jenis_upah || 'per_jam',
      permissions,
    };

    return next();
  } catch (error) {
    if (error.name === 'TokenExpiredError' || error.name === 'JsonWebTokenError') {
      return res.status(401).json({ success: false, message: 'Sesi login tidak valid atau sudah berakhir.' });
    }
    console.error('Gagal memvalidasi sesi:', error);
    return res.status(500).json({ success: false, message: 'Gagal memvalidasi akun.' });
  }
}

module.exports = { userResolver, AUTH_COOKIE };
