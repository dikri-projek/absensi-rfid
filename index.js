require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Koneksi ke Database Cloud Turso
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Otomatis Buat Tabel jika belum ada di Turso
async function initDatabase() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS siswa (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT UNIQUE NOT NULL,
        nama TEXT NOT NULL,
        kelas TEXT NOT NULL
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS presensi (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT NOT NULL,
        waktu DATETIME DEFAULT CURRENT_TIMESTAMP,
        keterangan TEXT NOT NULL
      );
    `);
    console.log("⚡ Database Turso Cloud Berhasil Terhubung!");
  } catch (err) {
    console.error("❌ Gagal terhubung ke Turso Cloud:", err);
  }
}

initDatabase();

// Logika Penentuan Status Absensi berdasarkan Jam
function dapatkanStatusPresensi() {
  const sekarang = new Date();
  const jam = sekarang.getHours();
  const menit = sekarang.getMinutes();
  const totalMenit = jam * 60 + menit;

  // 05:30 (330 menit) s/d 06:30 (390 menit)
  // 06:31 (391 menit) s/d 08:00 (480 menit)
  if (totalMenit >= 330 && totalMenit <= 390) {
    return "Hadir";
  } else if (totalMenit > 390 && totalMenit <= 480) {
    return "Terlambat";
  } else {
    return "Hadir (Luar Jam Regular)";
  }
}

// ================= API ROUTES =================

// 1. Ambil Data Semua Siswa
app.get('/api/siswa', async (req, res) => {
  try {
    const result = await db.execute("SELECT * FROM siswa ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 2. Tambah Siswa Baru
app.post('/api/siswa', async (req, res) => {
  const { uid, nama, kelas } = req.body;
  if (!uid || !nama || !kelas) {
    return res.status(400).json({ status: 'error', message: 'Data tidak lengkap' });
  }

  try {
    await db.execute({
      sql: "INSERT INTO siswa (uid, nama, kelas) VALUES (?, ?, ?)",
      args: [uid, nama, kelas]
    });
    res.json({ status: 'success', message: 'Siswa berhasil didaftarkan' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 3. Hapus Siswa
app.delete('/api/siswa/:id', async (req, res) => {
  try {
    await db.execute({
      sql: "DELETE FROM siswa WHERE id = ?",
      args: [req.params.id]
    });
    res.json({ status: 'success', message: 'Data siswa berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 4. Endpoint Scan Kartu RFID (Tap Kartu)
app.post('/api/scan', async (req, res) => {
  const { uid } = req.body;
  if (!uid) {
    return res.status(400).json({ status: 'error', message: 'UID Kartu tidak ditemukan' });
  }

  try {
    const siswaResult = await db.execute({
      sql: "SELECT * FROM siswa WHERE uid = ?",
      args: [uid]
    });

    if (siswaResult.rows.length === 0) {
      return res.status(404).json({ 
        status: 'unregistered', 
        message: 'Kartu RFID Belum Terdaftar!',
        uid: uid 
      });
    }

    const siswa = siswaResult.rows[0];
    const keterangan = dapatkanStatusPresensi();

    await db.execute({
      sql: "INSERT INTO presensi (uid, keterangan) VALUES (?, ?)",
      args: [uid, keterangan]
    });

    res.json({
      status: 'success',
      message: 'Absensi Berhasil Recorded',
      siswa: {
        nama: siswa.nama,
        kelas: siswa.kelas,
        uid: siswa.uid,
        keterangan: keterangan
      }
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 5. Ambil Rekap Data Presensi
app.get('/api/presensi', async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT presensi.id, presensi.uid, siswa.nama, siswa.kelas, presensi.waktu, presensi.keterangan
      FROM presensi
      LEFT JOIN siswa ON presensi.uid = siswa.uid
      ORDER BY presensi.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Jalankan Server
app.listen(PORT, () => {
  console.log("===================================================");
  console.log("🚀 Server Sistem Absensi RFID SMANCIK Berjalan!");
  console.log(`📍 URL: http://localhost:${PORT}`);
  console.log("⏱️  Aturan Jam: 05:30-06:30 (Hadir) | 06:31-08:00 (Terlambat)");
  console.log("===================================================");
});