const jwt = require('jsonwebtoken');
const db = require('../config/database');
const { getRolePermissionsMap } = require('../config/defaultRolePermissions');

const AUTH_COOKIE = 'pencatatan_auth';

function isPublicRequest(req) {
  if (req.path === '/api/health') return true;
  if (req.path.startsWith('/uploads/') || req.path.startsWith('/api/uploads/')) return true;
  if (req.path === '/api/auth/ping' || req.path === '/api/auth/ntp-time' || req.path === '/api/auth.php') return true;
  if (req.path === '/api/auth/login' && req.method === 'POST') return true;
  if (req.path === '/api/auth/register' && req.method === 'POST') return true;
  return false;
}

function readCookieToken(req) {
  const cookieHeader = String(req.headers.cookie || '');
  const cookie = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${AUTH_COOKIE}=`));
  return cookie ? decodeURIComponent(cookie.slice(AUTH_COOKIE.length + 1)) : '';
}

/**
 * Middleware untuk mengekstrak identitas pengguna dari:
 * 1. Cookie pencatatan_auth
 * 2. Header Authorization (Bearer JWT atau Bearer <userId>)
 * 3. Header X-User-Id & X-User-Role dari React safeFetchJson
 */
async function userResolver(req, res, next) {
  try {
    const authHeader = req.headers['authorization'] || req.headers['x-user-id'];
    const roleHeader = req.headers['x-user-role'];
    const cookieToken = readCookieToken(req);

    let rawToken = null;
    let userId = null;

    if (authHeader) {
      if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        const tokenOrId = authHeader.substring(7).trim();
        if (/^\d+$/.test(tokenOrId)) {
          userId = parseInt(tokenOrId, 10);
        } else {
          rawToken = tokenOrId;
        }
      } else if (/^\d+$/.test(String(authHeader).trim())) {
        userId = parseInt(String(authHeader).trim(), 10);
      }
    }

    if (!rawToken && cookieToken) {
      rawToken = cookieToken;
    }

    // Coba decode JWT jika ada token string
    if (rawToken) {
      try {
        const secret = process.env.JWT_SECRET || 'rahasia_kunci_jwt_12345_pencatatan_kerja_super_aman_2026';
        const decoded = jwt.verify(rawToken, secret);
        const parsedId = Number(decoded.id_user || decoded.sub || decoded.id);
        if (Number.isInteger(parsedId) && parsedId > 0) {
          userId = parsedId;
        } else if (decoded && decoded.role) {
          // Token legacy tanpa id numerik
          const perms = await getRolePermissionsMap(decoded.peran || decoded.role || 'karyawan', db);
          req.user = { ...decoded, permissions: perms };
          return next();
        }
      } catch (jwtErr) {
        // Token JWT tidak valid atau kedaluwarsa, lanjut ke fallback jika ada header ID
      }
    }

    if (!userId && req.headers['x-user-id'] && /^\d+$/.test(String(req.headers['x-user-id']))) {
      userId = parseInt(req.headers['x-user-id'], 10);
    }

    // Fallback Admin & Super Admin jika terindikasi dari header peran atau ID
    if (roleHeader === 'super_admin' || roleHeader === 'superadmin' || userId === 22) {
      const perms = await getRolePermissionsMap('super_admin', db);
      req.user = {
        id: userId || 22,
        id_user: userId || 22,
        id_karyawan: null,
        peran: 'super_admin',
        role: 'super_admin',
        nama: 'Super Admin',
        email: 'superadmin@gmail.com',
        permissions: perms
      };
      return next();
    }

    if (roleHeader === 'admin' || userId === 1) {
      const perms = await getRolePermissionsMap('admin', db);
      req.user = {
        id: 1,
        id_user: 1,
        id_karyawan: null,
        peran: 'admin',
        role: 'admin',
        nama: 'Administrator',
        email: 'admin@jamkerja.com',
        permissions: perms
      };
      return next();
    }

    // Query user dari database jika ada userId
    if (userId) {
      // Prioritas 1: cari berdasarkan id_user (ID akun pengguna login)
      let [rows] = await db.query(`
        SELECT 
          u.id_user,
          u.username,
          u.email,
          u.peran,
          u.aktif,
          k.id_karyawan,
          k.kode_karyawan,
          k.nama,
          k.jabatan,
          k.nominal_upah,
          k.tarif_per_jam,
          k.jenis_upah,
          k.status AS status_karyawan
        FROM \`user\` u
        LEFT JOIN karyawan k ON u.id_karyawan = k.id_karyawan
        WHERE u.id_user = ?
        LIMIT 1
      `, [userId]);

      // Prioritas 2: jika tidak cocok dengan id_user, cari berdasarkan id_karyawan (pencegah bentrok akun)
      if (rows.length === 0) {
        [rows] = await db.query(`
          SELECT 
            u.id_user,
            u.username,
            u.email,
            u.peran,
            u.aktif,
            k.id_karyawan,
            k.kode_karyawan,
            k.nama,
            k.jabatan,
            k.nominal_upah,
            k.tarif_per_jam,
            k.jenis_upah,
            k.status AS status_karyawan
          FROM karyawan k
          LEFT JOIN \`user\` u ON k.id_karyawan = u.id_karyawan
          WHERE k.id_karyawan = ?
          LIMIT 1
        `, [userId]);
      }

      if (rows.length > 0) {
        const row = rows[0];
        const role = row.peran || 'karyawan';
        const permissions = await getRolePermissionsMap(role, db);

        req.user = {
          id: row.id_karyawan || row.id_user,
          id_user: row.id_user,
          id_karyawan: row.id_karyawan,
          peran: role,
          role: role,
          kode_karyawan: row.kode_karyawan || row.username,
          nama: row.nama || row.username,
          email: row.email,
          jabatan: row.jabatan || 'Teknisi',
          jenis_upah: row.jenis_upah || 'per_jam',
          tarif_per_jam: Number(row.tarif_per_jam || row.nominal_upah) || 0,
          nominal_upah: Number(row.nominal_upah) || 0,
          permissions
        };
        return next();
      }
    }

    // Default jika tidak ada user ditemukan
    return next();
  } catch (err) {
    console.error('Error in userResolver middleware:', err);
    return next();
  }
}

module.exports = userResolver;
module.exports.userResolver = userResolver;
module.exports.AUTH_COOKIE = AUTH_COOKIE;
