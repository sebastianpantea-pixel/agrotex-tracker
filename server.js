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
  // SQLite nu permite ALTER TABLE ADD COLUMN cu DEFAULT datetime('now').
  // De aceea adăugăm coloana simplu și completăm valorile existente separat.
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

function validateId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
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

  // Development-only legacy fallback. Do not use in production.
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

// ── PRODUCTS ─────────────────────────────────────────────────────────────────
app.get('/api/products', requireAuth, (req, res) => {
  const row = db.prepare('SELECT data FROM products LIMIT 1').get();
  res.json(safeJsonParse(row?.data, {}));
});

app.put('/api/products', requireAuth, (req, res) => {
  const before = db.prepare('SELECT data FROM products LIMIT 1').get();
  db.prepare('UPDATE products SET data = ?, updated_at = datetime(\'now\') WHERE id = (SELECT id FROM products LIMIT 1)')
    .run(JSON.stringify(req.body));
  audit(req, 'update', 'products', 'singleton', { before: safeJsonParse(before?.data), after: req.body });
  res.json({ ok: true });
});

// ── LOGISTICS CONTRACTS ──────────────────────────────────────────────────────
app.get('/api/logistics/contracts', requireAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT id, data, created_at, updated_at FROM logistics_contracts WHERE deleted_at IS NULL ORDER BY id DESC').all();
    const contracts = rows.map(r => ({ ...safeJsonParse(r.data), id: r.id, _createdAt: r.created_at, _updatedAt: r.updated_at }));
    res.json(contracts);
  } catch (err) {
    console.error('Logistics GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logistics/contracts', requireAuth, (req, res) => {
  try {
    const contract = sanitizeObjectForStorage(req.body);
    const info = db.prepare('INSERT INTO logistics_contracts (data, created_at, updated_at) VALUES (?, datetime(\'now\'), datetime(\'now\'))')
      .run(JSON.stringify(contract));
    audit(req, 'create', 'logistics_contract', info.lastInsertRowid, { contract });
    res.json({ id: info.lastInsertRowid, ok: true });
  } catch (err) {
    console.error('Logistics POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/logistics/contracts/:id', requireAuth, (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });

    const before = db.prepare('SELECT data FROM logistics_contracts WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!before) return res.status(404).json({ error: 'Not found' });

    const contract = sanitizeObjectForStorage(req.body);
    db.prepare('UPDATE logistics_contracts SET data = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(JSON.stringify(contract), id);

    audit(req, 'update', 'logistics_contract', id, { before: safeJsonParse(before.data), after: contract });
    res.json({ ok: true });
  } catch (err) {
    console.error('Logistics PUT error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/logistics/contracts/:id', requireAuth, (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });

    const info = db.prepare('UPDATE logistics_contracts SET deleted_at = datetime(\'now\'), deleted_by = ? WHERE id = ? AND deleted_at IS NULL')
      .run(req.session.user || null, id);
    if (info.changes === 0) return res.status(404).json({ error: 'Not found' });

    audit(req, 'soft_delete', 'logistics_contract', id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Logistics DELETE error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logistics/contracts/bulk', requireAuth, (req, res) => {
  try {
    const { contracts, mode } = req.body;
    if (!Array.isArray(contracts)) return res.status(400).json({ error: 'contracts must be an array' });

    if (mode === 'replace') {
      makeBackup('before-logistics-replace');
      cleanupBackups();
    }

    const insert = db.prepare('INSERT INTO logistics_contracts (data, created_at, updated_at) VALUES (?, datetime(\'now\'), datetime(\'now\'))');

    const runBulk = db.transaction((items) => {
      if (mode === 'replace') {
        db.prepare('UPDATE logistics_contracts SET deleted_at = datetime(\'now\'), deleted_by = ? WHERE deleted_at IS NULL').run(req.session.user || null);
      }
      for (const item of items) insert.run(JSON.stringify(sanitizeObjectForStorage(item)));
    });

    runBulk(contracts);
    audit(req, 'bulk_import', 'logistics_contracts', null, { count: contracts.length, mode: mode === 'replace' ? 'replace' : 'append' });
    res.json({ ok: true, count: contracts.length, mode: mode === 'replace' ? 'replace' : 'append' });
  } catch (err) {
    console.error('Logistics BULK error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ── TRAIN CONTRACTS ─────────────────────────────────────────────────────────
function validateTrainId(raw) {
  const id = String(raw || '').trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}

function makeTrainServerId() {
  return 'tr_' + Date.now() + '_' + Math.floor(Math.random() * 1000000);
}

app.get('/api/train/contracts', requireAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT id, data, created_at, updated_at FROM train_contracts WHERE deleted_at IS NULL ORDER BY updated_at DESC, created_at DESC').all();
    const contracts = rows.map(r => {
      const data = safeJsonParse(r.data, {});
      return { ...data, id: data.id || r.id, _rowId: r.id, _createdAt: r.created_at, _updatedAt: r.updated_at };
    });
    res.json(contracts);
  } catch (err) {
    console.error('Train contracts GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/train/contracts', requireAuth, (req, res) => {
  try {
    const contract = sanitizeObjectForStorage(req.body) || {};
    const id = validateTrainId(req.body?.id) || makeTrainServerId();
    contract.id = id;
    const existing = db.prepare('SELECT id FROM train_contracts WHERE id = ?').get(id);
    if (existing) {
      db.prepare('UPDATE train_contracts SET data = ?, updated_at = datetime(\'now\'), deleted_at = NULL, deleted_by = NULL WHERE id = ?')
        .run(JSON.stringify(contract), id);
      audit(req, 'update', 'train_contract', id, { contract });
    } else {
      db.prepare('INSERT INTO train_contracts (id, data, created_at, updated_at) VALUES (?, ?, datetime(\'now\'), datetime(\'now\'))')
        .run(id, JSON.stringify(contract));
      audit(req, 'create', 'train_contract', id, { contract });
    }
    res.json({ ok: true, id });
  } catch (err) {
    console.error('Train contracts POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/train/contracts/:id', requireAuth, (req, res) => {
  try {
    const id = validateTrainId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });

    const before = db.prepare('SELECT data FROM train_contracts WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!before) return res.status(404).json({ error: 'Not found' });

    const contract = sanitizeObjectForStorage(req.body) || {};
    contract.id = id;
    db.prepare('UPDATE train_contracts SET data = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(JSON.stringify(contract), id);
    audit(req, 'update', 'train_contract', id, { before: safeJsonParse(before.data), after: contract });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('Train contracts PUT error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/train/contracts/:id', requireAuth, (req, res) => {
  try {
    const id = validateTrainId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });

    const info = db.prepare('UPDATE train_contracts SET deleted_at = datetime(\'now\'), deleted_by = ? WHERE id = ? AND deleted_at IS NULL')
      .run(req.session.user || null, id);
    if (info.changes === 0) return res.status(404).json({ error: 'Not found' });

    audit(req, 'soft_delete', 'train_contract', id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Train contracts DELETE error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/train/contracts/bulk', requireAuth, (req, res) => {
  try {
    const { contracts, mode } = req.body;
    if (!Array.isArray(contracts)) return res.status(400).json({ error: 'contracts must be an array' });

    if (mode === 'replace') {
      makeBackup('before-train-replace');
      cleanupBackups();
    }

    const upsert = db.prepare(`
      INSERT INTO train_contracts (id, data, created_at, updated_at, deleted_at, deleted_by)
      VALUES (?, ?, datetime('now'), datetime('now'), NULL, NULL)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = datetime('now'), deleted_at = NULL, deleted_by = NULL
    `);

    const runBulk = db.transaction((items) => {
      if (mode === 'replace') {
        db.prepare('UPDATE train_contracts SET deleted_at = datetime(\'now\'), deleted_by = ? WHERE deleted_at IS NULL').run(req.session.user || null);
      }
      for (const item of items) {
        const contract = sanitizeObjectForStorage(item) || {};
        const id = validateTrainId(item?.id) || makeTrainServerId();
        contract.id = id;
        upsert.run(id, JSON.stringify(contract));
      }
    });

    runBulk(contracts);
    audit(req, 'bulk_import', 'train_contracts', null, { count: contracts.length, mode: mode === 'replace' ? 'replace' : 'upsert' });
    res.json({ ok: true, count: contracts.length, mode: mode === 'replace' ? 'replace' : 'upsert' });
  } catch (err) {
    console.error('Train contracts BULK error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── STOCK LOCATIONS ──────────────────────────────────────────────────────────
app.get('/api/stock/locations', requireAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT id, data, created_at, updated_at FROM stock_locations WHERE deleted_at IS NULL ORDER BY id DESC').all();
    const locations = rows.map(r => ({ ...safeJsonParse(r.data), id: r.id, _CreatedAt: r.created_at, _UpdatedAt: r.updated_at, _createdAt: r.created_at, _updatedAt: r.updated_at }));
    res.json(locations);
  } catch (err) {
    console.error('Stock locations GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stock/locations', requireAuth, (req, res) => {
  try {
    const location = sanitizeObjectForStorage(req.body);
    const info = db.prepare('INSERT INTO stock_locations (data, created_at, updated_at) VALUES (?, datetime(\'now\'), datetime(\'now\'))')
      .run(JSON.stringify(location));
    audit(req, 'create', 'stock_location', info.lastInsertRowid, { location });
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    console.error('Stock locations POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/stock/locations/:id', requireAuth, (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });

    const before = db.prepare('SELECT data FROM stock_locations WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!before) return res.status(404).json({ error: 'Not found' });

    const location = sanitizeObjectForStorage(req.body);
    db.prepare('UPDATE stock_locations SET data = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(JSON.stringify(location), id);

    audit(req, 'update', 'stock_location', id, { before: safeJsonParse(before.data), after: location });
    res.json({ ok: true });
  } catch (err) {
    console.error('Stock locations PUT error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/stock/locations/:id', requireAuth, (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });

    const info = db.prepare('UPDATE stock_locations SET deleted_at = datetime(\'now\'), deleted_by = ? WHERE id = ? AND deleted_at IS NULL')
      .run(req.session.user || null, id);
    if (info.changes === 0) return res.status(404).json({ error: 'Not found' });

    audit(req, 'soft_delete', 'stock_location', id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Stock locations DELETE error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── STOCK ENTRIES ────────────────────────────────────────────────────────────
app.get('/api/stock/entries', requireAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT id, data, created_at, updated_at FROM stock_entries WHERE deleted_at IS NULL ORDER BY id DESC').all();
    const entries = rows.map(r => ({ ...safeJsonParse(r.data), id: r.id, _CreatedAt: r.created_at, _UpdatedAt: r.updated_at, _createdAt: r.created_at, _updatedAt: r.updated_at }));
    res.json(entries);
  } catch (err) {
    console.error('Stock entries GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stock/entries', requireAuth, (req, res) => {
  try {
    const entry = sanitizeObjectForStorage(req.body);
    const info = db.prepare('INSERT INTO stock_entries (data, created_at, updated_at) VALUES (?, datetime(\'now\'), datetime(\'now\'))')
      .run(JSON.stringify(entry));
    audit(req, 'create', 'stock_entry', info.lastInsertRowid, { entry });
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    console.error('Stock entries POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/stock/entries/:id', requireAuth, (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });

    const before = db.prepare('SELECT data FROM stock_entries WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!before) return res.status(404).json({ error: 'Not found' });

    const entry = sanitizeObjectForStorage(req.body);
    db.prepare('UPDATE stock_entries SET data = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(JSON.stringify(entry), id);

    audit(req, 'update', 'stock_entry', id, { before: safeJsonParse(before.data), after: entry });
    res.json({ ok: true });
  } catch (err) {
    console.error('Stock entries PUT error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/stock/entries/:id', requireAuth, (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });

    const info = db.prepare('UPDATE stock_entries SET deleted_at = datetime(\'now\'), deleted_by = ? WHERE id = ? AND deleted_at IS NULL')
      .run(req.session.user || null, id);
    if (info.changes === 0) return res.status(404).json({ error: 'Not found' });

    audit(req, 'soft_delete', 'stock_entry', id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Stock entries DELETE error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stock/entries/bulk', requireAuth, (req, res) => {
  try {
    const { entries, mode } = req.body;
    if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries must be an array' });

    if (mode === 'replace') {
      makeBackup('before-stock-entries-replace');
      cleanupBackups();
    }

    const insert = db.prepare('INSERT INTO stock_entries (data, created_at, updated_at) VALUES (?, datetime(\'now\'), datetime(\'now\'))');

    const runBulk = db.transaction((items) => {
      if (mode === 'replace') {
        db.prepare('UPDATE stock_entries SET deleted_at = datetime(\'now\'), deleted_by = ? WHERE deleted_at IS NULL').run(req.session.user || null);
      }
      for (const item of items) insert.run(JSON.stringify(sanitizeObjectForStorage(item)));
    });

    runBulk(entries);
    audit(req, 'bulk_import', 'stock_entries', null, { count: entries.length, mode: mode === 'replace' ? 'replace' : 'append' });
    res.json({ ok: true, count: entries.length, mode: mode === 'replace' ? 'replace' : 'append' });
  } catch (err) {
    console.error('Stock entries BULK error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN / BACKUP / AUDIT ───────────────────────────────────────────────────
app.post('/api/admin/backup', requireAdmin, (req, res) => {
  try {
    const backup = makeBackup('manual');
    cleanupBackups();
    audit(req, 'backup_manual', 'database', backup.filename);
    res.json({ ok: true, backup: { filename: backup.filename, createdAt: backup.createdAt } });
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/backups', requireAdmin, (req, res) => {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.db'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { filename: f, size: stat.size, modifiedAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    res.json({ backups: files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/audit', requireAdmin, (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10), 1), 1000);
    const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
    res.json(rows.map(r => ({ ...r, details: safeJsonParse(r.details, null) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/db-status', requireAdmin, (req, res) => {
  try {
    const tables = ['trades', 'logistics_contracts', 'train_contracts', 'stock_locations', 'stock_entries', 'products', 'target', 'weather_cache', 'audit_log'];
    const counts = {};

    for (const table of tables) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      const total = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
      let active = total;
      let deleted = 0;

      if (cols.includes('deleted_at')) {
        active = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE deleted_at IS NULL`).get().c;
        deleted = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE deleted_at IS NOT NULL`).get().c;
      }

      counts[table] = { total, active, deleted, columns: cols };
    }

    res.json({
      ok: true,
      dbDir: DB_DIR,
      dbPath,
      backupDir: BACKUP_DIR,
      dbExists: fs.existsSync(dbPath),
      dbSizeBytes: fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0,
      counts,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/undelete-all', requireAuth, (req, res) => {
  try {
    const tables = ['trades', 'logistics_contracts', 'train_contracts', 'stock_locations', 'stock_entries'];
    const result = {};
    makeBackup('before-undelete-all');

    for (const table of tables) {
      const info = db.prepare(`UPDATE ${table} SET deleted_at = NULL, deleted_by = NULL WHERE deleted_at IS NOT NULL`).run();
      result[table] = info.changes;
    }

    audit(req, 'undelete_all', 'database', null, result);
    res.json({ ok: true, restored: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MATIF QUOTES ─────────────────────────────────────────────────────────────
let matifCache = { data: null, ts: 0 };
const MATIF_TTL = 5 * 60 * 1000;

const MATIF_CONTRACTS = [
  { key: 'wheat',    code: 'EBM-DPAR', name: 'Grâu (EBM)' },
  { key: 'corn',     code: 'EMA-DPAR', name: 'Porumb (EMA)' },
  { key: 'rapeseed', code: 'ECO-DPAR', name: 'Rapiță (ECO)' },
];

async function fetchMatifContract(code) {
  const [symbol, mic] = code.split('-');
  const url = `https://live.euronext.com/en/ajax/getPricesFutures/commodities-futures/${symbol}/${mic}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'text/html, */*; q=0.01',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `https://live.euronext.com/en/product/commodities-futures/${code}`,
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${code}`);
  const html = await res.text();

  const rows = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;

  while ((trMatch = trRegex.exec(html)) !== null) {
    const rowHtml = trMatch[1];
    const cells = [];
    let tdMatch;
    const tdReg = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    while ((tdMatch = tdReg.exec(rowHtml)) !== null) {
      const text = tdMatch[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .trim();
      cells.push(text);
    }

    if (cells.length >= 6 && /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}$/.test(cells[0])) {
      const parseNum = (s) => {
        const n = parseFloat((s || '').replace(',', '.'));
        return isNaN(n) ? null : n;
      };
      rows.push({
        delivery: cells[0],
        bid: parseNum(cells[1]),
        ask: parseNum(cells[2]),
        last: parseNum(cells[3]),
        change: parseNum(cells[5]),
        settl: parseNum(cells[10]) || parseNum(cells[9]) || parseNum(cells[8]),
        isOpen: parseNum(cells[3]) !== null,
      });
    }
  }

  return rows;
}

app.get('/api/matif', requireAuth, async (req, res) => {
  try {
    const now = Date.now();
    if (matifCache.data && (now - matifCache.ts) < MATIF_TTL) {
      return res.json({ ...matifCache.data, cached: true, age: Math.round((now - matifCache.ts) / 1000) });
    }

    const results = {};
    const errors = {};

    await Promise.allSettled(
      MATIF_CONTRACTS.map(async ({ key, code, name }) => {
        try {
          const rows = await fetchMatifContract(code);
          const front = rows.find(r => r.bid !== null || r.settl !== null) || rows[0] || null;
          results[key] = { name, code, front, allRows: rows.slice(0, 6) };
        } catch (e) {
          errors[key] = e.message;
          results[key] = { name, code, front: null, allRows: [], error: e.message };
        }
      })
    );

    const payload = { quotes: results, errors, fetchedAt: new Date().toISOString(), cached: false, age: 0 };
    const hasData = Object.values(results).some(r => r.front !== null);
    if (hasData) matifCache = { data: payload, ts: now };

    res.json(payload);
  } catch (err) {
    console.error('MATIF fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── TARGET / BUDGET ──────────────────────────────────────────────────────────
app.get('/api/target/:year', requireAuth, (req, res) => {
  const row = db.prepare('SELECT data FROM target WHERE year = ?').get(req.params.year);
  res.json(row ? safeJsonParse(row.data) : null);
});

app.put('/api/target/:year', requireAuth, (req, res) => {
  const year = parseInt(req.params.year, 10);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return res.status(400).json({ error: 'Invalid year' });

  const before = db.prepare('SELECT data FROM target WHERE year = ?').get(year);
  const data = JSON.stringify(req.body);
  db.prepare(`
    INSERT INTO target (year, data, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(year) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(year, data);

  audit(req, 'update', 'target', year, { before: safeJsonParse(before?.data, null), after: req.body });
  res.json({ ok: true });
});

// ── NEWS ─────────────────────────────────────────────────────────────────────
let newsCache = { data: null, ts: 0 };
const NEWS_TTL = 15 * 60 * 1000;

const NEWS_SOURCES = [
  { name: 'Agrointeligenta', url: 'https://agrointel.ro/feed', lang: 'ro', tag: 'RO', filter: null },
  { name: 'Ziarul Financiar', url: 'https://www.zf.ro/rss', lang: 'ro', tag: 'RO', filter: null },
  { name: 'Bursa.ro', url: 'https://www.bursa.ro/rss.xml', lang: 'ro', tag: 'RO', filter: null },
  { name: 'HotNews Eco', url: 'https://economie.hotnews.ro/rss', lang: 'ro', tag: 'RO', filter: null },
  { name: 'USDA News', url: 'https://www.usda.gov/rss/latest-releases.xml', lang: 'en', tag: 'INT', filter: 'grain' },
  { name: 'Brownfield Ag', url: 'https://brownfieldagnews.com/feed', lang: 'en', tag: 'INT', filter: null },
  { name: 'Northern Ag', url: 'https://northernag.net/feed', lang: 'en', tag: 'INT', filter: null },
  { name: 'SpreadCharts', url: 'https://spreadcharts.com/feed', lang: 'en', tag: 'INT', filter: null },
  { name: 'OilPrice', url: 'https://oilprice.com/rss/main', lang: 'en', tag: 'MACRO', filter: null },
  { name: 'Farm Progress', url: 'https://www.farmprogress.com/rss/all', lang: 'en', tag: 'INT', filter: null },
];

const USDA_GRAIN_KEYWORDS = ['wheat','corn','grain','soybean','soy','rapeseed','canola','sunflower','oilseed','barley','crop','harvest','export','wasde','comodity','commodity','cereale','porumb','grau','rapita'];
const KEYWORDS_HIGH = ['grâu','wheat','porumb','corn','rapiță','rapeseed','canola','cereale','grain','oleaginoase','oilseed','MATIF','CBOT','futures','recoltă','harvest','export','import','USDA','IGC','Euronext'];
const KEYWORDS_MED = ['agricol','agricultură','agriculture','fermier','farmer','piață','market','preț','price','România','Romania','UE','EU','subvenț','subsid'];

function scoreItem(title, desc) {
  const text = ((title || '') + ' ' + (desc || '')).toLowerCase();
  let score = 0;
  KEYWORDS_HIGH.forEach(k => { if (text.includes(k.toLowerCase())) score += 3; });
  KEYWORDS_MED.forEach(k => { if (text.includes(k.toLowerCase())) score += 1; });
  return score;
}

async function fetchRSS(source) {
  const res = await fetch(source.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 AgrotexTracker/1.0 RSS Reader', 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();

  const items = [];
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;

  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
      const match = r.exec(block);
      return match
        ? match[1].replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim()
        : '';
    };

    const title = get('title');
    const link = get('link') || (/<link>([\s\S]*?)<\/link>/i.exec(block) || [])[1] || '';
    const desc = get('description').substring(0, 200);
    const pubDate = get('pubDate') || get('dc:date') || '';
    const date = pubDate ? new Date(pubDate) : new Date();

    if (!title || !link) continue;
    if (date.getTime() < cutoff24h) continue;

    if (source.filter === 'grain') {
      const text = (title + ' ' + desc).toLowerCase();
      const isGrain = USDA_GRAIN_KEYWORDS.some(k => text.includes(k));
      if (!isGrain) continue;
    }

    items.push({ title, link: link.trim(), desc, date: date.toISOString(), source: source.name, tag: source.tag, lang: source.lang, score: scoreItem(title, desc) });
  }
  return items;
}

app.get('/api/news', requireAuth, async (req, res) => {
  try {
    const now = Date.now();
    if (newsCache.data && (now - newsCache.ts) < NEWS_TTL) {
      return res.json({ ...newsCache.data, cached: true, age: Math.round((now - newsCache.ts) / 1000) });
    }

    const allItems = [];
    const sourceResults = await Promise.allSettled(
      NEWS_SOURCES.map(s => fetchRSS(s).then(items => ({ source: s.name, items, ok: true })).catch(e => ({ source: s.name, items: [], ok: false, error: e.message })))
    );

    sourceResults.forEach(r => { if (r.status === 'fulfilled') allItems.push(...r.value.items); });
    allItems.sort((a, b) => b.score !== a.score ? b.score - a.score : new Date(b.date) - new Date(a.date));

    const payload = { items: allItems.slice(0, 60), total: allItems.length, sources: sourceResults.map(r => r.value || r.reason), fetchedAt: new Date().toISOString(), cached: false, age: 0 };
    if (allItems.length > 0) newsCache = { data: payload, ts: now };
    res.json(payload);
  } catch (err) {
    console.error('News fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/news/test', requireAuth, async (req, res) => {
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
  const results = await Promise.allSettled(
    NEWS_SOURCES.map(async (s) => {
      const start = Date.now();
      try {
        const r = await fetch(s.url, { headers: { 'User-Agent': 'Mozilla/5.0 AgrotexTracker/1.0 RSS Reader' }, signal: AbortSignal.timeout(10000) });
        const text = await r.text();
        const totalItems = (text.match(/<item/gi) || []).length;
        const pubDates = [...text.matchAll(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/gi)].map(m => new Date(m[1]));
        const recent = pubDates.filter(d => d.getTime() > cutoff24h).length;
        return { name: s.name, tag: s.tag, filter: s.filter || 'none', url: s.url, status: r.status, ok: r.ok, totalItems, recent24h: recent, ms: Date.now() - start };
      } catch (e) {
        return { name: s.name, tag: s.tag, url: s.url, status: 0, ok: false, error: e.message, ms: Date.now() - start };
      }
    })
  );
  res.json(results.map(r => r.value || r.reason));
});

// ── WEATHER / OPEN-METEO V3 + SOIL MOISTURE FROM HOURLY ─────────────────────
const WEATHER_PRESET_LOCATIONS = [
  { name: 'Oradea', country: 'Romania', latitude: 47.0722, longitude: 21.9211, timezone: 'Europe/Bucharest' },
  { name: 'Apa', country: 'Romania', latitude: 47.7667, longitude: 23.1833, timezone: 'Europe/Bucharest' },
  { name: 'Valea lui Mihai', country: 'Romania', latitude: 47.5167, longitude: 22.1500, timezone: 'Europe/Bucharest' },
  { name: 'Carei', country: 'Romania', latitude: 47.6833, longitude: 22.4667, timezone: 'Europe/Bucharest' },
  { name: 'Săcueni', country: 'Romania', latitude: 47.3500, longitude: 22.1000, timezone: 'Europe/Bucharest' },
];

const WEATHER_PRESET_TTL = 6 * 60 * 60 * 1000;
let weatherPresetMemCache = { ts: 0, items: null };

function dbGetWeatherCache(locationName) {
  const row = db.prepare('SELECT data, updated_at FROM weather_cache WHERE location_name = ?').get(locationName);
  if (!row) return null;
  try { return { ...JSON.parse(row.data), _dbUpdatedAt: row.updated_at }; } catch { return null; }
}

function dbSetWeatherCache(locationName, payload) {
  db.prepare(`
    INSERT INTO weather_cache (location_name, data, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(location_name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(locationName, JSON.stringify(payload));
}

function round2(n) { const x = Number(n); return Number.isFinite(x) ? Math.round(x * 100) / 100 : null; }
function averageOrNull(values) { const vals = values.filter(v => Number.isFinite(v)); return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null; }
function sumOrZero(values) { return values.reduce((a, b) => a + (Number(b) || 0), 0); }
function maxOrNull(values) { const vals = values.filter(v => Number.isFinite(v)); return vals.length ? Math.max(...vals) : null; }
function minOrNull(values) { const vals = values.filter(v => Number.isFinite(v)); return vals.length ? Math.min(...vals) : null; }

function weatherCodeToLabel(code) {
  const map = { 0:'senin',1:'mai mult senin',2:'variabil',3:'noros',45:'ceață',48:'ceață depusă',51:'burniță',53:'burniță',55:'burniță densă',56:'lapoviță fină',57:'lapoviță densă',61:'ploaie slabă',63:'ploaie',65:'ploaie puternică',66:'ploaie înghețată',67:'ploaie înghețată',71:'ninsoare',73:'ninsoare',75:'ninsoare puternică',77:'grăunțe de zăpadă',80:'averse',81:'averse',82:'averse puternice',85:'averse ninsoare',86:'averse ninsoare',95:'furtună',96:'furtună cu grindină',99:'furtună cu grindină' };
  return map[code] || 'necunoscut';
}

function buildRiskFlags({ daily, current }) {
  const risks = [];
  const minTemp = minOrNull(daily.temperature_2m_min || []);
  const maxWind = maxOrNull(daily.wind_speed_10m_max || []);
  const maxRain = maxOrNull(daily.precipitation_sum || []);
  const currentTemp = Number(current.temperature_2m);
  if (Number.isFinite(minTemp) && minTemp <= 0) risks.push('risc îngheț');
  if (Number.isFinite(maxWind) && maxWind >= 45) risks.push('vânt puternic');
  if (Number.isFinite(maxRain) && maxRain >= 20) risks.push('ploaie semnificativă');
  if (Number.isFinite(currentTemp) && currentTemp >= 32) risks.push('stress termic');
  return risks;
}

function daysSinceLastMeaningfulRain(pastDaily) {
  if (!pastDaily || !Array.isArray(pastDaily.precipitation_sum)) return null;
  for (let i = pastDaily.precipitation_sum.length - 1; i >= 0; i--) {
    const mm = Number(pastDaily.precipitation_sum[i] || 0);
    if (mm >= 0.5) return pastDaily.precipitation_sum.length - 1 - i;
  }
  return null;
}

function groupHourlySoilByDate(hourly) {
  const byDate = {};
  const times = hourly.time || [];
  for (let i = 0; i < times.length; i++) {
    const date = String(times[i]).slice(0, 10);
    if (!byDate[date]) byDate[date] = { s01: [], s13: [], s39: [], s927: [], s2781: [] };
    byDate[date].s01.push(hourly.soil_moisture_0_to_1cm?.[i]);
    byDate[date].s13.push(hourly.soil_moisture_1_to_3cm?.[i]);
    byDate[date].s39.push(hourly.soil_moisture_3_to_9cm?.[i]);
    byDate[date].s927.push(hourly.soil_moisture_9_to_27cm?.[i]);
    byDate[date].s2781.push(hourly.soil_moisture_27_to_81cm?.[i]);
  }
  return byDate;
}

function buildDailySoilMapFromHourly(hourly) {
  const grouped = groupHourlySoilByDate(hourly);
  const out = {};
  for (const [date, v] of Object.entries(grouped)) {
    const surface = averageOrNull(v.s01);
    const mid = averageOrNull([averageOrNull(v.s13), averageOrNull(v.s39), averageOrNull(v.s927)]);
    const deep = averageOrNull([averageOrNull(v.s2781)]);
    out[date] = { soilSurface: round2(surface), soilMid: round2(mid), soilDeep: round2(deep) };
  }
  return out;
}

function buildWeatherPayload(location, raw) {
  const current = raw.current || {};
  const daily = raw.daily || {};
  const pastDaily = raw.pastDaily || {};
  const dailySoilMap = buildDailySoilMapFromHourly(raw.hourly || {});
  const currentDate = String(current.time || '').slice(0, 10);
  const currentSoil = dailySoilMap[currentDate] || { soilSurface: null, soilMid: null, soilDeep: null };

  const dates = daily.time || [];
  const dailyForecast = dates.map((date, idx) => {
    const soil = dailySoilMap[date] || { soilSurface: null, soilMid: null, soilDeep: null };
    return {
      date,
      tempMin: Number.isFinite(daily.temperature_2m_min?.[idx]) ? daily.temperature_2m_min[idx] : null,
      tempMax: Number.isFinite(daily.temperature_2m_max?.[idx]) ? daily.temperature_2m_max[idx] : null,
      precip: Number.isFinite(daily.precipitation_sum?.[idx]) ? daily.precipitation_sum[idx] : null,
      windMax: Number.isFinite(daily.wind_speed_10m_max?.[idx]) ? daily.wind_speed_10m_max[idx] : null,
      humidityMean: Number.isFinite(daily.relative_humidity_2m_mean?.[idx]) ? daily.relative_humidity_2m_mean[idx] : null,
      weatherCode: Number.isFinite(daily.weather_code?.[idx]) ? daily.weather_code[idx] : null,
      weatherLabel: weatherCodeToLabel(daily.weather_code?.[idx]),
      soilSurface: soil.soilSurface,
      soilMid: soil.soilMid,
      soilDeep: soil.soilDeep,
    };
  });

  const next7Precip = sumOrZero(daily.precipitation_sum || []);
  const last7Precip = sumOrZero((pastDaily.precipitation_sum || []).slice(-7));
  const last30Precip = sumOrZero(pastDaily.precipitation_sum || []);

  const summary = {
    currentTemp: round2(current.temperature_2m),
    currentHumidity: round2(current.relative_humidity_2m),
    currentWind: round2(current.wind_speed_10m),
    currentPrecip: round2(current.precipitation),
    currentWeatherCode: Number.isFinite(current.weather_code) ? current.weather_code : null,
    currentWeatherLabel: weatherCodeToLabel(current.weather_code),
    next7Precip: round2(next7Precip),
    last7Precip: round2(last7Precip),
    last30Precip: round2(last30Precip),
    daysSinceRain: daysSinceLastMeaningfulRain(pastDaily),
    minTemp7: round2(minOrNull(daily.temperature_2m_min || [])),
    maxTemp7: round2(maxOrNull(daily.temperature_2m_max || [])),
    maxWind7: round2(maxOrNull(daily.wind_speed_10m_max || [])),
    soilSurface: currentSoil.soilSurface,
    soilMid: currentSoil.soilMid,
    soilDeep: currentSoil.soilDeep,
    risks: buildRiskFlags({ daily, current }),
  };

  return { location, summary, dailyForecast, fetchedAt: new Date().toISOString() };
}

async function fetchWeatherForLocation(location) {
  const params = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    timezone: location.timezone || 'auto',
    current: ['temperature_2m','relative_humidity_2m','precipitation','weather_code','wind_speed_10m'].join(','),
    daily: ['weather_code','temperature_2m_max','temperature_2m_min','precipitation_sum','wind_speed_10m_max','relative_humidity_2m_mean'].join(','),
    hourly: ['soil_moisture_0_to_1cm','soil_moisture_1_to_3cm','soil_moisture_3_to_9cm','soil_moisture_9_to_27cm','soil_moisture_27_to_81cm'].join(','),
    past_days: '30',
    forecast_days: '7',
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'AgrotexTracker/1.0' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const raw = await res.json();

  const allDates = raw.daily?.time || [];
  const today = new Date();
  const tzNow = new Date(today.toLocaleString('en-US', { timeZone: location.timezone || 'UTC' }));
  const todayStr = tzNow.toISOString().slice(0, 10);

  const dailyIndexesFuture = [];
  const dailyIndexesPast = [];
  allDates.forEach((d, idx) => {
    if (d < todayStr) dailyIndexesPast.push(idx);
    else if (d >= todayStr && dailyIndexesFuture.length < 7) dailyIndexesFuture.push(idx);
  });

  const futureDaily = {
    time: dailyIndexesFuture.map(i => raw.daily.time?.[i]),
    weather_code: dailyIndexesFuture.map(i => raw.daily.weather_code?.[i]),
    temperature_2m_max: dailyIndexesFuture.map(i => raw.daily.temperature_2m_max?.[i]),
    temperature_2m_min: dailyIndexesFuture.map(i => raw.daily.temperature_2m_min?.[i]),
    precipitation_sum: dailyIndexesFuture.map(i => raw.daily.precipitation_sum?.[i]),
    wind_speed_10m_max: dailyIndexesFuture.map(i => raw.daily.wind_speed_10m_max?.[i]),
    relative_humidity_2m_mean: dailyIndexesFuture.map(i => raw.daily.relative_humidity_2m_mean?.[i]),
  };

  const pastDaily = { time: dailyIndexesPast.map(i => raw.daily.time?.[i]), precipitation_sum: dailyIndexesPast.map(i => raw.daily.precipitation_sum?.[i]) };
  return buildWeatherPayload(location, { current: raw.current, daily: futureDaily, pastDaily, hourly: raw.hourly || {} });
}

app.get('/api/weather/presets', requireAuth, async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1';
    const now = Date.now();
    if (!forceRefresh && weatherPresetMemCache.items && (now - weatherPresetMemCache.ts) < WEATHER_PRESET_TTL) {
      return res.json({ items: weatherPresetMemCache.items, fetchedAt: new Date(weatherPresetMemCache.ts).toISOString(), cached: true, age: Math.round((now - weatherPresetMemCache.ts) / 1000) });
    }

    const results = await Promise.allSettled(
      WEATHER_PRESET_LOCATIONS.map(async (location) => {
        try {
          const fresh = await fetchWeatherForLocation(location);
          dbSetWeatherCache(location.name, fresh);
          return { ...fresh, _source: 'fresh' };
        } catch (err) {
          console.warn(`Weather fetch failed for ${location.name}: ${err.message}`);
          const cached = dbGetWeatherCache(location.name);
          if (cached) return { ...cached, _source: 'cached_db', _cacheNote: `Date din ${cached._dbUpdatedAt || 'DB'}` };
          return { location, summary: null, dailyForecast: [], fetchedAt: new Date().toISOString(), _source: 'error', _error: err.message };
        }
      })
    );

    const items = results.map(r => r.status === 'fulfilled' ? r.value : { location: { name: 'Necunoscut', country: '' }, summary: null, dailyForecast: [], fetchedAt: new Date().toISOString(), _source: 'error', _error: r.reason?.message || 'Unknown error' });
    const hasFresh = items.some(i => i._source === 'fresh');
    if (hasFresh || !weatherPresetMemCache.items) weatherPresetMemCache = { ts: now, items };
    res.json({ items, fetchedAt: new Date().toISOString(), cached: false, age: 0 });
  } catch (err) {
    console.error('Weather presets error:', err);
    try {
      const items = WEATHER_PRESET_LOCATIONS.map(loc => dbGetWeatherCache(loc.name) || { location: loc, summary: null, dailyForecast: [], fetchedAt: new Date().toISOString(), _source: 'error', _error: 'Server error + no DB cache' });
      res.json({ items, fetchedAt: new Date().toISOString(), cached: true, age: -1 });
    } catch {
      res.status(500).json({ error: err.message });
    }
  }
});

app.get('/api/weather/search', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ results: [] });

    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=ro&format=json`;
    const r = await fetch(url, { headers: { 'User-Agent': 'AgrotexTracker/1.0' }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error(`Geocoding HTTP ${r.status}`);
    const data = await r.json();

    const results = (data.results || []).map(item => ({ name: item.name, country: item.country || '', admin1: item.admin1 || '', admin2: item.admin2 || '', latitude: item.latitude, longitude: item.longitude, timezone: item.timezone || 'auto' }));
    res.json({ results });
  } catch (err) {
    console.error('Weather search error:', err);
    res.status(500).json({ error: err.message, results: [] });
  }
});

app.get('/api/weather/location', requireAuth, async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const name = String(req.query.name || 'Locație');
    const country = String(req.query.country || '');
    const timezone = String(req.query.timezone || 'auto');

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'lat/lon invalid' });
    const payload = await fetchWeatherForLocation({ name, country, latitude: lat, longitude: lon, timezone });
    res.json(payload);
  } catch (err) {
    console.error('Weather location error:', err);
    res.status(500).json({ error: err.message });
  }
});



// ── CONTEXT GLOBAL / INDEXMUNDI ─────────────────────────────────────────────
const INDEXMUNDI_ALLOWED = new Set([
  'wheat',
  'corn',
  'rapeseed-oil',
  'soybeans',
  'soybean-oil',
  'sunflower-oil',
  'palm-oil',
  'urea'
]);
const INDEXMUNDI_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeSpace(s) {
  return String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripTags(s) {
  return normalizeSpace(String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
  );
}

function decodeHtmlBasic(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function parseIndexMundiHtml(html) {
  const raw = decodeHtmlBasic(String(html || ''));
  const pageText = stripTags(raw);
  const unit = (pageText.match(/Unit:\s*([^\n\r]+?)(?:\s{2,}|Frequency:|Historical Data|Description|$)/i) || [])[1] || 'US Dollars per Metric Ton';
  const dataAsOf = (pageText.match(/Data as of\s+([A-Za-z]+\s+\d{4})/i) || [])[1] || '';

  const rows = [];
  const trMatches = raw.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trMatches) {
    const cellMatches = tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [];
    const cells = cellMatches.map(c => stripTags(decodeHtmlBasic(c)));
    if (cells.length < 2) continue;
    const month = cells[0];
    const priceText = cells[1];
    if (!/^[A-Za-z]{3,9}\s+\d{4}$/.test(month)) continue;
    const price = Number(String(priceText).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)?.[0]);
    if (!Number.isFinite(price)) continue;
    rows.push({ month, price });
  }

  // Fallback pentru pagini unde tabelul vine fără markup obișnuit.
  if (!rows.length) {
    const re = /\b([A-Za-z]{3,9}\s+\d{4})\s+(-?\d+(?:,\d{3})*(?:\.\d+)?)/g;
    let m;
    while ((m = re.exec(pageText)) && rows.length < 240) {
      const price = Number(m[2].replace(/,/g, ''));
      if (Number.isFinite(price)) rows.push({ month: m[1], price });
    }
  }

  return { rows, unit: normalizeSpace(unit), dataAsOf };
}

function dbGetContextCache(key) {
  const row = db.prepare('SELECT data, updated_at FROM weather_cache WHERE location_name = ?').get(key);
  if (!row) return null;
  const data = safeJsonParse(row.data, null);
  if (!data) return null;
  return { ...data, _dbUpdatedAt: row.updated_at };
}

function dbSetContextCache(key, payload) {
  db.prepare(`
    INSERT INTO weather_cache (location_name, data, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(location_name) DO UPDATE SET data = excluded.data, updated_at = datetime('now')
  `).run(key, JSON.stringify(payload));
}

async function fetchIndexMundiFromSource(commodity) {
  const url = `https://www.indexmundi.com/commodities/?commodity=${encodeURIComponent(commodity)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 AgrotexTracker/1.0',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,ro;q=0.8',
      'Referer': 'https://www.indexmundi.com/commodities/'
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`IndexMundi HTTP ${res.status}`);
  const html = await res.text();
  const parsed = parseIndexMundiHtml(html);
  if (!parsed.rows.length) throw new Error('IndexMundi: tabel negasit');
  return {
    ok: true,
    commodity,
    url,
    rows: parsed.rows,
    unit: parsed.unit || 'US Dollars per Metric Ton',
    dataAsOf: parsed.dataAsOf || '',
    fetchedAt: new Date().toISOString(),
    source: 'indexmundi'
  };
}

app.get('/api/context/indexmundi', requireAuth, async (req, res) => {
  const commodity = String(req.query.commodity || '').trim().toLowerCase();
  const refresh = req.query.refresh === '1';
  if (!INDEXMUNDI_ALLOWED.has(commodity)) return res.status(400).json({ ok: false, error: 'Commodity invalid' });

  const cacheKey = `indexmundi:${commodity}`;
  const cached = dbGetContextCache(cacheKey);
  const cacheTs = cached?._dbUpdatedAt ? new Date(cached._dbUpdatedAt.replace(' ', 'T') + 'Z').getTime() : 0;
  const cacheFresh = cached && cacheTs && (Date.now() - cacheTs) < INDEXMUNDI_CACHE_TTL_MS;

  if (!refresh && cacheFresh) {
    return res.json({ ...cached, ok: true, cached: true, cacheUpdatedAt: cached._dbUpdatedAt });
  }

  try {
    const fresh = await fetchIndexMundiFromSource(commodity);
    dbSetContextCache(cacheKey, fresh);
    return res.json({ ...fresh, cached: false });
  } catch (err) {
    console.warn(`IndexMundi fetch failed for ${commodity}: ${err.message}`);
    if (cached) {
      return res.json({ ...cached, ok: true, cached: true, stale: true, cacheUpdatedAt: cached._dbUpdatedAt, warning: err.message });
    }
    return res.status(504).json({ ok: false, commodity, error: err.message || 'IndexMundi timeout' });
  }
});

// ── STATIC ───────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Agrotex running on port ${PORT}`));
