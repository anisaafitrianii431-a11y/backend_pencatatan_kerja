const db = require('../config/database');

const sqlDurasi = `
  CASE 
    WHEN a.jam_pulang IS NOT NULL AND a.jam_pulang >= a.jam_masuk 
      THEN ROUND(TIME_TO_SEC(TIMEDIFF(a.jam_pulang, a.jam_masuk)) / 3600, 2)
    WHEN a.jam_pulang IS NOT NULL AND a.jam_pulang < a.jam_masuk 
      THEN ROUND((TIME_TO_SEC(TIMEDIFF(a.jam_pulang, a.jam_masuk)) + 86400) / 3600, 2)
    ELSE 0 
  END
`;

async function getDashboardRekap(req, res) {
  try {
    const type = req.query.type || 'dashboard';
    const isWorker = req.user?.peran === 'karyawan' && !req.query.admin_view;
    const kId = isWorker ? req.user.id_karyawan : (req.query.id_karyawan ? parseInt(req.query.id_karyawan, 10) : null);
    const thisMonth = new Date().toISOString().slice(0, 7);

    // ==========================================
    // 1. TIPE: DASHBOARD STATS
    // ==========================================
    if (type === 'dashboard') {
      if (isWorker && kId) {
        // Dashboard Karyawan
        const [attRow] = await db.query(`
          SELECT 
            COALESCE(SUM(CASE WHEN a.status_verifikasi = 'disetujui' THEN ${sqlDurasi} ELSE 0 END), 0) AS total_jam_disetujui,
            COALESCE(SUM(CASE WHEN a.status_verifikasi = 'menunggu' THEN ${sqlDurasi} ELSE 0 END), 0) AS total_jam_menunggu,
            COUNT(DISTINCT a.id_pekerjaan) AS total_proyek
          FROM absensi a
          WHERE a.id_karyawan = ? AND a.jam_pulang IS NOT NULL AND a.tanggal LIKE ?
        `, [kId, `${thisMonth}%`]);

        const [pengRow] = await db.query(`
          SELECT COALESCE(SUM(nominal), 0) AS total_pengeluaran
          FROM pengeluaran
          WHERE id_karyawan = ? AND status_verifikasi = 'disetujui' AND tanggal LIKE ?
        `, [kId, `${thisMonth}%`]);

        const tarif = Number(req.user?.tarif_per_jam || req.user?.nominal_upah || 0);
        const jamDisetujui = Number(attRow[0]?.total_jam_disetujui || 0);

        return res.json({
          success: true,
          message: 'Dashboard stats karyawan berhasil dimuat',
          data: {
            total_jam_disetujui: jamDisetujui,
            total_jam_menunggu: Number(attRow[0]?.total_jam_menunggu || 0),
            total_proyek_bulan_ini: Number(attRow[0]?.total_proyek || 0),
            total_pengeluaran_bulan_ini: Number(pengRow[0]?.total_pengeluaran || 0),
            estimasi_upah_bulan_ini: jamDisetujui * tarif
          }
        });
      }

      // Dashboard Admin
      const [karyawanCount] = await db.query("SELECT COUNT(*) AS total FROM karyawan WHERE status = 'aktif'");
      const [pekerjaanAktif] = await db.query("SELECT COUNT(*) AS total FROM pekerjaan WHERE status = 'berjalan'");
      const [pekerjaanTotal] = await db.query("SELECT COUNT(*) AS total FROM pekerjaan");
      const [absensiMenunggu] = await db.query("SELECT COUNT(*) AS total FROM absensi WHERE status_verifikasi = 'menunggu'");
      const [pengeluaranMenunggu] = await db.query("SELECT COUNT(*) AS total FROM pengeluaran WHERE status_verifikasi = 'menunggu'");

      const [jamSum] = await db.query(`
        SELECT COALESCE(SUM(${sqlDurasi}), 0) AS total
        FROM absensi a
        WHERE a.status_verifikasi = 'disetujui' AND a.jam_pulang IS NOT NULL AND a.tanggal LIKE ?
      `, [`${thisMonth}%`]);

      const [pengSum] = await db.query(`
        SELECT COALESCE(SUM(nominal), 0) AS total
        FROM pengeluaran
        WHERE status_verifikasi = 'disetujui' AND tanggal LIKE ?
      `, [`${thisMonth}%`]);

      return res.json({
        success: true,
        message: 'Dashboard stats eksekutif berhasil dimuat (Admin)',
        data: {
          total_pekerja: karyawanCount[0]?.total || 0,
          total_karyawan: karyawanCount[0]?.total || 0,
          pekerjaan_aktif: pekerjaanAktif[0]?.total || 0,
          total_pekerjaan: pekerjaanTotal[0]?.total || 0,
          absensi_menunggu: absensiMenunggu[0]?.total || 0,
          pengeluaran_menunggu: pengeluaranMenunggu[0]?.total || 0,
          total_jam_bulan_ini: Number(jamSum[0]?.total || 0),
          total_pengeluaran_bulan_ini: Number(pengSum[0]?.total || 0)
        }
      });
    }

    // ==========================================
    // 2. TIPE: KONTRIBUSI TIM PER PROYEK
    // ==========================================
    if (type === 'kontribusi') {
      const id_pekerjaan = req.query.id_pekerjaan ? parseInt(req.query.id_pekerjaan, 10) : 0;
      let queryJobs = 'SELECT id_pekerjaan, nama_pekerjaan, status FROM pekerjaan ';
      const params = [];
      if (id_pekerjaan > 0) {
        queryJobs += ' WHERE id_pekerjaan = ? ';
        params.push(id_pekerjaan);
      }
      queryJobs += ' ORDER BY id_pekerjaan DESC ';

      const [pekerjaanList] = await db.query(queryJobs, params);
      const result = [];

      for (const job of pekerjaanList) {
        const jId = job.id_pekerjaan;

        const [totRow] = await db.query(`
          SELECT COALESCE(SUM(${sqlDurasi}), 0) AS total_jam
          FROM absensi a
          WHERE a.id_pekerjaan = ? AND a.status_verifikasi = 'disetujui' AND a.jam_pulang IS NOT NULL
        `, [jId]);
        const totalJamJob = Number(totRow[0]?.total_jam || 0);

        const [workerStats] = await db.query(`
          SELECT k.id_karyawan, k.nama, k.jabatan,
                 COALESCE(SUM(${sqlDurasi}), 0) AS jam_pekerja
          FROM penugasan pn
          JOIN karyawan k ON pn.id_karyawan = k.id_karyawan
          LEFT JOIN absensi a ON a.id_pekerjaan = pn.id_pekerjaan 
                             AND a.id_karyawan = pn.id_karyawan 
                             AND a.status_verifikasi = 'disetujui'
                             AND a.jam_pulang IS NOT NULL
          WHERE pn.id_pekerjaan = ?
          GROUP BY k.id_karyawan, k.nama, k.jabatan
          ORDER BY jam_pekerja DESC
        `, [jId]);

        const formattedStats = workerStats.map(ps => {
          const jP = Number(ps.jam_pekerja || 0);
          return {
            ...ps,
            jam_pekerja: jP,
            persentase: totalJamJob > 0 ? Number(((jP / totalJamJob) * 100).toFixed(1)) : 0,
            is_saya: isWorker ? (Number(ps.id_karyawan) === Number(kId)) : false
          };
        });

        result.push({
          id_pekerjaan: job.id_pekerjaan,
          nama_pekerjaan: job.nama_pekerjaan,
          status: job.status,
          total_jam_proyek: totalJamJob,
          kontributor: formattedStats
        });
      }

      return res.json({
        success: true,
        message: 'Data persentase kontribusi proyek berhasil dimuat',
        data: result
      });
    }

    // ==========================================
    // 3. TIPE: REKAP JAM KERJA TIM
    // ==========================================
    if (type === 'jam_kerja') {
      let queryWorkers = `
        SELECT k.id_karyawan, k.nama, k.jabatan, k.tarif_per_jam,
               COUNT(DISTINCT a.id_pekerjaan) AS total_proyek_dikerjakan,
               COUNT(a.id_absensi) AS total_sesi_kerja,
               COALESCE(SUM(CASE WHEN a.status_verifikasi = 'disetujui' THEN ${sqlDurasi} ELSE 0 END), 0) AS jam_disetujui,
               COALESCE(SUM(CASE WHEN a.status_verifikasi = 'menunggu' THEN ${sqlDurasi} ELSE 0 END), 0) AS jam_menunggu
        FROM karyawan k
        LEFT JOIN absensi a ON k.id_karyawan = a.id_karyawan AND a.jam_pulang IS NOT NULL
      `;
      const params = [];
      if (isWorker && kId) {
        queryWorkers += ' WHERE k.id_karyawan = ? ';
        params.push(kId);
      }
      queryWorkers += ' GROUP BY k.id_karyawan, k.nama, k.jabatan, k.tarif_per_jam ORDER BY jam_disetujui DESC ';

      const [rows] = await db.query(queryWorkers, params);
      const formatted = rows.map(r => {
        const disetujui = Number(r.jam_disetujui || 0);
        const menunggu = Number(r.jam_menunggu || 0);
        const tarif = Number(r.tarif_per_jam || 0);
        return {
          ...r,
          jam_disetujui: disetujui,
          jam_menunggu: menunggu,
          estimasi_upah: Number((disetujui * tarif).toFixed(2))
        };
      });

      return res.json({
        success: true,
        message: 'Rekapitulasi jam kerja tim berhasil dimuat',
        data: formatted
      });
    }

    return res.status(400).json({ success: false, message: 'Tipe rekap tidak valid' });
  } catch (err) {
    console.error('Error in getDashboardRekap:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { getDashboardRekap };
