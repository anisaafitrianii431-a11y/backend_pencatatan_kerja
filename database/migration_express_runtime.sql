-- Tambahan skema yang sebelumnya dibuat otomatis oleh backend PHP.
-- Jalankan pada database aplikasi setelah backup; semua ADD COLUMN dibuat idempoten.

ALTER TABLE karyawan
  ADD COLUMN IF NOT EXISTS kode_karyawan VARCHAR(30) NULL,
  ADD COLUMN IF NOT EXISTS nomor_hp VARCHAR(30) NULL,
  ADD COLUMN IF NOT EXISTS no_hp VARCHAR(30) NULL,
  ADD COLUMN IF NOT EXISTS email VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS alamat TEXT NULL,
  ADD COLUMN IF NOT EXISTS foto_profil VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS kontak_darurat VARCHAR(120) NULL,
  ADD COLUMN IF NOT EXISTS nama_bank VARCHAR(60) NULL,
  ADD COLUMN IF NOT EXISTS no_rekening VARCHAR(60) NULL,
  ADD COLUMN IF NOT EXISTS status ENUM('aktif','nonaktif') NOT NULL DEFAULT 'aktif',
  ADD COLUMN IF NOT EXISTS jenis_upah ENUM('per_jam','per_hari','per_bulan') NOT NULL DEFAULT 'per_jam',
  ADD COLUMN IF NOT EXISTS nominal_upah DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lembur_aktif TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tarif_lembur DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS catatan_admin TEXT NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

ALTER TABLE `user`
  ADD COLUMN IF NOT EXISTS kode_user VARCHAR(30) NULL,
  ADD COLUMN IF NOT EXISTS username VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE `user`
  MODIFY COLUMN peran ENUM('super_admin','admin','karyawan') NOT NULL DEFAULT 'karyawan';

ALTER TABLE pekerjaan
  ADD COLUMN IF NOT EXISTS metode_lokasi ENUM('titik','wfh') NOT NULL DEFAULT 'titik',
  ADD COLUMN IF NOT EXISTS metode_penentuan ENUM('langsung','terbuka','gabungan') NOT NULL DEFAULT 'terbuka',
  ADD COLUMN IF NOT EXISTS jenis_upah ENUM('per_jam','per_hari','per_bulan') NOT NULL DEFAULT 'per_jam',
  ADD COLUMN IF NOT EXISTS nominal_upah DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS titik_lokasi VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS latitude DECIMAL(10,7) NULL,
  ADD COLUMN IF NOT EXISTS longitude DECIMAL(10,7) NULL,
  ADD COLUMN IF NOT EXISTS radius_meter INT NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS kuota_pekerja INT NULL,
  ADD COLUMN IF NOT EXISTS status_pengambilan ENUM('terbuka','ditutup') NOT NULL DEFAULT 'terbuka';
ALTER TABLE pekerjaan
  MODIFY COLUMN metode_penentuan ENUM('langsung','terbuka','gabungan') NOT NULL DEFAULT 'terbuka';

ALTER TABLE penugasan
  ADD COLUMN IF NOT EXISTS peran_tugas VARCHAR(100) DEFAULT 'Anggota Tim Pelaksana',
  ADD COLUMN IF NOT EXISTS jenis_penugasan ENUM('admin','mandiri') NOT NULL DEFAULT 'admin',
  ADD COLUMN IF NOT EXISTS status_baca ENUM('belum','sudah') NOT NULL DEFAULT 'belum',
  ADD COLUMN IF NOT EXISTS status_karyawan ENUM('belum_hadir','sedang_bekerja','selesai_bertugas','tidak_hadir','meninggalkan_pekerjaan') NOT NULL DEFAULT 'belum_hadir',
  ADD COLUMN IF NOT EXISTS status_penugasan ENUM('aktif','dibatalkan') NOT NULL DEFAULT 'aktif',
  ADD COLUMN IF NOT EXISTS catatan_admin VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS status_konfirmasi_admin TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS alasan_batal VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS dibatalkan_pada DATETIME NULL,
  ADD COLUMN IF NOT EXISTS dibatalkan_oleh VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE absensi
  ADD COLUMN IF NOT EXISTS foto_lokasi VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS foto_masuk VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS foto_pulang VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS masuk_latitude DECIMAL(10,7) NULL,
  ADD COLUMN IF NOT EXISTS masuk_longitude DECIMAL(10,7) NULL,
  ADD COLUMN IF NOT EXISTS masuk_alamat TEXT NULL,
  ADD COLUMN IF NOT EXISTS pulang_latitude DECIMAL(10,7) NULL,
  ADD COLUMN IF NOT EXISTS pulang_longitude DECIMAL(10,7) NULL,
  ADD COLUMN IF NOT EXISTS pulang_alamat TEXT NULL,
  ADD COLUMN IF NOT EXISTS titik_pulang VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS jarak_masuk INT NULL,
  ADD COLUMN IF NOT EXISTS jarak_pulang INT NULL,
  ADD COLUMN IF NOT EXISTS jarak_meter INT NULL,
  ADD COLUMN IF NOT EXISTS catatan_admin VARCHAR(255) NULL;

ALTER TABLE pengeluaran
  ADD COLUMN IF NOT EXISTS id_dana INT NULL,
  ADD COLUMN IF NOT EXISTS id_penanggung_jawab INT NULL,
  ADD COLUMN IF NOT EXISTS id_kas INT NULL,
  ADD COLUMN IF NOT EXISTS nomor_transaksi VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS nominal_disetujui DECIMAL(14,2) NULL,
  ADD COLUMN IF NOT EXISTS total_dibayar DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sisa_pembayaran DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS kategori VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS catatan_penolakan TEXT NULL,
  ADD COLUMN IF NOT EXISTS status_reimbursement ENUM('belum','sebagian','lunas') DEFAULT 'belum';
ALTER TABLE pengeluaran
  MODIFY COLUMN status_ganti ENUM('belum','sebagian','sudah') NOT NULL DEFAULT 'belum';

ALTER TABLE gaji
  ADD COLUMN IF NOT EXISTS jenis_upah ENUM('per_jam','per_hari','per_bulan') DEFAULT 'per_jam',
  ADD COLUMN IF NOT EXISTS total_hari INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bonus DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS potongan DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS catatan_penyesuaian TEXT NULL,
  ADD COLUMN IF NOT EXISTS gaji_bersih DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_dibayar DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sisa_pembayaran DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status_penetapan ENUM('draft','ditetapkan') DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS tanggal_ditetapkan DATETIME NULL,
  ADD COLUMN IF NOT EXISTS ditetapkan_oleh VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS metode_bayar VARCHAR(30) DEFAULT 'transfer',
  ADD COLUMN IF NOT EXISTS catatan_bayar VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS bukti_bayar VARCHAR(255) NULL;
ALTER TABLE gaji
  MODIFY COLUMN status_bayar ENUM('belum','sebagian','sudah') NOT NULL DEFAULT 'belum';

CREATE TABLE IF NOT EXISTS laporan_pekerjaan (
  id_laporan INT AUTO_INCREMENT PRIMARY KEY,
  id_pekerjaan INT NOT NULL,
  id_karyawan INT NOT NULL,
  tipe_laporan ENUM('progres','akhir') NOT NULL DEFAULT 'akhir',
  judul VARCHAR(200) NOT NULL,
  keterangan TEXT NOT NULL,
  foto_dokumentasi LONGTEXT NULL,
  status_persetujuan ENUM('menunggu','disetujui','ditolak') NOT NULL DEFAULT 'menunggu',
  catatan_admin TEXT NULL,
  tanggal_laporan DATE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX (id_pekerjaan), INDEX (id_karyawan)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS dana_kantor (
  id_dana INT AUTO_INCREMENT PRIMARY KEY,
  nomor_transaksi VARCHAR(50) NULL,
  jenis_transaksi ENUM('pemasukan_kas','penyaluran_dana') NOT NULL DEFAULT 'penyaluran_dana',
  tanggal DATE NOT NULL,
  sumber_dana VARCHAR(100) NULL DEFAULT 'Kas Perusahaan',
  pemberi_dana VARCHAR(100) NULL,
  penerima_dana VARCHAR(100) NULL,
  id_penanggung_jawab INT NULL,
  id_pekerjaan INT NULL,
  nominal DECIMAL(14,2) NOT NULL DEFAULT 0,
  tujuan_penggunaan TEXT NULL,
  keterangan TEXT NULL,
  bukti_transaksi VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX (id_penanggung_jawab), INDEX (id_pekerjaan)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pengembalian_dana (
  id_pengembalian INT AUTO_INCREMENT PRIMARY KEY,
  nomor_transaksi VARCHAR(50) NULL,
  id_dana INT NULL,
  id_karyawan INT NULL,
  id_penanggung_jawab INT NULL,
  tanggal DATE NOT NULL,
  nominal DECIMAL(14,2) NOT NULL DEFAULT 0,
  penerima_pengembalian VARCHAR(100) NULL,
  keterangan TEXT NULL,
  bukti_pengembalian VARCHAR(255) NULL,
  status_verifikasi ENUM('menunggu','disetujui','ditolak') NOT NULL DEFAULT 'menunggu',
  catatan TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX (id_dana), INDEX (id_karyawan), INDEX (id_penanggung_jawab)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pembayaran_reimbursement (
  id_pembayaran INT AUTO_INCREMENT PRIMARY KEY,
  id_pengeluaran INT NOT NULL,
  tanggal_bayar DATE NOT NULL,
  nominal_bayar DECIMAL(14,2) NOT NULL DEFAULT 0,
  metode_pembayaran VARCHAR(50) DEFAULT 'transfer',
  nomor_referensi VARCHAR(100) NULL,
  nama_penerima VARCHAR(100) NULL,
  nama_pembayar VARCHAR(100) NULL,
  bukti_pembayaran VARCHAR(255) NULL,
  catatan TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX (id_pengeluaran)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pembayaran_gaji (
  id_pembayaran INT AUTO_INCREMENT PRIMARY KEY,
  id_gaji INT NOT NULL,
  tanggal_bayar DATE NOT NULL,
  nominal_bayar DECIMAL(14,2) NOT NULL DEFAULT 0,
  metode_pembayaran VARCHAR(50) DEFAULT 'transfer',
  nomor_referensi VARCHAR(100) NULL,
  nama_penerima VARCHAR(100) NULL,
  nama_pembayar VARCHAR(100) NULL,
  bukti_pembayaran VARCHAR(255) NULL,
  catatan TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX (id_gaji)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_name ENUM('admin','karyawan') NOT NULL,
  resource_key VARCHAR(40) NOT NULL,
  can_create TINYINT(1) NOT NULL DEFAULT 0,
  can_read TINYINT(1) NOT NULL DEFAULT 0,
  can_update TINYINT(1) NOT NULL DEFAULT 0,
  can_delete TINYINT(1) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (role_name, resource_key)
) ENGINE=InnoDB;
