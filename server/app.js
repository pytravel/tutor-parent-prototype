const express = require('express');
const { createClient } = require('@libsql/client');
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

// ==================== DATABASE ====================
// Turso cloud database (production) or local file (development)
const dbUrl = process.env.TURSO_DB_URL || `file:${path.join(DATA_DIR, 'data.db')}`;
const dbAuthToken = process.env.TURSO_AUTH_TOKEN || undefined;
const db = createClient(dbAuthToken ? { url: dbUrl, authToken: dbAuthToken } : { url: dbUrl });

// Convert BigInt values to Number (libsql returns BigInt for integers)
function normalizeRow(row) {
  if (!row) return row;
  const result = {};
  for (const [key, value] of Object.entries(row)) {
    result[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return result;
}

function normalizeRows(rows) {
  return (rows || []).map(normalizeRow);
}

// Helper: get single row
async function getOne(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows.length > 0 ? normalizeRow(result.rows[0]) : null;
}

// Helper: get multiple rows
async function getMany(sql, args = []) {
  const result = await db.execute({ sql, args });
  return normalizeRows(result.rows);
}

// Helper: run statement and return lastInsertRowid
async function runStmt(sql, args = []) {
  const result = await db.execute({ sql, args });
  return { lastInsertRowid: result.lastInsertRowid ? Number(result.lastInsertRowid) : null, changes: result.changes };
}

// ==================== INIT TABLES ====================
async function initDB() {
  // Create tables one by one (libsql executes single statements)
  await db.execute(`
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
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS needs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      city TEXT NOT NULL,
      district TEXT DEFAULT '',
      grade TEXT NOT NULL,
      subject TEXT NOT NULL,
      fee INTEGER NOT NULL,
      fee_unit TEXT DEFAULT 'hour',
      schedule TEXT DEFAULT '',
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
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      need_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','selected','rejected','cancelled')),
      message TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (need_id) REFERENCES needs(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS resumes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      school TEXT DEFAULT '',
      major TEXT DEFAULT '',
      grade_level TEXT DEFAULT '',
      gender TEXT DEFAULT '',
      subjects TEXT DEFAULT '',
      honors TEXT DEFAULT '',
      experience TEXT DEFAULT '',
      intro TEXT DEFAULT '',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id INTEGER NOT NULL,
      reviewer_id INTEGER NOT NULL,
      score INTEGER NOT NULL DEFAULT 5 CHECK(score BETWEEN 1 AND 5),
      content TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (target_id) REFERENCES users(id),
      FOREIGN KEY (reviewer_id) REFERENCES users(id)
    )
  `);

  // Migration: add columns if not exists
  await addColumnIfNotExists('resumes', 'gender', "TEXT DEFAULT ''");
  await addColumnIfNotExists('needs', 'schedule', "TEXT DEFAULT ''");

  console.log('Database tables initialized.');
}

// Migration helper: add column if not exists
async function addColumnIfNotExists(table, column, type) {
  try {
    const result = await db.execute(`PRAGMA table_info(${table})`);
    const cols = normalizeRows(result.rows);
    if (!cols.find(c => c.name === column)) {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      console.log(`Migration: added column ${table}.${column}`);
    }
  } catch (e) {
    console.log(`Migration check for ${table}.${column}:`, e.message);
  }
}

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

// Async error wrapper
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ==================== AUTH ====================

// Register: phone + password + role + nickname + city
app.post('/api/auth/register', asyncHandler(async (req, res) => {
  const { role, nickname, phone, password, city } = req.body;
  if (!role || !nickname || !phone || !password) {
    return res.status(400).json({ error: 'role, nickname, phone, password required' });
  }
  if (role !== 'parent' && role !== 'student') {
    return res.status(400).json({ error: 'role must be parent or student' });
  }

  const existing = await getOne('SELECT id FROM users WHERE phone=? AND role=?', [phone, role]);
  if (existing) {
    return res.status(409).json({ error: '该手机号已注册，请直接登录' });
  }

  const info = await runStmt('INSERT INTO users (role, nickname, phone, password, city) VALUES (?, ?, ?, ?, ?)', [role, nickname, phone, password, city || '']);
  const user = await getOne('SELECT id, role, nickname, phone, city, created_at FROM users WHERE id=?', [info.lastInsertRowid]);
  res.json(user);
}));

// Login: phone + password + role
app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { phone, password, role } = req.body;
  if (!phone || !password || !role) {
    return res.status(400).json({ error: 'phone, password, role required' });
  }

  const user = await getOne('SELECT * FROM users WHERE phone=? AND role=?', [phone, role]);
  if (!user) {
    return res.status(404).json({ error: '账号不存在，请先注册' });
  }
  if (user.password !== password) {
    return res.status(401).json({ error: '密码错误，请重试' });
  }

  const safeUser = { id: user.id, role: user.role, nickname: user.nickname, phone: user.phone, city: user.city, created_at: user.created_at };
  res.json(safeUser);
}));

// Get user by id (no password returned)
app.get('/api/users/:id', asyncHandler(async (req, res) => {
  const user = await getOne('SELECT id, role, nickname, phone, city, avatar, created_at FROM users WHERE id=?', [Number(req.params.id)]);
  if (!user) return res.status(404).json({ error: 'user not found' });
  res.json(user);
}));

// ==================== NEEDS ====================

// Create a need (parent publishes demand)
app.post('/api/needs', asyncHandler(async (req, res) => {
  const { user_id, city, district, grade, subject, fee, fee_unit, schedule, location_name, location_address, location_lat, location_lng, student_info, requirements, description } = req.body;
  if (!user_id || !city || !grade || !subject || !fee) {
    return res.status(400).json({ error: 'user_id, city, grade, subject, fee required' });
  }
  const info = await runStmt(
    `INSERT INTO needs (user_id, city, district, grade, subject, fee, fee_unit, schedule, location_name, location_address, location_lat, location_lng, student_info, requirements, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [user_id, city, district||'', grade, subject, fee, fee_unit||'hour', schedule||'', location_name||'', location_address||'', location_lat||0, location_lng||0, student_info||'', requirements||'', description||'']
  );
  res.json({ id: info.lastInsertRowid, status: 'active', created_at: new Date().toISOString() });
}));

// List needs (for students to browse)
app.get('/api/needs', asyncHandler(async (req, res) => {
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

  const rows = await getMany(sql, params);
  // Count applications for each need
  for (const row of rows) {
    const countRow = await getOne('SELECT count(*) as cnt FROM applications WHERE need_id=?', [row.id]);
    row.applications_count = countRow ? countRow.cnt : 0;
  }
  res.json(rows);
}));

// Get need detail (no contact info exposed — platform mediates)
app.get('/api/needs/:id', asyncHandler(async (req, res) => {
  const row = await getOne('SELECT n.*, u.nickname as publisher_name FROM needs n LEFT JOIN users u ON n.user_id=u.id WHERE n.id=?', [Number(req.params.id)]);
  if (!row) return res.status(404).json({ error: 'need not found' });
  const countRow = await getOne('SELECT count(*) as cnt FROM applications WHERE need_id=?', [row.id]);
  row.applications_count = countRow ? countRow.cnt : 0;
  res.json(row);
}));

// Get applications for a need (parent view)
app.get('/api/needs/:id/applications', asyncHandler(async (req, res) => {
  const rows = await getMany(
    `SELECT a.*, u.nickname as applicant_name, u.role as applicant_role
    FROM applications a LEFT JOIN users u ON a.user_id=u.id WHERE a.need_id=? ORDER BY a.created_at DESC`,
    [Number(req.params.id)]
  );
  // Attach resume info for each student applicant
  for (const row of rows) {
    if (row.applicant_role === 'student') {
      const resume = await getOne('SELECT * FROM resumes WHERE user_id=?', [row.user_id]);
      row.resume = resume || null;
    }
  }
  res.json(rows);
}));

// Update need status
app.patch('/api/needs/:id', asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });
  await runStmt('UPDATE needs SET status=? WHERE id=?', [status, Number(req.params.id)]);
  res.json({ id: Number(req.params.id), status });
}));

// ==================== APPLICATIONS ====================

// Create application (student applies)
app.post('/api/applications', asyncHandler(async (req, res) => {
  const { need_id, user_id, message } = req.body;
  if (!need_id || !user_id) return res.status(400).json({ error: 'need_id and user_id required' });
  // Check duplicate
  const existing = await getOne('SELECT * FROM applications WHERE need_id=? AND user_id=?', [need_id, user_id]);
  if (existing) return res.status(409).json({ error: 'already applied', application: existing });

  // Check need status: if matched/closed, auto-reject
  const need = await getOne('SELECT status FROM needs WHERE id=?', [need_id]);
  if (need && need.status !== 'active') {
    const info = await runStmt(
      `INSERT INTO applications (need_id, user_id, message, status) VALUES (?, ?, ?, 'rejected')`,
      [need_id, user_id, message || '']
    );
    return res.json({ id: info.lastInsertRowid, status: 'rejected', reason: '需求已' + (need.status === 'matched' ? '匹配' : '关闭'), created_at: new Date().toISOString() });
  }

  const info = await runStmt(
    `INSERT INTO applications (need_id, user_id, message, status) VALUES (?, ?, ?, 'pending')`,
    [need_id, user_id, message || '']
  );
  res.json({ id: info.lastInsertRowid, status: 'pending', created_at: new Date().toISOString() });
}));

// List applications for a user (student's own applications)
app.get('/api/applications', asyncHandler(async (req, res) => {
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
  const rows = await getMany(sql, params);
  res.json(rows);
}));

// Update application status (parent selects/rejects)
app.patch('/api/applications/:id', asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['selected','rejected','cancelled'].includes(status)) return res.status(400).json({ error: 'status must be selected/rejected/cancelled' });
  await runStmt('UPDATE applications SET status=? WHERE id=?', [status, Number(req.params.id)]);
  // If selected, mark need as matched
  if (status === 'selected') {
    const app = await getOne('SELECT need_id FROM applications WHERE id=?', [Number(req.params.id)]);
    if (app) {
      await runStmt(`UPDATE needs SET status='matched' WHERE id=?`, [app.need_id]);
      // Reject all other pending applications for this need
      await runStmt(`UPDATE applications SET status='rejected' WHERE need_id=? AND id!=? AND status='pending'`, [app.need_id, Number(req.params.id)]);
    }
  }
  res.json({ id: Number(req.params.id), status });
}));

// ==================== RESUMES ====================

// Create or update resume
app.post('/api/resumes', asyncHandler(async (req, res) => {
  const { user_id, school, major, grade_level, gender, subjects, honors, experience, intro } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  const existing = await getOne('SELECT * FROM resumes WHERE user_id=?', [user_id]);
  if (existing) {
    await runStmt(
      `UPDATE resumes SET school=?, major=?, grade_level=?, gender=?, subjects=?, honors=?, experience=?, intro=?, updated_at=CURRENT_TIMESTAMP WHERE user_id=?`,
      [school||'', major||'', grade_level||'', gender||'', subjects||'', honors||'', experience||'', intro||'', user_id]
    );
    res.json({ ...existing, school, major, grade_level, gender, subjects, honors, experience, intro, updated_at: new Date().toISOString() });
  } else {
    const info = await runStmt(
      'INSERT INTO resumes (user_id, school, major, grade_level, gender, subjects, honors, experience, intro) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [user_id, school||'', major||'', grade_level||'', gender||'', subjects||'', honors||'', experience||'', intro||'']
    );
    res.json({ id: info.lastInsertRowid, user_id, school, major, grade_level, gender, subjects, honors, experience, intro });
  }
}));

// Get resume
app.get('/api/resumes/:user_id', asyncHandler(async (req, res) => {
  const resume = await getOne('SELECT * FROM resumes WHERE user_id=?', [Number(req.params.user_id)]);
  if (!resume) return res.json(null);
  res.json(parseFields(resume, ['subjects']));
}));

// ==================== REVIEWS ====================

// Create review (parent reviews a student/teacher)
app.post('/api/reviews', asyncHandler(async (req, res) => {
  const { target_id, reviewer_id, score, content } = req.body;
  if (!target_id || !reviewer_id || !score) return res.status(400).json({ error: 'target_id, reviewer_id, score required' });
  if (score < 1 || score > 5) return res.status(400).json({ error: 'score must be 1-5' });
  const info = await runStmt(
    'INSERT INTO reviews (target_id, reviewer_id, score, content) VALUES (?, ?, ?, ?)',
    [target_id, reviewer_id, score, content || '']
  );
  res.json({ id: info.lastInsertRowid, target_id, reviewer_id, score, content, created_at: new Date().toISOString() });
}));

// Get reviews for a target user (with avg score and count)
app.get('/api/reviews', asyncHandler(async (req, res) => {
  const { target_id } = req.query;
  if (!target_id) return res.status(400).json({ error: 'target_id required' });

  const stats = await getOne('SELECT AVG(score) as avg_score, COUNT(*) as count FROM reviews WHERE target_id=?', [Number(target_id)]);
  const reviews = await getMany(
    `SELECT r.*, u.nickname as reviewer_name FROM reviews r LEFT JOIN users u ON r.reviewer_id=u.id WHERE r.target_id=? ORDER BY r.created_at DESC LIMIT 10`,
    [Number(target_id)]
  );

  res.json({
    avg_score: stats && stats.avg_score ? Math.round(stats.avg_score * 10) / 10 : 5.0,
    count: stats ? stats.count : 0,
    reviews: reviews || []
  });
}));

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
app.get('/api/admin/stats', asyncHandler(async (req, res) => {
  const totalUsers = await getOne('SELECT count(*) as cnt FROM users');
  const totalParents = await getOne(`SELECT count(*) as cnt FROM users WHERE role='parent'`);
  const totalStudents = await getOne(`SELECT count(*) as cnt FROM users WHERE role='student'`);
  const totalNeeds = await getOne('SELECT count(*) as cnt FROM needs');
  const activeNeeds = await getOne(`SELECT count(*) as cnt FROM needs WHERE status='active'`);
  const totalApplications = await getOne('SELECT count(*) as cnt FROM applications');
  const pendingApplications = await getOne(`SELECT count(*) as cnt FROM applications WHERE status='pending'`);
  const selectedApplications = await getOne(`SELECT count(*) as cnt FROM applications WHERE status='selected'`);
  const avgFeeRow = await getOne(`SELECT AVG(fee) as avg FROM needs WHERE status='active'`);
  const totalFeesRow = await getOne('SELECT SUM(fee) as total FROM needs');

  // Recent activity (last 7 days)
  const recent7 = await getOne(`SELECT count(*) as cnt FROM needs WHERE created_at >= datetime('now', '-7 days')`);
  const recent7Apps = await getOne(`SELECT count(*) as cnt FROM applications WHERE created_at >= datetime('now', '-7 days')`);

  // Subject distribution
  const subjectDist = await getMany('SELECT subject, count(*) as cnt FROM needs GROUP BY subject ORDER BY cnt DESC');
  // Grade distribution
  const gradeDist = await getMany('SELECT grade, count(*) as cnt FROM needs GROUP BY grade ORDER BY cnt DESC');
  // City distribution
  const cityDist = await getMany('SELECT city, count(*) as cnt FROM needs GROUP BY city ORDER BY cnt DESC');

  res.json({
    totalUsers: totalUsers ? totalUsers.cnt : 0,
    totalParents: totalParents ? totalParents.cnt : 0,
    totalStudents: totalStudents ? totalStudents.cnt : 0,
    totalNeeds: totalNeeds ? totalNeeds.cnt : 0,
    activeNeeds: activeNeeds ? activeNeeds.cnt : 0,
    totalApplications: totalApplications ? totalApplications.cnt : 0,
    pendingApplications: pendingApplications ? pendingApplications.cnt : 0,
    selectedApplications: selectedApplications ? selectedApplications.cnt : 0,
    avgFee: avgFeeRow && avgFeeRow.avg ? Math.round(avgFeeRow.avg) : 0,
    totalFees: totalFeesRow && totalFeesRow.total ? totalFeesRow.total : 0,
    recent7: recent7 ? recent7.cnt : 0,
    recent7Apps: recent7Apps ? recent7Apps.cnt : 0,
    subjectDist, gradeDist, cityDist
  });
}));

// Admin: all needs with filters
app.get('/api/admin/needs', asyncHandler(async (req, res) => {
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
  const rows = await getMany(sql, params);
  res.json(rows);
}));

// Admin: all applications
app.get('/api/admin/applications', asyncHandler(async (req, res) => {
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
  const rows = await getMany(sql, params);
  res.json(rows);
}));

// Admin: all users (no password)
app.get('/api/admin/users', asyncHandler(async (req, res) => {
  const rows = await getMany('SELECT id, role, nickname, phone, city, avatar, created_at FROM users ORDER BY created_at DESC');
  // Attach resume/student-specific info
  for (const row of rows) {
    if (row.role === 'student') {
      const resume = await getOne('SELECT school, major, grade_level, gender, subjects FROM resumes WHERE user_id=?', [row.id]);
      row.resume_summary = resume || null;
    }
    const needsCount = await getOne('SELECT count(*) as cnt FROM needs WHERE user_id=?', [row.id]);
    row.needs_count = needsCount ? needsCount.cnt : 0;
    const appsCount = await getOne('SELECT count(*) as cnt FROM applications WHERE user_id=?', [row.id]);
    row.applications_count = appsCount ? appsCount.cnt : 0;
  }
  res.json(rows);
}));

// Admin: export CSV
app.get('/api/admin/export/:table', asyncHandler(async (req, res) => {
  const table = req.params.table;
  const allowed = ['users', 'needs', 'applications', 'resumes'];
  if (!allowed.includes(table)) return res.status(400).json({ error: 'invalid table' });

  // For users table, exclude password column
  let rows;
  if (table === 'users') {
    rows = await getMany('SELECT id, role, nickname, phone, city, avatar, created_at FROM users');
  } else {
    rows = await getMany(`SELECT * FROM ${table}`);
  }

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
}));

// Health check endpoint (must be before catch-all)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Catch-all: serve index.html for non-API routes (Express 5 compatible)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  const filePath = path.join(__dirname, '..', req.path);
  res.sendFile(filePath, (err) => {
    if (err) {
      res.sendFile(path.join(__dirname, '..', 'index.html'));
    }
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: '服务器内部错误', detail: err.message });
});

// ==================== START SERVER ====================
async function start() {
  try {
    await initDB();
    app.listen(PORT, () => {
      console.log(`学霸直聘 backend running on http://localhost:${PORT}`);
      console.log(`Database: ${dbUrl.startsWith('file:') ? 'local file' : 'Turso cloud'}`);
    });
  } catch (e) {
    console.error('Failed to start server:', e);
    process.exit(1);
  }
}

start();
