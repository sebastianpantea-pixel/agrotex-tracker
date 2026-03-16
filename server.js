const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || 'agrotex2025';
const SESSION_SECRET = process.env.SESSION_SECRET || 'agrotex-secret-key-change-me';

// DB setup — Render persistent disk mounts at /data, fallback to local
const DB_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const db = new Database(path.join(DB_DIR, 'agrotex.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

const prodRow = db.prepare('SELECT id FROM products LIMIT 1').get();
if (!prodRow) {
  const defaultProducts = JSON.stringify({
    wheat:     { name:'Grâu',             emoji:'🌾', color:'#e2a857', symbol:'WHT' },
    corn:      { name:'Porumb',           emoji:'🌽', color:'#f0c040', symbol:'CRN' },
    rapeseed:  { name:'Rapiță',          emoji:'🌿', color:'#8bc34a', symbol:'RAP' },
    sunflower: { name:'Floarea-soarelui', emoji:'🌻', color:'#ffb300', symbol:'SFW' },
  });
  db.prepare('INSERT INTO products (data) VALUES (?)').run(defaultProducts);
}

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === APP_PASSWORD) {
    req.session.authenticated = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Parolă incorectă' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ authenticated: !!req.session.authenticated });
});

app.get('/api/trades', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, data FROM trades ORDER BY id DESC').all();
  const trades = rows.map(r => ({ ...JSON.parse(r.data), id: r.id }));
  res.json(trades);
});

app.post('/api/trades', requireAuth, (req, res) => {
  const trade = req.body;
  delete trade.id;
  const info = db.prepare('INSERT INTO trades (data) VALUES (?)').run(JSON.stringify(trade));
  res.json({ id: info.lastInsertRowid });
});

app.post('/api/trades/bulk', requireAuth, (req, res) => {
  const { trades } = req.body;
  if (!Array.isArray(trades)) return res.status(400).json({ error: 'Invalid' });
  const insert = db.prepare('INSERT INTO trades (data) VALUES (?)');
  const many = db.transaction((items) => {
    for (const t of items) {
      const copy = { ...t }; delete copy.id;
      insert.run(JSON.stringify(copy));
    }
  });
  many(trades);
  res.json({ ok: true, count: trades.length });
});

app.put('/api/trades/:id', requireAuth, (req, res) => {
  const trade = req.body;
  delete trade.id;
  db.prepare('UPDATE trades SET data = ? WHERE id = ?').run(JSON.stringify(trade), req.params.id);
  res.json({ ok: true });
});

app.delete('/api/trades/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM trades WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/products', requireAuth, (req, res) => {
  const row = db.prepare('SELECT data FROM products LIMIT 1').get();
  res.json(JSON.parse(row.data));
});

app.put('/api/products', requireAuth, (req, res) => {
  db.prepare('UPDATE products SET data = ?, updated_at = datetime(\'now\') WHERE id = (SELECT id FROM products LIMIT 1)')
    .run(JSON.stringify(req.body));
  res.json({ ok: true });
});

// ── MATIF QUOTES (Euronext scraping — delayed 15 min, no API key needed) ──────
// Cache to avoid hammering Euronext (refresh max once per 5 min)
let matifCache = { data: null, ts: 0 };
const MATIF_TTL = 5 * 60 * 1000; // 5 minutes

const MATIF_CONTRACTS = [
  { key: 'wheat',    code: 'EBM-DPAR', name: 'Grâu (EBM)'    },
  { key: 'corn',     code: 'EMA-DPAR', name: 'Porumb (EMA)'   },
  { key: 'rapeseed', code: 'ECO-DPAR', name: 'Rapiță (ECO)'  },
];

async function fetchMatifContract(code) {
  // code = 'EBM-DPAR' → symbol='EBM', mic='DPAR'
  const [symbol, mic] = code.split('-');

  // Use the internal Ajax endpoint that returns the prices table HTML
  const url = `https://live.euronext.com/en/ajax/getPricesFutures/commodities-futures/${symbol}/${mic}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
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
        bid:      parseNum(cells[1]),
        ask:      parseNum(cells[2]),
        last:     parseNum(cells[3]),
        change:   parseNum(cells[5]),
        settl:    parseNum(cells[10]) || parseNum(cells[9]) || parseNum(cells[8]),
      });
    }
  }

  return rows;
}

app.get('/api/matif', requireAuth, async (req, res) => {
  try {
    const now = Date.now();
    // Serve from cache if fresh
    if (matifCache.data && (now - matifCache.ts) < MATIF_TTL) {
      return res.json({ ...matifCache.data, cached: true, age: Math.round((now - matifCache.ts) / 1000) });
    }

    const results = {};
    const errors = {};

    await Promise.allSettled(
      MATIF_CONTRACTS.map(async ({ key, code, name }) => {
        try {
          const rows = await fetchMatifContract(code);
          // Front month = first row with a bid or settlement price
          const front = rows.find(r => r.bid !== null || r.settl !== null) || rows[0] || null;
          results[key] = {
            name,
            code,
            front,
            allRows: rows.slice(0, 6), // first 6 expiries
          };
        } catch (e) {
          errors[key] = e.message;
          results[key] = { name, code, front: null, allRows: [], error: e.message };
        }
      })
    );

    const payload = {
      quotes: results,
      errors,
      fetchedAt: new Date().toISOString(),
      cached: false,
      age: 0,
    };

    // Only cache if we got at least one valid result
    const hasData = Object.values(results).some(r => r.front !== null);
    if (hasData) {
      matifCache = { data: payload, ts: now };
    }

    res.json(payload);
  } catch (err) {
    console.error('MATIF fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── NEWS FEED (RSS aggregator — cereale, piețe, agro România) ─────────────────
let newsCache = { data: null, ts: 0 };
const NEWS_TTL = 15 * 60 * 1000; // 15 minute cache

const NEWS_SOURCES = [
  { name: 'Agrointeligenta', url: 'https://agrointel.ro/feed', lang: 'ro', tag: 'RO' },
  { name: 'Agerpres Economie', url: 'https://www.agerpres.ro/rss/economie.rss', lang: 'ro', tag: 'RO' },
  { name: 'World Grain', url: 'https://www.world-grain.com/rss/news', lang: 'en', tag: 'INT' },
  { name: 'USDA News', url: 'https://www.usda.gov/rss/latest-releases.xml', lang: 'en', tag: 'INT' },
  { name: 'Reuters Commodities', url: 'https://feeds.reuters.com/reuters/businessNews', lang: 'en', tag: 'INT' },
];

// Keywords to boost relevance score (not filter — show all but sort by relevance)
const KEYWORDS_HIGH = ['grâu','wheat','porumb','corn','rapiță','rapeseed','canola','cereale','grain','oleaginoase','oilseed','MATIF','CBOT','futures','recoltă','harvest','export','import','USDA','IGC','Euronext'];
const KEYWORDS_MED  = ['agricol','agricultură','agriculture','fermier','farmer','piață','market','preț','price','România','Romania','UE','EU','subvenț','subsid'];

function scoreItem(title, desc) {
  const text = ((title || '') + ' ' + (desc || '')).toLowerCase();
  let score = 0;
  KEYWORDS_HIGH.forEach(k => { if (text.includes(k.toLowerCase())) score += 3; });
  KEYWORDS_MED.forEach(k  => { if (text.includes(k.toLowerCase())) score += 1; });
  return score;
}

async function fetchRSS(source) {
  const res = await fetch(source.url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 AgrotexTracker/1.0 RSS Reader',
      'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();

  const items = [];
  // Parse <item> blocks
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
      const match = r.exec(block);
      return match ? match[1].replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim() : '';
    };
    const title = get('title');
    const link  = get('link') || (/<link>([\s\S]*?)<\/link>/i.exec(block) || [])[1] || '';
    const desc  = get('description').substring(0, 200);
    const pubDate = get('pubDate') || get('dc:date') || '';
    const date = pubDate ? new Date(pubDate) : new Date();

    if (title && link) {
      items.push({
        title,
        link: link.trim(),
        desc,
        date: date.toISOString(),
        source: source.name,
        tag: source.tag,
        lang: source.lang,
        score: scoreItem(title, desc),
      });
    }
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
      NEWS_SOURCES.map(s => fetchRSS(s).then(items => ({ source: s.name, items, ok: true }))
                                        .catch(e => ({ source: s.name, items: [], ok: false, error: e.message })))
    );

    sourceResults.forEach(r => {
      if (r.status === 'fulfilled') allItems.push(...r.value.items);
    });

    // Sort: score desc, then date desc — take top 60
    allItems.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.date) - new Date(a.date);
    });

    const payload = {
      items: allItems.slice(0, 60),
      total: allItems.length,
      sources: sourceResults.map(r => r.value || r.reason),
      fetchedAt: new Date().toISOString(),
      cached: false,
      age: 0,
    };

    if (allItems.length > 0) newsCache = { data: payload, ts: now };
    res.json(payload);
  } catch (err) {
    console.error('News fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});


app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Agrotex running on port ${PORT}`));
