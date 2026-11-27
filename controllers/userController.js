const db = require('../config/database');
const bcrypt = require('bcryptjs');

async function resetKaryawanPassword(req, res) {
  const idKaryawan = Number(req.params.id);
  const password = String(req.body?.kata_sandi || '');
  const confirmation = String(req.body?.konfirmasi_kata_sandi || '');
  if (!Number.isInteger(idKaryawan) || idKaryawan <= 0 || password.length < 6 || (confirmation && password !== confirmation)) {
    return res.status(400).json({ success: false, message: 'Masukkan kata sandi minimal 6 karakter dan pastikan konfirmasinya sama.' });
  }
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [users] = await connection.query('SELECT id_user FROM `user` WHERE id_karyawan = ? LIMIT 1', [idKaryawan]);
    if (!users.length) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Akun login karyawan belum tersedia.' });
    }
    const hash = await bcrypt.hash(password, 12);
    await connection.query('UPDATE `user` SET kata_sandi = ? WHERE id_user = ?', [hash, users[0].id_user]);
    await connection.commit();
    return res.json({ success: true, message: 'Kata sandi karyawan berhasil direset.' });
  } catch (error) {
    await connection.rollback();
    console.error('Error resetKaryawanPassword:', error);
    return res.status(500).json({ success: false, message: 'Gagal mereset kata sandi karyawan.' });
  } finally {
    connection.release();
  }
}

async function getAllUsers(req, res) {
  try {
    // Sinkronisasi otomatis: pastikan setiap karyawan aktif memiliki akun user login di Manajemen Pengguna
    const [missingEmployees] = await db.query(`
      SELECT k.id_karyawan, k.kode_karyawan, k.nama, k.email, k.status
      FROM karyawan k
      LEFT JOIN user u ON k.id_karyawan = u.id_karyawan
      WHERE u.id_user IS NULL
    `);

    if (missingEmployees.length > 0) {
      const defaultHash = '$2y$10$EkjiRpVsUqi02mqFUNwpPOJygzdSgCEBz1xafYErfOtox5K3tZABy'; // Default bcrypt hash untuk password 'karyawan123'
      for (const me of missingEmployees) {
        const userEmail = me.email || `${(me.kode_karyawan || 'usr' + me.id_karyawan).toLowerCase()}@jamkerja.com`;
        const isAktif = me.status === 'nonaktif' ? 0 : 1;
        await db.query(
          `INSERT INTO user (kode_user, id_karyawan, username, email, kata_sandi, peran, aktif)
           VALUES (?, ?, ?, ?, ?, 'karyawan', ?)`,
          [me.kode_karyawan, me.id_karyawan, me.kode_karyawan, userEmail, defaultHash, isAktif]
        );
      }
    }

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
      ORDER BY u.id_user DESC
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

async function createUser(req, res) {
  if (req.user?.peran !== 'super_admin') {
    return res.status(403).json({ success: false, message: 'Hanya super admin yang dapat menambahkan pengguna baru.' });
  }

  const username = String(req.body?.username || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.kata_sandi || req.body?.password || '');
  const peran = String(req.body?.peran || '').trim().toLowerCase();
  const aktif = req.body?.aktif === 0 || req.body?.aktif === false || req.body?.aktif === '0' ? 0 : 1;

  if (!username || !email || password.length < 6 || !peran) {
    return res.status(400).json({
      success: false,
      message: 'Username, email, password (minimal 6 karakter), dan peran wajib diisi.',
    });
  }
  if (peran === 'super_admin') {
    return res.status(400).json({ success: false, message: 'Tidak dapat membuat akun super_admin dari form ini.' });
  }

  try {
    const [roleRows] = await db.query(
      'SELECT role_name FROM custom_roles WHERE role_name = ? LIMIT 1',
      [peran],
    );
    if (roleRows.length === 0 && !['admin', 'karyawan'].includes(peran)) {
      return res.status(400).json({ success: false, message: `Role "${peran}" tidak terdaftar di Pengaturan Hak Akses.` });
    }

    const [dups] = await db.query(
      'SELECT id_user FROM `user` WHERE LOWER(email) = ? OR LOWER(username) = ? LIMIT 1',
      [email, username.toLowerCase()],
    );
    if (dups.length > 0) {
      return res.status(409).json({ success: false, message: 'Email atau username sudah terdaftar.' });
    }

    const hash = await bcrypt.hash(password, 12);
    const prefix = peran === 'admin' ? 'ADM' : peran === 'karyawan' ? 'USR' : 'ROLE';
    const kodeUser = `${prefix}${Date.now().toString().slice(-5)}`;

    const [insertRes] = await db.query(
      `INSERT INTO \`user\` (kode_user, id_karyawan, username, email, kata_sandi, peran, aktif)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
      [kodeUser, username, email, hash, peran, aktif],
    );

    const [createdRows] = await db.query(
      'SELECT id_user, kode_user, id_karyawan, username, email, peran, aktif, created_at FROM `user` WHERE id_user = ? LIMIT 1',
      [insertRes.insertId],
    );

    return res.status(201).json({
      success: true,
      message: 'Pengguna baru berhasil ditambahkan.',
      data: createdRows[0],
    });
  } catch (error) {
    console.error('Error createUser:', error);
    return res.status(500).json({ success: false, message: 'Gagal menambahkan pengguna baru.' });
  }
}

async function updateUserRole(req, res) {
  if (req.user?.peran !== 'super_admin') {
    return res.status(403).json({ success: false, message: 'Hanya super admin yang dapat mengubah peran pengguna.' });
  }

  const id = Number(req.params.id);
  const nextRole = String(req.body?.peran || '').trim().toLowerCase();
  if (!Number.isInteger(id) || id <= 0 || !nextRole) {
    return res.status(400).json({ success: false, message: 'ID pengguna dan peran baru wajib diisi.' });
  }
  if (nextRole === 'super_admin') {
    return res.status(400).json({ success: false, message: 'Tidak dapat menetapkan peran super_admin.' });
  }

  try {
    const [targetRows] = await db.query('SELECT id_user, peran FROM `user` WHERE id_user = ? LIMIT 1', [id]);
    if (targetRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Pengguna tidak ditemukan.' });
    }
    if (targetRows[0].peran === 'super_admin') {
      return res.status(400).json({ success: false, message: 'Peran akun super_admin tidak dapat diubah.' });
    }

    const [roleRows] = await db.query('SELECT role_name FROM custom_roles WHERE role_name = ? LIMIT 1', [nextRole]);
    if (roleRows.length === 0 && !['admin', 'karyawan'].includes(nextRole)) {
      return res.status(400).json({ success: false, message: `Role "${nextRole}" tidak terdaftar.` });
    }

    await db.query('UPDATE `user` SET peran = ? WHERE id_user = ?', [nextRole, id]);
    const [fresh] = await db.query(
      `SELECT u.id_user, u.kode_user, u.id_karyawan, u.username, u.email, u.peran, u.aktif, u.created_at,
              k.nama, k.jabatan, k.kode_karyawan, k.nomor_hp, k.status AS status_karyawan
       FROM \`user\` u LEFT JOIN karyawan k ON u.id_karyawan = k.id_karyawan
       WHERE u.id_user = ? LIMIT 1`,
      [id],
    );
    return res.json({ success: true, message: 'Peran pengguna berhasil diperbarui.', data: fresh[0] });
  } catch (error) {
    console.error('Error updateUserRole:', error);
    return res.status(500).json({ success: false, message: 'Gagal mengubah peran pengguna.' });
  }
}

module.exports = {
  resetKaryawanPassword,
  getAllUsers,
  getUserById,
  createUser,
  updateUserRole,
  resetPassword,
  toggleStatus
};
