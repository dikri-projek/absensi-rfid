const express = require('express');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');

const app = express();

// Konfigurasi Multer (Memory Storage agar kompatibel penuh dengan Vercel Serverless)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // Maksimal 10MB
});

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

// Helper Parsing Body Teraman untuk Vercel
function parseRequestBody(req) {
  let body = req.body;
  if (!body) return {};

  if (Buffer.isBuffer(body)) {
    try {
      body = JSON.parse(body.toString('utf-8'));
    } catch (e) {
      body = {};
    }
  } else if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {};
    }
  }
  return body || {};
}

// 3. Native Turso HTTP Driver
async function tursoQuery(stmt) {
  let sql = "";
  let args = [];

  if (typeof stmt === 'string') {
    sql = stmt;
  } else if (typeof stmt === 'object' && stmt !== null) {
    sql = stmt.sql || '';
    args = stmt.args || [];
  }

  let url = (process.env.TURSO_DATABASE_URL || '').trim().replace(/^["']|["']$/g, '');
  let token = (process.env.TURSO_AUTH_TOKEN || '').trim().replace(/^["']|["']$/g, '');

  if (!url || !token) {
    throw new Error("TURSO_DATABASE_URL atau TURSO_AUTH_TOKEN belum diatur pada Vercel Settings.");
  }

  if (url.startsWith('libsql://')) {
    url = url.replace('libsql://', 'https://');
  }
  if (url.endsWith('/')) {
    url = url.slice(0, -1);
  }

  const formattedArgs = args.map(arg => {
    if (arg === null || arg === undefined) return { type: "null" };
    if (typeof arg === "number") {
      return Number.isInteger(arg) ? { type: "integer", value: String(arg) } : { type: "float", value: arg };
    }
    return { type: "text", value: String(arg) };
  });

  const res = await fetch(`${url}/v2/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      requests: [
        {
          type: 'execute',
          stmt: { sql, args: formattedArgs }
        },
        { type: 'close' }
      ]
    })
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Turso HTTP Error (${res.status}): ${errorText}`);
  }

  const json = await res.json();
  const firstResult = json.results?.[0];

  if (firstResult?.type === 'error') {
    throw new Error(firstResult.error?.message || "Gagal mengeksekusi query Turso.");
  }

  const execResult = firstResult?.response?.result;
  if (!execResult) return { rows: [] };

  const cols = execResult.cols ? execResult.cols.map(c => c.name) : [];
  const rows = (execResult.rows || []).map(row => {
    const rowObj = {};
    row.forEach((cell, i) => {
      rowObj[cols[i]] = cell?.value !== undefined ? cell.value : null;
    });
    return rowObj;
  });

  return { rows };
}

function getDb() {
  return { execute: tursoQuery };
}

// 4. Helper Clean RFID & String Safe
function sanitizeRfid(val) {
  if (val === null || val === undefined) return null;
  const str = String(val).trim();
  if (str === '' || str.toLowerCase() === 'null' || str.toLowerCase() === 'undefined') return null;
  return str;
}

function cleanString(val) {
  if (val === null || val === undefined) return '';
  const str = String(val).trim();
  if (str.toLowerCase() === 'undefined' || str.toLowerCase() === 'null') return '';
  return str;
}

// 5. Inisialisasi Database
let isInitialized = false;
async function ensureTablesExist() {
  if (isInitialized) return;

  const db = getDb();

  // Tabel Users
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      nama TEXT,
      role TEXT DEFAULT 'admin'
    );
  `);

  // Tabel Siswa
  await db.execute(`
    CREATE TABLE IF NOT EXISTS siswa (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nis TEXT UNIQUE,
      nama TEXT,
      kelas TEXT,
      rfid_uid TEXT UNIQUE
    );
  `);

  // Auto Migration Kolom
  try { await db.execute("ALTER TABLE siswa ADD COLUMN rfid_uid TEXT;"); } catch(e) {}
  try { await db.execute("ALTER TABLE siswa ADD COLUMN nis TEXT;"); } catch(e) {}
  try { await db.execute("ALTER TABLE siswa ADD COLUMN kelas TEXT;"); } catch(e) {}

  // Pembersihan RFID kosong
  try {
    await db.execute("UPDATE siswa SET rfid_uid = NULL WHERE TRIM(rfid_uid) = '' OR rfid_uid = 'null' OR rfid_uid = 'undefined';");
  } catch(e) {}

  // Tabel Absensi
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

  // Akun Admin Default
  await db.execute({
    sql: "INSERT OR IGNORE INTO users (username, password, nama, role) VALUES (?, ?, ?, ?)",
    args: ['admin', 'admin', 'Administrator', 'admin']
  });

  isInitialized = true;
}

// 6. API ENDPOINTS

app.get('/api/ping', (req, res) => {
  res.json({ status: "OK", message: "Server aktif!" });
});

// LOGIN
app.post('/api/login', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const body = parseRequestBody(req);

    const username = cleanString(body.username);
    const password = cleanString(body.password);

    if (!username || !password) {
      return res.status(400).json({ success: false, message: "Username dan password tidak boleh kosong." });
    }

    const result = await db.execute({
      sql: "SELECT * FROM users WHERE LOWER(TRIM(username)) = LOWER(?) AND TRIM(password) = ?",
      args: [username, password]
    });

    if (result.rows.length > 0) {
      return res.json({ success: true, message: "Login berhasil!", user: result.rows[0] });
    }

    return res.status(401).json({ success: false, message: "Username atau password salah." });
  } catch (error) {
    next(error);
  }
});

// GET LIST SISWA
app.get('/api/siswa', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const result = await db.execute("SELECT * FROM siswa ORDER BY id DESC");
    return res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// SIMPAN / UPDATE SISWA (SINGLE)
app.post('/api/siswa', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const body = parseRequestBody(req);

    let nis = cleanString(body.nis || body.NIS || body.siswaNis);
    let nama = cleanString(body.nama || body.Nama || body.siswaNama || body.name);
    let kelas = cleanString(body.kelas || body.Kelas || body.siswaKelas);
    let rfid_uid = body.rfid_uid || body.rfid || body.RFID || body.siswaRfid || null;

    if (!nama || !kelas) {
      return res.status(400).json({ success: false, message: "Nama dan Kelas wajib diisi!" });
    }

    if (!nis) {
      nis = 'NIS-' + Date.now().toString().slice(-6) + Math.floor(Math.random() * 100);
    }

    const cleanRfid = sanitizeRfid(rfid_uid);

    // Cek duplikasi RFID
    if (cleanRfid) {
      const checkRfid = await db.execute({
        sql: "SELECT * FROM siswa WHERE rfid_uid = ? AND nis != ?",
        args: [cleanRfid, nis]
      });
      if (checkRfid.rows.length > 0) {
        return res.status(400).json({ success: false, message: `RFID '${cleanRfid}' sudah dipakai oleh siswa: ${checkRfid.rows[0].nama}` });
      }
    }

    // Cek apakah NIS sudah ada
    const checkNis = await db.execute({
      sql: "SELECT * FROM siswa WHERE nis = ?",
      args: [nis]
    });

    if (checkNis.rows.length > 0) {
      // UPDATE
      await db.execute({
        sql: "UPDATE siswa SET nama = ?, kelas = ?, rfid_uid = ? WHERE nis = ?",
        args: [nama, kelas, cleanRfid, nis]
      });
    } else {
      // INSERT
      await db.execute({
        sql: "INSERT INTO siswa (nis, nama, kelas, rfid_uid) VALUES (?, ?, ?, ?)",
        args: [nis, nama, kelas, cleanRfid]
      });
    }

    return res.json({ success: true, message: "Data siswa berhasil disimpan!" });
  } catch (error) {
    console.error("Error SIMPAN SISWA:", error.message);
    return res.status(500).json({ success: false, message: `Gagal menyimpan siswa: ${error.message}` });
  }
});

// HAPUS SISWA
app.delete('/api/siswa/:id', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const { id } = req.params;

    await db.execute({
      sql: "DELETE FROM siswa WHERE id = ? OR nis = ?",
      args: [id, id]
    });

    return res.json({ success: true, message: "Siswa berhasil dihapus!" });
  } catch (error) {
    next(error);
  }
});

// IMPORT EXCEL / CSV / JSON BULK SISWA (DUKUNGAN GANDA: FILE UPLOAD & JSON BODY)
async function handleBulkImport(req, res, next) {
  try {
    await ensureTablesExist();
    const db = getDb();

    let list = null;

    // 1. Cek Apakah Ada File Unggahan (Excel / CSV) via Multipart Form-Data
    const uploadedFile = (req.files && req.files.length > 0) ? req.files[0] : req.file;

    if (uploadedFile && uploadedFile.buffer) {
      const workbook = XLSX.read(uploadedFile.buffer, { type: 'buffer' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      list = XLSX.utils.sheet_to_json(worksheet, { defval: '', raw: false });
    } else {
      // 2. Fallback Jika Mengirim Array/Object JSON
      const body = parseRequestBody(req);
      if (Array.isArray(body)) {
        list = body;
      } else if (typeof body === 'object' && body !== null) {
        list = body.dataSiswa || body.siswa || body.data || body.items || null;
      }
    }

    if (!list || !Array.isArray(list) || list.length === 0) {
      return res.status(400).json({ success: false, message: "Format data import tidak valid atau data kosong." });
    }

    let insertedCount = 0;
    const errors = [];

    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item || typeof item !== 'object') continue;

      // Normalisasi Header Kolom (Pembersihan BOM UTF-8, Lowercase, & Trim Spasi)
      const cleanRow = {};
      Object.keys(item).forEach(key => {
        const cleanKey = key.replace(/^\uFEFF/, '').trim().toLowerCase();
        cleanRow[cleanKey] = cleanString(item[key]);
      });

      // Mapping Kolom Fleksibel
      let nis = cleanRow.nis || cleanRow.username || cleanRow.nisn || '';
      const nama = cleanRow.nama || cleanRow.nama_siswa || cleanRow.name || '';
      const kelas = cleanRow.kelas || cleanRow.class || '';
      const rfid_uid = cleanRow.rfid_uid || cleanRow.rfid || cleanRow.uid || null;

      // Skip Jika Seluruh Kolom Utama Kosong (Mengatasi Baris Blank di Akhir File Excel)
      if (!nis && !nama && !kelas && !rfid_uid) continue;

      // Validasi Nama & Kelas
      if (!nama || !kelas) {
        errors.push(`Baris ${i + 2}: Nama dan Kelas wajib diisi!`);
        continue;
      }

      // Generate Auto NIS Jika Kosong
      if (!nis) {
        nis = 'NIS-' + Math.floor(100000 + Math.random() * 900000);
      }

      const cleanRfid = sanitizeRfid(rfid_uid);

      // Upsert Ke Database
      const checkNis = await db.execute({
        sql: "SELECT * FROM siswa WHERE nis = ?",
        args: [String(nis).trim()]
      });

      if (checkNis.rows.length > 0) {
        await db.execute({
          sql: "UPDATE siswa SET nama = ?, kelas = ?, rfid_uid = ? WHERE nis = ?",
          args: [nama, kelas, cleanRfid, String(nis).trim()]
        });
      } else {
        await db.execute({
          sql: "INSERT INTO siswa (nis, nama, kelas, rfid_uid) VALUES (?, ?, ?, ?)",
          args: [String(nis).trim(), nama, kelas, cleanRfid]
        });
      }
      insertedCount++;
    }

    if (insertedCount === 0 && errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Gagal mengimpor data siswa.",
        errors: errors
      });
    }

    return res.json({
      success: true,
      message: `${insertedCount} data siswa berhasil diimpor!`,
      total: insertedCount
    });

  } catch (error) {
    return res.status(500).json({ success: false, message: `Gagal import: ${error.message}` });
  }
}

// Handler Import Menggunakan upload.any() Agar Fleksibel Menangkap File Apapun Field-nya
app.post('/api/siswa/import', upload.any(), handleBulkImport);
app.post('/api/siswa/bulk', upload.any(), handleBulkImport);

// GET LIST USERS
app.get('/api/users', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const result = await db.execute("SELECT id, username, nama, role FROM users ORDER BY id DESC");
    return res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// TAMBAH USER (PENGAMAN AGAR TIDAK TERJADI 'adminundefined')
app.post('/api/users', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const body = parseRequestBody(req);

    const username = cleanString(body.username);
    const password = cleanString(body.password);
    let nama = cleanString(body.nama) || username || 'Administrator';
    const role = cleanString(body.role) || 'admin';

    if (!username || !password) {
      return res.status(400).json({ success: false, message: "Username dan Password wajib diisi!" });
    }

    await db.execute({
      sql: "INSERT OR REPLACE INTO users (username, password, nama, role) VALUES (?, ?, ?, ?)",
      args: [username, password, nama, role]
    });
    return res.json({ success: true, message: "User berhasil disimpan!" });
  } catch (error) {
    next(error);
  }
});

// HAPUS USER
app.delete('/api/users/:id', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const { id } = req.params;

    await db.execute({
      sql: "DELETE FROM users WHERE id = ?",
      args: [id]
    });

    return res.json({ success: true, message: "User berhasil dihapus!" });
  } catch (error) {
    next(error);
  }
});

// TAP RFID SIMULASI / HARDWARE
app.post('/api/tap', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const body = parseRequestBody(req);

    const sanitizedRfid = sanitizeRfid(body.rfid_uid || body.rfid || body.RFID);
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

// GET REKAP ABSENSI
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

// Static Routing
app.use(express.static(path.join(__dirname, 'public')));

app.all('/api/*', (req, res) => {
  res.status(404).json({ success: false, message: `Endpoint API ${req.originalUrl} tidak ditemukan.` });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("Vercel Serverless Error Captured:", err.message);
  res.status(500).json({
    success: false,
    message: err.message || "Terjadi kesalahan internal pada server."
  });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server aktif di port ${PORT}`));
}

module.exports = app;