-- Jalankan pada database yang dikonfigurasi di backend/.env (DB_NAME)
-- untuk memasang tabel yang dibutuhkan endpoint /api/master-role.
CREATE TABLE IF NOT EXISTS `master_role` (
  `id_role` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `nama_role` VARCHAR(150) NOT NULL,
  `hierarchy_level` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `default_gaji_min_bulanan` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `default_gaji_max_bulanan` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `deskripsi` TEXT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id_role`),
  UNIQUE KEY `uq_master_role_nama` (`nama_role`),
  KEY `idx_master_role_hierarchy_active` (`hierarchy_level`, `is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
