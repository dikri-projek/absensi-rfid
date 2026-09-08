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
      body = body.toString('utf-8');
    }
  } else if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      // Biarkan sebagai string jika bukan JSON
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

// 4. Helper Clean RFID & String
function sanitizeRfid(val) {
  if (val === null || val === undefined) return null;
  const str = String(val).trim();
  if (str === '' || str.toLowerCase() === 'null' || str.toLowerCase() === 'undefined') return null;
  return str;
}

function cleanStr(val) {
  if (val === null || val === undefined) return '';
  const str = String(val).trim();
  if (str.toLowerCase() === 'null' || str.toLowerCase() === 'undefined') return '';
  return str;
}

// Helper Deteksi Kata Kunci Header
function cleanKeyName(str) {
  return String(str || '').replace(/^\uFEFF/, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function isNamaKey(k) {
  return k.includes('nama') || k.includes('name') || k.includes('siswa') || k.includes('fullname') || k.includes('lengkap') || k.includes('murid');
}

function isKelasKey(k) {
  return k.includes('kelas') || k.includes('class') || k.includes('rombel') || k.includes('tingkat') || k.includes('kls') || k.includes('jurusan');
}

function isNisKey(k) {
  return k.includes('nis') || k.includes('nisn') || k.includes('username') || k.includes('nomor') || k.includes('noinduk') || k.includes('id');
}

function isRfidKey(k) {
  return k.includes('rfid') || k.includes('uid') || k.includes('tag') || k.includes('kartu');
}

function assignFromCols(cols) {
  const filtered = cols.map(c => cleanStr(c)).filter(c => c !== '');
  let nis = '', nama = '', kelas = '', rfid_uid = null;

  if (filtered.length >= 4) {
    nis = filtered[0];
    nama = filtered[1];
    kelas = filtered[2];
    rfid_uid = filtered[3];
  } else if (filtered.length === 3) {
    nis = filtered[0];
    nama = filtered[1];
    kelas = filtered[2];
  } else if (filtered.length === 2) {
    nama = filtered[0];
    kelas = filtered[1];
  }

  return { nis, nama, kelas, rfid_uid: sanitizeRfid(rfid_uid) };
}

function parseRowItem(item) {
  let nis = '';
  let nama = '';
  let kelas = '';
  let rfid_uid = null;

  if (!item) return { nis, nama, kelas, rfid_uid };

  // Format 1: String "101;Ahmad;10A;1234"
  if (typeof item === 'string') {
    const delim = item.includes(';') ? ';' : (item.includes('\t') ? '\t' : ',');
    const cols = item.split(delim).map(c => c.replace(/^["']|["']$/g, ''));
    return assignFromCols(cols);
  }

  // Format 2: Array ["101", "Ahmad", "10A", "1234"]
  if (Array.isArray(item)) {
    return assignFromCols(item);
  }

  // Format 3: Object / JSON
  if (typeof item === 'object') {
    const keys = Object.keys(item);
    const vals = Object.values(item);

    // Kasus 3a: Header & Data Tergabung dalam Titik-Koma
    if (keys.length === 1 && (keys[0].includes(';') || keys[0].includes(','))) {
      const delim = keys[0].includes(';') ? ';' : ',';
      const hCols = keys[0].split(delim).map(h => cleanKeyName(h));
      const vCols = String(vals[0] || '').split(delim).map(v => v.replace(/^["']|["']$/g, ''));

      for (let i = 0; i < hCols.length; i++) {
        const hk = hCols[i];
        const val = cleanStr(vCols[i]);
        if (isRfidKey(hk)) rfid_uid = rfid_uid || val;
        else if (isNamaKey(hk)) nama = nama || val;
        else if (isKelasKey(hk)) kelas = kelas || val;
        else if (isNisKey(hk)) nis = nis || val;
      }

      if (!nama || !kelas) {
        return assignFromCols(vCols);
      }
      return { nis, nama, kelas, rfid_uid: sanitizeRfid(rfid_uid) };
    }

    // Kasus 3b: Object Key-Value Biasa
    const cleanObj = {};
    keys.forEach(k => {
      cleanObj[cleanKeyName(k)] = cleanStr(item[k]);
    });

    Object.keys(cleanObj).forEach(k => {
      const val = cleanObj[k];
      if (!val) return;

      if (isRfidKey(k)) {
        rfid_uid = rfid_uid || val;
      } else if (isNamaKey(k)) {
        nama = nama || val;
      } else if (isKelasKey(k)) {
        kelas = kelas || val;
      } else if (isNisKey(k)) {
        nis = nis || val;
      }
    });

    // Kasus 3c: Fallback ke urutan posisi jika nama/kelas belum ketemu
    if (!nama || !kelas) {
      const nonObjVals = vals.map(v => cleanStr(v)).filter(v => v !== '');
      if (nonObjVals.length === 1 && (nonObjVals[0].includes(';') || nonObjVals[0].includes(','))) {
        const delim = nonObjVals[0].includes(';') ? ';' : ',';
        const cols = nonObjVals[0].split(delim).map(c => c.replace(/^["']|["']$/g, ''));
        return assignFromCols(cols);
      }
      return assignFromCols(nonObjVals);
    }
  }

  return { nis, nama, kelas, rfid_uid: sanitizeRfid(rfid_uid) };
}

// 5. Inisialisasi Database & Migration
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
      rfid_uid TEXT,
      uid TEXT
    );
  `);

  // Auto Migration Kolom untuk DB Lama
  try { await db.execute("ALTER TABLE siswa ADD COLUMN rfid_uid TEXT;"); } catch(e) {}
  try { await db.execute("ALTER TABLE siswa ADD COLUMN nis TEXT;"); } catch(e) {}
  try { await db.execute("ALTER TABLE siswa ADD COLUMN kelas TEXT;"); } catch(e) {}
  try { await db.execute("ALTER TABLE siswa ADD COLUMN uid TEXT;"); } catch(e) {}

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

    const username = cleanStr(body.username);
    const password = cleanStr(body.password);

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

// SIMPAN / UPDATE SISWA (SINGLE MANUAL INPUT)
app.post('/api/siswa', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const body = parseRequestBody(req);

    let parsed = parseRowItem(body);
    let nis = parsed.nis;
    let nama = parsed.nama;
    let kelas = parsed.kelas;
    let rfid_uid = parsed.rfid_uid;

    if (!nama || !kelas) {
      const targetObj = (typeof body === 'object' && body !== null) ? (body.data || body.siswa || body) : {};
      Object.keys(targetObj).forEach(k => {
        const cleanK = cleanKeyName(k);
        const val = cleanStr(targetObj[k]);
        if (isNamaKey(cleanK) && !nama) nama = val;
        if (isKelasKey(cleanK) && !kelas) kelas = val;
        if (isNisKey(cleanK) && !nis) nis = val;
        if (isRfidKey(cleanK) && !rfid_uid) rfid_uid = val;
      });
    }

    if (!nama || !kelas) {
      return res.status(400).json({
        success: false,
        message: "Nama dan Kelas wajib diisi! Pastikan teks pada form input terisi."
      });
    }

    if (!nis) {
      nis = 'NIS-' + Date.now().toString().slice(-6) + Math.floor(Math.random() * 100);
    }

    const cleanRfid = sanitizeRfid(rfid_uid);
    // effectiveUid tidak boleh null untuk menghindari error NOT NULL constraint pada siswa.uid
    const effectiveUid = cleanRfid || String(nis).trim() || ('UID-' + Date.now() + Math.floor(Math.random() * 1000));

    if (cleanRfid) {
      const checkRfid = await db.execute({
        sql: "SELECT * FROM siswa WHERE (rfid_uid = ? OR uid = ?) AND nis != ?",
        args: [cleanRfid, cleanRfid, nis]
      });
      if (checkRfid.rows.length > 0) {
        return res.status(400).json({ success: false, message: `RFID '${cleanRfid}' sudah dipakai oleh siswa: ${checkRfid.rows[0].nama}` });
      }
    }

    const checkNis = await db.execute({
      sql: "SELECT * FROM siswa WHERE nis = ?",
      args: [nis]
    });

    if (checkNis.rows.length > 0) {
      await db.execute({
        sql: "UPDATE siswa SET nama = ?, kelas = ?, rfid_uid = ?, uid = ? WHERE nis = ?",
        args: [nama, kelas, cleanRfid, effectiveUid, nis]
      });
    } else {
      await db.execute({
        sql: "INSERT INTO siswa (nis, nama, kelas, rfid_uid, uid) VALUES (?, ?, ?, ?, ?)",
        args: [nis, nama, kelas, cleanRfid, effectiveUid]
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

// IMPORT BULK SISWA
async function handleBulkImport(req, res, next) {
  try {
    await ensureTablesExist();
    const db = getDb();
    const body = parseRequestBody(req);

    let list = null;

    if (Array.isArray(body)) {
      list = body;
    } else if (typeof body === 'string') {
      list = body.split(/\r?\n/).filter(line => line.trim() !== '');
    } else if (typeof body === 'object' && body !== null) {
      for (const k of Object.keys(body)) {
        if (Array.isArray(body[k])) {
          list = body[k];
          break;
        }
      }
      if (!list) {
        for (const k of Object.keys(body)) {
          if (typeof body[k] === 'string' && (body[k].includes('\n') || body[k].includes(';') || body[k].includes(','))) {
            list = body[k].split(/\r?\n/).filter(line => line.trim() !== '');
            break;
          }
        }
      }
      if (!list && Object.keys(body).length > 0) {
        list = [body];
      }
    }

    if (!list || !Array.isArray(list) || list.length === 0) {
      return res.status(400).json({ success: false, message: "Format data import tidak valid atau data kosong." });
    }

    let insertedCount = 0;

    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      let { nis, nama, kelas, rfid_uid } = parseRowItem(item);

      const lowerNama = String(nama).trim().toLowerCase();
      const lowerKelas = String(kelas).trim().toLowerCase();
      if (
        lowerNama === 'nama' || lowerNama === 'nama_siswa' || lowerNama === 'namasiswa' || lowerNama === 'name' || lowerNama === 'fullname' ||
        lowerKelas === 'kelas' || lowerKelas === 'class' || lowerKelas === 'rombel'
      ) {
        continue;
      }

      if (!nis && !nama && !kelas && !rfid_uid) continue;

      if (nama && kelas) {
        if (!nis) {
          nis = 'NIS-' + Math.floor(100000 + Math.random() * 900000);
        }

        const cleanRfid = sanitizeRfid(rfid_uid);
        const effectiveUid = cleanRfid || String(nis).trim() || ('UID-' + Date.now() + Math.floor(Math.random() * 1000));

        const checkNis = await db.execute({
          sql: "SELECT * FROM siswa WHERE nis = ?",
          args: [String(nis).trim()]
        });

        if (checkNis.rows.length > 0) {
          await db.execute({
            sql: "UPDATE siswa SET nama = ?, kelas = ?, rfid_uid = ?, uid = ? WHERE nis = ?",
            args: [nama, kelas, cleanRfid, effectiveUid, String(nis).trim()]
          });
        } else {
          await db.execute({
            sql: "INSERT INTO siswa (nis, nama, kelas, rfid_uid, uid) VALUES (?, ?, ?, ?, ?)",
            args: [String(nis).trim(), nama, kelas, cleanRfid, effectiveUid]
          });
        }
        insertedCount++;
      }
    }

    if (insertedCount === 0) {
      return res.status(400).json({
        success: false,
        message: "Gagal impor: Data siswa tidak dapat terbaca. Pastikan file berisi data Nama dan Kelas.",
        sample: list.slice(0, 2)
      });
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

    const username = cleanStr(body.username);
    const password = cleanStr(body.password);
    const nama = cleanStr(body.nama) || username || 'Administrator';
    const role = cleanStr(body.role) || 'admin';

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

// TAP RFID
app.post('/api/tap', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const body = parseRequestBody(req);

    const sanitizedRfid = sanitizeRfid(body.rfid_uid || body.rfid || body.RFID || body.uid);
    if (!sanitizedRfid) {
      return res.status(400).json({ success: false, message: "RFID UID wajib ada." });
    }

    const checkSiswa = await db.execute({
      sql: "SELECT * FROM siswa WHERE rfid_uid = ? OR uid = ?",
      args: [sanitizedRfid, sanitizedRfid]
    });

    if (checkSiswa.rows.length === 0) {
      return res.status(444).json({ success: false, message: "Kartu RFID belum terdaftar!" });
    }

    const siswa = checkSiswa.rows[0];
    await db.execute({
      sql: "INSERT INTO absensi (rfid_uid, nama, kelas) VALUES (?, ?, ?)",
      args: [siswa.rfid_uid || siswa.uid, siswa.nama, siswa.kelas]
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