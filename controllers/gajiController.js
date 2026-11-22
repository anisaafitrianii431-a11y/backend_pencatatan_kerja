const db = require('../config/database');
const { saveBase64Image } = require('../utils/uploadHelper');
const {
  resolveSalaryForDate,
  splitPeriodBySalarySegments,
  calculateSegmentWage
} = require('../utils/payrollCalculationHelper');
const {
  calculateEffectiveWorkingDays
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

// Helper periode (default bulan berjalan "YYYY-MM")
function getPeriode(req) {
  return req.query.periode || req.body?.periode || new Date().toISOString().slice(0, 7);
}

// Helper kalkulasi upah hybrid legacy (Tarif jabatan karyawan sebagai standar utama, mendukung multi-proyek)
function calculateEmployeeWages(karyawan, absensiRows) {
  let totalUpah = 0;
  let totalJam = 0;
  const uniqueDays = new Set();
  const dayJobMap = new Set();
  const sessionBreakdown = [];

  const defaultTarif = Number(karyawan.nominal_upah) || Number(karyawan.tarif_per_jam) || 0;
  const defaultJenis = karyawan.jenis_upah || 'per_jam';

  for (const a of absensiRows) {
    const durasi = Number(a.durasi_jam || 0);
    totalJam += durasi;
    const dateStr = a.tanggal ? String(a.tanggal).slice(0, 10) : '';
    if (dateStr) uniqueDays.add(dateStr);

    const jobNominal = Number(a.job_nominal_upah || 0);
    // Prioritas: Tarif jabatan karyawan utama (beda jabatan beda gaji).
    // Jika karyawan belum diset tarifnya, gunakan tarif proyek jika ada
    const effectiveTarif = defaultTarif > 0 ? defaultTarif : jobNominal;
    const effectiveJenis = defaultJenis || (a.job_jenis_upah ? a.job_jenis_upah : 'per_jam');

    let upahSesi = 0;
    if (effectiveJenis === 'per_jam') {
      upahSesi = durasi * effectiveTarif;
      totalUpah += upahSesi;
    } else if (effectiveJenis === 'per_hari') {
      const dayKey = `${dateStr}_${a.id_pekerjaan || 'default'}`;
      if (!dayJobMap.has(dayKey)) {
        dayJobMap.add(dayKey);
        upahSesi = effectiveTarif;
        totalUpah += upahSesi;
      }
    } else if (effectiveJenis === 'borongan') {
      const jobKey = `borongan_${a.id_pekerjaan || 'default'}`;
      if (!dayJobMap.has(jobKey)) {
        dayJobMap.add(jobKey);
        upahSesi = effectiveTarif;
        totalUpah += upahSesi;
      }
    }

    sessionBreakdown.push({
      ...a,
      is_job_rate: defaultTarif === 0 && jobNominal > 0,
      effective_jenis: effectiveJenis,
      effective_tarif: effectiveTarif,
      upah_sesi: Math.round(upahSesi)
    });
  }

  // Jika jenis upah karyawan adalah bulanan atau borongan dan tidak ada upah berbasis proyek
  if ((defaultJenis === 'per_bulan' || defaultJenis === 'borongan') && totalUpah === 0 && uniqueDays.size > 0) {
    totalUpah = defaultTarif;
  }

  return {
    totalJam: Number(totalJam.toFixed(2)),
    totalHari: uniqueDays.size,
    totalUpah: Math.round(totalUpah),
    sessionBreakdown
  };
}

/**
 * ENGINE PENGGAJIAN FASE 3:
 * Menghitung upah karyawan secara komprehensif berbasis:
 * - Versioning riwayat gaji penugasan (penugasan_gaji_riwayat)
 * - Multi-segmen tarif dalam satu bulan (perubahan skema di tengah bulan)
 * - Prorata untuk karyawan yang baru bergabung / selesai di tengah periode
 * - Dukungan 4 satuan: per_jam, per_hari, per_bulan, per_tahun
 * - Transparansi rumus perhitungan gaji (rincian_segmen_gaji)
 * - Dukungan aturan lembur per proyek
 */
async function calculateEmployeePayrollDetailed(karyawan, approvedAbsensi = [], periode) {
  const [yStr, mStr] = periode.split('-');
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  const lastDay = new Date(y, m, 0).getDate();
  const periodStart = `${periode}-01`;
  const periodEnd = `${periode}-${String(lastDay).padStart(2, '0')}`;

  // Ambil penugasan aktif karyawan pada proyek yang terhubung ke master_role via pekerjaan_role_budget
  const [assignments] = await db.query(`
    SELECT pn.id_penugasan, pn.id_pekerjaan, pn.peran_tugas, pn.id_role_budget,
           pn.tanggal_penugasan, pn.tanggal_selesai_tugas, pn.status_penugasan,
           p.nama_pekerjaan, p.kode_pekerjaan, p.tanggal_mulai AS project_start, p.target_selesai AS project_end,
           p.hari_kerja_per_bulan, p.jam_kerja_per_hari, p.lembur_diizinkan, p.tanggal_cutoff, p.tanggal_pencairan,
           p.jenis_upah AS job_jenis_upah, p.nominal_upah AS job_nominal_upah,
           prb.gaji_min_bulanan, prb.gaji_max_bulanan,
           mr.id_role, mr.nama_role, mr.hierarchy_level,
           (SELECT COUNT(*) FROM pekerjaan_role_budget prb_all WHERE prb_all.id_pekerjaan = p.id_pekerjaan) AS total_role_budget
    FROM penugasan pn
    JOIN pekerjaan p ON pn.id_pekerjaan = p.id_pekerjaan
    LEFT JOIN pekerjaan_role_budget prb ON pn.id_role_budget = prb.id_role_budget
    LEFT JOIN master_role mr ON prb.id_role = mr.id_role
    WHERE pn.id_karyawan = ?
      AND (pn.status_penugasan IS NULL OR pn.status_penugasan = 'aktif')
    ORDER BY pn.id_penugasan ASC
  `, [karyawan.id_karyawan]);

  // Cari Master Role berdasarkan jabatan karyawan jika ada
  let employeeMasterRole = null;
  if (karyawan.jabatan) {
    const [mrMatches] = await db.query(
      'SELECT id_role, nama_role, hierarchy_level, default_gaji_min_bulanan, default_gaji_max_bulanan FROM master_role WHERE LOWER(TRIM(nama_role)) = LOWER(TRIM(?)) AND is_active = 1 LIMIT 1',
      [karyawan.jabatan]
    );
    if (mrMatches.length > 0) employeeMasterRole = mrMatches[0];
  }

  const rincianSegmenGaji = [];
  const processedAbsensiIds = new Set();
  const uniqueDatesAll = new Set();
  let totalJamSemua = 0;
  let totalUpahSemua = 0;
  let infoCutoff = null;

  for (const a of approvedAbsensi) {
    const d = a.tanggal ? String(a.tanggal).slice(0, 10) : '';
    if (d) uniqueDatesAll.add(d);
    totalJamSemua += Number(a.durasi_jam || 0);
  }
  totalJamSemua = Number(totalJamSemua.toFixed(2));

  // Ambil info cutoff dari proyek jika ada
  for (const as of assignments) {
    if (as.tanggal_cutoff && !infoCutoff) {
      infoCutoff = {
        id_pekerjaan: as.id_pekerjaan,
        nama_pekerjaan: as.nama_pekerjaan,
        tanggal_cutoff: Number(as.tanggal_cutoff),
        tanggal_pencairan: Number(as.tanggal_pencairan || 28),
        keterangan: `Cutoff absensi tanggal ${as.tanggal_cutoff}, jadwal pencairan tanggal ${as.tanggal_pencairan || 28}`
      };
    }
  }

  if (assignments.length > 0) {
    for (const as of assignments) {
      // Ambil riwayat skema gaji penugasan (Anti-Overwrite: terikat tanggal berlaku)
      const [historyRows] = await db.query(
        'SELECT * FROM penugasan_gaji_riwayat WHERE id_penugasan = ? ORDER BY effective_from ASC, id_riwayat_gaji ASC',
        [as.id_penugasan]
      );

      const fallbackConfig = {
        jenis_upah: as.job_jenis_upah || karyawan.jenis_upah || 'per_jam',
        nominal_upah: Number(as.job_nominal_upah || karyawan.nominal_upah || karyawan.tarif_per_jam || 0)
      };

      const segments = splitPeriodBySalarySegments(
        periodStart,
        periodEnd,
        as.tanggal_penugasan,
        as.tanggal_selesai_tugas,
        as.project_start,
        as.project_end,
        historyRows,
        fallbackConfig
      );

      const projectCalendar = {
        hari_kerja_per_bulan: as.hari_kerja_per_bulan || 22,
        jam_kerja_per_hari: as.jam_kerja_per_hari || 8,
        lembur_diizinkan: Number(as.lembur_diizinkan) === 1 ? 1 : 0,
        has_role_budget: Number(as.total_role_budget || 0) > 0
      };

      for (const seg of segments) {
        // Ambil absensi untuk proyek ini yang berada di dalam segmen
        const segLogs = approvedAbsensi.filter(a => {
          const matchJob = Number(a.id_pekerjaan) === Number(as.id_pekerjaan);
          const d = a.tanggal ? String(a.tanggal).slice(0, 10) : '';
          const matchDate = d >= seg.segmen_mulai && d <= seg.segmen_selesai;
          return matchJob && matchDate;
        });

        segLogs.forEach(a => processedAbsensiIds.add(a.id_absensi));

        const segCalc = calculateSegmentWage(seg, segLogs, projectCalendar);

        // Aturan Lembur: HANYA jika admin mengizinkan pada proyek ini (lembur_diizinkan === 1)
        const lemburDiizinkanProyek = Number(projectCalendar.lembur_diizinkan) === 1;

        // Hitung standar tarif lembur per jam jika belum ditentukan di karyawan
        let baseHourlyRate = 0;
        if (seg.jenis_upah === 'per_jam') {
          baseHourlyRate = Number(seg.nominal_upah) || 0;
        } else if (seg.jenis_upah === 'per_hari') {
          baseHourlyRate = (Number(seg.nominal_upah) || 0) / (Number(projectCalendar.jam_kerja_per_hari) || 8);
        } else if (seg.jenis_upah === 'per_bulan' || seg.jenis_upah === 'borongan') {
          baseHourlyRate = (Number(seg.nominal_upah) || 0) / ((Number(projectCalendar.hari_kerja_per_bulan) || 22) * (Number(projectCalendar.jam_kerja_per_hari) || 8));
        } else if (seg.jenis_upah === 'per_tahun') {
          baseHourlyRate = (Number(seg.nominal_upah) || 0) / (12 * (Number(projectCalendar.hari_kerja_per_bulan) || 22) * (Number(projectCalendar.jam_kerja_per_hari) || 8));
        }
        const tarifLemburKaryawan = Number(karyawan.tarif_lembur || 0);
        const effectiveTarifLembur = tarifLemburKaryawan > 0 ? tarifLemburKaryawan : Math.round(baseHourlyRate * 1.5);

        let upahLemburSegmen = 0;
        let jamLemburSegmen = 0;
        if (lemburDiizinkanProyek) {
          for (const log of segLogs) {
            const durasi = Number(log.durasi_jam || 0);
            const jamStandar = Number(projectCalendar.jam_kerja_per_hari) || 8;
            if (durasi > jamStandar) {
              const extraHours = Number((durasi - jamStandar).toFixed(2));
              jamLemburSegmen += extraHours;
              upahLemburSegmen += Math.round(extraHours * effectiveTarifLembur);
            }
          }
        }

        const subtotalSegmen = segCalc.upah + upahLemburSegmen;
        totalUpahSemua += subtotalSegmen;

        let rumusFinal = segCalc.rumus_teks;
        if (lemburDiizinkanProyek && upahLemburSegmen > 0) {
          rumusFinal += ` + Lembur ${jamLemburSegmen} jam x Rp ${effectiveTarifLembur.toLocaleString('id-ID')} = Rp ${subtotalSegmen.toLocaleString('id-ID')}`;
        } else if (!lemburDiizinkanProyek) {
          rumusFinal += ` (Lembur tidak diizinkan admin proyek)`;
        }

        const roleNama = as.nama_role || employeeMasterRole?.nama_role || as.peran_tugas || karyawan.jabatan;
        const roleLevel = as.hierarchy_level || employeeMasterRole?.hierarchy_level || 1;

        rincianSegmenGaji.push({
          id_pekerjaan: Number(as.id_pekerjaan),
          nama_pekerjaan: as.nama_pekerjaan,
          kode_pekerjaan: as.kode_pekerjaan,
          peran_tugas: as.peran_tugas,
          id_role_budget: as.id_role_budget ? Number(as.id_role_budget) : null,
          role_nama: roleNama,
          role_level: roleLevel,
          role_source: as.nama_role ? 'Slot Role Proyek' : (employeeMasterRole ? 'Master Role Karyawan' : 'Jabatan Default'),
          lembur_diizinkan: lemburDiizinkanProyek ? 1 : 0,
          lembur_status_teks: lemburDiizinkanProyek ? 'Diizinkan Admin Proyek' : 'Tidak Diizinkan Admin Proyek',
          tarif_lembur_per_jam: effectiveTarifLembur,
          jenis_upah: seg.jenis_upah,
          nominal_upah: Number(seg.nominal_upah),
          effective_from: seg.effective_from,
          effective_to: seg.effective_to,
          segmen_mulai: seg.segmen_mulai,
          segmen_selesai: seg.segmen_selesai,
          is_prorata: segCalc.is_prorata,
          hari_efektif_aktif: segCalc.hari_efektif_aktif,
          standar_hari_bulan: segCalc.standar_hari_bulan,
          total_hari_hadir: segCalc.total_hari_hadir,
          total_jam_kerja: segCalc.total_jam_kerja,
          upah_pokok: segCalc.upah,
          upah_lembur: upahLemburSegmen,
          jam_lembur: Number(jamLemburSegmen.toFixed(2)),
          subtotal_upah: subtotalSegmen,
          rumus_teks: rumusFinal
        });
      }
    }
  }

  // Absensi di luar proyek terdaftar (orphan absensi / pekerjaan umum)
  const orphanAbsensi = approvedAbsensi.filter(a => !processedAbsensiIds.has(a.id_absensi));
  if (orphanAbsensi.length > 0) {
    const defaultTarif = Number(karyawan.nominal_upah) || Number(karyawan.tarif_per_jam) || 0;
    const defaultJenis = karyawan.jenis_upah || 'per_jam';
    const legacyCalc = calculateEmployeeWages(karyawan, orphanAbsensi);

    totalUpahSemua += legacyCalc.totalUpah;

    rincianSegmenGaji.push({
      id_pekerjaan: null,
      nama_pekerjaan: 'Pekerjaan Umum / Non-Proyek',
      peran_tugas: karyawan.jabatan || 'Pelaksana',
      id_role_budget: null,
      role_nama: employeeMasterRole?.nama_role || karyawan.jabatan || 'Pelaksana',
      role_level: employeeMasterRole?.hierarchy_level || 1,
      role_source: employeeMasterRole ? 'Master Role Karyawan' : 'Jabatan Default',
      lembur_diizinkan: 0,
      lembur_status_teks: 'Non-Proyek',
      tarif_lembur_per_jam: 0,
      jenis_upah: defaultJenis,
      nominal_upah: defaultTarif,
      effective_from: periodStart,
      effective_to: periodEnd,
      segmen_mulai: periodStart,
      segmen_selesai: periodEnd,
      is_prorata: false,
      hari_efektif_aktif: 0,
      standar_hari_bulan: 22,
      total_hari_hadir: legacyCalc.totalHari,
      total_jam_kerja: legacyCalc.totalJam,
      upah_pokok: legacyCalc.totalUpah,
      upah_lembur: 0,
      jam_lembur: 0,
      subtotal_upah: legacyCalc.totalUpah,
      rumus_teks: `${legacyCalc.totalHari} hari hadir / ${legacyCalc.totalJam} jam kerja x Rp ${defaultTarif.toLocaleString('id-ID')} = Rp ${legacyCalc.totalUpah.toLocaleString('id-ID')}`
    });
  }

  // Fallback jika tidak ada penugasan dan tidak ada absensi
  if (rincianSegmenGaji.length === 0) {
    const defaultTarif = Number(karyawan.nominal_upah) || Number(karyawan.tarif_per_jam) || 0;
    const defaultJenis = karyawan.jenis_upah || 'per_jam';
    const legacyCalc = calculateEmployeeWages(karyawan, approvedAbsensi);
    totalUpahSemua = legacyCalc.totalUpah;

    if (totalUpahSemua > 0 || approvedAbsensi.length > 0) {
      rincianSegmenGaji.push({
        id_pekerjaan: null,
        nama_pekerjaan: 'Standar Jabatan Karyawan',
        peran_tugas: karyawan.jabatan || 'Pelaksana',
        id_role_budget: null,
        role_nama: employeeMasterRole?.nama_role || karyawan.jabatan || 'Pelaksana',
        role_level: employeeMasterRole?.hierarchy_level || 1,
        role_source: employeeMasterRole ? 'Master Role Karyawan' : 'Jabatan Default',
        lembur_diizinkan: 0,
        lembur_status_teks: 'Standar Jabatan',
        tarif_lembur_per_jam: 0,
        jenis_upah: defaultJenis,
        nominal_upah: defaultTarif,
        effective_from: periodStart,
        effective_to: periodEnd,
        segmen_mulai: periodStart,
        segmen_selesai: periodEnd,
        is_prorata: false,
        hari_efektif_aktif: 0,
        standar_hari_bulan: 22,
        total_hari_hadir: legacyCalc.totalHari,
        total_jam_kerja: legacyCalc.totalJam,
        upah_pokok: totalUpahSemua,
        upah_lembur: 0,
        jam_lembur: 0,
        subtotal_upah: totalUpahSemua,
        rumus_teks: `Standar upah ${defaultJenis} Rp ${defaultTarif.toLocaleString('id-ID')} = Rp ${totalUpahSemua.toLocaleString('id-ID')}`
      });
    }
  }

  let totalUpahPokokSemua = 0;
  let totalUpahLemburSemua = 0;
  let totalJamLemburSemua = 0;
  let anyLemburAllowed = false;

  for (const seg of rincianSegmenGaji) {
    totalUpahPokokSemua += Number(seg.upah_pokok !== undefined ? seg.upah_pokok : (seg.subtotal_upah - (seg.upah_lembur || 0)));
    totalUpahLemburSemua += Number(seg.upah_lembur || 0);
    totalJamLemburSemua += Number(seg.jam_lembur || 0);
    if (seg.lembur_diizinkan === 1) anyLemburAllowed = true;
  }

  // Skema utama
  const primarySegment = rincianSegmenGaji[0];
  const primaryJenis = primarySegment ? primarySegment.jenis_upah : (karyawan.jenis_upah || 'per_jam');
  const primaryTarif = primarySegment ? primarySegment.nominal_upah : Number(karyawan.nominal_upah || karyawan.tarif_per_jam || 0);

  const finalNamaRole = primarySegment?.role_nama || employeeMasterRole?.nama_role || karyawan.jabatan || 'Pelaksana';
  const finalHierarchyLevel = primarySegment?.role_level || employeeMasterRole?.hierarchy_level || 1;

  return {
    totalUpah: Math.round(totalUpahSemua),
    totalUpahPokok: Math.round(totalUpahPokokSemua),
    totalUpahLembur: Math.round(totalUpahLemburSemua),
    totalJamLembur: Number(totalJamLemburSemua.toFixed(2)),
    lemburDiizinkan: anyLemburAllowed ? 1 : 0,
    masterRole: employeeMasterRole,
    namaRole: finalNamaRole,
    hierarchyLevel: finalHierarchyLevel,
    totalJam: totalJamSemua,
    totalHari: uniqueDatesAll.size,
    primaryJenis,
    primaryTarif,
    rincianSegmenGaji,
    infoCutoff
  };
}

// 1. Dispatcher Utama / Rekap Penggajian Seluruh Karyawan (Admin)
async function getRekapGaji(req, res) {
  try {
    const action = req.query.action || req.body?.action;

    if (action === 'kalkulasi') return kalkulasiGaji(req, res);
    if (action === 'detail') return getDetailGaji(req, res);
    if (action === 'pembayaran_list') return getPembayaranList(req, res);
    if (action === 'pembayaran_history') return getPembayaranHistory(req, res);
    if (action === 'slip') return getSlipGaji(req, res);
    if (action === 'riwayat') return getRiwayatGaji(req, res);

    const periode = getPeriode(req);

    // Ambil seluruh karyawan beserta master role jika cocok
    const [karyawanList] = await db.query(`
      SELECT k.id_karyawan, k.kode_karyawan, k.nama, k.jabatan, k.jenis_upah, k.nominal_upah, k.tarif_per_jam, k.lembur_aktif, k.tarif_lembur, k.status,
             mr.id_role AS master_id_role, mr.nama_role AS master_nama_role, mr.hierarchy_level AS master_hierarchy_level
      FROM karyawan k
      LEFT JOIN master_role mr ON LOWER(TRIM(k.jabatan)) = LOWER(TRIM(mr.nama_role)) AND mr.is_active = 1
      ORDER BY k.id_karyawan DESC
    `);

    // Ambil data penetapan gaji yang sudah tersimpan di database untuk periode ini
    const [savedGajiList] = await db.query('SELECT * FROM gaji WHERE periode = ?', [periode]);
    const savedMap = new Map(savedGajiList.map(g => [Number(g.id_karyawan), g]));

    const result = [];

    for (const k of karyawanList) {
      const saved = savedMap.get(Number(k.id_karyawan));

      // Ambil absensi disetujui pada periode ini
      const [absRows] = await db.query(`
        SELECT 
          a.id_absensi,
          a.tanggal,
          a.id_pekerjaan,
          p.nama_pekerjaan,
          p.jenis_upah AS job_jenis_upah,
          p.nominal_upah AS job_nominal_upah,
          ${sqlDurasi} AS durasi_jam
        FROM absensi a
        LEFT JOIN pekerjaan p ON a.id_pekerjaan = p.id_pekerjaan
        WHERE a.id_karyawan = ? 
          AND a.status_verifikasi = 'disetujui'
          AND a.jam_pulang IS NOT NULL
          AND a.tanggal LIKE ?
      `, [k.id_karyawan, `${periode}%`]);

      const detailedCalc = await calculateEmployeePayrollDetailed(k, absRows, periode);

      if (saved) {
        result.push({
          id_gaji: saved.id_gaji,
          id_karyawan: k.id_karyawan,
          kode_karyawan: k.kode_karyawan,
          nama: k.nama,
          nama_karyawan: k.nama,
          jabatan: k.jabatan,
          nama_role: detailedCalc.namaRole || k.master_nama_role || k.jabatan,
          hierarchy_level: detailedCalc.hierarchyLevel || k.master_hierarchy_level || 1,
          master_role: detailedCalc.masterRole || (k.master_id_role ? { id_role: k.master_id_role, nama_role: k.master_nama_role, hierarchy_level: k.master_hierarchy_level } : null),
          periode: saved.periode,
          jenis_upah: saved.jenis_upah,
          total_jam: Number(saved.total_jam) || 0,
          total_hari: Number(saved.total_hari) || 0,
          tarif: Number(saved.tarif) || 0,
          total_upah: Number(saved.total_upah) || 0,
          total_upah_pokok: detailedCalc.totalUpahPokok,
          total_upah_lembur: detailedCalc.totalUpahLembur,
          total_jam_lembur: detailedCalc.totalJamLembur,
          lembur_diizinkan: detailedCalc.lemburDiizinkan,
          total_ganti: Number(saved.total_ganti) || 0,
          bonus: Number(saved.bonus) || 0,
          potongan: Number(saved.potongan) || 0,
          catatan_penyesuaian: saved.catatan_penyesuaian || '',
          gaji_bersih: Number(saved.gaji_bersih) || 0,
          total_dibayar: Number(saved.total_dibayar) || 0,
          sisa_pembayaran: Number(saved.sisa_pembayaran) || 0,
          status_bayar: saved.status_bayar,
          status_penetapan: saved.status_penetapan,
          sudah_ditetapkan: saved.status_penetapan === 'ditetapkan',
          rincian_segmen_gaji: detailedCalc.rincianSegmenGaji,
          info_cutoff: detailedCalc.infoCutoff
        });
      } else {
        const totalJam = detailedCalc.totalJam;
        const totalHari = detailedCalc.totalHari;
        const totalUpah = detailedCalc.totalUpah;
        const jenisUpah = detailedCalc.primaryJenis;
        const tarif = detailedCalc.primaryTarif;

        // Reimburse uang pribadi disetujui pada periode ini
        const [reimburseRows] = await db.query(`
          SELECT COALESCE(SUM(nominal), 0) AS total_reimburse
          FROM pengeluaran
          WHERE id_karyawan = ?
            AND jenis_dana = 'pribadi'
            AND status_verifikasi = 'disetujui'
            AND tanggal LIKE ?
        `, [k.id_karyawan, `${periode}%`]);

        const totalGanti = Number(reimburseRows[0]?.total_reimburse || 0);
        const gajiBersih = totalUpah + totalGanti;

        result.push({
          id_gaji: null,
          id_karyawan: k.id_karyawan,
          kode_karyawan: k.kode_karyawan,
          nama: k.nama,
          nama_karyawan: k.nama,
          jabatan: k.jabatan,
          nama_role: detailedCalc.namaRole || k.master_nama_role || k.jabatan,
          hierarchy_level: detailedCalc.hierarchyLevel || k.master_hierarchy_level || 1,
          master_role: detailedCalc.masterRole || (k.master_id_role ? { id_role: k.master_id_role, nama_role: k.master_nama_role, hierarchy_level: k.master_hierarchy_level } : null),
          periode,
          jenis_upah: jenisUpah,
          total_jam: totalJam,
          total_hari: totalHari,
          tarif,
          total_upah: totalUpah,
          total_upah_pokok: detailedCalc.totalUpahPokok,
          total_upah_lembur: detailedCalc.totalUpahLembur,
          total_jam_lembur: detailedCalc.totalJamLembur,
          lembur_diizinkan: detailedCalc.lemburDiizinkan,
          total_ganti: totalGanti,
          bonus: 0,
          potongan: 0,
          catatan_penyesuaian: '',
          gaji_bersih: gajiBersih,
          total_dibayar: 0,
          sisa_pembayaran: gajiBersih,
          status_bayar: 'belum',
          status_penetapan: 'draft',
          sudah_ditetapkan: false,
          rincian_segmen_gaji: detailedCalc.rincianSegmenGaji,
          info_cutoff: detailedCalc.infoCutoff
        });
      }
    }

    return res.json({
      success: true,
      message: 'Data penggajian berhasil dimuat',
      periode,
      data: result
    });
  } catch (error) {
    console.error('Error getRekapGaji:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal memuat rekap gaji: ' + error.message,
      error: error.message
    });
  }
}

// 2. Kalkulasi Gaji (Menu 1: Kalkulasi & Pratinjau Gaji)
async function kalkulasiGaji(req, res) {
  return getRekapGaji({ ...req, query: { ...req.query, action: '' } }, res);
}

// 3. Detail Sesi Jam Kerja & Breakdown Penggajian Seorang Karyawan
async function getDetailGaji(req, res) {
  try {
    const id_karyawan = req.query.id_karyawan || req.user?.id_karyawan;
    const periode = getPeriode(req);

    if (!id_karyawan) {
      return res.status(400).json({ success: false, message: 'ID Karyawan wajib disertakan' });
    }

    const [kRows] = await db.query('SELECT * FROM karyawan WHERE id_karyawan = ?', [id_karyawan]);
    if (kRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data karyawan tidak ditemukan' });
    }
    const karyawan = kRows[0];

    // Ambil data penetapan jika sudah tersimpan
    const [gRows] = await db.query('SELECT * FROM gaji WHERE id_karyawan = ? AND periode = ?', [id_karyawan, periode]);
    const gajiLocked = gRows.length > 0 ? gRows[0] : null;

    // Ambil riwayat pembayaran terakhir jika gaji sudah dibuat
    let lastPay = {};
    if (gajiLocked?.id_gaji) {
      const [payRows] = await db.query(
        'SELECT * FROM pembayaran_gaji WHERE id_gaji = ? ORDER BY id_pembayaran DESC LIMIT 1',
        [gajiLocked.id_gaji]
      );
      if (payRows.length > 0) lastPay = payRows[0];
    }

    // Ambil seluruh sesi absensi pada periode ini (disetujui maupun menunggu)
    const [rawAbsensiList] = await db.query(`
      SELECT a.id_absensi, a.tanggal, a.jam_masuk, a.jam_pulang, a.id_pekerjaan, a.status_verifikasi,
             p.nama_pekerjaan, p.lokasi, p.status AS status_pekerjaan,
             p.jenis_upah AS job_jenis_upah, p.nominal_upah AS job_nominal_upah,
             ${sqlDurasi} AS durasi_jam
      FROM absensi a
      LEFT JOIN pekerjaan p ON a.id_pekerjaan = p.id_pekerjaan
      WHERE a.id_karyawan = ?
        AND a.tanggal LIKE ?
      ORDER BY a.tanggal DESC, a.jam_masuk DESC
    `, [id_karyawan, `${periode}%`]);

    const approvedAbsensi = rawAbsensiList.filter(a => a.status_verifikasi === 'disetujui' && a.jam_pulang);
    const pendingAbsensi = rawAbsensiList.filter(a => a.status_verifikasi === 'menunggu');

    // Ambil klaim reimburse uang pribadi pada periode ini
    const [rawReimburseList] = await db.query(`
      SELECT pg.id_pengeluaran, pg.tanggal, pg.nominal, pg.keterangan, pg.status_verifikasi,
             pg.status_reimbursement, pg.status_ganti, pg.foto_kwitansi, pg.id_pekerjaan,
             p.nama_pekerjaan, p.lokasi
      FROM pengeluaran pg
      LEFT JOIN pekerjaan p ON pg.id_pekerjaan = p.id_pekerjaan
      WHERE pg.id_karyawan = ?
        AND pg.jenis_dana = 'pribadi'
        AND pg.tanggal LIKE ?
      ORDER BY pg.tanggal DESC
    `, [id_karyawan, `${periode}%`]);

    const approvedReimburse = rawReimburseList.filter(r => r.status_verifikasi === 'disetujui');
    const pendingReimburse = rawReimburseList.filter(r => r.status_verifikasi === 'menunggu');

    // Ambil total pengeluaran uang kantor oleh karyawan ini per proyek
    const [rawKantorList] = await db.query(`
      SELECT pg.id_pekerjaan, COALESCE(SUM(pg.nominal), 0) AS total_kantor
      FROM pengeluaran pg
      WHERE pg.id_karyawan = ?
        AND pg.jenis_dana = 'kantor'
        AND pg.status_verifikasi = 'disetujui'
        AND pg.tanggal LIKE ?
      GROUP BY pg.id_pekerjaan
    `, [id_karyawan, `${periode}%`]);
    const kantorMap = new Map(rawKantorList.map(item => [Number(item.id_pekerjaan), Number(item.total_kantor || 0)]));

    // Ambil penugasan proyek karyawan
    const [assignments] = await db.query(`
      SELECT pn.id_pekerjaan, pn.peran_tugas, pn.id_role_budget,
             p.nama_pekerjaan, p.kode_pekerjaan, p.lokasi, p.status AS status_pekerjaan, p.jenis_upah, p.nominal_upah, p.lembur_diizinkan,
             prb.gaji_min_bulanan, prb.gaji_max_bulanan,
             mr.id_role, mr.nama_role, mr.hierarchy_level
      FROM penugasan pn
      JOIN pekerjaan p ON pn.id_pekerjaan = p.id_pekerjaan
      LEFT JOIN pekerjaan_role_budget prb ON pn.id_role_budget = prb.id_role_budget
      LEFT JOIN master_role mr ON prb.id_role = mr.id_role
      WHERE pn.id_karyawan = ? AND (pn.status_penugasan IS NULL OR pn.status_penugasan = 'aktif')
    `, [id_karyawan]);

    // Hitung upah menggunakan formula payroll engine baru
    const detailedCalc = await calculateEmployeePayrollDetailed(karyawan, approvedAbsensi, periode);
    const legacyCalc = calculateEmployeeWages(karyawan, approvedAbsensi);

    const totalJam = detailedCalc.totalJam;
    const totalHari = detailedCalc.totalHari;
    const jenisUpah = gajiLocked?.jenis_upah || detailedCalc.primaryJenis;
    const tarif = Number(gajiLocked?.tarif !== undefined ? gajiLocked.tarif : detailedCalc.primaryTarif);

    const totalUpah = gajiLocked ? (Number(gajiLocked.total_upah) || 0) : detailedCalc.totalUpah;
    const totalReimburse = approvedReimburse.reduce((acc, curr) => acc + Number(curr.nominal || 0), 0);
    const bonus = Number(gajiLocked?.bonus || 0);
    const potongan = Number(gajiLocked?.potongan || 0);
    const gajiBersih = (Number(gajiLocked?.total_upah) || totalUpah) + totalReimburse + bonus - potongan;

    // Buat ringkasan per pekerjaan (pekerjaan_summary)
    const jobMap = new Map();
    const touchJob = (jobId, jobName, jobLocation, jobStatus, jobPeran, jobJenis, jobRate, roleBudget) => {
      const idNum = Number(jobId);
      if (!idNum) return null;
      const effectiveRate = tarif > 0 ? tarif : (Number(jobRate) || 0);
      const effectiveType = jenisUpah || jobJenis || 'per_jam';

      if (!jobMap.has(idNum)) {
        jobMap.set(idNum, {
          id_pekerjaan: idNum,
          nama_pekerjaan: jobName || 'Proyek Lapangan',
          lokasi: jobLocation || '',
          status_pekerjaan: jobStatus || 'berjalan',
          peran_tugas: jobPeran || 'Anggota Tim Pelaksana',
          nama_role: roleBudget?.nama_role || detailedCalc.namaRole || jobPeran || karyawan.jabatan,
          hierarchy_level: roleBudget?.hierarchy_level || detailedCalc.hierarchyLevel || 1,
          lembur_diizinkan: roleBudget?.lembur_diizinkan !== undefined ? Number(roleBudget.lembur_diizinkan) : 0,
          upah_pokok: 0,
          upah_lembur: 0,
          jam_lembur: 0,
          jenis_upah: effectiveType,
          nominal_upah: effectiveRate,
          jumlah_sesi_disetujui: 0,
          jumlah_sesi_menunggu: 0,
          total_jam_disetujui: 0,
          estimasi_upah: 0,
          jumlah_nota: 0,
          reimbursement_disetujui: 0,
          reimbursement_sudah_diganti: 0,
          reimbursement_menunggu: 0,
          pengeluaran_kantor_disetujui: kantorMap.get(idNum) || 0,
          total_kontribusi: 0
        });
      } else {
        const existing = jobMap.get(idNum);
        if (jobPeran && existing.peran_tugas === 'Anggota Tim Pelaksana') existing.peran_tugas = jobPeran;
        if (effectiveRate > 0) existing.nominal_upah = effectiveRate;
        if (roleBudget?.nama_role) existing.nama_role = roleBudget.nama_role;
        if (roleBudget?.hierarchy_level) existing.hierarchy_level = roleBudget.hierarchy_level;
        if (roleBudget?.lembur_diizinkan !== undefined) existing.lembur_diizinkan = Number(roleBudget.lembur_diizinkan);
      }
      return jobMap.get(idNum);
    };

    assignments.forEach(as => {
      touchJob(as.id_pekerjaan, as.nama_pekerjaan, as.lokasi, as.status_pekerjaan, as.peran_tugas, as.jenis_upah, as.nominal_upah, as);
    });

    legacyCalc.sessionBreakdown.forEach(a => {
      const entry = touchJob(a.id_pekerjaan, a.nama_pekerjaan, a.lokasi, a.status_pekerjaan, null, a.effective_jenis, a.effective_tarif);
      if (entry) {
        entry.jumlah_sesi_disetujui += 1;
        entry.total_jam_disetujui = Number((entry.total_jam_disetujui + Number(a.durasi_jam || 0)).toFixed(2));
        entry.estimasi_upah += Number(a.upah_sesi || 0);
      }
    });

    // Sesuaikan estimasi_upah pada pekerjaan_summary jika ada segmen kalkulasi proyek
    detailedCalc.rincianSegmenGaji.forEach(seg => {
      if (seg.id_pekerjaan && jobMap.has(seg.id_pekerjaan)) {
        const entry = jobMap.get(seg.id_pekerjaan);
        entry.estimasi_upah = seg.subtotal_upah;
        entry.upah_pokok = seg.upah_pokok !== undefined ? seg.upah_pokok : (seg.subtotal_upah - (seg.upah_lembur || 0));
        entry.upah_lembur = seg.upah_lembur || 0;
        entry.jam_lembur = seg.jam_lembur || 0;
        entry.lembur_diizinkan = seg.lembur_diizinkan;
        if (seg.role_nama) entry.nama_role = seg.role_nama;
        if (seg.role_level) entry.hierarchy_level = seg.role_level;
      }
    });

    pendingAbsensi.forEach(a => {
      const entry = touchJob(a.id_pekerjaan, a.nama_pekerjaan, a.lokasi, a.status_pekerjaan, null, a.job_jenis_upah, a.job_nominal_upah);
      if (entry) {
        entry.jumlah_sesi_menunggu += 1;
      }
    });

    approvedReimburse.forEach(r => {
      const entry = touchJob(r.id_pekerjaan, r.nama_pekerjaan, r.lokasi);
      if (entry) {
        entry.jumlah_nota += 1;
        entry.reimbursement_disetujui += Number(r.nominal || 0);
        if (r.status_ganti === 'sudah') {
          entry.reimbursement_sudah_diganti += Number(r.nominal || 0);
        }
      }
    });

    pendingReimburse.forEach(r => {
      const entry = touchJob(r.id_pekerjaan, r.nama_pekerjaan, r.lokasi);
      if (entry) {
        entry.reimbursement_menunggu += Number(r.nominal || 0);
      }
    });

    const pekerjaan_summary = Array.from(jobMap.values()).map(job => ({
      ...job,
      estimasi_upah: Math.round(job.estimasi_upah),
      total_kontribusi: Math.round(job.estimasi_upah + job.reimbursement_disetujui)
    }));

    const pending_summary = {
      absensi_menunggu: pendingAbsensi.length,
      jam_menunggu: Number(pendingAbsensi.reduce((s, a) => s + Number(a.durasi_jam || 0), 0).toFixed(2)),
      pengeluaran_menunggu: pendingReimburse.length,
      nominal_menunggu: pendingReimburse.reduce((s, r) => s + Number(r.nominal || 0), 0)
    };

    const slipObj = gajiLocked ? {
      ...gajiLocked,
      id_gaji: Number(gajiLocked.id_gaji),
      id_karyawan: Number(gajiLocked.id_karyawan),
      nama_karyawan: karyawan.nama,
      kode_karyawan: karyawan.kode_karyawan,
      jabatan: karyawan.jabatan,
      nama_role: detailedCalc.namaRole || karyawan.jabatan,
      hierarchy_level: detailedCalc.hierarchyLevel || 1,
      master_role: detailedCalc.masterRole,
      tarif: Number(gajiLocked.tarif || 0),
      total_jam: Number(gajiLocked.total_jam || 0),
      total_hari: Number(gajiLocked.total_hari || 0),
      total_upah: Number(gajiLocked.total_upah || 0),
      total_upah_pokok: detailedCalc.totalUpahPokok,
      total_upah_lembur: detailedCalc.totalUpahLembur,
      total_jam_lembur: detailedCalc.totalJamLembur,
      lembur_diizinkan: detailedCalc.lemburDiizinkan,
      total_ganti: Number(gajiLocked.total_ganti || 0),
      bonus: Number(gajiLocked.bonus || 0),
      potongan: Number(gajiLocked.potongan || 0),
      gaji_bersih: Number(gajiLocked.gaji_bersih || 0),
      total_dibayar: Number(gajiLocked.total_dibayar || 0),
      sisa_pembayaran: Number(gajiLocked.sisa_pembayaran || 0),
      metode_bayar: lastPay.metode_pembayaran || 'transfer',
      catatan_bayar: lastPay.nomor_referensi || lastPay.catatan || '',
      bukti_bayar: lastPay.bukti_pembayaran || null,
      rincian_segmen_gaji: detailedCalc.rincianSegmenGaji,
      info_cutoff: detailedCalc.infoCutoff
    } : {
      id_gaji: null,
      id_karyawan: Number(id_karyawan),
      nama_karyawan: karyawan.nama,
      kode_karyawan: karyawan.kode_karyawan,
      jabatan: karyawan.jabatan,
      nama_role: detailedCalc.namaRole || karyawan.jabatan,
      hierarchy_level: detailedCalc.hierarchyLevel || 1,
      master_role: detailedCalc.masterRole,
      periode,
      jenis_upah: jenisUpah,
      tarif,
      total_jam: Number(totalJam.toFixed(2)),
      total_hari: totalHari,
      total_upah: totalUpah,
      total_upah_pokok: detailedCalc.totalUpahPokok,
      total_upah_lembur: detailedCalc.totalUpahLembur,
      total_jam_lembur: detailedCalc.totalJamLembur,
      lembur_diizinkan: detailedCalc.lemburDiizinkan,
      total_ganti: totalReimburse,
      bonus: 0,
      potongan: 0,
      catatan_penyesuaian: '',
      gaji_bersih: gajiBersih,
      total_dibayar: 0,
      sisa_pembayaran: gajiBersih,
      status_bayar: 'belum',
      status_penetapan: 'draft',
      tanggal_ditetapkan: null,
      tanggal_bayar: null,
      metode_bayar: null,
      catatan_bayar: null,
      bukti_bayar: null,
      rincian_segmen_gaji: detailedCalc.rincianSegmenGaji,
      info_cutoff: detailedCalc.infoCutoff
    };

    return res.json({
      success: true,
      message: 'Detail kalkulasi gaji berhasil dimuat',
      data: {
        // Kontrak objek untuk GajiKaryawan & GajiAdmin
        karyawan,
        slip: slipObj,
        tarif_aktif: tarif,
        absensi: legacyCalc.sessionBreakdown,
        pengeluaran: approvedReimburse,
        pekerjaan_summary,
        pending_summary,

        // Fitur Transparansi Segmen Gaji Fase 3
        rincian_segmen_gaji: detailedCalc.rincianSegmenGaji,
        info_cutoff: detailedCalc.infoCutoff,

        // Properti flat untuk kompatibilitas
        id_gaji: slipObj.id_gaji,
        id_karyawan: Number(id_karyawan),
        nama: karyawan.nama,
        kode_karyawan: karyawan.kode_karyawan,
        jabatan: karyawan.jabatan,
        nama_role: detailedCalc.namaRole || karyawan.jabatan,
        hierarchy_level: detailedCalc.hierarchyLevel || 1,
        master_role: detailedCalc.masterRole,
        total_upah_pokok: detailedCalc.totalUpahPokok,
        total_upah_lembur: detailedCalc.totalUpahLembur,
        total_jam_lembur: detailedCalc.totalJamLembur,
        lembur_diizinkan: detailedCalc.lemburDiizinkan,
        periode,
        jenis_upah: jenisUpah,
        tarif,
        total_jam: Number(totalJam.toFixed(2)),
        total_hari: totalHari,
        total_upah: totalUpah,
        total_ganti: totalReimburse,
        total_reimburse: totalReimburse,
        bonus,
        potongan,
        catatan_penyesuaian: slipObj.catatan_penyesuaian || '',
        gaji_bersih: gajiBersih,
        total_dibayar: Number(slipObj.total_dibayar || 0),
        sisa_pembayaran: Number(slipObj.sisa_pembayaran || 0),
        status_bayar: slipObj.status_bayar || 'belum',
        status_penetapan: slipObj.status_penetapan || 'draft',
        absensi_list: legacyCalc.sessionBreakdown,
        reimburse_list: approvedReimburse
      }
    });
  } catch (error) {
    console.error('Error getDetailGaji:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

// 4. Tetapkan / Kunci Gaji Karyawan (Admin) - Mendukung satuan maupun seluruh karyawan
async function tetapkanGaji(req, res) {
  try {
    const {
      id_karyawan,
      periode,
      jenis_upah,
      total_jam,
      total_hari,
      tarif,
      total_upah,
      total_ganti,
      bonus = 0,
      potongan = 0,
      catatan_penyesuaian = ''
    } = req.body;

    if (!periode) {
      return res.status(400).json({ success: false, message: 'Periode wajib diisi' });
    }

    // Jika id_karyawan tidak dikirim, tetapkan seluruh karyawan pada periode ini
    if (!id_karyawan) {
      const [kList] = await db.query('SELECT id_karyawan, nama, jenis_upah, nominal_upah, tarif_per_jam, lembur_aktif, tarif_lembur FROM karyawan WHERE status = "aktif"');
      for (const k of kList) {
        // Ambil absensi
        const [absRows] = await db.query(`
          SELECT a.id_absensi, a.tanggal, a.id_pekerjaan, p.nama_pekerjaan, p.jenis_upah AS job_jenis_upah, p.nominal_upah AS job_nominal_upah, ${sqlDurasi} AS durasi_jam
          FROM absensi a
          LEFT JOIN pekerjaan p ON a.id_pekerjaan = p.id_pekerjaan
          WHERE a.id_karyawan = ? AND a.status_verifikasi = 'disetujui' AND a.jam_pulang IS NOT NULL AND a.tanggal LIKE ?
        `, [k.id_karyawan, `${periode}%`]);

        const calc = await calculateEmployeePayrollDetailed(k, absRows, periode);

        // Ambil reimburse
        const [reimbRows] = await db.query(`
          SELECT COALESCE(SUM(nominal), 0) AS total_reimburse
          FROM pengeluaran
          WHERE id_karyawan = ? AND jenis_dana = 'pribadi' AND status_verifikasi = 'disetujui' AND tanggal LIKE ?
        `, [k.id_karyawan, `${periode}%`]);
        const kReimburse = Number(reimbRows[0]?.total_reimburse || 0);

        const [existing] = await db.query('SELECT id_gaji, total_dibayar, bonus, potongan, catatan_penyesuaian FROM gaji WHERE id_karyawan = ? AND periode = ?', [k.id_karyawan, periode]);
        const kBonus = Number(existing[0]?.bonus || 0);
        const kPotongan = Number(existing[0]?.potongan || 0);
        const kCatatan = existing[0]?.catatan_penyesuaian || '';
        const kGajiBersih = calc.totalUpah + kReimburse + kBonus - kPotongan;
        const kTarif = calc.primaryTarif;
        const kJenis = calc.primaryJenis;

        if (existing.length > 0) {
          const dibayar = Number(existing[0].total_dibayar || 0);
          const sisa = Math.max(0, kGajiBersih - dibayar);
          const statusBayar = sisa <= 0 ? 'sudah' : (dibayar > 0 ? 'sebagian' : 'belum');
          await db.query(`
            UPDATE gaji SET
              jenis_upah = ?, total_jam = ?, total_hari = ?, tarif = ?, total_upah = ?, total_ganti = ?,
              bonus = ?, potongan = ?, catatan_penyesuaian = ?, gaji_bersih = ?, sisa_pembayaran = ?,
              status_bayar = ?, status_penetapan = 'ditetapkan', tanggal_ditetapkan = NOW()
            WHERE id_gaji = ?
          `, [kJenis, calc.totalJam, calc.totalHari, kTarif, calc.totalUpah, kReimburse, kBonus, kPotongan, kCatatan, kGajiBersih, sisa, statusBayar, existing[0].id_gaji]);
        } else {
          await db.query(`
            INSERT INTO gaji (id_karyawan, periode, jenis_upah, total_jam, total_hari, tarif, total_upah, total_ganti, bonus, potongan, catatan_penyesuaian, gaji_bersih, total_dibayar, sisa_pembayaran, status_bayar, status_penetapan, tanggal_ditetapkan)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'belum', 'ditetapkan', NOW())
          `, [k.id_karyawan, periode, kJenis, calc.totalJam, calc.totalHari, kTarif, calc.totalUpah, kReimburse, kBonus, kPotongan, kCatatan, kGajiBersih, kGajiBersih]);
        }
      }

      return res.json({
        success: true,
        message: `Seluruh gaji periode ${periode} berhasil ditetapkan & dikunci!`
      });
    }

    // Jika id_karyawan spesifik
    let finalUpah = total_upah !== undefined ? Number(total_upah) : null;
    let finalJam = total_jam !== undefined ? Number(total_jam) : null;
    let finalHari = total_hari !== undefined ? Number(total_hari) : null;
    let finalJenis = jenis_upah || null;
    let finalTarif = tarif !== undefined ? Number(tarif) : null;

    if (finalUpah === null) {
      const [kRows] = await db.query('SELECT * FROM karyawan WHERE id_karyawan = ?', [id_karyawan]);
      if (kRows.length > 0) {
        const [absRows] = await db.query(`
          SELECT a.id_absensi, a.tanggal, a.id_pekerjaan, p.nama_pekerjaan, p.jenis_upah AS job_jenis_upah, p.nominal_upah AS job_nominal_upah, ${sqlDurasi} AS durasi_jam
          FROM absensi a
          LEFT JOIN pekerjaan p ON a.id_pekerjaan = p.id_pekerjaan
          WHERE a.id_karyawan = ? AND a.status_verifikasi = 'disetujui' AND a.jam_pulang IS NOT NULL AND a.tanggal LIKE ?
        `, [id_karyawan, `${periode}%`]);
        const calc = await calculateEmployeePayrollDetailed(kRows[0], absRows, periode);
        finalUpah = calc.totalUpah;
        finalJam = calc.totalJam;
        finalHari = calc.totalHari;
        finalJenis = finalJenis || calc.primaryJenis;
        finalTarif = finalTarif !== null ? finalTarif : calc.primaryTarif;
      }
    }

    const gajiBersih = (Number(finalUpah) || 0) + (Number(total_ganti) || 0) + (Number(bonus) || 0) - (Number(potongan) || 0);
    const [existing] = await db.query('SELECT id_gaji, total_dibayar FROM gaji WHERE id_karyawan = ? AND periode = ?', [id_karyawan, periode]);

    if (existing.length > 0) {
      const dibayar = Number(existing[0].total_dibayar || 0);
      const sisa = Math.max(0, gajiBersih - dibayar);
      const statusBayar = sisa <= 0 ? 'sudah' : (dibayar > 0 ? 'sebagian' : 'belum');

      await db.query(`
        UPDATE gaji SET
          jenis_upah = COALESCE(?, jenis_upah), total_jam = COALESCE(?, total_jam), total_hari = COALESCE(?, total_hari),
          tarif = COALESCE(?, tarif), total_upah = COALESCE(?, total_upah), total_ganti = ?,
          bonus = ?, potongan = ?, catatan_penyesuaian = ?, gaji_bersih = ?, sisa_pembayaran = ?,
          status_bayar = ?, status_penetapan = 'ditetapkan', tanggal_ditetapkan = NOW()
        WHERE id_gaji = ?
      `, [finalJenis, finalJam, finalHari, finalTarif, finalUpah, total_ganti || 0, bonus, potongan, catatan_penyesuaian, gajiBersih, sisa, statusBayar, existing[0].id_gaji]);
    } else {
      await db.query(`
        INSERT INTO gaji (id_karyawan, periode, jenis_upah, total_jam, total_hari, tarif, total_upah, total_ganti, bonus, potongan, catatan_penyesuaian, gaji_bersih, total_dibayar, sisa_pembayaran, status_bayar, status_penetapan, tanggal_ditetapkan)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'belum', 'ditetapkan', NOW())
      `, [id_karyawan, periode, finalJenis || 'per_jam', finalJam || 0, finalHari || 0, finalTarif || 0, finalUpah || 0, total_ganti || 0, bonus, potongan, catatan_penyesuaian, gajiBersih, gajiBersih]);
    }

    return res.json({
      success: true,
      message: 'Gaji karyawan berhasil ditetapkan/dikunci!'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal menetapkan gaji: ' + error.message,
      error: error.message
    });
  }
}

// 5. Update Penyesuaian (Bonus & Potongan)
async function updatePenyesuaian(req, res) {
  try {
    const { id_gaji, bonus = 0, potongan = 0, catatan_penyesuaian = '' } = req.body;

    if (!id_gaji) {
      return res.status(400).json({ success: false, message: 'ID Gaji wajib diisi' });
    }

    const [rows] = await db.query('SELECT * FROM gaji WHERE id_gaji = ?', [id_gaji]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data gaji tidak ditemukan' });
    }

    const curr = rows[0];
    const b = Number(bonus) || 0;
    const p = Number(potongan) || 0;
    const totalUpah = Number(curr.total_upah || 0);
    const totalGanti = Number(curr.total_ganti || 0);
    const gajiBersihBaru = totalUpah + totalGanti + b - p;
    const dibayar = Number(curr.total_dibayar || 0);
    const sisaBaru = Math.max(0, gajiBersihBaru - dibayar);
    const statusBaru = sisaBaru <= 0 ? 'sudah' : (dibayar > 0 ? 'sebagian' : 'belum');

    await db.query(`
      UPDATE gaji SET
        bonus = ?,
        potongan = ?,
        catatan_penyesuaian = ?,
        gaji_bersih = ?,
        sisa_pembayaran = ?,
        status_bayar = ?
      WHERE id_gaji = ?
    `, [b, p, catatan_penyesuaian, gajiBersihBaru, sisaBaru, statusBaru, id_gaji]);

    return res.json({
      success: true,
      message: 'Penyesuaian gaji berhasil disimpan!',
      data: {
        id_gaji,
        bonus: b,
        potongan: p,
        gaji_bersih: gajiBersihBaru,
        sisa_pembayaran: sisaBaru
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

// 6. Catat Pembayaran Gaji (Admin Melunasi / Mencicil Gaji)
async function bayarGaji(req, res) {
  try {
    const {
      id_gaji,
      nominal_bayar,
      metode_pembayaran = 'transfer',
      nomor_referensi = '',
      nama_penerima = '',
      nama_pembayar = req.user?.nama || 'Admin Keuangan',
      bukti_pembayaran = '',
      foto_bukti = '',
      catatan = ''
    } = req.body;

    if (!id_gaji || !nominal_bayar || Number(nominal_bayar) <= 0) {
      return res.status(400).json({ success: false, message: 'ID Gaji dan Nominal Bayar wajib diisi' });
    }

    const [rows] = await db.query('SELECT * FROM gaji WHERE id_gaji = ?', [id_gaji]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data gaji tidak ditemukan' });
    }

    const curr = rows[0];
    const nominalBayarNum = Number(nominal_bayar);
    const today = new Date().toISOString().slice(0, 10);

    const rawPhoto = bukti_pembayaran || foto_bukti || null;
    const fotoSaved = saveBase64Image(rawPhoto, 'bukti_gaji', 'bukti_gaji_');

    // Simpan ke tabel pembayaran_gaji
    await db.query(`
      INSERT INTO pembayaran_gaji
        (id_gaji, tanggal_bayar, nominal_bayar, metode_pembayaran, nomor_referensi, nama_penerima, nama_pembayar, bukti_pembayaran, catatan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id_gaji, today, nominalBayarNum, metode_pembayaran, nomor_referensi, nama_penerima, nama_pembayar, fotoSaved || null, catatan]);

    const totalDibayarBaru = Number(curr.total_dibayar || 0) + nominalBayarNum;
    const sisaBaru = Math.max(0, Number(curr.gaji_bersih || 0) - totalDibayarBaru);
    const statusBaru = sisaBaru <= 0 ? 'sudah' : 'sebagian';

    await db.query(`
      UPDATE gaji SET
        total_dibayar = ?,
        sisa_pembayaran = ?,
        status_bayar = ?,
        tanggal_bayar = NOW()
      WHERE id_gaji = ?
    `, [totalDibayarBaru, sisaBaru, statusBaru, id_gaji]);

    return res.json({
      success: true,
      message: `Pembayaran gaji sebesar Rp ${nominalBayarNum.toLocaleString('id-ID')} berhasil dicatat! Status: ${statusBaru === 'sudah' ? 'LUNAS (Sudah Dibayar)' : 'DIBAYAR SEBAGIAN'}`,
      data: {
        id_gaji,
        total_dibayar: totalDibayarBaru,
        sisa_pembayaran: sisaBaru,
        status_bayar: statusBaru
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal mencatat pembayaran gaji: ' + error.message,
      error: error.message
    });
  }
}

// 7. Ambil Daftar Pembayaran Gaji (Filter Status Bayar)
async function getPembayaranList(req, res) {
  try {
    const periode = getPeriode(req);
    const status_bayar = req.query.status_bayar || 'semua';

    let query = `
      SELECT g.*, k.nama AS nama_karyawan, k.kode_karyawan, k.jabatan
      FROM gaji g
      JOIN karyawan k ON g.id_karyawan = k.id_karyawan
      WHERE g.periode = ?
    `;
    const params = [periode];

    if (status_bayar && status_bayar !== 'semua') {
      query += ` AND g.status_bayar = ? `;
      params.push(status_bayar);
    }

    query += ` ORDER BY g.id_gaji DESC `;
    const [rows] = await db.query(query, params);

    return res.json({ success: true, data: rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

// 8. Riwayat Pembayaran Gaji Tertentu
async function getPembayaranHistory(req, res) {
  try {
    const id_gaji = req.params.id || req.query.id_gaji;
    const [rows] = await db.query('SELECT * FROM pembayaran_gaji WHERE id_gaji = ? ORDER BY id_pembayaran DESC', [id_gaji]);
    return res.json({ success: true, data: rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

// 9. Slip Gaji Lengkap (Siap Cetak / Tampil dengan Transparansi Segmen)
async function getSlipGaji(req, res) {
  try {
    const id_gaji = req.params.id || req.query.id_gaji;
    const [gRows] = await db.query(`
      SELECT g.*, k.nama, k.kode_karyawan, k.jabatan, k.email, k.nominal_upah, k.tarif_per_jam, k.lembur_aktif, k.tarif_lembur,
             mr.id_role AS master_id_role, mr.nama_role AS master_nama_role, mr.hierarchy_level AS master_hierarchy_level
      FROM gaji g
      JOIN karyawan k ON g.id_karyawan = k.id_karyawan
      LEFT JOIN master_role mr ON LOWER(TRIM(k.jabatan)) = LOWER(TRIM(mr.nama_role)) AND mr.is_active = 1
      WHERE g.id_gaji = ?
    `, [id_gaji]);

    if (gRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data slip gaji tidak ditemukan' });
    }

    const slip = gRows[0];
    const [absensi] = await db.query(`
      SELECT a.id_absensi, a.tanggal, a.jam_masuk, a.jam_pulang, a.id_pekerjaan, p.nama_pekerjaan, ${sqlDurasi} AS durasi_jam
      FROM absensi a
      LEFT JOIN pekerjaan p ON a.id_pekerjaan = p.id_pekerjaan
      WHERE a.id_karyawan = ? AND a.status_verifikasi = 'disetujui' AND a.tanggal LIKE ?
      ORDER BY a.tanggal ASC
    `, [slip.id_karyawan, `${slip.periode}%`]);

    const [reimburse] = await db.query(`
      SELECT nominal, keterangan, tanggal
      FROM pengeluaran
      WHERE id_karyawan = ? AND jenis_dana = 'pribadi' AND status_verifikasi = 'disetujui' AND tanggal LIKE ?
    `, [slip.id_karyawan, `${slip.periode}%`]);

    // Hitung rincian segmen gaji untuk transparansi slip
    const detailedCalc = await calculateEmployeePayrollDetailed(slip, absensi, slip.periode);

    return res.json({
      success: true,
      message: 'Slip gaji berhasil dimuat',
      data: {
        ...slip,
        nama_role: detailedCalc.namaRole || slip.master_nama_role || slip.jabatan,
        hierarchy_level: detailedCalc.hierarchyLevel || slip.master_hierarchy_level || 1,
        master_role: detailedCalc.masterRole,
        total_upah_pokok: detailedCalc.totalUpahPokok,
        total_upah_lembur: detailedCalc.totalUpahLembur,
        total_jam_lembur: detailedCalc.totalJamLembur,
        lembur_diizinkan: detailedCalc.lemburDiizinkan,
        absensi_list: absensi,
        reimburse_list: reimburse,
        rincian_segmen_gaji: detailedCalc.rincianSegmenGaji,
        info_cutoff: detailedCalc.infoCutoff
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

// 10. Riwayat Slip Gaji Karyawan (Arsip Riwayat Penggajian)
async function getRiwayatGaji(req, res) {
  try {
    const id_karyawan = req.query.id_karyawan || req.user?.id_karyawan;
    let query = `
      SELECT g.*, k.nama, k.nama AS nama_karyawan, k.kode_karyawan, k.jabatan
      FROM gaji g
      JOIN karyawan k ON g.id_karyawan = k.id_karyawan
    `;
    const params = [];

    if (id_karyawan) {
      query += ` WHERE g.id_karyawan = ? `;
      params.push(id_karyawan);
    }

    query += ` ORDER BY g.periode DESC, g.id_gaji DESC `;

    const [rows] = await db.query(query, params);
    return res.json({ success: true, data: rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

module.exports = {
  getRekapGaji,
  kalkulasiGaji,
  getDetailGaji,
  tetapkanGaji,
  updatePenyesuaian,
  bayarGaji,
  getPembayaranList,
  getPembayaranHistory,
  getSlipGaji,
  getRiwayatGaji,
  calculateEmployeeWages,
  calculateEmployeePayrollDetailed
};
