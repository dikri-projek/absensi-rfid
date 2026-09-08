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
      // Biarkan jika bukan JSON
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

// 4. Inisialisasi Database, Tabel & Seed Data Awal
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

  // User Default Admin
  await db.execute({
    sql: "INSERT OR IGNORE INTO users (username, password, nama, role) VALUES (?, ?, ?, ?)",
    args: ['admin', 'admin', 'Administrator', 'admin']
  });

  // Otomatis Isikan Data Siswa Awal Jika Tabel Masih Kosong
  try {
    const checkSiswa = await db.execute("SELECT COUNT(*) as total FROM siswa");
    const totalSiswa = checkSiswa.rows?.[0]?.total || checkSiswa.rows?.[0]?.['COUNT(*)'] || 0;
    
    if (Number(totalSiswa) === 0) {
      await db.execute({
        sql: `INSERT INTO siswa (nis, nama, kelas, rfid_uid, uid) VALUES 
              ('1001', 'Ahmad Rizky', 'X IPA 1', '12345678', '12345678'),
              ('1002', 'Siti Aminah', 'XI IPA 2', '87654321', '87654321'),
              ('1003', 'Budi Santoso', 'XII IPS 1', '11223344', '11223344')`,
        args: []
      });
    }
  } catch (e) {
    console.error("Gagal melakukan auto-seed siswa:", e.message);
  }

  isInitialized = true;
}

// 5. API ENDPOINTS

app.get('/api/ping', (req, res) => {
  res.json({ status: "OK", message: "Server aktif!" });
});

// LOGIN USER
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

// MANAJEMEN USERS
app.get('/api/users', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const result = await db.execute("SELECT id, username, nama, role FROM users ORDER BY id DESC");
    const rows = result.rows || [];
    
    if (req.query.raw === 'true' || req.query.format === 'array') {
      return res.json(rows);
    }
    return res.json({ success: true, data: rows, users: rows });
  } catch (error) {
    next(error);
  }
});

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

// GET DAFTAR KELAS (DROPDOWN & PRINTOUT)
async function handleGetKelas(req, res, next) {
  try {
    await ensureTablesExist();
    const db = getDb();

    let dbKelas = [];
    try {
      const resSiswa = await db.execute("SELECT DISTINCT kelas FROM siswa WHERE kelas IS NOT NULL AND TRIM(kelas) != ''");
      const resAbsensi = await db.execute("SELECT DISTINCT kelas FROM absensi WHERE kelas IS NOT NULL AND TRIM(kelas) != ''");
      
      const k1 = (resSiswa.rows || []).map(r => r.kelas);
      const k2 = (resAbsensi.rows || []).map(r => r.kelas);
      dbKelas = [...k1, ...k2].filter(Boolean);
    } catch (e) {
      console.error("Error fetching kelas DB:", e.message);
    }

    const defaultKelas = [
      'X IPA 1', 'X IPA 2', 'X IPS 1', 'X IPS 2',
      'XI IPA 1', 'XI IPA 2', 'XI IPS 1', 'XI IPS 2',
      'XII IPA 1', 'XII IPA 2', 'XII IPS 1', 'XII IPS 2'
    ];

    const uniqueKelas = Array.from(new Set([...dbKelas, ...defaultKelas])).sort();

    const formattedObjects = uniqueKelas.map((k, index) => ({
      id: index + 1,
      id_kelas: index + 1,
      nama: k,
      nama_kelas: k,
      kelas: k,
      value: k,
      label: k
    }));

    if (req.query.raw === 'true' || req.query.format === 'string') {
      return res.json(uniqueKelas);
    }

    return res.json({
      success: true,
      data: formattedObjects,
      kelas: formattedObjects,
      list: uniqueKelas,
      options: formattedObjects
    });
  } catch (error) {
    next(error);
  }
}

app.get('/api/kelas', handleGetKelas);
app.get('/api/kelas-list', handleGetKelas);
app.get('/api/siswa/kelas', handleGetKelas);
app.get('/api/absensi/kelas', handleGetKelas);

// GET DATA SISWA (FORMAT UNIVERSAL SUPAYA TABEL TAMPIL KONSISTEN)
app.get('/api/siswa', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    
    let result;
    try {
      result = await db.execute("SELECT * FROM siswa ORDER BY id DESC");
    } catch(e) {
      result = await db.execute("SELECT * FROM siswa");
    }

    const rows = result.rows || [];
    const formattedData = rows.map(s => {
      const nama = s.nama || s.nama_siswa || s.name || 'Tanpa Nama';
      const kelas = s.kelas || s.kelas_siswa || s.rombel || '-';
      const rfid_uid = s.rfid_uid || s.rfid || s.uid || '';
      const nis = s.nis || s.id || '';
      const id = s.id || nis || Math.floor(Math.random() * 10000);

      return {
        id,
        nis,
        nama,
        nama_siswa: nama,
        name: nama,
        kelas,
        kelas_siswa: kelas,
        rombel: kelas,
        rfid_uid,
        rfid: rfid_uid,
        uid: rfid_uid
      };
    });

    if (req.query.raw === 'true' || req.query.format === 'array') {
      return res.json(formattedData);
    }

    return res.json({
      success: true,
      data: formattedData,
      siswa: formattedData,
      list: formattedData,
      rows: formattedData,
      items: formattedData,
      result: formattedData
    });
  } catch (error) {
    next(error);
  }
});

// GET DETAIL SISWA BY ID
app.get('/api/siswa/:id', async (req, res, next) => {
  try {
    await ensureTablesExist();
    const db = getDb();
    const { id } = req.params;

    const result = await db.execute({
      sql: "SELECT * FROM siswa WHERE id = ? OR nis = ? OR rfid_uid = ? OR uid = ?",
      args: [id, id, id, id]
    });

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Siswa tidak ditemukan." });
    }

    const s = result.rows[0];
    const nama = s.nama || s.nama_siswa || s.name || '';
    const kelas = s.kelas || s.kelas_siswa || s.rombel || '';
    const rfid_uid = s.rfid_uid || s.rfid || s.uid || '';
    const nis = s.nis || s.id || '';
    const studentId = s.id || nis;

    const formattedSiswa = {
      id: studentId,
      nis,
      nama,
      nama_siswa: nama,
      name: nama,
      kelas,
      kelas_siswa: kelas,
      rombel: kelas,
      rfid_uid,
      rfid: rfid_uid,
      uid: rfid_uid
    };

    return res.json({
      success: true,
      data: formattedSiswa,
      siswa: formattedSiswa
    });
  } catch (error) {
    next(error);
  }
});

// SIMPAN & EDIT SISWA (POST / PUT)
async function handleSaveOrUpdateSiswa(req, res, next) {
  try {
    await ensureTablesExist();
    const db = getDb();
    const body = parseRequestBody(req);

    const targetId = req.params.id || body.id || body.siswa_id;
    let nama = cleanStr(body.nama || body.nama_siswa || body.name);
    let kelas = cleanStr(body.kelas || body.kelas_siswa || body.rombel);
    let rfid_uid = sanitizeRfid(body.rfid_uid || body.rfid || body.uid);
    let nis = cleanStr(body.nis || body.id || targetId);

    if (!nama || !kelas) {
      return res.status(400).json({
        success: false,
        message: "Nama dan Kelas wajib diisi!"
      });
    }

    let existingSiswa = null;

    if (targetId) {
      const checkId = await db.execute({
        sql: "SELECT * FROM siswa WHERE id = ? OR nis = ?",
        args: [targetId, targetId]
      });
      if (checkId.rows.length > 0) existingSiswa = checkId.rows[0];
    }

    if (!existingSiswa && rfid_uid) {
      const checkRfid = await db.execute({
        sql: "SELECT * FROM siswa WHERE rfid_uid = ? OR uid = ?",
        args: [rfid_uid, rfid_uid]
      });
      if (checkRfid.rows.length > 0) existingSiswa = checkRfid.rows[0];
    }

    if (!existingSiswa && nis) {
      const checkNis = await db.execute({
        sql: "SELECT * FROM siswa WHERE nis = ? OR id = ?",
        args: [nis, nis]
      });
      if (checkNis.rows.length > 0) existingSiswa = checkNis.rows[0];
    }

    if (existingSiswa) {
      const updateId = existingSiswa.id || existingSiswa.nis;
      const finalNis = nis || existingSiswa.nis || ('NIS-' + Date.now());
      const finalRfid = rfid_uid || existingSiswa.rfid_uid || existingSiswa.uid || finalNis;

      await db.execute({
        sql: "UPDATE siswa SET nama = ?, kelas = ?, rfid_uid = ?, uid = ?, nis = ? WHERE id = ? OR nis = ?",
        args: [nama, kelas, finalRfid, finalRfid, finalNis, updateId, finalNis]
      });

      return res.json({
        success: true,
        message: `Data siswa '${nama}' berhasil diperbarui!`,
        siswa: { id: updateId, nis: finalNis, nama, kelas, rfid_uid: finalRfid },
        data: { id: updateId, nis: finalNis, nama, kelas, rfid_uid: finalRfid }
      });
    } else {
      if (!nis) {
        nis = 'NIS-' + Date.now().toString().slice(-6);
      }
      const cleanRfid = rfid_uid || nis;

      await db.execute({
        sql: "INSERT INTO siswa (nis, nama, kelas, rfid_uid, uid) VALUES (?, ?, ?, ?, ?)",
        args: [nis, nama, kelas, rfid_uid, cleanRfid]
      });

      return res.json({
        success: true,
        message: `Siswa baru '${nama}' berhasil ditambahkan!`,
        siswa: { nis, nama, kelas, rfid_uid: cleanRfid },
        data: { nis, nama, kelas, rfid_uid: cleanRfid }
      });
    }
  } catch (error) {
    console.error("Error Simpan/Edit Siswa:", error.message);
    return res.status(500).json({ success: false, message: `Gagal menyimpan data siswa: ${error.message}` });
  }
}

app.post('/api/siswa', handleSaveOrUpdateSiswa);
app.put('/api/siswa', handleSaveOrUpdateSiswa);
app.post('/api/siswa/:id', handleSaveOrUpdateSiswa);
app.put('/api/siswa/:id', handleSaveOrUpdateSiswa);
app.post('/api/siswa/edit', handleSaveOrUpdateSiswa);
app.post('/api/siswa/update', handleSaveOrUpdateSiswa);

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
        sql: "SELECT * FROM siswa WHERE id = ? OR nis = ? OR rfid_uid = ? OR uid = ?",
        args: [targetIdentifier, targetIdentifier, targetIdentifier, targetIdentifier]
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

    const kelasFilter = req.query.kelas || req.query.kelas_siswa || '';
    const tanggalFilter = req.query.tanggal || req.query.date || '';

    let sql = "SELECT * FROM absensi";
    let args = [];
    let conditions = [];

    if (kelasFilter && kelasFilter.toLowerCase() !== 'semua' && kelasFilter.toLowerCase() !== 'all') {
      conditions.push("(kelas = ? OR kelas LIKE ?)");
      args.push(kelasFilter, `%${kelasFilter}%`);
    }

    if (tanggalFilter) {
      conditions.push("waktu LIKE ?");
      args.push(`%${tanggalFilter}%`);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY waktu DESC, id DESC";

    const result = await db.execute({ sql, args });
    const rows = (result.rows || []).map(a => ({
      id: a.id,
      rfid_uid: a.rfid_uid || a.rfid || a.uid || '',
      rfid: a.rfid_uid || a.rfid || a.uid || '',
      uid: a.rfid_uid || a.rfid || a.uid || '',
      nama: a.nama || a.nama_siswa || '',
      nama_siswa: a.nama || a.nama_siswa || '',
      kelas: a.kelas || a.kelas_siswa || '-',
      kelas_siswa: a.kelas || a.kelas_siswa || '-',
      waktu: a.waktu || '',
      tanggal: a.waktu ? String(a.waktu).split(' ')[0] : '',
      keterangan: a.keterangan || 'Hadir',
      status: a.keterangan || 'Hadir'
    }));

    if (req.query.raw === 'true' || req.query.format === 'array') {
      return res.json(rows);
    }

    return res.json({
      success: true,
      data: rows,
      absensi: rows,
      list: rows,
      rows: rows
    });
  } catch (error) {
    next(error);
  }
}

app.get('/api/absensi', handleGetAbsensi);
app.get('/api/log-absensi', handleGetAbsensi);
app.get('/api/absensi/rekap', handleGetAbsensi);
app.get('/api/rekap', handleGetAbsensi);

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