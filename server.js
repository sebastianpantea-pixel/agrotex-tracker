const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || 'agrotex2025';
const SESSION_SECRET = process.env.SESSION_SECRET || 'agrotex-secret-key-change-me';

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
app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
app.get('/api/me', (req, res) => { res.json({ authenticated: !!req.session.authenticated }); });

app.get('/api/trades', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, data FROM trades ORDER BY id DESC').all();
  res.json(rows.map(r => ({ ...JSON.parse(r.data), id: r.id })));
});
app.post('/api/trades', requireAuth, (req, res) => {
  const trade = req.body; delete trade.id;
  const info = db.prepare('INSERT INTO trades (data) VALUES (?)').run(JSON.stringify(trade));
  res.json({ id: info.lastInsertRowid });
});
app.post('/api/trades/bulk', requireAuth, (req, res) => {
  const { trades } = req.body;
  if (!Array.isArray(trades)) return res.status(400).json({ error: 'Invalid' });
  const insert = db.prepare('INSERT INTO trades (data) VALUES (?)');
  db.transaction((items) => { for (const t of items) { const c={...t}; delete c.id; insert.run(JSON.stringify(c)); } })(trades);
  res.json({ ok: true, count: trades.length });
});
app.put('/api/trades/:id', requireAuth, (req, res) => {
  const trade = req.body; delete trade.id;
  db.prepare('UPDATE trades SET data = ? WHERE id = ?').run(JSON.stringify(trade), req.params.id);
  res.json({ ok: true });
});
app.delete('/api/trades/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM trades WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
app.get('/api/products', requireAuth, (req, res) => {
  res.json(JSON.parse(db.prepare('SELECT data FROM products LIMIT 1').get().data));
});
app.put('/api/products', requireAuth, (req, res) => {
  db.prepare("UPDATE products SET data=?,updated_at=datetime('now') WHERE id=(SELECT id FROM products LIMIT 1)").run(JSON.stringify(req.body));
  res.json({ ok: true });
});

// ── MATIF ─────────────────────────────────────────────────────────────────────
let matifCache = { data: null, ts: 0 };
const MATIF_TTL = 5 * 60 * 1000;
const MATIF_CONTRACTS = [
  { key:'wheat',    code:'EBM-DPAR', name:'Grâu (EBM)'   },
  { key:'corn',     code:'EMA-DPAR', name:'Porumb (EMA)'  },
  { key:'rapeseed', code:'ECO-DPAR', name:'Rapiță (ECO)' },
];
async function fetchMatifContract(code) {
  const [symbol, mic] = code.split('-');
  const res = await fetch(`https://live.euronext.com/en/ajax/getPricesFutures/commodities-futures/${symbol}/${mic}`, {
    headers: { 'User-Agent':'Mozilla/5.0','Accept':'text/html,*/*;q=0.01','X-Requested-With':'XMLHttpRequest','Referer':`https://live.euronext.com/en/product/commodities-futures/${code}` },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi; let trM;
  while ((trM = trRe.exec(html)) !== null) {
    const cells = []; const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi; let tdM;
    while ((tdM = tdRe.exec(trM[1])) !== null) cells.push(tdM[1].replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').trim());
    if (cells.length >= 6 && /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}$/.test(cells[0])) {
      const p = s => { const n=parseFloat((s||'').replace(',','.')); return isNaN(n)?null:n; };
      rows.push({ delivery:cells[0], bid:p(cells[1]), ask:p(cells[2]), last:p(cells[3]), change:p(cells[5]), settl:p(cells[10])||p(cells[9])||p(cells[8]), isOpen:p(cells[3])!==null });
    }
  }
  return rows;
}
app.get('/api/matif', requireAuth, async (req, res) => {
  try {
    const now = Date.now();
    if (matifCache.data && (now - matifCache.ts) < MATIF_TTL) return res.json({ ...matifCache.data, cached:true });
    const results = {}; const errors = {};
    await Promise.allSettled(MATIF_CONTRACTS.map(async ({ key, code, name }) => {
      try {
        const rows = await fetchMatifContract(code);
        const front = rows.find(r => r.bid !== null || r.settl !== null) || rows[0] || null;
        results[key] = { name, code, front, allRows: rows.slice(0,6) };
      } catch(e) { errors[key]=e.message; results[key]={name,code,front:null,allRows:[],error:e.message}; }
    }));
    const payload = { quotes:results, errors, fetchedAt:new Date().toISOString(), cached:false };
    if (Object.values(results).some(r => r.front !== null)) matifCache = { data:payload, ts:now };
    res.json(payload);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── TARGET ────────────────────────────────────────────────────────────────────
app.get('/api/target/:year', requireAuth, (req, res) => {
  const row = db.prepare('SELECT data FROM target WHERE year=?').get(req.params.year);
  res.json(row ? JSON.parse(row.data) : null);
});
app.put('/api/target/:year', requireAuth, (req, res) => {
  db.prepare("INSERT INTO target(year,data,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(year) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at")
    .run(parseInt(req.params.year,10), JSON.stringify(req.body));
  res.json({ ok: true });
});

// ── NEWS ──────────────────────────────────────────────────────────────────────
let newsCache = { data: null, ts: 0 };
const NEWS_TTL = 15 * 60 * 1000;
const NEWS_SOURCES = [
  { name:'Agrointeligenta',  url:'https://agrointel.ro/feed',                     lang:'ro', filter:null  },
  { name:'Ziarul Financiar', url:'https://www.zf.ro/rss',                         lang:'ro', filter:null  },
  { name:'Bursa.ro',         url:'https://www.bursa.ro/rss.xml',                  lang:'ro', filter:null  },
  { name:'HotNews Eco',      url:'https://economie.hotnews.ro/rss',               lang:'ro', filter:null  },
  { name:'USDA News',        url:'https://www.usda.gov/rss/latest-releases.xml',  lang:'en', filter:'grain'},
  { name:'Brownfield Ag',    url:'https://brownfieldagnews.com/feed',             lang:'en', filter:null  },
  { name:'Northern Ag',      url:'https://northernag.net/feed',                   lang:'en', filter:null  },
  { name:'OilPrice',         url:'https://oilprice.com/rss/main',                 lang:'en', filter:null  },
  { name:'Farm Progress',    url:'https://www.farmprogress.com/rss/all',          lang:'en', filter:null  },
];
const GRAIN_KW = ['wheat','corn','grain','soybean','rapeseed','canola','sunflower','oilseed','barley','crop','harvest','export','wasde','commodity','cereale','porumb','grau','rapita'];
const KW_HIGH  = ['grâu','wheat','porumb','corn','rapiță','rapeseed','cereale','grain','oleaginoase','oilseed','MATIF','CBOT','futures','recoltă','harvest','export','import','USDA','Euronext'];
const KW_MED   = ['agricol','agricultură','agriculture','fermier','piață','market','preț','price','România','Romania','UE','EU'];
function scoreItem(t,d){ const tx=((t||'')+(d||'')).toLowerCase(); let s=0; KW_HIGH.forEach(k=>{if(tx.includes(k.toLowerCase()))s+=3;}); KW_MED.forEach(k=>{if(tx.includes(k.toLowerCase()))s+=1;}); return s; }
async function fetchRSS(source) {
  const res = await fetch(source.url, { headers:{'User-Agent':'AgrotexTracker/1.0','Accept':'application/rss+xml,text/xml,*/*'}, signal:AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text(); const items = []; const cut = Date.now()-86400000;
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi; let m;
  while ((m=re.exec(xml))!==null) {
    const b=m[1];
    const get=tag=>{ const r=new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`,'i'); const x=r.exec(b); return x?x[1].replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').trim():''; };
    const title=get('title'), link=get('link')||(/<link>([\s\S]*?)<\/link>/i.exec(b)||[])[1]||'', desc=get('description').substring(0,200), pubDate=get('pubDate')||get('dc:date')||'';
    const date=pubDate?new Date(pubDate):new Date();
    if(!title||!link) continue; if(date.getTime()<cut) continue;
    if(source.filter==='grain'&&!GRAIN_KW.some(k=>(title+desc).toLowerCase().includes(k))) continue;
    items.push({ title, link:link.trim(), desc, date:date.toISOString(), source:source.name, lang:source.lang, score:scoreItem(title,desc) });
  }
  return items;
}
app.get('/api/news', requireAuth, async (req, res) => {
  try {
    const now=Date.now();
    if(newsCache.data&&(now-newsCache.ts)<NEWS_TTL) return res.json({...newsCache.data,cached:true});
    const allItems=[];
    const sr=await Promise.allSettled(NEWS_SOURCES.map(s=>fetchRSS(s).then(i=>({items:i,ok:true})).catch(e=>({items:[],ok:false,error:e.message}))));
    sr.forEach(r=>{if(r.status==='fulfilled')allItems.push(...r.value.items);});
    allItems.sort((a,b)=>b.score!==a.score?b.score-a.score:new Date(b.date)-new Date(a.date));
    const payload={items:allItems.slice(0,60),total:allItems.length,fetchedAt:new Date().toISOString(),cached:false};
    if(allItems.length>0) newsCache={data:payload,ts:now};
    res.json(payload);
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ── WEATHER — BATCH REQUEST (o singură cerere pentru toate locațiile) ──────────
// Open-Meteo suportă multiple latitudini/longitudini într-un singur request
// Returnează un array JSON în loc de un obiect

const WEATHER_PRESET_LOCATIONS = [
  { name:'Oradea',          country:'Romania', latitude:47.0722, longitude:21.9211, timezone:'Europe/Bucharest' },
  { name:'Apa',             country:'Romania', latitude:47.7667, longitude:23.1833, timezone:'Europe/Bucharest' },
  { name:'Valea lui Mihai', country:'Romania', latitude:47.5167, longitude:22.1500, timezone:'Europe/Bucharest' },
  { name:'Carei',           country:'Romania', latitude:47.6833, longitude:22.4667, timezone:'Europe/Bucharest' },
  { name:'Săcueni',         country:'Romania', latitude:47.3500, longitude:22.1000, timezone:'Europe/Bucharest' },
];

let weatherPresetCache = { data: null, ts: 0 };
const WEATHER_PRESET_TTL = 30 * 60 * 1000;

function r2(n){ const x=Number(n); return Number.isFinite(x)?Math.round(x*100)/100:null; }
function sumZ(a){ return (a||[]).reduce((s,v)=>s+(Number(v)||0),0); }
function maxN(a){ const v=(a||[]).filter(x=>Number.isFinite(Number(x))).map(Number); return v.length?Math.max(...v):null; }
function minN(a){ const v=(a||[]).filter(x=>Number.isFinite(Number(x))).map(Number); return v.length?Math.min(...v):null; }

function wxLabel(code){
  const m={0:'senin',1:'mai mult senin',2:'variabil',3:'noros',45:'ceață',48:'ceață depusă',51:'burniță',53:'burniță',55:'burniță densă',61:'ploaie slabă',63:'ploaie',65:'ploaie puternică',71:'ninsoare',73:'ninsoare',75:'ninsoare puternică',80:'averse',81:'averse',82:'averse puternice',95:'furtună',96:'furtună cu grindină',99:'furtună cu grindină'};
  return m[code]||'necunoscut';
}

function buildRisks(daily, current){
  const risks=[];
  const mn=minN(daily.temperature_2m_min||[]), mx=maxN(daily.wind_speed_10m_max||[]), mr=maxN(daily.precipitation_sum||[]), ct=Number(current.temperature_2m);
  if(Number.isFinite(mn)&&mn<=0)      risks.push('risc îngheț');
  if(Number.isFinite(mx)&&mx>=45)     risks.push('vânt puternic');
  if(Number.isFinite(mr)&&mr>=20)     risks.push('ploaie semnificativă');
  if(Number.isFinite(ct)&&ct>=32)     risks.push('stress termic');
  return risks;
}

function daysSinceRain(precip){
  if(!Array.isArray(precip)) return null;
  for(let i=precip.length-1;i>=0;i--) if(Number(precip[i]||0)>=0.5) return precip.length-1-i;
  return null;
}

function buildPayload(location, raw){
  const cur=raw.current||{}, daily=raw.daily||{}, past=raw.pastDaily||{};
  const todayStr = new Date(new Date().toLocaleString('en-US',{timeZone:location.timezone||'UTC'})).toISOString().slice(0,10);
  const allDates=daily.time||[];
  const fi=[], pi=[];
  allDates.forEach((d,i)=>{ if(d<todayStr)pi.push(i); else fi.push(i); });
  const pick=(arr,idxs)=>idxs.map(i=>arr?.[i]??null);

  const fd={
    time:                     pick(daily.time,fi),
    weather_code:             pick(daily.weather_code,fi),
    temperature_2m_max:       pick(daily.temperature_2m_max,fi),
    temperature_2m_min:       pick(daily.temperature_2m_min,fi),
    precipitation_sum:        pick(daily.precipitation_sum,fi),
    wind_speed_10m_max:       pick(daily.wind_speed_10m_max,fi),
    relative_humidity_2m_max: pick(daily.relative_humidity_2m_max,fi),
    soil_moisture_0_to_7cm:   pick(daily.soil_moisture_0_to_7cm,fi),
    soil_moisture_7_to_28cm:  pick(daily.soil_moisture_7_to_28cm,fi),
    soil_moisture_28_to_100cm:pick(daily.soil_moisture_28_to_100cm,fi),
  };
  const pd={ precipitation_sum: pick(daily.precipitation_sum,pi) };

  const forecast=(fd.time||[]).map((date,idx)=>({
    date,
    tempMin:     fd.temperature_2m_min?.[idx]??null,
    tempMax:     fd.temperature_2m_max?.[idx]??null,
    precip:      fd.precipitation_sum?.[idx]??null,
    windMax:     fd.wind_speed_10m_max?.[idx]??null,
    humidityMean:fd.relative_humidity_2m_max?.[idx]??null,
    weatherCode: fd.weather_code?.[idx]??null,
    weatherLabel:wxLabel(fd.weather_code?.[idx]),
    soilSurface: r2(fd.soil_moisture_0_to_7cm?.[idx]),
    soilMid:     r2(fd.soil_moisture_7_to_28cm?.[idx]),
    soilDeep:    r2(fd.soil_moisture_28_to_100cm?.[idx]),
  }));

  const summary={
    currentTemp:         r2(cur.temperature_2m),
    currentHumidity:     r2(cur.relative_humidity_2m),
    currentWind:         r2(cur.wind_speed_10m),
    currentPrecip:       r2(cur.precipitation),
    currentWeatherCode:  Number.isFinite(cur.weather_code)?cur.weather_code:null,
    currentWeatherLabel: wxLabel(cur.weather_code),
    next7Precip:    r2(sumZ(fd.precipitation_sum)),
    last7Precip:    r2(sumZ(pd.precipitation_sum.slice(-7))),
    last30Precip:   r2(sumZ(pd.precipitation_sum)),
    daysSinceRain:  daysSinceRain(pd.precipitation_sum),
    minTemp7:       r2(minN(fd.temperature_2m_min||[])),
    maxTemp7:       r2(maxN(fd.temperature_2m_max||[])),
    maxWind7:       r2(maxN(fd.wind_speed_10m_max||[])),
    soilSurface:    r2(fd.soil_moisture_0_to_7cm?.[0]??null),
    soilMid:        r2(fd.soil_moisture_7_to_28cm?.[0]??null),
    soilDeep:       r2(fd.soil_moisture_28_to_100cm?.[0]??null),
    risks:          buildRisks(fd, cur),
  };

  return { location, summary, dailyForecast:forecast, fetchedAt:new Date().toISOString() };
}

async function fetchAllPresetsInOneBatch() {
  // Un singur request HTTP cu toate cele 5 locații — Open-Meteo batch API
  const lats = WEATHER_PRESET_LOCATIONS.map(l=>l.latitude).join(',');
  const lons = WEATHER_PRESET_LOCATIONS.map(l=>l.longitude).join(',');
  // Toate locațiile sunt în același timezone
  const tz = 'Europe/Bucharest';

  const params = new URLSearchParams({
    latitude:      lats,
    longitude:     lons,
    timezone:      tz,
    current:       'temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
    daily:         'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,relative_humidity_2m_max,soil_moisture_0_to_7cm,soil_moisture_7_to_28cm,soil_moisture_28_to_100cm',
    past_days:     '7',
    forecast_days: '7',
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'AgrotexTracker/1.0' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Open-Meteo HTTP ${res.status}: ${errText.slice(0,200)}`);
  }
  const raw = await res.json();

  // Batch răspuns = array de obiecte, unul per locație
  const rawArray = Array.isArray(raw) ? raw : [raw];

  return rawArray.map((r, idx) => {
    const location = WEATHER_PRESET_LOCATIONS[idx] || { name:'Necunoscut', country:'', latitude:0, longitude:0, timezone:tz };
    try {
      return buildPayload(location, { current: r.current, daily: r.daily, pastDaily: {} });
    } catch(e) {
      return { location, error: e.message, fetchedAt: new Date().toISOString() };
    }
  });
}

async function fetchSingleLocation(location) {
  const params = new URLSearchParams({
    latitude:      String(location.latitude),
    longitude:     String(location.longitude),
    timezone:      location.timezone || 'auto',
    current:       'temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
    daily:         'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,relative_humidity_2m_max,soil_moisture_0_to_7cm,soil_moisture_7_to_28cm,soil_moisture_28_to_100cm',
    past_days:     '7',
    forecast_days: '7',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, {
    headers: { 'User-Agent': 'AgrotexTracker/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Open-Meteo HTTP ${res.status}: ${errText.slice(0,200)}`);
  }
  const raw = await res.json();
  return buildPayload(location, { current: raw.current, daily: raw.daily, pastDaily: {} });
}

// ── TEST endpoint (fără auth) ─────────────────────────────────────────────────
app.get('/api/weather/test', async (req, res) => {
  try {
    const items = await fetchAllPresetsInOneBatch();
    res.json({ ok: true, count: items.length, first: { name: items[0]?.location?.name, temp: items[0]?.summary?.currentTemp, error: items[0]?.error } });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── PRESETS ───────────────────────────────────────────────────────────────────
app.get('/api/weather/presets', requireAuth, async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1';
    const now = Date.now();
    if (!forceRefresh && weatherPresetCache.data && (now - weatherPresetCache.ts) < WEATHER_PRESET_TTL) {
      return res.json({ ...weatherPresetCache.data, cached: true, age: Math.round((now - weatherPresetCache.ts) / 1000) });
    }
    let items;
    try {
      items = await fetchAllPresetsInOneBatch();
    } catch(e) {
      console.error('Batch weather failed:', e.message);
      // Fallback: niciun rezultat, returnează eroare per locație
      items = WEATHER_PRESET_LOCATIONS.map(loc => ({ location: loc, error: e.message, fetchedAt: new Date().toISOString() }));
    }
    const payload = { items, fetchedAt: new Date().toISOString(), cached: false, age: 0 };
    if (items.some(i => !i.error)) weatherPresetCache = { data: payload, ts: now };
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SEARCH ────────────────────────────────────────────────────────────────────
app.get('/api/weather/search', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ results: [] });
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=ro&format=json`, {
      headers: { 'User-Agent': 'AgrotexTracker/1.0' }, signal: AbortSignal.timeout(12000)
    });
    if (!r.ok) throw new Error(`Geocoding HTTP ${r.status}`);
    const data = await r.json();
    res.json({ results: (data.results||[]).map(i=>({ name:i.name, country:i.country||'', admin1:i.admin1||'', admin2:i.admin2||'', latitude:i.latitude, longitude:i.longitude, timezone:i.timezone||'auto' })) });
  } catch(err) { res.status(500).json({ error: err.message, results: [] }); }
});

// ── LOCATION ──────────────────────────────────────────────────────────────────
app.get('/api/weather/location', requireAuth, async (req, res) => {
  try {
    const lat=parseFloat(req.query.lat), lon=parseFloat(req.query.lon);
    if (!Number.isFinite(lat)||!Number.isFinite(lon)) return res.status(400).json({ error:'lat/lon invalid' });
    const payload = await fetchSingleLocation({ name:String(req.query.name||'Locație'), country:String(req.query.country||''), latitude:lat, longitude:lon, timezone:String(req.query.timezone||'auto') });
    res.json(payload);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── STATIC ────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.listen(PORT, () => console.log(`Agrotex running on port ${PORT}`));
