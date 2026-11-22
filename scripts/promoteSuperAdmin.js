const db = require('../config/database');

async function main() {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Gunakan: npm run admin:promote-super -- email-admin@perusahaan.com');
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      "SELECT id_user, email, username, peran FROM `user` WHERE LOWER(email) = ? LIMIT 1 FOR UPDATE",
      [email],
    );
    const account = rows[0];
    if (!account) throw new Error('Akun dengan email tersebut tidak ditemukan.');
    if (!['admin', 'super_admin'].includes(account.peran)) {
      throw new Error('Hanya akun admin yang dapat ditingkatkan menjadi super admin.');
    }

    if (account.peran !== 'super_admin') {
      await connection.query("UPDATE `user` SET peran = 'super_admin' WHERE id_user = ?", [account.id_user]);
    }
    await connection.commit();
    console.log(`${account.email} sekarang memiliki role super_admin. Kata sandi akun tidak diubah.`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

main()
  .catch((error) => {
    console.error('Gagal mengatur super admin:', error.code || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
