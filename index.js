const express = require('express');
const path = require('path');
const { createClient } = require('@libsql/client');

const app = express();

// Middleware parsing data request
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Folder static untuk file HTML/CSS/JS frontend
app.use(express.static(path.join(__dirname, 'public')));

// Inisialisasi Koneksi Database Turso dari Environment Variable
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || '',
  authToken: process.env.TURSO_AUTH_TOKEN || '',
});

// Route / Endpoint Login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    // Logika verifikasi login ke database Turso
    // Silakan sesuaikan query tabel jika Anda memakai struktur tabel sendiri
    /*
    const result = await db.execute({
      sql: "SELECT * FROM users WHERE username = ? AND password = ?",
      args: [username, password]
    });
    */

    return res.json({ success: true, message: "Login berhasil!" });
  } catch (error) {
    console.error("Error Login:", error);
    return res.status(500).json({ success: false, message: "Terjadi kesalahan server." });
  }
});

// Endpoint pengujian status server
app.get('/api/ping', (req, res) => {
  res.json({ status: "OK", message: "Server aktif!" });
});

// Menjalankan server pada environment lokal
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
  });
}

// WAJIB: Eksport modul agar dikenali Vercel Serverless
module.exports = app;