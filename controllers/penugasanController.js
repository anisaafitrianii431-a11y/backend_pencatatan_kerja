const db = require('../config/database');

const sqlDurasi = `
  CASE 
    WHEN a.jam_pulang IS NOT NULL AND a.jam_pulang >= a.jam_masuk 
      THEN ROUND(TIME_TO_SEC(TIMEDIFF(a.jam_pulang, a.jam_masuk)) / 3600, 2)
    WHEN a.jam_pulang IS NOT NULL AND a.jam_pulang < a.jam_masuk 
      THEN ROUND((TIME_TO_SEC(TIMEDIFF(a.jam_pulang, a.jam_masuk)) + 86400) / 3600, 2)
    ELSE 0 
  END
`;

// 1. Ambil Penugasan / Notifikasi Karyawan
async function getAllPenugasan(req, res) {
  try {
    const action = req.query.action || req.body?.action;
    const kId = req.user?.id_karyawan || (req.query.id_karyawan ? parseInt(req.query.id_karyawan, 10) : null);

    // Fitur Notifikasi Penugasan
    if (action === 'notifikasi') {
      const [list] = await db.query(`
        SELECT pn.id_penugasan, pn.id_pekerjaan, pn.peran_tugas, pn.jenis_penugasan, pn.status_baca, pn.created_at,
               p.nama_pekerjaan, p.deskripsi, p.lokasi, p.tanggal_mulai, p.target_selesai, p.status AS status_pekerjaan
        FROM penugasan pn
        JOIN pekerjaan p ON pn.id_pekerjaan = p.id_pekerjaan
        WHERE pn.id_karyawan = ?
        ORDER BY pn.id_penugasan DESC
      `, [kId || 0]);

      let unreadCount = 0;
      for (const item of list) {
        if (item.status_baca === 'belum') unreadCount++;
      }

      return res.json({
        success: true,
        message: 'Daftar notifikasi penugasan karyawan berhasil dimuat',
        data: {
          total: list.length,
          unread_count: unreadCount,
          notifikasi: list
        }
      });
    }

    const { id_pekerjaan, id_karyawan } = req.query;

    // Jika karyawan melihat rekan kerja pada satu pekerjaan
    if (req.user?.peran === 'karyawan' && id_pekerjaan) {
      const [totalRow] = await db.query(`
        SELECT COALESCE(SUM(${sqlDurasi}), 0) AS total_jam
        FROM absensi a
        WHERE a.id_pekerjaan = ? AND a.status_verifikasi = 'disetujui' AND a.jam_pulang IS NOT NULL
      `, [id_pekerjaan]);
      const totalJamProyek = Number(totalRow[0]?.total_jam || 0);

      const [workers] = await db.query(`
        SELECT pn.id_penugasan, pn.id_pekerjaan, pn.id_karyawan, pn.peran_tugas,
               k.nama, k.jabatan,
               COALESCE(SUM(${sqlDurasi}), 0) AS total_jam_pekerja
        FROM penugasan pn
        JOIN karyawan k ON pn.id_karyawan = k.id_karyawan
        LEFT JOIN absensi a ON a.id_pekerjaan = pn.id_pekerjaan 
                           AND a.id_karyawan = pn.id_karyawan 
                           AND a.status_verifikasi = 'disetujui'
                           AND a.jam_pulang IS NOT NULL
        WHERE pn.id_pekerjaan = ?
        GROUP BY pn.id_penugasan, pn.id_pekerjaan, pn.id_karyawan, pn.peran_tugas, k.nama, k.jabatan
        ORDER BY pn.id_penugasan DESC
      `, [id_pekerjaan]);

      const formattedWorkers = workers.map(p => {
        const jamP = Number(p.total_jam_pekerja || 0);
        return {
          ...p,
          total_jam_pekerja: jamP,
          persentase_kontribusi: totalJamProyek > 0 ? Number(((jamP / totalJamProyek) * 100).toFixed(1)) : 0,
          is_saya: Number(p.id_karyawan) === Number(kId)
        };
      });

      return res.json({
        success: true,
        message: 'Daftar rekan kerja pada pekerjaan berhasil dimuat',
        data: {
          total_jam_proyek: totalJamProyek,
          pekerja: formattedWorkers
        }
      });
    }

    // Tampilan Standar / Admin
    let query = `
      SELECT pn.*,
        p.nama_pekerjaan, p.lokasi, p.tanggal_mulai, p.target_selesai, p.status AS status_pekerjaan, p.jenis_upah, p.nominal_upah,
        k.nama AS nama_karyawan, k.kode_karyawan, k.jabatan
      FROM penugasan pn
      LEFT JOIN pekerjaan p ON pn.id_pekerjaan = p.id_pekerjaan
      LEFT JOIN karyawan k ON pn.id_karyawan = k.id_karyawan
      WHERE 1=1
    `;
    const params = [];
    if (id_pekerjaan) {
      query += ` AND pn.id_pekerjaan = ? `;
      params.push(id_pekerjaan);
    }
    if (id_karyawan) {
      query += ` AND pn.id_karyawan = ? `;
      params.push(id_karyawan);
    }
    query += ` ORDER BY pn.id_penugasan DESC `;

    const [rows] = await db.query(query, params);
    return res.json({
      success: true,
      message: 'Data penugasan berhasil dimuat',
      data: rows
    });
  } catch (err) {
    console.error('Error getAllPenugasan:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// 2. Tambah Penugasan / Tandai Baca Notifikasi
async function createPenugasan(req, res) {
  try {
    const action = req.query.action || req.body?.action;
    const kId = req.user?.id_karyawan || (req.body.id_karyawan ? parseInt(req.body.id_karyawan, 10) : null);

    // Tandai Baca Notifikasi
    if (action === 'baca' || action === 'mark_read') {
      const id_penugasan = parseInt(req.body.id_penugasan || req.query.id_penugasan || 0, 10);
      if (id_penugasan > 0) {
        await db.query("UPDATE penugasan SET status_baca = 'sudah' WHERE id_penugasan = ?", [id_penugasan]);
        return res.json({ success: true, message: `Notifikasi penugasan #${id_penugasan} telah dibaca` });
      } else if (kId) {
        await db.query("UPDATE penugasan SET status_baca = 'sudah' WHERE id_karyawan = ?", [kId]);
        return res.json({ success: true, message: 'Semua notifikasi penugasan telah dibaca' });
      }
      return res.json({ success: true });
    }

    const { id_pekerjaan, id_karyawan, peran_tugas = 'Anggota Tim Pelaksana', jenis_penugasan = 'admin' } = req.body;
    if (!id_pekerjaan || !id_karyawan) {
      return res.status(400).json({ success: false, message: 'ID Pekerjaan dan ID Karyawan wajib diisi' });
    }

    const [result] = await db.query(
      `INSERT INTO penugasan (id_pekerjaan, id_karyawan, peran_tugas, jenis_penugasan, status_penugasan, status_baca)
       VALUES (?, ?, ?, ?, 'aktif', 'belum')`,
      [id_pekerjaan, id_karyawan, peran_tugas, jenis_penugasan]
    );

    return res.status(201).json({
      success: true,
      message: 'Penugasan berhasil ditambahkan',
      data: { id_penugasan: result.insertId }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

// 3. Hapus Penugasan
async function deletePenugasan(req, res) {
  try {
    const id = req.params.id || req.query.id_penugasan || req.body?.id_penugasan;
    if (!id) {
      return res.status(400).json({ success: false, message: 'ID Penugasan tidak valid' });
    }
    await db.query('DELETE FROM penugasan WHERE id_penugasan = ?', [id]);
    return res.json({ success: true, message: 'Penugasan berhasil dihapus' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = {
  getAllPenugasan,
  createPenugasan,
  deletePenugasan
};
