require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');
const imap = require('imap-simple');
const { simpleParser } = require('mailparser');
const axios = require('axios');

const app = express();
app.use(express.json());

// In-Memory Storage & Queue System
const queue = [];
const jobs = new Map(); // Menyimpan status job berdasarkan ID
let isProcessing = false;

// Management Stok Akun Admin Canva
const adminAccounts = [
  {
    id: "admin_1",
    email: "admin1@domainmu.my.id",
    password: "PasswordAdmin1!",
    quotaRemaining: 100 // Sisa kuota invite/slot tim
  },
  {
    id: "admin_2",
    email: "admin2@domainmu.my.id",
    password: "PasswordAdmin2!",
    quotaRemaining: 50
  }
];

// Helper untuk mengambil akun admin yang masih memiliki stok/kuota aktif
function getAvailableAdmin() {
  return adminAccounts.find(admin => admin.quotaRemaining > 0);
}

// Helper: Polling Email Inbox via IMAP untuk mengambil OTP (Untuk Catch-All IMAP)
async function fetchLatestOTP(targetEmail) {
  const config = {
    imap: {
      user: process.env.MAIL_USER,
      password: process.env.MAIL_PASS,
      host: process.env.MAIL_HOST,
      port: 993,
      tls: true,
      authTimeout: 3000
    }
  };

  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const connection = await imap.connect(config);
      await connection.openBox('INBOX');
      const searchCriteria = ['UNSEEN'];
      const fetchOptions = { bodies: [''], struct: true };
      const results = await connection.search(searchCriteria, fetchOptions);

      for (let item of results) {
        const all = item.parts.find(part => part.which === '');
        const id = item.attributes.uid;
        const idHeader = `Imap-Id: ${id}\r\n`;
        const mail = await simpleParser(idHeader + all.body);

        if (mail.to.text.includes(targetEmail) || mail.text.includes(targetEmail)) {
          const otpMatch = mail.text.match(/\b\d{6}\b/);
          connection.end();
          if (otpMatch) return otpMatch[0];
        }
      }
      connection.end();
    } catch (err) {
      console.error('Error membaca IMAP:', err.message);
    }
  }
  throw new Error('OTP tidak ditemukan dalam batas waktu.');
}

// Helper khusus TempMail.lol (Create Inbox & Fetch OTP)
async function createTempMailLolInbox() {
  const res = await axios.post('https://api.tempmail.lol/v2/inbox/create');
  return {
    address: res.data.address, // Alamat email temp
    token: res.data.token       // Token unik untuk cek inbox
  };
}

async function fetchOtpFromTempMailLol(token) {
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise(r => setTimeout(r, 3000)); // Polling tiap 3 detik
    try {
      const res = await axios.get(`https://api.tempmail.lol/v2/inbox?token=${token}`);
      const emails = res.data.emails;

      if (emails && emails.length > 0) {
        for (let email of emails) {
          const content = email.body || email.html || '';
          const otpMatch = content.match(/\b\d{6}\b/);
          if (otpMatch) return otpMatch[0];
        }
      }
    } catch (err) {
      console.error('Error membaca TempMail.lol API:', err.message);
    }
  }
  throw new Error('OTP TempMail.lol tidak ditemukan dalam batas waktu.');
}

// Worker Processing Queue
async function processQueue() {
  if (queue.length === 0) {
    isProcessing = false;
    return;
  }

  isProcessing = true;
  const jobId = queue.shift();
  const job = jobs.get(jobId);

  if (!job) {
    processQueue();
    return;
  }

  job.status = 'processing';
  job.updatedAt = new Date();

  try {
    const accountData = await processCanvaAccount();
    job.status = 'completed';
    job.result = accountData;
  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
  } finally {
    job.updatedAt = new Date();
    processQueue();
  }
}

// Playwright Automator
async function processCanvaAccount() {
  const currentAdmin = getAvailableAdmin();
  if (!currentAdmin) {
    throw new Error("STOK_ADMIN_HABIS: Semua akun admin sudah mencapai batas kuota invite.");
  }
  console.log(`Menggunakan Admin: ${currentAdmin.email} (Sisa Kuota: ${currentAdmin.quotaRemaining})`);

  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const context = await browser.newContext();
  const page = await context.newPage();

  const useTempMailLol = process.env.USE_TEMPMAIL_LOL === 'true' || true;
  let targetEmail = '';
  let tempMailToken = '';

  if (useTempMailLol) {
    const tempInbox = await createTempMailLolInbox();
    targetEmail = tempInbox.address;
    tempMailToken = tempInbox.token;
    console.log(`TempMail.lol Inbox Dibuat: ${targetEmail}`);
  } else {
    const domain = process.env.MAIL_DOMAIN || 'domainmu.my.id';
    targetEmail = `user_${Math.floor(Math.random() * 100000)}@${domain}`;
  }

  const defaultPassword = 'Branndigitalhub';

  try {
    await page.goto('https://www.canva.com/signup', { waitUntil: 'networkidle' });

    const continueEmailBtn = page.locator('button:has-text("Continue with email")');
    await continueEmailBtn.waitFor({ state: 'visible' });
    await continueEmailBtn.click();

    await page.fill('input[type="email"]', targetEmail);
    await page.click('button[type="submit"]');

    let otpCode = '';
    if (useTempMailLol) {
      otpCode = await fetchOtpFromTempMailLol(tempMailToken);
    } else {
      otpCode = await fetchLatestOTP(targetEmail);
    }
    console.log(`OTP Berhasil Diterima: ${otpCode}`);

    await page.waitForSelector('input[type="text"]', { timeout: 10000 });
    await page.fill('input[type="text"]', otpCode);
    await page.click('button[type="submit"]');

    const nameInput = page.locator('input[name="name"]');
    if (await nameInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await page.fill('input[name="name"]', 'User Member');
      await page.click('button[type="submit"]');
    }

    await browser.close();

    currentAdmin.quotaRemaining -= 1;
    console.log(`Akun berhasil dibuat. Sisa kuota untuk ${currentAdmin.email}: ${currentAdmin.quotaRemaining}`);

    return { email: targetEmail, password: defaultPassword };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// ENDPOINTS API
// 1. Endpoint untuk menambahkan request pembuatan akun
app.post('/api/create', (req, res) => {
  const count = parseInt(req.body.count) || 1;
  const createdJobs = [];

  for (let i = 0; i < count; i++) {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const jobData = {
      id: jobId,
      status: 'queued',
      result: null,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    jobs.set(jobId, jobData);
    queue.push(jobId);
    createdJobs.push(jobId);
  }

  if (!isProcessing) {
    processQueue();
  }

  return res.status(200).json({
    success: true,
    message: `${count} pekerjaan pembuatan akun berhasil ditambahkan ke antrian.`,
    jobs: createdJobs,
    queueLength: queue.length
  });
});

// 2. Endpoint untuk cek status pekerjaan
app.get('/api/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ success: false, message: 'Job ID tidak ditemukan.' });
  }

  return res.status(200).json({ success: true, job });
});

// Endpoints Manajemen Antrian Tambahan
app.get('/api/queue', (req, res) => {
  const activeJobs = Array.from(jobs.values()).filter(j => j.status === 'queued' || j.status === 'processing');
  return res.status(200).json({
    success: true,
    isProcessing,
    totalQueued: queue.length,
    activeJobs
  });
});

app.post('/api/queue/clear', (req, res) => {
  queue.length = 0;
  isProcessing = false;
  return res.status(200).json({
    success: true,
    message: "Seluruh antrian berhasil dibersihkan."
  });
});

// Endpoints Manajemen Stok Admin (Restock & Cek Stok)
app.post('/api/admin/restock', (req, res) => {
  const { email, password, quota } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: "Email dan password admin wajib diisi." });
  }

  const newAdmin = {
    id: `admin_${Date.now()}`,
    email,
    password,
    quotaRemaining: parseInt(quota) || 100
  };

  adminAccounts.push(newAdmin);

  return res.status(200).json({
    success: true,
    message: "Stok akun admin berhasil ditambahkan.",
    data: newAdmin
  });
});

app.get('/api/admin/stock', (req, res) => {
  const totalStock = adminAccounts.reduce((acc, curr) => acc + curr.quotaRemaining, 0);
  return res.status(200).json({
    success: true,
    totalStockRemaining: totalStock,
    accounts: adminAccounts
  });
});

// Endpoint untuk Hapus Akun Admin Bermasalah
app.delete('/api/admin/:id', (req, res) => {
  const { id } = req.params;
  const index = adminAccounts.findIndex(a => a.id === id);

  if (index === -1) {
    return res.status(404).json({ success: false, message: "ID Admin tidak ditemukan." });
  }

  const removed = adminAccounts.splice(index, 1);
  return res.status(200).json({
    success: true,
    message: "Akun admin berhasil dihapus dari sistem.",
    removedAdmin: removed[0]
  });
});

// Endpoint Monitoring Performa Server (Health Check)
app.get('/api/health', (req, res) => {
  const memoryUsage = process.memoryUsage();
  return res.status(200).json({
    status: "healthy",
    uptime: `${Math.floor(process.uptime())} detik`,
    memory: {
      rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
      heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`
    }
  });
});

// FITUR BARU MULAI DI SINI: Visual Admin Dashboard (Interaktif HTML UI)
app.get('/', (req, res) => {
  const totalStock = adminAccounts.reduce((acc, curr) => acc + curr.quotaRemaining, 0);
  const html = `
    <!DOCTYPE html>
    <html lang="id">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Brann Digital Hub - Canva Automator Dashboard</title>
      <style>
        * { box-sizing: border-box; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 0; }
        body { background: #0f172a; color: #f8fafc; padding: 20px; }
        .container { max-width: 1000px; margin: 0 auto; }
        header { text-align: center; margin-bottom: 30px; border-bottom: 1px solid #334155; padding-bottom: 15px; }
        header h1 { color: #38bdf8; font-size: 28px; }
        header p { color: #94a3b8; font-size: 14px; margin-top: 5px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .card { background: #1e293b; border-radius: 12px; padding: 20px; border: 1px solid #334155; shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .card h3 { color: #f1f5f9; font-size: 18px; margin-bottom: 15px; border-bottom: 1px solid #334155; padding-bottom: 8px; }
        .stat-val { font-size: 36px; font-weight: bold; color: #4ade80; text-align: center; margin: 10px 0; }
        form { display: flex; flex-direction: column; gap: 12px; }
        input, button { padding: 10px 14px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #fff; font-size: 14px; }
        input:focus { outline: none; border-color: #38bdf8; }
        button { background: #0284c7; color: #fff; font-weight: bold; border: none; cursor: pointer; transition: 0.2s; }
        button:hover { background: #0369a1; }
        .btn-danger { background: #dc2626; }
        .btn-danger:hover { background: #b91c1c; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { text-align: left; padding: 10px; border-bottom: 1px solid #334155; font-size: 13px; }
        th { color: #94a3b8; background: #0f172a; }
        .badge { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; }
        .badge-success { background: #166534; color: #4ade80; }
        .badge-warning { background: #854d0e; color: #facc15; }
      </style>
    </head>
    <body>
      <div class="container">
        <header>
          <h1>BRANN DIGITAL HUB</h1>
          <p>Canva Automation Server & Management Dashboard</p>
        </header>

        <div class="grid">
          <!-- Card Total Stok -->
          <div class="card">
            <h3>Total Kuota Tersedia</h3>
            <div class="stat-val">${totalStock} Slot</div>
            <p style="text-align:center; color:#94a3b8; font-size:12px;">Aktif memproses antrian via TempMail.lol</p>
          </div>

          <!-- Card Form Restock Admin -->
          <div class="card">
            <h3>+ Restock Admin Canva</h3>
            <form id="restockForm">
              <input type="email" id="adminEmail" placeholder="Email Admin Canva Baru" required>
              <input type="password" id="adminPass" placeholder="Password Admin" required>
              <input type="number" id="adminQuota" placeholder="Kuota Slot Invite (Contoh: 100)" value="100" required>
              <button type="submit">Tambah Stok Admin</button>
            </form>
          </div>
        </div>

        <!-- Tabel Daftar Admin -->
        <div class="card" style="margin-bottom: 20px;">
          <h3>Daftar Stok Akun Admin</h3>
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Email Admin</th>
                <th>Sisa Kuota</th>
                <th>Status</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              ${adminAccounts.map(a => `
                <tr>
                  <td>${a.id}</td>
                  <td>${a.email}</td>
                  <td><b>${a.quotaRemaining}</b> Slot</td>
                  <td>${a.quotaRemaining > 0 ? '<span class="badge badge-success">Ready</span>' : '<span class="badge badge-warning">Habis</span>'}</td>
                  <td><button class="btn-danger" onclick="deleteAdmin('${a.id}')" style="padding:4px 8px; font-size:11px;">Hapus</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <script>
        // Restock Admin Form Submit
        document.getElementById('restockForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const email = document.getElementById('adminEmail').value;
          const password = document.getElementById('adminPass').value;
          const quota = document.getElementById('adminQuota').value;

          const res = await fetch('/api/admin/restock', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, quota })
          });

          const data = await res.json();
          if (data.success) {
            alert('Stok Admin Berhasil Ditambahkan!');
            location.reload();
          } else {
            alert('Gagal: ' + data.message);
          }
        });

        // Hapus Admin
        async function deleteAdmin(id) {
          if (confirm('Yakin ingin menghapus akun admin ini?')) {
            const res = await fetch('/api/admin/' + id, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
              location.reload();
            }
          }
        }
      </script>
    </body>
    </html>
  `;
  res.send(html);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`REST API Server berjalan di port ${PORT}`);
});
// FITUR BARU SELESAI DI SINI
