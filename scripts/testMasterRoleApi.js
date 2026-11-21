const http = require('http');

function apiRequest(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const dataString = body ? JSON.stringify(body) : '';
    const reqHeaders = {
      'Content-Type': 'application/json',
      'X-User-Role': 'admin',
      'X-User-Id': '1',
      ...headers
    };
    if (dataString) {
      reqHeaders['Content-Length'] = Buffer.byteLength(dataString);
    }

    const req = http.request(
      {
        hostname: 'localhost',
        port: 5000,
        path,
        method,
        headers: reqHeaders
      },
      (res) => {
        let responseBody = '';
        res.on('data', chunk => responseBody += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(responseBody);
            resolve({ status: res.statusCode, body: parsed });
          } catch (e) {
            resolve({ status: res.statusCode, raw: responseBody });
          }
        });
      }
    );

    req.on('error', reject);
    if (dataString) {
      req.write(dataString);
    }
    req.end();
  });
}

async function runTests() {
  console.log('=== MEMULAI TEST VALIDASI API MASTER ROLE ===\n');
  let role1Id = null;
  let role2Id = null;

  try {
    // Bersihkan dulu jika ada role sisa
    const existingList = await apiRequest('GET', '/api/master-role');
    if (existingList.body?.data) {
      for (const r of existingList.body.data) {
        if (r.nama_role.includes('Uji')) {
          await apiRequest('DELETE', `/api/master-role/${r.id_role}`);
        }
      }
    }

    // Skenario 1: Berhasil tambah role level 1 (Helper, 3jt-4jt) dan level 2 (Staf, 4.5jt-6jt)
    console.log('1. Pengujian Skenario 1: Tambah Role Level 1 & Level 2 yang Valid...');
    const res1 = await apiRequest('POST', '/api/master-role', {
      nama_role: 'Helper Uji',
      hierarchy_level: 1,
      default_gaji_min_bulanan: 3000000,
      default_gaji_max_bulanan: 4000000,
      deskripsi: 'Role uji level 1'
    });
    console.log('Status Tambah Level 1:', res1.status, res1.body.message);
    if (res1.status !== 201) throw new Error('Gagal menambah level 1');
    role1Id = res1.body.data.id_role;

    const res2 = await apiRequest('POST', '/api/master-role', {
      nama_role: 'Staf Uji',
      hierarchy_level: 2,
      default_gaji_min_bulanan: 4500000,
      default_gaji_max_bulanan: 6000000,
      deskripsi: 'Role uji level 2'
    });
    console.log('Status Tambah Level 2:', res2.status, res2.body.message);
    if (res2.status !== 201) throw new Error('Gagal menambah level 2');
    role2Id = res2.body.data.id_role;
    console.log('✓ Skenario 1 LULUS (Level 1 dan Level 2 berhasil dibuat).\n');

    // Skenario 2: Ditolak (400) jika menambah level 2 dengan gaji min <= 4jt (bentrok max level 1)
    console.log('2. Pengujian Skenario 2: Ditolak jika Level 2 Gaji Min <= Max Level 1 (4.000.000)...');
    const resConflictLow = await apiRequest('POST', '/api/master-role', {
      nama_role: 'Supervisor Uji Bentrok Bawah',
      hierarchy_level: 2,
      default_gaji_min_bulanan: 3800000, // bentrok karena <= 4jt (max level 1)
      default_gaji_max_bulanan: 5000000
    });
    console.log('Status Respon:', resConflictLow.status);
    console.log('Pesan Respon:', resConflictLow.body.message);
    if (resConflictLow.status === 400 && resConflictLow.body.message.includes('harus lebih besar')) {
      console.log('✓ Skenario 2 LULUS (Ditolak 400 dengan pesan hierarki yang benar).\n');
    } else {
      throw new Error('Skenario 2 GAGAL: Seharusnya ditolak 400.');
    }

    // Skenario 3: Ditolak (400) jika menambah level 1 dengan gaji max >= 4.5jt (bentrok min level 2)
    console.log('3. Pengujian Skenario 3: Ditolak jika Level 1 Gaji Max >= Min Level 2 (4.500.000)...');
    const resConflictHigh = await apiRequest('POST', '/api/master-role', {
      nama_role: 'Magang Uji Bentrok Atas',
      hierarchy_level: 1,
      default_gaji_min_bulanan: 4100000, // tidak bentrok dengan level 1 (4.000.000)
      default_gaji_max_bulanan: 4800000  // bentrok dengan level 2 min (4.500.000)
    });
    console.log('Status Respon:', resConflictHigh.status);
    console.log('Pesan Respon:', resConflictHigh.body.message);
    if (resConflictHigh.status === 400 && resConflictHigh.body.message.includes('harus lebih kecil')) {
      console.log('✓ Skenario 3 LULUS (Ditolak 400 dengan pesan hierarki level atas yang benar).\n');
    } else {
      throw new Error('Skenario 3 GAGAL: Seharusnya ditolak 400.');
    }

    // Skenario 4: Berhasil edit dan hapus role
    console.log('4. Pengujian Skenario 4: Edit dan Hapus Role...');
    const resEdit = await apiRequest('PUT', `/api/master-role/${role1Id}`, {
      nama_role: 'Helper Senior Uji',
      hierarchy_level: 1,
      default_gaji_min_bulanan: 3200000,
      default_gaji_max_bulanan: 4200000,
      deskripsi: 'Deskripsi terupdate'
    });
    console.log('Status Edit:', resEdit.status, resEdit.body.message);
    if (resEdit.status !== 200 || resEdit.body.data.nama_role !== 'Helper Senior Uji') {
      throw new Error('Gagal update role');
    }

    const resDel1 = await apiRequest('DELETE', `/api/master-role/${role1Id}`);
    console.log('Status Hapus Role 1:', resDel1.status, resDel1.body.message);
    const resDel2 = await apiRequest('DELETE', `/api/master-role/${role2Id}`);
    console.log('Status Hapus Role 2:', resDel2.status, resDel2.body.message);
    console.log('✓ Skenario 4 LULUS (Edit & Hapus permanen berhasil).\n');

    console.log('=== SEMUA 4 SKENARIO PENGUJIAN API BERHASIL 100% ===');
    process.exit(0);
  } catch (err) {
    console.error('Error saat pengujian:', err);
    if (role1Id) await apiRequest('DELETE', `/api/master-role/${role1Id}`).catch(() => {});
    if (role2Id) await apiRequest('DELETE', `/api/master-role/${role2Id}`).catch(() => {});
    process.exit(1);
  }
}

runTests();
