const express = require('express');
const path = require('path');

// Menggunakan Client Web HTTP agar 100% stabil di Vercel Serverless
let createClient;
try {
  createClient = require('@libsql/client/web').createClient;
} catch (e) {
  createClient = require('@libsql/client').createClient;
}

const app = express();

// 1. CORS Middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// 2. Body Parser Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 3. Inisialisasi Database HTTP Safe
function getDb() {
  const rawUrl = process.env.TURSO_DATABASE_URL || '';
  const authToken = process.env.TURSO_AUTH_TOKEN || '';

  if (!rawUrl || rawUrl.trim() === '') {
    throw new Error("TURSO_DATABASE_URL belum diatur atau kosong pada Environment Variables Vercel.");
  }

  let url = rawUrl.trim();
  if (url.startsWith('libsql://')) {
    url = url.replace('libsql://', 'https://');
  }

  return createClient({ url, authToken });
}

// 4. Inisialisasi Tabel Cerdas (1x per Container)
let isInitialized = false;
async function ensureTablesExist() {
  if (isInitialized) return;

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

  const userCheck = await db.execute("SELECT COUNT(*) as total FROM users");
  if (userCheck.rows[0].total === 0) {
    await db.execute({
      sql: "INSERT INTO users (username, password, nama, role) VALUES (?, ?, ?, ?)",
      args: ['admin', 'admin', 'Administrator', 'admin']
    });
  }

  isInitialized = true;
}

function sanitizeRfid(val) {
  if (!val) return null;
  const str = String(val).trim();
  return str === '' ? null : str;
}

// ---------------- API ENDPOINTS ----------------

// 1. LOGIN
app.post('/api/login', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const { username, password } = req.body || {};

    const result = await db.execute({
      sql: "SELECT * FROM users WHERE username = ? AND password = ?",
      args: [String(username || ''), String(password || '')]
    });

    if (result.rows.length > 0) {
      return res.json({ success: true, message: "Login berhasil!", user: result.rows[0] });
    }
    return res.status(401).json({ success: false, message: "Username atau password salah." });
  } catch (error) {
    next(error);
  }
});

// 2. SISWA (GET ALL)
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

// 3. SISWA (TAMBAH MANUAL)
app.post('/api/siswa', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const { nis, nama, kelas, rfid_uid } = req.body || {};

    if (!nis || !nama || !kelas) {
      return res.status(400).json({ success: false, message: "NIS, Nama, dan Kelas wajib diisi!" });
    }

    await db.execute({
      sql: "INSERT OR REPLACE INTO siswa (nis, nama, kelas, rfid_uid) VALUES (?, ?, ?, ?)",
      args: [String(nis), String(nama), String(kelas), sanitizeRfid(rfid_uid)]
    });
    return res.json({ success: true, message: "Data siswa berhasil disimpan!" });
  } catch (error) {
    next(error);
  }
});

// 4. IMPORT SISWA SEKALIGUS (/api/siswa/import & /api/siswa/bulk)
async function handleBulkImport(req, res, next) {
  try {
    await ensureTablesExist();
    const db = getDb();

    const body = req.body || {};
    let list = null;

    if (Array.isArray(body)) {
      list = body;
    } else if (typeof body === 'object') {
      list = body.dataSiswa || body.siswa || body.data || body.items || null;
    }

    if (!list || !Array.isArray(list) || list.length === 0) {
      return res.status(400).json({ success: false, message: "Format data import tidak valid atau data kosong." });
    }

    let insertedCount = 0;
    for (const s of list) {
      if (!s || typeof s !== 'object') continue;

      const nis = s.nis || s.NIS;
      const nama = s.nama || s.Nama || s.NAMA;
      const kelas = s.kelas || s.Kelas || s.KELAS;
      const rfid_uid = s.rfid_uid || s.rfid || s.RFID || null;

      if (nis && nama) {
        await db.execute({
          sql: "INSERT OR REPLACE INTO siswa (nis, nama, kelas, rfid_uid) VALUES (?, ?, ?, ?)",
          args: [String(nis), String(nama), String(kelas || ''), sanitizeRfid(rfid_uid)]
        });
        insertedCount++;
      }
    }

    return res.json({ success: true, message: `${insertedCount} data siswa berhasil disimpan!` });
  } catch (error) {
    next(error);
  }
}
app.post('/api/siswa/import', handleBulkImport);
app.post('/api/siswa/bulk', handleBulkImport);

// 5. DAFTAR KELAS
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

// 6. DAFTAR SISWA PER KELAS
app.get('/api/daftar-siswa-kelas', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const kelasParam = req.query.kelas;

    let query = "SELECT * FROM siswa";
    let args = [];

    if (kelasParam) {
      query += " WHERE kelas = ?";
      args.push(String(kelasParam));
    }
    query += " ORDER BY nama ASC";

    const result = await db.execute({ sql: query, args });
    return res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// 7. USERS (GET ALL & POST TAMBAH)
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
    const { username, password, nama, role } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ success: false, message: "Username dan Password wajib diisi!" });
    }

    await db.execute({
      sql: "INSERT OR REPLACE INTO users (username, password, nama, role) VALUES (?, ?, ?, ?)",
      args: [String(username), String(password), String(nama || username), String(role || 'admin')]
    });
    return res.json({ success: true, message: "User berhasil ditambahkan!" });
  } catch (error) {
    next(error);
  }
});

// 8. TAP RFID
app.post('/api/tap', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const { rfid_uid } = req.body || {};

    const sanitizedRfid = sanitizeRfid(rfid_uid);
    if (!sanitizedRfid) {
      return res.status(400).json({ success: false, message: "RFID UID wajib ada." });
    }

    const checkSiswa = await db.execute({
      sql: "SELECT * FROM siswa WHERE rfid_uid = ?",
      args: [sanitizedRfid]
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

// 9. REKAP & LOG ABSENSI
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

// Serve Static Frontend
app.use(express.static(path.join(__dirname, 'public')));

// Catch-All Endpoint API 404
app.use('/api/*', (req, res) => {
  res.status(404).json({ success: false, message: `Endpoint ${req.originalUrl} tidak ditemukan.` });
});

// Global Error Handler (Menangkap error DB tanpa mematikan Vercel)
app.use((err, req, res, next) => {
  console.error("Vercel Serverless Error Captured:", err.message);
  res.status(500).json({
    success: false,
    message: err.message || "Terjadi kesalahan internal pada server."
  });
});

// Export Serverless Vercel & Run Lokal
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server aktif di port ${PORT}`));
}

module.exports = app;