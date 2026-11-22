/**
 * Automated Verification Script - Fase 2: Backend Engine
 * Menguji 7 skenario engine proyek & payroll serta membersihkan seluruh data uji.
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
  console.log('🚀 MEMULAI PENGUJIAN OTOMATIS FASE 2: BACKEND ENGINE');
  console.log('====================================================\n');

  const createdRoleIds = [];
  const createdProjectIds = [];
  const createdAssignmentIds = [];

  try {
    // ----------------------------------------------------
    // PERSIAPAN: Role Master untuk Pengujian
    // ----------------------------------------------------
    console.log('--- SETUP: Inisialisasi Role Master Uji ---');
    const [resRole1] = await db.query(
      `INSERT INTO master_role (nama_role, hierarchy_level, default_gaji_min_bulanan, default_gaji_max_bulanan, deskripsi, is_active)
       VALUES ('Uji Helper Fase2', 1, 3000000, 4000000, 'Helper level 1', 1)`
    );
    const idRoleHelper = resRole1.insertId;
    createdRoleIds.push(idRoleHelper);

    const [resRole2] = await db.query(
      `INSERT INTO master_role (nama_role, hierarchy_level, default_gaji_min_bulanan, default_gaji_max_bulanan, deskripsi, is_active)
       VALUES ('Uji Staf Fase2', 2, 4500000, 6000000, 'Staf level 2', 1)`
    );
    const idRoleStaf = resRole2.insertId;
    createdRoleIds.push(idRoleStaf);

    console.log(`  ✓ Role uji dibuat: Helper (ID ${idRoleHelper}, Lvl 1), Staf (ID ${idRoleStaf}, Lvl 2)\n`);

    // Ambil sample 3 karyawan aktif untuk penugasan
    const [empRows] = await db.query('SELECT id_karyawan, nama FROM karyawan WHERE status = "aktif" LIMIT 3');
    assert(empRows.length >= 3, 'Terdapat minimal 3 karyawan aktif di database');
    const emp1 = empRows[0];
    const emp2 = empRows[1];
    const emp3 = empRows[2];
    console.log(`  ✓ Karyawan sampel: [${emp1.id_karyawan}] ${emp1.nama}, [${emp2.id_karyawan}] ${emp2.nama}, [${emp3.id_karyawan}] ${emp3.nama}\n`);

    // ----------------------------------------------------
    // SKENARIO 1: Blueprint & Validasi Hierarki
    // ----------------------------------------------------
    console.log('--- SKENARIO 1: Blueprint & Validasi Hierarki ---');

    // 1A: Uji DITOLAK (400) bila batas gaji role atas <= batas gaji role bawah
    const invalidBlueprintPayload = {
      nama_pekerjaan: 'Proyek Uji Invalid Hierarchy',
      hari_kerja_per_bulan: 24,
      jam_kerja_per_hari: 8,
      tanggal_mulai: '2026-06-01',
      target_selesai: '2026-08-31',
      role_budgets: [
        { id_role: idRoleHelper, kuota_slot: 1, gaji_min_bulanan: 3000000, gaji_max_bulanan: 5000000 },
        { id_role: idRoleStaf, kuota_slot: 2, gaji_min_bulanan: 4500000, gaji_max_bulanan: 6000000 } // 5jt max Helper >= 4.5jt min Staf
      ]
    };
    const res1A = await request('POST', '/api/pekerjaan', invalidBlueprintPayload);
    assert(res1A.status === 400, 'Create proyek dengan hierarki gaji tumpang tindih ditolak dengan HTTP 400');
    assert(res1A.data.message && res1A.data.message.includes('tidak boleh lebih besar atau sama dengan batas minimal role di atasnya'), 'Pesan error hierarki spesifik menyebut bentrok role');

    // 1B: Buat Proyek Valid dengan Blueprint
    const validProjectPayload = {
      nama_pekerjaan: 'Proyek Uji Engine Fase 2',
      hari_kerja_per_bulan: 24,
      jam_kerja_per_hari: 8,
      lembur_diizinkan: 1,
      buffer_lembur_persen: 10,
      tanggal_mulai: '2026-06-01',
      target_selesai: '2026-08-31',
      role_budgets: [
        { id_role: idRoleHelper, kuota_slot: 1, gaji_min_bulanan: 3000000, gaji_max_bulanan: 4000000 },
        { id_role: idRoleStaf, kuota_slot: 2, gaji_min_bulanan: 4500000, gaji_max_bulanan: 6000000 }
      ]
    };
    const res1B = await request('POST', '/api/pekerjaan', validProjectPayload);
    assert(res1B.status === 201, 'Create proyek valid berhasil dengan HTTP 201');
    assert(res1B.data.data.kuota_pekerja === 3, 'Total kuota_pekerja tersinkron otomatis ke 3 (1 Helper + 2 Staf)');
    assert(res1B.data.data.kode_pekerjaan && res1B.data.data.kode_pekerjaan.startsWith('PRJ-'), 'Kode proyek PRJ-YYYYMM-XXX ter-generate otomatis');

    const idProject1 = res1B.data.data.id_pekerjaan;
    createdProjectIds.push(idProject1);

    // Ambil detail blueprint
    const resBlueprint = await request('GET', `/api/pekerjaan/${idProject1}/blueprint`);
    assert(resBlueprint.status === 200, 'GET /api/pekerjaan/:id/blueprint berhasil dimuat (200)');
    assert(resBlueprint.data.data.role_budgets.length === 2, 'Daftar role_budgets mengembalikan 2 role terurut');

    const slotHelper = resBlueprint.data.data.role_budgets.find(r => r.id_role === idRoleHelper);
    const slotStaf = resBlueprint.data.data.role_budgets.find(r => r.id_role === idRoleStaf);
    assert(slotStaf.konversi_satuan.per_hari.min === 187500, 'Konversi Staf per_hari min = 4.500.000 / 24 = 187.500');
    assert(slotStaf.konversi_satuan.per_hari.max === 250000, 'Konversi Staf per_hari max = 6.000.000 / 24 = 250.000');
    console.log('');

    // ----------------------------------------------------
    // SKENARIO 2: Validasi Normalisasi Gaji Antar Satuan
    // ----------------------------------------------------
    console.log('--- SKENARIO 2: Validasi Normalisasi Gaji Antar Satuan ---');

    // 2A: Assign per_hari Rp 300.000 (setara Rp 7.200.000/bulan -> di atas max 6.000.000)
    const res2A = await request('POST', '/api/penugasan', {
      id_pekerjaan: idProject1,
      id_karyawan: emp1.id_karyawan,
      id_role_budget: slotStaf.id_role_budget,
      jenis_upah: 'per_hari',
      nominal_upah: 300000
    });
    assert(res2A.status === 400, 'Assign per_hari Rp 300.000 ditolak dengan HTTP 400 karena melebihi plafon Staf');
    assert(res2A.data.message && res2A.data.message.includes('187.500') && res2A.data.message.includes('250.000'), 'Pesan error menyebutkan rentang per hari yang diperbolehkan');

    // 2B: Assign per_jam Rp 20.000 (setara Rp 3.840.000/bulan -> di bawah min 4.500.000)
    const res2B = await request('POST', '/api/penugasan', {
      id_pekerjaan: idProject1,
      id_karyawan: emp1.id_karyawan,
      id_role_budget: slotStaf.id_role_budget,
      jenis_upah: 'per_jam',
      nominal_upah: 20000
    });
    assert(res2B.status === 400, 'Assign per_jam Rp 20.000 ditolak dengan HTTP 400 karena di bawah min Staf');
    console.log('');

    // ----------------------------------------------------
    // SKENARIO 3: Assign Multi-Satuan & Auto-Lock Slot Kuota
    // ----------------------------------------------------
    console.log('--- SKENARIO 3: Assign Multi-Satuan & Auto-Lock Slot Kuota ---');

    // 3A: Berhasil assign Karyawan 1 (per_hari Rp 200.000 -> setara 4.8jt, masuk rentang Staf)
    const res3A = await request('POST', '/api/penugasan', {
      id_pekerjaan: idProject1,
      id_karyawan: emp1.id_karyawan,
      id_role_budget: slotStaf.id_role_budget,
      jenis_upah: 'per_hari',
      nominal_upah: 200000,
      tanggal_penugasan: '2026-06-01',
      tanggal_selesai_tugas: '2026-08-31'
    });
    assert(res3A.status === 201, 'Karyawan 1 berhasil di-assign ke slot Staf dengan per_hari Rp 200.000 (HTTP 201)');
    const idPenugasan1 = res3A.data.data.id_penugasan;
    createdAssignmentIds.push(idPenugasan1);

    // 3B: Berhasil assign Karyawan 2 (per_jam Rp 26.000 -> setara 4.992jt, masuk rentang Staf)
    const res3B = await request('POST', '/api/penugasan', {
      id_pekerjaan: idProject1,
      id_karyawan: emp2.id_karyawan,
      id_role_budget: slotStaf.id_role_budget,
      jenis_upah: 'per_jam',
      nominal_upah: 26000,
      tanggal_penugasan: '2026-06-01',
      tanggal_selesai_tugas: '2026-08-31'
    });
    assert(res3B.status === 201, 'Karyawan 2 berhasil di-assign ke slot Staf dengan per_jam Rp 26.000 (HTTP 201)');
    const idPenugasan2 = res3B.data.data.id_penugasan;
    createdAssignmentIds.push(idPenugasan2);

    // 3C: Kuota Staf penuh (2/2) -> Karyawan 3 DITOLAK (400)
    const res3C = await request('POST', '/api/penugasan', {
      id_pekerjaan: idProject1,
      id_karyawan: emp3.id_karyawan,
      id_role_budget: slotStaf.id_role_budget,
      jenis_upah: 'per_hari',
      nominal_upah: 200000
    });
    assert(res3C.status === 400, 'Assign karyawan ke slot Staf yang sudah penuh (2/2) ditolak dengan HTTP 400');
    assert(res3C.data.message && res3C.data.message.includes('sudah penuh'), 'Pesan error mengonfirmasi kuota slot sudah penuh');

    // 3D: Assign Karyawan 3 ke slot Helper (kuota 1/1) dengan per_tahun Rp 42.000.000 (setara 3.5jt/bulan)
    const res3D = await request('POST', '/api/penugasan', {
      id_pekerjaan: idProject1,
      id_karyawan: emp3.id_karyawan,
      id_role_budget: slotHelper.id_role_budget,
      jenis_upah: 'per_tahun',
      nominal_upah: 42000000,
      tanggal_penugasan: '2026-06-01',
      tanggal_selesai_tugas: '2026-08-31'
    });
    assert(res3D.status === 201, 'Karyawan 3 berhasil di-assign ke slot Helper dengan per_tahun Rp 42.000.000 (HTTP 201)');
    assert(res3D.data.data.normalized_monthly === 3500000, 'Normalisasi bulanan tepat 42jt / 12 = 3.500.000');
    const idPenugasan3 = res3D.data.data.id_penugasan;
    createdAssignmentIds.push(idPenugasan3);
    console.log('');

    // ----------------------------------------------------
    // SKENARIO 4: Cek Bentrok Jadwal (Overlap Checker)
    // ----------------------------------------------------
    console.log('--- SKENARIO 4: Cek Bentrok Jadwal (Overlap Checker) ---');

    // Buat Proyek 2 dengan tanggal bentrok (1 Juli - 31 Juli 2026)
    const resProject2 = await request('POST', '/api/pekerjaan', {
      nama_pekerjaan: 'Proyek Uji Bentrok Fase 2',
      tanggal_mulai: '2026-07-01',
      target_selesai: '2026-07-31',
      status: 'berjalan'
    });
    assert(resProject2.status === 201, 'Proyek 2 uji bentrok berhasil dibuat');
    const idProject2 = resProject2.data.data.id_pekerjaan;
    createdProjectIds.push(idProject2);

    // 4A: Coba assign Karyawan 1 ke Proyek 2 tanpa izinkan_bentrok -> DITOLAK (409 Conflict)
    const res4A = await request('POST', '/api/penugasan', {
      id_pekerjaan: idProject2,
      id_karyawan: emp1.id_karyawan,
      tanggal_penugasan: '2026-07-01',
      tanggal_selesai_tugas: '2026-07-31',
      izinkan_bentrok: false
    });
    assert(res4A.status === 409, 'Assign karyawan yang memiliki penugasan bentrok ditolak dengan HTTP 409 Conflict');
    assert(Array.isArray(res4A.data.konflik) && res4A.data.konflik.length > 0, 'Respons 409 mengembalikan daftar proyek yang bentrok');

    // 4B: Endpoint cek-ketersediaan
    const res4B = await request('GET', `/api/penugasan/cek-ketersediaan?id_karyawan=${emp1.id_karyawan}&tanggal_mulai=2026-07-01&tanggal_selesai=2026-07-31`);
    assert(res4B.status === 200, 'GET /api/penugasan/cek-ketersediaan berhasil dimuat (200)');
    assert(res4B.data.available === false, 'Status ketersediaan karyawan 1 bernilai false (bentrok)');

    // 4C: Endpoint kandidat-karyawan pada Proyek 2
    const res4C = await request('GET', `/api/pekerjaan/${idProject2}/kandidat-karyawan`);
    assert(res4C.status === 200, 'GET /api/pekerjaan/:id/kandidat-karyawan berhasil dimuat (200)');
    const cand1 = res4C.data.data.find(c => c.id_karyawan === emp1.id_karyawan);
    assert(cand1 && cand1.available === false, 'Karyawan 1 berstatus available: false pada daftar kandidat');
    console.log('');

    // ----------------------------------------------------
    // SKENARIO 5: Versioning Riwayat Gaji (Anti-Overwrite)
    // ----------------------------------------------------
    console.log('--- SKENARIO 5: Versioning Riwayat Gaji (Anti-Overwrite) ---');

    // 5A: DITOLAK (400) jika effective_from baru <= effective_from aktif (2026-06-01)
    const res5A = await request('POST', `/api/penugasan/${idPenugasan1}/gaji-riwayat`, {
      jenis_upah: 'per_bulan',
      nominal_upah: 5000000,
      effective_from: '2026-06-01' // Tanggal sama dengan skema aktif
    });
    assert(res5A.status === 400, 'Ganti skema dengan tanggal berlaku mundur atau sama ditolak HTTP 400');

    // 5B: DITOLAK (400) jika nominal baru melanggar batas role Staf (min 4.5jt, max 6jt)
    const res5B = await request('POST', `/api/penugasan/${idPenugasan1}/gaji-riwayat`, {
      jenis_upah: 'per_bulan',
      nominal_upah: 7000000, // Di atas 6jt
      effective_from: '2026-07-01'
    });
    assert(res5B.status === 400, 'Ganti skema dengan nominal di luar batas role ditolak HTTP 400');

    // 5C: Berhasil ganti skema ke per_bulan Rp 5.000.000 efektif 2026-07-01
    const res5C = await request('POST', `/api/penugasan/${idPenugasan1}/gaji-riwayat`, {
      jenis_upah: 'per_bulan',
      nominal_upah: 5000000,
      effective_from: '2026-07-01',
      catatan: 'Kenaikan upah bulanan'
    });
    assert(res5C.status === 201, 'Ganti skema gaji berhasil disimpan (HTTP 201)');

    // 5D: Verifikasi riwayat: record lama ter-close effective_to = 2026-06-30, record baru effective_to = NULL
    const res5D = await request('GET', `/api/penugasan/${idPenugasan1}/gaji-riwayat`);
    assert(res5D.status === 200, 'GET /api/penugasan/:id/gaji-riwayat berhasil dimuat (200)');
    assert(res5D.data.data.riwayat.length === 2, 'Riwayat gaji kini memiliki 2 versi');

    const activeRec = res5D.data.data.riwayat.find(r => r.is_active);
    const oldRec = res5D.data.data.riwayat.find(r => !r.is_active);
    assert(activeRec && String(activeRec.effective_from).slice(0, 10) === '2026-07-01', 'Record aktif baru dimulai 2026-07-01');
    assert(oldRec && String(oldRec.effective_to).slice(0, 10) === '2026-06-30', 'Record lama otomatis ditutup pada 2026-06-30 (H-1)');
    console.log('');

    // ----------------------------------------------------
    // SKENARIO 6: Kalkulator Budget Summary
    // ----------------------------------------------------
    console.log('--- SKENARIO 6: Kalkulator Budget Summary ---');

    const resBudget = await request('GET', `/api/pekerjaan/${idProject1}/budget-summary`);
    assert(resBudget.status === 200, 'GET /api/pekerjaan/:id/budget-summary berhasil dimuat (200)');

    const summary = resBudget.data.data;
    console.log('  Parameter Durasi:', summary.parameter_durasi);
    console.log('  Lapis 1 Rencana Total Min:', summary.lapis_1_rencana.total_min);
    console.log('  Lapis 1 Rencana Total Max:', summary.lapis_1_rencana.total_max);
    console.log('  Lapis 1 Buffer Lembur (10%):', summary.lapis_1_rencana.buffer_lembur);
    console.log('  Lapis 1 Grand Total Max:', summary.lapis_1_rencana.grand_total.grand_total_max);
    console.log('  Lapis 2 Total Komitmen:', summary.lapis_2_komitmen.total_komitmen);
    console.log('  Status Budget:', summary.status_budget, `(${summary.persentase_pemakaian}%)`);

    assert(summary.parameter_durasi.hari_kerja_per_bulan === 24, 'Hari kerja per bulan = 24');
    assert(summary.lapis_1_rencana.total_min > 0, 'Total min blueprint > 0');
    assert(summary.lapis_1_rencana.total_max > summary.lapis_1_rencana.total_min, 'Total max > Total min');
    assert(summary.lapis_1_rencana.buffer_lembur.buffer_min > 0, 'Buffer lembur terhitung positif (karena lembur_diizinkan = 1)');
    assert(summary.lapis_2_komitmen.total_komitmen > 0, 'Total komitmen karyawan terhitung positif');
    assert(['UNDER_MIN', 'IN_BUDGET', 'OVER_BUDGET'].includes(summary.status_budget), 'Status budget bernilai valid');
    console.log('');

    // ----------------------------------------------------
    // SKENARIO 7: Regresi Endpoint Lama
    // ----------------------------------------------------
    console.log('--- SKENARIO 7: Regresi Endpoint Lama ---');

    // 7A: Create proyek payload lama (tanpa role_budgets)
    const legacyProjectPayload = {
      nama_pekerjaan: 'Proyek Regresi Legacy Payload',
      kuota_pekerja: 5,
      lokasi: 'Kantor Pusat'
    };
    const res7A = await request('POST', '/api/pekerjaan', legacyProjectPayload);
    assert(res7A.status === 201, 'Create proyek payload legacy tetap merespons 201 normal');
    createdProjectIds.push(res7A.data.data.id_pekerjaan);

    // 7B: Read all jobs
    const res7B = await request('GET', '/api/pekerjaan');
    assert(res7B.status === 200 && Array.isArray(res7B.data.data), 'GET /api/pekerjaan tetap merespons array pekerjaan (200)');

    // 7C: Read penugasan
    const res7C = await request('GET', '/api/penugasan');
    assert(res7C.status === 200 && Array.isArray(res7C.data.data), 'GET /api/penugasan tetap merespons array penugasan (200)');

    // 7D: Read gaji
    const res7D = await request('GET', '/api/gaji');
    assert(res7D.status === 200, 'GET /api/gaji tetap merespons normal (200)');

    // 7E: Read master-role
    const res7E = await request('GET', '/api/master-role');
    assert(res7E.status === 200 && Array.isArray(res7E.data.data), 'GET /api/master-role tetap merespons normal (200)');

    console.log('\n====================================================');
    console.log('🎉 SEMUA 7 SKENARIO PENGUJIAN FASE 2 BERHASIL (100% PASS)!');
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
