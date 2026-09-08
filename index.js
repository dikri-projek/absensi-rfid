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
      // Abaikan jika string biasa
    }
  }
  return body || {};
}

function extractCellValue(cell) {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'object') {
    if (cell.type === 'null') return null;
    if ('value' in cell) return cell.value;
  }
  return cell;
}

// 3. Turso HTTP Driver
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
    throw new Error("TURSO_DATABASE_URL atau TURSO_AUTH_TOKEN belum diatur pada Environment Variables Vercel.");
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

// 4. Inisialisasi Tabel Database
let isInitialized = false;
async function ensureTablesExist() {
  if (isInitialized) return;

  const db = getDb();

  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      password TEXT,
      nama TEXT,
      role TEXT DEFAULT 'admin'
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS siswa (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nis TEXT,
      nama TEXT,
      kelas TEXT,
      rfid_uid TEXT,
      uid TEXT
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

  isInitialized = true;
}

// 5. API ENDPOINTS

app.get('/api/ping', (req, res) => {
  res.json({ status: "OK", message: "Server aktif!" });
});

// REPAIR DATABASE (DROPS & RECREATES TABEL SISWA SECARA BERSIH)
app.post('/api/repair-db', async (req, res) => {
  try {
    const db = getDb();
    await db.execute("DROP TABLE IF EXISTS siswa");
    await db.execute(`
      CREATE TABLE siswa (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nis TEXT,
        nama TEXT,
        kelas TEXT,
        rfid_uid TEXT,
        uid TEXT
      );
    `);
    isInitialized = true;
    return res.json({ success: true, message: "Tabel siswa berhasil direparasi & di-reset bersih!" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Gagal reparasi: " + error.message });
  }
});

// GET DAFTAR PILIHAN KELAS
app.get('/api/kelas', async (req, res) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    
    const result = await db.execute("SELECT DISTINCT kelas FROM siswa WHERE kelas IS NOT NULL AND TRIM(kelas) != ''");
    const dbKelas = (result.rows || []).map(r => cleanStr(r.kelas)).filter(Boolean);

    const defaultKelas = [
      "10 IPA 1", "10 IPA 2", "10 IPS 1", "10 IPS 2",
      "11 IPA 1", "11 IPA 2", "11 IPS 1", "11 IPS 2",
      "12 IPA 1", "12 IPA 2", "12 IPS 1", "12 IPS 2"
    ];

    const allKelas = Array.from(new Set([...defaultKelas, ...dbKelas]));
    return res.json({ success: true, kelas: allKelas });
  } catch (error) {
    return res.json({
      success: true,
      kelas: [
        "10 IPA 1", "10 IPA 2", "10 IPS 1", "10 IPS 2",
        "11 IPA 1", "11 IPA 2", "11 IPS 1", "11 IPS 2",
        "12 IPA 1", "12 IPA 2", "12 IPS 1", "12 IPS 2"
      ]
    });
  }
});

// GET SISWA
app.get('/api/siswa', async (req, res) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    
    const result = await db.execute("SELECT * FROM siswa ORDER BY id DESC");
    const rows = result.rows || [];

    const formattedData = rows.map((s, idx) => ({
      id: s.id || s.nis || (idx + 1),
      nis: s.nis || '-',
      nama: s.nama || s.nama_siswa || s.name || 'Tanpa Nama',
      kelas: s.kelas || s.kelas_siswa || '-',
      rfid_uid: s.rfid_uid || s.uid || '-'
    }));

    return res.json({
      success: true,
      data: formattedData,
      siswa: formattedData
    });
  } catch (error) {
    console.error("GET /api/siswa Error:", error.message);
    return res.status(500).json({ success: false, message: error.message, data: [], siswa: [] });
  }
});

// SIMPAN & EDIT SISWA
async function handleSaveOrUpdateSiswa(req, res) {
  try {
    await ensureTablesExist();
    const db = getDb();
    const body = parseRequestBody(req);

    const paramId = req.params.id;
    const bodyId = body.id || body.siswa_id;
    const targetId = paramId || bodyId;

    const nama = cleanStr(body.nama || body.nama_siswa || body.name);
    const kelas = cleanStr(body.kelas || body.kelas_siswa || body.rombel);
    const rfid_uid = sanitizeRfid(body.rfid_uid || body.rfid || body.uid);
    const nis = cleanStr(body.nis);

    if (!nama || !kelas) {
      return res.status(400).json({ success: false, message: "Nama dan Kelas wajib diisi!" });
    }

    const finalNis = nis || ('NIS-' + Date.now().toString().slice(-6));
    const finalRfid = rfid_uid || finalNis;

    // 1. Cek apakah mode Edit (ada targetId)
    if (targetId) {
      await db.execute({
        sql: "UPDATE siswa SET nama = ?, kelas = ?, rfid_uid = ?, uid = ?, nis = ? WHERE id = ? OR nis = ?",
        args: [nama, kelas, finalRfid, finalRfid, finalNis, targetId, targetId]
      });
      return res.json({ success: true, message: `Data '${nama}' berhasil diperbarui!` });
    }

    // 2. Mode Tambah Baru
    try {
      await db.execute({
        sql: "INSERT INTO siswa (nis, nama, kelas, rfid_uid, uid) VALUES (?, ?, ?, ?, ?)",
        args: [finalNis, nama, kelas, finalRfid, finalRfid]
      });
    } catch (insertErr) {
      // Fallback jika terjadi kendala bentrok data
      await db.execute({
        sql: "UPDATE siswa SET nama = ?, kelas = ? WHERE rfid_uid = ? OR uid = ? OR nis = ?",
        args: [nama, kelas, finalRfid, finalRfid, finalNis]
      });
    }

    return res.json({ success: true, message: `Siswa '${nama}' berhasil disimpan!` });
  } catch (error) {
    console.error("Save Siswa Error:", error.message);
    return res.status(500).json({ success: false, message: "Gagal menyimpan ke database: " + error.message });
  }
}

app.post('/api/siswa', handleSaveOrUpdateSiswa);
app.put('/api/siswa', handleSaveOrUpdateSiswa);
app.post('/api/siswa/:id', handleSaveOrUpdateSiswa);
app.put('/api/siswa/:id', handleSaveOrUpdateSiswa);

// SEED SAMPLE SISWA (ISI 4 CONTOH DATA)
app.post('/api/siswa/seed', async (req, res) => {
  try {
    await ensureTablesExist();
    const db = getDb();

    const sampleStudents = [
      { nis: '1001', nama: 'Ahmad Rizky', kelas: '10 IPA 1', rfid: 'RFID1001' },
      { nis: '1002', nama: 'Siti Rahma', kelas: '10 IPA 1', rfid: 'RFID1002' },
      { nis: '1003', nama: 'Budi Santoso', kelas: '10 IPA 2', rfid: 'RFID1003' },
      { nis: '1004', nama: 'Dewi Lestari', kelas: '11 IPA 1', rfid: 'RFID1004' }
    ];

    for (const s of sampleStudents) {
      await db.execute({
        sql: "INSERT INTO siswa (nis, nama, kelas, rfid_uid, uid) VALUES (?, ?, ?, ?, ?)",
        args: [s.nis, s.nama, s.kelas, s.rfid, s.rfid]
      });
    }

    return res.json({ success: true, message: "Berhasil mengisi 4 data siswa contoh!" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// HAPUS SISWA
app.delete('/api/siswa/:id', async (req, res) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const { id } = req.params;

    await db.execute({
      sql: "DELETE FROM siswa WHERE id = ? OR nis = ? OR rfid_uid = ? OR uid = ?",
      args: [id, id, id, id]
    });

    return res.json({ success: true, message: "Siswa berhasil dihapus!" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// GET REKAP ABSENSI
app.get('/api/absensi', async (req, res) => {
  try {
    await ensureTablesExist();
    const db = getDb();

    const result = await db.execute("SELECT * FROM absensi ORDER BY waktu DESC, id DESC");
    const rows = (result.rows || []).map(a => ({
      id: a.id,
      rfid_uid: a.rfid_uid || '',
      nama: a.nama || '',
      kelas: a.kelas || '-',
      waktu: a.waktu || '',
      keterangan: a.keterangan || 'Hadir'
    }));

    return res.json({ success: true, data: rows, absensi: rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// TAP RFID PRESENSI
app.post('/api/tap', async (req, res) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const body = parseRequestBody(req);

    const sanitizedRfid = sanitizeRfid(body.rfid_uid || body.rfid || body.uid);
    if (!sanitizedRfid) {
      return res.status(400).json({ success: false, message: "RFID UID wajib diisi." });
    }

    const checkSiswa = await db.execute({
      sql: "SELECT * FROM siswa WHERE rfid_uid = ? OR uid = ? OR nis = ?",
      args: [sanitizedRfid, sanitizedRfid, sanitizedRfid]
    });

    if (checkSiswa.rows.length === 0) {
      return res.status(444).json({ success: false, message: `Kartu RFID '${sanitizedRfid}' belum terdaftar!` });
    }

    const siswa = checkSiswa.rows[0];
    await db.execute({
      sql: "INSERT INTO absensi (rfid_uid, nama, kelas, keterangan) VALUES (?, ?, ?, 'Hadir')",
      args: [siswa.rfid_uid || sanitizedRfid, siswa.nama, siswa.kelas]
    });

    return res.json({ success: true, message: `Absen Berhasil: ${siswa.nama}`, siswa });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// STATIC SERVING
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// GLOBAL ERROR HANDLER
app.use((err, req, res, next) => {
  console.error("Server Error:", err.message);
  res.status(500).json({ success: false, message: err.message || "Terjadi kesalahan server." });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server aktif di port ${PORT}`));
}

module.exports = app;