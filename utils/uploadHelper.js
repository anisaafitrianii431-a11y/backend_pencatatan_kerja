const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Menyimpan data gambar (baik base64 data-URI maupun file buffer) ke folder upload lokal
 * @param {string} input - Base64 data URI atau string path lama
 * @param {string} subfolder - Subfolder tujuan: 'absensi', 'kwitansi', 'dana_kantor', 'pengembalian', 'bukti_bayar', 'bukti_gaji'
 * @param {string} prefix - Prefix nama file (misal: 'absensi_masuk_', 'absensi_pulang_')
 * @returns {string} Path relatif yang dapat diakses publik, misal: 'uploads/absensi/absensi_masuk_xxx.jpg'
 */
function saveBase64Image(input, subfolder = 'absensi', prefix = 'img_') {
  if (!input || typeof input !== 'string') return null;

  // Jika sudah berupa path uploads yang valid
  if (input.startsWith('uploads/') || input.startsWith('/uploads/') || input.startsWith('http')) {
    return input.replace(/^\//, '');
  }

  // Cek apakah string adalah base64 data URI
  const match = input.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
  if (!match) {
    // Jika hanya path string biasa yang bukan base64
    return input;
  }

  let ext = match[1].toLowerCase();
  if (ext === 'jpeg') ext = 'jpg';
  if (ext.includes('svg')) ext = 'svg';
  const base64Data = match[2];

  const targetDir = path.join(__dirname, '..', 'uploads', subfolder);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const hash = crypto.randomBytes(16).toString('hex');
  const filename = `${prefix}${hash}.${ext}`;
  const filePath = path.join(targetDir, filename);

  try {
    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
    return `uploads/${subfolder}/${filename}`;
  } catch (err) {
    console.error(`Gagal menyimpan foto base64 ke ${filePath}:`, err);
    return null;
  }
}

module.exports = {
  saveBase64Image
};
