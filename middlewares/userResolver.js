const jwt = require('jsonwebtoken');
const db = require('../config/database');

/**
 * Middleware untuk mengekstrak identitas pengguna dari:
 * 1. Header Authorization (Bearer JWT atau Bearer <userId>)
 * 2. Header X-User-Id & X-User-Role dari React safeFetchJson
 * 3. Body atau Query id_karyawan / user_id
 */
async function userResolver(req, res, next) {
  try {
    const authHeader = req.headers['authorization'] || req.headers['x-user-id'];
    const roleHeader = req.headers['x-user-role'];
    let userId = null;

    if (authHeader) {
      if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        const tokenOrId = authHeader.substring(7).trim();
        if (/^\d+$/.test(tokenOrId)) {
          userId = parseInt(tokenOrId, 10);
        } else {
          try {
            const decoded = jwt.verify(tokenOrId, process.env.JWT_SECRET || 'rahasia_kunci_jwt_12345');
            req.user = decoded;
            return next();
          } catch (e) {
            // Token JWT mungkin kedaluwarsa atau dikirim ID biasa
          }
        }
      } else if (/^\d+$/.test(String(authHeader).trim())) {
        userId = parseInt(String(authHeader).trim(), 10);
      }
    }

    if (!userId && req.headers['x-user-id'] && /^\d+$/.test(String(req.headers['x-user-id']))) {
      userId = parseInt(req.headers['x-user-id'], 10);
    }

    // Fallback Admin jika terindikasi dari header peran atau ID 1
    if (roleHeader === 'admin' || userId === 1) {
      req.user = {
        id: 1,
        id_user: 1,
        id_karyawan: null,
        peran: 'admin',
        role: 'admin',
        nama: 'Administrator',
        email: 'admin@jamkerja.com'
      };
      return next();
    }

    // Query user dari database jika ada userId
    if (userId) {
      const [rows] = await db.query(`
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
          k.jenis_upah
        FROM user u
        LEFT JOIN karyawan k ON u.id_karyawan = k.id_karyawan
        WHERE u.id_user = ? OR k.id_karyawan = ?
        LIMIT 1
      `, [userId, userId]);

      if (rows.length > 0) {
        const row = rows[0];
        req.user = {
          id: row.id_karyawan || row.id_user,
          id_user: row.id_user,
          id_karyawan: row.id_karyawan,
          peran: row.peran || 'karyawan',
          role: row.peran || 'karyawan',
          kode_karyawan: row.kode_karyawan || row.username,
          nama: row.nama || row.username,
          email: row.email,
          jabatan: row.jabatan || 'Teknisi',
          jenis_upah: row.jenis_upah || 'per_jam',
          tarif_per_jam: Number(row.tarif_per_jam || row.nominal_upah) || 0,
          nominal_upah: Number(row.nominal_upah) || 0
        };
        return next();
      }
    }

    // Default jika tidak ada header
    next();
  } catch (err) {
    console.error('Error in userResolver middleware:', err);
    next();
  }
}

module.exports = userResolver;
