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
  CREATE TABLE IF NOT EXISTS target (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(year)
  );
`);

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
      const copy = { ...t };
      delete copy.id;
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

// ── MATIF QUOTES ──────────────────────────────────────────────────────────────
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
          results[key] = {
            name,
            code,
            front,
            allRows: rows.slice(0, 6),
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

    const hasData = Object.values(results).some(r => r.front !== null);
    if (hasData) matifCache = { data: payload, ts: now };

    res.json(payload);
  } catch (err) {
    console.error('MATIF fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── TARGET / BUDGET ───────────────────────────────────────────────────────────
app.get('/api/target/:year', requireAuth, (req, res) => {
  const row = db.prepare('SELECT data FROM target WHERE year = ?').get(req.params.year);
  res.json(row ? JSON.parse(row.data) : null);
});

app.put('/api/target/:year', requireAuth, (req, res) => {
  const year = parseInt(req.params.year, 10);
  const data = JSON.stringify(req.body);
  db.prepare(`
    INSERT INTO target (year, data, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(year) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(year, data);
  res.json({ ok: true });
});

// ── NEWS ──────────────────────────────────────────────────────────────────────
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

const USDA_GRAIN_KEYWORDS = [
  'wheat','corn','grain','soybean','soy','rapeseed','canola','sunflower',
  'oilseed','barley','crop','harvest','export','wasde','comodity','commodity',
  'cereale','porumb','grau','rapita'
];

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
    headers: {
      'User-Agent': 'Mozilla/5.0 AgrotexTracker/1.0 RSS Reader',
      'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    },
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
      const r = new RegExp(`<${tag}[^>]*>(?:<!\$begin:math:display$CDATA\\\\\[\)\?\(\[\\\\s\\\\S\]\*\?\)\(\?\:\\$end:math:display$\\]>)?<\\/${tag}>`, 'i');
      const match = r.exec(block);
      return match
        ? match[1]
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g,'&')
            .replace(/&lt;/g,'<')
            .replace(/&gt;/g,'>')
            .replace(/&quot;/g,'"')
            .replace(/&#39;/g,"'")
            .trim()
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
      NEWS_SOURCES.map(s =>
        fetchRSS(s)
          .then(items => ({ source: s.name, items, ok: true }))
          .catch(e => ({ source: s.name, items: [], ok: false, error: e.message }))
      )
    );

    sourceResults.forEach(r => {
      if (r.status === 'fulfilled') allItems.push(...r.value.items);
    });

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

app.get('/api/news/test', requireAuth, async (req, res) => {
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
  const results = await Promise.allSettled(
    NEWS_SOURCES.map(async (s) => {
      const start = Date.now();
      try {
        const r = await fetch(s.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 AgrotexTracker/1.0 RSS Reader' },
          signal: AbortSignal.timeout(10000),
        });
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

// ── WEATHER / OPEN-METEO ──────────────────────────────────────────────────────
const WEATHER_PRESET_LOCATIONS = [
  { name: 'Oradea', country: 'Romania', latitude: 47.0722, longitude: 21.9211, timezone: 'Europe/Bucharest' },
  { name: 'Apa', country: 'Romania', latitude: 47.7667, longitude: 23.1833, timezone: 'Europe/Bucharest' },
  { name: 'Valea lui Mihai', country: 'Romania', latitude: 47.5167, longitude: 22.1500, timezone: 'Europe/Bucharest' },
  { name: 'Carei', country: 'Romania', latitude: 47.6833, longitude: 22.4667, timezone: 'Europe/Bucharest' },
  { name: 'Săcueni', country: 'Romania', latitude: 47.3500, longitude: 22.1000, timezone: 'Europe/Bucharest' },
];

let weatherPresetCache = { data: null, ts: 0 };
const WEATHER_PRESET_TTL = 30 * 60 * 1000;

function round2(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
}

function averageOrNull(values) {
  const vals = values.filter(v => Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function sumOrZero(values) {
  return values.reduce((a, b) => a + (Number(b) || 0), 0);
}

function maxOrNull(values) {
  const vals = values.filter(v => Number.isFinite(v));
  return vals.length ? Math.max(...vals) : null;
}

function minOrNull(values) {
  const vals = values.filter(v => Number.isFinite(v));
  return vals.length ? Math.min(...vals) : null;
}

function weatherCodeToLabel(code) {
  const map = {
    0: 'senin',
    1: 'mai mult senin',
    2: 'variabil',
    3: 'noros',
    45: 'ceață',
    48: 'ceață depusă',
    51: 'burniță',
    53: 'burniță',
    55: 'burniță densă',
    56: 'lapoviță fină',
    57: 'lapoviță densă',
    61: 'ploaie slabă',
    63: 'ploaie',
    65: 'ploaie puternică',
    66: 'ploaie înghețată',
    67: 'ploaie înghețată',
    71: 'ninsoare',
    73: 'ninsoare',
    75: 'ninsoare puternică',
    77: 'grăunțe de zăpadă',
    80: 'averse',
    81: 'averse',
    82: 'averse puternice',
    85: 'averse ninsoare',
    86: 'averse ninsoare',
    95: 'furtună',
    96: 'furtună cu grindină',
    99: 'furtună cu grindină',
  };
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
    const ts = times[i];
    const date = String(ts).slice(0, 10);
    if (!byDate[date]) {
      byDate[date] = {
        s01: [],
        s13: [],
        s39: [],
        s927: [],
        s2781: [],
      };
    }
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
    const mid = averageOrNull([
      averageOrNull(v.s13),
      averageOrNull(v.s39),
      averageOrNull(v.s927),
    ]);
    const deep = averageOrNull([
      averageOrNull(v.s2781),
    ]);
    out[date] = {
      soilSurface: round2(surface),
      soilMid: round2(mid),
      soilDeep: round2(deep),
    };
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

  return {
    location,
    summary,
    dailyForecast,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchJsonWithDebug(url, label) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'AgrotexTracker/1.0' },
    signal: AbortSignal.timeout(15000),
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} invalid JSON, status=${res.status}, body=${text.slice(0, 400)}`);
  }

  if (!res.ok) {
    throw new Error(`${label} HTTP ${res.status}, body=${text.slice(0, 400)}`);
  }

  return json;
}

async function fetchWeatherForLocation(location) {
  const params = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    timezone: location.timezone || 'auto',
    current: [
      'temperature_2m',
      'relative_humidity_2m',
      'precipitation',
      'weather_code',
      'wind_speed_10m'
    ].join(','),
    daily: [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_sum',
      'wind_speed_10m_max',
      'relative_humidity_2m_mean'
    ].join(','),
    hourly: [
      'soil_moisture_0_to_1cm',
      'soil_moisture_1_to_3cm',
      'soil_moisture_3_to_9cm',
      'soil_moisture_9_to_27cm',
      'soil_moisture_27_to_81cm'
    ].join(','),
    past_days: '30',
    forecast_days: '7',
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  const raw = await fetchJsonWithDebug(url, `Open-Meteo forecast ${location.name}`);

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

  const pastDaily = {
    time: dailyIndexesPast.map(i => raw.daily.time?.[i]),
    precipitation_sum: dailyIndexesPast.map(i => raw.daily.precipitation_sum?.[i]),
  };

  return buildWeatherPayload(location, {
    current: raw.current,
    daily: futureDaily,
    pastDaily,
    hourly: raw.hourly || {},
  });
}

app.get('/api/weather/presets', requireAuth, async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1';
    const now = Date.now();

    if (!forceRefresh && weatherPresetCache.data && (now - weatherPresetCache.ts) < WEATHER_PRESET_TTL) {
      return res.json({
        ...weatherPresetCache.data,
        cached: true,
        age: Math.round((now - weatherPresetCache.ts) / 1000),
      });
    }

    const results = await Promise.allSettled(
      WEATHER_PRESET_LOCATIONS.map(async (location) => {
        try {
          const data = await fetchWeatherForLocation(location);
          return data;
        } catch (e) {
          console.error(`Weather location failed: ${location.name}`, e);
          return {
            location,
            error: e.message,
            fetchedAt: new Date().toISOString(),
          };
        }
      })
    );

    const items = results.map(r => r.status === 'fulfilled' ? r.value : ({
      location: { name: 'Necunoscut', country: '' },
      error: r.reason?.message || 'Unknown error',
      fetchedAt: new Date().toISOString(),
    }));

    const payload = {
      items,
      fetchedAt: new Date().toISOString(),
      cached: false,
      age: 0,
    };

    weatherPresetCache = { data: payload, ts: now };
    res.json(payload);
  } catch (err) {
    console.error('Weather presets error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/weather/search', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ results: [] });

    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=ro&format=json`;
    const data = await fetchJsonWithDebug(url, 'Open-Meteo geocoding');

    const results = (data.results || []).map(item => ({
      name: item.name,
      country: item.country || '',
      admin1: item.admin1 || '',
      admin2: item.admin2 || '',
      latitude: item.latitude,
      longitude: item.longitude,
      timezone: item.timezone || 'auto',
    }));

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

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: 'lat/lon invalid' });
    }

    const payload = await fetchWeatherForLocation({
      name,
      country,
      latitude: lat,
      longitude: lon,
      timezone,
    });

    res.json(payload);
  } catch (err) {
    console.error('Weather location error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── DEBUG WEATHER ─────────────────────────────────────────────────────────────
app.get('/api/weather/debug', requireAuth, async (req, res) => {
  try {
    const testUrl = 'https://api.open-meteo.com/v1/forecast?latitude=47.0722&longitude=21.9211&timezone=Europe%2FBucharest&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,relative_humidity_2m_mean&hourly=soil_moisture_0_to_1cm,soil_moisture_1_to_3cm,soil_moisture_3_to_9cm,soil_moisture_9_to_27cm,soil_moisture_27_to_81cm&past_days=30&forecast_days=7';

    const r = await fetch(testUrl, {
      headers: { 'User-Agent': 'AgrotexTracker/1.0' },
      signal: AbortSignal.timeout(15000),
    });

    const text = await r.text();

    res.json({
      ok: r.ok,
      status: r.status,
      preview: text.slice(0, 1200)
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      stack: err.stack
    });
  }
});

app.get('/api/weather/debug/preset', requireAuth, async (req, res) => {
  try {
    const name = String(req.query.name || 'Oradea').toLowerCase();
    const location = WEATHER_PRESET_LOCATIONS.find(x => x.name.toLowerCase() === name) || WEATHER_PRESET_LOCATIONS[0];
    const payload = await fetchWeatherForLocation(location);
    res.json({
      location,
      summary: payload.summary,
      forecastCount: payload.dailyForecast?.length || 0,
      firstForecast: payload.dailyForecast?.[0] || null
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      stack: err.stack
    });
  }
});

// ── STATIC ────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Agrotex running on port ${PORT}`));
