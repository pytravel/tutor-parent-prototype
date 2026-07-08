const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname);

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..')));

// Database — store in DATA_DIR for persistence
const db = new Database(path.join(DATA_DIR, 'data.db'));
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK(role IN ('parent','student')),
    nickname TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL DEFAULT '',
    city TEXT DEFAULT '',
    avatar TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(phone, role)
  );

  CREATE TABLE IF NOT EXISTS needs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    city TEXT NOT NULL,
    district TEXT DEFAULT '',
    grade TEXT NOT NULL,
    subject TEXT NOT NULL,
    fee INTEGER NOT NULL,
    fee_unit TEXT DEFAULT 'hour',
    location_name TEXT DEFAULT '',
    location_address TEXT DEFAULT '',
    location_lat REAL DEFAULT 0,
    location_lng REAL DEFAULT 0,
    student_info TEXT DEFAULT '',
    requirements TEXT DEFAULT '',
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'active' CHECK(status IN ('active','matched','closed')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    need_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','selected','rejected','cancelled')),
    message TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (need_id) REFERENCES needs(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS resumes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    school TEXT DEFAULT '',
    major TEXT DEFAULT '',
    grade_level TEXT DEFAULT '',
    subjects TEXT DEFAULT '',
    honors TEXT DEFAULT '',
    experience TEXT DEFAULT '',
    intro TEXT DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id INTEGER NOT NULL,
    reviewer_id INTEGER NOT NULL,
    score INTEGER NOT NULL DEFAULT 5 CHECK(score BETWEEN 1 AND 5),
    content TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (target_id) REFERENCES users(id),
    FOREIGN KEY (reviewer_id) REFERENCES users(id)
  );
`);

// Helper: JSON parse fields that may be stored as strings
function parseFields(obj, fields) {
  if (!obj) return obj;
  for (const f of fields) {
    if (obj[f] && typeof obj[f] === 'string') {
      try { obj[f] = JSON.parse(obj[f]); } catch(e) { /* keep as string */ }
    }
  }
  return obj;
}

// ==================== AUTH ====================

// Register: phone + password + role + nickname + city
app.post('/api/auth/register', (req, res) => {
  const { role, nickname, phone, password, city } = req.body;
  if (!role || !nickname || !phone || !password) {
    return res.status(400).json({ error: 'role, nickname, phone, password required' });
  }
  if (role !== 'parent' && role !== 'student') {
    return res.status(400).json({ error: 'role must be parent or student' });
  }

  // Check if phone+role already exists
  const existing = db.prepare('SELECT id FROM users WHERE phone=? AND role=?').get(phone, role);
  if (existing) {
    return res.status(409).json({ error: '该手机号已注册，请直接登录' });
  }

  const stmt = db.prepare('INSERT INTO users (role, nickname, phone, password, city) VALUES (?, ?, ?, ?, ?)');
  const info = stmt.run(role, nickname, phone, password, city || '');
  const user = db.prepare('SELECT id, role, nickname, phone, city, created_at FROM users WHERE id=?').get(info.lastInsertRowid);
  res.json(user);
});

// Login: phone + password + role
app.post('/api/auth/login', (req, res) => {
  const { phone, password, role } = req.body;
  if (!phone || !password || !role) {
    return res.status(400).json({ error: 'phone, password, role required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE phone=? AND role=?').get(phone, role);
  if (!user) {
    return res.status(404).json({ error: '账号不存在，请先注册' });
  }
  if (user.password !== password) {
    return res.status(401).json({ error: '密码错误，请重试' });
  }

  // Return user without password
  const safeUser = { id: user.id, role: user.role, nickname: user.nickname, phone: user.phone, city: user.city, created_at: user.created_at };
  res.json(safeUser);
});

// Get user by id (no password returned)
app.get('/api/users/:id', (req, res) => {
  const user = db.prepare('SELECT id, role, nickname, phone, city, avatar, created_at FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  res.json(user);
});

// ==================== NEEDS ====================

// Create a need (parent publishes demand)
app.post('/api/needs', (req, res) => {
  const { user_id, city, district, grade, subject, fee, fee_unit, location_name, location_address, location_lat, location_lng, student_info, requirements, description } = req.body;
  if (!user_id || !city || !grade || !subject || !fee) {
    return res.status(400).json({ error: 'user_id, city, grade, subject, fee required' });
  }
  const stmt = db.prepare(`INSERT INTO needs (user_id, city, district, grade, subject, fee, fee_unit, location_name, location_address, location_lat, location_lng, student_info, requirements, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const info = stmt.run(user_id, city, district||'', grade, subject, fee, fee_unit||'hour', location_name||'', location_address||'', location_lat||0, location_lng||0, student_info||'', requirements||'', description||'');
  res.json({ id: info.lastInsertRowid, status: 'active', created_at: new Date().toISOString() });
});

// List needs (for students to browse)
app.get('/api/needs', (req, res) => {
  const { city, subject, grade, fee_min, fee_max, status, user_id, page, limit } = req.query;
  let sql = 'SELECT n.*, u.nickname as publisher_name FROM needs n LEFT JOIN users u ON n.user_id=u.id WHERE 1=1';
  const params = [];
  if (user_id) { sql += ' AND n.user_id=?'; params.push(Number(user_id)); }
  if (city) { sql += ' AND n.city=?'; params.push(city); }
  if (subject) { sql += ' AND n.subject=?'; params.push(subject); }
  if (grade) { sql += ' AND n.grade=?'; params.push(grade); }
  if (fee_min) { sql += ' AND n.fee>=?'; params.push(Number(fee_min)); }
  if (fee_max) { sql += ' AND n.fee<=?'; params.push(Number(fee_max)); }
  if (status) { sql += ' AND n.status=?'; params.push(status); }
  else if (!user_id) { sql += ` AND n.status='active'`; }
  sql += ' ORDER BY n.created_at DESC';
  
  const p = Number(page) || 1;
  const l = Number(limit) || 20;
  sql += ` LIMIT ${l} OFFSET ${(p-1)*l}`;
  
  const rows = db.prepare(sql).all(...params);
  // Count applications for each need
  const countStmt = db.prepare('SELECT count(*) as cnt FROM applications WHERE need_id=?');
  for (const row of rows) {
    row.applications_count = countStmt.get(row.id).cnt;
  }
  res.json(rows);
});

// Get need detail (no contact info exposed — platform mediates)
app.get('/api/needs/:id', (req, res) => {
  const row = db.prepare('SELECT n.*, u.nickname as publisher_name FROM needs n LEFT JOIN users u ON n.user_id=u.id WHERE n.id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'need not found' });
  row.applications_count = db.prepare('SELECT count(*) as cnt FROM applications WHERE need_id=?').get(row.id).cnt;
  res.json(row);
});

// Get applications for a need (parent view)
app.get('/api/needs/:id/applications', (req, res) => {
  const rows = db.prepare(`SELECT a.*, u.nickname as applicant_name, u.role as applicant_role
    FROM applications a LEFT JOIN users u ON a.user_id=u.id WHERE a.need_id=? ORDER BY a.created_at DESC`)
    .all(req.params.id);
  // Attach resume info for each student applicant
  for (const row of rows) {
    if (row.applicant_role === 'student') {
      const resume = db.prepare('SELECT * FROM resumes WHERE user_id=?').get(row.user_id);
      row.resume = resume || null;
    }
  }
  res.json(rows);
});

// Update need status
app.patch('/api/needs/:id', (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });
  db.prepare('UPDATE needs SET status=? WHERE id=?').run(status, req.params.id);
  res.json({ id: req.params.id, status });
});

// ==================== APPLICATIONS ====================

// Create application (student applies)
app.post('/api/applications', (req, res) => {
  const { need_id, user_id, message } = req.body;
  if (!need_id || !user_id) return res.status(400).json({ error: 'need_id and user_id required' });
  // Check duplicate
  const existing = db.prepare('SELECT * FROM applications WHERE need_id=? AND user_id=?').get(need_id, user_id);
  if (existing) return res.status(409).json({ error: 'already applied', application: existing });
  
  // Check need status: if matched/closed, auto-reject
  const need = db.prepare('SELECT status FROM needs WHERE id=?').get(need_id);
  if (need && need.status !== 'active') {
    const stmt = db.prepare(`INSERT INTO applications (need_id, user_id, message, status) VALUES (?, ?, ?, 'rejected')`);
    const info = stmt.run(need_id, user_id, message || '');
    return res.json({ id: info.lastInsertRowid, status: 'rejected', reason: '需求已' + (need.status === 'matched' ? '匹配' : '关闭'), created_at: new Date().toISOString() });
  }
  
  const stmt = db.prepare(`INSERT INTO applications (need_id, user_id, message, status) VALUES (?, ?, ?, 'pending')`);
  const info = stmt.run(need_id, user_id, message || '');
  res.json({ id: info.lastInsertRowid, status: 'pending', created_at: new Date().toISOString() });
});

// List applications for a user (student's own applications)
app.get('/api/applications', (req, res) => {
  const { user_id, status } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  let sql = `SELECT a.*, n.city, n.grade, n.subject, n.fee, n.fee_unit, n.student_info, n.requirements, n.description, n.location_name, n.status as need_status, u.nickname as publisher_name
    FROM applications a 
    LEFT JOIN needs n ON a.need_id=n.id 
    LEFT JOIN users u ON n.user_id=u.id 
    WHERE a.user_id=?`;
  const params = [Number(user_id)];
  if (status) { sql += ' AND a.status=?'; params.push(status); }
  sql += ' ORDER BY a.created_at DESC';
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// Update application status (parent selects/rejects)
app.patch('/api/applications/:id', (req, res) => {
  const { status } = req.body;
  if (!['selected','rejected','cancelled'].includes(status)) return res.status(400).json({ error: 'status must be selected/rejected/cancelled' });
  db.prepare('UPDATE applications SET status=? WHERE id=?').run(status, req.params.id);
  // If selected, mark need as matched
  if (status === 'selected') {
    const app = db.prepare('SELECT need_id FROM applications WHERE id=?').get(req.params.id);
    if (app) {
      db.prepare(`UPDATE needs SET status='matched' WHERE id=?`).run(app.need_id);
      // Reject all other pending applications for this need
      db.prepare(`UPDATE applications SET status='rejected' WHERE need_id=? AND id!=? AND status='pending'`).run(app.need_id, req.params.id);
    }
  }
  res.json({ id: req.params.id, status });
});

// ==================== RESUMES ====================

// Create or update resume
app.post('/api/resumes', (req, res) => {
  const { user_id, school, major, grade_level, subjects, honors, experience, intro } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  
  const existing = db.prepare('SELECT * FROM resumes WHERE user_id=?').get(user_id);
  if (existing) {
    db.prepare(`UPDATE resumes SET school=?, major=?, grade_level=?, subjects=?, honors=?, experience=?, intro=?, updated_at=CURRENT_TIMESTAMP WHERE user_id=?`)
      .run(school||'', major||'', grade_level||'', subjects||'', honors||'', experience||'', intro||'', user_id);
    res.json({ ...existing, school, major, grade_level, subjects, honors, experience, intro, updated_at: new Date().toISOString() });
  } else {
    const stmt = db.prepare('INSERT INTO resumes (user_id, school, major, grade_level, subjects, honors, experience, intro) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const info = stmt.run(user_id, school||'', major||'', grade_level||'', subjects||'', honors||'', experience||'', intro||'');
    res.json({ id: info.lastInsertRowid, user_id, school, major, grade_level, subjects, honors, experience, intro });
  }
});

// Get resume
app.get('/api/resumes/:user_id', (req, res) => {
  const resume = db.prepare('SELECT * FROM resumes WHERE user_id=?').get(req.params.user_id);
  if (!resume) return res.json(null);
  res.json(parseFields(resume, ['subjects']));
});

// ==================== REVIEWS ====================

// Create review (parent reviews a student/teacher)
app.post('/api/reviews', (req, res) => {
  const { target_id, reviewer_id, score, content } = req.body;
  if (!target_id || !reviewer_id || !score) return res.status(400).json({ error: 'target_id, reviewer_id, score required' });
  if (score < 1 || score > 5) return res.status(400).json({ error: 'score must be 1-5' });
  const stmt = db.prepare('INSERT INTO reviews (target_id, reviewer_id, score, content) VALUES (?, ?, ?, ?)');
  const info = stmt.run(target_id, reviewer_id, score, content || '');
  res.json({ id: info.lastInsertRowid, target_id, reviewer_id, score, content, created_at: new Date().toISOString() });
});

// Get reviews for a target user (with avg score and count)
app.get('/api/reviews', (req, res) => {
  const { target_id } = req.query;
  if (!target_id) return res.status(400).json({ error: 'target_id required' });

  const stats = db.prepare('SELECT AVG(score) as avg_score, COUNT(*) as count FROM reviews WHERE target_id=?').get(Number(target_id));
  const reviews = db.prepare(`SELECT r.*, u.nickname as reviewer_name FROM reviews r LEFT JOIN users u ON r.reviewer_id=u.id WHERE r.target_id=? ORDER BY r.created_at DESC LIMIT 10`).all(Number(target_id));

  res.json({
    avg_score: stats.avg_score ? Math.round(stats.avg_score * 10) / 10 : 5.0,
    count: stats.count || 0,
    reviews: reviews || []
  });
});

// ==================== ADMIN AUTH ====================
const ADMIN_PIN = process.env.ADMIN_PIN || '9527';
app.post('/api/admin/auth', (req, res) => {
  const { pin } = req.body || {};
  if (pin === ADMIN_PIN) res.json({ ok: true });
  else res.status(401).json({ error: 'PIN 错误' });
});
app.use('/api/admin', (req, res, next) => {
  if (req.path === '/auth') return next();
  const pin = req.headers['x-admin-pin'] || req.query.admin_pin;
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: '未授权，请输入管理 PIN' });
  next();
});

// ==================== ADMIN ====================

// Dashboard stats
app.get('/api/admin/stats', (req, res) => {
  const totalUsers = db.prepare('SELECT count(*) as cnt FROM users').get().cnt;
  const totalParents = db.prepare(`SELECT count(*) as cnt FROM users WHERE role='parent'`).get().cnt;
  const totalStudents = db.prepare(`SELECT count(*) as cnt FROM users WHERE role='student'`).get().cnt;
  const totalNeeds = db.prepare('SELECT count(*) as cnt FROM needs').get().cnt;
  const activeNeeds = db.prepare(`SELECT count(*) as cnt FROM needs WHERE status='active'`).get().cnt;
  const totalApplications = db.prepare('SELECT count(*) as cnt FROM applications').get().cnt;
  const pendingApplications = db.prepare(`SELECT count(*) as cnt FROM applications WHERE status='pending'`).get().cnt;
  const selectedApplications = db.prepare(`SELECT count(*) as cnt FROM applications WHERE status='selected'`).get().cnt;
  const avgFee = db.prepare(`SELECT AVG(fee) as avg FROM needs WHERE status='active'`).get().avg || 0;
  const totalFees = db.prepare('SELECT SUM(fee) as total FROM needs').get().total || 0;
  
  // Recent activity (last 7 days)
  const recent7 = db.prepare(`SELECT count(*) as cnt FROM needs WHERE created_at >= datetime('now', '-7 days')`).get().cnt;
  const recent7Apps = db.prepare(`SELECT count(*) as cnt FROM applications WHERE created_at >= datetime('now', '-7 days')`).get().cnt;
  
  // Subject distribution
  const subjectDist = db.prepare('SELECT subject, count(*) as cnt FROM needs GROUP BY subject ORDER BY cnt DESC').all();
  // Grade distribution
  const gradeDist = db.prepare('SELECT grade, count(*) as cnt FROM needs GROUP BY grade ORDER BY cnt DESC').all();
  // City distribution
  const cityDist = db.prepare('SELECT city, count(*) as cnt FROM needs GROUP BY city ORDER BY cnt DESC').all();
  
  res.json({
    totalUsers, totalParents, totalStudents,
    totalNeeds, activeNeeds,
    totalApplications, pendingApplications, selectedApplications,
    avgFee: Math.round(avgFee), totalFees,
    recent7, recent7Apps,
    subjectDist, gradeDist, cityDist
  });
});

// Admin: all needs with filters
app.get('/api/admin/needs', (req, res) => {
  const { status, city, subject, page, limit } = req.query;
  let sql = 'SELECT n.*, u.nickname as publisher_name FROM needs n LEFT JOIN users u ON n.user_id=u.id WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND n.status=?'; params.push(status); }
  if (city) { sql += ' AND n.city=?'; params.push(city); }
  if (subject) { sql += ' AND n.subject=?'; params.push(subject); }
  sql += ' ORDER BY n.created_at DESC';
  const p = Number(page) || 1;
  const l = Number(limit) || 50;
  sql += ` LIMIT ${l} OFFSET ${(p-1)*l}`;
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// Admin: all applications
app.get('/api/admin/applications', (req, res) => {
  const { status, page, limit } = req.query;
  let sql = `SELECT a.*, u.nickname as applicant_name, u.role as applicant_role, n.city, n.grade, n.subject, n.fee, pu.nickname as parent_name
    FROM applications a 
    LEFT JOIN users u ON a.user_id=u.id 
    LEFT JOIN needs n ON a.need_id=n.id 
    LEFT JOIN users pu ON n.user_id=pu.id 
    WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND a.status=?'; params.push(status); }
  sql += ' ORDER BY a.created_at DESC';
  const p = Number(page) || 1;
  const l = Number(limit) || 50;
  sql += ` LIMIT ${l} OFFSET ${(p-1)*l}`;
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// Admin: all users (no password)
app.get('/api/admin/users', (req, res) => {
  const rows = db.prepare('SELECT id, role, nickname, phone, city, avatar, created_at FROM users ORDER BY created_at DESC').all();
  // Attach resume/student-specific info
  for (const row of rows) {
    if (row.role === 'student') {
      const resume = db.prepare('SELECT school, major, grade_level, subjects FROM resumes WHERE user_id=?').get(row.id);
      row.resume_summary = resume || null;
    }
    row.needs_count = db.prepare('SELECT count(*) as cnt FROM needs WHERE user_id=?').get(row.id).cnt;
    row.applications_count = db.prepare('SELECT count(*) as cnt FROM applications WHERE user_id=?').get(row.id).cnt;
  }
  res.json(rows);
});

// Admin: export CSV
app.get('/api/admin/export/:table', (req, res) => {
  const table = req.params.table;
  const allowed = ['users', 'needs', 'applications', 'resumes'];
  if (!allowed.includes(table)) return res.status(400).json({ error: 'invalid table' });

  // For users table, exclude password column
  if (table === 'users') {
    const rows = db.prepare('SELECT id, role, nickname, phone, city, avatar, created_at FROM users').all();
    if (rows.length === 0) return res.send('');
    const headers = Object.keys(rows[0]);
    const csvLines = [
      headers.join(','),
      ...rows.map(r => headers.map(h => {
        let val = r[h] || '';
        if (typeof val === 'string' && (val.includes(',') || val.includes('"') || val.includes('\n'))) {
          val = '"' + val.replace(/"/g, '""') + '"';
        }
        return val;
      }).join(','))
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=${table}_${new Date().toISOString().slice(0,10)}.csv`);
    return res.send(csvLines.join('\n'));
  }

  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  if (rows.length === 0) return res.send('');
  
  const headers = Object.keys(rows[0]);
  const csvLines = [
    headers.join(','),
    ...rows.map(r => headers.map(h => {
      let val = r[h] || '';
      if (typeof val === 'string' && (val.includes(',') || val.includes('"') || val.includes('\n'))) {
        val = '"' + val.replace(/"/g, '""') + '"';
      }
      return val;
    }).join(','))
  ];
  
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=${table}_${new Date().toISOString().slice(0,10)}.csv`);
  res.send(csvLines.join('\n'));
});

// Catch-all: serve index.html for non-API routes (Express 5 compatible)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  // Try to serve static files first (already handled by express.static)
  // If not found, serve index.html for SPA routing
  const filePath = path.join(__dirname, '..', req.path);
  res.sendFile(filePath, (err) => {
    if (err) {
      res.sendFile(path.join(__dirname, '..', 'index.html'));
    }
  });
});

app.listen(PORT, () => {
  console.log(`学霸直聘 backend running on http://localhost:${PORT}`);
});
