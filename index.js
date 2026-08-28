const express = require('express');
const path = require('path');
const { createClient } = require('@libsql/client');

const app = express();

// Parsing JSON & Form Data
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Konversi URL Turso ke HTTPS agar aman di Serverless Vercel
function getTursoUrl() {
  let url = process.env.TURSO_DATABASE_URL || '';
  if (url.startsWith('libsql://')) {
    url = url.replace('libsql://', 'https://');
  }
  return url;
}

// Inisialisasi Database Turso
function getDb() {
  const url = getTursoUrl();
  const authToken = process.env.TURSO_AUTH_TOKEN || '';

  if (!url) {
    throw new Error("TURSO_DATABASE_URL belum diisi pada Environment Variables Vercel.");
  }

  return createClient({ url, authToken });
}

// Memastikan Tabel & Akun Admin Default Selalu Siap
async function ensureTablesExist() {
  const db = getDb();

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

  // OTOMATIS SEED AKUN ADMIN JIKA TABEL USERS KOSONG
  const userCheck = await db.execute("SELECT COUNT(*) as total FROM users");
  if (userCheck.rows[0].total === 0) {
    await db.execute({
      sql: "INSERT INTO users (username, password, nama, role) VALUES (?, ?, ?, ?)",
      args: ['admin', 'admin', 'Administrator', 'admin']
    });
  }
}

// ---------------- API ENDPOINTS ----------------

// 1. API LOGIN
app.post('/api/login', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
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
    next(error);
  }
});

// 2. API DAFTAR SISWA (GET ALL)
app.get('/api/siswa', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const result = await db.execute("SELECT * FROM siswa ORDER BY nama ASC");
    return res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// 3. API TAMBAH SISWA MANUAL
app.post('/api/siswa', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
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
    next(error);
  }
});

// 4. API IMPORT SISWA SEKALIGUS (/api/siswa/import DAN /api/siswa/bulk)
async function handleBulkImport(req, res, next) {
  try {
    await ensureTablesExist();
    const db = getDb();
    
    // Mendukung berbagai format body data dari frontend
    let list = req.body.dataSiswa || req.body.siswa || req.body.data || req.body;
    if (!Array.isArray(list)) {
      return res.status(400).json({ success: false, message: "Format data import tidak valid." });
    }

    for (const s of list) {
      const nis = s.nis || s.NIS;
      const nama = s.nama || s.Nama || s.NAMA;
      const kelas = s.kelas || s.Kelas || s.KELAS;
      const rfid_uid = s.rfid_uid || s.rfid || s.RFID || null;

      if (nis && nama) {
        await db.execute({
          sql: "INSERT OR REPLACE INTO siswa (nis, nama, kelas, rfid_uid) VALUES (?, ?, ?, ?)",
          args: [String(nis), String(nama), String(kelas || ''), rfid_uid ? String(rfid_uid) : null]
        });
      }
    }
    return res.json({ success: true, message: `${list.length} data siswa berhasil di-import!` });
  } catch (error) {
    next(error);
  }
}
app.post('/api/siswa/import', handleBulkImport);
app.post('/api/siswa/bulk', handleBulkImport);

// 5. API DAFTAR KELAS (DIPAKAI UNTUK DROPDOWN FE)
app.get('/api/daftar-kelas', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const result = await db.execute("SELECT DISTINCT kelas FROM siswa WHERE kelas IS NOT NULL AND kelas != '' ORDER BY kelas ASC");
    const listKelas = result.rows.map(row => row.kelas);
    return res.json({ success: true, data: listKelas, kelas: listKelas });
  } catch (error) {
    next(error);
  }
});

// 6. API DAFTAR SISWA PER KELAS
app.get('/api/daftar-siswa-kelas', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const kelasParam = req.query.kelas;

    let query = "SELECT * FROM siswa";
    let args = [];

    if (kelasParam) {
      query += " WHERE kelas = ?";
      args.push(kelasParam);
    }
    query += " ORDER BY nama ASC";

    const result = await db.execute({ sql: query, args });
    return res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// 7. API USERS (GET ALL & POST TAMBAH)
app.get('/api/users', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const result = await db.execute("SELECT id, username, nama, role FROM users");
    return res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

app.post('/api/users', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
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
    next(error);
  }
});

// 8. API TAP RFID
app.post('/api/tap', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
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
    next(error);
  }
});

// 9. API REKAP & LOG ABSENSI (/api/absensi DAN /api/log-absensi)
async function handleGetAbsensi(req, res, next) {
  try {
    await ensureTablesExist();
    const db = getDb();
    const result = await db.execute("SELECT * FROM absensi ORDER BY waktu DESC");
    return res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
}
app.get('/api/absensi', handleGetAbsensi);
app.get('/api/log-absensi', handleGetAbsensi);

// 10. API PING STATUS
app.get('/api/ping', (req, res) => {
  res.json({ status: "OK", message: "Server aktif!" });
});

// Static Files Frontend
app.use(express.static(path.join(__dirname, 'public')));

// GLOBAL ERROR HANDLER
app.use((err, req, res, next) => {
  console.error("Internal Error:", err.message);
  res.status(500).json({
    success: false,
    message: err.message || "Terjadi kesalahan pada server."
  });
});

// Export Serverless Vercel & Run Lokal
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server aktif di port ${PORT}`));
}

module.exports = app;