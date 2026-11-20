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

// Helper periode (default bulan berjalan "YYYY-MM")
function getPeriode(req) {
  return req.query.periode || req.body?.periode || new Date().toISOString().slice(0, 7);
}

// Helper kalkulasi upah hybrid (Mendukung tarif per-proyek maupun tarif default karyawan)
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
    const hasJobRate = jobNominal > 0;
    const effectiveJenis = hasJobRate && a.job_jenis_upah ? a.job_jenis_upah : defaultJenis;
    const effectiveTarif = hasJobRate ? jobNominal : defaultTarif;

    let upahSesi = 0;
    if (effectiveJenis === 'per_jam') {
      upahSesi = durasi * effectiveTarif;
      totalUpah += upahSesi;
    } else if (effectiveJenis === 'per_hari') {
      const dayKey = `${dateStr}_${hasJobRate ? a.id_pekerjaan : 'default'}`;
      if (!dayJobMap.has(dayKey)) {
        dayJobMap.add(dayKey);
        upahSesi = effectiveTarif;
        totalUpah += upahSesi;
      }
    }

    sessionBreakdown.push({
      ...a,
      is_job_rate: hasJobRate,
      effective_jenis: effectiveJenis,
      effective_tarif: effectiveTarif,
      upah_sesi: Math.round(upahSesi)
    });
  }

  // Jika jenis upah karyawan adalah bulanan dan tidak ada upah berbasis proyek
  if (defaultJenis === 'per_bulan' && totalUpah === 0 && uniqueDays.size > 0) {
    totalUpah = defaultTarif;
  }

  return {
    totalJam: Number(totalJam.toFixed(2)),
    totalHari: uniqueDays.size,
    totalUpah: Math.round(totalUpah),
    sessionBreakdown
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

    // Ambil seluruh karyawan
    const [karyawanList] = await db.query(`
      SELECT id_karyawan, kode_karyawan, nama, jabatan, jenis_upah, nominal_upah, tarif_per_jam, status
      FROM karyawan
      ORDER BY id_karyawan ASC
    `);

    // Ambil data penetapan gaji yang sudah tersimpan di database untuk periode ini
    const [savedGajiList] = await db.query('SELECT * FROM gaji WHERE periode = ?', [periode]);
    const savedMap = new Map(savedGajiList.map(g => [Number(g.id_karyawan), g]));

    const result = [];

    for (const k of karyawanList) {
      const saved = savedMap.get(Number(k.id_karyawan));

      if (saved) {
        result.push({
          id_gaji: saved.id_gaji,
          id_karyawan: k.id_karyawan,
          kode_karyawan: k.kode_karyawan,
          nama: k.nama,
          jabatan: k.jabatan,
          periode: saved.periode,
          jenis_upah: saved.jenis_upah,
          total_jam: Number(saved.total_jam) || 0,
          total_hari: Number(saved.total_hari) || 0,
          tarif: Number(saved.tarif) || 0,
          total_upah: Number(saved.total_upah) || 0,
          total_ganti: Number(saved.total_ganti) || 0,
          bonus: Number(saved.bonus) || 0,
          potongan: Number(saved.potongan) || 0,
          catatan_penyesuaian: saved.catatan_penyesuaian || '',
          gaji_bersih: Number(saved.gaji_bersih) || 0,
          total_dibayar: Number(saved.total_dibayar) || 0,
          sisa_pembayaran: Number(saved.sisa_pembayaran) || 0,
          status_bayar: saved.status_bayar,
          status_penetapan: saved.status_penetapan,
          sudah_ditetapkan: saved.status_penetapan === 'ditetapkan'
        });
      } else {
        // Kalkulasi Live dari Absensi (Join pekerjaan untuk kalkulasi upah hybrid)
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

        const calc = calculateEmployeeWages(k, absRows);
        const totalJam = calc.totalJam;
        const totalHari = calc.totalHari;
        const totalUpah = calc.totalUpah;

        const jenisUpah = k.jenis_upah || 'per_jam';
        const tarif = Number(k.nominal_upah) || Number(k.tarif_per_jam) || 0;

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
          jabatan: k.jabatan,
          periode,
          jenis_upah: jenisUpah,
          total_jam: totalJam,
          total_hari: totalHari,
          tarif,
          total_upah: totalUpah,
          total_ganti: totalGanti,
          bonus: 0,
          potongan: 0,
          catatan_penyesuaian: '',
          gaji_bersih: gajiBersih,
          total_dibayar: 0,
          sisa_pembayaran: gajiBersih,
          status_bayar: 'belum',
          status_penetapan: 'draft',
          sudah_ditetapkan: false
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

    // Ambil sesi absensi yang disetujui pada periode ini
    const [absensiList] = await db.query(`
      SELECT a.id_absensi, a.tanggal, a.jam_masuk, a.jam_pulang, a.id_pekerjaan,
             p.nama_pekerjaan, p.jenis_upah AS job_jenis_upah, p.nominal_upah AS job_nominal_upah,
             ${sqlDurasi} AS durasi_jam
      FROM absensi a
      LEFT JOIN pekerjaan p ON a.id_pekerjaan = p.id_pekerjaan
      WHERE a.id_karyawan = ?
        AND a.status_verifikasi = 'disetujui'
        AND a.jam_pulang IS NOT NULL
        AND a.tanggal LIKE ?
      ORDER BY a.tanggal DESC, a.jam_masuk DESC
    `, [id_karyawan, `${periode}%`]);

    // Ambil klaim reimburse uang pribadi
    const [reimburseList] = await db.query(`
      SELECT id_pengeluaran, tanggal, nominal, keterangan, status_reimbursement, status_ganti, foto_kwitansi
      FROM pengeluaran
      WHERE id_karyawan = ?
        AND jenis_dana = 'pribadi'
        AND status_verifikasi = 'disetujui'
        AND tanggal LIKE ?
      ORDER BY tanggal DESC
    `, [id_karyawan, `${periode}%`]);

    const calc = calculateEmployeeWages(karyawan, absensiList);
    const totalJam = calc.totalJam;
    const totalHari = calc.totalHari;
    const jenisUpah = gajiLocked?.jenis_upah || karyawan.jenis_upah || 'per_jam';
    const tarif = Number(gajiLocked?.tarif || karyawan.nominal_upah || karyawan.tarif_per_jam || 0);

    const totalUpah = gajiLocked ? (Number(gajiLocked.total_upah) || 0) : calc.totalUpah;

    const totalReimburse = reimburseList.reduce((acc, curr) => acc + Number(curr.nominal || 0), 0);
    const bonus = Number(gajiLocked?.bonus || 0);
    const potongan = Number(gajiLocked?.potongan || 0);
    const gajiBersih = (Number(gajiLocked?.total_upah) || totalUpah) + totalReimburse + bonus - potongan;

    return res.json({
      success: true,
      message: 'Detail kalkulasi gaji berhasil dimuat',
      data: {
        id_gaji: gajiLocked?.id_gaji || null,
        id_karyawan: Number(id_karyawan),
        nama: karyawan.nama,
        kode_karyawan: karyawan.kode_karyawan,
        jabatan: karyawan.jabatan,
        periode,
        jenis_upah: jenisUpah,
        tarif,
        total_jam: Number(totalJam.toFixed(2)),
        total_hari: totalHari,
        total_upah: totalUpah,
        total_ganti: totalReimburse,
        bonus,
        potongan,
        catatan_penyesuaian: gajiLocked?.catatan_penyesuaian || '',
        gaji_bersih: gajiBersih,
        total_dibayar: Number(gajiLocked?.total_dibayar || 0),
        sisa_pembayaran: Math.max(0, gajiBersih - Number(gajiLocked?.total_dibayar || 0)),
        status_bayar: gajiLocked?.status_bayar || 'belum',
        status_penetapan: gajiLocked?.status_penetapan || 'draft',
        absensi_list: calc.sessionBreakdown,
        reimburse_list: reimburseList
      }
    });
  } catch (error) {
    console.error('Error getDetailGaji:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

// 4. Tetapkan / Kunci Gaji Karyawan (Admin)
async function tetapkanGaji(req, res) {
  try {
    const {
      id_karyawan,
      periode,
      jenis_upah = 'per_jam',
      total_jam = 0,
      total_hari = 0,
      tarif = 0,
      total_upah = 0,
      total_ganti = 0,
      bonus = 0,
      potongan = 0,
      catatan_penyesuaian = ''
    } = req.body;

    if (!id_karyawan || !periode) {
      return res.status(400).json({ success: false, message: 'ID Karyawan dan Periode wajib diisi' });
    }

    const gajiBersih = (Number(total_upah) || 0) + (Number(total_ganti) || 0) + (Number(bonus) || 0) - (Number(potongan) || 0);

    const [existing] = await db.query('SELECT id_gaji, total_dibayar FROM gaji WHERE id_karyawan = ? AND periode = ?', [id_karyawan, periode]);

    if (existing.length > 0) {
      const dibayar = Number(existing[0].total_dibayar || 0);
      const sisa = Math.max(0, gajiBersih - dibayar);
      const statusBayar = sisa <= 0 ? 'sudah' : (dibayar > 0 ? 'sebagian' : 'belum');

      await db.query(`
        UPDATE gaji SET
          jenis_upah = ?, total_jam = ?, total_hari = ?, tarif = ?, total_upah = ?, total_ganti = ?,
          bonus = ?, potongan = ?, catatan_penyesuaian = ?, gaji_bersih = ?, sisa_pembayaran = ?,
          status_bayar = ?, status_penetapan = 'ditetapkan', tanggal_ditetapkan = NOW()
        WHERE id_gaji = ?
      `, [jenis_upah, total_jam, total_hari, tarif, total_upah, total_ganti, bonus, potongan, catatan_penyesuaian, gajiBersih, sisa, statusBayar, existing[0].id_gaji]);
    } else {
      await db.query(`
        INSERT INTO gaji (id_karyawan, periode, jenis_upah, total_jam, total_hari, tarif, total_upah, total_ganti, bonus, potongan, catatan_penyesuaian, gaji_bersih, total_dibayar, sisa_pembayaran, status_bayar, status_penetapan, tanggal_ditetapkan)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'belum', 'ditetapkan', NOW())
      `, [id_karyawan, periode, jenis_upah, total_jam, total_hari, tarif, total_upah, total_ganti, bonus, potongan, catatan_penyesuaian, gajiBersih, gajiBersih]);
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

// 9. Slip Gaji Lengkap (Siap Cetak / Tampil)
async function getSlipGaji(req, res) {
  try {
    const id_gaji = req.params.id || req.query.id_gaji;
    const [gRows] = await db.query(`
      SELECT g.*, k.nama, k.kode_karyawan, k.jabatan, k.email
      FROM gaji g
      JOIN karyawan k ON g.id_karyawan = k.id_karyawan
      WHERE g.id_gaji = ?
    `, [id_gaji]);

    if (gRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data slip gaji tidak ditemukan' });
    }

    const slip = gRows[0];
    const [absensi] = await db.query(`
      SELECT a.id_absensi, a.tanggal, a.jam_masuk, a.jam_pulang, p.nama_pekerjaan, ${sqlDurasi} AS durasi_jam
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

    return res.json({
      success: true,
      message: 'Slip gaji berhasil dimuat',
      data: {
        ...slip,
        absensi_list: absensi,
        reimburse_list: reimburse
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

// 10. Riwayat Slip Gaji Karyawan (Arsip Riwayat Penggajian Pribadi)
async function getRiwayatGaji(req, res) {
  try {
    const id_karyawan = req.user?.id_karyawan || req.query.id_karyawan;
    if (!id_karyawan) {
      return res.status(400).json({ success: false, message: 'ID Karyawan tidak valid' });
    }

    const [rows] = await db.query(`
      SELECT g.*, k.nama, k.kode_karyawan, k.jabatan
      FROM gaji g
      JOIN karyawan k ON g.id_karyawan = k.id_karyawan
      WHERE g.id_karyawan = ?
      ORDER BY g.periode DESC
    `, [id_karyawan]);

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
  getRiwayatGaji
};
