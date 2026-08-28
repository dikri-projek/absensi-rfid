const express = require('express');
const path = require('path');
const { createClient } = require('@libsql/client');

const app = express();

// Parsing JSON dan Form Data
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Inisialisasi Database Turso
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || '',
  authToken: process.env.TURSO_AUTH_TOKEN || '',
});

// Fungsi Memastikan Tabel Database Ada
async function ensureTablesExist() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        nama TEXT,
        role TEXT DEFAULT 'admin'
      );
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS siswa (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nis TEXT UNIQUE,
        nama TEXT,
        kelas TEXT,
        rfid_uid TEXT UNIQUE
      );
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS absensi (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rfid_uid TEXT,
        nama TEXT,
        kelas TEXT,
        waktu DATETIME DEFAULT CURRENT_TIMESTAMP,
        keterangan TEXT DEFAULT 'Hadir'
      );
    `);
  } catch (err) {
    console.error("Gagal inisialisasi tabel:", err);
  }
}

// ---------------- API ENDPOINTS ----------------

// API LOGIN
app.post('/api/login', async (req, res) => {
  try {
    await ensureTablesExist();
    const { username, password } = req.body;
    const result = await db.execute({
      sql: "SELECT * FROM users WHERE username = ? AND password = ?",
      args: [username || '', password || '']
    });

    if (result.rows.length > 0) {
      return res.json({ success: true, message: "Login berhasil!", user: result.rows[0] });
    }
    return res.status(401).json({ success: false, message: "Username atau password salah." });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// API SISWA (GET ALL)
app.get('/api/siswa', async (req, res) => {
  try {
    await ensureTablesExist();
    const result = await db.execute("SELECT * FROM siswa ORDER BY nama ASC");
    return res.json({ success: true, data: result.rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// API SISWA (TAMBAH MANUAL)
app.post('/api/siswa', async (req, res) => {
  try {
    await ensureTablesExist();
    const { nis, nama, kelas, rfid_uid } = req.body;

    if (!nis || !nama || !kelas) {
      return res.status(400).json({ success: false, message: "NIS, Nama, dan Kelas wajib diisi!" });
    }

    await db.execute({
      sql: "INSERT OR REPLACE INTO siswa (nis, nama, kelas, rfid_uid) VALUES (?, ?, ?, ?)",
      args: [nis, nama, kelas, rfid_uid || null]
    });
    return res.json({ success: true, message: "Data siswa berhasil disimpan!" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Gagal simpan siswa: " + error.message });
  }
});

// API SISWA (IMPORT SEKALIGUS / BULK)
app.post('/api/siswa/bulk', async (req, res) => {
  try {
    await ensureTablesExist();
    const { dataSiswa } = req.body;

    if (!Array.isArray(dataSiswa) || dataSiswa.length === 0) {
      return res.status(400).json({ success: false, message: "Data siswa kosong atau format salah." });
    }

    for (const s of dataSiswa) {
      if (s.nis && s.nama && s.kelas) {
        await db.execute({
          sql: "INSERT OR REPLACE INTO siswa (nis, nama, kelas, rfid_uid) VALUES (?, ?, ?, ?)",
          args: [s.nis, s.nama, s.kelas, s.rfid_uid || null]
        });
      }
    }
    return res.json({ success: true, message: `${dataSiswa.length} data siswa berhasil disimpan!` });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Gagal simpan sekaligus: " + error.message });
  }
});

// API USERS (GET ALL)
app.get('/api/users', async (req, res) => {
  try {
    await ensureTablesExist();
    const result = await db.execute("SELECT id, username, nama, role FROM users");
    return res.json({ success: true, data: result.rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// API USERS (TAMBAH USER)
app.post('/api/users', async (req, res) => {
  try {
    await ensureTablesExist();
    const { username, password, nama, role } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, message: "Username dan Password wajib diisi!" });
    }

    await db.execute({
      sql: "INSERT OR REPLACE INTO users (username, password, nama, role) VALUES (?, ?, ?, ?)",
      args: [username, password, nama || username, role || 'admin']
    });
    return res.json({ success: true, message: "User berhasil ditambahkan!" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Gagal tambah user: " + error.message });
  }
});

// API TAP RFID
app.post('/api/tap', async (req, res) => {
  try {
    await ensureTablesExist();
    const { rfid_uid } = req.body;

    if (!rfid_uid) {
      return res.status(400).json({ success: false, message: "RFID UID wajib ada." });
    }

    const checkSiswa = await db.execute({
      sql: "SELECT * FROM siswa WHERE rfid_uid = ?",
      args: [rfid_uid]
    });

    if (checkSiswa.rows.length === 0) {
      return res.status(444).json({ success: false, message: "Kartu RFID belum terdaftar!" });
    }

    const siswa = checkSiswa.rows[0];
    await db.execute({
      sql: "INSERT INTO absensi (rfid_uid, nama, kelas) VALUES (?, ?, ?)",
      args: [siswa.rfid_uid, siswa.nama, siswa.kelas]
    });

    return res.json({ success: true, message: `Absen Berhasil: ${siswa.nama}`, siswa });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// API REKAP ABSENSI
app.get('/api/absensi', async (req, res) => {
  try {
    await ensureTablesExist();
    const result = await db.execute("SELECT * FROM absensi ORDER BY waktu DESC");
    return res.json({ success: true, data: result.rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// PING STATUS SERVER
app.get('/api/ping', (req, res) => {
  res.json({ status: "OK", message: "Server aktif!" });
});

// CATCH-ALL API ERROR: Mencegah kembalian HTML jika endpoint /api/ salah
app.use('/api/*', (req, res) => {
  res.status(404).json({ success: false, message: `Endpoint ${req.originalUrl} tidak ditemukan di server.` });
});

// Menyediakan file statis dari folder public
app.use(express.static(path.join(__dirname, 'public')));

// MENJALANKAN SERVER LOKAL & EXPORT VERCEL
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server aktif di port ${PORT}`));
}

module.exports = app;