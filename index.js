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
      // Biarkan jika bukan JSON
    }
  }
  return body || {};
}

// Helper Ekstraksi Nilai Kolom Turso secara Aman
function extractCellValue(cell) {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'object') {
    if (cell.type === 'null') return null;
    if ('value' in cell) return cell.value;
  }
  return cell;
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
      rowObj[cols[i]] = extractCellValue(cell);
    });
    return rowObj;
  });

  return { rows };
}

function getDb() {
  return { execute: tursoQuery };
}

// 4. Helper Pembersih String & RFID
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

// 5. Inisialisasi Database & Migrasi
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
      rfid_uid TEXT,
      uid TEXT
    );
  `);

  try { await db.execute("ALTER TABLE siswa ADD COLUMN rfid_uid TEXT;"); } catch(e) {}
  try { await db.execute("ALTER TABLE siswa ADD COLUMN nis TEXT;"); } catch(e) {}
  try { await db.execute("ALTER TABLE siswa ADD COLUMN kelas TEXT;"); } catch(e) {}
  try { await db.execute("ALTER TABLE siswa ADD COLUMN uid TEXT;"); } catch(e) {}

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

  try { await db.execute("ALTER TABLE absensi ADD COLUMN keterangan TEXT DEFAULT 'Hadir';"); } catch(e) {}

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

// GET LIST SISWA (Aman & Kompatibel)
app.get('/api/siswa', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    
    let result;
    try {
      result = await db.execute("SELECT *, rowid FROM siswa ORDER BY rowid DESC");
    } catch(e) {
      result = await db.execute("SELECT * FROM siswa");
    }

    const formattedData = (result.rows || []).map(s => {
      const nama = s.nama || s.nama_siswa || s.name || 'Tanpa Nama';
      const kelas = s.kelas || s.kelas_siswa || s.rombel || '-';
      const rfid_uid = s.rfid_uid || s.rfid || s.uid || '';
      const nis = s.nis || s.id || s.rowid || '';
      const id = s.id || s.rowid || nis;

      return {
        id,
        nis,
        nama,
        kelas,
        rfid_uid,
        rfid: rfid_uid,
        uid: rfid_uid
      };
    });

    return res.json({ success: true, data: formattedData });
  } catch (error) {
    next(error);
  }
});

// SIMPAN / UPDATE SISWA (OTOMATIS UPDATE JIKA SUDAH ADA)
app.post('/api/siswa', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const body = parseRequestBody(req);

    let nama = cleanStr(body.nama || body.nama_siswa || body.name);
    let kelas = cleanStr(body.kelas || body.kelas_siswa || body.rombel);
    let rfid_uid = sanitizeRfid(body.rfid_uid || body.rfid || body.uid);
    let nis = cleanStr(body.nis || body.id);

    if (!nama || !kelas) {
      return res.status(400).json({
        success: false,
        message: "Nama dan Kelas wajib diisi!"
      });
    }

    // Cek apakah siswa/RFID sudah ada di DB
    let existingSiswa = null;
    if (rfid_uid) {
      const checkRfid = await db.execute({
        sql: "SELECT *, rowid FROM siswa WHERE rfid_uid = ? OR uid = ?",
        args: [rfid_uid, rfid_uid]
      });
      if (checkRfid.rows.length > 0) existingSiswa = checkRfid.rows[0];
    }

    if (!existingSiswa && nis) {
      const checkNis = await db.execute({
        sql: "SELECT *, rowid FROM siswa WHERE nis = ? OR id = ?",
        args: [nis, nis]
      });
      if (checkNis.rows.length > 0) existingSiswa = checkNis.rows[0];
    }

    if (existingSiswa) {
      // JIKA SUDAH ADA: OTOMATIS UPDATE DATA
      const targetNis = existingSiswa.nis || nis || ('NIS-' + Date.now());
      const targetId = existingSiswa.id || existingSiswa.rowid || targetNis;

      await db.execute({
        sql: "UPDATE siswa SET nama = ?, kelas = ?, rfid_uid = ?, uid = ? WHERE rowid = ? OR id = ? OR nis = ?",
        args: [nama, kelas, rfid_uid, rfid_uid || targetNis, targetId, targetId, targetNis]
      });

      return res.json({ success: true, message: `Data siswa '${nama}' berhasil diperbarui!` });
    } else {
      // JIKA BELUM ADA: INSERT SISWA BARU
      if (!nis) {
        nis = 'NIS-' + Date.now().toString().slice(-6);
      }
      const cleanRfid = rfid_uid || nis;

      await db.execute({
        sql: "INSERT INTO siswa (nis, nama, kelas, rfid_uid, uid) VALUES (?, ?, ?, ?, ?)",
        args: [nis, nama, kelas, rfid_uid, cleanRfid]
      });

      return res.json({ success: true, message: `Siswa baru '${nama}' berhasil ditambahkan!` });
    }
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
      sql: "DELETE FROM siswa WHERE id = ? OR nis = ? OR rowid = ?",
      args: [id, id, id]
    });

    return res.json({ success: true, message: "Siswa berhasil dihapus!" });
  } catch (error) {
    next(error);
  }
});

// TAP RFID PRESENSI
app.post('/api/tap', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const body = parseRequestBody(req);

    const sanitizedRfid = sanitizeRfid(body.rfid_uid || body.rfid || body.uid);
    if (!sanitizedRfid) {
      return res.status(400).json({ success: false, message: "RFID UID wajib ada." });
    }

    const checkSiswa = await db.execute({
      sql: "SELECT * FROM siswa WHERE rfid_uid = ? OR uid = ? OR nis = ?",
      args: [sanitizedRfid, sanitizedRfid, sanitizedRfid]
    });

    if (checkSiswa.rows.length === 0) {
      return res.status(444).json({ success: false, message: `Kartu RFID '${sanitizedRfid}' belum terdaftar!` });
    }

    const siswa = checkSiswa.rows[0];
    const studentRfid = siswa.rfid_uid || siswa.uid || sanitizedRfid;
    const studentNama = siswa.nama || 'Siswa';
    const studentKelas = siswa.kelas || '-';

    await db.execute({
      sql: "INSERT INTO absensi (rfid_uid, nama, kelas, keterangan) VALUES (?, ?, ?, 'Hadir')",
      args: [studentRfid, studentNama, studentKelas]
    });

    return res.json({
      success: true,
      message: `Absen Berhasil: ${studentNama}`,
      siswa: {
        ...siswa,
        rfid: studentRfid,
        rfid_uid: studentRfid
      }
    });
  } catch (error) {
    next(error);
  }
});

// ABSENSI MANUAL
async function handleAbsensiManual(req, res, next) {
  try {
    await ensureTablesExist();
    const db = getDb();
    const body = parseRequestBody(req);

    let nama = cleanStr(body.nama || body.nama_siswa);
    let kelas = cleanStr(body.kelas);
    let rfid_uid = sanitizeRfid(body.rfid_uid || body.rfid || body.uid);
    let keterangan = cleanStr(body.keterangan || body.status) || 'Hadir';

    const targetIdentifier = body.siswa_id || body.id || body.nis || rfid_uid;
    if ((!nama || !kelas) && targetIdentifier) {
      const checkSiswa = await db.execute({
        sql: "SELECT *, rowid FROM siswa WHERE id = ? OR nis = ? OR rfid_uid = ? OR uid = ? OR rowid = ?",
        args: [targetIdentifier, targetIdentifier, targetIdentifier, targetIdentifier, targetIdentifier]
      });
      if (checkSiswa.rows.length > 0) {
        const s = checkSiswa.rows[0];
        nama = nama || s.nama;
        kelas = kelas || s.kelas;
        rfid_uid = rfid_uid || s.rfid_uid || s.uid;
      }
    }

    if (!nama) {
      return res.status(400).json({ success: false, message: "Nama siswa wajib dipilih atau diisi." });
    }

    await db.execute({
      sql: "INSERT INTO absensi (rfid_uid, nama, kelas, keterangan) VALUES (?, ?, ?, ?)",
      args: [rfid_uid || 'MANUAL', nama, kelas || '-', keterangan]
    });

    return res.json({ success: true, message: `Absensi manual ${nama} berhasil disimpan!` });
  } catch (error) {
    next(error);
  }
}

app.post('/api/absensi/manual', handleAbsensiManual);
app.post('/api/manual-absensi', handleAbsensiManual);

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

// HAPUS ABSENSI
app.delete('/api/absensi/:id', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const { id } = req.params;

    await db.execute({
      sql: "DELETE FROM absensi WHERE id = ?",
      args: [id]
    });

    return res.json({ success: true, message: "Data absensi berhasil dihapus!" });
  } catch (error) {
    next(error);
  }
});

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