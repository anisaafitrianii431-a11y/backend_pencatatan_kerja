const http = require('http');

function testEndpoint(path, headers = { 'X-User-Role': 'admin', 'X-User-Id': '1' }) {
  return new Promise((resolve, reject) => {
    http.get({
      hostname: 'localhost',
      port: 5000,
      path,
      headers
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    }).on('error', reject);
  });
}

async function verifyAll() {
  console.log('--- Memulai Pengujian Regresi & Validasi Endpoint Lama vs Baru ---\n');

  // 1. Health check
  const health = await testEndpoint('/api/health');
  console.log('1. Health check (/api/health): Status', health.status, 'OK');
  if (health.status !== 200) throw new Error('Health check failed');

  // 2. Master Role (Baru)
  const masterRole = await testEndpoint('/api/master-role');
  console.log('2. Master Role (/api/master-role): Status', masterRole.status, 'Total item:', masterRole.data.data?.length);
  if (masterRole.status !== 200 || !masterRole.data.success) throw new Error('Master role API failed');

  // 3. Pekerjaan (Lama)
  const pekerjaan = await testEndpoint('/api/pekerjaan');
  console.log('3. Pekerjaan (/api/pekerjaan): Status', pekerjaan.status, 'Total item:', pekerjaan.data.data?.length);
  if (pekerjaan.status !== 200 || !pekerjaan.data.success) throw new Error('Pekerjaan API regression failed');

  // 4. Penugasan (Lama)
  const penugasan = await testEndpoint('/api/penugasan');
  console.log('4. Penugasan (/api/penugasan): Status', penugasan.status, 'Total item:', penugasan.data.data?.length);
  if (penugasan.status !== 200 || !penugasan.data.success) throw new Error('Penugasan API regression failed');

  // 5. Gaji (Lama)
  const gaji = await testEndpoint('/api/gaji?periode=2026-11');
  console.log('5. Gaji (/api/gaji?periode=2026-11): Status', gaji.status, 'Total rekap:', gaji.data.data?.length);
  if (gaji.status !== 200 || !gaji.data.success) throw new Error('Gaji API regression failed');

  // 6. Karyawan (Lama)
  const karyawan = await testEndpoint('/api/karyawan');
  console.log('6. Karyawan (/api/karyawan): Status', karyawan.status, 'Total item:', karyawan.data.data?.length);
  if (karyawan.status !== 200 || !karyawan.data.success) throw new Error('Karyawan API regression failed');

  console.log('\n✓ SEMUA ENDPOINT LAMA & BARU MERESPONS 200 NORMAL TANPA REGRESI!');
  process.exit(0);
}

verifyAll().catch(err => {
  console.error('Verifikasi gagal:', err);
  process.exit(1);
});
