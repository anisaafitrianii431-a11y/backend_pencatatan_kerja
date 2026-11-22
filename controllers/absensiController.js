const db = require('../config/database');
const { saveBase64Image } = require('../utils/uploadHelper');
const { isAdminRole } = require('../utils/roles');

function distanceMeters(lat1, lon1, lat2, lon2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function validCoordinate(lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
    Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
    ? { latitude, longitude }
    : null;
}

async function getAssignedRunningJob(idPekerjaan, idKaryawan) {
  const [rows] = await db.query(`
    SELECT p.id_pekerjaan, p.status, p.metode_lokasi, p.latitude, p.longitude,
           p.radius_meter, p.lokasi
    FROM pekerjaan p
    JOIN penugasan pn ON pn.id_pekerjaan = p.id_pekerjaan
    WHERE p.id_pekerjaan = ? AND pn.id_karyawan = ?
      AND (pn.status_penugasan IS NULL OR pn.status_penugasan = 'aktif')
    LIMIT 1
  `, [idPekerjaan, idKaryawan]);
  return rows[0] || null;
}

// Rumus SQL Durasi Jam Kerja (Mendukung Shift Malam yang lewat tengah malam)
const sqlDurasi = `
  CASE 
    WHEN a.jam_pulang IS NOT NULL AND a.jam_pulang >= a.jam_masuk 
      THEN ROUND(TIME_TO_SEC(TIMEDIFF(a.jam_pulang, a.jam_masuk)) / 3600, 2)
    WHEN a.jam_pulang IS NOT NULL AND a.jam_pulang < a.jam_masuk 
      THEN ROUND((TIME_TO_SEC(TIMEDIFF(a.jam_pulang, a.jam_masuk)) + 86400) / 3600, 2)
    ELSE 0 
  END
`;

function getJakartaNow() {
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);

  const timeStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(now);

  return { tanggal: dateStr, jam: timeStr };
}

// 1. Ambil Semua Data Absensi (Dengan filter & relasi nama karyawan serta proyek)
async function getAllAbsensi(req, res) {
  try {
    const { id_karyawan, id_pekerjaan, tanggal, bulan, status_verifikasi } = req.query;

    let query = `
      SELECT 
        a.*,
        k.nama AS nama_karyawan,
        k.kode_karyawan,
        k.jabatan,
        k.nominal_upah,
        k.tarif_per_jam,
        k.jenis_upah,
        p.nama_pekerjaan,
        p.lokasi AS lokasi_pekerjaan,
        p.titik_lokasi AS titik_proyek,
        p.radius_meter,
        ${sqlDurasi} AS total_jam_kerja
      FROM absensi a
      LEFT JOIN karyawan k ON a.id_karyawan = k.id_karyawan
      LEFT JOIN pekerjaan p ON a.id_pekerjaan = p.id_pekerjaan
      WHERE 1=1
    `;

    const params = [];

    // Filter berdasarkan karyawan (jika login sebagai karyawan dan bukan admin, batasi otomatis)
    const targetKaryawan = id_karyawan || (req.user?.peran === 'karyawan' ? req.user.id_karyawan : null);
    if (targetKaryawan) {
      query += ` AND a.id_karyawan = ? `;
      params.push(targetKaryawan);
    }

    if (id_pekerjaan) {
      query += ` AND a.id_pekerjaan = ? `;
      params.push(id_pekerjaan);
    }
    if (tanggal) {
      query += ` AND a.tanggal = ? `;
      params.push(tanggal);
    }
    if (bulan) {
      query += ` AND a.tanggal LIKE ? `;
      params.push(`${bulan}%`);
    }
    if (status_verifikasi) {
      query += ` AND a.status_verifikasi = ? `;
      params.push(status_verifikasi);
    }

    query += ` ORDER BY a.tanggal DESC, a.jam_masuk DESC, a.id_absensi DESC `;

    const [rows] = await db.query(query, params);

    const enrichedRows = rows.map(a => {
      const titikMasuk = a.titik_lokasi || (a.masuk_latitude && a.masuk_longitude ? `${a.masuk_latitude}, ${a.masuk_longitude}` : '');
      const titikPulang = a.titik_pulang || (a.pulang_latitude && a.pulang_longitude ? `${a.pulang_latitude}, ${a.pulang_longitude}` : '');
      const fotoMasuk = a.foto_masuk || a.foto_lokasi || '';
      const fotoPulang = a.foto_pulang || '';
      const jarakMasuk = a.jarak_masuk !== null ? Number(a.jarak_masuk) : (a.jarak_meter !== null ? Number(a.jarak_meter) : null);
      const jarakPulang = a.jarak_pulang !== null ? Number(a.jarak_pulang) : null;
      const radius = a.radius_meter ? Number(a.radius_meter) : 100;
      
      const sesuaiTitikMasuk = jarakMasuk !== null ? (jarakMasuk <= radius) : null;
      const sesuaiTitikPulang = jarakPulang !== null ? (jarakPulang <= radius) : null;

      // Hitung durasi jam dan menit
      const totalJam = Number(a.total_jam_kerja || 0);
      const totalMenit = Math.round(totalJam * 60);
      const j = Math.floor(totalMenit / 60);
      const m = totalMenit % 60;
      const durasiFormat = totalMenit > 0 ? `${j}j ${m}m` : (a.jam_pulang ? '0j 0m' : 'Sedang Berjalan');

      return {
        ...a,
        foto_masuk: fotoMasuk,
        foto_lokasi: fotoMasuk,
        foto_pulang: fotoPulang,
        titik_lokasi: titikMasuk,
        titik_masuk: titikMasuk,
        titik_pulang: titikPulang,
        jarak_masuk: jarakMasuk,
        jarak_pulang: jarakPulang,
        jarak_meter: jarakMasuk,
        radius_meter: radius,
        sesuai_titik_masuk: sesuaiTitikMasuk,
        sesuai_titik_pulang: sesuaiTitikPulang,
        durasi_jam: totalJam,
        durasi_format: durasiFormat,
        durasi_menit: totalMenit
      };
    });

    return res.json({
      success: true,
      message: 'Data absensi berhasil dimuat',
      data: enrichedRows
    });
  } catch (error) {
    console.error('Error getAllAbsensi:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal mengambil data absensi',
      error: error.message
    });
  }
}

async function getAbsensiById(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'ID absensi tidak valid.' });
    }
    const [rows] = await db.query(`
      SELECT a.*, k.nama AS nama_karyawan, p.nama_pekerjaan
      FROM absensi a
      LEFT JOIN karyawan k ON k.id_karyawan = a.id_karyawan
      LEFT JOIN pekerjaan p ON p.id_pekerjaan = a.id_pekerjaan
      WHERE a.id_absensi = ? LIMIT 1
    `, [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Data absensi tidak ditemukan.' });
    if (!isAdminRole(req.user?.peran) && Number(rows[0].id_karyawan) !== Number(req.user?.id_karyawan)) {
      return res.status(403).json({ success: false, message: 'Akses absensi ditolak.' });
    }
    return res.json({ success: true, data: rows[0] });
  } catch (error) {
    console.error('Error getAbsensiById:', error);
    return res.status(500).json({ success: false, message: 'Gagal memuat absensi.' });
  }
}

// 2. Karyawan Melakukan Absen Masuk
async function absenMasuk(req, res) {
  try {
    const {
      id_pekerjaan,
      id_karyawan,
      foto_masuk,
      foto_lokasi,
      masuk_latitude,
      masuk_longitude,
      masuk_alamat,
      titik_lokasi,
      jarak_masuk,
      jarak_meter,
      catatan
    } = req.body;

    const workerId = Number(req.user?.id_karyawan);

    if (!id_pekerjaan || !workerId) {
      return res.status(400).json({
        success: false,
        message: 'ID Pekerjaan dan ID Karyawan wajib diisi'
      });
    }

    const job = await getAssignedRunningJob(id_pekerjaan, workerId);
    if (!job) {
      return res.status(403).json({ success: false, message: 'Pekerjaan tidak ditugaskan kepada Anda.' });
    }
    if (job.status !== 'berjalan') {
      return res.status(403).json({ success: false, message: 'Absensi hanya dapat dilakukan saat status pekerjaan berjalan.' });
    }

    const methodLocation = String(job.metode_lokasi || 'titik').toLowerCase();
    const currentPoint = validCoordinate(masuk_latitude, masuk_longitude);
    let measuredDistance = null;
    if (methodLocation !== 'wfh') {
      const targetPoint = validCoordinate(job.latitude, job.longitude);
      if (!targetPoint) {
        return res.status(409).json({ success: false, message: 'Admin belum menetapkan koordinat lokasi pekerjaan.' });
      }
      if (!currentPoint) {
        return res.status(400).json({ success: false, message: 'Koordinat GPS Anda belum valid. Deteksi ulang lokasi.' });
      }
      measuredDistance = distanceMeters(targetPoint.latitude, targetPoint.longitude, currentPoint.latitude, currentPoint.longitude);
      const radius = Math.max(10, Number(job.radius_meter) || 100);
      if (measuredDistance > radius) {
        return res.status(403).json({
          success: false,
          message: `Anda berada di luar radius pekerjaan (${Math.round(measuredDistance)} m dari batas ${radius} m).`,
          data: { jarak_meter: Math.round(measuredDistance), radius_meter: radius },
        });
      }
    }

    const { tanggal: today, jam: nowTime } = getJakartaNow();
    const finalTanggal = today;
    const finalJamMasuk = nowTime;

    // Simpan foto base64 ke disk jika ada
    const rawPhoto = foto_masuk || foto_lokasi || null;
    const fotoSaved = saveBase64Image(rawPhoto, 'absensi', 'absensi_masuk_');

    const finalTitikLokasi = currentPoint ? `${currentPoint.latitude}, ${currentPoint.longitude}` : (titik_lokasi || null);
    const jarak = measuredDistance;

    // Cek apakah hari ini sudah absen masuk untuk pekerjaan yang sama dan belum pulang
    const [existing] = await db.query(
      'SELECT id_absensi FROM absensi WHERE id_pekerjaan = ? AND id_karyawan = ? AND tanggal = ? AND jam_pulang IS NULL',
      [id_pekerjaan, workerId, finalTanggal]
    );

    if (existing.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Anda sudah melakukan absen masuk hari ini dan belum absen pulang.'
      });
    }

    const [result] = await db.query(
      `INSERT INTO absensi 
        (id_pekerjaan, id_karyawan, tanggal, jam_masuk, status_verifikasi, foto_masuk, foto_lokasi, masuk_latitude, masuk_longitude, masuk_alamat, titik_lokasi, jarak_masuk, jarak_meter, catatan)
       VALUES (?, ?, ?, ?, 'menunggu', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id_pekerjaan, workerId, finalTanggal, finalJamMasuk,
        fotoSaved, fotoSaved,
        currentPoint?.latitude ?? null, currentPoint?.longitude ?? null, masuk_alamat || null,
        finalTitikLokasi,
        jarak, jarak, catatan || null
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Absen masuk berhasil dicatat! Menunggu persetujuan Admin.',
      data: {
        id_absensi: result.insertId,
        tanggal: finalTanggal,
        jam_masuk: finalJamMasuk,
        foto_masuk: fotoSaved,
        titik_lokasi: finalTitikLokasi,
        status_verifikasi: 'menunggu'
      }
    });
  } catch (error) {
    console.error('Error absenMasuk:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal melakukan absen masuk',
      error: error.message
    });
  }
}

// 3. Karyawan Melakukan Absen Pulang
async function absenPulang(req, res) {
  try {
    let id = req.params.id || req.body.id_absensi || req.body.id || req.query.id_absensi;
    const workerId = Number(req.user?.id_karyawan);

    // Jika id tidak dikirim eksplisit, cari sesi aktif yang belum pulang hari ini
    if (!id && workerId) {
      const [actives] = await db.query(
        'SELECT id_absensi FROM absensi WHERE id_karyawan = ? AND jam_pulang IS NULL ORDER BY id_absensi DESC LIMIT 1',
        [workerId]
      );
      if (actives.length > 0) {
        id = actives[0].id_absensi;
      }
    }

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'ID Absensi tidak ditemukan untuk melakukan absen pulang.'
      });
    }

    const { jam: nowTimeJakarta, tanggal: todayJakarta } = getJakartaNow();
    const finalJamPulang = nowTimeJakarta;

    // Simpan foto bukti kamera pulang jika base64
    const rawPhoto = req.body.foto_pulang || req.body.foto_lokasi || null;
    const fotoSaved = saveBase64Image(rawPhoto, 'absensi', 'absensi_pulang_');

    let titikPulang = null;
    let jarakPulang = null;

    // Ambil data absensi masuk untuk validasi durasi
    const [absRows] = await db.query('SELECT * FROM absensi WHERE id_absensi = ? AND id_karyawan = ?', [id, workerId]);
    if (absRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Data absensi tidak ditemukan.'
      });
    }

    const curr = absRows[0];
    if (curr.jam_pulang) return res.status(409).json({ success: false, message: 'Sesi kerja ini sudah ditutup.' });

    const [jobRows] = await db.query(`SELECT id_pekerjaan, metode_lokasi, latitude, longitude, radius_meter
      FROM pekerjaan WHERE id_pekerjaan = ? LIMIT 1`, [curr.id_pekerjaan]);
    const job = jobRows[0];
    if (!job) return res.status(403).json({ success: false, message: 'Pekerjaan tidak ditugaskan kepada Anda.' });
    const methodLocation = String(job.metode_lokasi || 'titik').toLowerCase();
    const currentPoint = validCoordinate(req.body.pulang_latitude ?? req.body.latitude, req.body.pulang_longitude ?? req.body.longitude);
    if (methodLocation !== 'wfh') {
      const targetPoint = validCoordinate(job.latitude, job.longitude);
      if (!targetPoint) return res.status(409).json({ success: false, message: 'Koordinat lokasi pekerjaan belum tersedia.' });
      if (!currentPoint) return res.status(400).json({ success: false, message: 'Koordinat GPS saat pulang tidak valid.' });
      jarakPulang = distanceMeters(targetPoint.latitude, targetPoint.longitude, currentPoint.latitude, currentPoint.longitude);
      const radius = Math.max(10, Number(job.radius_meter) || 100);
      if (jarakPulang > radius) {
        return res.status(403).json({ success: false, message: `Anda berada di luar radius pekerjaan (${Math.round(jarakPulang)} m dari batas ${radius} m).` });
      }
    } else if (!currentPoint) {
      // Titik lokasi WFH opsional, tetapi bila dikirim harus tetap valid.
      titikPulang = req.body.titik_pulang || req.body.titik_lokasi || null;
    }
    if (currentPoint) titikPulang = `${currentPoint.latitude}, ${currentPoint.longitude}`;

    // Hitung durasi jam
    let durasiJam = 0;
    let durasiMenit = 0;
    if (curr.jam_masuk && finalJamPulang) {
      const [h1, m1, s1 = 0] = String(curr.jam_masuk).split(':').map(Number);
      const [h2, m2, s2 = 0] = String(finalJamPulang).split(':').map(Number);
      let sec1 = h1 * 3600 + m1 * 60 + s1;
      let sec2 = h2 * 3600 + m2 * 60 + s2;
      if (sec2 < sec1) {
        sec2 += 86400;
      }
      const diffSec = Math.max(0, sec2 - sec1);
      durasiJam = Number((diffSec / 3600).toFixed(2));
      durasiMenit = Math.floor(diffSec / 60);
    }

    // Update database absensi: set jam_pulang, foto, titik, jarak dan kembalikan status ke 'menunggu' untuk review admin
    await db.query(
      `UPDATE absensi SET
        jam_pulang = ?,
        foto_pulang = COALESCE(?, foto_pulang),
        titik_pulang = COALESCE(?, titik_pulang),
        pulang_latitude = COALESCE(?, pulang_latitude),
        pulang_longitude = COALESCE(?, pulang_longitude),
        pulang_alamat = COALESCE(?, pulang_alamat),
        jarak_pulang = COALESCE(?, jarak_pulang),
        status_verifikasi = CASE WHEN status_verifikasi = 'ditolak' THEN 'ditolak' ELSE 'menunggu' END
      WHERE id_absensi = ?`,
      [
        finalJamPulang,
        fotoSaved,
        titikPulang,
        currentPoint?.latitude ?? null,
        currentPoint?.longitude ?? null,
        req.body.pulang_alamat || null,
        jarakPulang,
        id
      ]
    );

    return res.json({
      success: true,
      message: `Absen pulang berhasil dicatat (${durasiJam} jam)! Menunggu persetujuan Admin.`,
      data: {
        id_absensi: Number(id),
        jam_pulang: finalJamPulang,
        tanggal_pulang: todayJakarta,
        titik_pulang: titikPulang,
        foto_pulang: fotoSaved,
        jarak_pulang: jarakPulang,
        durasi_jam: durasiJam,
        durasi_menit: durasiMenit,
        status_verifikasi: curr.status_verifikasi === 'ditolak' ? 'ditolak' : 'menunggu'
      }
    });
  } catch (error) {
    console.error('Error absenPulang:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal melakukan absen pulang',
      error: error.message
    });
  }
}

// 4. Admin Memverifikasi Absensi (Setujui / Tolak / Menunggu)
async function verifikasiAbsensi(req, res) {
  try {
    const id = req.params.id || req.query.id_absensi || req.body.id_absensi;
    const status_verifikasi = req.body.status_verifikasi || req.body.status;
    const catatan_admin = req.body.catatan_admin !== undefined ? req.body.catatan_admin : null;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'ID Absensi wajib disertakan'
      });
    }

    if (!['disetujui', 'ditolak', 'menunggu'].includes(status_verifikasi)) {
      return res.status(400).json({
        success: false,
        message: 'Status verifikasi harus "disetujui", "ditolak", atau "menunggu"'
      });
    }

    await db.query(
      `UPDATE absensi SET 
        status_verifikasi = ?, 
        catatan_admin = COALESCE(?, catatan_admin)
      WHERE id_absensi = ?`,
      [status_verifikasi, catatan_admin, id]
    );

    return res.json({
      success: true,
      message: `Presensi berhasil ${status_verifikasi === 'disetujui' ? 'disetujui' : status_verifikasi === 'ditolak' ? 'ditolak' : 'diubah ke status menunggu'}`
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal memverifikasi presensi',
      error: error.message
    });
  }
}

module.exports = {
  getAllAbsensi,
  getAbsensiById,
  absenMasuk,
  absenPulang,
  verifikasiAbsensi
};
