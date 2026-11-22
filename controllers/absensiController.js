const db = require('../config/database');
const { saveBase64Image } = require('../utils/uploadHelper');

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

// Helper kalkulasi evaluasi keterlambatan berdasarkan standar proyek
function evaluateKeterlambatan(jamMasuk, jamMasukStandar = '08:00:00', toleransiMenit = 15) {
  const jamStandar = jamMasukStandar || '08:00:00';
  const toleransi = Number(toleransiMenit !== undefined && toleransiMenit !== null ? toleransiMenit : 15);

  if (!jamMasuk) {
    return {
      jam_masuk_standar: jamStandar,
      toleransi_terlambat_menit: toleransi,
      status_keterlambatan: 'tepat_waktu',
      menit_terlambat: 0
    };
  }

  const [sh, sm] = String(jamStandar).split(':').map(Number);
  const standarMin = (sh || 0) * 60 + (sm || 0);
  const batasMin = standarMin + toleransi;

  const [ah, am] = String(jamMasuk).split(':').map(Number);
  const masukMin = (ah || 0) * 60 + (am || 0);

  if (masukMin <= batasMin) {
    return {
      jam_masuk_standar: jamStandar,
      toleransi_terlambat_menit: toleransi,
      status_keterlambatan: 'tepat_waktu',
      menit_terlambat: 0
    };
  }

  const menitLate = Math.max(0, masukMin - standarMin);
  return {
    jam_masuk_standar: jamStandar,
    toleransi_terlambat_menit: toleransi,
    status_keterlambatan: 'terlambat',
    menit_terlambat: menitLate
  };
}

// Helper parsing koordinat lat, lng dari parameter terpisah atau string "lat, lng"
function parseCoordinates(lat, lng, titikStr) {
  let latNum = Number(lat);
  let lngNum = Number(lng);
  if ((isNaN(latNum) || isNaN(lngNum) || (!latNum && !lngNum)) && typeof titikStr === 'string' && titikStr.includes(',')) {
    const parts = titikStr.split(',');
    latNum = parseFloat(parts[0]?.trim());
    lngNum = parseFloat(parts[1]?.trim());
  }
  if (!isNaN(latNum) && !isNaN(lngNum) && (latNum !== 0 || lngNum !== 0)) {
    return { lat: latNum, lng: lngNum };
  }
  return null;
}

// Rumus Haversine: Menghitung jarak presisi dua titik koordinat GPS di bumi (dalam satuan meter)
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const p1 = Number(lat1);
  const l1 = Number(lon1);
  const p2 = Number(lat2);
  const l2 = Number(lon2);
  if (isNaN(p1) || isNaN(l1) || isNaN(p2) || isNaN(l2)) return null;

  const R = 6371000; // Radius bumi dalam meter
  const dLat = (p2 - p1) * Math.PI / 180;
  const dLon = (l2 - l1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(p1 * Math.PI / 180) * Math.cos(p2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

// 1. Ambil Semua Data Absensi (Dengan filter & evaluasi keterlambatan berbasis proyek)
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
        p.jam_masuk_standar,
        p.toleransi_terlambat_menit,
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

      // Evaluasi toleransi keterlambatan
      const evalLate = evaluateKeterlambatan(a.jam_masuk, a.jam_masuk_standar, a.toleransi_terlambat_menit);

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
        durasi_menit: totalMenit,
        jam_masuk_standar: evalLate.jam_masuk_standar,
        toleransi_terlambat_menit: evalLate.toleransi_terlambat_menit,
        status_keterlambatan: evalLate.status_keterlambatan,
        menit_terlambat: evalLate.menit_terlambat
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

    const workerId = id_karyawan || req.user?.id_karyawan;

    if (!id_pekerjaan || !workerId) {
      return res.status(400).json({
        success: false,
        message: 'ID Pekerjaan dan ID Karyawan wajib diisi'
      });
    }

    const { tanggal: today, jam: nowTime } = getJakartaNow();
    const finalTanggal = req.body.tanggal || today;
    const finalJamMasuk = req.body.jam_masuk || nowTime;

    // Simpan foto base64 ke disk jika ada
    const rawPhoto = foto_masuk || foto_lokasi || null;
    const fotoSaved = saveBase64Image(rawPhoto, 'absensi', 'absensi_masuk_');

    const finalTitikLokasi = titik_lokasi || (masuk_latitude && masuk_longitude ? `${masuk_latitude}, ${masuk_longitude}` : null);
    let finalJarak = jarak_masuk !== undefined ? Number(jarak_masuk) : (jarak_meter !== undefined ? Number(jarak_meter) : 0);
    let finalCatatan = catatan ? String(catatan).trim() : '';

    // Ambil data lokasi & radius proyek untuk validasi Geofencing backend & evaluasi keterlambatan
    const [projectRows] = await db.query(
      'SELECT latitude, longitude, titik_lokasi, radius_meter, jam_masuk_standar, toleransi_terlambat_menit FROM pekerjaan WHERE id_pekerjaan = ?',
      [id_pekerjaan]
    );

    let evalLate = {
      jam_masuk_standar: '08:00:00',
      toleransi_terlambat_menit: 15,
      status_keterlambatan: 'tepat_waktu',
      menit_terlambat: 0
    };

    if (projectRows.length > 0) {
      const job = projectRows[0];
      const jobCoords = parseCoordinates(job.latitude, job.longitude, job.titik_lokasi);
      const userCoords = parseCoordinates(masuk_latitude, masuk_longitude, finalTitikLokasi);
      const maxRadius = Number(job.radius_meter) || 100;

      if (jobCoords && userCoords) {
        const computedDist = calculateHaversineDistance(jobCoords.lat, jobCoords.lng, userCoords.lat, userCoords.lng);
        if (computedDist !== null) {
          finalJarak = computedDist;
          if (computedDist > maxRadius) {
            const warningTag = `[Di luar radius: ${computedDist}m / maks ${maxRadius}m]`;
            finalCatatan = finalCatatan ? `${finalCatatan} ${warningTag}` : warningTag;
          }
        }
      }

      evalLate = evaluateKeterlambatan(finalJamMasuk, job.jam_masuk_standar, job.toleransi_terlambat_menit);
    }

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
        masuk_latitude || null, masuk_longitude || null, masuk_alamat || null,
        finalTitikLokasi,
        finalJarak, finalJarak, finalCatatan || null
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Absen masuk berhasil dicatat! Menunggu persetujuan Admin.',
      data: {
        id_absensi: result.insertId,
        id_pekerjaan: Number(id_pekerjaan),
        id_karyawan: Number(workerId),
        tanggal: finalTanggal,
        jam_masuk: finalJamMasuk,
        foto_masuk: fotoSaved,
        titik_lokasi: finalTitikLokasi,
        status_verifikasi: 'menunggu',
        jam_masuk_standar: evalLate.jam_masuk_standar,
        toleransi_terlambat_menit: evalLate.toleransi_terlambat_menit,
        status_keterlambatan: evalLate.status_keterlambatan,
        menit_terlambat: evalLate.menit_terlambat
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
    const workerId = req.user?.id_karyawan || req.body.id_karyawan;

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
    const finalJamPulang = req.body.jam_pulang || nowTimeJakarta;

    // Simpan foto bukti kamera pulang jika base64
    const rawPhoto = req.body.foto_pulang || req.body.foto_lokasi || null;
    const fotoSaved = saveBase64Image(rawPhoto, 'absensi', 'absensi_pulang_');

    const titikPulang = req.body.titik_pulang || req.body.titik_lokasi || (req.body.pulang_latitude && req.body.pulang_longitude ? `${req.body.pulang_latitude}, ${req.body.pulang_longitude}` : null);
    let jarakPulang = req.body.jarak_pulang !== undefined ? Number(req.body.jarak_pulang) : (req.body.jarak_meter !== undefined ? Number(req.body.jarak_meter) : null);

    // Ambil data absensi masuk untuk validasi durasi
    const [absRows] = await db.query('SELECT * FROM absensi WHERE id_absensi = ?', [id]);
    if (absRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Data absensi tidak ditemukan.'
      });
    }

    const curr = absRows[0];

    // Validasi Geofencing backend saat pulang jika koordinat pulang tersedia
    if (curr.id_pekerjaan) {
      const [projRows] = await db.query(
        'SELECT latitude, longitude, titik_lokasi, radius_meter FROM pekerjaan WHERE id_pekerjaan = ?',
        [curr.id_pekerjaan]
      );
      if (projRows.length > 0) {
        const job = projRows[0];
        const jobCoords = parseCoordinates(job.latitude, job.longitude, job.titik_lokasi);
        const userCoordsPulang = parseCoordinates(req.body.pulang_latitude, req.body.pulang_longitude, titikPulang);
        if (jobCoords && userCoordsPulang) {
          const distPulang = calculateHaversineDistance(jobCoords.lat, jobCoords.lng, userCoordsPulang.lat, userCoordsPulang.lng);
          if (distPulang !== null) {
            jarakPulang = distPulang;
          }
        }
      }
    }
    const isOvernight = Boolean(req.body.is_overnight);

    // Hitung durasi jam
    let durasiJam = 0;
    let durasiMenit = 0;
    if (curr.jam_masuk && finalJamPulang) {
      const [h1, m1, s1 = 0] = String(curr.jam_masuk).split(':').map(Number);
      const [h2, m2, s2 = 0] = String(finalJamPulang).split(':').map(Number);
      let sec1 = h1 * 3600 + m1 * 60 + s1;
      let sec2 = h2 * 3600 + m2 * 60 + s2;
      if (isOvernight && sec2 < sec1) {
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
        req.body.pulang_latitude || null,
        req.body.pulang_longitude || null,
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
  absenMasuk,
  absenPulang,
  verifikasiAbsensi,
  evaluateKeterlambatan
};
