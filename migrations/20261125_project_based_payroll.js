const db = require('../config/database');

async function migrate() {
  try {
    const [colsGaji] = await db.query('SHOW COLUMNS FROM gaji');
    const colNames = colsGaji.map(c => c.Field);
    
    if (!colNames.includes('id_pekerjaan')) {
      await db.query('ALTER TABLE gaji ADD COLUMN id_pekerjaan INT NULL AFTER id_karyawan');
      console.log('Added id_pekerjaan to gaji');
    }
    if (!colNames.includes('id_penugasan')) {
      await db.query('ALTER TABLE gaji ADD COLUMN id_penugasan INT NULL AFTER id_pekerjaan');
      console.log('Added id_penugasan to gaji');
    }
    if (!colNames.includes('jabatan')) {
      await db.query('ALTER TABLE gaji ADD COLUMN jabatan VARCHAR(100) NULL AFTER id_penugasan');
      console.log('Added jabatan to gaji');
    }
    if (!colNames.includes('jam_normal')) {
      await db.query('ALTER TABLE gaji ADD COLUMN jam_normal DECIMAL(6,2) DEFAULT 0.00 AFTER total_hari');
      console.log('Added jam_normal to gaji');
    }
    if (!colNames.includes('jam_lembur')) {
      await db.query('ALTER TABLE gaji ADD COLUMN jam_lembur DECIMAL(6,2) DEFAULT 0.00 AFTER jam_normal');
      console.log('Added jam_lembur to gaji');
    }
    if (!colNames.includes('upah_normal')) {
      await db.query('ALTER TABLE gaji ADD COLUMN upah_normal DECIMAL(14,2) DEFAULT 0.00 AFTER tarif');
      console.log('Added upah_normal to gaji');
    }
    if (!colNames.includes('upah_lembur')) {
      await db.query('ALTER TABLE gaji ADD COLUMN upah_lembur DECIMAL(14,2) DEFAULT 0.00 AFTER upah_normal');
      console.log('Added upah_lembur to gaji');
    }
    if (!colNames.includes('catatan_lembur')) {
      await db.query('ALTER TABLE gaji ADD COLUMN catatan_lembur VARCHAR(255) NULL AFTER catatan_penyesuaian');
      console.log('Added catatan_lembur to gaji');
    }

    // Populate existing gaji rows
    await db.query("UPDATE gaji SET id_pekerjaan = 18, jabatan = 'Teknisi Listrik', upah_normal = total_upah, jam_normal = total_jam WHERE id_gaji = 13 AND id_pekerjaan IS NULL");
    await db.query("UPDATE gaji SET id_pekerjaan = 17, jabatan = 'Helper biasa', upah_normal = total_upah, jam_normal = total_jam WHERE id_gaji = 14 AND id_pekerjaan IS NULL");

    // Penugasan columns
    const [colsPenugasan] = await db.query('SHOW COLUMNS FROM penugasan');
    const colPenNames = colsPenugasan.map(c => c.Field);
    if (!colPenNames.includes('jenis_upah')) {
      await db.query("ALTER TABLE penugasan ADD COLUMN jenis_upah ENUM('per_jam', 'per_hari', 'per_bulan', 'per_tahun', 'borongan') DEFAULT 'per_jam' AFTER peran_tugas");
      console.log('Added jenis_upah to penugasan');
    }
    if (!colPenNames.includes('nominal_upah')) {
      await db.query("ALTER TABLE penugasan ADD COLUMN nominal_upah DECIMAL(15,2) DEFAULT 0.00 AFTER jenis_upah");
      console.log('Added nominal_upah to penugasan');
    }

    // Sync penugasan rates from penugasan_gaji_riwayat latest
    await db.query(`
      UPDATE penugasan pn
      JOIN (
        SELECT r1.id_penugasan, r1.jenis_upah, r1.nominal_upah
        FROM penugasan_gaji_riwayat r1
        JOIN (
          SELECT id_penugasan, MAX(id_riwayat_gaji) as max_id
          FROM penugasan_gaji_riwayat
          GROUP BY id_penugasan
        ) r2 ON r1.id_riwayat_gaji = r2.max_id
      ) latest ON pn.id_penugasan = latest.id_penugasan
      SET pn.jenis_upah = latest.jenis_upah, pn.nominal_upah = latest.nominal_upah
      WHERE pn.nominal_upah = 0 OR pn.nominal_upah IS NULL
    `);
    console.log('Synced latest rates into penugasan');

    // Ensure an index on id_karyawan exists before dropping composite unique index
    const [idxKaryawan] = await db.query("SHOW INDEX FROM gaji WHERE Key_name = 'idx_gaji_karyawan'");
    if (idxKaryawan.length === 0) {
      await db.query("ALTER TABLE gaji ADD INDEX idx_gaji_karyawan (id_karyawan)");
      console.log('Added idx_gaji_karyawan');
    }

    // Update unique index on gaji
    const [indexes] = await db.query("SHOW INDEX FROM gaji WHERE Key_name = 'uq_gaji_karyawan_periode'");
    if (indexes.length > 0) {
      await db.query("ALTER TABLE gaji DROP INDEX uq_gaji_karyawan_periode");
      console.log('Dropped uq_gaji_karyawan_periode');
    }
    const [newIndexes] = await db.query("SHOW INDEX FROM gaji WHERE Key_name = 'uq_gaji_karyawan_pekerjaan_periode'");
    if (newIndexes.length === 0) {
      await db.query("ALTER TABLE gaji ADD UNIQUE KEY uq_gaji_karyawan_pekerjaan_periode (id_karyawan, id_pekerjaan, periode)");
      console.log('Added uq_gaji_karyawan_pekerjaan_periode');
    }

    console.log('MIGRATION COMPLETED SUCCESSFULLY!');
    process.exit(0);
  } catch (e) {
    console.error('Migration error:', e);
    process.exit(1);
  }
}

migrate();
