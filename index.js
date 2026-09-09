const express = require('express');
const path = require('path');

const app = express();

// Middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Helper Parsing & Ekstraksi Data
function extractCellValue(cell) {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'object') {
    if (cell.type === 'null') return null;
    if ('value' in cell) return cell.value;
  }
  return cell;
}

// Driver Database Turso HTTP
async function tursoQuery(stmt, args = []) {
  let url = (process.env.TURSO_DATABASE_URL || '').trim().replace(/^["']|["']$/g, '');
  let token = (process.env.TURSO_AUTH_TOKEN || '').trim().replace(/^["']|["']$/g, '');

  if (!url || !token) {
    throw new Error("Variabel TURSO_DATABASE_URL atau TURSO_AUTH_TOKEN belum dikonfigurasi.");
  }
  
  url = url.replace('libsql://', 'https://').replace(/\/$/, '');

  const formattedArgs = args.map(arg => {
    if (arg === null || arg === undefined) return { type: "null" };
    if (typeof arg === "number") return Number.isInteger(arg) ? { type: "integer", value: String(arg) } : { type: "float", value: arg };
    return { type: "text", value: String(arg) };
  });

  const res = await fetch(`${url}/v2/pipeline`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{ type: 'execute', stmt: { sql: stmt, args: formattedArgs } }, { type: 'close' }]
    })
  });

  if (!res.ok) throw new Error(`Turso Error: ${await res.text()}`);
  
  const json = await res.json();
  const firstResult = json.results?.[0];
  if (firstResult?.type === 'error') throw new Error(firstResult.error?.message || "Query Gagal.");

  const execResult = firstResult?.response?.result;
  if (!execResult) return { rows: [] };

  const cols = execResult.cols ? execResult.cols.map(c => c.name) : [];
  const rows = (execResult.rows || []).map(row => {
    const rowObj = {};
    row.forEach((cell, i) => { rowObj[cols[i]] = extractCellValue(cell); });
    return rowObj;
  });

  return { rows };
}

// Inisialisasi Database
let isDbReady = false;
async function initDb() {
  if (isDbReady) return;
  
  await tursoQuery(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, nama TEXT, role TEXT DEFAULT 'admin');`);
  await tursoQuery(`CREATE TABLE IF NOT EXISTS siswa (id INTEGER PRIMARY KEY AUTOINCREMENT, nis TEXT, nama TEXT, kelas TEXT, rfid_uid TEXT, uid TEXT);`);
  await tursoQuery(`CREATE TABLE IF NOT EXISTS absensi (id INTEGER PRIMARY KEY AUTOINCREMENT, rfid_uid TEXT, nama TEXT, kelas TEXT, waktu DATETIME DEFAULT CURRENT_TIMESTAMP, keterangan TEXT DEFAULT 'Hadir');`);
  
  const checkUser = await tursoQuery("SELECT * FROM users WHERE username = 'admin'");
  if (checkUser.rows.length === 0) {
    await tursoQuery("INSERT INTO users (username, password, nama) VALUES (?, ?, ?)", ['admin', 'admin123', 'Admin Utama']);
  }
  isDbReady = true;
}

// API: Autentikasi
app.post('/api/login', async (req, res) => {
  try {
    await initDb();
    const { username, password } = req.body;
    const result = await tursoQuery("SELECT * FROM users WHERE username = ? AND password = ?", [username, password]);
    
    if (result.rows.length === 0) return res.status(401).json({ success: false, message: "Kredensial salah!" });
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// API: Ambil Data Siswa (Clean API)
app.get('/api/siswa', async (req, res) => {
  try {
    await initDb();
    const result = await tursoQuery("SELECT * FROM siswa ORDER BY nama ASC");
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// API: Simpan / Update Siswa (Bebas Error Duplikasi)
app.post('/api/siswa', async (req, res) => {
  try {
    await initDb();
    let { id, nis, nama, kelas, rfid_uid } = req.body;
    nis = nis || `NIS-${Date.now().toString().slice(-6)}`;
    rfid_uid = rfid_uid || nis;

    if (!nama || !kelas) return res.status(400).json({ success: false, message: "Nama dan Kelas wajib diisi!" });

    if (id) {
      const cekExist = await tursoQuery("SELECT nama FROM siswa WHERE (rfid_uid = ? OR nis = ?) AND id != ?", [rfid_uid, nis, id]);
      if (cekExist.rows.length > 0) return res.status(400).json({ success: false, message: `NIS / RFID sudah dipakai oleh ${cekExist.rows[0].nama}` });
      
      await tursoQuery("UPDATE siswa SET nis = ?, nama = ?, kelas = ?, rfid_uid = ?, uid = ? WHERE id = ?", [nis, nama, kelas, rfid_uid, rfid_uid, id]);
      return res.json({ success: true, message: "Data berhasil diupdate!" });
    } else {
      const cekExist = await tursoQuery("SELECT nama FROM siswa WHERE rfid_uid = ? OR nis = ?", [rfid_uid, nis]);
      if (cekExist.rows.length > 0) return res.status(400).json({ success: false, message: `NIS / RFID sudah dipakai oleh ${cekExist.rows[0].nama}` });

      await tursoQuery("INSERT INTO siswa (nis, nama, kelas, rfid_uid, uid) VALUES (?, ?, ?, ?, ?)", [nis, nama, kelas, rfid_uid, rfid_uid]);
      return res.json({ success: true, message: "Siswa baru berhasil ditambahkan!" });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// API: Hapus Siswa
app.delete('/api/siswa/:id', async (req, res) => {
  try {
    await initDb();
    await tursoQuery("DELETE FROM siswa WHERE id = ?", [req.params.id]);
    res.json({ success: true, message: "Siswa dihapus!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// API: Tap RFID
app.post('/api/tap', async (req, res) => {
  try {
    await initDb();
    const rfid = req.body.rfid_uid;
    if (!rfid) return res.status(400).json({ success: false, message: "Kartu tidak terbaca." });

    const siswa = await tursoQuery("SELECT * FROM siswa WHERE rfid_uid = ? OR uid = ?", [rfid, rfid]);
    if (siswa.rows.length === 0) return res.status(404).json({ success: false, message: `Kartu ${rfid} tidak terdaftar!` });

    await tursoQuery("INSERT INTO absensi (rfid_uid, nama, kelas) VALUES (?, ?, ?)", [rfid, siswa.rows[0].nama, siswa.rows[0].kelas]);
    res.json({ success: true, message: `Presensi Sukses: ${siswa.rows[0].nama}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// API: Data Absensi & Kelas
app.get('/api/absensi', async (req, res) => {
  try {
    await initDb();
    const result = await tursoQuery("SELECT * FROM absensi ORDER BY waktu DESC LIMIT 50");
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/kelas', async (req, res) => {
  try {
    await initDb();
    const result = await tursoQuery("SELECT DISTINCT kelas FROM siswa WHERE kelas != ''");
    const kelasArr = result.rows.map(r => r.kelas);
    const defaultKelas = ["10 IPA 1", "10 IPS 1", "11 IPA 1", "12 IPA 1"];
    res.json({ success: true, data: Array.from(new Set([...defaultKelas, ...kelasArr])) });
  } catch (err) { res.json({ success: true, data: ["10 IPA 1"] }); }
});

// Fallback Frontend
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sistem Berjalan di Port ${PORT}`));