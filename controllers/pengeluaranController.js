const db = require('../config/database');
const { saveBase64Image } = require('../utils/uploadHelper');

// 1. Ambil Semua Data Pengeluaran / Dispatcher Berdasarkan Query Action
async function getAllPengeluaran(req, res) {
  try {
    const action = req.query.action || req.body?.action;

    if (action === 'summary') return getSummary(req, res);
    if (action === 'dana_kantor') return getDanaKantor(req, res);
    if (action === 'kas_list') return getKasList(req, res);
    if (action === 'dana_tersedia') return getDanaTersedia(req, res);
    if (action === 'pengembalian_dana') return getPengembalianDana(req, res);
    if (action === 'reimbursement_list') return getReimbursementList(req, res);
    if (action === 'riwayat_bayar_reimbursement') return getRiwayatBayarReimbursement(req, res);
    if (action === 'rekap_uang_kantor') return getRekapUangKantor(req, res);

    const { id_karyawan, id_pekerjaan, jenis_dana, status_verifikasi, bulan, include_kas_pj } = req.query;

    let query = `
      SELECT 
        p.*,
        k.nama AS nama_karyawan,
        k.kode_karyawan,
        k.jabatan,
        pk.nama_pekerjaan,
        pk.lokasi AS lokasi_pekerjaan,
        pj.nama AS nama_penanggung_jawab,
        pj.kode_karyawan AS kode_pj
      FROM pengeluaran p
      LEFT JOIN karyawan k ON p.id_karyawan = k.id_karyawan
      LEFT JOIN pekerjaan pk ON p.id_pekerjaan = pk.id_pekerjaan
      LEFT JOIN karyawan pj ON p.id_penanggung_jawab = pj.id_karyawan
      WHERE 1=1
    `;

    const params = [];

    // Filter berdasarkan identitas pengguna jika karyawan
    const isWorker = req.user?.peran === 'karyawan' && !req.query.admin_view;
    const targetKaryawan = isWorker
      ? req.user.id_karyawan
      : (id_karyawan && !isNaN(parseInt(id_karyawan, 10)) ? parseInt(id_karyawan, 10) : null);

    if (targetKaryawan) {
      if (include_kas_pj === '1') {
        query += ` AND (p.id_karyawan = ? OR p.id_penanggung_jawab = ?) `;
        params.push(targetKaryawan, targetKaryawan);
      } else {
        query += ` AND p.id_karyawan = ? `;
        params.push(targetKaryawan);
      }
    }

    if (id_pekerjaan) {
      query += ` AND p.id_pekerjaan = ? `;
      params.push(id_pekerjaan);
    }
    if (jenis_dana) {
      query += ` AND p.jenis_dana = ? `;
      params.push(jenis_dana);
    }
    if (status_verifikasi) {
      query += ` AND p.status_verifikasi = ? `;
      params.push(status_verifikasi);
    }
    if (bulan) {
      query += ` AND p.tanggal LIKE ? `;
      params.push(`${bulan}%`);
    }

    query += ` ORDER BY p.tanggal DESC, p.id_pengeluaran DESC `;

    const [rows] = await db.query(query, params);

    return res.json({
      success: true,
      message: 'Data pengeluaran berhasil dimuat',
      data: rows
    });
  } catch (error) {
    console.error('Error getAllPengeluaran:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal memuat data pengeluaran',
      error: error.message
    });
  }
}

// 2. Ringkasan Finansial (Summary Metrics untuk Tab & Dashboard)
async function getSummary(req, res) {
  try {
    const [pRows] = await db.query(`
      SELECT 
        COALESCE(SUM(CASE WHEN status_verifikasi = 'disetujui' THEN nominal ELSE 0 END), 0) AS total_pengeluaran_disetujui,
        COALESCE(SUM(CASE WHEN status_verifikasi = 'disetujui' AND jenis_dana = 'kantor' THEN nominal ELSE 0 END), 0) AS uang_kantor_disetujui,
        COALESCE(SUM(CASE WHEN status_verifikasi = 'disetujui' AND jenis_dana = 'pribadi' THEN nominal ELSE 0 END), 0) AS uang_pribadi_disetujui,
        COALESCE(SUM(CASE WHEN status_verifikasi = 'menunggu' THEN 1 ELSE 0 END), 0) AS pending_count,
        COALESCE(SUM(CASE WHEN status_verifikasi = 'menunggu' THEN nominal ELSE 0 END), 0) AS pending_nominal,
        COALESCE(SUM(CASE WHEN jenis_dana = 'pribadi' AND status_verifikasi = 'disetujui' AND (status_reimbursement = 'sudah' OR status_ganti = 'sudah') THEN nominal ELSE 0 END), 0) AS reimbursement_sudah_dibayar,
        COALESCE(SUM(CASE WHEN jenis_dana = 'pribadi' AND status_verifikasi = 'disetujui' AND (status_reimbursement <> 'sudah' AND status_ganti <> 'sudah') THEN COALESCE(sisa_pembayaran, nominal) ELSE 0 END), 0) AS reimbursement_belum_dibayar
      FROM pengeluaran
    `);

    // Total dana kantor masuk (pemasukan_kas) dan disalurkan (penyaluran_dana)
    const [dkRows] = await db.query(`
      SELECT 
        COALESCE(SUM(CASE WHEN jenis_transaksi = 'pemasukan_kas' THEN nominal ELSE 0 END), 0) AS total_masuk_kas,
        COALESCE(SUM(CASE WHEN jenis_transaksi = 'penyaluran_dana' THEN nominal ELSE 0 END), 0) AS total_penyaluran
      FROM dana_kantor
    `);

    // Total pengembalian dana kantor oleh pekerja yang disetujui
    const [retRows] = await db.query(`
      SELECT COALESCE(SUM(nominal), 0) AS total_kembali
      FROM pengembalian_dana
      WHERE status_verifikasi = 'disetujui'
    `);

    const p = pRows[0];
    const dk = dkRows[0];
    const ret = retRows[0];

    const totalKasMasuk = Number(dk.total_masuk_kas || 0);
    const totalPenyaluran = Number(dk.total_penyaluran || 0);
    const uangKantorDisetujui = Number(p.uang_kantor_disetujui || 0);
    const totalKembali = Number(ret.total_kembali || 0);

    const totalSaldoPj = Math.max(0, totalPenyaluran - uangKantorDisetujui - totalKembali);
    const saldoKasSaatIni = totalKasMasuk > 0 ? (totalKasMasuk - uangKantorDisetujui + totalKembali) : totalSaldoPj;

    return res.json({
      success: true,
      message: 'Ringkasan finansial berhasil dimuat',
      data: {
        total_pengeluaran_disetujui: Number(p.total_pengeluaran_disetujui || 0),
        uang_kantor_disetujui: uangKantorDisetujui,
        uang_pribadi_disetujui: Number(p.uang_pribadi_disetujui || 0),
        pending_count: Number(p.pending_count || 0),
        pending_nominal: Number(p.pending_nominal || 0),

        // Metrics untuk PengeluaranAdmin.jsx (Card Subtab A & Tab 3 Rekap)
        total_pemasukan_perusahaan: totalKasMasuk,
        total_dana_disalurkan: totalPenyaluran,
        total_saldo_penanggung_jawab: totalSaldoPj,
        saldo_dana_kantor_aktif: totalSaldoPj,
        total_pengembalian_diverifikasi: totalKembali,
        total_pengembalian_dana: totalKembali,
        total_reimbursement_sudah_dibayar: Number(p.reimbursement_sudah_dibayar || 0),
        total_reimbursement_belum_dibayar: Number(p.reimbursement_belum_dibayar || 0),
        reimbursement_sudah_dibayar: Number(p.reimbursement_sudah_dibayar || 0),
        reimbursement_belum_dibayar: Number(p.reimbursement_belum_dibayar || 0),
        pribadi_sudah_diganti: Number(p.reimbursement_sudah_dibayar || 0),
        pribadi_belum_diganti: Number(p.reimbursement_belum_dibayar || 0),

        // Metrics umum
        total_kas_kantor: totalKasMasuk || totalPenyaluran,
        saldo_kas_saat_ini: saldoKasSaatIni
      }
    });
  } catch (error) {
    console.error('Error getSummary:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal memuat ringkasan finansial',
      error: error.message
    });
  }
}

// 3. Tambah Nota Belanja / Pengeluaran Baru
async function createPengeluaran(req, res) {
  try {
    const {
      id_pekerjaan,
      id_karyawan,
      tanggal,
      nominal,
      kategori = 'operasional',
      jenis_dana = 'pribadi',
      id_dana = null,
      id_penanggung_jawab = null,
      keterangan = '',
      foto_kwitansi = '',
      foto_nota = '',
      status_verifikasi = 'menunggu'
    } = req.body;

    // Resolusi Karyawan yang aman (tidak terpengaruh string "undefined" atau "null")
    let workerId = null;
    if (id_karyawan && !isNaN(parseInt(id_karyawan, 10)) && parseInt(id_karyawan, 10) > 0) {
      workerId = parseInt(id_karyawan, 10);
    } else if (req.user?.id_karyawan && !isNaN(parseInt(req.user.id_karyawan, 10)) && parseInt(req.user.id_karyawan, 10) > 0) {
      workerId = parseInt(req.user.id_karyawan, 10);
    } else if (req.user?.id && !isNaN(parseInt(req.user.id, 10)) && parseInt(req.user.id, 10) > 0) {
      workerId = parseInt(req.user.id, 10);
    }

    if (!workerId && req.user?.id_user) {
      const [uRows] = await db.query('SELECT id_karyawan FROM user WHERE id_user = ?', [req.user.id_user]);
      if (uRows.length > 0 && uRows[0].id_karyawan) {
        workerId = uRows[0].id_karyawan;
      }
    }

    if (!workerId) {
      const [kRows] = await db.query('SELECT id_karyawan FROM karyawan WHERE status = "aktif" LIMIT 1');
      if (kRows.length > 0) workerId = kRows[0].id_karyawan;
    }

    // Resolusi Pekerjaan yang aman
    let jobId = null;
    if (id_pekerjaan && !isNaN(parseInt(id_pekerjaan, 10)) && parseInt(id_pekerjaan, 10) > 0) {
      jobId = parseInt(id_pekerjaan, 10);
    }
    if (!jobId && workerId) {
      const [pRows] = await db.query('SELECT id_pekerjaan FROM penugasan WHERE id_karyawan = ? AND status_penugasan = "aktif" LIMIT 1', [workerId]);
      if (pRows.length > 0) jobId = pRows[0].id_pekerjaan;
    }
    if (!jobId) {
      const [pRows] = await db.query('SELECT id_pekerjaan FROM pekerjaan WHERE status = "berjalan" LIMIT 1');
      if (pRows.length > 0) {
        jobId = pRows[0].id_pekerjaan;
      } else {
        const [anyRows] = await db.query('SELECT id_pekerjaan FROM pekerjaan LIMIT 1');
        if (anyRows.length > 0) jobId = anyRows[0].id_pekerjaan;
      }
    }

    const nominalNum = Number(nominal) || 0;
    if (nominalNum <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Nominal pengeluaran harus lebih besar dari 0'
      });
    }

    if (!jobId || !workerId) {
      return res.status(400).json({
        success: false,
        message: 'Pekerjaan dan Karyawan wajib valid'
      });
    }

    // Generate Nomor Transaksi
    const [countRows] = await db.query('SELECT COUNT(*) AS total FROM pengeluaran');
    const nextNum = (countRows[0].total || 0) + 1;
    const noTrans = req.body.nomor_transaksi || `EXP-${String(nextNum).padStart(4, '0')}`;
    const tgl = tanggal || new Date().toISOString().slice(0, 10);

    // Resolusi Foto Bukti Kuitansi
    const rawPhoto = foto_kwitansi || foto_nota || req.body?.foto_kwitansi || null;
    let fotoSaved = saveBase64Image(rawPhoto, 'kwitansi', 'kwitansi_');
    if (!fotoSaved && req.file) {
      const subfolder = path.basename(path.dirname(req.file.path));
      fotoSaved = `uploads/${subfolder}/${req.file.filename}`.replace(/\\/g, '/');
    }
    if (!fotoSaved) {
      fotoSaved = 'uploads/kwitansi/nota_default.jpg';
    }

    // Resolusi Dana & Penanggung Jawab
    let danaId = null;
    let pjId = null;
    if (jenis_dana === 'kantor') {
      danaId = (id_dana && !isNaN(parseInt(id_dana, 10))) ? parseInt(id_dana, 10) : null;
      pjId = (id_penanggung_jawab && !isNaN(parseInt(id_penanggung_jawab, 10))) ? parseInt(id_penanggung_jawab, 10) : null;
      if (danaId && !pjId) {
        const [dRows] = await db.query('SELECT id_penanggung_jawab FROM dana_kantor WHERE id_dana = ?', [danaId]);
        if (dRows.length > 0) pjId = dRows[0].id_penanggung_jawab;
      }
    }

    const nominalDisetujui = (status_verifikasi === 'disetujui') ? nominalNum : null;
    const statusReimburse = (jenis_dana === 'pribadi') ? ((status_verifikasi === 'disetujui') ? 'disetujui' : 'menunggu') : 'menunggu';
    const sisaBayar = (jenis_dana === 'pribadi') ? nominalNum : 0.00;

    const [result] = await db.query(
      `INSERT INTO pengeluaran 
        (nomor_transaksi, id_pekerjaan, id_karyawan, tanggal, nominal, nominal_disetujui, total_dibayar, sisa_pembayaran, kategori, jenis_dana, id_dana, id_penanggung_jawab, keterangan, foto_kwitansi, status_verifikasi, status_reimbursement, status_ganti)
       VALUES (?, ?, ?, ?, ?, ?, 0.00, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        noTrans, jobId, workerId, tgl, nominalNum, nominalDisetujui, sisaBayar,
        kategori || 'operasional', jenis_dana, danaId, pjId,
        keterangan || '', fotoSaved,
        status_verifikasi,
        statusReimburse,
        'belum'
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Pengeluaran berhasil dicatat dan diajukan ke admin!',
      data: {
        id_pengeluaran: result.insertId,
        nomor_transaksi: noTrans,
        foto_kwitansi: fotoSaved
      }
    });
  } catch (error) {
    console.error('Error createPengeluaran:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal mencatat pengeluaran: ' + error.message,
      error: error.message
    });
  }
}

// 3b. Update Pengeluaran / Edit Catatan Pengeluaran
async function updatePengeluaran(req, res) {
  try {
    const id = req.params.id || req.body.id_pengeluaran || req.query.id_pengeluaran;
    if (!id) {
      return res.status(400).json({ success: false, message: 'ID Pengeluaran tidak valid' });
    }

    const [currRows] = await db.query('SELECT * FROM pengeluaran WHERE id_pengeluaran = ?', [id]);
    if (currRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Pengeluaran tidak ditemukan' });
    }
    const curr = currRows[0];

    const {
      id_pekerjaan,
      tanggal,
      nominal,
      kategori,
      jenis_dana,
      id_dana,
      id_penanggung_jawab,
      keterangan,
      foto_kwitansi,
      foto_nota
    } = req.body;

    const jobId = (id_pekerjaan && !isNaN(parseInt(id_pekerjaan, 10))) ? parseInt(id_pekerjaan, 10) : curr.id_pekerjaan;
    const tgl = tanggal || curr.tanggal;
    const nominalNum = nominal !== undefined ? Number(nominal) : Number(curr.nominal);
    const kat = kategori || curr.kategori || 'operasional';
    const jDana = jenis_dana || curr.jenis_dana || 'pribadi';
    const dId = (id_dana !== undefined) ? ((id_dana && !isNaN(parseInt(id_dana, 10))) ? parseInt(id_dana, 10) : null) : curr.id_dana;
    let pjId = (id_penanggung_jawab !== undefined) ? ((id_penanggung_jawab && !isNaN(parseInt(id_penanggung_jawab, 10))) ? parseInt(id_penanggung_jawab, 10) : null) : curr.id_penanggung_jawab;
    if (dId && !pjId) {
      const [dRows] = await db.query('SELECT id_penanggung_jawab FROM dana_kantor WHERE id_dana = ?', [dId]);
      if (dRows.length > 0) pjId = dRows[0].id_penanggung_jawab;
    }
    const ket = keterangan !== undefined ? keterangan : curr.keterangan;

    const rawPhoto = foto_kwitansi || foto_nota || null;
    let fotoSaved = curr.foto_kwitansi;
    if (rawPhoto) {
      fotoSaved = saveBase64Image(rawPhoto, 'kwitansi', 'kwitansi_') || curr.foto_kwitansi;
    }

    const sisaBayar = (jDana === 'pribadi') ? nominalNum : 0.00;
    const statusReimburse = (jDana === 'pribadi') ? 'menunggu' : 'menunggu';

    await db.query(`
      UPDATE pengeluaran SET
        id_pekerjaan = ?,
        tanggal = ?,
        nominal = ?,
        nominal_disetujui = NULL,
        sisa_pembayaran = ?,
        kategori = ?,
        jenis_dana = ?,
        id_dana = ?,
        id_penanggung_jawab = ?,
        keterangan = ?,
        foto_kwitansi = ?,
        status_verifikasi = 'menunggu',
        status_reimbursement = ?,
        catatan_penolakan = NULL
      WHERE id_pengeluaran = ?
    `, [jobId, tgl, nominalNum, sisaBayar, kat, jDana, dId, pjId, ket, fotoSaved, statusReimburse, id]);

    return res.json({
      success: true,
      message: 'Catatan pengeluaran berhasil diperbarui dan diajukan ulang ke admin!',
      data: { id_pengeluaran: id, foto_kwitansi: fotoSaved }
    });
  } catch (error) {
    console.error('Error updatePengeluaran:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal memperbarui pengeluaran: ' + error.message,
      error: error.message
    });
  }
}

// 4. Verifikasi Pengeluaran (Setujui / Tolak oleh Admin)
async function verifikasiPengeluaran(req, res) {
  try {
    const id = req.params.id || req.body.id_pengeluaran || req.query.id_pengeluaran;
    const status_verifikasi = req.body.status_verifikasi || req.body.status;
    const catatan_penolakan = req.body.catatan_penolakan || null;
    let nominal_disetujui = req.body.nominal_disetujui !== undefined ? Number(req.body.nominal_disetujui) : null;

    if (!id) {
      return res.status(400).json({ success: false, message: 'ID Pengeluaran tidak valid' });
    }

    const [curRows] = await db.query('SELECT * FROM pengeluaran WHERE id_pengeluaran = ?', [id]);
    if (curRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Pengeluaran tidak ditemukan' });
    }
    const curr = curRows[0];

    if (status_verifikasi === 'disetujui') {
      if (nominal_disetujui === null || nominal_disetujui <= 0) {
        nominal_disetujui = Number(curr.nominal);
      }
      const sisaBayar = (curr.jenis_dana === 'pribadi') ? Math.max(0, nominal_disetujui - Number(curr.total_dibayar || 0)) : 0;
      const statusReimburse = (curr.jenis_dana === 'pribadi') ? (sisaBayar <= 0 ? 'sudah' : 'disetujui') : null;

      await db.query(`
        UPDATE pengeluaran SET
          status_verifikasi = 'disetujui',
          nominal_disetujui = ?,
          sisa_pembayaran = ?,
          status_reimbursement = ?,
          catatan_penolakan = NULL
        WHERE id_pengeluaran = ?
      `, [nominal_disetujui, sisaBayar, statusReimburse, id]);
    } else if (status_verifikasi === 'ditolak') {
      await db.query(`
        UPDATE pengeluaran SET
          status_verifikasi = 'ditolak',
          nominal_disetujui = 0,
          sisa_pembayaran = 0,
          status_reimbursement = CASE WHEN jenis_dana = 'pribadi' THEN 'ditolak' ELSE NULL END,
          catatan_penolakan = ?
        WHERE id_pengeluaran = ?
      `, [catatan_penolakan, id]);
    } else {
      // Status 'menunggu'
      await db.query(`
        UPDATE pengeluaran SET
          status_verifikasi = 'menunggu',
          nominal_disetujui = NULL,
          catatan_penolakan = ?
        WHERE id_pengeluaran = ?
      `, [catatan_penolakan, id]);
    }

    return res.json({
      success: true,
      message: `Pengeluaran berhasil ${status_verifikasi === 'disetujui' ? 'disetujui' : status_verifikasi === 'ditolak' ? 'ditolak' : 'diubah ke status menunggu'}`
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal memverifikasi pengeluaran',
      error: error.message
    });
  }
}

// 5. Hapus Pengeluaran
async function deletePengeluaran(req, res) {
  try {
    const id = req.params.id || req.query.id_pengeluaran || req.body?.id_pengeluaran;
    if (!id) {
      return res.status(400).json({ success: false, message: 'ID Pengeluaran tidak valid' });
    }
    await db.query('DELETE FROM pembayaran_reimbursement WHERE id_pengeluaran = ?', [id]);
    await db.query('DELETE FROM pengeluaran WHERE id_pengeluaran = ?', [id]);

    return res.json({
      success: true,
      message: 'Pengeluaran berhasil dihapus'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal menghapus pengeluaran',
      error: error.message
    });
  }
}

// 6. Data Kas & Dana Kantor (Tab 2: Pengelolaan Dana Operasional)
async function getDanaKantor(req, res) {
  try {
    const [rows] = await db.query(`
      SELECT 
        dk.*,
        pj.nama AS nama_penanggung_jawab,
        pj.kode_karyawan AS kode_pj,
        pk.nama_pekerjaan
      FROM dana_kantor dk
      LEFT JOIN karyawan pj ON dk.id_penanggung_jawab = pj.id_karyawan
      LEFT JOIN pekerjaan pk ON dk.id_pekerjaan = pk.id_pekerjaan
      ORDER BY dk.tanggal DESC, dk.id_dana DESC
    `);

    // Hitung terpakai dan sisa secara akurat untuk setiap baris transaksi
    const enriched = await Promise.all(rows.map(async (row) => {
      let terpakai = 0;
      let terpakaiMenunggu = 0;
      let dikembalikan = 0;

      if (row.jenis_transaksi === 'penyaluran_dana') {
        const [usedRows] = await db.query(`
          SELECT 
            COALESCE(SUM(CASE WHEN status_verifikasi = 'disetujui' THEN nominal ELSE 0 END), 0) AS total_disetujui,
            COALESCE(SUM(CASE WHEN status_verifikasi = 'menunggu' THEN nominal ELSE 0 END), 0) AS total_menunggu
          FROM pengeluaran
          WHERE jenis_dana = 'kantor' AND (id_dana = ? OR (id_dana IS NULL AND id_penanggung_jawab = ?))
        `, [row.id_dana, row.id_penanggung_jawab]);

        const [retRows] = await db.query(`
          SELECT COALESCE(SUM(nominal), 0) AS total_kembali
          FROM pengembalian_dana
          WHERE status_verifikasi = 'disetujui' AND (id_dana = ? OR (id_dana IS NULL AND id_penanggung_jawab = ?))
        `, [row.id_dana, row.id_penanggung_jawab]);

        terpakai = Number(usedRows[0]?.total_disetujui || 0);
        terpakaiMenunggu = Number(usedRows[0]?.total_menunggu || 0);
        dikembalikan = Number(retRows[0]?.total_kembali || 0);
      }

      const nominalNum = Number(row.nominal || 0);
      const sisa = row.jenis_transaksi === 'pemasukan_kas' ? nominalNum : Math.max(0, nominalNum - terpakai - dikembalikan);

      return {
        ...row,
        nominal: nominalNum,
        nominal_masuk: nominalNum,
        terpakai,
        total_terpakai: terpakai,
        total_terpakai_disetujui: terpakai,
        total_terpakai_menunggu: terpakaiMenunggu,
        dikembalikan,
        total_dikembalikan: dikembalikan,
        sisa_dana: sisa,
        sisa_resmi: sisa,
        saldo_sisa: sisa,
        id_kas: row.id_dana,
        id_karyawan: row.id_penanggung_jawab
      };
    }));

    return res.json({
      success: true,
      data: enriched
    });
  } catch (error) {
    console.error('Error getDanaKantor:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal memuat dana kantor',
      error: error.message
    });
  }
}

// 6b. Ambil Daftar Kas Kantor & Summary Kas (Untuk PemasukanKasAdmin.jsx & api.js)
async function getKasList(req, res) {
  try {
    const { id_pekerjaan, id_karyawan, status_lpj } = req.query;

    const [danaRows] = await db.query(`
      SELECT 
        dk.id_dana AS id_kas,
        dk.id_dana,
        dk.nomor_transaksi,
        dk.tanggal,
        dk.jenis_transaksi,
        dk.sumber_dana,
        dk.pemberi_dana,
        dk.penerima_dana,
        dk.nominal AS nominal_masuk,
        dk.nominal,
        dk.id_penanggung_jawab AS id_karyawan,
        dk.id_penanggung_jawab,
        dk.id_pekerjaan,
        dk.keterangan,
        dk.tujuan_penggunaan,
        dk.bukti_transaksi,
        pj.nama AS nama_penanggung_jawab,
        pj.kode_karyawan AS kode_pj,
        pj.jabatan AS jabatan_penanggung_jawab,
        pk.nama_pekerjaan,
        pk.lokasi AS lokasi_pekerjaan,
        'disetujui' AS status_verifikasi
      FROM dana_kantor dk
      LEFT JOIN karyawan pj ON dk.id_penanggung_jawab = pj.id_karyawan
      LEFT JOIN pekerjaan pk ON dk.id_pekerjaan = pk.id_pekerjaan
      ORDER BY dk.tanggal DESC, dk.id_dana DESC
    `);

    const [pRows] = await db.query(`
      SELECT 
        id_dana,
        id_penanggung_jawab,
        id_karyawan,
        jenis_dana,
        nominal,
        status_verifikasi
      FROM pengeluaran
      WHERE jenis_dana = 'kantor'
    `);

    const [retRows] = await db.query(`
      SELECT 
        pd.*,
        k.nama AS nama_penyetor,
        pj.nama AS nama_penanggung_jawab,
        dk.keterangan AS keterangan_kas,
        pk.nama_pekerjaan
      FROM pengembalian_dana pd
      LEFT JOIN karyawan k ON pd.id_karyawan = k.id_karyawan
      LEFT JOIN karyawan pj ON pd.id_penanggung_jawab = pj.id_karyawan
      LEFT JOIN dana_kantor dk ON pd.id_dana = dk.id_dana
      LEFT JOIN pekerjaan pk ON dk.id_pekerjaan = pk.id_pekerjaan
      ORDER BY pd.tanggal DESC, pd.id_pengembalian DESC
    `);

    let totalKasMasuk = 0;
    let totalPenyaluran = 0;
    let totalTerpakaiDisetujui = 0;
    let totalTerpakaiMenunggu = 0;
    let totalDikembalikan = 0;

    const daftar = [];

    for (const dk of danaRows) {
      const masuk = Number(dk.nominal_masuk || 0);
      if (dk.jenis_transaksi === 'pemasukan_kas') {
        totalKasMasuk += masuk;
      } else {
        totalPenyaluran += masuk;
      }

      const linkedNotes = pRows.filter(p => 
        (p.id_dana && Number(p.id_dana) === Number(dk.id_dana)) ||
        (!p.id_dana && dk.id_penanggung_jawab && Number(p.id_penanggung_jawab) === Number(dk.id_penanggung_jawab))
      );

      const terpakaiDisetujui = linkedNotes
        .filter(p => p.status_verifikasi === 'disetujui')
        .reduce((sum, p) => sum + Number(p.nominal || 0), 0);

      const terpakaiMenunggu = linkedNotes
        .filter(p => p.status_verifikasi === 'menunggu')
        .reduce((sum, p) => sum + Number(p.nominal || 0), 0);

      const linkedReturns = retRows.filter(r => 
        (r.id_dana && Number(r.id_dana) === Number(dk.id_dana)) ||
        (!r.id_dana && dk.id_penanggung_jawab && Number(r.id_penanggung_jawab) === Number(dk.id_penanggung_jawab))
      );

      const kembaliDisetujui = linkedReturns
        .filter(r => (r.status_verifikasi || r.status_konfirmasi) === 'disetujui' || (r.status_verifikasi || r.status_konfirmasi) === 'diterima')
        .reduce((sum, r) => sum + Number(r.nominal || 0), 0);

      const sisaResmi = dk.jenis_transaksi === 'pemasukan_kas' 
        ? masuk 
        : Math.max(0, masuk - terpakaiDisetujui - kembaliDisetujui);

      const sisaTersedia = dk.jenis_transaksi === 'pemasukan_kas'
        ? masuk
        : Math.max(0, masuk - terpakaiDisetujui - terpakaiMenunggu - kembaliDisetujui);

      const statusLpjCurrent = (dk.jenis_transaksi === 'penyaluran_dana' && sisaResmi <= 0 && terpakaiMenunggu === 0) 
        ? 'selesai' 
        : 'berjalan';

      const item = {
        ...dk,
        nominal_masuk: masuk,
        total_terpakai_disetujui: terpakaiDisetujui,
        total_terpakai_menunggu: terpakaiMenunggu,
        total_dikembalikan: kembaliDisetujui,
        sisa_resmi: sisaResmi,
        sisa_tersedia: sisaTersedia,
        sisa_dana: sisaResmi,
        terpakai: terpakaiDisetujui,
        status_lpj: statusLpjCurrent,
        status_verifikasi: 'disetujui'
      };

      if (id_pekerjaan && Number(dk.id_pekerjaan) !== Number(id_pekerjaan)) continue;
      if (id_karyawan && Number(dk.id_penanggung_jawab) !== Number(id_karyawan)) continue;
      if (status_lpj && statusLpjCurrent !== status_lpj) continue;

      daftar.push(item);

      if (dk.jenis_transaksi === 'penyaluran_dana') {
        totalTerpakaiDisetujui += terpakaiDisetujui;
        totalTerpakaiMenunggu += terpakaiMenunggu;
        totalDikembalikan += kembaliDisetujui;
      }
    }

    const totalSisaTanggungan = Math.max(0, totalPenyaluran - totalTerpakaiDisetujui - totalDikembalikan);

    return res.json({
      success: true,
      message: 'Data kas list berhasil dimuat',
      data: {
        daftar,
        pengembalian: retRows,
        summary: {
          total_kas_masuk: totalKasMasuk || totalPenyaluran,
          total_pemasukan_perusahaan: totalKasMasuk,
          total_dana_disalurkan: totalPenyaluran,
          total_terpakai_disetujui: totalTerpakaiDisetujui,
          total_terpakai_menunggu: totalTerpakaiMenunggu,
          total_sisa_dikembalikan: totalDikembalikan,
          total_sisa_tanggungan: totalSisaTanggungan,
          menunggu_konfirmasi_kembali: retRows.filter(r => (r.status_verifikasi || r.status_konfirmasi) === 'menunggu').length,
          menunggu_verifikasi_kas: 0
        }
      }
    });
  } catch (error) {
    console.error('Error getKasList:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

// 6b. Ambil Dana Kantor Tersedia (Untuk dropdown Form Modal Pengeluaran Karyawan)
async function getDanaTersedia(req, res) {
  try {
    const kId = req.query.id_karyawan ? parseInt(req.query.id_karyawan, 10) : (req.user?.id_karyawan || null);

    const [danaRows] = await db.query(`
      SELECT 
        dk.id_dana AS id_kas,
        dk.id_dana,
        dk.nomor_transaksi,
        dk.tanggal,
        dk.nominal AS nominal_masuk,
        dk.nominal,
        dk.id_penanggung_jawab AS id_karyawan,
        dk.id_pekerjaan,
        dk.keterangan,
        dk.tujuan_penggunaan,
        pj.nama AS nama_penanggung_jawab,
        pj.kode_karyawan AS kode_pj,
        pj.jabatan AS jabatan_penanggung_jawab,
        pk.nama_pekerjaan,
        'berjalan' AS status_lpj,
        'disetujui' AS status_verifikasi
      FROM dana_kantor dk
      LEFT JOIN karyawan pj ON dk.id_penanggung_jawab = pj.id_karyawan
      LEFT JOIN pekerjaan pk ON dk.id_pekerjaan = pk.id_pekerjaan
      WHERE dk.jenis_transaksi = 'penyaluran_dana'
      ORDER BY dk.tanggal DESC, dk.id_dana DESC
    `);

    const daftarKas = [];
    const kasSaya = [];

    for (const d of danaRows) {
      const [usedRows] = await db.query(`
        SELECT COALESCE(SUM(nominal), 0) AS total_pakai
        FROM pengeluaran
        WHERE id_dana = ? AND status_verifikasi = 'disetujui'
      `, [d.id_dana]);
      const [kembaliRows] = await db.query(`
        SELECT COALESCE(SUM(nominal), 0) AS total_kembali
        FROM pengembalian_dana
        WHERE id_dana = ? AND status_verifikasi = 'disetujui'
      `, [d.id_dana]);

      const totalPakai = Number(usedRows[0]?.total_pakai || 0);
      const totalKembali = Number(kembaliRows[0]?.total_kembali || 0);
      const sisaSaldo = Math.max(0, Number(d.nominal) - totalPakai - totalKembali);

      const kasItem = {
        ...d,
        total_pengeluaran: totalPakai,
        total_pengembalian: totalKembali,
        sisa_saldo: sisaSaldo,
        saldo_sisa: sisaSaldo
      };

      daftarKas.push(kasItem);
      if (kId && Number(d.id_karyawan) === Number(kId)) {
        kasSaya.push(kasItem);
      }
    }

    let pengembalianSaya = [];
    if (kId) {
      const [retRows] = await db.query(`
        SELECT 
          pd.*,
          dk.keterangan AS keterangan_kas,
          pk.nama_pekerjaan
        FROM pengembalian_dana pd
        LEFT JOIN dana_kantor dk ON pd.id_dana = dk.id_dana
        LEFT JOIN pekerjaan pk ON dk.id_pekerjaan = pk.id_pekerjaan
        WHERE pd.id_penanggung_jawab = ? OR pd.id_karyawan = ?
        ORDER BY pd.tanggal DESC, pd.id_pengembalian DESC
      `, [kId, kId]);
      pengembalianSaya = retRows;
    }

    return res.json({
      success: true,
      message: 'Data dana tersedia berhasil dimuat',
      data: {
        daftar_kas: daftarKas,
        kas_tanggung_jawab_saya: kasSaya,
        pengembalian_saya: pengembalianSaya
      }
    });
  } catch (error) {
    console.error('Error getDanaTersedia:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

// 7. Tambah Dana Kantor Baru (Pemasukan Kas atau Penyaluran Dana ke Pekerja)
async function tambahDanaKantor(req, res) {
  try {
    const {
      jenis_transaksi = 'pemasukan_kas',
      tanggal,
      nominal,
      sumber_dana = 'Kas Perusahaan',
      pemberi_dana = 'Finance / Bendahara',
      penerima_dana = '',
      id_penanggung_jawab = null,
      id_pekerjaan = null,
      keterangan = '',
      tujuan_penggunaan = '',
      bukti_transaksi = ''
    } = req.body;

    if (!nominal || Number(nominal) <= 0) {
      return res.status(400).json({ success: false, message: 'Nominal wajib diisi dengan angka positif' });
    }

    const tgl = tanggal || new Date().toISOString().slice(0, 10);
    const prefix = jenis_transaksi === 'pemasukan_kas' ? 'KAS-IN-' : 'DYN-OUT-';
    const noTrans = req.body.nomor_transaksi || `${prefix}${Date.now().toString().slice(-6)}`;

    const fotoSaved = saveBase64Image(bukti_transaksi, 'dana_kantor', 'dana_');

    const [result] = await db.query(
      `INSERT INTO dana_kantor
        (nomor_transaksi, jenis_transaksi, tanggal, sumber_dana, pemberi_dana, penerima_dana, id_penanggung_jawab, id_pekerjaan, nominal, keterangan, tujuan_penggunaan, bukti_transaksi)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        noTrans, jenis_transaksi, tgl, sumber_dana, pemberi_dana, penerima_dana,
        id_penanggung_jawab || null, id_pekerjaan || null, Number(nominal),
        keterangan || '', tujuan_penggunaan || '', fotoSaved || null
      ]
    );

    return res.status(201).json({
      success: true,
      message: jenis_transaksi === 'pemasukan_kas' ? 'Pemasukan kas kantor berhasil dicatat!' : 'Penyaluran dana ke pekerja berhasil dicatat!',
      data: { id_dana: result.insertId, nomor_transaksi: noTrans }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal mencatat dana kantor: ' + error.message,
      error: error.message
    });
  }
}

// 8. Hapus Transaksi Dana Kantor
async function deleteDanaKantor(req, res) {
  try {
    const id = req.params.id || req.query.id_dana || req.body?.id_dana;
    if (!id) return res.status(400).json({ success: false, message: 'ID Dana tidak valid' });

    await db.query('DELETE FROM dana_kantor WHERE id_dana = ?', [id]);
    return res.json({ success: true, message: 'Transaksi dana kantor berhasil dihapus' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

// 9. Daftar Klaim Reimbursement (Uang Pribadi)
async function getReimbursementList(req, res) {
  try {
    const { status_reimbursement, id_karyawan } = req.query;

    let query = `
      SELECT 
        p.*,
        k.nama AS nama_karyawan,
        k.kode_karyawan,
        k.jabatan,
        pk.nama_pekerjaan
      FROM pengeluaran p
      JOIN karyawan k ON p.id_karyawan = k.id_karyawan
      LEFT JOIN pekerjaan pk ON p.id_pekerjaan = pk.id_pekerjaan
      WHERE p.jenis_dana = 'pribadi' AND p.status_verifikasi = 'disetujui'
    `;

    const params = [];

    if (id_karyawan) {
      query += ` AND p.id_karyawan = ? `;
      params.push(id_karyawan);
    }

    if (status_reimbursement && status_reimbursement !== 'semua') {
      query += ` AND p.status_reimbursement = ? `;
      params.push(status_reimbursement);
    }

    query += ` ORDER BY p.tanggal DESC, p.id_pengeluaran DESC `;

    const [rows] = await db.query(query, params);

    return res.json({
      success: true,
      data: rows
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

// 10. Bayar Reimbursement (Admin Melunasi Klaim Uang Pribadi Pekerja)
async function bayarReimbursement(req, res) {
  try {
    const id = req.params.id || req.body.id_pengeluaran || req.query.id_pengeluaran;
    const {
      nominal_bayar,
      metode_pembayaran = 'transfer',
      nomor_referensi = '',
      nama_penerima = '',
      nama_pembayar = req.user?.nama || 'Admin Keuangan',
      bukti_pembayaran = '',
      catatan = ''
    } = req.body;

    if (!id || !nominal_bayar || Number(nominal_bayar) <= 0) {
      return res.status(400).json({ success: false, message: 'ID Pengeluaran dan Nominal Bayar wajib diisi' });
    }

    const [rows] = await db.query('SELECT * FROM pengeluaran WHERE id_pengeluaran = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data pengeluaran tidak ditemukan' });
    }

    const row = rows[0];
    const nominalBayarNum = Number(nominal_bayar);
    const nominalDisetujui = Number(row.nominal_disetujui || row.nominal);
    const totalDibayarLama = Number(row.total_dibayar || 0);
    const totalDibayarBaru = totalDibayarLama + nominalBayarNum;
    const sisaBaru = Math.max(0, nominalDisetujui - totalDibayarBaru);
    const statusReimburseBaru = sisaBaru <= 0 ? 'sudah' : 'sebagian';

    const today = new Date().toISOString().slice(0, 10);
    const fotoSaved = saveBase64Image(bukti_pembayaran, 'bukti_bayar', 'bukti_reimburse_');

    // Catat ke tabel pembayaran_reimbursement
    await db.query(`
      INSERT INTO pembayaran_reimbursement
        (id_pengeluaran, tanggal_bayar, nominal_bayar, metode_pembayaran, nomor_referensi, nama_penerima, nama_pembayar, bukti_pembayaran, catatan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, today, nominalBayarNum, metode_pembayaran, nomor_referensi, nama_penerima, nama_pembayar, fotoSaved || null, catatan]);

    // Update pengeluaran
    await db.query(`
      UPDATE pengeluaran SET
        total_dibayar = ?,
        sisa_pembayaran = ?,
        status_reimbursement = ?,
        status_ganti = CASE WHEN ? = 'sudah' THEN 'sudah' ELSE 'sebagian' END
      WHERE id_pengeluaran = ?
    `, [totalDibayarBaru, sisaBaru, statusReimburseBaru, statusReimburseBaru, id]);

    return res.json({
      success: true,
      message: `Pembayaran reimbursement sebesar Rp ${nominalBayarNum.toLocaleString('id-ID')} berhasil dicatat! Status: ${statusReimburseBaru === 'sudah' ? 'Lunas' : 'Sebagian'}`
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal memproses pembayaran reimbursement: ' + error.message,
      error: error.message
    });
  }
}

// 11. Riwayat Pembayaran Reimbursement Tertentu
async function getRiwayatBayarReimbursement(req, res) {
  try {
    const id = req.params.id || req.query.id_pengeluaran;
    const [rows] = await db.query(
      'SELECT * FROM pembayaran_reimbursement WHERE id_pengeluaran = ? ORDER BY id_pembayaran_reimburse DESC',
      [id]
    );
    return res.json({ success: true, data: rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

// 12. Daftar Pengembalian Dana Kantor oleh Pekerja
async function getPengembalianDana(req, res) {
  try {
    const [rows] = await db.query(`
      SELECT 
        pd.*,
        k.nama AS nama_karyawan,
        k.kode_karyawan,
        pj.nama AS nama_penanggung_jawab
      FROM pengembalian_dana pd
      LEFT JOIN karyawan k ON pd.id_karyawan = k.id_karyawan
      LEFT JOIN karyawan pj ON pd.id_penanggung_jawab = pj.id_karyawan
      ORDER BY pd.tanggal DESC, pd.id_pengembalian DESC
    `);
    return res.json({ success: true, data: rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

// 13. Tambah Pengembalian Dana Kantor
async function tambahPengembalianDana(req, res) {
  try {
    const {
      id_karyawan,
      id_dana = null,
      id_penanggung_jawab = null,
      tanggal,
      nominal,
      penerima_pengembalian = 'Finance / Bendahara',
      keterangan = '',
      bukti_pengembalian = '',
      status_verifikasi = 'menunggu'
    } = req.body;

    const workerId = id_karyawan || req.user?.id_karyawan;
    if (!workerId || !nominal) {
      return res.status(400).json({ success: false, message: 'Karyawan dan Nominal wajib diisi' });
    }

    const tgl = tanggal || new Date().toISOString().slice(0, 10);
    const [countRows] = await db.query('SELECT COUNT(*) AS total FROM pengembalian_dana');
    const noTrans = `RET-${String((countRows[0].total || 0) + 1).padStart(4, '0')}`;
    const fotoSaved = saveBase64Image(bukti_pengembalian, 'pengembalian', 'kembali_');

    const [result] = await db.query(
      `INSERT INTO pengembalian_dana
        (nomor_transaksi, id_dana, id_karyawan, id_penanggung_jawab, tanggal, nominal, penerima_pengembalian, keterangan, bukti_pengembalian, status_verifikasi)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        noTrans, id_dana || null, workerId, id_penanggung_jawab || null,
        tgl, Number(nominal), penerima_pengembalian, keterangan, fotoSaved || null, status_verifikasi
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Pengembalian sisa uang kantor berhasil dicatat!',
      data: { id_pengembalian: result.insertId, nomor_transaksi: noTrans }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

// 14. Verifikasi Pengembalian Dana
async function verifikasiPengembalianDana(req, res) {
  try {
    const id = req.params.id || req.body.id_pengembalian || req.query.id_pengembalian;
    const { status_verifikasi, catatan = '' } = req.body;

    await db.query(
      'UPDATE pengembalian_dana SET status_verifikasi = ?, catatan = ? WHERE id_pengembalian = ?',
      [status_verifikasi, catatan, id]
    );

    return res.json({
      success: true,
      message: `Pengembalian dana ${status_verifikasi === 'disetujui' ? 'disetujui' : 'ditolak'}`
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

// 15. Hapus Pengembalian Dana
async function deletePengembalianDana(req, res) {
  try {
    const id = req.params.id || req.query.id_pengembalian || req.body?.id_pengembalian;
    await db.query('DELETE FROM pengembalian_dana WHERE id_pengembalian = ?', [id]);
    return res.json({ success: true, message: 'Data pengembalian dana berhasil dihapus' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

// 16. Rekap Uang Kantor per Penanggung Jawab
async function getRekapUangKantor(req, res) {
  try {
    const [pjList] = await db.query(`
      SELECT id_karyawan, kode_karyawan, nama, jabatan
      FROM karyawan
      WHERE status = 'aktif'
      ORDER BY id_karyawan DESC
    `);

    const result = [];
    let totalGlobalDiterima = 0;
    let totalGlobalDipakai = 0;
    let totalGlobalDikembalikan = 0;
    for (const k of pjList) {
      const [dk] = await db.query(
        'SELECT COALESCE(SUM(nominal), 0) AS total_diterima FROM dana_kantor WHERE id_penanggung_jawab = ?',
        [k.id_karyawan]
      );
      const [pg] = await db.query(
        'SELECT COALESCE(SUM(nominal), 0) AS total_dipakai FROM pengeluaran WHERE jenis_dana = "kantor" AND status_verifikasi = "disetujui" AND (id_penanggung_jawab = ? OR id_karyawan = ?)',
        [k.id_karyawan, k.id_karyawan]
      );
      const [ret] = await db.query(
        'SELECT COALESCE(SUM(nominal), 0) AS total_dikembalikan FROM pengembalian_dana WHERE status_verifikasi = "disetujui" AND (id_penanggung_jawab = ? OR id_karyawan = ?)',
        [k.id_karyawan, k.id_karyawan]
      );

      const diterima = Number(dk[0]?.total_diterima || 0);
      const dipakai = Number(pg[0]?.total_dipakai || 0);
      const dikembalikan = Number(ret[0]?.total_dikembalikan || 0);
      const sisa = Math.max(0, diterima - dipakai - dikembalikan);

      if (diterima > 0 || dipakai > 0 || dikembalikan > 0) {
        totalGlobalDiterima += diterima;
        totalGlobalDipakai += dipakai;
        totalGlobalDikembalikan += dikembalikan;

        result.push({
          penanggung_jawab: {
            id_karyawan: k.id_karyawan,
            nama: k.nama,
            kode_karyawan: k.kode_karyawan,
            jabatan: k.jabatan
          },
          id_karyawan: k.id_karyawan,
          nama: k.nama,
          kode_karyawan: k.kode_karyawan,
          jabatan: k.jabatan,
          total_dana_diterima: diterima,
          total_pengeluaran: dipakai,
          total_pengeluaran_kantor: dipakai,
          total_pengembalian: dikembalikan,
          saldo_dipegang: sisa,
          sisa_dana_dipegang: sisa
        });
      }
    }

    const totalGlobalSaldo = Math.max(0, totalGlobalDiterima - totalGlobalDipakai - totalGlobalDikembalikan);

    return res.json({
      success: true,
      message: 'Rekapitulasi uang kantor berhasil dimuat',
      data: {
        ringkasan_global: {
          total_dana_diterima: totalGlobalDiterima,
          total_pengeluaran: totalGlobalDipakai,
          total_pengembalian: totalGlobalDikembalikan,
          saldo_dipegang: totalGlobalSaldo
        },
        rekap_per_pj: result
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function updateDanaKantor(req, res) {
  try {
    const id = Number(req.params.id || req.body?.id_dana || req.body?.id_kas);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, message: 'ID dana tidak valid.' });
    const { tanggal, sumber_dana, pemberi_dana, penerima_dana, id_penanggung_jawab, id_pekerjaan, nominal, keterangan, tujuan_penggunaan, bukti_transaksi } = req.body;
    const [result] = await db.query(`
      UPDATE dana_kantor SET
        tanggal = COALESCE(?, tanggal),
        sumber_dana = COALESCE(?, sumber_dana),
        pemberi_dana = COALESCE(?, pemberi_dana),
        penerima_dana = COALESCE(?, penerima_dana),
        id_penanggung_jawab = COALESCE(?, id_penanggung_jawab),
        id_pekerjaan = COALESCE(?, id_pekerjaan),
        nominal = COALESCE(?, nominal),
        keterangan = COALESCE(?, keterangan),
        tujuan_penggunaan = COALESCE(?, tujuan_penggunaan),
        bukti_transaksi = COALESCE(?, bukti_transaksi)
      WHERE id_dana = ?
    `, [tanggal || null, sumber_dana || null, pemberi_dana || null, penerima_dana || null,
      id_penanggung_jawab || null, id_pekerjaan || null,
      nominal !== undefined && nominal !== '' ? Number(nominal) : null,
      keterangan ?? null, tujuan_penggunaan ?? null, bukti_transaksi || null, id]);
    if (!result.affectedRows) return res.status(404).json({ success: false, message: 'Transaksi dana tidak ditemukan.' });
    return res.json({ success: true, message: 'Transaksi dana berhasil diperbarui.', data: { id_dana: id, id_kas: id } });
  } catch (error) {
    console.error('Error updateDanaKantor:', error);
    return res.status(500).json({ success: false, message: 'Gagal memperbarui transaksi dana.' });
  }
}

module.exports = {
  getAllPengeluaran,
  getSummary,
  createPengeluaran,
  updatePengeluaran,
  verifikasiPengeluaran,
  deletePengeluaran,
  getDanaKantor,
  getDanaTersedia,
  getKasList,
  tambahDanaKantor,
  deleteDanaKantor,
  updateDanaKantor,
  getReimbursementList,
  bayarReimbursement,
  getRiwayatBayarReimbursement,
  getPengembalianDana,
  tambahPengembalianDana,
  verifikasiPengembalianDana,
  deletePengembalianDana,
  getRekapUangKantor
};
