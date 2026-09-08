const express = require('express');
const path = require('path');

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

// 3. Native Turso HTTP Driver (Bypass SDK untuk mencegah error migration/WebSocket)
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

// 4. Inisialisasi Database
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

  await db.execute({
    sql: "INSERT OR IGNORE INTO users (username, password, nama, role) VALUES (?, ?, ?, ?)",
    args: ['admin', 'admin', 'Administrator', 'admin']
  });

  isInitialized = true;
}

function sanitizeRfid(val) {
  if (!val) return null;
  const str = String(val).trim();
  return str === '' ? null : str;
}

// 5. API ENDPOINTS

app.get('/api/ping', (req, res) => {
  res.json({ status: "OK", message: "Server aktif!" });
});

app.post('/api/login', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();

    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '').trim();

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

// TAMBAH / UPDATE SISWA (DILENGKAPI AUTO-GENERATE NIS JIKA KOSONG)
app.post('/api/siswa', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    let { nis, nama, kelas, rfid_uid } = req.body || {};

    if (!nama || !kelas) {
      return res.status(400).json({ success: false, message: "Nama dan Kelas wajib diisi!" });
    }

    // Jika NIS tidak dikirim dari frontend, buat NIS otomatis
    if (!nis || String(nis).trim() === '') {
      nis = 'NIS-' + Date.now().toString().slice(-6);
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

// IMPORT EXCEL / BULK SISWA
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

      let nis = s.nis || s.NIS || s.Nis || '';
      const nama = s.nama || s.Nama || s.NAMA || '';
      const kelas = s.kelas || s.Kelas || s.KELAS || '';
      const rfid_uid = s.rfid_uid || s.rfid || s.RFID || s.Rfid || null;

      if (nama) {
        if (!nis || String(nis).trim() === '') {
          nis = 'NIS-' + Math.floor(100000 + Math.random() * 900000);
        }

        await db.execute({
          sql: "INSERT OR REPLACE INTO siswa (nis, nama, kelas, rfid_uid) VALUES (?, ?, ?, ?)",
          args: [String(nis), String(nama), String(kelas), sanitizeRfid(rfid_uid)]
        });
        insertedCount++;
      }
    }

    return res.json({ success: true, message: `${insertedCount} data siswa berhasil diimpor!` });
  } catch (error) {
    next(error);
  }
}
app.post('/api/siswa/import', handleBulkImport);
app.post('/api/siswa/bulk', handleBulkImport);

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

// Static Routing Frontend & SPA Fallback
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