-- ==============================================================================
-- FASE 1: MIGRATION FOUNDATION - PROJECT ROLE BLUEPRINT & MULTI-UNIT PAYROLL
-- Database: db_pencatatan_kerja (MySQL 8.0)
-- Sifat: Aditif & 100% Backward-Compatible (Tidak merusak data operasional lama)
-- ==============================================================================

-- 1. TABEL: master_role (Master Jabatan & Hierarki Tingkat Perusahaan)
CREATE TABLE IF NOT EXISTS `master_role` (
  `id_role` INT AUTO_INCREMENT PRIMARY KEY,
  `nama_role` VARCHAR(100) NOT NULL UNIQUE,
  `hierarchy_level` INT NOT NULL,
  `default_gaji_min_bulanan` DECIMAL(15,2) NOT NULL,
  `default_gaji_max_bulanan` DECIMAL(15,2) NOT NULL,
  `deskripsi` TEXT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_hierarchy_active` (`hierarchy_level`, `is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. TABEL: pekerjaan_role_budget (Blueprint Kuota & Rentang Gaji per Role per Proyek)
CREATE TABLE IF NOT EXISTS `pekerjaan_role_budget` (
  `id_role_budget` INT AUTO_INCREMENT PRIMARY KEY,
  `id_pekerjaan` INT NOT NULL,
  `id_role` INT NOT NULL,
  `kuota_slot` INT NOT NULL DEFAULT 1,
  `gaji_min_bulanan` DECIMAL(15,2) NOT NULL,
  `gaji_max_bulanan` DECIMAL(15,2) NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_pekerjaan_role` (`id_pekerjaan`, `id_role`),
  CONSTRAINT `fk_prb_pekerjaan` FOREIGN KEY (`id_pekerjaan`) REFERENCES `pekerjaan` (`id_pekerjaan`) ON DELETE CASCADE,
  CONSTRAINT `fk_prb_role` FOREIGN KEY (`id_role`) REFERENCES `master_role` (`id_role`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. TABEL: penugasan_gaji_riwayat (Versioning Skema & Nominal Gaji per Penugasan)
CREATE TABLE IF NOT EXISTS `penugasan_gaji_riwayat` (
  `id_riwayat_gaji` INT AUTO_INCREMENT PRIMARY KEY,
  `id_penugasan` INT NOT NULL,
  `jenis_upah` ENUM('per_jam','per_hari','per_bulan','per_tahun') NOT NULL,
  `nominal_upah` DECIMAL(15,2) NOT NULL,
  `normalized_monthly` DECIMAL(15,2) NOT NULL,
  `effective_from` DATE NOT NULL,
  `effective_to` DATE NULL,
  `catatan` VARCHAR(255) NULL,
  `created_by` INT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_penugasan_effective` (`id_penugasan`, `effective_from`, `effective_to`),
  CONSTRAINT `fk_pgr_penugasan` FOREIGN KEY (`id_penugasan`) REFERENCES `penugasan` (`id_penugasan`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
