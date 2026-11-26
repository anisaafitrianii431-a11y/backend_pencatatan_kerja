/**
 * Project Salary Helper
 * Modul pembantu untuk kalkulasi multi-satuan gaji, kalender kerja proyek,
 * validasi hierarki role blueprint, serta kalkulasi komitmen anggaran proyek.
 */

/**
 * 1. Normalisasi nominal upah dari berbagai satuan ke nilai bulanan (per_bulan)
 *    berdasarkan kalender kerja proyek.
 * 
 * @param {string} jenisUpah - 'per_jam' | 'per_hari' | 'per_bulan' | 'per_tahun'
 * @param {number} nominalUpah - Nominal upah dalam satuan jenisUpah
 * @param {number} [hariKerjaPerBulan=22] - Jumlah hari kerja proyek dalam 1 bulan
 * @param {number} [jamKerjaPerHari=8] - Jam kerja proyek dalam 1 hari
 * @returns {number} Nominal setara bulanan dibulatkan ke 2 desimal
 */
function normalizeToMonthly(jenisUpah, nominalUpah, hariKerjaPerBulan = 22, jamKerjaPerHari = 8) {
  const nominal = Number(nominalUpah) || 0;
  const h = Number(hariKerjaPerBulan) || 22;
  const j = Number(jamKerjaPerHari) || 8;

  let monthly = 0;
  switch (jenisUpah) {
    case 'per_jam':
      monthly = nominal * j * h;
      break;
    case 'per_hari':
      monthly = nominal * h;
      break;
    case 'per_bulan':
      monthly = nominal;
      break;
    case 'per_tahun':
      monthly = nominal / 12;
      break;
    default:
      monthly = nominal;
      break;
  }

  return Number(monthly.toFixed(2));
}

/**
 * 2. Mengonversi rentang gaji bulanan (Min-Max) ke seluruh 4 satuan
 *    berdasarkan kalender kerja proyek.
 * 
 * @param {number} minBulanan - Batas minimal bulanan
 * @param {number} maxBulanan - Batas maksimal bulanan
 * @param {number} [hariKerjaPerBulan=22] - Jumlah hari kerja proyek dalam 1 bulan
 * @param {number} [jamKerjaPerHari=8] - Jam kerja proyek dalam 1 hari
 * @returns {object} Objek min & max untuk per_jam, per_hari, per_bulan, per_tahun
 */
function convertMonthlyRangeToAllUnits(minBulanan, maxBulanan, hariKerjaPerBulan = 22, jamKerjaPerHari = 8) {
  const minB = Number(minBulanan) || 0;
  const maxB = Number(maxBulanan) || 0;
  const h = Number(hariKerjaPerBulan) || 22;
  const j = Number(jamKerjaPerHari) || 8;
  const totalJamPerBulan = h * j;

  return {
    per_jam: {
      min: totalJamPerBulan > 0 ? Number((minB / totalJamPerBulan).toFixed(2)) : 0,
      max: totalJamPerBulan > 0 ? Number((maxB / totalJamPerBulan).toFixed(2)) : 0
    },
    per_hari: {
      min: h > 0 ? Number((minB / h).toFixed(2)) : 0,
      max: h > 0 ? Number((maxB / h).toFixed(2)) : 0
    },
    per_bulan: {
      min: Number(minB.toFixed(2)),
      max: Number(maxB.toFixed(2))
    },
    per_tahun: {
      min: Number((minB * 12).toFixed(2)),
      max: Number((maxB * 12).toFixed(2))
    }
  };
}

/**
 * 3. Validasi aturan hierarki & integritas blueprint role dalam satu proyek.
 * 
 * Aturan:
 * - Tidak boleh ada id_role duplikat.
 * - Setiap role: kuota_slot >= 1 (bulat), gaji_min_bulanan > 0, gaji_max_bulanan > gaji_min_bulanan.
 * - Antar role:
 *   - Jika A.hierarchy_level < B.hierarchy_level, wajib A.gaji_max_bulanan < B.gaji_min_bulanan.
 *   - Jika A.hierarchy_level === B.hierarchy_level, rentang tidak boleh beririsan/bersentuhan
 *     (A.gaji_max_bulanan < B.gaji_min_bulanan ATAU A.gaji_min_bulanan > B.gaji_max_bulanan).
 * 
 * @param {Array<object>} roleBudgets - Array role blueprint yang dilengkapi nama_role dan hierarchy_level
 * @returns {{ valid: boolean, message?: string }}
 */
function validateRoleBudgetsHierarchy(roleBudgets) {
  if (!Array.isArray(roleBudgets) || roleBudgets.length === 0) {
    return { valid: false, message: 'Daftar blueprint role tidak boleh kosong' };
  }

  const seenRoleIds = new Set();

  for (let i = 0; i < roleBudgets.length; i++) {
    const r = roleBudgets[i];
    const roleId = Number(r.id_role);
    const roleName = r.nama_role || `Role #${roleId}`;

    // Cek duplikat id_role
    if (seenRoleIds.has(roleId)) {
      return {
        valid: false,
        message: `Role "${roleName}" (ID ${roleId}) terdaftar lebih dari satu kali dalam proyek ini.`
      };
    }
    seenRoleIds.add(roleId);

    // Cek kuota slot (minimal 1)
    const kuota = Number(r.kuota_slot);
    if (!Number.isInteger(kuota) || kuota < 1) {
      return {
        valid: false,
        message: `Kuota slot untuk role "${roleName}" harus berupa bilangan bulat minimal 1.`
      };
    }
  }

  // Tingkatan jabatan pada proyek tidak ditentukan berdasarkan rentang gaji.
  // Validasi rentang gaji min-max dihapus sesuai arahan Direktur.
  return { valid: true };
}

/**
 * 4. Menghitung jumlah hari kerja efektif (inklusif) antara startDate dan endDate.
 * 
 * Aturan kalender kerja proyek:
 * - hariKerjaPerBulan <= 22 -> Senin–Jumat (5 hari kerja/minggu)
 * - hariKerjaPerBulan 23..26 -> Senin–Sabtu (6 hari kerja/minggu)
 * - hariKerjaPerBulan >= 27 -> Seluruh hari kalender (7 hari/minggu)
 * 
 * @param {string|Date} startDate 
 * @param {string|Date} endDate 
 * @param {number} [hariKerjaPerBulan=22] 
 * @returns {{ effectiveWorkingDays: number, faktor_bulan: number }}
 */
function calculateEffectiveWorkingDays(startDate, endDate, hariKerjaPerBulan = 22) {
  if (!startDate || !endDate) {
    return { effectiveWorkingDays: 0, faktor_bulan: 0 };
  }

  const start = new Date(startDate);
  const end = new Date(endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
    return { effectiveWorkingDays: 0, faktor_bulan: 0 };
  }

  const h = Number(hariKerjaPerBulan) || 22;

  // Normalisasi waktu ke jam 00:00:00 UTC/lokal agar perhitungan hari bersih
  const curr = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());

  let workingDays = 0;

  while (curr <= last) {
    const dayOfWeek = curr.getDay(); // 0 = Minggu, 1 = Senin, ..., 6 = Sabtu

    if (h <= 22) {
      if (dayOfWeek >= 1 && dayOfWeek <= 5) workingDays++;
    } else if (h >= 23 && h <= 26) {
      if (dayOfWeek >= 1 && dayOfWeek <= 6) workingDays++;
    } else {
      // >= 27: seluruh hari kalender
      workingDays++;
    }

    curr.setDate(curr.getDate() + 1);
  }

  const faktorBulan = h > 0 ? Number((workingDays / h).toFixed(4)) : 0;

  return {
    effectiveWorkingDays: workingDays,
    faktor_bulan: faktorBulan
  };
}

/**
 * 5. Menghitung proyeksi biaya komitmen gaji satu karyawan selama periode tugasnya.
 * 
 * Rumus:
 * - per_jam   -> nominalUpah * jamKerjaPerHari * effectiveDaysEmployee
 * - per_hari  -> nominalUpah * effectiveDaysEmployee
 * - per_bulan -> nominalUpah * (effectiveDaysEmployee / hariKerjaPerBulan)
 * - per_tahun -> (nominalUpah / 12) * (effectiveDaysEmployee / hariKerjaPerBulan)
 * 
 * @param {string} jenisUpah 
 * @param {number} nominalUpah 
 * @param {number} effectiveDaysEmployee 
 * @param {number} [hariKerjaPerBulan=22] 
 * @param {number} [jamKerjaPerHari=8] 
 * @returns {number} Biaya komitmen dibulatkan ke 2 desimal
 */
function calculateIndividualCommitment(jenisUpah, nominalUpah, effectiveDaysEmployee, hariKerjaPerBulan = 22, jamKerjaPerHari = 8) {
  const nominal = Number(nominalUpah) || 0;
  const days = Number(effectiveDaysEmployee) || 0;
  const h = Number(hariKerjaPerBulan) || 22;
  const j = Number(jamKerjaPerHari) || 8;

  let total = 0;
  switch (jenisUpah) {
    case 'per_jam':
      total = nominal * j * days;
      break;
    case 'per_hari':
      total = nominal * days;
      break;
    case 'per_bulan':
      total = h > 0 ? nominal * (days / h) : 0;
      break;
    case 'per_tahun':
      total = h > 0 ? (nominal / 12) * (days / h) : 0;
      break;
    default:
      total = nominal * days;
      break;
  }

  return Number(total.toFixed(2));
}

module.exports = {
  normalizeToMonthly,
  convertMonthlyRangeToAllUnits,
  validateRoleBudgetsHierarchy,
  calculateEffectiveWorkingDays,
  calculateIndividualCommitment
};
