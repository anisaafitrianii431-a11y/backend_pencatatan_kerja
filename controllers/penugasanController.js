const db = require('../config/database');
const {
  normalizeToMonthly,
  convertMonthlyRangeToAllUnits,
  calculateEffectiveWorkingDays,
  calculateIndividualCommitment
} = require('../utils/projectSalaryHelper');

const sqlDurasi = `
  CASE 
    WHEN a.jam_pulang IS NOT NULL AND a.jam_pulang >= a.jam_masuk 
      THEN ROUND(TIME_TO_SEC(TIMEDIFF(a.jam_pulang, a.jam_masuk)) / 3600, 2)
    WHEN a.jam_pulang IS NOT NULL AND a.jam_pulang < a.jam_masuk 
      THEN ROUND((TIME_TO_SEC(TIMEDIFF(a.jam_pulang, a.jam_masuk)) + 86400) / 3600, 2)
    ELSE 0 
  END
`;

// 1. Ambil Penugasan / Notifikasi Karyawan
async function getAllPenugasan(req, res) {
  try {
    const action = req.query.action || req.body?.action;
    const kId = req.user?.id_karyawan || (req.query.id_karyawan ? parseInt(req.query.id_karyawan, 10) : null);

    // Fitur Notifikasi Penugasan
    if (action === 'notifikasi') {
      const [list] = await db.query(`
        SELECT pn.id_penugasan, pn.id_pekerjaan, pn.peran_tugas, pn.jenis_penugasan, pn.status_baca, pn.created_at,
               p.kode_pekerjaan, p.nama_pekerjaan, p.deskripsi, p.lokasi, p.titik_lokasi, p.metode_lokasi, p.latitude, p.longitude, p.radius_meter,
               p.tanggal_mulai, p.target_selesai, p.status AS status_pekerjaan
        FROM penugasan pn
        JOIN pekerjaan p ON pn.id_pekerjaan = p.id_pekerjaan
        WHERE pn.id_karyawan = ?
        ORDER BY pn.id_penugasan DESC
      `, [kId || 0]);

      let unreadCount = 0;
      for (const item of list) {
        if (item.status_baca === 'belum') unreadCount++;
      }

      return res.json({
        success: true,
        message: 'Daftar notifikasi penugasan karyawan berhasil dimuat',
        data: {
          total: list.length,
          unread_count: unreadCount,
          notifikasi: list
        }
      });
    }

    const id_penugasan = req.params?.id || req.query?.id_penugasan || req.query?.id;
    const { id_pekerjaan, id_karyawan } = req.query;

    // Jika karyawan melihat rekan kerja pada satu pekerjaan
    if (req.user?.peran === 'karyawan' && id_pekerjaan) {
      const [totalRow] = await db.query(`
        SELECT COALESCE(SUM(${sqlDurasi}), 0) AS total_jam
        FROM absensi a
        WHERE a.id_pekerjaan = ? AND a.status_verifikasi = 'disetujui' AND a.jam_pulang IS NOT NULL
      `, [id_pekerjaan]);
      const totalJamProyek = Number(totalRow[0]?.total_jam || 0);

      const [workers] = await db.query(`
        SELECT pn.id_penugasan, pn.id_pekerjaan, pn.id_karyawan, pn.peran_tugas,
               k.nama, k.jabatan,
               COALESCE(SUM(${sqlDurasi}), 0) AS total_jam_pekerja
        FROM penugasan pn
        JOIN karyawan k ON pn.id_karyawan = k.id_karyawan
        LEFT JOIN absensi a ON a.id_pekerjaan = pn.id_pekerjaan 
                           AND a.id_karyawan = pn.id_karyawan 
                           AND a.status_verifikasi = 'disetujui'
                           AND a.jam_pulang IS NOT NULL
        WHERE pn.id_pekerjaan = ?
        GROUP BY pn.id_penugasan, pn.id_pekerjaan, pn.id_karyawan, pn.peran_tugas, k.nama, k.jabatan
        ORDER BY pn.id_penugasan DESC
      `, [id_pekerjaan]);

      const formattedWorkers = workers.map(p => {
        const jamP = Number(p.total_jam_pekerja || 0);
        return {
          ...p,
          total_jam_pekerja: jamP,
          persentase_kontribusi: totalJamProyek > 0 ? Number(((jamP / totalJamProyek) * 100).toFixed(1)) : 0,
          is_saya: Number(p.id_karyawan) === Number(kId)
        };
      });

      return res.json({
        success: true,
        message: 'Daftar rekan kerja pada pekerjaan berhasil dimuat',
        data: {
          total_jam_proyek: totalJamProyek,
          pekerja: formattedWorkers
        }
      });
    }

    // Tampilan Standar / Admin
    let query = `
      SELECT pn.*,
        p.kode_pekerjaan, p.nama_pekerjaan, p.deskripsi, p.lokasi, p.titik_lokasi, p.metode_lokasi, p.latitude, p.longitude, p.radius_meter,
        p.tanggal_mulai, p.target_selesai, p.status AS status_pekerjaan, p.jenis_upah, p.nominal_upah,
        p.hari_kerja_per_bulan, p.jam_kerja_per_hari,
        k.nama AS nama_karyawan, k.kode_karyawan, k.jabatan
      FROM penugasan pn
      LEFT JOIN pekerjaan p ON pn.id_pekerjaan = p.id_pekerjaan
      LEFT JOIN karyawan k ON pn.id_karyawan = k.id_karyawan
      WHERE 1=1
    `;
    const params = [];
    if (id_penugasan) {
      query += ` AND pn.id_penugasan = ? `;
      params.push(id_penugasan);
    }
    if (id_pekerjaan) {
      query += ` AND pn.id_pekerjaan = ? `;
      params.push(id_pekerjaan);
    }
    if (id_karyawan) {
      query += ` AND pn.id_karyawan = ? `;
      params.push(id_karyawan);
    }
    query += ` ORDER BY pn.id_penugasan DESC `;

    const [rows] = await db.query(query, params);
    if (id_penugasan) {
      if (rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Data penugasan tidak ditemukan',
          data: null
        });
      }
      return res.json({
        success: true,
        message: 'Detail penugasan berhasil dimuat',
        data: rows[0]
      });
    }

    return res.json({
      success: true,
      message: 'Data penugasan berhasil dimuat',
      data: rows
    });
  } catch (err) {
    console.error('Error getAllPenugasan:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// 2. Cek Ketersediaan Karyawan (Overlap Checker)
// GET /api/penugasan/cek-ketersediaan?id_karyawan=X&tanggal_mulai=Y&tanggal_selesai=Z&exclude_pekerjaan=W
async function cekKetersediaanKaryawan(req, res) {
  try {
    const id_karyawan = req.query.id_karyawan || req.body?.id_karyawan;
    const tanggal_mulai = req.query.tanggal_mulai || req.body?.tanggal_mulai;
    const tanggal_selesai = req.query.tanggal_selesai || req.body?.tanggal_selesai;
    const exclude_pekerjaan = req.query.exclude_pekerjaan || req.body?.exclude_pekerjaan || null;

    if (!id_karyawan) {
      return res.status(400).json({ success: false, message: 'ID Karyawan wajib disertakan' });
    }

    let query = `
      SELECT p.id_pekerjaan, p.kode_pekerjaan, p.nama_pekerjaan, p.status,
             COALESCE(pn.tanggal_penugasan, p.tanggal_mulai) AS tanggal_mulai,
             COALESCE(pn.tanggal_selesai_tugas, p.target_selesai) AS tanggal_selesai
      FROM penugasan pn
      JOIN pekerjaan p ON pn.id_pekerjaan = p.id_pekerjaan
      WHERE pn.id_karyawan = ?
        AND (pn.status_penugasan IS NULL OR pn.status_penugasan = 'aktif')
        AND p.status <> 'selesai'
    `;
    const params = [id_karyawan];

    if (exclude_pekerjaan) {
      query += ` AND p.id_pekerjaan <> ? `;
      params.push(exclude_pekerjaan);
    }

    // Irisan: start_existing <= tanggal_selesai_baru AND end_existing >= tanggal_mulai_baru
    if (tanggal_selesai) {
      query += ` AND COALESCE(pn.tanggal_penugasan, p.tanggal_mulai) <= ? `;
      params.push(tanggal_selesai);
    }
    if (tanggal_mulai) {
      query += ` AND COALESCE(pn.tanggal_selesai_tugas, p.target_selesai) >= ? `;
      params.push(tanggal_mulai);
    }

    query += ` ORDER BY p.id_pekerjaan DESC `;

    const [rows] = await db.query(query, params);
    const isAvailable = rows.length === 0;

    return res.json({
      success: true,
      available: isAvailable,
      konflik: rows
    });
  } catch (err) {
    console.error('Error cekKetersediaanKaryawan:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// 3. Tambah Penugasan / Tandai Baca Notifikasi (Mendukung Slot Role & Multi-Satuan)
// POST /api/penugasan
async function createPenugasan(req, res) {
  let connection;
  try {
    const action = req.query.action || req.body?.action;
    const kId = req.user?.id_karyawan || (req.body.id_karyawan ? parseInt(req.body.id_karyawan, 10) : null);

    // Tandai Baca Notifikasi
    if (action === 'baca' || action === 'mark_read') {
      const id_penugasan = parseInt(req.body.id_penugasan || req.query.id_penugasan || 0, 10);
      if (id_penugasan > 0) {
        await db.query("UPDATE penugasan SET status_baca = 'sudah' WHERE id_penugasan = ?", [id_penugasan]);
        return res.json({ success: true, message: `Notifikasi penugasan #${id_penugasan} telah dibaca` });
      } else if (kId) {
        await db.query("UPDATE penugasan SET status_baca = 'sudah' WHERE id_karyawan = ?", [kId]);
        return res.json({ success: true, message: 'Semua notifikasi penugasan telah dibaca' });
      }
      return res.json({ success: true });
    }

    const {
      id_pekerjaan,
      id_karyawan,
      id_role_budget,
      jenis_upah,
      nominal_upah,
      tanggal_penugasan,
      tanggal_selesai_tugas,
      catatan_gaji,
      izinkan_bentrok = false,
      peran_tugas = 'Anggota Tim Pelaksana',
      jenis_penugasan = 'admin'
    } = req.body;

    if (!id_pekerjaan || !id_karyawan) {
      return res.status(400).json({ success: false, message: 'ID Pekerjaan dan ID Karyawan wajib diisi' });
    }

    // Ambil info proyek
    const [jobRows] = await db.query('SELECT * FROM pekerjaan WHERE id_pekerjaan = ?', [id_pekerjaan]);
    if (jobRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data proyek tidak ditemukan' });
    }
    const job = jobRows[0];
    if (job.status === 'selesai') {
      return res.status(400).json({ success: false, message: 'Tidak dapat menugaskan karyawan ke proyek yang sudah berstatus selesai.' });
    }

    // Tentukan tanggal efektif penugasan
    const startEff = tanggal_penugasan || job.tanggal_mulai;
    const endEff = tanggal_selesai_tugas || job.target_selesai;

    // 1. Validasi Bentrok Jadwal terhadap proyek aktif lain
    if (startEff && endEff) {
      const [conflictRows] = await db.query(`
        SELECT p.id_pekerjaan, p.kode_pekerjaan, p.nama_pekerjaan, p.status,
               COALESCE(pn.tanggal_penugasan, p.tanggal_mulai) AS tanggal_mulai,
               COALESCE(pn.tanggal_selesai_tugas, p.target_selesai) AS tanggal_selesai
        FROM penugasan pn
        JOIN pekerjaan p ON pn.id_pekerjaan = p.id_pekerjaan
        WHERE pn.id_karyawan = ?
          AND (pn.status_penugasan IS NULL OR pn.status_penugasan = 'aktif')
          AND p.status <> 'selesai'
          AND p.id_pekerjaan <> ?
          AND COALESCE(pn.tanggal_penugasan, p.tanggal_mulai) <= ?
          AND COALESCE(pn.tanggal_selesai_tugas, p.target_selesai) >= ?
      `, [id_karyawan, id_pekerjaan, endEff, startEff]);

      if (conflictRows.length > 0 && izinkan_bentrok !== true && izinkan_bentrok !== 'true') {
        const conflictNames = conflictRows.map(c => c.nama_pekerjaan).join(', ');
        return res.status(409).json({
          success: false,
          message: `Karyawan memiliki penugasan aktif di proyek lain (${conflictNames}) pada rentang tanggal yang bentrok.`,
          konflik: conflictRows
        });
      }
    }

    // 2. Jika id_role_budget disertakan (Alur Blueprint Baru)
    if (id_role_budget) {
      const [roleBudgetRows] = await db.query(`
        SELECT prb.*, mr.nama_role, mr.hierarchy_level
        FROM pekerjaan_role_budget prb
        JOIN master_role mr ON prb.id_role = mr.id_role
        WHERE prb.id_role_budget = ? AND prb.id_pekerjaan = ?
      `, [id_role_budget, id_pekerjaan]);

      if (roleBudgetRows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Role budget tidak ditemukan atau tidak sesuai dengan proyek ini.'
        });
      }

      const prb = roleBudgetRows[0];

      // Cek Kuota Slot (Auto-Lock)
      const [countRows] = await db.query(`
        SELECT COUNT(*) AS total
        FROM penugasan
        WHERE id_role_budget = ? AND (status_penugasan IS NULL OR status_penugasan = 'aktif')
      `, [id_role_budget]);

      const terisiSlot = Number(countRows[0]?.total || 0);
      if (terisiSlot >= Number(prb.kuota_slot)) {
        return res.status(400).json({
          success: false,
          message: `Kuota slot untuk role "${prb.nama_role}" sudah penuh (${terisiSlot}/${prb.kuota_slot}).`
        });
      }

      // Validasi Gaji & Normalisasi
      const allowedUnits = ['per_jam', 'per_hari', 'per_bulan', 'per_tahun'];
      if (!allowedUnits.includes(jenis_upah) || isNaN(Number(nominal_upah)) || Number(nominal_upah) <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Nominal upah harus lebih besar dari 0 dan satuan upah harus valid (per_jam, per_hari, per_bulan, per_tahun).'
        });
      }

      const hKerja = Number(job.hari_kerja_per_bulan || 22);
      const jKerja = Number(job.jam_kerja_per_hari || 8);
      const normMonthly = normalizeToMonthly(jenis_upah, Number(nominal_upah), hKerja, jKerja);

      // Simpan penugasan + riwayat gaji awal dalam transaksi
      connection = await db.getConnection();
      await connection.beginTransaction();

      const [insertPenugasan] = await connection.query(
        `INSERT INTO penugasan 
          (id_pekerjaan, id_karyawan, peran_tugas, jenis_upah, nominal_upah, jenis_penugasan, status_penugasan, status_baca, id_role_budget, tanggal_penugasan, tanggal_selesai_tugas)
         VALUES (?, ?, ?, ?, ?, ?, 'aktif', 'belum', ?, ?, ?)`,
        [
          id_pekerjaan, id_karyawan, prb.nama_role, jenis_upah, Number(nominal_upah), jenis_penugasan,
          id_role_budget, tanggal_penugasan || null, tanggal_selesai_tugas || null
        ]
      );

      const idPenugasan = insertPenugasan.insertId;
      const effFrom = startEff || new Date().toISOString().slice(0, 10);

      await connection.query(
        `INSERT INTO penugasan_gaji_riwayat 
          (id_penugasan, jenis_upah, nominal_upah, normalized_monthly, effective_from, effective_to, catatan)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
        [
          idPenugasan, jenis_upah, Number(nominal_upah), normMonthly,
          effFrom, catatan_gaji || 'Penetapan skema gaji awal penugasan'
        ]
      );

      await connection.commit();
      connection.release();
      connection = null;

      return res.status(201).json({
        success: true,
        message: `Karyawan berhasil ditugaskan ke slot ${prb.nama_role} dengan skema upah ${jenis_upah}`,
        data: {
          id_penugasan: idPenugasan,
          id_pekerjaan: Number(id_pekerjaan),
          id_karyawan: Number(id_karyawan),
          id_role_budget: Number(id_role_budget),
          peran_tugas: prb.nama_role,
          jenis_upah,
          nominal_upah: Number(nominal_upah),
          normalized_monthly: normMonthly,
          effective_from: effFrom
        }
      });
    }

    // 3. Backward Compatibility: Jika id_role_budget tidak disertakan
    if (job.kuota_pekerja) {
      const [countRows] = await db.query(
        'SELECT COUNT(DISTINCT id_karyawan) AS total FROM penugasan WHERE id_pekerjaan = ? AND (status_penugasan IS NULL OR status_penugasan = "aktif")',
        [id_pekerjaan]
      );
      const totalAktif = Number(countRows[0]?.total || 0);
      if (totalAktif >= Number(job.kuota_pekerja)) {
        return res.status(400).json({
          success: false,
          message: `Kuota pekerja untuk proyek ini sudah penuh (${totalAktif}/${job.kuota_pekerja} pekerja).`
        });
      }
    }

    const [result] = await db.query(
      `INSERT INTO penugasan 
        (id_pekerjaan, id_karyawan, peran_tugas, jenis_penugasan, status_penugasan, status_baca, tanggal_penugasan, tanggal_selesai_tugas)
       VALUES (?, ?, ?, ?, 'aktif', 'belum', ?, ?)`,
      [
        id_pekerjaan, id_karyawan, peran_tugas, jenis_penugasan,
        tanggal_penugasan || null, tanggal_selesai_tugas || null
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Penugasan berhasil ditambahkan',
      data: { id_penugasan: result.insertId }
    });
  } catch (err) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    console.error('Error createPenugasan:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// 4. Hapus Penugasan
async function deletePenugasan(req, res) {
  try {
    const id = req.params.id || req.query.id_penugasan || req.body?.id_penugasan;
    if (!id) {
      return res.status(400).json({ success: false, message: 'ID Penugasan tidak valid' });
    }
    await db.query('DELETE FROM penugasan_gaji_riwayat WHERE id_penugasan = ?', [id]);
    await db.query('DELETE FROM penugasan WHERE id_penugasan = ?', [id]);
    return res.json({ success: true, message: 'Penugasan berhasil dihapus' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ========================================================
// FITUR FASE 2: RIWAYAT & PERUBAHAN SKEMA GAJI
// ========================================================

// 5. GET /api/penugasan/:id/gaji-riwayat
async function getPenugasanGajiRiwayat(req, res) {
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ success: false, message: 'ID Penugasan tidak valid' });
    }

    const [pnRows] = await db.query(`
      SELECT pn.*, p.nama_pekerjaan, p.kode_pekerjaan, p.hari_kerja_per_bulan, p.jam_kerja_per_hari,
             k.nama AS nama_karyawan, k.kode_karyawan, k.jabatan
      FROM penugasan pn
      JOIN pekerjaan p ON pn.id_pekerjaan = p.id_pekerjaan
      JOIN karyawan k ON pn.id_karyawan = k.id_karyawan
      WHERE pn.id_penugasan = ?
    `, [id]);

    if (pnRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data penugasan tidak ditemukan' });
    }
    const penugasan = pnRows[0];

    // Info slot role budget jika terikat
    let roleBudgetInfo = null;
    if (penugasan.id_role_budget) {
      const [rbRows] = await db.query(`
        SELECT prb.*, mr.nama_role, mr.hierarchy_level
        FROM pekerjaan_role_budget prb
        JOIN master_role mr ON prb.id_role = mr.id_role
        WHERE prb.id_role_budget = ?
      `, [penugasan.id_role_budget]);

      if (rbRows.length > 0) {
        const rb = rbRows[0];
        roleBudgetInfo = {
          id_role_budget: Number(rb.id_role_budget),
          id_role: Number(rb.id_role),
          nama_role: rb.nama_role,
          hierarchy_level: Number(rb.hierarchy_level),
          kuota_slot: Number(rb.kuota_slot),
          gaji_min_bulanan: Number(rb.gaji_min_bulanan),
          gaji_max_bulanan: Number(rb.gaji_max_bulanan),
          konversi_satuan: convertMonthlyRangeToAllUnits(
            Number(rb.gaji_min_bulanan),
            Number(rb.gaji_max_bulanan),
            penugasan.hari_kerja_per_bulan,
            penugasan.jam_kerja_per_hari
          )
        };
      }
    }

    // Ambil riwayat skema gaji
    const [riwayat] = await db.query(`
      SELECT *
      FROM penugasan_gaji_riwayat
      WHERE id_penugasan = ?
      ORDER BY effective_from DESC, id_riwayat_gaji DESC
    `, [id]);

    return res.json({
      success: true,
      message: 'Riwayat skema gaji berhasil dimuat',
      data: {
        penugasan: {
          id_penugasan: penugasan.id_penugasan,
          id_pekerjaan: penugasan.id_pekerjaan,
          nama_pekerjaan: penugasan.nama_pekerjaan,
          kode_pekerjaan: penugasan.kode_pekerjaan,
          id_karyawan: penugasan.id_karyawan,
          nama_karyawan: penugasan.nama_karyawan,
          kode_karyawan: penugasan.kode_karyawan,
          jabatan: penugasan.jabatan,
          peran_tugas: penugasan.peran_tugas,
          id_role_budget: penugasan.id_role_budget
        },
        role_budget: roleBudgetInfo,
        riwayat: riwayat.map(r => ({
          ...r,
          id_riwayat_gaji: Number(r.id_riwayat_gaji),
          id_penugasan: Number(r.id_penugasan),
          nominal_upah: Number(r.nominal_upah),
          normalized_monthly: Number(r.normalized_monthly),
          is_active: r.effective_to === null
        }))
      }
    });
  } catch (err) {
    console.error('Error getPenugasanGajiRiwayat:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// 6. POST /api/penugasan/:id/gaji-riwayat (Ganti Skema / Nominal Gaji Tanpa Overwrite)
async function updatePenugasanGajiRiwayat(req, res) {
  let connection;
  try {
    const id = req.params.id;
    const { jenis_upah, nominal_upah, effective_from, catatan = '' } = req.body;

    if (!id) {
      return res.status(400).json({ success: false, message: 'ID Penugasan tidak valid' });
    }

    const allowedUnits = ['per_jam', 'per_hari', 'per_bulan', 'per_tahun'];
    if (!allowedUnits.includes(jenis_upah)) {
      return res.status(400).json({ success: false, message: 'Satuan upah tidak valid (per_jam, per_hari, per_bulan, per_tahun).' });
    }

    const nominal = Number(nominal_upah);
    if (isNaN(nominal) || nominal <= 0) {
      return res.status(400).json({ success: false, message: 'Nominal upah harus lebih besar dari 0.' });
    }

    if (!effective_from || isNaN(new Date(effective_from).getTime())) {
      return res.status(400).json({ success: false, message: 'Format tanggal berlaku (effective_from) tidak valid.' });
    }

    const newEffDateStr = String(effective_from).slice(0, 10);

    // Ambil data penugasan & kalender kerja proyek
    const [pnRows] = await db.query(`
      SELECT pn.*, p.hari_kerja_per_bulan, p.jam_kerja_per_hari
      FROM penugasan pn
      JOIN pekerjaan p ON pn.id_pekerjaan = p.id_pekerjaan
      WHERE pn.id_penugasan = ?
    `, [id]);

    if (pnRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data penugasan tidak ditemukan.' });
    }
    const penugasan = pnRows[0];

    // Ambil riwayat gaji aktif saat ini (effective_to IS NULL)
    const [activeRows] = await db.query(
      'SELECT * FROM penugasan_gaji_riwayat WHERE id_penugasan = ? AND effective_to IS NULL ORDER BY id_riwayat_gaji DESC LIMIT 1',
      [id]
    );

    if (activeRows.length > 0) {
      const activeRecord = activeRows[0];
      const activeEffStr = String(activeRecord.effective_from).slice(0, 10);

      // effective_from baru WAJIB strictly lebih besar (>) daripada effective_from saat ini
      if (newEffDateStr <= activeEffStr) {
        return res.status(400).json({
          success: false,
          message: `Tanggal berlaku baru (${newEffDateStr}) harus strictly lebih besar dari tanggal berlaku skema saat ini (${activeEffStr}).`
        });
      }
    }

    // Hitung normalisasi gaji bulanan
    const hKerja = Number(penugasan.hari_kerja_per_bulan || 22);
    const jKerja = Number(penugasan.jam_kerja_per_hari || 8);
    const normMonthly = normalizeToMonthly(jenis_upah, nominal, hKerja, jKerja);

    // Jalankan pembaruan skema gaji dalam 1 transaksi
    connection = await db.getConnection();
    await connection.beginTransaction();

    if (activeRows.length > 0) {
      const activeRecord = activeRows[0];
      // Set effective_to = DATE_SUB(newEffDateStr, INTERVAL 1 DAY)
      await connection.query(
        'UPDATE penugasan_gaji_riwayat SET effective_to = DATE_SUB(?, INTERVAL 1 DAY) WHERE id_riwayat_gaji = ?',
        [newEffDateStr, activeRecord.id_riwayat_gaji]
      );
    }

    // Insert record skema baru
    const [insertResult] = await connection.query(
      `INSERT INTO penugasan_gaji_riwayat 
        (id_penugasan, jenis_upah, nominal_upah, normalized_monthly, effective_from, effective_to, catatan)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      [id, jenis_upah, nominal, normMonthly, newEffDateStr, catatan || 'Penyesuaian skema gaji']
    );

    // Sinkronkan juga ke tabel penugasan langsung
    await connection.query(
      'UPDATE penugasan SET jenis_upah = ?, nominal_upah = ? WHERE id_penugasan = ?',
      [jenis_upah, nominal, id]
    );

    await connection.commit();
    connection.release();
    connection = null;

    // Ambil daftar riwayat terbaru
    const [allHistory] = await db.query(
      'SELECT * FROM penugasan_gaji_riwayat WHERE id_penugasan = ? ORDER BY effective_from DESC, id_riwayat_gaji DESC',
      [id]
    );

    return res.status(201).json({
      success: true,
      message: 'Skema gaji berhasil diperbarui tanpa menimpa riwayat sebelumnya',
      data: {
        new_record: {
          id_riwayat_gaji: insertResult.insertId,
          id_penugasan: Number(id),
          jenis_upah,
          nominal_upah: nominal,
          normalized_monthly: normMonthly,
          effective_from: newEffDateStr,
          effective_to: null,
          catatan
        },
        riwayat: allHistory.map(r => ({
          ...r,
          id_riwayat_gaji: Number(r.id_riwayat_gaji),
          id_penugasan: Number(r.id_penugasan),
          nominal_upah: Number(r.nominal_upah),
          normalized_monthly: Number(r.normalized_monthly),
          is_active: r.effective_to === null
        }))
      }
    });
  } catch (err) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    console.error('Error updatePenugasanGajiRiwayat:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

async function getPenugasanById(req, res) {
  return getAllPenugasan(req, res);
}

async function updatePenugasan(req, res) {
  try {
    const id = Number(req.params.id);
    const idPekerjaan = Number(req.body.id_pekerjaan);
    const idKaryawan = (req.user?.peran === 'admin' || req.user?.peran === 'super_admin')
      ? Number(req.body.id_karyawan)
      : Number(req.user?.id_karyawan);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(idPekerjaan) || idPekerjaan <= 0 || !Number.isInteger(idKaryawan) || idKaryawan <= 0) {
      return res.status(400).json({ success: false, message: 'Pekerjaan dan karyawan wajib dipilih.' });
    }
    const [result] = await db.query(
      'UPDATE penugasan SET id_pekerjaan = ?, id_karyawan = ? WHERE id_penugasan = ?',
      [idPekerjaan, idKaryawan, id]
    );
    if (!result.affectedRows) return res.status(404).json({ success: false, message: 'Penugasan tidak ditemukan.' });
    req.params.id = String(id);
    return getPenugasanById(req, res);
  } catch (error) {
    console.error('Error updatePenugasan:', error);
    return res.status(500).json({ success: false, message: 'Gagal memperbarui penugasan.' });
  }
}

module.exports = {
  getAllPenugasan,
  getPenugasanById,
  createPenugasan,
  updatePenugasan,
  deletePenugasan,
  cekKetersediaanKaryawan,
  getPenugasanGajiRiwayat,
  updatePenugasanGajiRiwayat
};
