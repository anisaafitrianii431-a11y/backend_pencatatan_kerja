/**
 * Payroll Calculation Helper
 * Modul pembantu untuk resolusi riwayat skema gaji penugasan (penugasan_gaji_riwayat),
 * pemecahan segmen tanggal (multi-segment salary), kalkulasi upah prorata,
 * 4 satuan upah (per_jam, per_hari, per_bulan, per_tahun), dan transparansi rumus slip gaji.
 */

const { calculateEffectiveWorkingDays } = require('./projectSalaryHelper');

/**
 * Helper internal untuk menambah/mengurangi hari pada format string 'YYYY-MM-DD'
 * secara aman dari pergeseran zona waktu (UTC-safe).
 */
function addDays(dateStr, n) {
  if (!dateStr) return dateStr;
  const parts = String(dateStr).slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + n));
  return date.toISOString().slice(0, 10);
}

/**
 * 1. Mencari record skema gaji pada penugasan_gaji_riwayat yang berlaku
 *    pada targetDate tertentu (effective_from <= targetDate <= effective_to).
 * 
 * @param {Array<object>} salaryHistoryList - Daftar riwayat skema gaji
 * @param {string|Date} targetDate - Tanggal acuan (YYYY-MM-DD)
 * @param {object} [fallbackConfig={}] - Konfigurasi skema gaji cadangan jika riwayat kosong
 * @returns {object} Objek skema gaji aktif pada tanggal tersebut
 */
function resolveSalaryForDate(salaryHistoryList, targetDate, fallbackConfig = {}) {
  if (!targetDate) return fallbackConfig;
  const target = typeof targetDate === 'string' ? targetDate.slice(0, 10) : targetDate.toISOString().slice(0, 10);

  if (!Array.isArray(salaryHistoryList) || salaryHistoryList.length === 0) {
    return fallbackConfig;
  }

  // Filter record yang mencakup targetDate
  const matches = salaryHistoryList.filter(r => {
    const fromStr = String(r.effective_from).slice(0, 10);
    const toStr = r.effective_to ? String(r.effective_to).slice(0, 10) : null;
    return fromStr <= target && (!toStr || toStr >= target);
  });

  if (matches.length === 0) {
    // Jika tidak ada irisan eksak (misal tanggal sebelum record pertama), fallback
    return fallbackConfig;
  }

  // Urutkan berdasarkan effective_from DESC, id_riwayat_gaji DESC untuk mengambil yang terbaru
  matches.sort((a, b) => {
    const fromA = String(a.effective_from).slice(0, 10);
    const fromB = String(b.effective_from).slice(0, 10);
    if (fromA !== fromB) return fromB.localeCompare(fromA);
    return (Number(b.id_riwayat_gaji || 0)) - (Number(a.id_riwayat_gaji || 0));
  });

  const best = matches[0];
  return {
    ...best,
    id_riwayat_gaji: best.id_riwayat_gaji || null,
    jenis_upah: best.jenis_upah || fallbackConfig.jenis_upah || 'per_jam',
    nominal_upah: Number(best.nominal_upah !== undefined && best.nominal_upah !== null ? best.nominal_upah : (fallbackConfig.nominal_upah || 0)),
    normalized_monthly: Number(best.normalized_monthly || 0),
    effective_from: best.effective_from ? String(best.effective_from).slice(0, 10) : null,
    effective_to: best.effective_to ? String(best.effective_to).slice(0, 10) : null
  };
}

/**
 * 2. Memecah periode YYYY-MM menjadi satu atau lebih segmen tanggal
 *    berdasarkan irisan aktif karyawan dan riwayat perubahan tarif gaji.
 * 
 * @param {string} periodStart - Awal bulan (misal '2026-07-01')
 * @param {string} periodEnd - Akhir bulan (misal '2026-07-31')
 * @param {string|null} joinDate - Tanggal bergabung/penugasan karyawan
 * @param {string|null} endTaskDate - Tanggal selesai tugas karyawan
 * @param {string|null} projectStart - Tanggal mulai proyek
 * @param {string|null} projectEnd - Target selesai proyek
 * @param {Array<object>} salaryHistoryList - Daftar riwayat gaji penugasan
 * @param {object} fallbackConfig - Skema gaji fallback
 * @returns {Array<object>} Daftar segmen tanggal dengan skema gaji masing-masing
 */
function splitPeriodBySalarySegments(
  periodStart,
  periodEnd,
  joinDate,
  endTaskDate,
  projectStart,
  projectEnd,
  salaryHistoryList = [],
  fallbackConfig = {}
) {
  const pStart = String(periodStart).slice(0, 10);
  const pEnd = String(periodEnd).slice(0, 10);
  const jDate = joinDate ? String(joinDate).slice(0, 10) : null;
  const eDate = endTaskDate ? String(endTaskDate).slice(0, 10) : null;
  const prjStart = projectStart ? String(projectStart).slice(0, 10) : null;
  const prjEnd = projectEnd ? String(projectEnd).slice(0, 10) : null;

  // activeStart = MAX(periodStart, projectStart, joinDate)
  let activeStart = pStart;
  if (prjStart && prjStart > activeStart) activeStart = prjStart;
  if (jDate && jDate > activeStart) activeStart = jDate;

  // activeEnd = MIN(periodEnd, projectEnd, endTaskDate)
  let activeEnd = pEnd;
  if (prjEnd && prjEnd < activeEnd) activeEnd = prjEnd;
  if (eDate && eDate < activeEnd) activeEnd = eDate;

  // Jika rentang aktif tidak valid atau di luar periode, karyawan tidak aktif
  if (activeStart > activeEnd) {
    return [];
  }

  // Jika tidak memiliki riwayat gaji, kembalikan 1 segmen tunggal
  if (!Array.isArray(salaryHistoryList) || salaryHistoryList.length === 0) {
    const isFull = (activeStart <= pStart && activeEnd >= pEnd);
    return [{
      segmen_mulai: activeStart,
      segmen_selesai: activeEnd,
      is_full_period: isFull,
      jenis_upah: fallbackConfig.jenis_upah || 'per_jam',
      nominal_upah: Number(fallbackConfig.nominal_upah || 0),
      id_riwayat_gaji: null,
      effective_from: activeStart,
      effective_to: null
    }];
  }

  // Kumpulkan seluruh titik potong di dalam interval [activeStart, activeEnd]
  const cutPoints = new Set();
  cutPoints.add(activeStart);

  for (const r of salaryHistoryList) {
    if (r.effective_from) {
      const fromStr = String(r.effective_from).slice(0, 10);
      if (fromStr > activeStart && fromStr <= activeEnd) {
        cutPoints.add(fromStr);
      }
    }
    if (r.effective_to) {
      const nextDay = addDays(String(r.effective_to).slice(0, 10), 1);
      if (nextDay > activeStart && nextDay <= activeEnd) {
        cutPoints.add(nextDay);
      }
    }
  }

  const sortedCuts = Array.from(cutPoints).sort();
  const segments = [];

  for (let i = 0; i < sortedCuts.length; i++) {
    const sStart = sortedCuts[i];
    let sEnd = activeEnd;
    if (i < sortedCuts.length - 1) {
      sEnd = addDays(sortedCuts[i + 1], -1);
    }

    const scheme = resolveSalaryForDate(salaryHistoryList, sStart, fallbackConfig);
    // Periode penuh hanya jika segmen mencakup seluruh awal sampai akhir bulan
    const isFull = (sortedCuts.length === 1 && sStart <= pStart && sEnd >= pEnd);

    segments.push({
      segmen_mulai: sStart,
      segmen_selesai: sEnd,
      is_full_period: isFull,
      jenis_upah: scheme.jenis_upah,
      nominal_upah: Number(scheme.nominal_upah || 0),
      id_riwayat_gaji: scheme.id_riwayat_gaji || null,
      effective_from: scheme.effective_from || null,
      effective_to: scheme.effective_to || null
    });
  }

  return segments;
}

/**
 * 3. Menghitung upah satu segmen tanggal secara presisi beserta teks rumus transparansinya.
 * 
 * Aturan:
 * - per_jam: total_jam_valid * nominal_upah
 * - per_hari: total_hari_hadir * nominal_upah
 * - per_bulan:
 *     - Periode penuh: nominal_upah (is_prorata = false)
 *     - Prorata: nominal_upah * (hari_efektif / hari_kerja_per_bulan) (is_prorata = true)
 * - per_tahun: (nominal_upah / 12) dengan aturan periode penuh / prorata sama dengan per_bulan
 * 
 * @param {object} segment - Objek segmen hasil splitPeriodBySalarySegments
 * @param {Array<object>} attendanceLogsInSegment - Log absensi yang disetujui dalam rentang segmen
 * @param {object} [projectCalendar={}] - Standar kalender kerja proyek
 * @returns {object} Hasil kalkulasi upah, jam, hari, flag prorata, dan rumus_teks
 */
function calculateSegmentWage(segment, attendanceLogsInSegment = [], projectCalendar = {}) {
  const hKerja = Number(projectCalendar.hari_kerja_per_bulan || 22);
  const jKerja = Number(projectCalendar.jam_kerja_per_hari || 8);
  const nominal = Number(segment.nominal_upah || 0);
  const jenis = segment.jenis_upah || 'per_jam';

  // Kumpulkan log absensi unik dan hitung durasi jam
  const uniqueDays = new Set();
  let totalJam = 0;

  for (const a of attendanceLogsInSegment) {
    const d = a.tanggal ? String(a.tanggal).slice(0, 10) : '';
    if (d >= segment.segmen_mulai && d <= segment.segmen_selesai) {
      if (d) uniqueDays.add(d);
      totalJam += Number(a.durasi_jam || 0);
    }
  }

  totalJam = Number(totalJam.toFixed(2));
  const totalHari = uniqueDays.size;

  let upah = 0;
  let isProrata = false;
  let rumusTeks = '';
  let hariEfektif = 0;

  switch (jenis) {
    case 'borongan':
      upah = Math.round(nominal);
      isProrata = false;
      rumusTeks = `Upah borongan tetap = Rp ${nominal.toLocaleString('id-ID')}`;
      break;

    case 'per_jam':
      upah = Math.round(totalJam * nominal);
      isProrata = false;
      rumusTeks = `${totalJam} jam kerja x Rp ${nominal.toLocaleString('id-ID')} = Rp ${upah.toLocaleString('id-ID')}`;
      break;

    case 'per_hari':
      upah = Math.round(totalHari * nominal);
      isProrata = false;
      rumusTeks = `${totalHari} hari hadir x Rp ${nominal.toLocaleString('id-ID')} = Rp ${upah.toLocaleString('id-ID')}`;
      break;

    case 'per_bulan':
      if (segment.is_full_period) {
        upah = Math.round(nominal);
        isProrata = false;
        rumusTeks = `Gaji bulanan penuh = Rp ${nominal.toLocaleString('id-ID')}`;
      } else {
        const eff = calculateEffectiveWorkingDays(segment.segmen_mulai, segment.segmen_selesai, hKerja);
        hariEfektif = eff.effectiveWorkingDays;
        const rasio = Math.min(1, hariEfektif / hKerja);
        upah = Math.round(nominal * rasio);
        isProrata = true;
        rumusTeks = `Prorata ${hariEfektif}/${hKerja} hari x Rp ${nominal.toLocaleString('id-ID')} = Rp ${upah.toLocaleString('id-ID')}`;
      }
      break;

    case 'per_tahun':
      const bulananEkuivalen = nominal / 12;
      if (segment.is_full_period) {
        upah = Math.round(bulananEkuivalen);
        isProrata = false;
        rumusTeks = `Rp ${nominal.toLocaleString('id-ID')}/tahun ÷ 12 bulan = Rp ${upah.toLocaleString('id-ID')}`;
      } else {
        const eff = calculateEffectiveWorkingDays(segment.segmen_mulai, segment.segmen_selesai, hKerja);
        hariEfektif = eff.effectiveWorkingDays;
        const rasio = Math.min(1, hariEfektif / hKerja);
        upah = Math.round(bulananEkuivalen * rasio);
        isProrata = true;
        rumusTeks = `Prorata ${hariEfektif}/${hKerja} hari x (Rp ${nominal.toLocaleString('id-ID')} ÷ 12) = Rp ${upah.toLocaleString('id-ID')}`;
      }
      break;

    default:
      upah = Math.round(totalJam * nominal);
      isProrata = false;
      rumusTeks = `${totalJam} jam kerja x Rp ${nominal.toLocaleString('id-ID')} = Rp ${upah.toLocaleString('id-ID')}`;
      break;
  }

  return {
    upah,
    is_prorata: isProrata,
    rumus_teks: rumusTeks,
    total_jam_kerja: totalJam,
    total_hari_hadir: totalHari,
    hari_efektif_aktif: hariEfektif,
    standar_hari_bulan: hKerja
  };
}

module.exports = {
  resolveSalaryForDate,
  splitPeriodBySalarySegments,
  calculateSegmentWage
};
