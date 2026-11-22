/**
 * Automated Verification Script - Fase 3: Upgrade Payroll Engine
 * Menguji 6 skenario payroll (anti-overwrite, multi-segmen, prorata, per-tahun, keterlambatan absensi, dan regresi)
 * serta membersihkan seluruh data uji dari database di akhir script.
 */

const http = require('http');
const db = require('../config/database');

const BASE_URL = 'http://localhost:5000';
const HEADERS = {
  'Content-Type': 'application/json',
  'X-User-Role': 'admin',
  'Authorization': 'Bearer 1'
};

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method.toUpperCase(),
      headers: { ...HEADERS }
    };

    let postData = null;
    if (body) {
      postData = JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = http.request(options, (res) => {
      let rawData = '';
      res.on('data', chunk => rawData += chunk);
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(rawData);
        } catch (e) {
          json = { raw: rawData };
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: json
        });
      });
    });

    req.on('error', (err) => reject(err));
    if (postData) req.write(postData);
    req.end();
  });
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(message);
  } else {
    console.log(`  ✓ ${message}`);
  }
}

async function runTest() {
  console.log('====================================================');
  console.log('🚀 MEMULAI PENGUJIAN OTOMATIS FASE 3: PAYROLL ENGINE');
  console.log('====================================================\n');

  const createdRoleIds = [];
  const createdProjectIds = [];
  const createdAssignmentIds = [];
  const createdAbsensiIds = [];

  try {
    // ----------------------------------------------------
    // SETUP: Role Master & Karyawan Sampel
    // ----------------------------------------------------
    console.log('--- SETUP: Inisialisasi Role Master & Pekerja Uji ---');
    const [resRole1] = await db.query(
      `INSERT INTO master_role (nama_role, hierarchy_level, default_gaji_min_bulanan, default_gaji_max_bulanan, deskripsi, is_active)
       VALUES ('Uji Helper Fase3', 1, 3000000, 4200000, 'Helper level 1', 1)`
    );
    const idRoleHelper = resRole1.insertId;
    createdRoleIds.push(idRoleHelper);

    const [resRole2] = await db.query(
      `INSERT INTO master_role (nama_role, hierarchy_level, default_gaji_min_bulanan, default_gaji_max_bulanan, deskripsi, is_active)
       VALUES ('Uji Staf Fase3', 2, 4500000, 6500000, 'Staf level 2', 1)`
    );
    const idRoleStaf = resRole2.insertId;
    createdRoleIds.push(idRoleStaf);

    const [empRows] = await db.query('SELECT id_karyawan, nama FROM karyawan WHERE status = "aktif" LIMIT 3');
    assert(empRows.length >= 3, 'Terdapat minimal 3 karyawan aktif di database');
    const emp1 = empRows[0];
    const emp2 = empRows[1];
    const emp3 = empRows[2];
    console.log(`  ✓ Role uji dibuat: Helper (ID ${idRoleHelper}), Staf (ID ${idRoleStaf})`);
    console.log(`  ✓ Pekerja sampel: [${emp1.id_karyawan}] ${emp1.nama}, [${emp2.id_karyawan}] ${emp2.nama}, [${emp3.id_karyawan}] ${emp3.nama}\n`);

    // Buat Proyek Uji Payroll (Mei - Juli 2026, 24 hari/bulan, 8 jam/hari)
    const projectPayload = {
      nama_pekerjaan: 'Proyek Uji Payroll Fase 3',
      hari_kerja_per_bulan: 24,
      jam_kerja_per_hari: 8,
      jam_masuk_standar: '08:00:00',
      toleransi_terlambat_menit: 15,
      tanggal_mulai: '2026-05-01',
      target_selesai: '2026-07-31',
      tanggal_cutoff: 25,
      tanggal_pencairan: 28,
      role_budgets: [
        { id_role: idRoleHelper, kuota_slot: 2, gaji_min_bulanan: 3000000, gaji_max_bulanan: 4200000 },
        { id_role: idRoleStaf, kuota_slot: 2, gaji_min_bulanan: 4500000, gaji_max_bulanan: 6500000 }
      ]
    };
    const resProj = await request('POST', '/api/pekerjaan', projectPayload);
    assert(resProj.status === 201, 'Proyek uji Fase 3 berhasil dibuat (HTTP 201)');
    const idProject = resProj.data.data.id_pekerjaan;
    createdProjectIds.push(idProject);

    // Ambil detail blueprint slot
    const resBlueprint = await request('GET', `/api/pekerjaan/${idProject}/blueprint`);
    const slotStaf = resBlueprint.data.data.role_budgets.find(r => r.id_role === idRoleStaf);
    const slotHelper = resBlueprint.data.data.role_budgets.find(r => r.id_role === idRoleHelper);

    // ----------------------------------------------------
    // SKENARIO 1: Anti-Overwrite / Immutability Slip Lama
    // ----------------------------------------------------
    console.log('--- SKENARIO 1: Anti-Overwrite / Immutability Slip Lama ---');

    // 1A: Assign Karyawan 1 ke slot Staf dengan per_hari Rp 200.000 efektif 2026-05-01
    const resAssign1 = await request('POST', '/api/penugasan', {
      id_pekerjaan: idProject,
      id_karyawan: emp1.id_karyawan,
      id_role_budget: slotStaf.id_role_budget,
      jenis_upah: 'per_hari',
      nominal_upah: 200000,
      tanggal_penugasan: '2026-05-01',
      tanggal_selesai_tugas: '2026-07-31'
    });
    assert(resAssign1.status === 201, 'Karyawan 1 di-assign per_hari Rp 200.000 efektif 2026-05-01');
    const idPenugasan1 = resAssign1.data.data.id_penugasan;
    createdAssignmentIds.push(idPenugasan1);

    // 1B: Tambah 3 hari absensi disetujui di bulan Mei 2026 (4, 5, 6 Mei 2026)
    const absDatesMay = ['2026-05-04', '2026-05-05', '2026-05-06'];
    for (const d of absDatesMay) {
      const [insAbs] = await db.query(
        `INSERT INTO absensi (id_pekerjaan, id_karyawan, tanggal, jam_masuk, jam_pulang, status_verifikasi)
         VALUES (?, ?, ?, '08:00:00', '17:00:00', 'disetujui')`,
        [idProject, emp1.id_karyawan, d]
      );
      createdAbsensiIds.push(insAbs.insertId);
    }
    console.log('  ✓ 3 hari absensi disetujui bulan Mei 2026 tercatat');

    // 1C: Ubah skema gaji Karyawan 1 menjadi per_bulan Rp 5.000.000 efektif 2026-06-01
    const resUpdateScheme = await request('POST', `/api/penugasan/${idPenugasan1}/gaji-riwayat`, {
      jenis_upah: 'per_bulan',
      nominal_upah: 5000000,
      effective_from: '2026-06-01',
      catatan: 'Kenaikan ke upah bulanan'
    });
    assert(resUpdateScheme.status === 201, 'Skema gaji berhasil diubah ke per_bulan Rp 5.000.000 efektif 2026-06-01');

    // 1D: Verifikasi Periode Mei 2026 (Anti-Overwrite): tetap menggunakan tarif per_hari Rp 200.000
    const resMay = await request('GET', `/api/gaji?action=detail&id_karyawan=${emp1.id_karyawan}&periode=2026-05`);
    assert(resMay.status === 200, 'GET /api/gaji?action=detail periode 2026-05 berhasil (200)');
    assert(resMay.data.data.total_upah === 600000, 'Gaji Mei 2026 tetap 3 hari x Rp 200.000 = Rp 600.000 (tidak tertimpa skema baru)');

    const segMay = resMay.data.data.rincian_segmen_gaji[0];
    assert(segMay.jenis_upah === 'per_hari' && segMay.nominal_upah === 200000, 'Segmen Mei memuat jenis_upah per_hari dan nominal Rp 200.000');
    assert(segMay.rumus_teks.includes('3 hari hadir x Rp 200.000 = Rp 600.000'), 'Rumus teks Mei 2026 transparan dan akurat');

    // 1E: Verifikasi Periode Juni 2026: menggunakan skema baru per_bulan Rp 5.000.000 penuh
    const resJune = await request('GET', `/api/gaji?action=detail&id_karyawan=${emp1.id_karyawan}&periode=2026-06`);
    assert(resJune.status === 200, 'GET /api/gaji?action=detail periode 2026-06 berhasil (200)');
    assert(resJune.data.data.total_upah === 5000000, 'Gaji Juni 2026 terhitung penuh Rp 5.000.000');
    const segJune = resJune.data.data.rincian_segmen_gaji[0];
    assert(segJune.is_prorata === false, 'Bulan Juni 2026 berstatus is_prorata: false (periode penuh)');
    assert(segJune.rumus_teks.includes('Gaji bulanan penuh = Rp 5.000.000'), 'Rumus teks Juni 2026 memuat gaji bulanan penuh');
    console.log('');

    // ----------------------------------------------------
    // SKENARIO 2: Perubahan Skema di Tengah Bulan (Multi-Segmen)
    // ----------------------------------------------------
    console.log('--- SKENARIO 2: Perubahan Skema di Tengah Bulan (Multi-Segmen) ---');

    // 2A: Ubah skema gaji Karyawan 1 pada 2026-07-16 menjadi per_hari Rp 220.000
    const resUpdateJuly = await request('POST', `/api/penugasan/${idPenugasan1}/gaji-riwayat`, {
      jenis_upah: 'per_hari',
      nominal_upah: 220000,
      effective_from: '2026-07-16',
      catatan: 'Perubahan ke harian di pertengahan Juli'
    });
    assert(resUpdateJuly.status === 201, 'Skema gaji diubah ke per_hari Rp 220.000 efektif 2026-07-16');

    // 2B: Catat 4 hari absensi disetujui antara 16 - 31 Juli (16, 17, 20, 21 Juli 2026)
    const absDatesJuly = ['2026-07-16', '2026-07-17', '2026-07-20', '2026-07-21'];
    for (const d of absDatesJuly) {
      const [insAbs] = await db.query(
        `INSERT INTO absensi (id_pekerjaan, id_karyawan, tanggal, jam_masuk, jam_pulang, status_verifikasi)
         VALUES (?, ?, ?, '08:00:00', '17:00:00', 'disetujui')`,
        [idProject, emp1.id_karyawan, d]
      );
      createdAbsensiIds.push(insAbs.insertId);
    }
    console.log('  ✓ 4 hari absensi disetujui tercatat pada paruh kedua Juli 2026');

    // 2C: Verifikasi Periode Juli 2026: WAJIB menghasilkan 2 segmen
    const resJuly = await request('GET', `/api/gaji?action=detail&id_karyawan=${emp1.id_karyawan}&periode=2026-07`);
    assert(resJuly.status === 200, 'GET /api/gaji?action=detail periode 2026-07 berhasil (200)');
    const segmenJuly = resJuly.data.data.rincian_segmen_gaji;
    assert(segmenJuly.length === 2, 'Gaji Juli 2026 otomatis dipecah menjadi 2 segmen tanggal');

    // Segmen 1: 1 - 15 Juli 2026 (per_bulan Rp 5.000.000 prorata)
    const jSeg1 = segmenJuly.find(s => s.segmen_mulai === '2026-07-01');
    assert(jSeg1 && jSeg1.jenis_upah === 'per_bulan' && jSeg1.is_prorata === true, 'Segmen 1 Juli adalah prorata per_bulan');
    assert(jSeg1.hari_efektif_aktif === 13, 'Segmen 1 Juli memiliki 13 hari kerja efektif (Mon-Sat)');
    assert(jSeg1.subtotal_upah === 2708333, 'Subtotal segmen 1: Math.round(5jt * 13/24) = Rp 2.708.333');
    assert(jSeg1.rumus_teks.includes('Prorata 13/24 hari x Rp 5.000.000 = Rp 2.708.333'), 'Rumus teks segmen 1 akurat');

    // Segmen 2: 16 - 31 Juli 2026 (per_hari Rp 220.000 x 4 hari = Rp 880.000)
    const jSeg2 = segmenJuly.find(s => s.segmen_mulai === '2026-07-16');
    assert(jSeg2 && jSeg2.jenis_upah === 'per_hari' && jSeg2.total_hari_hadir === 4, 'Segmen 2 Juli memuat 4 hari hadir');
    assert(jSeg2.subtotal_upah === 880000, 'Subtotal segmen 2: 4 x Rp 220.000 = Rp 880.000');
    assert(jSeg2.rumus_teks.includes('4 hari hadir x Rp 220.000 = Rp 880.000'), 'Rumus teks segmen 2 akurat');

    const expectedTotalJuly = 2708333 + 880000; // 3.588.333
    assert(resJuly.data.data.total_upah === expectedTotalJuly, `Total upah Juli tepat Rp ${expectedTotalJuly.toLocaleString('id-ID')}`);
    console.log('');

    // ----------------------------------------------------
    // SKENARIO 3: Karyawan Baru Bergabung di Tengah Bulan (Prorata)
    // ----------------------------------------------------
    console.log('--- SKENARIO 3: Karyawan Baru Bergabung di Tengah Bulan (Prorata) ---');

    // 3A: Assign Karyawan 2 pada tanggal 2026-06-16 dengan per_bulan Rp 4.800.000
    const resAssign2 = await request('POST', '/api/penugasan', {
      id_pekerjaan: idProject,
      id_karyawan: emp2.id_karyawan,
      id_role_budget: slotStaf.id_role_budget,
      jenis_upah: 'per_bulan',
      nominal_upah: 4800000,
      tanggal_penugasan: '2026-06-16',
      tanggal_selesai_tugas: '2026-07-31'
    });
    assert(resAssign2.status === 201, 'Karyawan 2 di-assign bergabung tengah bulan (2026-06-16) per_bulan Rp 4.800.000');
    createdAssignmentIds.push(resAssign2.data.data.id_penugasan);

    // 3B: Hitung gaji Juni 2026: 16 - 30 Juni memiliki 13 hari kerja efektif -> 13/24 x 4.8jt = 2.600.000
    const resJune2 = await request('GET', `/api/gaji?action=detail&id_karyawan=${emp2.id_karyawan}&periode=2026-06`);
    assert(resJune2.status === 200, 'GET /api/gaji?action=detail Karyawan 2 periode 2026-06 berhasil (200)');
    const segJune2 = resJune2.data.data.rincian_segmen_gaji[0];
    assert(segJune2 && segJune2.is_prorata === true, 'Karyawan bergabung tengah bulan berstatus is_prorata: true');
    assert(segJune2.hari_efektif_aktif === 13, 'Hari efektif aktif paruh kedua Juni = 13 hari');
    assert(segJune2.subtotal_upah === 2600000, 'Upah prorata tepat: Math.round(4.8jt * 13/24) = Rp 2.600.000');
    assert(segJune2.rumus_teks.includes('Prorata 13/24 hari x Rp 4.800.000 = Rp 2.600.000'), 'Rumus teks prorata akurat');
    console.log('');

    // ----------------------------------------------------
    // SKENARIO 4: Satuan Gaji per_tahun (Penuh & Prorata)
    // ----------------------------------------------------
    console.log('--- SKENARIO 4: Satuan Gaji per_tahun (Penuh & Prorata) ---');

    // 4A: Assign Karyawan 3 dengan per_tahun Rp 42.000.000 efektif 2026-06-01 pada slot Helper
    const resAssign3 = await request('POST', '/api/penugasan', {
      id_pekerjaan: idProject,
      id_karyawan: emp3.id_karyawan,
      id_role_budget: slotHelper.id_role_budget,
      jenis_upah: 'per_tahun',
      nominal_upah: 42000000,
      tanggal_penugasan: '2026-06-01',
      tanggal_selesai_tugas: '2026-07-31'
    });
    assert(resAssign3.status === 201, 'Karyawan 3 di-assign dengan per_tahun Rp 42.000.000 efektif 2026-06-01');
    createdAssignmentIds.push(resAssign3.data.data.id_penugasan);

    // 4B: Verifikasi Periode Juni 2026 (Periode Penuh per_tahun): Rp 42.000.000 / 12 = Rp 3.500.000
    const resJune3 = await request('GET', `/api/gaji?action=detail&id_karyawan=${emp3.id_karyawan}&periode=2026-06`);
    assert(resJune3.status === 200, 'GET /api/gaji?action=detail Karyawan 3 periode 2026-06 berhasil (200)');
    const segJune3 = resJune3.data.data.rincian_segmen_gaji[0];
    assert(segJune3 && segJune3.subtotal_upah === 3500000, 'Upah per_tahun periode penuh: 42jt / 12 = Rp 3.500.000');
    assert(segJune3.is_prorata === false, 'Periode penuh per_tahun berstatus is_prorata: false');
    assert(segJune3.rumus_teks.includes('Rp 42.000.000/tahun ÷ 12 bulan = Rp 3.500.000'), 'Rumus teks per_tahun transparan dan tepat');
    console.log('');

    // ----------------------------------------------------
    // SKENARIO 5: Evaluasi Toleransi Keterlambatan Absensi
    // ----------------------------------------------------
    console.log('--- SKENARIO 5: Evaluasi Toleransi Keterlambatan Absensi ---');

    // 5A: Check-in dalam batas toleransi (08:10 saat jam masuk standar 08:00 + toleransi 15 menit)
    const resCheckinOnTime = await request('POST', '/api/absensi', {
      id_pekerjaan: idProject,
      id_karyawan: emp1.id_karyawan,
      tanggal: '2026-06-10',
      jam_masuk: '08:10:00'
    });
    assert(resCheckinOnTime.status === 201, 'Check-in jam 08:10 berhasil dicatat (HTTP 201)');
    assert(resCheckinOnTime.data.data.status_keterlambatan === 'tepat_waktu', 'Status keterlambatan: tepat_waktu');
    assert(resCheckinOnTime.data.data.menit_terlambat === 0, 'Menit terlambat = 0');
    createdAbsensiIds.push(resCheckinOnTime.data.data.id_absensi);

    // 5B: Check-in melewati batas toleransi (08:30)
    const resCheckinLate = await request('POST', '/api/absensi', {
      id_pekerjaan: idProject,
      id_karyawan: emp2.id_karyawan,
      tanggal: '2026-06-10',
      jam_masuk: '08:30:00'
    });
    assert(resCheckinLate.status === 201, 'Check-in jam 08:30 tetap diterima (tidak diblokir) HTTP 201');
    assert(resCheckinLate.data.data.status_keterlambatan === 'terlambat', 'Status keterlambatan: terlambat');
    assert(resCheckinLate.data.data.menit_terlambat === 30, 'Menit terlambat = 30 menit (selisih dari jam masuk standar 08:00)');
    createdAbsensiIds.push(resCheckinLate.data.data.id_absensi);

    // 5C: Verifikasi evaluasi keterlambatan pada GET /api/absensi
    const resAllAbs = await request('GET', `/api/absensi?id_pekerjaan=${idProject}&tanggal=2026-06-10`);
    assert(resAllAbs.status === 200, 'GET /api/absensi berhasil memuat data dengan evaluasi keterlambatan');
    const onTimeItem = resAllAbs.data.data.find(a => a.id_absensi === resCheckinOnTime.data.data.id_absensi);
    const lateItem = resAllAbs.data.data.find(a => a.id_absensi === resCheckinLate.data.data.id_absensi);
    assert(onTimeItem && onTimeItem.status_keterlambatan === 'tepat_waktu', 'Query absensi tepat waktu sesuai');
    assert(lateItem && lateItem.status_keterlambatan === 'terlambat' && lateItem.menit_terlambat === 30, 'Query absensi terlambat sesuai');
    console.log('');

    // ----------------------------------------------------
    // SKENARIO 6: Regresi Total & Konsistensi Fitur
    // ----------------------------------------------------
    console.log('--- SKENARIO 6: Regresi Total & Konsistensi Fitur ---');

    // 6A: GET /api/gaji rekap
    const resRekap = await request('GET', '/api/gaji?periode=2026-06');
    assert(resRekap.status === 200 && Array.isArray(resRekap.data.data), 'GET /api/gaji?periode=2026-06 mengembalikan daftar rekap');
    const rekapEmp1 = resRekap.data.data.find(r => r.id_karyawan === emp1.id_karyawan);
    assert(rekapEmp1 && rekapEmp1.total_upah === 5000000, 'Rekap penggajian Karyawan 1 bulan Juni tepat Rp 5.000.000');
    assert(Array.isArray(rekapEmp1.rincian_segmen_gaji) && rekapEmp1.rincian_segmen_gaji.length > 0, 'Rekap memuat array rincian_segmen_gaji transparan');

    // 6B: GET /api/pekerjaan
    const resJobs = await request('GET', '/api/pekerjaan');
    assert(resJobs.status === 200 && Array.isArray(resJobs.data.data), 'GET /api/pekerjaan merespons 200 normal');

    // 6C: GET /api/penugasan
    const resAss = await request('GET', '/api/penugasan');
    assert(resAss.status === 200 && Array.isArray(resAss.data.data), 'GET /api/penugasan merespons 200 normal');

    // 6D: GET /api/master-role
    const resRoles = await request('GET', '/api/master-role');
    assert(resRoles.status === 200 && Array.isArray(resRoles.data.data), 'GET /api/master-role merespons 200 normal');

    console.log('\n====================================================');
    console.log('🎉 SEMUA 6 SKENARIO PENGUJIAN FASE 3 BERHASIL (100% PASS)!');
    console.log('====================================================\n');

  } catch (err) {
    console.error('\n❌ PENGUJIAN GAGAL DENGAN ERROR:', err.message);
    throw err;
  } finally {
    // ----------------------------------------------------
    // CLEANUP: Bersihkan seluruh data uji dari database
    // ----------------------------------------------------
    console.log('--- CLEANUP: Membersihkan seluruh data uji dari database ---');
    try {
      if (createdAbsensiIds.length > 0) {
        await db.query(`DELETE FROM absensi WHERE id_absensi IN (${createdAbsensiIds.map(() => '?').join(',')})`, createdAbsensiIds);
        console.log(`  ✓ Menghapus ${createdAbsensiIds.length} sesi absensi uji`);
      }

      if (createdAssignmentIds.length > 0) {
        await db.query(`DELETE FROM penugasan_gaji_riwayat WHERE id_penugasan IN (${createdAssignmentIds.map(() => '?').join(',')})`, createdAssignmentIds);
        await db.query(`DELETE FROM penugasan WHERE id_penugasan IN (${createdAssignmentIds.map(() => '?').join(',')})`, createdAssignmentIds);
        console.log(`  ✓ Menghapus ${createdAssignmentIds.length} penugasan & riwayat uji`);
      }

      if (createdProjectIds.length > 0) {
        await db.query(`DELETE FROM pekerjaan_role_budget WHERE id_pekerjaan IN (${createdProjectIds.map(() => '?').join(',')})`, createdProjectIds);
        await db.query(`DELETE FROM penugasan WHERE id_pekerjaan IN (${createdProjectIds.map(() => '?').join(',')})`, createdProjectIds);
        await db.query(`DELETE FROM pekerjaan WHERE id_pekerjaan IN (${createdProjectIds.map(() => '?').join(',')})`, createdProjectIds);
        console.log(`  ✓ Menghapus ${createdProjectIds.length} proyek uji`);
      }

      if (createdRoleIds.length > 0) {
        await db.query(`DELETE FROM master_role WHERE id_role IN (${createdRoleIds.map(() => '?').join(',')})`, createdRoleIds);
        console.log(`  ✓ Menghapus ${createdRoleIds.length} role uji`);
      }
      console.log('  ✓ Database 100% bersih kembali tanpa sampah pengujian.\n');
    } catch (cleanupErr) {
      console.error('Peringatan saat cleanup:', cleanupErr.message);
    }
  }
}

runTest().then(() => {
  process.exit(0);
}).catch(() => {
  process.exit(1);
});
