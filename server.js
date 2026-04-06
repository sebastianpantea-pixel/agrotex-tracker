const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || 'agrotex2025';
const SESSION_SECRET = process.env.SESSION_SECRET || 'agrotex-secret-key-change-me';

// DB setup
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
  db.prepare("UPDATE products SET data = ?, updated_at = datetime('now') WHERE id = (SELECT id FROM products LIMIT 1)")
    .run(JSON.stringify(req.body));
  res.json({ ok: true });
});

// ── MATIF QUOTES ──────────────────────────────────────────────────────────────
let matifCache = { data: null, ts: 0 };
const MATIF_TTL = 5 * 60 * 1000;

const MATIF_CONTRACTS = [
  { key: 'wheat',    code: 'EBM-DPAR', name: 'Grâu (EBM)'    },
  { key: 'corn',     code: 'EMA-DPAR', name: 'Porumb (EMA)'  },
  { key: 'rapeseed', code: 'ECO-DPAR', name: 'Rapiță (ECO)'  },
];

async function fetchMatifContract(code) {
  const [symbol, mic] = code.split('-');
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
      return res.json({
        ...matifCache.data,
        cached: true,
        age: Math.round((now - matifCache.ts) / 1000),
      });
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

// ── TARGET ────────────────────────────────────────────────────────────────────
app.get('/api/target/:year', requireAuth, (req, res) => {
  const row = db.prepare('SELECT data FROM target WHERE year = ?').get(req.params.year);
  res.json(row ? JSON.parse(row.data) : null);
});

app.put('/api/target/:year', requireAuth, (req, res) => {
  const year = parseInt(req.params.year, 10);
  const data = JSON.stringify(req.body);

  db.prepare(`
    INSERT INTO target (year, data, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(year) DO UPDATE
    SET data = excluded.data, updated_at = excluded.updated_at
  `).run(year, data);

  res.json({ ok: true });
});

// ── NEWS ──────────────────────────────────────────────────────────────────────
let newsCache = { data: null, ts: 0 };
const NEWS_TTL = 15 * 60 * 1000;

const NEWS_SOURCES = [
  { name: 'Agrointeligenta', url: 'https://agrointel.ro/feed',                     lang: 'ro', tag: 'RO',    filter: null },
  { name: 'Ziarul Financiar', url: 'https://www.zf.ro/rss',                        lang: 'ro', tag: 'RO',    filter: null },
  { name: 'Bursa.ro',         url: 'https://www.bursa.ro/rss.xml',                 lang: 'ro', tag: 'RO',    filter: null },
  { name: 'HotNews Eco',      url: 'https://economie.hotnews.ro/rss',              lang: 'ro', tag: 'RO',    filter: null },
  { name: 'USDA News',        url: 'https://www.usda.gov/rss/latest-releases.xml', lang: 'en', tag: 'INT',   filter: 'grain' },
  { name: 'Brownfield Ag',    url: 'https://brownfieldagnews.com/feed',            lang: 'en', tag: 'INT',   filter: null },
  { name: 'Northern Ag',      url: 'https://northernag.net/feed',                  lang: 'en', tag: 'INT',   filter: null },
  { name: 'SpreadCharts',     url: 'https://spreadcharts.com/feed',                lang: 'en', tag: 'INT',   filter: null },
  { name: 'OilPrice',         url: 'https://oilprice.com/rss/main',                lang: 'en', tag: 'MACRO', filter: null },
  { name: 'Farm Progress',    url: 'https://www.farmprogress.com/rss/all',         lang: 'en', tag: 'INT',   filter: null },
];

const USDA_GRAIN_KEYWORDS = [
  'wheat','corn','grain','soybean','soy','rapeseed','canola','sunflower',
  'oilseed','barley','crop','harvest','export','wasde','comodity','commodity',
  'cereale','porumb','grau','rapita'
];

const KEYWORDS_HIGH = ['grâu','wheat','porumb','corn','rapiță','rapeseed','canola','cereale','grain','oleaginoase','oilseed','MATIF','CBOT','futures','recoltă','harvest','export','import','USDA','IGC','Euronext'];
const KEYWORDS_MED  = ['agricol','agricultură','agriculture','fermier','farmer','piață','market','preț','price','România','Romania','UE','EU','subvenț','subsid'];

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
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
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
      return res.json({
        ...newsCache.data,
        cached: true,
        age: Math.round((now - newsCache.ts) / 1000),
      });
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

        return {
          name: s.name,
          tag: s.tag,
          filter: s.filter || 'none',
          url: s.url,
          status: r.status,
          ok: r.ok,
          totalItems,
          recent24h: recent,
          ms: Date.now() - start,
        };
      } catch (e) {
        return {
          name: s.name,
          tag: s.tag,
          url: s.url,
          status: 0,
          ok: false,
          error: e.message,
          ms: Date.now() - start,
        };
      }
    })
  );

  res.json(results.map(r => r.value || r.reason));
});

// ── WEATHER / AGRO-METEO ──────────────────────────────────────────────────────
const WEATHER_PRESETS = [
  { key: 'oradea',          name: 'Oradea',          lat: 47.0722, lon: 21.9211, country: 'Romania' },
  { key: 'valea-lui-mihai', name: 'Valea lui Mihai', lat: 47.5167, lon: 22.1500, country: 'Romania' },
  { key: 'carei',           name: 'Carei',           lat: 47.6833, lon: 22.4667, country: 'Romania' },
  { key: 'sacueni',         name: 'Săcueni',         lat: 47.3500, lon: 22.1000, country: 'Romania' },
  { key: 'apa',             name: 'Apa',             lat: 47.7667, lon: 23.1833, country: 'Romania' },
];

let weatherCache = new Map();
const WEATHER_TTL = 30 * 60 * 1000;
const GEO_TTL = 12 * 60 * 60 * 1000;

function weatherCacheGet(key) {
  const item = weatherCache.get(key);
  if (!item) return null;
  if (Date.now() - item.ts > item.ttl) {
    weatherCache.delete(key);
    return null;
  }
  return item.data;
}

function weatherCacheSet(key, data, ttl = WEATHER_TTL) {
  weatherCache.set(key, { data, ts: Date.now(), ttl });
}

function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function safeNum(v, digits = 1) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : null;
}

function sum(arr) {
  return (arr || []).reduce((s, v) => s + (Number(v) || 0), 0);
}

function max(arr) {
  const nums = (arr || []).map(v => Number(v)).filter(v => Number.isFinite(v));
  return nums.length ? Math.max(...nums) : null;
}

function min(arr) {
  const nums = (arr || []).map(v => Number(v)).filter(v => Number.isFinite(v));
  return nums.length ? Math.min(...nums) : null;
}

function avg(arr) {
  const nums = (arr || []).map(v => Number(v)).filter(v => Number.isFinite(v));
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function calcDaysSinceLastRain(times, values, threshold = 0.2) {
  if (!times || !values || times.length !== values.length) return null;

  for (let i = values.length - 1; i >= 0; i--) {
    if ((Number(values[i]) || 0) >= threshold) {
      const dt = new Date(times[i] + 'T12:00:00');
      const now = new Date();
      const diff = Math.floor((now - dt) / (24 * 60 * 60 * 1000));
      return diff < 0 ? 0 : diff;
    }
  }

  return null;
}

function weatherCodeLabel(code) {
  const c = Number(code);
  if (c === 0) return 'senin';
  if ([1, 2, 3].includes(c)) return 'variabil';
  if ([45, 48].includes(c)) return 'ceață';
  if ([51, 53, 55, 56, 57].includes(c)) return 'burniță';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(c)) return 'ploaie';
  if ([71, 73, 75, 77, 85, 86].includes(c)) return 'ninsoare';
  if ([95, 96, 99].includes(c)) return 'furtună';
  return 'mixt';
}

function buildRisk(summary) {
  const out = [];

  if (summary.daysSinceRain !== null && summary.daysSinceRain >= 7) out.push('fără ploaie 7+ zile');
  if (summary.daysSinceRain !== null && summary.daysSinceRain >= 14) out.push('deficit de apă');
  if ((summary.next7Precip || 0) >= 25) out.push('ploi consistente în 7 zile');
  if ((summary.maxWind7 || 0) >= 45) out.push('vânt puternic');
  if ((summary.minTemp7 || 99) <= 0) out.push('risc îngheț');
  if ((summary.maxTemp7 || -99) >= 30) out.push('stress termic');

  if (!out.length) out.push('fără risc major');
  return out.slice(0, 3);
}

async function fetchOpenMeteoForecast(lat, lon) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat);
  url.searchParams.set('longitude', lon);
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '7');
  url.searchParams.set('current', [
    'temperature_2m',
    'relative_humidity_2m',
    'precipitation',
    'weather_code',
    'wind_speed_10m'
  ].join(','));
  url.searchParams.set('daily', [
    'weather_code',
    'temperature_2m_max',
    'temperature_2m_min',
    'precipitation_sum',
    'wind_speed_10m_max',
    'relative_humidity_2m_mean'
  ].join(','));

  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Forecast HTTP ${res.status}`);
  return await res.json();
}

async function fetchOpenMeteoHistory(lat, lon, daysBack = 45) {
  const end = new Date();
  end.setDate(end.getDate() - 1);

  const start = new Date(end);
  start.setDate(start.getDate() - (daysBack - 1));

  const url = new URL('https://historical-forecast-api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat);
  url.searchParams.set('longitude', lon);
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('start_date', isoDate(start));
  url.searchParams.set('end_date', isoDate(end));
  url.searchParams.set('daily', 'precipitation_sum');

  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`History HTTP ${res.status}`);
  return await res.json();
}

function buildWeatherPayload(meta, forecast, history) {
  const current = forecast.current || {};
  const daily = forecast.daily || {};
  const histDaily = history.daily || {};

  const dailyForecast = (daily.time || []).map((date, i) => ({
    date,
    weatherCode: daily.weather_code?.[i] ?? null,
    weatherLabel: weatherCodeLabel(daily.weather_code?.[i]),
    tempMax: safeNum(daily.temperature_2m_max?.[i]),
    tempMin: safeNum(daily.temperature_2m_min?.[i]),
    precip: safeNum(daily.precipitation_sum?.[i]),
    windMax: safeNum(daily.wind_speed_10m_max?.[i]),
    humidityMean: safeNum(daily.relative_humidity_2m_mean?.[i], 0),
  }));

  const histTimes = histDaily.time || [];
  const histPrecip = histDaily.precipitation_sum || [];

  const last7 = histPrecip.slice(-7);
  const last30 = histPrecip.slice(-30);

  const summary = {
    currentTemp: safeNum(current.temperature_2m),
    currentHumidity: safeNum(current.relative_humidity_2m, 0),
    currentWind: safeNum(current.wind_speed_10m),
    currentPrecip: safeNum(current.precipitation),
    currentWeatherCode: current.weather_code ?? null,
    currentWeatherLabel: weatherCodeLabel(current.weather_code),
    next7Precip: safeNum(sum(daily.precipitation_sum), 1),
    last7Precip: safeNum(sum(last7), 1),
    last30Precip: safeNum(sum(last30), 1),
    minTemp7: safeNum(min(daily.temperature_2m_min)),
    maxTemp7: safeNum(max(daily.temperature_2m_max)),
    maxWind7: safeNum(max(daily.wind_speed_10m_max)),
    avgHumidity7: safeNum(avg(daily.relative_humidity_2m_mean), 0),
    daysSinceRain: calcDaysSinceLastRain(histTimes, histPrecip, 0.2),
  };

  summary.risks = buildRisk(summary);

  return {
    location: {
      name: meta.name,
      country: meta.country || '',
      latitude: meta.lat,
      longitude: meta.lon,
      timezone: forecast.timezone || 'auto',
    },
    summary,
    dailyForecast,
    history: {
      last7PrecipDaily: last7,
      last30PrecipDaily: last30,
      dailyDates: histTimes,
      dailyPrecip: histPrecip,
    },
    fetchedAt: new Date().toISOString(),
  };
}

async function getWeatherForLocation(meta) {
  const key = `wx:${meta.lat}:${meta.lon}`;
  const cached = weatherCacheGet(key);
  if (cached) return cached;

  const [forecast, history] = await Promise.all([
    fetchOpenMeteoForecast(meta.lat, meta.lon),
    fetchOpenMeteoHistory(meta.lat, meta.lon, 45),
  ]);

  const payload = buildWeatherPayload(meta, forecast, history);
  weatherCacheSet(key, payload, WEATHER_TTL);
  return payload;
}

app.get('/api/weather/presets', requireAuth, async (req, res) => {
  try {
    const results = await Promise.all(
      WEATHER_PRESETS.map(async (preset) => {
        try {
          return await getWeatherForLocation({ ...preset, lat: preset.lat, lon: preset.lon });
        } catch (e) {
          return {
            location: {
              name: preset.name,
              country: preset.country,
              latitude: preset.lat,
              longitude: preset.lon,
            },
            error: e.message,
            fetchedAt: new Date().toISOString(),
          };
        }
      })
    );

    res.json({ items: results, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Weather presets error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/weather/location', requireAuth, async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const name = String(req.query.name || 'Locație');
    const country = String(req.query.country || '');

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: 'Lat/Lon invalide' });
    }

    const payload = await getWeatherForLocation({ name, country, lat, lon });
    res.json(payload);
  } catch (err) {
    console.error('Weather location error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/weather/search', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ results: [] });

    const key = `geo:${q.toLowerCase()}`;
    const cached = weatherCacheGet(key);
    if (cached) return res.json({ results: cached });

    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.searchParams.set('name', q);
    url.searchParams.set('count', '8');
    url.searchParams.set('language', 'ro');
    url.searchParams.set('format', 'json');

    const geoRes = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!geoRes.ok) throw new Error(`Geocoding HTTP ${geoRes.status}`);

    const geo = await geoRes.json();
    const results = (geo.results || []).map(x => ({
      id: x.id,
      name: x.name,
      country: x.country || '',
      admin1: x.admin1 || '',
      admin2: x.admin2 || '',
      latitude: x.latitude,
      longitude: x.longitude,
      timezone: x.timezone || '',
    }));

    weatherCacheSet(key, results, GEO_TTL);
    res.json({ results });
  } catch (err) {
    console.error('Weather search error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── STATIC ────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Agrotex running on port ${PORT}`));
