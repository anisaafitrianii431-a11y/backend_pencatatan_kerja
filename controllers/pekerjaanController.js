const db = require('../config/database');
const { saveBase64Image } = require('../utils/uploadHelper');
const {
  normalizeToMonthly,
  convertMonthlyRangeToAllUnits,
  validateRoleBudgetsHierarchy,
  calculateEffectiveWorkingDays,
  calculateIndividualCommitment
} = require('../utils/projectSalaryHelper');

// Formula SQL Durasi Kerja (Mendukung Shift Malam)
const sqlDurasi = `
  CASE 
    WHEN a.jam_pulang IS NOT NULL AND a.jam_pulang >= a.jam_masuk 
      THEN ROUND(TIME_TO_SEC(TIMEDIFF(a.jam_pulang, a.jam_masuk)) / 3600, 2)
    WHEN a.jam_pulang IS NOT NULL AND a.jam_pulang < a.jam_masuk 
      THEN ROUND((TIME_TO_SEC(TIMEDIFF(a.jam_pulang, a.jam_masuk)) + 86400) / 3600, 2)
    ELSE 0 
  END
`;

// Helper untuk format data pekerjaan
function formatJob(row) {
  if (!row) return null;
  const kuota = row.kuota_pekerja !== null && row.kuota_pekerja !== '' && Number(row.kuota_pekerja) > 0 ? Number(row.kuota_pekerja) : null;
  const totalPekerja = Number(row.total_pekerja || row.total_pekerja_aktif || 0);
  const isUnlimited = kuota === null;

  return {
    ...row,
    id_pekerjaan: Number(row.id_pekerjaan),
    kode_pekerjaan: row.kode_pekerjaan || null,
    kuota_pekerja: kuota,
    total_pekerja: totalPekerja,
    total_pekerja_aktif: totalPekerja,
    is_unlimited_kuota: isUnlimited,
    sisa_slot: isUnlimited ? null : Math.max(0, kuota - totalPekerja),
    is_kuota_penuh: !isUnlimited && totalPekerja >= kuota,
    radius_meter: Number(row.radius_meter || 100),
    nominal_upah: Number(row.nominal_upah || 0),
    hari_kerja_per_bulan: Number(row.hari_kerja_per_bulan !== undefined && row.hari_kerja_per_bulan !== null ? row.hari_kerja_per_bulan : 22),
    jam_kerja_per_hari: Number(row.jam_kerja_per_hari !== undefined && row.jam_kerja_per_hari !== null ? row.jam_kerja_per_hari : 8),
    jam_masuk_standar: row.jam_masuk_standar || '08:00:00',
    jam_pulang_standar: row.jam_pulang_standar || '17:00:00',
    toleransi_terlambat_menit: Number(row.toleransi_terlambat_menit !== undefined && row.toleransi_terlambat_menit !== null ? row.toleransi_terlambat_menit : 15),
    tanggal_cutoff: Number(row.tanggal_cutoff !== undefined && row.tanggal_cutoff !== null ? row.tanggal_cutoff : 25),
    tanggal_pencairan: Number(row.tanggal_pencairan !== undefined && row.tanggal_pencairan !== null ? row.tanggal_pencairan : 28),
    lembur_diizinkan: Number(row.lembur_diizinkan !== undefined && row.lembur_diizinkan !== null ? row.lembur_diizinkan : 0),
    buffer_lembur_persen: Number(row.buffer_lembur_persen !== undefined && row.buffer_lembur_persen !== null ? row.buffer_lembur_persen : 10),
    latitude: row.latitude ? String(row.latitude) : '',
    longitude: row.longitude ? String(row.longitude) : '',
    titik_lokasi: row.titik_lokasi || (row.latitude && row.longitude ? `${row.latitude}, ${row.longitude}` : ''),
    nama_karyawan_list: row.nama_karyawan_list || '-',
    id_karyawan_list: row.id_karyawan_list
      ? (Array.isArray(row.id_karyawan_list) ? row.id_karyawan_list : String(row.id_karyawan_list).split(',').map(Number))
      : []
  };
}

// Helper auto-generate kode pekerjaan: PRJ-YYYYMM-XXX
async function generateKodePekerjaan(executor) {
  const now = new Date();
  const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prefix = `PRJ-${yyyymm}-`;
  const [rows] = await executor.query(
    'SELECT kode_pekerjaan FROM pekerjaan WHERE kode_pekerjaan LIKE ? ORDER BY id_pekerjaan DESC LIMIT 1',
    [`${prefix}%`]
  );
  if (rows.length > 0 && rows[0].kode_pekerjaan) {
    const lastNumStr = rows[0].kode_pekerjaan.replace(prefix, '');
    const lastNum = parseInt(lastNumStr, 10);
    if (!isNaN(lastNum)) {
      return `${prefix}${String(lastNum + 1).padStart(3, '0')}`;
    }
  }
  return `${prefix}001`;
}

// 1. Ambil Semua Data Pekerjaan / Dispatcher Berdasarkan Parameter Query
async function getAllPekerjaan(req, res) {
  try {
    const rawId = req.params.id || req.query.id_pekerjaan;
    const action = req.query.action || req.body?.action;

    // Sub-routing query jika ada query bertingkat seperti ?id_pekerjaan=5/pekerja
    if (typeof rawId === 'string' && rawId.includes('/')) {
      const parts = rawId.split('/');
      const actualId = parseInt(parts[0], 10);
      const subAction = parts[1];
      if (subAction === 'pekerja') return getPekerjaanPekerja({ ...req, params: { id: actualId } }, res);
      if (subAction === 'laporan') return getPekerjaanLaporan({ ...req, params: { id: actualId } }, res);
      if (subAction === 'status-pengambilan') return togglePengambilanPekerjaan({ ...req, params: { id: actualId } }, res);
      if (subAction === 'ambil') return ambilPekerjaan({ ...req, params: { id: actualId } }, res);
      if (subAction === 'blueprint') return getPekerjaanBlueprint({ ...req, params: { id: actualId } }, res);
      if (subAction === 'budget-summary') return getPekerjaanBudgetSummary({ ...req, params: { id: actualId } }, res);
      if (subAction === 'kandidat-karyawan') return getPekerjaanKandidatKaryawan({ ...req, params: { id: actualId } }, res);
    }

    if (action === 'tersedia') {
      return getPekerjaanTersedia(req, res);
    }

    if (action === 'ambil') {
      return ambilPekerjaan(req, res);
    }

    if (action === 'blueprint') {
      return getPekerjaanBlueprint(req, res);
    }

    if (action === 'budget-summary') {
      return getPekerjaanBudgetSummary(req, res);
    }

    if (action === 'kandidat-karyawan') {
      return getPekerjaanKandidatKaryawan(req, res);
    }

    const id = parseInt(rawId, 10);
    if (!isNaN(id) && id > 0) {
      return getPekerjaanById(req, res, id);
    }

    // Role-based filtering:
    // Jika user login adalah karyawan dan tidak meminta view admin eksplisit
    const isWorker = req.user?.peran === 'karyawan' && !req.query.admin_view;
    const workerId = isWorker ? req.user.id_karyawan : (req.query.id_karyawan ? parseInt(req.query.id_karyawan, 10) : null);

    if (isWorker && workerId) {
      const [rows] = await db.query(`
        SELECT p.*,
          pn.id_penugasan,
          pn.peran_tugas AS peran_saya,
          pn.jenis_penugasan,
          pn.status_baca,
          DATE(pn.created_at) AS tanggal_penugasan,
          (SELECT COUNT(DISTINCT pnx.id_karyawan) FROM penugasan pnx WHERE pnx.id_pekerjaan = p.id_pekerjaan AND (pnx.status_penugasan IS NULL OR pnx.status_penugasan = 'aktif')) AS total_pekerja,
          (SELECT COALESCE(SUM(${sqlDurasi}), 0) FROM absensi a WHERE a.id_pekerjaan = p.id_pekerjaan AND a.id_karyawan = ? AND a.status_verifikasi = 'disetujui' AND a.jam_pulang IS NOT NULL) AS jam_kerja_saya,
          (SELECT COALESCE(SUM(nominal), 0) FROM pengeluaran pg WHERE pg.id_pekerjaan = p.id_pekerjaan AND pg.id_karyawan = ?) AS pengeluaran_saya
        FROM pekerjaan p
        JOIN penugasan pn ON p.id_pekerjaan = pn.id_pekerjaan AND pn.id_karyawan = ? AND (pn.status_penugasan IS NULL OR pn.status_penugasan = 'aktif')
        ORDER BY p.id_pekerjaan DESC
      `, [workerId, workerId, workerId]);

      if (rows.length > 0) {
        return res.json({
          success: true,
          message: 'Daftar pekerjaan tugas saya berhasil dimuat (Karyawan)',
          data: rows.map(formatJob)
        });
      }

      return res.json({
        success: true,
        message: 'Belum ada pekerjaan yang ditugaskan kepada karyawan ini',
        data: []
      });
    }

    // Tampilan Admin: Mengambil semua data pekerjaan beserta relasi penugasan, durasi kerja, dan pengeluaran
    const [allJobs] = await db.query(`
      SELECT p.*,
        (SELECT COUNT(DISTINCT pn.id_karyawan) FROM penugasan pn WHERE pn.id_pekerjaan = p.id_pekerjaan AND (pn.status_penugasan IS NULL OR pn.status_penugasan = 'aktif')) AS total_pekerja,
        (SELECT GROUP_CONCAT(k.nama ORDER BY pn.id_penugasan ASC SEPARATOR ', ')
         FROM penugasan pn JOIN karyawan k ON pn.id_karyawan = k.id_karyawan
         WHERE pn.id_pekerjaan = p.id_pekerjaan AND (pn.status_penugasan IS NULL OR pn.status_penugasan = 'aktif')) AS nama_karyawan_list,
        (SELECT GROUP_CONCAT(pn.id_karyawan ORDER BY pn.id_penugasan ASC SEPARATOR ',')
         FROM penugasan pn
         WHERE pn.id_pekerjaan = p.id_pekerjaan AND (pn.status_penugasan IS NULL OR pn.status_penugasan = 'aktif')) AS id_karyawan_list,
        (SELECT COALESCE(SUM(${sqlDurasi}), 0) FROM absensi a WHERE a.id_pekerjaan = p.id_pekerjaan AND a.status_verifikasi = 'disetujui' AND a.jam_pulang IS NOT NULL) AS total_jam_kerja,
        (SELECT COALESCE(SUM(nominal), 0) FROM pengeluaran pg WHERE pg.id_pekerjaan = p.id_pekerjaan AND pg.status_verifikasi = 'disetujui') AS total_pengeluaran
      FROM pekerjaan p
      ORDER BY p.id_pekerjaan DESC
    `);

    return res.json({
      success: true,
      message: 'Data pekerjaan berhasil dimuat',
      data: allJobs.map(formatJob)
    });
  } catch (error) {
    console.error('Error getAllPekerjaan:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal mengambil data pekerjaan',
      error: error.message
    });
  }
}

// 2. Ambil Detail Tunggal Pekerjaan (ById)
async function getPekerjaanById(req, res, targetId = null) {
  try {
    const id = targetId || req.params.id || req.query.id_pekerjaan;
    if (!id) {
      return res.status(400).json({ success: false, message: 'ID Pekerjaan tidak valid' });
    }

    const [rows] = await db.query(`
      SELECT p.*,
        (SELECT COUNT(DISTINCT pn.id_karyawan) FROM penugasan pn WHERE pn.id_pekerjaan = p.id_pekerjaan AND (pn.status_penugasan IS NULL OR pn.status_penugasan = 'aktif')) AS total_pekerja,
        (SELECT GROUP_CONCAT(k.nama ORDER BY pn.id_penugasan ASC SEPARATOR ', ')
         FROM penugasan pn JOIN karyawan k ON pn.id_karyawan = k.id_karyawan
         WHERE pn.id_pekerjaan = p.id_pekerjaan AND (pn.status_penugasan IS NULL OR pn.status_penugasan = 'aktif')) AS nama_karyawan_list,
        (SELECT GROUP_CONCAT(pn.id_karyawan ORDER BY pn.id_penugasan ASC SEPARATOR ',')
         FROM penugasan pn
         WHERE pn.id_pekerjaan = p.id_pekerjaan AND (pn.status_penugasan IS NULL OR pn.status_penugasan = 'aktif')) AS id_karyawan_list,
        (SELECT COALESCE(SUM(${sqlDurasi}), 0) FROM absensi a WHERE a.id_pekerjaan = p.id_pekerjaan AND a.status_verifikasi = 'disetujui' AND a.jam_pulang IS NOT NULL) AS total_jam_kerja,
        (SELECT COALESCE(SUM(nominal), 0) FROM pengeluaran pg WHERE pg.id_pekerjaan = p.id_pekerjaan AND pg.status_verifikasi = 'disetujui') AS total_pengeluaran
      FROM pekerjaan p
      WHERE p.id_pekerjaan = ?
    `, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data pekerjaan tidak ditemukan' });
    }

    const job = formatJob(rows[0]);

    // Ambil daftar pekerja yang ditugaskan ke pekerjaan ini
    const [workers] = await db.query(`
      SELECT pn.id_penugasan, pn.id_karyawan, pn.peran_tugas, pn.jenis_penugasan, pn.status_karyawan, pn.status_penugasan,
             pn.id_role_budget, pn.tanggal_penugasan, pn.tanggal_selesai_tugas,
             k.nama, k.jabatan, k.kode_karyawan
      FROM penugasan pn
      JOIN karyawan k ON pn.id_karyawan = k.id_karyawan
      WHERE pn.id_pekerjaan = ? AND (pn.status_penugasan IS NULL OR pn.status_penugasan <> 'dibatalkan')
      ORDER BY pn.id_penugasan ASC
    `, [id]);

    job.assigned_workers = workers;

    return res.json({
      success: true,
      message: 'Detail pekerjaan berhasil dimuat',
      data: job
    });
  } catch (error) {
    console.error('Error getPekerjaanById:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal memuat detail pekerjaan',
      error: error.message
    });
  }
}

// 3. Ambil Pekerjaan Tersedia (Bisa diambil mandiri oleh pekerja)
async function getPekerjaanTersedia(req, res) {
  try {
    const workerId = req.query.worker_id || req.user?.id_karyawan;

    const [rows] = await db.query(`
      SELECT p.*,
        (SELECT COUNT(DISTINCT pn.id_karyawan) FROM penugasan pn WHERE pn.id_pekerjaan = p.id_pekerjaan AND (pn.status_penugasan IS NULL OR pn.status_penugasan = 'aktif')) AS total_pekerja
      FROM pekerjaan p
      WHERE p.status <> 'selesai'
        AND p.metode_penentuan IN ('terbuka', 'gabungan')
        AND (p.status_pengambilan IS NULL OR p.status_pengambilan = 'terbuka')
      ORDER BY p.id_pekerjaan DESC
    `);

    const formatted = rows
      .map(formatJob)
      .filter(j => j.is_unlimited_kuota || (j.sisa_slot !== null && j.sisa_slot > 0));

    // Jika workerId disertakan, cek apakah pekerja sudah bergabung
    if (workerId) {
      const [joinedJobs] = await db.query(
        'SELECT id_pekerjaan FROM penugasan WHERE id_karyawan = ? AND (status_penugasan IS NULL OR status_penugasan = "aktif")',
        [workerId]
      );
      const joinedSet = new Set(joinedJobs.map(r => Number(r.id_pekerjaan)));
      formatted.forEach(j => {
        j.already_joined = joinedSet.has(j.id_pekerjaan);
      });
    }

    return res.json({
      success: true,
      message: 'Daftar pekerjaan tersedia berhasil dimuat',
      data: formatted
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal memuat pekerjaan tersedia',
      error: error.message
    });
  }
}

// 4. Tambah Pekerjaan Baru (Mendukung Blueprint Role & Multi-Satuan)
async function createPekerjaan(req, res) {
  let connection;
  try {
    const {
      nama_pekerjaan,
      kode_pekerjaan,
      deskripsi = '',
      lokasi = '',
      titik_lokasi = '',
      metode_lokasi = 'titik',
      tanggal_mulai = null,
      target_selesai = null,
      status = 'belum_mulai',
      metode_penentuan = 'langsung',
      jenis_upah = 'per_jam',
      nominal_upah = 0,
      kuota_pekerja = null,
      status_pengambilan = 'ditutup',
      latitude = null,
      longitude = null,
      radius_meter = 100,
      id_karyawan_list = [],
      // Kolom Standar Waktu & Payroll Baru (Fase 1 & 2)
      hari_kerja_per_bulan = 22,
      jam_kerja_per_hari = 8,
      jam_masuk_standar = '08:00:00',
      jam_pulang_standar = '17:00:00',
      toleransi_terlambat_menit = 15,
      tanggal_cutoff = 25,
      tanggal_pencairan = 28,
      lembur_diizinkan = 0,
      buffer_lembur_persen = 10,
      role_budgets = []
    } = req.body;

    if (!nama_pekerjaan) {
      return res.status(400).json({
        success: false,
        message: 'Nama pekerjaan wajib diisi'
      });
    }

    // Validasi aturan standar kalender proyek
    const hKerja = Number(hari_kerja_per_bulan !== undefined && hari_kerja_per_bulan !== null ? hari_kerja_per_bulan : 22);
    if (!Number.isInteger(hKerja) || hKerja < 1 || hKerja > 31) {
      return res.status(400).json({ success: false, message: 'Jumlah hari kerja per bulan harus antara 1 dan 31 hari.' });
    }

    const jKerja = Number(jam_kerja_per_hari !== undefined && jam_kerja_per_hari !== null ? jam_kerja_per_hari : 8);
    if (isNaN(jKerja) || jKerja <= 0 || jKerja > 24) {
      return res.status(400).json({ success: false, message: 'Jam kerja per hari harus lebih besar dari 0 dan maksimal 24 jam.' });
    }

    const tCutoff = Number(tanggal_cutoff !== undefined && tanggal_cutoff !== null ? tanggal_cutoff : 25);
    if (!Number.isInteger(tCutoff) || tCutoff < 1 || tCutoff > 31) {
      return res.status(400).json({ success: false, message: 'Tanggal cutoff absensi harus antara 1 dan 31.' });
    }

    const tPencairan = Number(tanggal_pencairan !== undefined && tanggal_pencairan !== null ? tanggal_pencairan : 28);
    if (!Number.isInteger(tPencairan) || tPencairan < 1 || tPencairan > 31) {
      return res.status(400).json({ success: false, message: 'Tanggal pencairan gaji harus antara 1 dan 31.' });
    }

    const bLembur = Number(buffer_lembur_persen !== undefined && buffer_lembur_persen !== null ? buffer_lembur_persen : 10);
    if (isNaN(bLembur) || bLembur < 0 || bLembur > 100) {
      return res.status(400).json({ success: false, message: 'Buffer lembur harus antara 0% dan 100%.' });
    }

    const isLembur = Number(lembur_diizinkan) === 1 ? 1 : 0;

    let finalTitik = titik_lokasi;
    if (!finalTitik && latitude && longitude) {
      finalTitik = `${latitude}, ${longitude}`;
    }

    const hasRoleBudgets = Array.isArray(role_budgets) && role_budgets.length > 0;

    if (hasRoleBudgets) {
      // Ambil metadata role dari master_role untuk verifikasi dan validasi hierarki
      const roleIds = role_budgets.map(r => Number(r.id_role)).filter(Boolean);
      if (roleIds.length === 0) {
        return res.status(400).json({ success: false, message: 'Data role budget tidak valid.' });
      }

      const [roles] = await db.query(
        `SELECT id_role, nama_role, hierarchy_level, is_active FROM master_role WHERE id_role IN (${roleIds.map(() => '?').join(',')})`,
        roleIds
      );

      const roleMap = new Map();
      roles.forEach(r => roleMap.set(Number(r.id_role), r));

      const enrichedBudgets = [];
      for (const rb of role_budgets) {
        const mr = roleMap.get(Number(rb.id_role));
        if (!mr || !mr.is_active) {
          return res.status(400).json({
            success: false,
            message: `Role dengan ID ${rb.id_role} tidak ditemukan atau sedang tidak aktif.`
          });
        }
        enrichedBudgets.push({
          ...rb,
          nama_role: mr.nama_role,
          hierarchy_level: mr.hierarchy_level,
          kuota_slot: Number(rb.kuota_slot),
          gaji_min_bulanan: Number(rb.gaji_min_bulanan),
          gaji_max_bulanan: Number(rb.gaji_max_bulanan)
        });
      }

      // Validasi hierarki & konsistensi rentang gaji
      const hierarchyCheck = validateRoleBudgetsHierarchy(enrichedBudgets);
      if (!hierarchyCheck.valid) {
        return res.status(400).json({
          success: false,
          message: hierarchyCheck.message
        });
      }

      // Hitung total kuota pekerja dari seluruh slot role blueprint
      const totalSlotKuota = enrichedBudgets.reduce((sum, r) => sum + r.kuota_slot, 0);

      connection = await db.getConnection();
      await connection.beginTransaction();

      let finalKode = kode_pekerjaan;
      if (!finalKode || String(finalKode).trim() === '') {
        finalKode = await generateKodePekerjaan(connection);
      }

      const [result] = await connection.query(
        `INSERT INTO pekerjaan 
          (nama_pekerjaan, kode_pekerjaan, deskripsi, lokasi, titik_lokasi, metode_lokasi, tanggal_mulai, target_selesai, status, metode_penentuan, jenis_upah, nominal_upah, kuota_pekerja, status_pengambilan, latitude, longitude, radius_meter, hari_kerja_per_bulan, jam_kerja_per_hari, jam_masuk_standar, jam_pulang_standar, toleransi_terlambat_menit, tanggal_cutoff, tanggal_pencairan, lembur_diizinkan, buffer_lembur_persen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          nama_pekerjaan, finalKode, deskripsi, lokasi, finalTitik || null, metode_lokasi,
          tanggal_mulai || null, target_selesai || null, status, metode_penentuan,
          jenis_upah, nominal_upah, totalSlotKuota, status_pengambilan,
          latitude || null, longitude || null, radius_meter || 100,
          hKerja, jKerja, jam_masuk_standar || '08:00:00', jam_pulang_standar || '17:00:00',
          toleransi_terlambat_menit || 15, tCutoff, tPencairan, isLembur, bLembur
        ]
      );

      const idPekerjaan = result.insertId;

      // Masukkan role blueprint ke pekerjaan_role_budget
      for (const rb of enrichedBudgets) {
        await connection.query(
          `INSERT INTO pekerjaan_role_budget 
            (id_pekerjaan, id_role, kuota_slot, gaji_min_bulanan, gaji_max_bulanan)
           VALUES (?, ?, ?, ?, ?)`,
          [idPekerjaan, rb.id_role, rb.kuota_slot, rb.gaji_min_bulanan, rb.gaji_max_bulanan]
        );
      }

      // Masukkan penugasan legacy jika ada
      const empIds = Array.isArray(id_karyawan_list) ? id_karyawan_list : (id_karyawan_list ? String(id_karyawan_list).split(',').map(Number) : []);
      for (const idKar of empIds) {
        if (idKar > 0) {
          await connection.query(
            `INSERT INTO penugasan (id_pekerjaan, id_karyawan, peran_tugas, jenis_penugasan, status_baca, status_penugasan) 
             VALUES (?, ?, 'Anggota Tim Pelaksana', 'admin', 'belum', 'aktif')`,
            [idPekerjaan, idKar]
          );
        }
      }

      await connection.commit();
      connection.release();
      connection = null;

      return res.status(201).json({
        success: true,
        message: 'Pekerjaan beserta blueprint role berhasil dibuat',
        data: {
          id_pekerjaan: idPekerjaan,
          kode_pekerjaan: finalKode,
          nama_pekerjaan,
          status,
          kuota_pekerja: totalSlotKuota,
          metode_penentuan
        }
      });
    }

    // Alur Backward-Compatible (tanpa role_budgets)
    let finalKode = kode_pekerjaan;
    if (!finalKode || String(finalKode).trim() === '') {
      finalKode = await generateKodePekerjaan(db);
    }

    const [result] = await db.query(
      `INSERT INTO pekerjaan 
        (nama_pekerjaan, kode_pekerjaan, deskripsi, lokasi, titik_lokasi, metode_lokasi, tanggal_mulai, target_selesai, status, metode_penentuan, jenis_upah, nominal_upah, kuota_pekerja, status_pengambilan, latitude, longitude, radius_meter, hari_kerja_per_bulan, jam_kerja_per_hari, jam_masuk_standar, jam_pulang_standar, toleransi_terlambat_menit, tanggal_cutoff, tanggal_pencairan, lembur_diizinkan, buffer_lembur_persen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nama_pekerjaan, finalKode, deskripsi, lokasi, finalTitik || null, metode_lokasi,
        tanggal_mulai || null, target_selesai || null, status, metode_penentuan,
        jenis_upah, nominal_upah, kuota_pekerja || null, status_pengambilan,
        latitude || null, longitude || null, radius_meter || 100,
        hKerja, jKerja, jam_masuk_standar || '08:00:00', jam_pulang_standar || '17:00:00',
        toleransi_terlambat_menit || 15, tCutoff, tPencairan, isLembur, bLembur
      ]
    );

    const idPekerjaan = result.insertId;

    const empIds = Array.isArray(id_karyawan_list) ? id_karyawan_list : (id_karyawan_list ? String(id_karyawan_list).split(',').map(Number) : []);
    for (const idKar of empIds) {
      if (idKar > 0) {
        await db.query(
          `INSERT INTO penugasan (id_pekerjaan, id_karyawan, peran_tugas, jenis_penugasan, status_baca, status_penugasan) 
           VALUES (?, ?, 'Anggota Tim Pelaksana', 'admin', 'belum', 'aktif')`,
          [idPekerjaan, idKar]
        );
      }
    }

    return res.status(201).json({
      success: true,
      message: 'Pekerjaan berhasil dibuat',
      data: {
        id_pekerjaan: idPekerjaan,
        kode_pekerjaan: finalKode,
        nama_pekerjaan,
        status,
        metode_penentuan
      }
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    console.error('Error createPekerjaan:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal membuat pekerjaan: ' + error.message,
      error: error.message
    });
  }
}

// 5. Perbarui Pekerjaan
async function updatePekerjaan(req, res) {
  let connection;
  try {
    const id = req.params.id || req.body.id_pekerjaan || req.query.id_pekerjaan;
    if (!id) {
      return res.status(400).json({ success: false, message: 'ID Pekerjaan wajib diisi' });
    }

    const {
      nama_pekerjaan,
      kode_pekerjaan,
      deskripsi,
      lokasi,
      titik_lokasi,
      metode_lokasi,
      tanggal_mulai,
      target_selesai,
      status,
      metode_penentuan,
      jenis_upah,
      nominal_upah,
      kuota_pekerja,
      status_pengambilan,
      latitude,
      longitude,
      radius_meter,
      id_karyawan_list,
      // Kolom Standar Waktu & Payroll Baru (Fase 1 & 2)
      hari_kerja_per_bulan,
      jam_kerja_per_hari,
      jam_masuk_standar,
      jam_pulang_standar,
      toleransi_terlambat_menit,
      tanggal_cutoff,
      tanggal_pencairan,
      lembur_diizinkan,
      buffer_lembur_persen,
      role_budgets
    } = req.body;

    // Validasi kalender kerja jika disertakan
    if (hari_kerja_per_bulan !== undefined && hari_kerja_per_bulan !== null) {
      const hKerja = Number(hari_kerja_per_bulan);
      if (!Number.isInteger(hKerja) || hKerja < 1 || hKerja > 31) {
        return res.status(400).json({ success: false, message: 'Jumlah hari kerja per bulan harus antara 1 dan 31 hari.' });
      }
    }

    if (jam_kerja_per_hari !== undefined && jam_kerja_per_hari !== null) {
      const jKerja = Number(jam_kerja_per_hari);
      if (isNaN(jKerja) || jKerja <= 0 || jKerja > 24) {
        return res.status(400).json({ success: false, message: 'Jam kerja per hari harus lebih besar dari 0 dan maksimal 24 jam.' });
      }
    }

    if (tanggal_cutoff !== undefined && tanggal_cutoff !== null) {
      const tCutoff = Number(tanggal_cutoff);
      if (!Number.isInteger(tCutoff) || tCutoff < 1 || tCutoff > 31) {
        return res.status(400).json({ success: false, message: 'Tanggal cutoff absensi harus antara 1 dan 31.' });
      }
    }

    if (tanggal_pencairan !== undefined && tanggal_pencairan !== null) {
      const tPencairan = Number(tanggal_pencairan);
      if (!Number.isInteger(tPencairan) || tPencairan < 1 || tPencairan > 31) {
        return res.status(400).json({ success: false, message: 'Tanggal pencairan gaji harus antara 1 dan 31.' });
      }
    }

    if (buffer_lembur_persen !== undefined && buffer_lembur_persen !== null) {
      const bLembur = Number(buffer_lembur_persen);
      if (isNaN(bLembur) || bLembur < 0 || bLembur > 100) {
        return res.status(400).json({ success: false, message: 'Buffer lembur harus antara 0% dan 100%.' });
      }
    }

    let finalTitik = titik_lokasi;
    if (!finalTitik && latitude && longitude) {
      finalTitik = `${latitude}, ${longitude}`;
    }

    // Jika role_budgets disertakan, lakukan update blueprint role dalam transaksi
    if (Array.isArray(role_budgets) && role_budgets.length > 0) {
      connection = await db.getConnection();
      await connection.beginTransaction();

      // Ambil metadata role
      const roleIds = role_budgets.map(r => Number(r.id_role)).filter(Boolean);
      const [roles] = await connection.query(
        `SELECT id_role, nama_role, hierarchy_level, is_active FROM master_role WHERE id_role IN (${roleIds.map(() => '?').join(',')})`,
        roleIds
      );

      const roleMap = new Map();
      roles.forEach(r => roleMap.set(Number(r.id_role), r));

      const enrichedBudgets = [];
      for (const rb of role_budgets) {
        const mr = roleMap.get(Number(rb.id_role));
        if (!mr || !mr.is_active) {
          await connection.rollback();
          connection.release();
          return res.status(400).json({
            success: false,
            message: `Role dengan ID ${rb.id_role} tidak ditemukan atau tidak aktif.`
          });
        }
        enrichedBudgets.push({
          ...rb,
          nama_role: mr.nama_role,
          hierarchy_level: mr.hierarchy_level,
          kuota_slot: Number(rb.kuota_slot),
          gaji_min_bulanan: Number(rb.gaji_min_bulanan),
          gaji_max_bulanan: Number(rb.gaji_max_bulanan)
        });
      }

      const hierarchyCheck = validateRoleBudgetsHierarchy(enrichedBudgets);
      if (!hierarchyCheck.valid) {
        await connection.rollback();
        connection.release();
        return res.status(400).json({ success: false, message: hierarchyCheck.message });
      }

      // Ambil kalender kerja proyek saat ini
      const [currJobRows] = await connection.query('SELECT * FROM pekerjaan WHERE id_pekerjaan = ?', [id]);
      if (currJobRows.length === 0) {
        await connection.rollback();
        connection.release();
        return res.status(404).json({ success: false, message: 'Data pekerjaan tidak ditemukan' });
      }
      const cJob = currJobRows[0];
      const hPerBulan = hari_kerja_per_bulan !== undefined ? Number(hari_kerja_per_bulan) : Number(cJob.hari_kerja_per_bulan || 22);
      const jPerHari = jam_kerja_per_hari !== undefined ? Number(jam_kerja_per_hari) : Number(cJob.jam_kerja_per_hari || 8);

      // Cek pekerja aktif yang sudah ter-assign ke role budget di proyek ini (Proteksi Slot Terisi)
      const [assignedWorkers] = await connection.query(`
        SELECT pn.id_penugasan, pn.id_role_budget, pn.id_karyawan, k.nama, prb.id_role, mr.nama_role,
               COALESCE(
                 pgr.normalized_monthly,
                 CASE 
                   WHEN pgr.jenis_upah = 'per_jam' THEN pgr.nominal_upah * ? * ?
                   WHEN pgr.jenis_upah = 'per_hari' THEN pgr.nominal_upah * ?
                   WHEN pgr.jenis_upah = 'per_tahun' THEN pgr.nominal_upah / 12
                   ELSE pgr.nominal_upah
                 END,
                 CASE 
                   WHEN k.jenis_upah = 'per_jam' THEN k.nominal_upah * ? * ?
                   WHEN k.jenis_upah = 'per_hari' THEN k.nominal_upah * ?
                   WHEN k.jenis_upah = 'per_tahun' THEN k.nominal_upah / 12
                   ELSE k.nominal_upah
                 END
               ) AS normalized_monthly
        FROM penugasan pn
        JOIN pekerjaan_role_budget prb ON pn.id_role_budget = prb.id_role_budget
        JOIN master_role mr ON prb.id_role = mr.id_role
        JOIN karyawan k ON pn.id_karyawan = k.id_karyawan
        LEFT JOIN penugasan_gaji_riwayat pgr ON pgr.id_penugasan = pn.id_penugasan AND pgr.effective_to IS NULL
        WHERE pn.id_pekerjaan = ? AND (pn.status_penugasan IS NULL OR pn.status_penugasan = 'aktif')
      `, [hPerBulan, jPerHari, hPerBulan, hPerBulan, jPerHari, hPerBulan, id]);

      const workersByRole = {};
      for (const w of assignedWorkers) {
        if (!workersByRole[w.id_role]) workersByRole[w.id_role] = [];
        workersByRole[w.id_role].push(w);
      }

      const incomingRoleIds = new Set(enrichedBudgets.map(b => b.id_role));

      // Proteksi 1: Cek apakah ada role yang dihapus padahal sudah ada pekerjanya
      for (const [rId, wList] of Object.entries(workersByRole)) {
        if (!incomingRoleIds.has(Number(rId)) && wList.length > 0) {
          await connection.rollback();
          connection.release();
          return res.status(400).json({
            success: false,
            message: `Role "${wList[0].nama_role}" tidak dapat dihapus dari blueprint karena sudah memiliki ${wList.length} pekerja yang ditugaskan.`
          });
        }
      }

      // Proteksi 2: Cek kuota dan kesesuaian rentang gaji untuk pekerja yang sudah ter-assign
      for (const eb of enrichedBudgets) {
        const assignedList = workersByRole[eb.id_role] || [];
        if (eb.kuota_slot < assignedList.length) {
          await connection.rollback();
          connection.release();
          return res.status(400).json({
            success: false,
            message: `Kuota slot untuk role "${eb.nama_role}" tidak boleh lebih kecil dari jumlah pekerja yang sudah terisi (${assignedList.length} pekerja).`
          });
        }
      }

      // Hapus role budget lama yang tidak ada di daftar baru (hanya yang tidak punya pekerja)
      const [oldBudgets] = await connection.query('SELECT id_role_budget, id_role FROM pekerjaan_role_budget WHERE id_pekerjaan = ?', [id]);
      for (const ob of oldBudgets) {
        if (!incomingRoleIds.has(ob.id_role)) {
          await connection.query('DELETE FROM pekerjaan_role_budget WHERE id_role_budget = ?', [ob.id_role_budget]);
        }
      }

      // Simpan / update role budget baru
      for (const eb of enrichedBudgets) {
        const existing = oldBudgets.find(b => b.id_role === eb.id_role);
        if (existing) {
          await connection.query(
            'UPDATE pekerjaan_role_budget SET kuota_slot = ?, gaji_min_bulanan = ?, gaji_max_bulanan = ? WHERE id_role_budget = ?',
            [eb.kuota_slot, eb.gaji_min_bulanan, eb.gaji_max_bulanan, existing.id_role_budget]
          );
        } else {
          await connection.query(
            'INSERT INTO pekerjaan_role_budget (id_pekerjaan, id_role, kuota_slot, gaji_min_bulanan, gaji_max_bulanan) VALUES (?, ?, ?, ?, ?)',
            [id, eb.id_role, eb.kuota_slot, eb.gaji_min_bulanan, eb.gaji_max_bulanan]
          );
        }
      }

      const totalSlotKuota = enrichedBudgets.reduce((sum, r) => sum + r.kuota_slot, 0);

      // Update kolom di tabel pekerjaan
      await connection.query(
        `UPDATE pekerjaan SET
          nama_pekerjaan = COALESCE(?, nama_pekerjaan),
          kode_pekerjaan = COALESCE(?, kode_pekerjaan),
          deskripsi = COALESCE(?, deskripsi),
          lokasi = COALESCE(?, lokasi),
          titik_lokasi = COALESCE(?, titik_lokasi),
          metode_lokasi = COALESCE(?, metode_lokasi),
          tanggal_mulai = COALESCE(?, tanggal_mulai),
          target_selesai = COALESCE(?, target_selesai),
          status = COALESCE(?, status),
          metode_penentuan = COALESCE(?, metode_penentuan),
          jenis_upah = COALESCE(?, jenis_upah),
          nominal_upah = COALESCE(?, nominal_upah),
          kuota_pekerja = ?,
          status_pengambilan = COALESCE(?, status_pengambilan),
          latitude = COALESCE(?, latitude),
          longitude = COALESCE(?, longitude),
          radius_meter = COALESCE(?, radius_meter),
          hari_kerja_per_bulan = COALESCE(?, hari_kerja_per_bulan),
          jam_kerja_per_hari = COALESCE(?, jam_kerja_per_hari),
          jam_masuk_standar = COALESCE(?, jam_masuk_standar),
          jam_pulang_standar = COALESCE(?, jam_pulang_standar),
          toleransi_terlambat_menit = COALESCE(?, toleransi_terlambat_menit),
          tanggal_cutoff = COALESCE(?, tanggal_cutoff),
          tanggal_pencairan = COALESCE(?, tanggal_pencairan),
          lembur_diizinkan = COALESCE(?, lembur_diizinkan),
          buffer_lembur_persen = COALESCE(?, buffer_lembur_persen)
        WHERE id_pekerjaan = ?`,
        [
          nama_pekerjaan, kode_pekerjaan, deskripsi, lokasi, finalTitik, metode_lokasi,
          tanggal_mulai, target_selesai, status, metode_penentuan,
          jenis_upah, nominal_upah, totalSlotKuota, status_pengambilan,
          latitude, longitude, radius_meter,
          hari_kerja_per_bulan, jam_kerja_per_hari, jam_masuk_standar, jam_pulang_standar,
          toleransi_terlambat_menit, tanggal_cutoff, tanggal_pencairan,
          lembur_diizinkan !== undefined ? (Number(lembur_diizinkan) === 1 ? 1 : 0) : null,
          buffer_lembur_persen, id
        ]
      );

      // Update penugasan jika dikirimkan list karyawan baru
      if (Array.isArray(id_karyawan_list)) {
        await connection.query("DELETE FROM penugasan WHERE id_pekerjaan = ? AND jenis_penugasan = 'admin' AND id_role_budget IS NULL", [id]);
        for (const idKar of id_karyawan_list) {
          if (idKar > 0) {
            await connection.query(
              `INSERT INTO penugasan (id_pekerjaan, id_karyawan, peran_tugas, jenis_penugasan, status_penugasan, status_baca) 
               VALUES (?, ?, 'Anggota Tim Pelaksana', 'admin', 'aktif', 'belum')`,
              [id, idKar]
            );
          }
        }
      }

      await connection.commit();
      connection.release();
      connection = null;

      return res.json({
        success: true,
        message: 'Pekerjaan dan blueprint role berhasil diperbarui',
        data: { id_pekerjaan: Number(id), kuota_pekerja: totalSlotKuota }
      });
    }

    // Alur Update Reguler
    await db.query(
      `UPDATE pekerjaan SET
        nama_pekerjaan = COALESCE(?, nama_pekerjaan),
        kode_pekerjaan = COALESCE(?, kode_pekerjaan),
        deskripsi = COALESCE(?, deskripsi),
        lokasi = COALESCE(?, lokasi),
        titik_lokasi = COALESCE(?, titik_lokasi),
        metode_lokasi = COALESCE(?, metode_lokasi),
        tanggal_mulai = COALESCE(?, tanggal_mulai),
        target_selesai = COALESCE(?, target_selesai),
        status = COALESCE(?, status),
        metode_penentuan = COALESCE(?, metode_penentuan),
        jenis_upah = COALESCE(?, jenis_upah),
        nominal_upah = COALESCE(?, nominal_upah),
        kuota_pekerja = ?,
        status_pengambilan = COALESCE(?, status_pengambilan),
        latitude = COALESCE(?, latitude),
        longitude = COALESCE(?, longitude),
        radius_meter = COALESCE(?, radius_meter),
        hari_kerja_per_bulan = COALESCE(?, hari_kerja_per_bulan),
        jam_kerja_per_hari = COALESCE(?, jam_kerja_per_hari),
        jam_masuk_standar = COALESCE(?, jam_masuk_standar),
        jam_pulang_standar = COALESCE(?, jam_pulang_standar),
        toleransi_terlambat_menit = COALESCE(?, toleransi_terlambat_menit),
        tanggal_cutoff = COALESCE(?, tanggal_cutoff),
        tanggal_pencairan = COALESCE(?, tanggal_pencairan),
        lembur_diizinkan = COALESCE(?, lembur_diizinkan),
        buffer_lembur_persen = COALESCE(?, buffer_lembur_persen)
      WHERE id_pekerjaan = ?`,
      [
        nama_pekerjaan, kode_pekerjaan, deskripsi, lokasi, finalTitik, metode_lokasi,
        tanggal_mulai, target_selesai, status, metode_penentuan,
        jenis_upah, nominal_upah, kuota_pekerja !== undefined ? (kuota_pekerja || null) : null, status_pengambilan,
        latitude, longitude, radius_meter,
        hari_kerja_per_bulan, jam_kerja_per_hari, jam_masuk_standar, jam_pulang_standar,
        toleransi_terlambat_menit, tanggal_cutoff, tanggal_pencairan,
        lembur_diizinkan !== undefined ? (Number(lembur_diizinkan) === 1 ? 1 : 0) : null,
        buffer_lembur_persen, id
      ]
    );

    // Update penugasan jika dikirimkan list karyawan baru
    if (Array.isArray(id_karyawan_list)) {
      await db.query("DELETE FROM penugasan WHERE id_pekerjaan = ? AND jenis_penugasan = 'admin' AND id_role_budget IS NULL", [id]);
      for (const idKar of id_karyawan_list) {
        if (idKar > 0) {
          await db.query(
            `INSERT INTO penugasan (id_pekerjaan, id_karyawan, peran_tugas, jenis_penugasan, status_penugasan, status_baca) 
             VALUES (?, ?, 'Anggota Tim Pelaksana', 'admin', 'aktif', 'belum')`,
            [id, idKar]
          );
        }
      }
    }

    return res.json({
      success: true,
      message: 'Pekerjaan berhasil diperbarui',
      data: { id_pekerjaan: Number(id) }
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    console.error('Error updatePekerjaan:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal memperbarui pekerjaan',
      error: error.message
    });
  }
}

// 6. Hapus Pekerjaan (Cascading Clean Delete)
async function deletePekerjaan(req, res) {
  try {
    const id = req.params.id || req.query.id_pekerjaan;

    if (!id) {
      return res.status(400).json({ success: false, message: 'ID Pekerjaan tidak valid' });
    }

    // 1. Bersihkan riwayat gaji penugasan (penugasan_gaji_riwayat)
    await db.query(`
      DELETE pgr FROM penugasan_gaji_riwayat pgr 
      INNER JOIN penugasan p ON pgr.id_penugasan = p.id_penugasan 
      WHERE p.id_pekerjaan = ?
    `, [id]);

    // 2. Bersihkan gaji yang terikat ke proyek ini
    await db.query('DELETE FROM gaji WHERE id_pekerjaan = ?', [id]);

    // 3. Bersihkan laporan pekerjaan & lokasi
    await db.query('DELETE FROM laporan_pekerjaan WHERE id_pekerjaan = ?', [id]);
    await db.query('DELETE FROM lokasi_kerja WHERE id_pekerjaan = ?', [id]);

    // 4. Bersihkan absensi & pengeluaran terkait proyek ini
    await db.query('DELETE FROM absensi WHERE id_pekerjaan = ?', [id]);
    await db.query('DELETE FROM pengeluaran WHERE id_pekerjaan = ?', [id]);

    // 5. Bersihkan penugasan & role budget proyek
    await db.query('DELETE FROM penugasan WHERE id_pekerjaan = ?', [id]);
    await db.query('DELETE FROM pekerjaan_role_budget WHERE id_pekerjaan = ?', [id]);

    // 6. Hapus master pekerjaan
    const [result] = await db.query('DELETE FROM pekerjaan WHERE id_pekerjaan = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Pekerjaan tidak ditemukan atau sudah dihapus' });
    }

    return res.json({
      success: true,
      message: 'Pekerjaan berhasil dihapus'
    });
  } catch (error) {
    console.error('Error deletePekerjaan:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Gagal menghapus pekerjaan',
      error: error.message
    });
  }
}

// 7. Ambil Pekerjaan Mandiri (Self-Assign)
async function ambilPekerjaan(req, res) {
  try {
    const id = req.params.id || req.body.id_pekerjaan || req.query.id_pekerjaan;
    const id_karyawan = req.user?.id_karyawan || req.body.id_karyawan;

    if (!id || !id_karyawan) {
      return res.status(400).json({
        success: false,
        message: 'ID Pekerjaan dan Identitas Karyawan wajib disertakan'
      });
    }

    const [jobRows] = await db.query('SELECT * FROM pekerjaan WHERE id_pekerjaan = ?', [id]);
    if (jobRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data pekerjaan tidak ditemukan' });
    }

    const job = jobRows[0];
    if (job.status === 'selesai') {
      return res.status(422).json({ success: false, message: 'Pekerjaan ini sudah selesai.' });
    }

    if (job.status_pengambilan === 'ditutup') {
      return res.status(422).json({
        success: false,
        message: 'Pengambilan mandiri untuk pekerjaan ini sedang ditutup oleh Admin.'
      });
    }

    // Validasi kuota pekerja aktif
    const kuota = job.kuota_pekerja !== null && job.kuota_pekerja !== '' && Number(job.kuota_pekerja) > 0 ? Number(job.kuota_pekerja) : null;
    if (kuota !== null) {
      const [countRows] = await db.query(
        'SELECT COUNT(DISTINCT id_karyawan) AS total FROM penugasan WHERE id_pekerjaan = ? AND (status_penugasan IS NULL OR status_penugasan = "aktif")',
        [id]
      );
      const totalAktif = Number(countRows[0]?.total || 0);
      if (totalAktif >= kuota) {
        return res.status(422).json({
          success: false,
          message: `Kuota pekerja untuk proyek ini sudah penuh (${totalAktif}/${kuota} pekerja).`
        });
      }
    }

    const [existing] = await db.query(
      'SELECT id_penugasan FROM penugasan WHERE id_pekerjaan = ? AND id_karyawan = ? AND (status_penugasan IS NULL OR status_penugasan = "aktif")',
      [id, id_karyawan]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Anda sudah bergabung dalam pekerjaan ini sebelumnya.'
      });
    }

    await db.query(
      `INSERT INTO penugasan (id_pekerjaan, id_karyawan, peran_tugas, jenis_penugasan, status_penugasan, status_baca)
       VALUES (?, ?, 'Pelaksana Mandiri', 'mandiri', 'aktif', 'sudah')`,
      [id, id_karyawan]
    );

    return res.json({
      success: true,
      message: 'Pekerjaan berhasil diambil! Selamat bertugas.'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal mengambil pekerjaan: ' + error.message,
      error: error.message
    });
  }
}

// 8. Buka / Tutup Pengambilan Mandiri
async function togglePengambilanPekerjaan(req, res) {
  try {
    const id = req.params.id || req.body.id_pekerjaan;
    const requestedStatus = req.body?.status;

    let newStatus = requestedStatus;
    if (!newStatus) {
      const [curr] = await db.query('SELECT status_pengambilan FROM pekerjaan WHERE id_pekerjaan = ?', [id]);
      newStatus = curr[0]?.status_pengambilan === 'ditutup' ? 'terbuka' : 'ditutup';
    }

    await db.query('UPDATE pekerjaan SET status_pengambilan = ? WHERE id_pekerjaan = ?', [newStatus, id]);

    return res.json({
      success: true,
      message: `Pengambilan mandiri berhasil diubah menjadi ${newStatus}`,
      data: { status_pengambilan: newStatus }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal mengubah status pengambilan pekerjaan',
      error: error.message
    });
  }
}

// 9. Ambil Daftar Pekerja pada Pekerjaan Tertentu
async function getPekerjaanPekerja(req, res) {
  try {
    const id = req.params.id || req.query.id_pekerjaan;
    const [workers] = await db.query(`
      SELECT 
        pn.id_penugasan,
        pn.id_karyawan,
        pn.peran_tugas,
        pn.jenis_penugasan,
        pn.status_penugasan,
        pn.status_karyawan,
        pn.status_baca,
        pn.id_role_budget,
        pn.tanggal_penugasan,
        pn.tanggal_selesai_tugas,
        k.nama,
        k.kode_karyawan,
        k.jabatan,
        k.email,
        k.nominal_upah
      FROM penugasan pn
      JOIN karyawan k ON pn.id_karyawan = k.id_karyawan
      WHERE pn.id_pekerjaan = ?
      ORDER BY pn.id_penugasan ASC
    `, [id]);

    return res.json({
      success: true,
      data: workers
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal memuat daftar pekerja',
      error: error.message
    });
  }
}

// 10. Tambah Pekerja ke Pekerjaan (Admin)
async function tambahPekerjaKePekerjaan(req, res) {
  try {
    const id = req.params.id || req.body.id_pekerjaan;
    const { id_karyawan, peran_tugas = 'Anggota Tim Pelaksana' } = req.body;

    if (!id || !id_karyawan) {
      return res.status(400).json({ success: false, message: 'ID Pekerjaan dan ID Karyawan wajib diisi' });
    }

    const [existing] = await db.query(
      'SELECT id_penugasan FROM penugasan WHERE id_pekerjaan = ? AND id_karyawan = ?',
      [id, id_karyawan]
    );

    if (existing.length > 0) {
      await db.query(
        'UPDATE penugasan SET status_penugasan = "aktif", peran_tugas = ? WHERE id_penugasan = ?',
        [peran_tugas, existing[0].id_penugasan]
      );
    } else {
      await db.query(
        `INSERT INTO penugasan (id_pekerjaan, id_karyawan, peran_tugas, jenis_penugasan, status_penugasan, status_baca)
         VALUES (?, ?, ?, 'admin', 'aktif', 'belum')`,
        [id, id_karyawan, peran_tugas]
      );
    }

    return res.json({
      success: true,
      message: 'Pekerja berhasil ditambahkan ke pekerjaan ini.'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal menambahkan pekerja: ' + error.message,
      error: error.message
    });
  }
}

// 11. Batalkan Penugasan Pekerja
async function batalkanPenugasanPekerja(req, res) {
  try {
    const { id, assignmentId } = req.params;
    const { alasan = '' } = req.body;

    await db.query(
      `UPDATE penugasan SET
        status_penugasan = 'dibatalkan',
        alasan_batal = ?,
        dibatalkan_pada = NOW(),
        dibatalkan_oleh = ?
      WHERE id_penugasan = ? AND id_pekerjaan = ?`,
      [alasan, req.user?.nama || 'Admin', assignmentId, id]
    );

    return res.json({
      success: true,
      message: 'Penugasan pekerja berhasil dibatalkan.'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal membatalkan penugasan',
      error: error.message
    });
  }
}

// 12. Update Status Pekerja di Pekerjaan
async function updatePekerjaanStatusPekerja(req, res) {
  try {
    const { id, karyawanId } = req.params;
    const { status, catatan = '' } = req.body;

    await db.query(
      `UPDATE penugasan SET
        status_karyawan = ?,
        catatan_admin = ?
      WHERE id_pekerjaan = ? AND id_karyawan = ?`,
      [status, catatan, id, karyawanId]
    );

    return res.json({
      success: true,
      message: 'Status kehadiran pekerja berhasil diperbarui.'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal memperbarui status pekerja',
      error: error.message
    });
  }
}

// 13. Ambil Laporan Progres / Akhir Pekerjaan
async function getPekerjaanLaporan(req, res) {
  try {
    const id = req.params.id || req.query.id_pekerjaan;
    const [reports] = await db.query(`
      SELECT lp.*, k.nama AS nama_karyawan, k.kode_karyawan, k.jabatan
      FROM laporan_pekerjaan lp
      LEFT JOIN karyawan k ON lp.id_karyawan = k.id_karyawan
      WHERE lp.id_pekerjaan = ?
      ORDER BY lp.id_laporan DESC
    `, [id]);

    return res.json({
      success: true,
      data: reports
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal memuat laporan pekerjaan',
      error: error.message
    });
  }
}

// 14. Kirim Laporan Progres / Akhir Pekerjaan
async function createPekerjaanLaporan(req, res) {
  try {
    const id = req.params.id || req.body.id_pekerjaan;
    const {
      id_karyawan,
      tipe_laporan = 'akhir',
      judul,
      keterangan,
      foto_dokumentasi = ''
    } = req.body;

    const workerId = id_karyawan || req.user?.id_karyawan;

    if (!id || !workerId || !judul) {
      return res.status(400).json({
        success: false,
        message: 'Pekerjaan, Karyawan pelapor, dan Judul laporan wajib diisi'
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const fotoSaved = saveBase64Image(foto_dokumentasi, 'absensi', 'laporan_');

    const [result] = await db.query(
      `INSERT INTO laporan_pekerjaan
        (id_pekerjaan, id_karyawan, tipe_laporan, judul, keterangan, foto_dokumentasi, status_persetujuan, tanggal_laporan)
       VALUES (?, ?, ?, ?, ?, ?, 'menunggu', ?)`,
      [id, workerId, tipe_laporan, judul, keterangan || '', fotoSaved || '', today]
    );

    return res.status(201).json({
      success: true,
      message: 'Laporan pekerjaan berhasil dikirim! Menunggu persetujuan Admin.',
      data: { id_laporan: result.insertId }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal mengirim laporan: ' + error.message,
      error: error.message
    });
  }
}

// 15. Setujui Laporan Pekerjaan
async function setujuiPekerjaanLaporan(req, res) {
  try {
    const { id } = req.params;
    const { catatan = '' } = req.body;

    const [rep] = await db.query('SELECT * FROM laporan_pekerjaan WHERE id_laporan = ?', [id]);
    if (rep.length === 0) {
      return res.status(404).json({ success: false, message: 'Laporan tidak ditemukan' });
    }

    await db.query(
      'UPDATE laporan_pekerjaan SET status_persetujuan = "disetujui", catatan_admin = ? WHERE id_laporan = ?',
      [catatan, id]
    );

    // Jika ini adalah laporan akhir penyelesaian proyek, tandai status pekerjaan menjadi 'selesai'
    if (rep[0].tipe_laporan === 'akhir') {
      await db.query('UPDATE pekerjaan SET status = "selesai" WHERE id_pekerjaan = ?', [rep[0].id_pekerjaan]);
    }

    return res.json({
      success: true,
      message: 'Laporan pekerjaan berhasil disetujui!'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal menyetujui laporan',
      error: error.message
    });
  }
}

// 16. Tolak Laporan Pekerjaan
async function tolakPekerjaanLaporan(req, res) {
  try {
    const { id } = req.params;
    const { catatan = '' } = req.body;

    await db.query(
      'UPDATE laporan_pekerjaan SET status_persetujuan = "ditolak", catatan_admin = ? WHERE id_laporan = ?',
      [catatan, id]
    );

    return res.json({
      success: true,
      message: 'Laporan pekerjaan ditolak.'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal menolak laporan',
      error: error.message
    });
  }
}

// ========================================================
// FITUR FASE 2: BLUEPRINT ROLE, BUDGET SUMMARY & KANDIDAT
// ========================================================

// 17. GET /api/pekerjaan/:id/blueprint
async function getPekerjaanBlueprint(req, res) {
  try {
    const id = req.params.id || req.query.id_pekerjaan;
    if (!id) {
      return res.status(400).json({ success: false, message: 'ID Pekerjaan tidak valid' });
    }

    const [jobRows] = await db.query('SELECT * FROM pekerjaan WHERE id_pekerjaan = ?', [id]);
    if (jobRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data pekerjaan tidak ditemukan' });
    }

    const job = formatJob(jobRows[0]);

    // Ambil daftar role budget yang sudah diset untuk proyek ini
    const [roleBudgets] = await db.query(`
      SELECT prb.id_role_budget, prb.id_pekerjaan, prb.id_role, mr.nama_role, mr.hierarchy_level,
             prb.kuota_slot, prb.gaji_min_bulanan, prb.gaji_max_bulanan
      FROM pekerjaan_role_budget prb
      JOIN master_role mr ON prb.id_role = mr.id_role
      WHERE prb.id_pekerjaan = ?
      ORDER BY mr.hierarchy_level ASC, prb.id_role_budget ASC
    `, [id]);

    // Ambil pekerja aktif pada tiap slot role budget
    const enrichedBudgets = [];
    for (const rb of roleBudgets) {
      const [workers] = await db.query(`
        SELECT pn.id_penugasan, pn.id_karyawan, k.nama, k.kode_karyawan, k.jabatan,
               COALESCE(pgr.jenis_upah, k.jenis_upah) AS jenis_upah,
               COALESCE(pgr.nominal_upah, k.nominal_upah) AS nominal_upah,
               COALESCE(
                 pgr.normalized_monthly,
                 CASE 
                   WHEN k.jenis_upah = 'per_jam' THEN k.nominal_upah * ? * ?
                   WHEN k.jenis_upah = 'per_hari' THEN k.nominal_upah * ?
                   WHEN k.jenis_upah = 'per_tahun' THEN k.nominal_upah / 12
                   ELSE k.nominal_upah
                 END
               ) AS normalized_monthly,
               pgr.effective_from
        FROM penugasan pn
        JOIN karyawan k ON pn.id_karyawan = k.id_karyawan
        LEFT JOIN penugasan_gaji_riwayat pgr ON pgr.id_penugasan = pn.id_penugasan AND pgr.effective_to IS NULL
        WHERE pn.id_role_budget = ? AND (pn.status_penugasan IS NULL OR pn.status_penugasan = 'aktif')
        ORDER BY pn.id_penugasan ASC
      `, [job.hari_kerja_per_bulan, job.jam_kerja_per_hari, job.hari_kerja_per_bulan, rb.id_role_budget]);

      const terisiSlot = workers.length;
      const sisaSlot = Math.max(0, Number(rb.kuota_slot) - terisiSlot);
      const konversiSatuan = convertMonthlyRangeToAllUnits(
        Number(rb.gaji_min_bulanan),
        Number(rb.gaji_max_bulanan),
        job.hari_kerja_per_bulan,
        job.jam_kerja_per_hari
      );

      enrichedBudgets.push({
        id_role_budget: Number(rb.id_role_budget),
        id_pekerjaan: Number(rb.id_pekerjaan),
        id_role: Number(rb.id_role),
        nama_role: rb.nama_role,
        hierarchy_level: Number(rb.hierarchy_level),
        kuota_slot: Number(rb.kuota_slot),
        terisi_slot: terisiSlot,
        sisa_slot: sisaSlot,
        is_slot_penuh: sisaSlot === 0,
        gaji_min_bulanan: Number(rb.gaji_min_bulanan),
        gaji_max_bulanan: Number(rb.gaji_max_bulanan),
        konversi_satuan: konversiSatuan,
        assigned_workers: workers
      });
    }

    return res.json({
      success: true,
      message: 'Blueprint role proyek berhasil dimuat',
      data: {
        id_pekerjaan: job.id_pekerjaan,
        kode_pekerjaan: job.kode_pekerjaan,
        nama_pekerjaan: job.nama_pekerjaan,
        status: job.status,
        tanggal_mulai: job.tanggal_mulai,
        target_selesai: job.target_selesai,
        hari_kerja_per_bulan: job.hari_kerja_per_bulan,
        jam_kerja_per_hari: job.jam_kerja_per_hari,
        jam_masuk_standar: job.jam_masuk_standar,
        jam_pulang_standar: job.jam_pulang_standar,
        toleransi_terlambat_menit: job.toleransi_terlambat_menit,
        tanggal_cutoff: job.tanggal_cutoff,
        tanggal_pencairan: job.tanggal_pencairan,
        lembur_diizinkan: job.lembur_diizinkan,
        buffer_lembur_persen: job.buffer_lembur_persen,
        total_kuota_pekerja: job.kuota_pekerja,
        role_budgets: enrichedBudgets
      }
    });
  } catch (error) {
    console.error('Error getPekerjaanBlueprint:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal memuat blueprint role proyek',
      error: error.message
    });
  }
}

// 18. PUT /api/pekerjaan/:id/blueprint
async function updatePekerjaanBlueprint(req, res) {
  let connection;
  try {
    const id = req.params.id || req.body.id_pekerjaan;
    if (!id) {
      return res.status(400).json({ success: false, message: 'ID Pekerjaan tidak valid' });
    }

    const { role_budgets } = req.body;
    if (!Array.isArray(role_budgets) || role_budgets.length === 0) {
      return res.status(400).json({ success: false, message: 'Daftar blueprint role tidak boleh kosong' });
    }

    const [jobRows] = await db.query('SELECT * FROM pekerjaan WHERE id_pekerjaan = ?', [id]);
    if (jobRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data pekerjaan tidak ditemukan' });
    }
    const job = formatJob(jobRows[0]);

    connection = await db.getConnection();
    await connection.beginTransaction();

    // Verifikasi role dari master_role
    const roleIds = role_budgets.map(r => Number(r.id_role)).filter(Boolean);
    const [roles] = await connection.query(
      `SELECT id_role, nama_role, hierarchy_level, is_active FROM master_role WHERE id_role IN (${roleIds.map(() => '?').join(',')})`,
      roleIds
    );

    const roleMap = new Map();
    roles.forEach(r => roleMap.set(Number(r.id_role), r));

    const enrichedBudgets = [];
    for (const rb of role_budgets) {
      const mr = roleMap.get(Number(rb.id_role));
      if (!mr || !mr.is_active) {
        await connection.rollback();
        connection.release();
        return res.status(400).json({
          success: false,
          message: `Role ID ${rb.id_role} tidak valid atau tidak aktif dalam Master Role`
        });
      }
      enrichedBudgets.push({
        ...rb,
        nama_role: mr.nama_role,
        hierarchy_level: Number(mr.hierarchy_level),
        kuota_slot: Number(rb.kuota_slot),
        gaji_min_bulanan: Number(rb.gaji_min_bulanan),
        gaji_max_bulanan: Number(rb.gaji_max_bulanan)
      });
    }

    // Validasi hierarki
    const hierarchyCheck = validateRoleBudgetsHierarchy(enrichedBudgets);
    if (!hierarchyCheck.valid) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ success: false, message: hierarchyCheck.message });
    }

    // Ambil pekerja aktif pada proyek ini untuk proteksi slot terisi
    const [assignedWorkers] = await connection.query(`
      SELECT pn.id_penugasan, pn.id_role_budget, pn.id_karyawan, k.nama, prb.id_role, mr.nama_role,
             COALESCE(
               pgr.normalized_monthly,
               CASE 
                 WHEN pgr.jenis_upah = 'per_jam' THEN pgr.nominal_upah * ? * ?
                 WHEN pgr.jenis_upah = 'per_hari' THEN pgr.nominal_upah * ?
                 WHEN pgr.jenis_upah = 'per_tahun' THEN pgr.nominal_upah / 12
                 ELSE pgr.nominal_upah
               END,
               CASE 
                 WHEN k.jenis_upah = 'per_jam' THEN k.nominal_upah * ? * ?
                 WHEN k.jenis_upah = 'per_hari' THEN k.nominal_upah * ?
                 WHEN k.jenis_upah = 'per_tahun' THEN k.nominal_upah / 12
                 ELSE k.nominal_upah
               END
             ) AS normalized_monthly
      FROM penugasan pn
      JOIN pekerjaan_role_budget prb ON pn.id_role_budget = prb.id_role_budget
      JOIN master_role mr ON prb.id_role = mr.id_role
      JOIN karyawan k ON pn.id_karyawan = k.id_karyawan
      LEFT JOIN penugasan_gaji_riwayat pgr ON pgr.id_penugasan = pn.id_penugasan AND pgr.effective_to IS NULL
      WHERE pn.id_pekerjaan = ? AND (pn.status_penugasan IS NULL OR pn.status_penugasan = 'aktif')
    `, [job.hari_kerja_per_bulan, job.jam_kerja_per_hari, job.hari_kerja_per_bulan, job.hari_kerja_per_bulan, job.jam_kerja_per_hari, job.hari_kerja_per_bulan, id]);

    const workersByRole = {};
    for (const w of assignedWorkers) {
      if (!workersByRole[w.id_role]) workersByRole[w.id_role] = [];
      workersByRole[w.id_role].push(w);
    }

    const incomingRoleIds = new Set(enrichedBudgets.map(b => b.id_role));

    // Proteksi 1: Cek role dihapus
    for (const [rId, wList] of Object.entries(workersByRole)) {
      if (!incomingRoleIds.has(Number(rId)) && wList.length > 0) {
        await connection.rollback();
        connection.release();
        return res.status(400).json({
          success: false,
          message: `Role "${wList[0].nama_role}" tidak dapat dihapus dari blueprint karena sudah memiliki ${wList.length} pekerja yang ditugaskan.`
        });
      }
    }

    // Proteksi 2: Cek kuota dan rentang gaji
    for (const eb of enrichedBudgets) {
      const assignedList = workersByRole[eb.id_role] || [];
      if (eb.kuota_slot < assignedList.length) {
        await connection.rollback();
        connection.release();
        return res.status(400).json({
          success: false,
          message: `Kuota slot untuk role "${eb.nama_role}" tidak boleh lebih kecil dari jumlah pekerja yang sudah terisi (${assignedList.length} pekerja).`
        });
      }
    }

    // Sinkronisasi tabel pekerjaan_role_budget
    const [oldBudgets] = await connection.query('SELECT id_role_budget, id_role FROM pekerjaan_role_budget WHERE id_pekerjaan = ?', [id]);
    for (const ob of oldBudgets) {
      if (!incomingRoleIds.has(ob.id_role)) {
        await connection.query('DELETE FROM pekerjaan_role_budget WHERE id_role_budget = ?', [ob.id_role_budget]);
      }
    }

    for (const eb of enrichedBudgets) {
      const existing = oldBudgets.find(b => b.id_role === eb.id_role);
      if (existing) {
        await connection.query(
          'UPDATE pekerjaan_role_budget SET kuota_slot = ?, gaji_min_bulanan = ?, gaji_max_bulanan = ? WHERE id_role_budget = ?',
          [eb.kuota_slot, eb.gaji_min_bulanan, eb.gaji_max_bulanan, existing.id_role_budget]
        );
      } else {
        await connection.query(
          'INSERT INTO pekerjaan_role_budget (id_pekerjaan, id_role, kuota_slot, gaji_min_bulanan, gaji_max_bulanan) VALUES (?, ?, ?, ?, ?)',
          [id, eb.id_role, eb.kuota_slot, eb.gaji_min_bulanan, eb.gaji_max_bulanan]
        );
      }
    }

    const totalSlotKuota = enrichedBudgets.reduce((sum, r) => sum + r.kuota_slot, 0);
    await connection.query('UPDATE pekerjaan SET kuota_pekerja = ? WHERE id_pekerjaan = ?', [totalSlotKuota, id]);

    await connection.commit();
    connection.release();
    connection = null;

    return res.json({
      success: true,
      message: 'Blueprint role proyek berhasil diperbarui',
      data: {
        id_pekerjaan: Number(id),
        total_kuota_pekerja: totalSlotKuota,
        role_budgets: enrichedBudgets
      }
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    console.error('Error updatePekerjaanBlueprint:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal memperbarui blueprint role proyek',
      error: error.message
    });
  }
}

// 19. GET /api/pekerjaan/:id/budget-summary
async function getPekerjaanBudgetSummary(req, res) {
  try {
    const id = req.params.id || req.query.id_pekerjaan;
    if (!id) {
      return res.status(400).json({ success: false, message: 'ID Pekerjaan tidak valid' });
    }

    const [jobRows] = await db.query('SELECT * FROM pekerjaan WHERE id_pekerjaan = ?', [id]);
    if (jobRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data pekerjaan tidak ditemukan' });
    }

    const job = formatJob(jobRows[0]);

    // 1. Parameter Durasi
    const { effectiveWorkingDays, faktor_bulan } = calculateEffectiveWorkingDays(
      job.tanggal_mulai,
      job.target_selesai,
      job.hari_kerja_per_bulan
    );

    // Ambil blueprint role
    const [roleBudgets] = await db.query(`
      SELECT prb.id_role_budget, prb.id_role, mr.nama_role, mr.hierarchy_level,
             prb.kuota_slot, prb.gaji_min_bulanan, prb.gaji_max_bulanan
      FROM pekerjaan_role_budget prb
      JOIN master_role mr ON prb.id_role = mr.id_role
      WHERE prb.id_pekerjaan = ?
      ORDER BY mr.hierarchy_level ASC
    `, [id]);

    // 2. Lapis 1 — Budget Rencana (Blueprint)
    let totalMin = 0;
    let totalMax = 0;
    let totalMidpoint = 0;
    const rincianRole = [];

    for (const rb of roleBudgets) {
      const kuota = Number(rb.kuota_slot);
      const minB = Number(rb.gaji_min_bulanan);
      const maxB = Number(rb.gaji_max_bulanan);

      const estMin = Number((kuota * minB * faktor_bulan).toFixed(2));
      const estMax = Number((kuota * maxB * faktor_bulan).toFixed(2));
      const estMid = Number(((estMin + estMax) / 2).toFixed(2));

      totalMin += estMin;
      totalMax += estMax;
      totalMidpoint += estMid;

      rincianRole.push({
        id_role_budget: Number(rb.id_role_budget),
        id_role: Number(rb.id_role),
        nama_role: rb.nama_role,
        hierarchy_level: Number(rb.hierarchy_level),
        kuota_slot: kuota,
        gaji_min_bulanan: minB,
        gaji_max_bulanan: maxB,
        estimasi_min: estMin,
        estimasi_max: estMax,
        estimasi_midpoint: estMid
      });
    }

    totalMin = Number(totalMin.toFixed(2));
    totalMax = Number(totalMax.toFixed(2));
    totalMidpoint = Number(totalMidpoint.toFixed(2));

    let bufferMin = 0;
    let bufferMax = 0;
    let bufferMidpoint = 0;

    if (job.lembur_diizinkan === 1) {
      const pct = job.buffer_lembur_persen / 100;
      bufferMin = Number((totalMin * pct).toFixed(2));
      bufferMax = Number((totalMax * pct).toFixed(2));
      bufferMidpoint = Number((totalMidpoint * pct).toFixed(2));
    }

    const grandTotalMin = Number((totalMin + bufferMin).toFixed(2));
    const grandTotalMax = Number((totalMax + bufferMax).toFixed(2));
    const grandTotalMidpoint = Number((totalMidpoint + bufferMidpoint).toFixed(2));

    // 3. Lapis 2 — Komitmen Gaji Terpakai (Setelah Assign)
    const [assignedWorkers] = await db.query(`
      SELECT pn.id_penugasan, pn.id_karyawan, pn.tanggal_penugasan, pn.tanggal_selesai_tugas, pn.peran_tugas,
             k.nama, k.kode_karyawan, k.jenis_upah AS k_jenis_upah, k.nominal_upah AS k_nominal_upah,
             pgr.jenis_upah AS r_jenis_upah, pgr.nominal_upah AS r_nominal_upah, pgr.normalized_monthly, pgr.effective_from
      FROM penugasan pn
      JOIN karyawan k ON pn.id_karyawan = k.id_karyawan
      LEFT JOIN penugasan_gaji_riwayat pgr ON pgr.id_penugasan = pn.id_penugasan AND pgr.effective_to IS NULL
      WHERE pn.id_pekerjaan = ? AND (pn.status_penugasan IS NULL OR pn.status_penugasan = 'aktif')
      ORDER BY pn.id_penugasan ASC
    `, [id]);

    let totalKomitmen = 0;
    const rincianKaryawan = [];

    for (const w of assignedWorkers) {
      // Periode efektif karyawan
      const startEff = w.tanggal_penugasan || job.tanggal_mulai;
      const endEff = w.tanggal_selesai_tugas || job.target_selesai;

      const { effectiveWorkingDays: empDays } = calculateEffectiveWorkingDays(startEff, endEff, job.hari_kerja_per_bulan);

      const effJenis = w.r_jenis_upah || w.k_jenis_upah || 'per_jam';
      const effNominal = (w.r_nominal_upah !== undefined && w.r_nominal_upah !== null) ? Number(w.r_nominal_upah) : Number(w.k_nominal_upah || 0);

      const komitmenIndividu = calculateIndividualCommitment(
        effJenis,
        effNominal,
        empDays,
        job.hari_kerja_per_bulan,
        job.jam_kerja_per_hari
      );

      totalKomitmen += komitmenIndividu;

      const normMonthly = w.normalized_monthly
        ? Number(w.normalized_monthly)
        : normalizeToMonthly(effJenis, effNominal, job.hari_kerja_per_bulan, job.jam_kerja_per_hari);

      rincianKaryawan.push({
        id_penugasan: Number(w.id_penugasan),
        id_karyawan: Number(w.id_karyawan),
        nama: w.nama,
        kode_karyawan: w.kode_karyawan,
        peran_tugas: w.peran_tugas,
        jenis_upah: effJenis,
        nominal_upah: effNominal,
        normalized_monthly: normMonthly,
        start_eff: startEff,
        end_eff: endEff,
        effective_days: empDays,
        komitmen: komitmenIndividu
      });
    }

    totalKomitmen = Number(totalKomitmen.toFixed(2));

    // 4. Lapis 3 — Realisasi Sudah Dibayar
    // Ambil sesi absensi yang telah disetujui pada proyek ini
    const [absensiSessions] = await db.query(`
      SELECT a.id_karyawan, DATE_FORMAT(a.tanggal, '%Y-%m') AS periode,
             COALESCE(SUM(${sqlDurasi}), 0) AS total_jam_proyek,
             COUNT(DISTINCT a.tanggal) AS total_hari_proyek
      FROM absensi a
      WHERE a.id_pekerjaan = ? AND a.status_verifikasi = 'disetujui' AND a.jam_pulang IS NOT NULL
      GROUP BY a.id_karyawan, DATE_FORMAT(a.tanggal, '%Y-%m')
    `, [id]);

    let totalRealisasiDibayar = 0;
    let hasRealization = false;

    for (const sess of absensiSessions) {
      const [gajiRows] = await db.query(
        'SELECT id_gaji, total_upah, gaji_bersih, total_dibayar FROM gaji WHERE id_karyawan = ? AND periode = ?',
        [sess.id_karyawan, sess.periode]
      );
      if (gajiRows.length > 0) {
        const g = gajiRows[0];
        const dibayar = Number(g.total_dibayar || 0);
        if (dibayar > 0) {
          hasRealization = true;
          const upahTotal = Number(g.total_upah || g.gaji_bersih || 1);
          // Ambil upah karyawan proyek ini pada periode terkait
          const [totalKaryawanAbsPeriode] = await db.query(`
            SELECT COALESCE(SUM(${sqlDurasi}), 0) AS total_jam
            FROM absensi a
            WHERE a.id_karyawan = ? AND DATE_FORMAT(a.tanggal, '%Y-%m') = ? AND a.status_verifikasi = 'disetujui' AND a.jam_pulang IS NOT NULL
          `, [sess.id_karyawan, sess.periode]);
          const totalJamSemuaProyek = Number(totalKaryawanAbsPeriode[0]?.total_jam || sess.total_jam_proyek || 1);
          const ratio = totalJamSemuaProyek > 0 ? (Number(sess.total_jam_proyek) / totalJamSemuaProyek) : 1;
          totalRealisasiDibayar += dibayar * Math.min(1, Math.max(0, ratio));
        }
      }
    }

    totalRealisasiDibayar = Number(totalRealisasiDibayar.toFixed(2));
    const sumberRealisasi = hasRealization
      ? 'Dihitung proporsional dari total_dibayar pada tabel gaji & pembayaran_gaji berdasarkan absensi disetujui pada proyek ini'
      : 'Belum ada pembayaran gaji tercatat (pembayaran_gaji / gaji.total_dibayar) untuk sesi kerja proyek ini';

    // 5. Status Budget & Persentase Pemakaian
    let statusBudget = 'BELUM_ADA_BLUEPRINT';
    let persentasePemakaian = 0;

    if (roleBudgets.length > 0) {
      const targetPlafon = grandTotalMax > 0 ? grandTotalMax : totalMax;
      persentasePemakaian = targetPlafon > 0 ? Number(((totalKomitmen / targetPlafon) * 100).toFixed(2)) : 0;

      if (totalKomitmen < totalMin) {
        statusBudget = 'UNDER_MIN';
      } else if (totalKomitmen <= grandTotalMax) {
        statusBudget = 'IN_BUDGET';
      } else {
        statusBudget = 'OVER_BUDGET';
      }
    }

    return res.json({
      success: true,
      message: 'Ringkasan budget proyek berhasil dihitung',
      data: {
        parameter_durasi: {
          tanggal_mulai: job.tanggal_mulai,
          target_selesai: job.target_selesai,
          hari_kerja_per_bulan: job.hari_kerja_per_bulan,
          jam_kerja_per_hari: job.jam_kerja_per_hari,
          total_hari_kerja_efektif: effectiveWorkingDays,
          faktor_bulan: faktor_bulan
        },
        lapis_1_rencana: {
          rincian_role: rincianRole,
          total_min: totalMin,
          total_max: totalMax,
          total_midpoint: totalMidpoint,
          gaji_pokok: {
            total_min: totalMin,
            total_max: totalMax,
            total_midpoint: totalMidpoint
          },
          buffer_lembur: {
            lembur_diizinkan: job.lembur_diizinkan,
            buffer_lembur_persen: job.buffer_lembur_persen,
            buffer_min: bufferMin,
            buffer_max: bufferMax,
            buffer_midpoint: bufferMidpoint
          },
          grand_total: {
            grand_total_min: grandTotalMin,
            grand_total_max: grandTotalMax,
            grand_total_midpoint: grandTotalMidpoint
          }
        },
        lapis_2_komitmen: {
          total_komitmen: totalKomitmen,
          jumlah_pekerja_aktif: assignedWorkers.length,
          rincian_karyawan: rincianKaryawan
        },
        lapis_3_realisasi: {
          total_realisasi_dibayar: totalRealisasiDibayar,
          sumber_realisasi: sumberRealisasi
        },
        status_budget: statusBudget,
        persentase_pemakaian: persentasePemakaian
      }
    });
  } catch (error) {
    console.error('Error getPekerjaanBudgetSummary:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal menghitung ringkasan budget proyek',
      error: error.message
    });
  }
}

// 20. GET /api/pekerjaan/:id/kandidat-karyawan
async function getPekerjaanKandidatKaryawan(req, res) {
  try {
    const id = req.params.id || req.query.id_pekerjaan;
    if (!id) {
      return res.status(400).json({ success: false, message: 'ID Pekerjaan tidak valid' });
    }

    const [jobRows] = await db.query('SELECT * FROM pekerjaan WHERE id_pekerjaan = ?', [id]);
    if (jobRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data pekerjaan tidak ditemukan' });
    }
    const job = formatJob(jobRows[0]);

    // Ambil seluruh karyawan aktif
    const [karyawanList] = await db.query(`
      SELECT id_karyawan, kode_karyawan, nama, jabatan, email, jenis_upah, nominal_upah, status
      FROM karyawan
      WHERE status = 'aktif'
      ORDER BY nama ASC
    `);

    // Karyawan yang sudah bergabung pada proyek ini
    const [currentAssignees] = await db.query(
      'SELECT id_karyawan FROM penugasan WHERE id_pekerjaan = ? AND (status_penugasan IS NULL OR status_penugasan = "aktif")',
      [id]
    );
    const currentJoinedSet = new Set(currentAssignees.map(a => Number(a.id_karyawan)));

    // Konflik jadwal pada proyek lain yang belum selesai dan tanggalnya bertabrakan
    const [conflictRows] = await db.query(`
      SELECT pn.id_karyawan, p.id_pekerjaan, p.kode_pekerjaan, p.nama_pekerjaan, p.status,
             COALESCE(pn.tanggal_penugasan, p.tanggal_mulai) AS tanggal_mulai,
             COALESCE(pn.tanggal_selesai_tugas, p.target_selesai) AS tanggal_selesai
      FROM penugasan pn
      JOIN pekerjaan p ON pn.id_pekerjaan = p.id_pekerjaan
      WHERE (pn.status_penugasan IS NULL OR pn.status_penugasan = 'aktif')
        AND p.status <> 'selesai'
        AND p.id_pekerjaan <> ?
        AND (? IS NULL OR COALESCE(pn.tanggal_selesai_tugas, p.target_selesai) >= ?)
        AND (? IS NULL OR COALESCE(pn.tanggal_penugasan, p.tanggal_mulai) <= ?)
    `, [id, job.tanggal_mulai, job.tanggal_mulai, job.target_selesai, job.target_selesai]);

    const conflictMap = {};
    for (const c of conflictRows) {
      const kId = Number(c.id_karyawan);
      if (!conflictMap[kId]) conflictMap[kId] = [];
      conflictMap[kId].push({
        id_pekerjaan: Number(c.id_pekerjaan),
        kode_pekerjaan: c.kode_pekerjaan,
        nama_pekerjaan: c.nama_pekerjaan,
        status: c.status,
        tanggal_mulai: c.tanggal_mulai,
        tanggal_selesai: c.tanggal_selesai
      });
    }

    const candidates = karyawanList.map(k => {
      const kId = Number(k.id_karyawan);
      const conflicts = conflictMap[kId] || [];
      const alreadyJoined = currentJoinedSet.has(kId);
      const isAvailable = conflicts.length === 0;

      return {
        id_karyawan: kId,
        kode_karyawan: k.kode_karyawan,
        nama: k.nama,
        jabatan: k.jabatan,
        email: k.email,
        jenis_upah: k.jenis_upah,
        nominal_upah: Number(k.nominal_upah || 0),
        status: k.status,
        sudah_di_proyek_ini: alreadyJoined,
        available: isAvailable,
        konflik: conflicts
      };
    });

    return res.json({
      success: true,
      message: 'Daftar kandidat karyawan berhasil dimuat',
      data: candidates
    });
  } catch (error) {
    console.error('Error getPekerjaanKandidatKaryawan:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal memuat daftar kandidat karyawan',
      error: error.message
    });
  }
}

module.exports = {
  getAllPekerjaan,
  getPekerjaanById,
  getPekerjaanTersedia,
  createPekerjaan,
  updatePekerjaan,
  deletePekerjaan,
  ambilPekerjaan,
  togglePengambilanPekerjaan,
  getPekerjaanPekerja,
  tambahPekerjaKePekerjaan,
  batalkanPenugasanPekerja,
  updatePekerjaanStatusPekerja,
  getPekerjaanLaporan,
  createPekerjaanLaporan,
  setujuiPekerjaanLaporan,
  tolakPekerjaanLaporan,
  // Ekspor Fitur Fase 2
  getPekerjaanBlueprint,
  updatePekerjaanBlueprint,
  getPekerjaanBudgetSummary,
  getPekerjaanKandidatKaryawan
};
