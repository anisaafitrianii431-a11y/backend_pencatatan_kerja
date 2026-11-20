const db = require('../config/database');
const { saveBase64Image } = require('../utils/uploadHelper');

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

function formatJob(row) {
  if (!row) return null;
  const kuota = row.kuota_pekerja !== null && row.kuota_pekerja !== '' && Number(row.kuota_pekerja) > 0 ? Number(row.kuota_pekerja) : null;
  const totalPekerja = Number(row.total_pekerja || row.total_pekerja_aktif || 0);
  const isUnlimited = kuota === null;

  return {
    ...row,
    id_pekerjaan: Number(row.id_pekerjaan),
    kuota_pekerja: kuota,
    total_pekerja: totalPekerja,
    total_pekerja_aktif: totalPekerja,
    is_unlimited_kuota: isUnlimited,
    sisa_slot: isUnlimited ? null : Math.max(0, kuota - totalPekerja),
    is_kuota_penuh: !isUnlimited && totalPekerja >= kuota,
    radius_meter: Number(row.radius_meter || 100),
    nominal_upah: Number(row.nominal_upah || 0),
    latitude: row.latitude ? String(row.latitude) : '',
    longitude: row.longitude ? String(row.longitude) : '',
    titik_lokasi: row.titik_lokasi || (row.latitude && row.longitude ? `${row.latitude}, ${row.longitude}` : ''),
    nama_karyawan_list: row.nama_karyawan_list || '-',
    id_karyawan_list: row.id_karyawan_list
      ? (Array.isArray(row.id_karyawan_list) ? row.id_karyawan_list : String(row.id_karyawan_list).split(',').map(Number))
      : []
  };
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
    }

    if (action === 'tersedia') {
      return getPekerjaanTersedia(req, res);
    }

    if (action === 'ambil') {
      return ambilPekerjaan(req, res);
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

      // Fallback jika belum ditugaskan pekerjaan spesifik: tampilkan pekerjaan yang sedang aktif
      const [activeRows] = await db.query(`
        SELECT p.*,
          NULL AS id_penugasan,
          'Anggota Tim' AS peran_saya,
          'admin' AS jenis_penugasan,
          'sudah' AS status_baca,
          NULL AS tanggal_penugasan,
          (SELECT COUNT(DISTINCT pnx.id_karyawan) FROM penugasan pnx WHERE pnx.id_pekerjaan = p.id_pekerjaan AND (pnx.status_penugasan IS NULL OR pnx.status_penugasan = 'aktif')) AS total_pekerja,
          0 AS jam_kerja_saya,
          0 AS pengeluaran_saya
        FROM pekerjaan p
        WHERE p.status = 'berjalan'
        ORDER BY p.id_pekerjaan DESC
      `);

      return res.json({
        success: true,
        message: 'Daftar pekerjaan aktif berhasil dimuat (Karyawan)',
        data: activeRows.map(formatJob)
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
      SELECT pn.id_penugasan, pn.id_karyawan, pn.peran_tugas, pn.jenis_penugasan, pn.status_karyawan, pn.status_penugasan, k.nama, k.jabatan, k.kode_karyawan
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

// 4. Tambah Pekerjaan Baru
async function createPekerjaan(req, res) {
  try {
    const {
      nama_pekerjaan,
      deskripsi = '',
      lokasi = '',
      titik_lokasi = '',
      metode_lokasi = 'titik',
      tanggal_mulai = null,
      target_selesai = null,
      status = 'belum_mulai',
      metode_penentuan = 'terbuka',
      jenis_upah = 'per_jam',
      nominal_upah = 0,
      kuota_pekerja = null,
      status_pengambilan = 'terbuka',
      latitude = null,
      longitude = null,
      radius_meter = 100,
      id_karyawan_list = []
    } = req.body;

    if (!nama_pekerjaan) {
      return res.status(400).json({
        success: false,
        message: 'Nama pekerjaan wajib diisi'
      });
    }

    let finalTitik = titik_lokasi;
    if (!finalTitik && latitude && longitude) {
      finalTitik = `${latitude}, ${longitude}`;
    }

    const [result] = await db.query(
      `INSERT INTO pekerjaan 
        (nama_pekerjaan, deskripsi, lokasi, titik_lokasi, metode_lokasi, tanggal_mulai, target_selesai, status, metode_penentuan, jenis_upah, nominal_upah, kuota_pekerja, status_pengambilan, latitude, longitude, radius_meter)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nama_pekerjaan, deskripsi, lokasi, finalTitik || null, metode_lokasi,
        tanggal_mulai || null, target_selesai || null, status, metode_penentuan,
        jenis_upah, nominal_upah, kuota_pekerja || null, status_pengambilan,
        latitude || null, longitude || null, radius_meter || 100
      ]
    );

    const idPekerjaan = result.insertId;

    // Jika metode langsung, masukkan karyawan terpilih ke tabel penugasan
    const empIds = Array.isArray(id_karyawan_list) ? id_karyawan_list : (id_karyawan_list ? String(id_karyawan_list).split(',').map(Number) : []);
    for (const idKar of empIds) {
      if (idKar > 0) {
        await db.query(
          `INSERT INTO penugasan (id_pekerjaan, id_karyawan, peran_tugas, jenis_penugasan, status_baca, status_penugasan) 
           VALUES (?, ?, 'Anggota Tim Pelaksana', 'admin', 'belum', 'aktif')`,
          [idPekerjaan, idKar]
        );
        // Sinkronkan upah jika nominal > 0
        if (Number(nominal_upah) > 0) {
          await db.query(
            'UPDATE karyawan SET jenis_upah = ?, nominal_upah = ?, tarif_per_jam = CASE WHEN ? = "per_jam" THEN ? ELSE tarif_per_jam END WHERE id_karyawan = ?',
            [jenis_upah, nominal_upah, jenis_upah, nominal_upah, idKar]
          );
        }
      }
    }

    return res.status(201).json({
      success: true,
      message: 'Pekerjaan berhasil dibuat',
      data: {
        id_pekerjaan: idPekerjaan,
        nama_pekerjaan,
        status,
        metode_penentuan
      }
    });
  } catch (error) {
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
  try {
    const id = req.params.id || req.body.id_pekerjaan;
    if (!id) {
      return res.status(400).json({ success: false, message: 'ID Pekerjaan wajib diisi' });
    }

    const {
      nama_pekerjaan,
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
      id_karyawan_list
    } = req.body;

    let finalTitik = titik_lokasi;
    if (!finalTitik && latitude && longitude) {
      finalTitik = `${latitude}, ${longitude}`;
    }

    await db.query(
      `UPDATE pekerjaan SET
        nama_pekerjaan = COALESCE(?, nama_pekerjaan),
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
        radius_meter = COALESCE(?, radius_meter)
      WHERE id_pekerjaan = ?`,
      [
        nama_pekerjaan, deskripsi, lokasi, finalTitik, metode_lokasi,
        tanggal_mulai, target_selesai, status, metode_penentuan,
        jenis_upah, nominal_upah, kuota_pekerja || null, status_pengambilan,
        latitude, longitude, radius_meter, id
      ]
    );

    // Update penugasan jika dikirimkan list karyawan baru
    if (Array.isArray(id_karyawan_list)) {
      await db.query("DELETE FROM penugasan WHERE id_pekerjaan = ? AND jenis_penugasan = 'admin'", [id]);
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
    console.error('Error updatePekerjaan:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal memperbarui pekerjaan',
      error: error.message
    });
  }
}

// 6. Hapus Pekerjaan
async function deletePekerjaan(req, res) {
  try {
    const id = req.params.id || req.query.id_pekerjaan;
    const force = req.query.force === '1' || req.body?.force === true;

    if (!id) {
      return res.status(400).json({ success: false, message: 'ID Pekerjaan tidak valid' });
    }

    const [absRows] = await db.query('SELECT COUNT(*) AS total FROM absensi WHERE id_pekerjaan = ?', [id]);
    const [pengRows] = await db.query('SELECT COUNT(*) AS total FROM pengeluaran WHERE id_pekerjaan = ?', [id]);
    const totalAbs = absRows[0].total || 0;
    const totalPeng = pengRows[0].total || 0;

    if ((totalAbs > 0 || totalPeng > 0) && !force) {
      return res.status(400).json({
        success: false,
        message: `Pekerjaan ini memiliki riwayat ${totalAbs} sesi absensi dan ${totalPeng} pengeluaran. Ubah status menjadi Selesai atau hapus paksa jika ingin membersihkannya.`,
        has_history: true,
        total_absensi: totalAbs,
        total_pengeluaran: totalPeng
      });
    }

    if (force) {
      await db.query('DELETE FROM absensi WHERE id_pekerjaan = ?', [id]);
      await db.query('DELETE FROM pengeluaran WHERE id_pekerjaan = ?', [id]);
    }

    await db.query('DELETE FROM penugasan WHERE id_pekerjaan = ?', [id]);
    await db.query('DELETE FROM pekerjaan WHERE id_pekerjaan = ?', [id]);

    return res.json({
      success: true,
      message: 'Pekerjaan berhasil dihapus'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal menghapus pekerjaan',
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
  tolakPekerjaanLaporan
};
