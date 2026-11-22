# Backend Express

Backend ini menjadi API runtime aplikasi. Frontend mengaksesnya lewat `/api` dan `/uploads`, yang diproxy Vite ke `http://localhost:5000`. Server tidak memuat atau meneruskan request ke folder PHP `api/`.

## Menjalankan lokal

1. Nyalakan MySQL di Laragon dan pastikan database aplikasi tersedia.
2. Salin `.env.example` menjadi `.env`, lalu sesuaikan `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, dan `DB_NAME` dengan database yang berisi data aplikasi. `.env.example` memakai `db_jam_kerja` untuk instalasi baru; untuk database lama, pertahankan nama database yang memang berisi data Anda.
3. Pastikan `JWT_SECRET` di `.env` diganti dengan rahasia acak minimal 32 karakter.
4. Dari folder `backend`, jalankan `npm install`, lalu `npm run dev`.
5. Pastikan `http://localhost:5000/api/health` mengembalikan `status: success`, lalu jalankan frontend seperti biasa.
6. Setelah migrasi runtime, akun admin yang sudah ada dapat ditingkatkan menjadi super admin secara lokal dengan `npm run admin:promote-super -- admin@example.com`. Ganti alamat tersebut dengan email admin yang akan ditingkatkan. Kata sandi akun tidak berubah.

## Skema database

`database/database.sql` adalah bootstrap untuk database baru yang masih kosong; skrip ini membuat tabel dan mengisi contoh data. Jangan jalankan di database yang sudah berisi data. Untuk database lama, atur `DB_NAME` di `.env`, lalu jalankan `npm run db:sync-runtime`. Perintah ini menerapkan kolom runtime yang belum ada secara idempoten pada database terpilih.

Untuk setup baru, gunakan `DB_NAME=db_jam_kerja`, impor `database/database.sql`, lalu jalankan `npm run db:sync-runtime`. Script penyelarasan menerjemahkan definisi migrasi ke perubahan tambahan yang sesuai dengan versi MySQL lokal.

Role aplikasi adalah `super_admin`, `admin`, dan `karyawan`. `super_admin` serta `admin` memiliki akses administrator; hanya karyawan yang dibatasi ke data miliknya. Pendaftaran publik hanya membuat akun karyawan.

`database/pencatatan_kerja.sql` dan `database/database-gaji.sql` adalah skema alternatif dari versi lama; jangan jalankan bersama bootstrap utama.

Folder `uploads/` menyimpan foto yang dilayani Express. Isinya tidak masuk Git; salin berkas upload lama ke folder ini sekali saat migrasi data.
