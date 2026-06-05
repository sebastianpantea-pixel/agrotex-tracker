const express = require('express');
const session = require('express-session');
const SQLiteStoreFactory = require('connect-sqlite3');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
const SQLiteStore = SQLiteStoreFactory(session);

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

const APP_USER = process.env.APP_USER || 'admin';
const APP_PASSWORD_HASH = process.env.APP_PASSWORD_HASH || '';
const LEGACY_APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

if (IS_PROD && !SESSION_SECRET) {
  throw new Error('SESSION_SECRET lipseste. Seteaza SESSION_SECRET in Render Environment.');
}

if (IS_PROD && !APP_PASSWORD_HASH) {
  throw new Error('APP_PASSWORD_HASH lipseste. Seteaza APP_PASSWORD_HASH in Render Environment.');
}

if (TRUST_PROXY) app.set('trust proxy', 1);

// DB setup — Render persistent disk mounts at /data, fallback to local
const DB_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const BACKUP_DIR = path.join(DB_DIR, 'backups');
const dbPath = path.join(DB_DIR, 'agrotex.db');
const sessionDbPath = path.join(DB_DIR, 'sessions.sqlite');

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT,
    deleted_by TEXT
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS target (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(year)
  );

  CREATE TABLE IF NOT EXISTS weather_cache (
    location_name TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS logistics_contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT,
    deleted_by TEXT
  );

  CREATE TABLE IF NOT EXISTS train_contracts (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT,
    deleted_by TEXT
  );

  CREATE TABLE IF NOT EXISTS stock_locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT,
    deleted_by TEXT
  );

  CREATE TABLE IF NOT EXISTS stock_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT,
    deleted_by TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT DEFAULT (datetime('now')),
    user TEXT,
    ip TEXT,
    action TEXT NOT NULL,
    entity TEXT,
    entity_id TEXT,
    details TEXT
  );
`);

// Safe migrations for older databases
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

['trades', 'logistics_contracts', 'train_contracts', 'stock_locations', 'stock_entries'].forEach(table => {
  ensureColumn(table, 'updated_at', 'TEXT');
  ensureColumn(table, 'deleted_at', 'TEXT');
  ensureColumn(table, 'deleted_by', 'TEXT');
  db.prepare(`UPDATE ${table} SET updated_at = COALESCE(updated_at, created_at, datetime('now')) WHERE updated_at IS NULL`).run();
});

const prodRow = db.prepare('SELECT id FROM products LIMIT 1').get();
if (!prodRow) {
  const defaultProducts = JSON.stringify({
    wheat:     { name:'Grâu',             emoji:'🌾', color:'#e2a857', symbol:'WHT' },
    corn:      { name:'Porumb',           emoji:'🌽', color:'#f0c040', symbol:'CRN' },
    rapeseed:  { name:'Rapiță',           emoji:'🌿', color:'#8bc34a', symbol:'RAP' },
    sunflower: { name:'Floarea-soarelui', emoji:'🌻', color:'#ffb300', symbol:'SFW' },
  });
  db.prepare('INSERT INTO products (data) VALUES (?)').run(defaultProducts);
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
}

function audit(req, action, entity, entityId, details = null) {
  try {
    db.prepare(`
      INSERT INTO audit_log (user, ip, action, entity, entity_id, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req?.session?.user || null,
      req ? getClientIp(req) : null,
      action,
      entity || null,
      entityId == null ? null : String(entityId),
      details == null ? null : JSON.stringify(details)
    );
  } catch (err) {
    console.error('Audit log error:', err.message);
  }
}

function safeJsonParse(text, fallback = {}) {
  try { return JSON.parse(text || '{}'); } catch { return fallback; }
}

function sanitizeObjectForStorage(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const copy = { ...obj };
  delete copy.id;
  delete copy._createdAt;
  delete copy._updatedAt;
  delete copy.deleted_at;
  delete copy.deleted_by;
  return copy;
}

function sanitizeTrainContractForStorage(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const copy = { ...obj };
  delete copy._createdAt;
  delete copy._updatedAt;
  delete copy.deleted_at;
  delete copy.deleted_by;
  return copy;
}

function validateId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function validateTrainId(raw) {
  const id = String(raw || '').trim();
  if (!id || id.length > 120) return null;
  if (!/^[a-zA-Z0-9:_\-\.]+$/.test(id)) return null;
  return id;
}

function makeBackup(reason = 'manual') {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const filename = `agrotex-${reason}-${stamp}.db`;
  const target = path.join(BACKUP_DIR, filename);
  db.pragma('wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(dbPath, target);
  return { filename, path: target, createdAt: now.toISOString() };
}

function cleanupBackups(maxFiles = 30) {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.db'))
      .map(f => ({ name: f, full: path.join(BACKUP_DIR, f), stat: fs.statSync(path.join(BACKUP_DIR, f)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

    files.slice(maxFiles).forEach(f => fs.unlinkSync(f.full));
  } catch (err) {
    console.error('Backup cleanup error:', err.message);
  }
}

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));

app.use(session({
  store: new SQLiteStore({ db: path.basename(sessionDbPath), dir: DB_DIR }),
  secret: SESSION_SECRET || 'dev-only-change-me',
  name: 'agrotex.sid',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: 'auto',
    sameSite: 'lax',
    maxAge: 12 * 60 * 60 * 1000,
  },
}));

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Prea multe incercari. Incearca din nou peste cateva minute.' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Prea multe cereri. Incearca din nou imediat.' },
});

app.use('/api', apiLimiter);

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function requireAdmin(req, res, next) {
  if (req.session.authenticated && req.session.role === 'admin') return next();
  res.status(403).json({ error: 'Forbidden' });
}

function requireSameOriginForWrites(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const origin = req.headers.origin;
  const host = req.headers.host;

  if (!origin) return next();

  try {
    const originHost = new URL(origin).host;
    if (originHost === host) return next();
  } catch {}

  return res.status(403).json({ error: 'Cross-origin write blocked' });
}

app.use('/api', requireSameOriginForWrites);

async function passwordMatches(password) {
  if (!password || typeof password !== 'string') return false;

  if (APP_PASSWORD_HASH) {
    return bcrypt.compare(password, APP_PASSWORD_HASH);
  }

  if (!IS_PROD && LEGACY_APP_PASSWORD) {
    return crypto.timingSafeEqual(
      Buffer.from(password),
      Buffer.from(LEGACY_APP_PASSWORD)
    );
  }

  return false;
}

app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { password } = req.body;
    const ok = await passwordMatches(password);

    if (ok) {
      req.session.authenticated = true;
      req.session.user = APP_USER;
      req.session.role = 'admin';
      audit(req, 'login_success', 'auth', APP_USER);
      return res.json({ ok: true, user: APP_USER, role: 'admin' });
    }

    audit(req, 'login_failed', 'auth', APP_USER);
    return res.status(401).json({ error: 'Parola incorecta' });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Login error' });
  }
});

app.post('/api/logout', (req, res) => {
  audit(req, 'logout', 'auth', req.session?.user || null);
  req.session.destroy(() => {
    res.clearCookie('agrotex.sid');
    res.json({ ok: true });
  });
});

app.get('/api/me', (req, res) => {
  res.json({
    authenticated: !!req.session.authenticated,
    user: req.session.user || null,
    role: req.session.role || null,
  });
});

// ── TRADES ───────────────────────────────────────────────────────────────────
app.get('/api/trades', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, data, created_at, updated_at FROM trades WHERE deleted_at IS NULL ORDER BY id DESC').all();
  const trades = rows.map(r => ({ ...safeJsonParse(r.data), id: r.id, _createdAt: r.created_at, _updatedAt: r.updated_at }));
  res.json(trades);
});

app.post('/api/trades', requireAuth, (req, res) => {
  const trade = sanitizeObjectForStorage(req.body);
  const info = db.prepare('INSERT INTO trades (data, created_at, updated_at) VALUES (?, datetime(\'now\'), datetime(\'now\'))').run(JSON.stringify(trade));
  audit(req, 'create', 'trade', info.lastInsertRowid, { trade });
  res.json({ id: info.lastInsertRowid });
});

app.post('/api/trades/bulk', requireAuth, (req, res) => {
  const { trades, mode } = req.body;
  if (!Array.isArray(trades)) return res.status(400).json({ error: 'Invalid' });

  if (mode === 'replace') {
    makeBackup('before-trades-replace');
    cleanupBackups();
  }

  const insert = db.prepare('INSERT INTO trades (data, created_at, updated_at) VALUES (?, datetime(\'now\'), datetime(\'now\'))');
  const many = db.transaction((items) => {
    if (mode === 'replace') {
      db.prepare('UPDATE trades SET deleted_at = datetime(\'now\'), deleted_by = ? WHERE deleted_at IS NULL').run(req.session.user || null);
    }
    for (const t of items) insert.run(JSON.stringify(sanitizeObjectForStorage(t)));
  });

  many(trades);
  audit(req, 'bulk_import', 'trades', null, { count: trades.length, mode: mode || 'append' });
  res.json({ ok: true, count: trades.length });
});

app.put('/api/trades/:id', requireAuth, (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  const before = db.prepare('SELECT data FROM trades WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!before) return res.status(404).json({ error: 'Not found' });

  const trade = sanitizeObjectForStorage(req.body);
  db.prepare('UPDATE trades SET data = ?, updated_at = datetime(\'now\') WHERE id = ?').run(JSON.stringify(trade), id);
  audit(req, 'update', 'trade', id, { before: safeJsonParse(before.data), after: trade });
  res.json({ ok: true });
});

app.delete('/api/trades/:id', requireAuth, (req, res) => {
  const id = validateId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  const info = db.prepare('UPDATE trades SET deleted_at = datetime(\'now\'), deleted_by = ? WHERE id = ? AND deleted_at IS NULL').run(req.session.user || null, id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });

  audit(req, 'soft_delete', 'trade', id);
  res.json({ ok: true });
});
