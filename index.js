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

// 4. Helper Clean RFID
function sanitizeRfid(val) {
  if (val === null || val === undefined) return null;
  const str = String(val).trim();
  if (str === '' || str.toLowerCase() === 'null' || str.toLowerCase() === 'undefined') return null;
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
    await db.execute("UPDATE siswa SET rfid_uid = NULL WHERE TRIM(rfid_uid) = '' OR rfid_uid = 'null';");
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

    const username = String(body.username || '').trim();
    const password = String(body.password || '').trim();

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

// SIMPAN / UPDATE SISWA (PERBAIKAN BESAR DI SINI)
app.post('/api/siswa', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const body = parseRequestBody(req);

    let nis = String(body.nis || body.NIS || body.siswaNis || '').trim();
    let nama = String(body.nama || body.Nama || body.siswaNama || body.name || '').trim();
    let kelas = String(body.kelas || body.Kelas || body.siswaKelas || '').trim();
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
      // INSERT (URUTAN SUDAH DIPERBAIKI: nis, nama, kelas, cleanRfid)
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

// IMPORT EXCEL BULK SISWA
async function handleBulkImport(req, res, next) {
  try {
    await ensureTablesExist();
    const db = getDb();
    const body = parseRequestBody(req);

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
      const nama = String(s.nama || s.Nama || s.NAMA || '').trim();
      const kelas = String(s.kelas || s.Kelas || s.KELAS || '').trim();
      const rfid_uid = s.rfid_uid || s.rfid || s.RFID || s.Rfid || null;

      if (nama && kelas) {
        if (!nis || String(nis).trim() === '') {
          nis = 'NIS-' + Math.floor(100000 + Math.random() * 900000);
        }

        const cleanRfid = sanitizeRfid(rfid_uid);

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
    }

    return res.json({ success: true, message: `${insertedCount} data siswa berhasil diimpor!` });
  } catch (error) {
    return res.status(500).json({ success: false, message: `Gagal import: ${error.message}` });
  }
}
app.post('/api/siswa/import', handleBulkImport);
app.post('/api/siswa/bulk', handleBulkImport);

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

// TAMBAH USER
app.post('/api/users', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const body = parseRequestBody(req);

    const username = String(body.username || '').trim();
    const password = String(body.password || '').trim();
    const nama = String(body.nama || username).trim();
    const role = String(body.role || 'admin').trim();

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

// TAP RFID SIMULASI
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