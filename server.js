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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

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

  CREATE TABLE IF NOT EXISTS partners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT,
    deleted_by TEXT
  );

  CREATE TABLE IF NOT EXISTS purchase_contracts (
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

['trades', 'logistics_contracts', 'train_contracts', 'stock_locations', 'stock_entries', 'partners', 'purchase_contracts'].forEach(table => {
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

const GENERATED_CONTRACTS_DIR = path.join(DB_DIR, 'generated_contracts');
if (!fs.existsSync(GENERATED_CONTRACTS_DIR)) fs.mkdirSync(GENERATED_CONTRACTS_DIR, { recursive: true });

const DEFAULT_PARTNERS_SEED = [{"name": "TUR AGRAR SRL", "cui": "RO21061957", "regCom": "J30/227/2007", "iban": "RO64BTRL03101202474808XX", "bank": "Banca Transilvania", "phone": "0740938243", "representative": "____________", "role": "VÂNZĂTOR", "fullText": "TUR AGRAR SRL, cu sediul in Turulung, jud. Satu Mare, str. Principala nr. 114L, înregistrata la C.C.I. Satu Mare, sub nr. J30/227/2007, CIF RO21061957, tel./fax. 0740938243, având contul IBAN RO64BTRL03101202474808XX deschis la Banca Transilvania, reprezentată prin ____________ administrator, în calitate de VÂNZĂTOR."}, {"name": "DEMETER BALINT JOZSEF PFA", "cui": "RO34153718", "regCom": "F30/134/2015", "iban": "RO31CECESM1230RON0455758", "bank": "CEC Bank", "phone": "0746688217", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "DEMETER BALINT JOZSEF PFA cu sediul în APA, NR.496 jud. SATU MARE, înmatriculată sub nr. F30/134/2015 la Reg. C.C.I. Satu Mare, CIF RO34153718, tel./fax. 0746688217, avand contul IBAN RO31CECESM1230RON0455758 deschis la CEC Bank , reprezentată prin _________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "RATYIS MIHALY VIOREL I.I", "cui": "RO18872924", "regCom": "F30/616/2006", "iban": "RO59CECESM0130RON0367964", "bank": "CEC Bank", "phone": "0742762217", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "RATYIS MIHALY VIOREL I.I cu sediul în Dumbrava jud. SATU MARE, nr.111 , înmatriculată sub nr. F30/616/2006 la Reg. C.C.I. Satu Mare, CIF RO18872924, tel./fax. 0742762217, avand contul IBAN RO59 CECE SM01 30RO N036 7964 deschis la CEC Bank , reprezentată prin _________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "AGRIND SINCRAI SRL", "cui": "RO15197009", "regCom": "J30/94/2003", "iban": "RO19BTRL03101202E29364XX", "bank": "Banca Transilvania", "phone": "0744764180/074311612", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "AGRIND SINCRAI SRL cu sediul în JUD. SATU MARE, SAT ERIU SANCRAI COM. CRAIDOROLT, FOSTA SECTIE MECANIZARE , înmatriculată sub nr. J30/94/2003 la Reg. C.C.I. Satu Mare, CIF RO15197009, tel./fax. 0744764180/074311612, avand contul IBAN RO19BTRL03101202E29364XX deschis la Banca Transilvania , reprezentată prin _________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "KIND ZSOLT I.I", "cui": "RO 35309492", "regCom": "F30/743/2015", "iban": "", "bank": "", "phone": "_________________", "representative": "________________________", "role": "VÂNZĂTOR", "fullText": "KIND ZSOLT I.I. cu sediul CAPLENI, NR.512/B, jud. Satu Mare, înmatriculată sub nr. F30/743/2015 , înregistrata la Reg. Comertului Satu Mare , CIF RO 35309492 tel. _________________, având contul deschis la , reprezentată prin ________________________, în calitate de VÂNZĂTOR."}, {"name": "KIND HENRIETTE I.I", "cui": "RO 28065263", "regCom": "F30/130/2011", "iban": "", "bank": "Raiffeisen", "phone": "_________________", "representative": "________________________", "role": "VÂNZĂTOR", "fullText": "KIND HENRIETTE I.I cu sediul CAPLENI, NR.512/B, jud. Satu Mare, înmatriculată sub nr. F30/130/2011 , înregistrata la Reg. Comertului Satu Mare , CIF RO 28065263 tel. _________________, având contul RO26RZBR0000060013330053 deschis la Raiffeisen , reprezentată prin ________________________, în calitate de VÂNZĂTOR."}, {"name": "SIRMIS EXIM SRL VALEA LUI MIHAI", "cui": "RO5021586", "regCom": "J05/3853/1993", "iban": "RO98BTRLRONCRT0385656701", "bank": "Banca Transilvania_suc", "phone": "______________", "representative": "________________________", "role": "VÂNZĂTOR", "fullText": "SIRMIS EXIM SRL VALEA LUI MIHAI cu sediul/domiciliul în Valea lui Mihai , jud. Bihor , înmatriculată sub nr. J05/3853/1993 , CIF RO5021586 , tel./fax. ______________, având codul IBAN RO98 BTRL RONC RT03 8565 6701 deschis la Banca Transilvania_suc./ag._____________________, reprezentată prin ________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "LELENKA IOAN ROBERT I.I", "cui": "RO33577898", "regCom": "F30/565/2014", "iban": "RO46CECESM1630RON0445511", "bank": "CEC BANK S", "phone": "", "representative": "-", "role": "VANZATOR", "fullText": "LELENKA IOAN ROBERT I.I cu sediul/domiciliul in JUD. SATU MARE, ORS. LIVADA, STR. VICTORIEI, NR.65, inmatriculata sub nr. F30/565/2014, inregistrata la Reg. C.C.I. , CIF RO33577898, telefon nr. : , avand codul IBAN RO46CECESM1630RON0445511, deschis la CEC BANK S.A. reprezentata prin - administrator , in calitate de VANZATOR."}, {"name": "AGROPROD TURISM SRL", "cui": "RO29763922", "regCom": "J30/95/2012", "iban": "", "bank": "", "phone": "", "representative": "asociat unic Trandafir Dorina", "role": "VÂNZĂTOR", "fullText": "AGROPROD TURISM SRL cu sediul în loc. IOJIB, NR.103 , jud. Satu Mare , înmatriculata sub nr. J30/95/2012 la Reg.C.C.I. , CIF RO29763922 , reprezentată prin asociat unic Trandafir Dorina, în calitate de VÂNZĂTOR."}, {"name": "SZUCS F. FERENC AGRO PFA", "cui": "RO19976974", "regCom": "F05/21/2006", "iban": "RO93BTRLRONCRT0393662201", "bank": "Banza Transilvania reprezentata prin ________________administrator", "phone": "", "representative": "________________", "role": "VANZATOR", "fullText": "SZUCS F. FERENC AGRO PFA cu sediul/domiciliul in TAMASEU NR 126, Jud. BIHOR, inmatriculata sub nr. F05/21/2006, inregistrata la Reg. C.C.I. BIHOR, CIF RO19976974, telefon nr. : , avand codul IBAN RO93BTRLRONCRT0393662201, deschis la Banza Transilvania reprezentata prin ________________administrator , in calitate de VANZATOR."}, {"name": "SZUCS A. FERENC I.I", "cui": "RO25161940", "regCom": "F05/304/2009", "iban": "RO94BTRLRONCRT0393681001", "bank": "Banza Transilvania reprezentata prin ________________administrator", "phone": "", "representative": "________________", "role": "VANZATOR", "fullText": "SZUCS A. FERENC I.I cu sediul/domiciliul in TAMASEU NR 126, Jud. BIHOR, inmatriculata sub nr. F05/304/2009, inregistrata la Reg. C.C.I. BIHOR, CIF RO25161940, telefon nr. : , avand codul IBAN RO94BTRLRONCRT0393681001, deschis la Banza Transilvania reprezentata prin ________________administrator , in calitate de VANZATOR."}, {"name": "FERENAGRO SRL", "cui": "RO26281651", "regCom": "J05/1538/2009", "iban": "RO45BTRLRONCRT0397309101", "bank": "Banza Transilvania reprezentata prin ________________administrator", "phone": "", "representative": "________________", "role": "VANZATOR", "fullText": "FERENAGRO SRL cu sediul/domiciliul in TAMASEU NR 126, Jud. BIHOR, inmatriculata sub nr. J05/1538/2009, inregistrata la Reg. C.C.I. BIHOR, CIF RO26281651, telefon nr. : , avand codul IBAN RO45BTRLRONCRT0397309101, deschis la Banza Transilvania reprezentata prin ________________administrator , in calitate de VANZATOR."}, {"name": "PROMOCIONES ALSINA SRL", "cui": "RO20404178", "regCom": "J30/3/2007", "iban": "RO39BACX0000002453586000", "bank": "Unicredit Bank suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "PROMOCIONES ALSINA SRL cu sediul/domiciliul în Satu Mare BLD. UNIRII NR.7, jud. Satu Mare, înmatriculată sub nr. J30/3/2007, înregistrata la Reg. C.C.I. _____, CIF RO20404178 , tel./fax. ______________, având codul IBAN RO39BACX0000002453586000 deschis la Unicredit Bank suc./ag.______________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "SCHWAB AGRO PROD SRL", "cui": "RO16753072", "regCom": "J30/988/2004", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________", "role": "VÂNZĂTOR", "fullText": "SCHWAB AGRO PROD SRL cu sediul în loc JUD. SATU MARE, ORAS. ARDUD, STR. BUCURESTIULUI, NR.152V, înmatriculata sub nr. J30/988/2004 la Reg.C.C.I. , CIF RO16753072 , reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "RITLI IOAN I.I", "cui": "RO38828303", "regCom": "F30/81/2018", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________", "role": "VÂNZĂTOR", "fullText": "RITLI IOAN I.I. cu sediul în loc. CAPLENI, NR.438, jud. Satu Mare , înmatriculata sub nr. F30/81/2018 la Reg.C.C.I. , CIF RO38828303, reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "FERMA KADAR SRL", "cui": "RO17816578", "regCom": "J30/866/2005", "iban": "", "bank": "", "phone": "", "representative": "", "role": "VÂNZĂTOR", "fullText": "FERMA KADAR SRL cu sediul în Carei STR. PETRU RARES NR.17, jud. Satu Mare , înmatriculata sub nr. J30/866/2005 , înregistrata la Reg. C.C.I. , CIF RO17816578 tel. , având codul IBAN deschis la , reprezentată prin , în calitate de VÂNZĂTOR."}, {"name": "ILUT MIHAELA PFA", "cui": "RO38745267", "regCom": "F30/49/2018", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________", "role": "VÂNZĂTOR", "fullText": "ILUT MIHAELA PFA cu sediul în loc.Dacia STR.PRINCIPALA, NR.75 , jud. Satu Mare , înmatriculata sub nr. F30/49/2018 la Reg.C.C.I. , CIF RO38745267, reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "FERMA CORPARET SRL", "cui": "RO21118506", "regCom": "J30/267/2007", "iban": "", "bank": "CEC BANK ag", "phone": "", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "FERMA CORPARET SRL cu sediul în JUD. SATU MARE, MUN. CAREI, înmatriculata sub nr. J30/267/2007 , înregistrata la Reg. C.C.I. , CIF RO21118506 tel. , având codul IBAN RO06CECESM0201RON0296655 deschis la CEC BANK ag. __________, reprezentată prin _________________, în calitate de VÂNZĂTOR."}, {"name": "PASCU MONICA MARIANA PFA", "cui": "RO34263117", "regCom": "F30/213/20", "iban": "RO79BTRLRONCRT0395319601", "bank": "BANCA TRANSILVANIA suc", "phone": "", "representative": "____________________", "role": "VÂNZĂTOR", "fullText": "PASCU MONICA MARIANA PFA cu sediul/domiciliul in CAUAS, CAUAS NR.132, Jud. SATU MARE, inmatriculata sub nr. F30/213/20.03.2015, inregistrata la Reg. C.C.I. SATU MARE, CIF RO34263117, telefon nr. 0771773133, avand codul IBAN RO79 BTRL RONC RT03 9531 9601, deschis la BANCA TRANSILVANIA suc./ag. ______________________, reprezentata prin ____________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "KISS L ATTILA PFA", "cui": "RO 43943473", "regCom": "F30/130/2021", "iban": "", "bank": "CEC BANK suc", "phone": "______________", "representative": "Radu Donca", "role": "VÂNZĂTOR", "fullText": "KISS L ATTILA PFA cu sediul/domiciliul în GHENCI, NR.358/A, jud.Satu Mare, înmatriculată sub nr. F30/130/2021, înregistrata la Reg. C.C.I. ____________________, CIF RO 43943473 tel./fax. ______________, având codul IBAN RO52CECEC001946009785121 deschis la CEC BANK suc./ag.______________________, reprezentată prin Radu Donca administrator, în calitate de VÂNZĂTOR."}, {"name": "SOLO IMPEX SRL", "cui": "RO3246612", "regCom": "J31 /917 /1992", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________", "role": "VÂNZĂTOR", "fullText": "SOLO IMPEX SRL cu sediul în loc. Zalau Aleea BRADULUI , jud. Salaj , înmatriculata sub nr. J31 /917 /1992 la Reg.C.C.I. Bihor, CIF RO3246612, reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "fermaILUT MIHAI", "cui": "", "regCom": "", "iban": "", "bank": "BankA COMERCIALA ROMANA", "phone": "", "representative": "ILUT MIHAI", "role": "VÂNZĂTOR", "fullText": "fermaILUT MIHAI cu sediul în Dacia STR.PRINCIPALA, NR.75, jud. Satu Mare , înmatriculata sub nr. înregistrata la Reg. C.C.I. CNP 1620924300021 tel. , având codul IBANRO86RNCB0222012023260001 deschis la BankA COMERCIALA ROMANA , reprezentată prin ILUT MIHAI , în calitate de VÂNZĂTOR."}, {"name": "BOROS DAVID PFA", "cui": "RO29710332", "regCom": "F5/487/2012", "iban": "RO18CARP005200794522RO01", "bank": "BANCA COMERCIAL CARPATICA suc", "phone": "_______", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "BOROS DAVID PFA cu sediul/domiciliul în SACUENI STR. MORII, NR.39 jud. BIHOR , înmatriculată sub nr. F5/487/2012, înregistrata la Reg. C.C.I. , CIF RO29710332, tel./fax. _______, având codul IBAN RO18CARP005200794522RO01 DESCHIS LA BANCA COMERCIAL CARPATICA suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "AGRODAN COMERT S.R.L", "cui": "RO46820319", "regCom": "J30/1059/2022", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________", "role": "VÂNZĂTOR", "fullText": "AGRODAN COMERT S.R.L. cu sediul în loc.Rosiori, str.___________, nr.241, jud.Satu Mare , înmatriculata sub nr. J30/1059/2022 la Reg.C.C.I. Bihor, CIF RO46820319, reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "POOSZ ALEX EMERIC", "cui": "CNP1871231303711", "regCom": "", "iban": "RO04BACX0000001643754000", "bank": "Unicredit Bank", "phone": "", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "POOSZ ALEX EMERIC cu sediul în CAPLENI NR.55 , jud. Satu Mare, înmatriculata sub nr. , înregistrata la Reg. C.C.I. , CIF CNP1871231303711 tel. , având codul IBAN RO04BACX0000001643754000 deschis la Unicredit Bank , reprezentată prin _________________, în calitate de VÂNZĂTOR."}, {"name": "VIRAGH CSABA ISTVAN", "cui": "CNP 1790608300024", "regCom": "", "iban": "RO69CECEC001946268965711", "bank": "CEC", "phone": "", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "VIRAGH CSABA ISTVAN cu sediul în MOFTINU MIC NR 419, jud. Satu Mare, înmatriculata sub nr. , înregistrata la Reg. C.C.I. r CIF CNP 1790608300024 tel. , având codul IBAN RO69 CECE C001 9462 6896 5711 deschis la CEC, reprezentată prin _________________, în calitate de VÂNZĂTOR."}, {"name": "S.C. CIRSIUM SRL MARGHITA S.R.L", "cui": "RO15515005", "regCom": "J05/738/2003", "iban": "RO53BRDE050SV23319180500", "bank": "BANCA ROMANA PENTRU DEZVOLTARE suc", "phone": "", "representative": "____________________", "role": "VÂNZĂTOR", "fullText": "S.C. CIRSIUM SRL MARGHITA S.R.L. cu sediul in loc. Marghita, Closca, nr. 11, Jud. Bihor, inmatriculata sub nr. J05/738/2003, inregistrata la Reg. C.C.I. BIHOR, CIF RO15515005, telefon nr. 0767532180, avand codul IBAN RO53BRDE050SV23319180500, deschis la BANCA ROMANA PENTRU DEZVOLTARE suc./ag. ______________________, reprezentata prin ____________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "S.C. FERMA LIBAGRO SRL", "cui": "RO36367610", "regCom": "J05/1465/2016", "iban": "RO70CECEBH3530RON0804185", "bank": "CEC BANK S", "phone": "0261/861399", "representative": "Nagy Erzsebet-", "role": "VANZATOR", "fullText": "S.C. FERMA LIBAGRO SRL cu sediul/domiciliul in SACUENI, STR.1 MAI NR 22, Jud. BIHOR, inmatriculata sub nr. J05/1465/2016, inregistrata la Reg. C.C.I. BIHOR, CIF RO36367610, telefon nr. : 0261/861399, avand codul IBAN RO70 CECE BH35 30RO N080 4185, deschis la CEC BANK S.A. reprezentata prin Nagy Erzsebet- administrator , in calitate de VANZATOR."}, {"name": "KOVACS G.VIORICA I.I", "cui": "RO26866729", "regCom": "F05/937/03", "iban": "", "bank": "Banca Transilvania ag", "phone": "0745764169", "representative": "Kovacs Viorica", "role": "VÂNZĂTOR", "fullText": "KOVACS G.VIORICA I.I. cu sediul în Adoni, nr. 312, jud. Bihor, înmatriculata sub nr. F05/937/03.05.2010 , înregistrata la Reg. C.C.I. Bihor, CIF RO26866729 tel. 0745764169, având codul IBAN RO11 BTRL 0050 1202 R238 84XX deschis la Banca Transilvania ag. Valea lui Mihai, reprezentată prin Kovacs Viorica administrator, în calitate de DEPOZITAR MESZAROS ELEK ELEMER cu sediul în Marghita STR.KOLCSEY FERENCZ, NR.6 , jud. Bihor, înmatriculata sub nr., înregistrata la Reg. C.C.I. Bihor, CIF CNP 1570814052859 tel, având codul IBAN RO83RZBR0000060009111855 deschis Raiffeisen, reprezentată prin ERDEI IMRE ISTVAN calitate de VÂNZĂTOR. ERDEI IMRE ISTVAN cu sediul în SAT. OTOMAN NR.245 , jud. Bihor, înmatriculata sub nr., înregistrata la Reg. C.C.I. Bihor, CIF CNP 1600702052853 tel, având codul IBAN RO27RNCB0035022202800001 deschis BCR, reprezentată prin ERDEI IMRE ISTVAN calitate de VÂNZĂTOR. SOLTESZ LEVENTE PFA cu sediul în OTOMANI 226 , jud. Bihor, înmatriculata sub nr. J05/1016/2016 , înregistrata la Reg. C.C.I. Bihor, CIF RO36318804 tel. 0745399041, având codul IBAN RO04BTRLRONCRT0357146601 deschis la Banca Transylvania , reprezentată prin SOLTESZ LEVENTE calitate de VÂNZĂTOR. GROMAX GRAINS SRL cu sediul în loc. SAT BERCU NR.110 , jud.Satu Mare , înmatriculata sub nr. J30/233/2015 la Reg.C.C.I. , CIF RO34367614 , reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "SILAGHI ANDREI PAUL PFA", "cui": "RO344851304", "regCom": "F05/894/2015", "iban": "", "bank": "Banca Transylvania reprezentată prin administrator in calitate de VANZATOR", "phone": "", "representative": "administrator", "role": "VANZATOR", "fullText": "SILAGHI ANDREI PAUL PFA cu sediul în CHIRIBIS, NR.208B jud.Bihor, înmatriculata sub nr. F05/894/2015, înregistrata la Reg. C.C.I. Bihor, CIF RO344851304 tel. , având codul IBAN RO15BTRL00501202995635XX deschis la Banca Transylvania reprezentată prin administrator in calitate de VANZATOR."}, {"name": "CHICHINESDI EMANUEL-FLORIN PFA", "cui": "RO30549494", "regCom": "F05/1838/2012", "iban": "", "bank": "Banca Romana de Dezoltare reprezentată prin administrator in calitate de VANZATOR", "phone": "", "representative": "administrator", "role": "VANZATOR", "fullText": "CHICHINESDI EMANUEL-FLORIN PFA cu sediul în SAT SUIUG, NR 105/A jud.Bihor, înmatriculata sub nr. F05/1838/2012, înregistrata la Reg. C.C.I. Bihor, CIF RO30549494 tel. , având codul IBAN RO71BRDE050SV59364020500 deschis la Banca Romana de Dezoltare reprezentată prin administrator in calitate de VANZATOR."}, {"name": "AGROSEM CEREALE COOP AGRIC", "cui": "47178552", "regCom": "C30/5/2022", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________", "role": "VÂNZĂTOR", "fullText": "AGROSEM CEREALE COOP AGRIC cu sediul în loc. MUN. SATU MARE, STR. FERMA SATMAREL, NR.32v, jud. Satu Mare , înmatriculata sub nr. C30/5/2022 la Reg.C.C.I. Bihor, CIF 47178552 , reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "AGROERH GNANDT SRL", "cui": "RO45573830", "regCom": "J30/127/2022", "iban": "RO24RNCB0222171965860001", "bank": "BCR Carei", "phone": "", "representative": "", "role": "VÂNZĂTOR", "fullText": "AGROERH GNANDT SRL cu sediul in Urziceni, jud. Satu Mare, str. Urziceni nr. 382, Hot. Jud nr. J30/127/2022, CIF RO45573830, tel./fax. , având contul IBAN RO24RNCB0222171965860001 deschis la BCR Carei, reprezentat prin , în calitate de VÂNZĂTOR."}, {"name": "KISS GABOR SZILARD PFA SRL", "cui": "RO34323502", "regCom": "F30/252/2015", "iban": "", "bank": "Banca Romana de Dezoltare reprezentată prin Kiss Gabor Szilard administrator in calitate de VANZATOR", "phone": "0740900213", "representative": "Kiss Gabor Szilard", "role": "VANZATOR", "fullText": "KISS GABOR SZILARD PFA SRL cu sediul în SOCOND jud.Satu Mare, înmatriculata sub nr. F30/252/2015, înregistrata la Reg. C.C.I. Satu Mare, CIF RO34323502 tel. 0740900213, având codul IBAN RO67BRDE310SV54975993100 deschis la Banca Romana de Dezoltare reprezentată prin Kiss Gabor Szilard administrator in calitate de VANZATOR."}, {"name": "FILIP SIMINA CORINA PFA", "cui": "RO26231408", "regCom": "F30/946/2009", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________", "role": "VÂNZĂTOR", "fullText": "FILIP SIMINA CORINA PFA cu sediul în loc.APA, STR PRINCIPALA NR 756 jud.Satu Mare , înmatriculata sub nr. F30/946/2009 la Reg.C.C.I. , CIF RO26231408 , reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "CUBITCHI ALEXANDRU PFA", "cui": "RO39272205", "regCom": "F30/413/2018", "iban": "", "bank": "_______________", "phone": "", "representative": "ing. ____________", "role": "VÂNZĂTOR", "fullText": "CUBITCHI ALEXANDRU PFA. cu sediul în JUD. SATU MARE, SAT ACAS COM. ACAS, NR.99, înmatriculata sub nr. F30/413/2018 , înregistrata la Reg. C.C.I. Satu Mare, CIF RO39272205, având codul IBAN________________ deschis la _______________, reprezentată prin ing. ____________, în calitate de VÂNZĂTOR."}, {"name": "BRUTLER MIHAI PFA", "cui": "RO34973513", "regCom": "F30/595/2015", "iban": "", "bank": "_______________", "phone": "", "representative": "ing. ____________", "role": "VÂNZĂTOR", "fullText": "BRUTLER MIHAI PFA. cu sediul în BELTIUG NR.363, jud. Satu Mare, înmatriculata sub nr. F30/595/2015 , înregistrata la Reg. C.C.I. Satu Mare, CIF RO34973513, având codul IBAN________________ deschis la _______________, reprezentată prin ing. ____________, în calitate de VÂNZĂTOR."}, {"name": "AGROMIRIAM SANISLAU COOPERATIVA AGRICOLA", "cui": "RO44871251", "regCom": "C30/16/2021", "iban": "", "bank": "Banca Transilvania Bank suc", "phone": "______________", "representative": "________________________", "role": "VÂNZĂTOR", "fullText": "AGROMIRIAM SANISLAU COOPERATIVA AGRICOLA cu sediul/domiciliul în SANISLAU NR 1330 , jud. Satu Mare , înmatriculată sub nr. C30/16/2021 , CIF RO44871251 , tel./fax. ______________, având codul IBAN deschis la Banca Transilvania Bank suc./ag.______________________, reprezentată prin ________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "AGRIMANITIU SRL", "cui": "RO35462142", "regCom": "J30/63/2016", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________", "role": "VÂNZĂTOR", "fullText": "AGRIMANITIU SRL cu sediul în loc. CAREI STR. INDEPENDENTEI NR 34, jud. Satu Mare, înmatriculata sub nr. J30/63/2016 la Reg.C.C.I. , CIF RO35462142 , reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "S SC ATLANT PRETISGE ACTIVE SRL", "cui": "RO46916155", "regCom": "J24/2032/2022", "iban": "RO09RZBR0000060023959037", "bank": "Raiffeisen Bank", "phone": "", "representative": "ing. Mariana Nutsu", "role": "PROPRIETAR", "fullText": "S SC ATLANT PRETISGE ACTIVE SRL. cu sediul în Sighetu Marmatiei str.Bogdan Voda nr. 13A,ap.65 jud. Maramures, înmatriculata sub nr. J24/2032/2022, înregistrata la Reg. C.C.I.or, CIF RO46916155 , având codul IBAN RO09RZBR0000060023959037 deschis la Raiffeisen Bank, reprezentată prin ing. Mariana Nutsu , în calitate de PROPRIETAR."}, {"name": "MAN FARM COOP AGRICOLA", "cui": "RO44925769", "regCom": "C30/22/2021", "iban": "", "bank": "", "phone": "", "representative": "asociat unic Manitiu Dumitru", "role": "VÂNZĂTOR", "fullText": "MAN FARM COOP AGRICOLA cu sediul în loc. JUD. SATU MARE, MUN. CAREI, STR. GROF KAROLYI SANDOR, NR.4, înmatriculata sub nr. C30/22/2021 la Reg.C.C.I. , CIF RO44925769, reprezentată prin asociat unic Manitiu Dumitru , în calitate de VÂNZĂTOR."}, {"name": "CSIRAK ATTILA OTTO PFA", "cui": "RO23277044", "regCom": "F30/300/2002", "iban": "", "bank": "", "phone": "", "representative": "asociat unic Csirak Attila Otto", "role": "VÂNZĂTOR", "fullText": "CSIRAK ATTILA OTTO PFA cu sediul în loc. COM. MOFTINU MARE, NR.199 jud. Satu Mare , înmatriculata sub nr. F30/300/2002 la Reg.C.C.I. , CIF RO23277044 , reprezentată prin asociat unic Csirak Attila Otto , în calitate de VÂNZĂTOR."}, {"name": "BARTAN GAVRIL LIVIU I.I", "cui": "RO26986466", "regCom": "F05/1184/2010", "iban": "RO42CECEBH1430RON0528505", "bank": "CEC Bank suc", "phone": "______________", "representative": "____________________VANZATOR. ILUT I DANIELA FLORICA I.I. cu sediul/domiciliul în JUD. SATU MARE", "role": "VÂNZĂTOR", "fullText": "BARTAN GAVRIL LIVIU I.I. cu sediul/domiciliul în COM TAMASEU, SAT.NIUVED NR.38 , jud. Bihor, , înmatriculată sub nr. F05/1184/2010, înregistrata la Reg. C.C.I. _____, CIF RO26986466 , tel./fax. ______________, având codul IBAN RO42CECEBH1430RON0528505 deschis la CEC Bank suc./ag.______________, reprezentată prin ____________________VANZATOR. ILUT I DANIELA FLORICA I.I. cu sediul/domiciliul în JUD. SATU MARE , VALEA VINULUI, NR.17 , F30 /240 /2014 CIF RO33025397, tel./fax ______________, având codul IBAN RO08RNCB0035101152450001 deschis la BCR suc./ag. , reprezentată prin _________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "AGROROS SRL", "cui": "RO23940251", "regCom": "", "iban": "RO08RNCB0035101152450001", "bank": "BCR suc", "phone": "______________", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "AGROROS SRL cu sediul/domiciliul în JUD. BIHOR, SAT ROSIORI COM. ROSIORI, ROSIORI, NR.251 , J05/1362/2008 CIF RO23940251, tel./fax ______________, având codul IBAN RO08RNCB0035101152450001 deschis la BCR suc./ag. , reprezentată prin _________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "BOSCONE CEREALE SRL", "cui": "RO35130992", "regCom": "J05/1664/2015", "iban": "", "bank": "Banca _______________", "phone": "", "representative": "_______________________", "role": "VÂNZĂTOR", "fullText": "BOSCONE CEREALE SRL cu sediul în JUD. BIHOR, SAT ROSIORI COM. ROSIORI, ROSIORI, NR.442, înmatriculata sub nr. J05/1664/2015, înregistrata la Reg. C.C.I. Bihor, CIF RO35130992 tel. , având codul IBANRO57WBAN000596075033RO01 deschis la Banca _______________, reprezentată prin _______________________, în calitate de VÂNZĂTOR."}, {"name": "URSU IULIU IOAN PFA", "cui": "RO19886022", "regCom": "F05/643/2006", "iban": "", "bank": "CEC Bank", "phone": "", "representative": "", "role": "VÂNZĂTOR", "fullText": "URSU IULIU IOAN PFA cu sediul în Valea lui Mihai ARANY JANOS 2/A , jud. Satu Mare , înmatriculata sub nr. F05/643/2006 , înregistrata la Reg. C.C.I. CIF RO19886022 tel. , având codul IBAN RO11CECEBH1730RON0607304 deschis la CEC Bank , reprezentată prin , în calitate de VÂNZĂTOR."}, {"name": "HODOROG ANDREA PFA", "cui": "RO25372859", "regCom": "F30/306/2009", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________", "role": "VÂNZĂTOR", "fullText": "HODOROG ANDREA PFA cu sediul în loc. Sauca nr.62, jud .Satu Mare , înmatriculata sub nr. F30/306/2009 la Reg.C.C.I. Bihor, CIF RO25372859, reprezentată prin asociat unic ___________________, în calitate de VÂNZĂTOR."}, {"name": "GARDAN AGRO SRL", "cui": "RO22376988", "regCom": "J05/2244/2007", "iban": "", "bank": "Banca Transilvania ag", "phone": "", "representative": "Gardan Grigore", "role": "VÂNZĂTOR", "fullText": "GARDAN AGRO SRL cu sediul în ADONI NR.253, jud. Bihor, înmatriculata sub nr. J05/2244/2007, înregistrata la Reg. C.C.I. Bihor, CIF RO22376988 tel. , având codul IBAN RO50 BTRL RONC RT02 6603 6001 deschis la Banca Transilvania ag. Valea lui Mihai, reprezentată prin Gardan Grigore , în calitate de VÂNZĂTOR."}, {"name": "BUTEAN IOAN I.I", "cui": "RO36725050", "regCom": "F05/1430/2016", "iban": "RO57RNCB0035152558560001", "bank": "BCR Bank", "phone": "", "representative": "_______________", "role": "VANZATOR", "fullText": "BUTEAN IOAN I.I. cu sediul în Marghita ALEEA INFRATIRII NR 9, BL.9, ET.1, AP.1, jud. Bihor, înmatriculată sub nr. F05/1430/2016 la Reg. C.C.I. Bihor, CIF RO36725050, tel./fax. , avand contul IBAN RO57RNCB0035152558560001 deschis la BCR Bank , reprezentată prin _______________ administrator în calitate de VANZATOR."}, {"name": "FARCAU I IOAN PFA", "cui": "", "regCom": "F30/893/2005", "iban": "", "bank": "Banca Romana pentru Dezvoltare", "phone": "_____________", "representative": "", "role": "PROPRIETAR", "fullText": "FARCAU I IOAN PFA cu sediul în MOFTINU MARE, NR.205, jud. Satu Mare , înmatriculata sub nr. F30/893/2005 , înregistrata la Reg. C.C.I. RO19801760 tel. _____________, având codul IBAN RO56BRDE310SV20808933100 deschis la Banca Romana pentru Dezvoltare , reprezentată prin_Farcau Ioan , în calitate de PROPRIETAR."}, {"name": "CANDREA DANIEL MIREL", "cui": "", "regCom": "", "iban": "RO10BACX0000001099173000", "bank": "Banca Unicredit Tiriac", "phone": "_____________", "representative": "", "role": "PROPRIETAR", "fullText": "CANDREA DANIEL MIREL cu sediul în VEZENDIU NR.34, jud. Satu Mare , înmatriculata sub nr., înregistrata la Reg. C.C.I. CNP1680427300012 tel. _____________, având codul IBAN RO10BACX0000001099173000 deschis la Banca Unicredit Tiriac , reprezentată prin_______________, în calitate de PROPRIETAR."}, {"name": "FANEA VASILE PFA", "cui": "RO38874008", "regCom": "F30/109/2018", "iban": "RO78CECESM0230RON0499012", "bank": "CEC", "phone": "", "representative": "Fanea Vasile", "role": "VÂNZĂTOR", "fullText": "FANEA VASILE PFA., cu sediul in CAUAS, NR.108/A, jud. Satu Mareihor, înregistrata la C.C.I. Bihor, nr. F30/109/2018, CIF RO38874008, tel./fax. având contul IBAN RO78CECESM0230RON0499012 deschis la CEC , reprezentată prin Fanea Vasile, în calitate de VÂNZĂTOR."}, {"name": "MOISE PAUL PFA", "cui": "RO31605517", "regCom": "F05/820/2013", "iban": "", "bank": "Raiffeisen Bank ag", "phone": "0745773969", "representative": "Moisa Paul", "role": "VÂNZĂTOR", "fullText": "MOISE PAUL PFA. cu sediul în Balc, str. Petofi Sandor nr. 52, jud. Bihor, înmatriculata sub nr. F05/820/2013, înregistrata la Reg. C.C.I. Bihor, CIF RO31605517 tel. 0745773969, având codul IBAN RO46 RZBR 0000 0600 1561 1812 deschis la Raiffeisen Bank ag. Marghita, reprezentată prin Moisa Paul, administrator, în calitate de VÂNZĂTOR."}, {"name": "TARPAI A. SANDOR I.I", "cui": "", "regCom": "", "iban": "RO26741490laReg", "bank": "", "phone": "", "representative": "asociat unic Tarpai Sandor", "role": "VÂNZĂTOR", "fullText": "TARPAI A. SANDOR I.I. cu sediul în loc. Valea lui Mihai STR.PETOFI SANDOR, NR.28 , jud. Bihor , înmatriculata sub nr. RO26741490 la Reg.C.C.I. Bihor, CIF F05/660/2010 , reprezentată prin asociat unic Tarpai Sandor , în calitate de VÂNZĂTOR."}, {"name": "FORON SRL", "cui": "RO666077", "regCom": "J30/241/1991", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________", "role": "VÂNZĂTOR", "fullText": "FORON SRL cu sediul în loc. Craidorolt STR.PRINCIPALA NR.222 , jud. Satu Mare , înmatriculata sub nr. J30/241/1991 la Reg.C.C.I. , CIF RO666077 , reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "SILA DAN ELENA AGRO PFA", "cui": "", "regCom": "F30/114/2016", "iban": "", "bank": "", "phone": "", "representative": "_______________", "role": "PROPRIETAR", "fullText": "SILA DAN ELENA AGRO PFA, cu sediul in loc.LUCACENI 206, jud. Satu Mare, inregistrat la ORC sub nr. F30/114/2016 si CIF RO RO35895804, reprezentata prin _______________, în calitate de PROPRIETAR."}, {"name": "GHI ANDREI PAUL PFA", "cui": "RO34485130", "regCom": "F05/894/2015", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________", "role": "VÂNZĂTOR", "fullText": "GHI ANDREI PAUL PFA cu sediul în loc. CHIRIBIS, NR.208B , jud. Bihor, înmatriculata sub nr. F05/894/2015 la Reg.C.C.I. Bihor, CIF RO34485130 , reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "ZSISCU ROBERT PFA", "cui": "31803204", "regCom": "", "iban": "RO04BRDE050SV80815940500", "bank": "Banca Romana pentru Dezvoltare", "phone": "", "representative": "", "role": "VÂNZĂTOR", "fullText": "ZSISCU ROBERT PFA cu sediul în VIISOARA, NR.271A , jud. Bihor, înmatriculata sub nr. , înregistrata la Reg. F5/1647/2013 C.C.I. Bihor, CIF 31803204 tel. , având codul IBAN RO04BRDE050SV80815940500 deschis la Banca Romana pentru Dezvoltare , în calitate de VÂNZĂTOR."}, {"name": "COREMANS AGRO TIPAR SRL", "cui": "RO40030019", "regCom": "J05/2306/2020", "iban": "RO85OTPV220000252909RO01", "bank": "OTP Bank Romania", "phone": "________________", "representative": "Ruud Lucas", "role": "VÂNZĂTOR", "fullText": "COREMANS AGRO TIPAR SRL cu sediul în loc. Salonta nr.240, jud.Bihor, înmatriculată sub nr. J05/2306/2020, înregistrata la Reg. C.C.I. Satu Mare, CIF RO40030019 , tel./fax.________________ , având codul IBAN RO85 OTPV 2200 0025 2909 RO01 deschis la OTP Bank Romania, reprezentată prin Ruud Lucas administrator, în calitate de VÂNZĂTOR."}, {"name": "AGRO MOLINERO SRL", "cui": "RO19233325", "regCom": "J05/2458/2006", "iban": "RO85OTPV220000252909RO01", "bank": "OTP Bank Romania", "phone": "________________", "representative": "Ruud Lucas Heikens", "role": "VÂNZĂTOR", "fullText": "AGRO MOLINERO SRL cu sediul în loc. ORADEA STR.AUREL LAZAR NR.11 AP.3, jud.Bihor, înmatriculată sub nr. J05/2458/2006, înregistrata la Reg. C.C.I. Satu Mare, CIF RO19233325 , tel./fax.________________ , având codul IBAN RO85 OTPV 2200 0025 2909 RO01 deschis la OTP Bank Romania, reprezentată prin Ruud Lucas Heikens administrator, în calitate de VÂNZĂTOR."}, {"name": "AGRO IANUS SRL", "cui": "RO18973880", "regCom": "J05/1737/2006", "iban": "RO85OTPV220000252909RO01", "bank": "OTP Bank Romania", "phone": "________________", "representative": "Ruud Lucas Heikens", "role": "VÂNZĂTOR", "fullText": "AGRO IANUS SRL cu sediul în loc. ORADEA STR.AUREL LAZAR NR. 11, jud.Bihor, înmatriculată sub nr. J05/1737/2006, înregistrata la Reg. C.C.I. Satu Mare, CIF RO18973880 , tel./fax.________________ , având codul IBAN RO85 OTPV 2200 0025 2909 RO01 deschis la OTP Bank Romania, reprezentată prin Ruud Lucas Heikens administrator, în calitate de VÂNZĂTOR."}, {"name": "ERNI ANA", "cui": "", "regCom": "", "iban": "RO32CECESM1408RON0303787", "bank": "CEC BANK", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "ERNI ANA cu sediul/domiciliul în SAT. URZICENI NR 327, jud. Satu Mare , înmatriculată sub nr., înregistrata la Reg. C.C.I., CNP 2470705300042 , tel./fax. ______________, având codul IBAN RO32CECESM1408RON0303787 deschis la CEC BANK, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "HUND GERHARDT", "cui": "", "regCom": "", "iban": "RO35RZBR0000060021642403", "bank": "Raiffeisen Bank", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "HUND GERHARDT cu sediul/domiciliul în SAT. FOIENI NR.411, jud. Satu Mare , înmatriculată sub nr., înregistrata la Reg. C.C.I., CNP1951022303939 , tel./fax. ______________, având codul IBAN RO35RZBR0000060021642403 deschis la Raiffeisen Bank, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "GABOR AGRO SRL", "cui": "RO20630388", "regCom": "J05/111/2007", "iban": "", "bank": "Banca Romana pentru Dezvoltare", "phone": "", "representative": "_______________________", "role": "VÂNZĂTOR", "fullText": "GABOR AGRO SRL cu sediul în TARCEA, NR.344, jud. Bihor, înmatriculata sub nr. J05/111/2007, înregistrata la Reg. C.C.I. Bihor, CIF RO20630388 tel. , având codul IBAN RO74BRDE050SV86139840500 deschis la Banca Romana pentru Dezvoltare, reprezentată prin _______________________, în calitate de VÂNZĂTOR."}, {"name": "AGRIPROD COOP.AGR", "cui": "RO44993828", "regCom": "C30/24/2021", "iban": "RO22BTRLRONCRT0620267701", "bank": "Banca Transilvaniae", "phone": "", "representative": "___________", "role": "PROPRIETAR", "fullText": "AGRIPROD COOP.AGR. cu sediul in CRAIDOROLT, NR.174 jud. Satu Mare, înmatriculată sub nr. C30/24/2021, înregistrata la Reg. C.C.I. Satu Mare, CIF RO44993828, tel./fax., având codul IBAN RO22BTRLRONCRT0620267701 deschis la Banca Transilvaniae, reprezentată prin ___________administrator, în calitate de PROPRIETAR."}, {"name": "KUKI AGRO SRL", "cui": "RO28095779", "regCom": "J05 /313 /2011", "iban": "", "bank": "Banca Transilvania reprezentată prin ____________________", "phone": "0740196972", "representative": "____________________", "role": "VÂNZĂTOR", "fullText": "KUKI AGRO SRL cu sediul în Sacueni Str. LETA MARE 45 , jud. Bihor , înmatriculata sub nr. J05 /313 /2011, înregistrata la Reg. C.C.I. , CIF RO28095779 tel. 0740196972 , având codul RO14BTRL00501202W39239XX deschis la Banca Transilvania reprezentată prin ____________________, în calitate de VÂNZĂTOR."}, {"name": "AGRO CEREAL CRISUL NEGRU SRL", "cui": "RO43783321", "regCom": "J05 /469 /2021", "iban": "", "bank": "CEC Bank", "phone": "___________", "representative": "__________", "role": "VÂNZĂTOR", "fullText": "AGRO CEREAL CRISUL NEGRU SRL cu sediul în Olcea nr.299 , jud. Bihor , înmatriculata sub nr. J05 /469 /2021, înregistrata la Reg. C.C.I. , CIF RO43783321 tel. ___________ , având codul IBAN RO51CECEB00030RON1498982 deschis la CEC Bank, reprezentată prin __________, în calitate de VÂNZĂTOR."}, {"name": "CRISUL NEGRU TINCA COOP.AGR", "cui": "RO43651444", "regCom": "C05 /5 /2021", "iban": "", "bank": "Banca Transilvania", "phone": "___________", "representative": "__________", "role": "VÂNZĂTOR", "fullText": "CRISUL NEGRU TINCA COOP.AGR. cu sediul în Nadlac STR. GEORGE COSBUC, NR.51 , jud. Arad , înmatriculata sub nr. C05 /5 /2021, înregistrata la Reg. C.C.I. , CIF RO43651444 tel. ___________ , având codul IBAN RO85BTRLRONCRT0586212001 deschis la Banca Transilvania, reprezentată prin __________, în calitate de VÂNZĂTOR."}, {"name": "AGRO SOMPREST SRL", "cui": "RO28856748", "regCom": "J31/338/2011", "iban": "", "bank": "Banca Transilvania", "phone": "0751623920", "representative": "", "role": "VÂNZĂTOR", "fullText": "AGRO SOMPREST SRL cu sediul în NAPRADEA NR 245, jud. Salaj , înmatriculata sub nr. J31/338/2011, înregistrata la Reg. C.C.I. , CIF RO28856748 tel. 0751623920 , având codul IBAN RO50BTRLRONCRT00B4698501 deschis la Banca Transilvania, reprezentată prin , în calitate de VÂNZĂTOR."}, {"name": "MARCZIN CLAUDIA PFA SRL", "cui": "RO34316165", "regCom": "F05/556/2015", "iban": "", "bank": "CEC Bank", "phone": "", "representative": "", "role": "VANZATOR", "fullText": "MARCZIN CLAUDIA PFA SRL. cu sediul în SAT.CIOCAIA, NR.379 , jud. Bihor, înmatriculata sub nr. F05/556/2015, înregistrata la Reg. C.C.I. Bihor, CIF RO34316165 tel., având codul IBAN RO58CECEBH3530RON0761527 deschis la CEC Bank , reprezentată prin , în calitate de VANZATOR."}, {"name": "VASY & ALEX SRL", "cui": "RO21791145", "regCom": "J30 /696 /2007", "iban": "", "bank": "___________", "phone": "", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "VASY & ALEX SRL cu sediul în Pomi nr.56, jud. Satu Mare, înmatriculata sub nr. J30 /696 /2007, înregistrata la Reg. C.C.I. , CIF RO21791145 tel. , având codul IBAN___________________ deschis la ___________, reprezentată prin _________________, în calitate de VÂNZĂTOR."}, {"name": "AGROFLORETOM SRL", "cui": "RO37077305", "regCom": "J05/288/2017", "iban": "", "bank": "BankA tRANSILVANIA", "phone": "", "representative": "", "role": "VANZATOR", "fullText": "AGROFLORETOM SRL. cu sediul în MARGINE NR 13 , jud. Bihor, înmatriculata sub nr. J05/288/2017 , înregistrata la Reg. C.C.I. Bihor, CIF RO37077305 tel., având codul IBAN RO78BTRLRONCRT0384980001 deschis la BankA tRANSILVANIA , reprezentată prin , în calitate de VANZATOR."}, {"name": "MURESAN SILVIU IONEL PFA S.R.L", "cui": "", "regCom": "F30/261/2015", "iban": "", "bank": "CEC Bank SA", "phone": "_____________", "representative": "______________", "role": "VÂNZĂTOR", "fullText": "MURESAN SILVIU IONEL PFA S.R.L. cu sediul în Sauca sat Silvas nr.15, jud. Satu Mare , înmatriculata sub nr. F30/261/2015 , înregistrata la Reg. C.C.I. RO34330496 tel. _____________, având codul IBAN RO98 CECE SM09 30RO N045 7015 deschis la CEC Bank SA, reprezentată prin ______________, CNP ___________________, în calitate de VÂNZĂTOR."}, {"name": "FAZEKAS IMRE IANOS", "cui": "", "regCom": "", "iban": "RO21RZBR0000060016069035", "bank": "Raiffeisen Bank SA", "phone": "_____________", "representative": "______________", "role": "VÂNZĂTOR", "fullText": "FAZEKAS IMRE IANOS cu sediul în Balc STR. PRIMAVERII NR.83, jud. Bihor , înmatriculata sub nr., înregistrata la Reg. C.C.I. CNP 1790719052858tel. _____________, având codul IBAN RO21RZBR0000060016069035 deschis la Raiffeisen Bank SA, reprezentată prin ______________, CNP ___________________, în calitate de VÂNZĂTOR."}, {"name": "_S.C. ROXION AGRO S.R.L", "cui": "RO26777575", "regCom": "J05/487/2010", "iban": "", "bank": "BRD ag", "phone": "0771750922", "representative": "Briscut Ionut", "role": "VÂNZĂTOR", "fullText": "_S.C. ROXION AGRO S.R.L. cu sediul Margine nr 174, jud. Bihor, înmatriculata sub nr.J05/487/2010, înregistrata la Reg. C.C.I. Bihor, CIF RO26777575 tel.0771750922, având codul IBAN RO84RNCB0664115622120001 deschis la BRD ag. Marghita, reprezentată prin Briscut Ionut administrator, , în calitate de VÂNZĂTOR."}, {"name": "AVI BROILER SKM SRL", "cui": "RO25379652", "regCom": "J30/297/2009", "iban": "", "bank": "___________", "phone": "", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "AVI BROILER SKM SRL cu sediul în Satu Mare BLD. INDEPENDENTEI, BL.UH10, AP.5, jud. Satu Mare, înmatriculata sub nr. J30/297/2009, înregistrata la Reg. C.C.I. , CIF RO25379652 tel. , având codul IBAN___________________ deschis la ___________, reprezentată prin _________________, în calitate de VÂNZĂTOR."}, {"name": "KAPLONYI JOZSEF ROBERT IF", "cui": "RO 23450985", "regCom": "F30/155/06", "iban": "RO29BTRL03101202H59435XX", "bank": "Banca Transilvania", "phone": "", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "KAPLONYI JOZSEF ROBERT IF cu sediul în Capleni nr.381, jud. Satu Mare, înmatriculată sub nr. F30/155/06.03.2008, înregistrata la Reg. C.C.I. Satu Mare, CIF RO 23450985, tel./fax., având codul IBAN RO29 BTRL 0310 1202 H594 35XX deschis la Banca Transilvania , reprezentată prin _________________administrator CNP 2850124303705, în calitate de VÂNZĂTOR."}, {"name": "KONCZ STEFAN IF", "cui": "18186888", "regCom": "F30/1479/2005", "iban": "RO33RNCB0222029507060002", "bank": "Banca Comerciala Romana", "phone": "", "representative": "______________", "role": "VÂNZĂTOR", "fullText": "KONCZ STEFAN IF. cu sediul în Tiream STR.CIORII 152/ATrifeşti, jud. Satu Mare. , înmatriculată sub nr. F30/1479/2005, înregistrata la Reg. C.C.I. Satu Mare, CIF 18186888, tel./fax. , având codul IBAN RO33 RNCB 0222 0295 0706 0002 deschis la Banca Comerciala Romana, reprezentată prin ______________administrator CNP 180050130378, în calitate de VÂNZĂTOR."}, {"name": "FILIP GHEORGHE DANUT PFA", "cui": "RO30560980", "regCom": "F30/934/2012", "iban": "RO18BRDE310SV56880113100", "bank": "ING Bank suc", "phone": "______________", "representative": "Radu Donca", "role": "VÂNZĂTOR", "fullText": "FILIP GHEORGHE DANUT PFA cu sediul/domiciliul în SAT POTAU NR. 73, jud.Satu Mare,înmatriculată sub nr. F30/934/2012 înregistrata la Reg. C.C.I. ____________________, CIFRO30560980 tel./fax. ______________, având codul IBAN RO18 BRDE 310S V568 8011 3100 deschis la ING Bank suc./ag.______________________, reprezentată prin Radu Donca administrator, în calitate de VÂNZĂTOR."}, {"name": "PALOTAS MIHAI I.I", "cui": "RO31265415", "regCom": "F30 /129 /2013", "iban": "", "bank": "Banca", "phone": "", "representative": "", "role": "VANZATOR", "fullText": "PALOTAS MIHAI I.I. cu sediul în Livada STR VICTORIEI NR69, jud. Satu Mare, înmatriculata sub nr. F30 /129 /2013, înregistrata la Reg. C.C.I, CIF RO31265415 tel. , având codul IBAN RO34CECESM1630RON0406151 deschis la Banca , reprezentată prin , în calitate de VANZATOR."}, {"name": "PALOTAS RICHARD MIHAI I.I", "cui": "RO34358632", "regCom": "F30/270/2015", "iban": "", "bank": "Banca", "phone": "", "representative": "", "role": "VANZATOR", "fullText": "PALOTAS RICHARD MIHAI I.I. cu sediul în Livada STR VICTORIEI NR69/ACHIRALEU NR.149, jud. Satu Mare, înmatriculata sub nr. F30/270/2015, înregistrata la Reg. C.C.I, CIF RO34358632 tel. , având codul IBAN RO43 CRCO X250 1100 0024 8358 deschis la Banca , reprezentată prin , în calitate de VANZATOR."}, {"name": "A.V.CRASNA SRL", "cui": "RO4625622", "regCom": "J30/410/1991", "iban": "RO53RNCB0222055739880001", "bank": "Banca Comerciala Romana suc", "phone": "______________", "representative": "________________________", "role": "VÂNZĂTOR", "fullText": "A.V.CRASNA SRL. cu sediul/domiciliul în Moftinu Mare nr.142 , jud. Satu Mare , înmatriculată sub nr. J30/410/1991 , CIF RO4625622 , tel./fax. ______________, având codul IBAN RO53 RNCB 0222 0557 3988 0001deschis la Banca Comerciala Romana suc./ag.______________________, reprezentată prin ________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "DENICRIS AGRO SRL", "cui": "RO30864890", "regCom": "J05/1873/2012", "iban": "RO51RNCB0035022178070001", "bank": "BCR_____________ suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "DENICRIS AGRO SRL cu sediul/domiciliul în GALOSPETREU NR.218, jud. BIHOR , înmatriculată sub nr. J05/1873/2012 , înregistrata la Reg. C.C.I.__________________, CIF RO30864890 , tel./fax. ______________, având codul IBAN RO51 RNCB 0035 0221 7807 0001 deschis la BCR_____________ suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "BULLS MAN SRL", "cui": "RO37811168", "regCom": "J30/738/2017", "iban": "RO18CECESM0230RON0491071", "bank": "", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "BULLS MAN SRL cu sediul/domiciliul în CAUAS STR. INDEPENDENTEI NR.34, jud. Satu Mare, înmatriculată sub nr. J30/738/2017, înregistrata la Reg. C.C.I. , CIF RO37811168, tel./fax. ______________, având codul IBAN RO18CECESM0230RON0491071 suc./ag.CEC BANK SA, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "S.C. AGRO HEVELI 2018 S.R.L", "cui": "RO 39670790", "regCom": "J30/697/2018", "iban": "", "bank": "", "phone": "0747692000_", "representative": "HEVELI CSABA", "role": "VANZATOR", "fullText": "S.C. AGRO HEVELI 2018 S.R.L. cu sediul în CAPLENI , str.____________nr. 1 , jud. SATU MARE, înmatriculata sub nr. J30/697/2018 , înregistrata la Reg. C.C.I. Bihor, CIF RO 39670790 tel. 0747692000_, având codul IBAN RO44BRDE310SV66902603100 deschis BRD BANK , reprezentată prin HEVELI CSABA, în calitate de VANZATOR."}, {"name": "AGROMAX GRAINS SRL", "cui": "RO34367614", "regCom": "J30/233/2015", "iban": "RO47BTRLRONCRT0295118401", "bank": "Banca Transilvania suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "AGROMAX GRAINS SRL cu sediul/domiciliul în SAT BERCU NR.110, jud. Satu Mare , înmatriculată sub nr. J30/233/2015 , înregistrata la Reg. C.C.I.__________________, CIF RO34367614 , tel./fax. ______________, având codul IBAN RO47BTRLRONCRT0295118401 deschis la Banca Transilvania suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "AGROINVEST CAREI SRL SRL", "cui": "RO17521780", "regCom": "J30/535/2005", "iban": "RO34BTRL03101202219855XX", "bank": "ING Bank suc", "phone": "______________", "representative": "Radu Donca", "role": "VÂNZĂTOR", "fullText": "AGROINVEST CAREI SRL SRL cu sediul/domiciliul în Carei, jud.Satu Mare, str. TIREAMULUI 76 , înmatriculată sub nr. J30/535/2005, înregistrata la Reg. C.C.I. ____________________, CIFRO17521780 tel./fax. ______________, având codul IBAN RO34 BTRL 0310 1202 2198 55XX deschis la ING Bank suc./ag.______________________, reprezentată prin Radu Donca administrator, în calitate de VÂNZĂTOR."}, {"name": "ACTA LINE TRANS SRL", "cui": "RO30257260", "regCom": "J24/457/2012", "iban": "", "bank": "Banca Transilvania", "phone": "_____________", "representative": "Tetis Abraham Claudiu", "role": "VÂNZĂTOR", "fullText": "ACTA LINE TRANS SRL cu sediul în Baia Mare STR. VICTORIEI, NR.71, AP.28 jud. Maramures, înmatriculata sub nr. J24/457/2012, înregistrata la Reg. C.C.I. Bihor, CIF RO30257260 tel._____________, având codul IBAN RO63 BTRL 0250 1202 A023 88XX deschis la Banca Transilvania, reprezentată prin Tetis Abraham Claudiu , în calitate de VÂNZĂTOR."}, {"name": "CHEREJI CRACIUN COOP.AGR", "cui": "RO41409992", "regCom": "C30/9/2019", "iban": "", "bank": "Banca Comerciala Romana", "phone": "_____________", "representative": "_____________________", "role": "VÂNZĂTOR", "fullText": "CHEREJI CRACIUN COOP.AGR cu sediul în Piscolt STR. UNIRII, NR.911 jud.Satu Mare, înmatriculata sub nr. C30/9/2019, înregistrata la Reg. C.C.I. Bihor, CIF RO41409992 tel._____________, având codul IBAN RO23RNCB0222164162230001 deschis la Banca Comerciala Romana, reprezentată prin _____________________, în calitate de VÂNZĂTOR."}, {"name": "AGROFARM ERIU SANCRAI SRL", "cui": "RO36681205", "regCom": "J30/937/2016", "iban": "", "bank": "Banca ________________", "phone": "0761415163", "representative": "_____________________", "role": "VÂNZĂTOR", "fullText": "AGROFARM ERIU SANCRAI SRL cu sediul în Eriu Sancrai, nr.102 jud.Satu Mare, înmatriculata sub nr. J30/937/2016, înregistrata la Reg. C.C.I. Bihor, CIF RO36681205 tel. 0761415163, având codul IBAN _________________________________ deschis la Banca ________________, reprezentată prin _____________________, în calitate de VÂNZĂTOR."}, {"name": "VIITORUL SA SANISLAU", "cui": "RO648771", "regCom": "", "iban": "", "bank": "Raiffeisen Bank reprezentată prin ___________________ administrator in calitate de VANZATOR", "phone": "", "representative": "___________________", "role": "VANZATOR", "fullText": "VIITORUL SA SANISLAU cu sediul în Sanislau jud.Satu Mare, înmatriculata sub nr. 35/13.04.1992, înregistrata la Reg. C.C.I. Satu Mare, CIF RO648771 tel. , având codul IBAN RO66RZBR0000060001473411 deschis la Raiffeisen Bank reprezentată prin ___________________ administrator in calitate de VANZATOR."}, {"name": "KIS M GABOR PFA", "cui": "", "regCom": "F30/99/2021", "iban": "RO43BRDE310SV73504443100", "bank": "BRD", "phone": "_____________", "representative": "______________", "role": "PROPRIETAR", "fullText": "KIS M GABOR PFA cu sediul în Carei str.titulescu nr .19, jud. Satu Mare, înmatriculata sub nr. F30/99/2021, înregistrata la Reg. C.C.I. RO43845530__________ tel. _____________, având codul IBAN RO43BRDE310SV73504443100 deschis la BRD , reprezentată prin ______________, în calitate de PROPRIETAR."}, {"name": "TERRA SOC.AGR. SANISLAU", "cui": "RO648780", "regCom": "", "iban": "RO07RZBR0000060001473406", "bank": "Raiffeisen Bank suc", "phone": "", "representative": "administrator", "role": "VÂNZĂTOR", "fullText": "TERRA SOC.AGR. SANISLAU cu sediul în Sanislau, jud. Satu Mare, str LIBERTATII 562, înmatriculată sub nr. , înregistrata la Reg. C.C.I. Satu Mare, CIF RO648780, tel./fax. , având codul IBAN RO07 RZBR 0000 0600 0147 3406 deschis la Raiffeisen Bank suc. , reprezentată prin administrator, în calitate de VÂNZĂTOR."}, {"name": "SCHAMAGOSCH SOC.AGR", "cui": "RO648739", "regCom": "", "iban": "RO31BRDE310SV43317313100", "bank": "BRD suc", "phone": "", "representative": "Mihai Lochli", "role": "VÂNZĂTOR", "fullText": "SCHAMAGOSCH SOC.AGR. cu sediul în Ciumesti, jud. Satu Mare, str. NISIPULUI 56, înmatriculată sub nr. HJ20/1992, înregistrata la Reg. C.C.I. Satu Mare, CIF RO648739, tel./fax. , având codul IBAN RO31 BRDE 310S V433 1731 3100 deschis la BRD suc. , reprezentată prin Mihai Lochli administrator, în calitate de VÂNZĂTOR."}, {"name": "KOVACS IOZSEF I.I", "cui": "RO26079661", "regCom": "F05/1681/2009", "iban": "RO36BRDE050SV48107870500", "bank": "Banca Romana de Dezvoltare", "phone": "", "representative": "Kovacs Iozsef", "role": "VÂNZĂTOR", "fullText": "KOVACS IOZSEF I.I., cu sediul in BUDUSLAU NR.16, jud. Bihor, înregistrata la C.C.I. Bihor, sub nr. F05/1681/2009, CIF RO26079661, tel./fax. având contul IBAN RO36BRDE050SV48107870500 deschis la Banca Romana de Dezvoltare , reprezentată prin Kovacs Iozsef, în calitate de VÂNZĂTOR."}, {"name": "BOVAGRO PISCARI COOP AGR", "cui": "RO41485736", "regCom": "C30/12/2019", "iban": "RO72BRDE310SV69853753100", "bank": "BRD suc", "phone": "0728321463", "representative": "Avorniciti Neculai", "role": "VÂNZĂTOR", "fullText": "BOVAGRO PISCARI COOP AGR. cu sediul în Pişcari, jud. Satu Mare, str. Istrău nr. 207, înmatriculată sub nr. C30/12/2019, înregistrata la Reg. C.C.I. Satu Mare, CIF RO41485736, tel./fax. 0728321463, având codul IBAN RO72BRDE310SV69853753100 deschis la BRD suc. Satu Mare, reprezentată prin Avorniciti Neculai administrator, în calitate de VÂNZĂTOR."}, {"name": "VAN DEN HEERIK AGRICOLA SRL", "cui": "RO18961622", "regCom": "J05/1719/2006", "iban": "RO23RZBR0000060010957875", "bank": "Raiffeisen Bank suc", "phone": "______________", "representative": "Borsi Attila", "role": "VÂNZĂTOR", "fullText": "VAN DEN HEERIK AGRICOLA SRL cu sediul/domiciliul în Marghita , jud. Satu Mare , STR.TUDOR VLADIMIRESCU NR.273 , înmatriculată sub nr. J05/1719/2006 , CIF RO18961622 , tel./fax. ______________, având codul IBAN RO23 RZBR 0000 0600 1095 7875 deschis la Raiffeisen Bank suc./ag.______________________, reprezentată prin Borsi Attila administrator, în calitate de VÂNZĂTOR."}, {"name": "SEMCEREAL SRL S.R.L", "cui": "RO25149424", "regCom": "J05/246/2009", "iban": "", "bank": "", "phone": "0740344288", "representative": "Bogdan Tirpe", "role": "VANZATOR", "fullText": "SEMCEREAL SRL S.R.L. cu sediul în Salard, NR.431, ET.1, AP.2 , jud. Bih, înmatriculata sub nr. J05/246/2009 , înregistrata la Reg. C.C.I. Bihor, CIF RO25149424 tel. 0740344288, având codul IBAN ___________________ deschis _________________, reprezentată prin Bogdan Tirpe , în calitate de VANZATOR."}, {"name": "CAMPIA CAREIULUI COOP AGR", "cui": "", "regCom": "C30/1/2017", "iban": "", "bank": "Unicredit Bank", "phone": "_____________", "representative": "______________", "role": "VÂNZĂTOR", "fullText": "CAMPIA CAREIULUI COOP AGR cu sediul în Petresti nr.68, jud.Satu Mare , înmatriculata sub nr. C30/1/2017, înregistrata la Reg. C.C.I. RO37622967 tel. _____________, având codul IBAN RO74BACX0000001900568000 deschis la Unicredit Bank , reprezentată prin ______________, CNP ___________________, în calitate de VÂNZĂTOR."}, {"name": "ROSCA MARIA I.I", "cui": "RO17309648", "regCom": "F30/223/2005", "iban": "", "bank": "Raiffeisen Bank suc", "phone": "______________", "representative": "________________________", "role": "VÂNZĂTOR", "fullText": "ROSCA MARIA I.I.. cu sediul/domiciliul în Sanislau , jud. Satu Mare , str. 30 DECEMBRIE NR , înmatriculată sub nr. F30/223/2005 , CIF RO17309648 , tel./fax. ______________, având codul IBAN RO15 RZBR 0000 0600 0238 8554 deschis la Raiffeisen Bank suc./ag.______________________, reprezentată prin ________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "AGROCOM BOGDANA SRL", "cui": "RO14918549", "regCom": "J30/480/2002", "iban": "RO78BTRL03101202E29343XX", "bank": "Banca Transilvania suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "AGROCOM BOGDANA SRL cu sediul/domiciliul în Tasnad sat Cig nr.1, jud. Satu Mare, înmatriculată sub nr. J30/480/2002, înregistrata la Reg. C.C.I. ____________________, CIF RO14918549 , tel./fax. ______________, având codul IBAN RO78 BTRL 0310 1202 E293 43XX deschis la Banca Transilvania suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "BALINT ROBERT JOZSEF PFA", "cui": "RO29699196", "regCom": "F30/330", "iban": "RO55RNCB0226126182850001", "bank": "Banca Comerciala Romana suc", "phone": "______________", "representative": "______________________________________", "role": "VÂNZĂTOR", "fullText": "BALINT ROBERT JOZSEF PFA cu sediul/domiciliul în HODOD, NR.63, jud. Satu Mare, înmatriculată sub nr. F30/330./2012, înregistrata la Reg. C.C.I. ____________________, CIF _ RO29699196 , tel./fax. ______________, având codul IBAN RO55 RNCB 0226 1261 8285 0001 deschis la Banca Comerciala Romana suc./ag._________________, reprezentată prin ______________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "TOP CRAIDOROLT SRL", "cui": "RO26773590", "regCom": "J30/169/2014", "iban": "", "bank": "Raiffeisen Bank suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "TOP CRAIDOROLT SRL cu sediul/domiciliul în Craidorolt, jud.Satu Mare, str. PRINCIPALA NR.58/A, înmatriculată sub nr. J30/169/2014, înregistrata la Reg C.C.I. ____________________, CIF RO26773590 tel./fax. ______________, având codul IBAN RO43 RZBR 0000 0600 1288 1122 deschis la Raiffeisen Bank suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "PETKES MIKLOS OLIVER I.I", "cui": "RO43298211", "regCom": "F30/478/2020", "iban": "", "bank": "Raiffeisen Bank suc", "phone": "______________", "representative": "________________________", "role": "VÂNZĂTOR", "fullText": "PETKES MIKLOS OLIVER I.I.. cu sediul/domiciliul în SER, NR.275 , jud. Satu Mare , înmatriculată sub nr. F30/478/2020 , CIF RO43298211 , tel./fax. ______________, având codul IBAN ___________________deschis la Raiffeisen Bank suc./ag.______________________, reprezentată prin ________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "AGRIPRODCOM SRL", "cui": "RO6852141", "regCom": "J30/2067/1994", "iban": "", "bank": "CEC Bank suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "AGRIPRODCOM SRL cu sediul/domiciliul în Craidorolt, jud.Satu Mare, str. NR.222, înmatriculată sub nr. J30/2067/1994 , înregistrata la Reg C.C.I. ____________________, CIF RO6852141 tel./fax. ______________, având codul IBAN RO70 CECE SM01 01RO N005 7995 deschis la CEC Bank suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "TOP FERMA SRL", "cui": "RO27484018", "regCom": "J30/168/2014", "iban": "", "bank": "Raiffeisen Bank suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "TOP FERMA SRL cu sediul/domiciliul în Craidorolt, jud.Satu Mare, str. PRINCIPALA NR.58/A, înmatriculată sub nr. J30/168/2014, înregistrata la Reg C.C.I. ____________________, CIF RO27484018 tel./fax. ______________, având codul IBAN RO77 RZBR 0000 0600 1298 0517 deschis la Raiffeisen Bank suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "POP GH.CLAUDIU I.I", "cui": "RO31100131", "regCom": "F30/26/17", "iban": "RO92BTRLRONCRT0205250001", "bank": "Banka Transilvania suc", "phone": "______________", "representative": "________________________", "role": "VÂNZĂTOR", "fullText": "POP GH.CLAUDIU I.I. cu sediul/domiciliul în Domanesti , jud. Satu Mare , str.__ nr.274 , înmatriculată sub nr. F30/26/17.01.2013 , CIF RO31100131 , tel./fax. ______________, având codul IBAN RO92 BTRL RONC RT02 0525 0001 deschis la Banka Transilvania suc./ag.______________________, reprezentată prin ________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "AGRONOR COMPANY SRL", "cui": "RO20850200", "regCom": "J30/149/2007", "iban": "", "bank": "ING Bank suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "AGRONOR COMPANY SRL cu sediul/domiciliul în Carei, jud.Satu Mare, str. STR.CUZA VODA NR 27, înmatriculată sub nr. J30/149/2007, înregistrata la Reg. C.C.I. ____________________, CIF RO20850200 tel./fax. ______________, având codul IBAN RO36 INGB 0022 0000 5046 8911 deschis la ING Bank suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "AGRIND SA TASNAD", "cui": "RO665284", "regCom": "J30/955/1991", "iban": "RO76BTRL03101202209295XX", "bank": "Banca Transilvania suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "AGRIND SA TASNAD cu sediul/domiciliul în Tasnad, jud.Satu Mare, str. INFRATIRII NR 147, înmatriculată sub nr. J30/955/1991, înregistrata la Reg. C.C.I. ____________________, CIF RO665284, tel./fax. ______________, având codul IBAN RO76 BTRL 0310 1202 2092 95XX deschis la Banca Transilvania suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "EUDIS SA", "cui": "RO7895515", "regCom": "", "iban": "RO88BTRL03201202220421XX", "bank": "Banca Transilvania suc", "phone": "", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "EUDIS SA cu sediul/domiciliul în Criseni nr.376/E , jud. Salaj , , înmatriculată sub nr. , înregistrata la Reg. C.C.I. , CIF RO7895515 , tel./fax. , având codul I BAN RO88 BTRL 0320 1202 2204 21XX deschis la Banca Transilvania suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "SPIC AGRO SRL", "cui": "RO 9161442", "regCom": "J30/104/1997", "iban": "", "bank": "", "phone": "_______", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "SPIC AGRO SRL cu sediul/domiciliul în CAREI, jud. SATU MARE, str. , înmatriculată sub nr. J30/104/1997, înregistrata la Reg. C.C.I. , CIF RO 9161442, tel./fax. _______, având codul IBAN RO40 CECE SM02 01RO N025 4333 la CEC BANK_ suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "RASNATAL SOC.AGR. CAPLENI", "cui": "", "regCom": "", "iban": "", "bank": "Raiffeisen Bank", "phone": "_____________", "representative": "______________", "role": "VÂNZĂTOR", "fullText": "RASNATAL SOC.AGR. CAPLENI cu sediul în Carei STR.PRINCIPALA, 125, jud. Satu Mare , înmatriculata sub nr. J_________, înregistrata la Reg. C.C.I. RO 5674046 tel. _____________, având codul IBAN RO17 RZBR 0000 0600 0147 3420 deschis la Raiffeisen Bank , reprezentată prin ______________, CNP ___________________, în calitate de VÂNZĂTOR."}, {"name": "GOSPODARUL DIN ARDEAL SRL", "cui": "RO29738384", "regCom": "J12/331/2012", "iban": "RO37BTRLRONCRTOP16749602", "bank": "Banca Comercială S", "phone": "0744854301", "representative": "ing", "role": "VÂNZĂTOR", "fullText": "GOSPODARUL DIN ARDEAL SRL cu sediul în Cluj Napoca, jud.Cluj , str. STR. SITARILOR, NR.44, înmatriculată sub nr. J12/331/2012, înregistrata la Reg. C.C.I. Satu Mare, CIF RO29738384, tel./fax. 0744854301, având codul IBAN RO37 BTRL RONC RTOP 1674 9602 deschis la Banca Comercială S.A. ag. Carei, reprezentată prin ing. administrator , în calitate de VÂNZĂTOR."}, {"name": "EKOBRIK S.R.L", "cui": "", "regCom": "J05/3062/2008", "iban": "", "bank": "", "phone": "_____________", "representative": "______________", "role": "VÂNZĂTOR", "fullText": "EKOBRIK S.R.L. cu sediul în Diosig STR. ARGESULUI, NR.7, jud. Bihor, înmatriculata sub nr. J05/3062/2008, înregistrata la Reg. C.C.I. RO24905090__________ tel. _____________, având codul IBAN ______________________ deschis la____________, reprezentată prin ______________, CNP ___________________, în calitate de VÂNZĂTOR."}, {"name": "NORD GRAIN SRL", "cui": "RO23978957", "regCom": "J30/783/2008", "iban": "", "bank": "Banca Romana pentru Dezvoltare suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "NORD GRAIN SRL cu sediul/domiciliul în Carei , jud. Satu Mare, str. CALEA ARMATEI ROMANE NR 81B, înmatriculată sub nr. J30/783/2008, înregistrata la Reg. C.C.I. _____, CIF RO23978957 , tel./fax. ______________, având codul IBAN RO37 BRDE 310S V224 0690 3100 deschis la Banca Romana pentru Dezvoltare suc./ag.______________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "AGRICOLA TIREAM SRL", "cui": "RO29478691", "regCom": "J30/922/21", "iban": "", "bank": "Banca Romana pentru Dezvoltare suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "AGRICOLA TIREAM SRL cu sediul/domiciliul în Carei , jud. Satu Mare, str. CALEA ARMATEI ROMANE NR 81B, înmatriculată sub nr. J30/922/21.12.2011, înregistrata la Reg. C.C.I. _____, CIF RO29478691 , tel./fax. ______________, având codul IBAN RO26 BRDE 310S V598 6561 3100 deschis la Banca Romana pentru Dezvoltare suc./ag.______________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "PETE KOMAROMY ORS SZILARD PFA", "cui": "RO26121189", "regCom": "F30/845/19", "iban": "RO11BTRLRONCRT0V07346501", "bank": "Banca Transilvania suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "PETE KOMAROMY ORS SZILARD PFA cu sediul/domiciliul în Carei STR.PETOFI SANDOR NR.59, jud. Satu Mare , înmatriculată sub nr. F30/845/19.10.2009, înregistrata la Reg. C.C.I. ____________________, CIF RO26121189, tel./fax. ______________, având codul IBAN RO11 BTRL RONC RT0V 0734 6501 deschis la Banca Transilvania suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "MAISONS SRL", "cui": "RO13808130", "regCom": "J05/278/2001", "iban": "RO74BRDE050SV63451540500", "bank": "Banca Romana de Dezvoltare suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "MAISONS SRL cu sediul/domiciliul în Sacueni STR LETA MARE NR 12, jud. Bihor, înmatriculată sub nr. J05/278/2001, înregistrata la Reg. C.C.I. ____, CIF RO13808130 , tel./fax. ______________, având codul IBAN RO74 BRDE 050S V634 5154 0500 deschis la Banca Romana de Dezvoltare suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "SEGAL &CO SRL", "cui": "RO9064237", "regCom": "J30/23/1997", "iban": "", "bank": "Banca Romana pentru Dezvoltare", "phone": "0261766860", "representative": "__________________", "role": "VÂNZĂTOR", "fullText": "SEGAL &CO SRL cu sediul în Satu Mare STR. INDEPENDENTEI BL.UH10,AP.5, jud. Satu Mare , înmatriculata sub nr. J30/23/1997, înregistrata la Reg. C.C.I. , CIF RO9064237 tel. 0261766860 , având codul IBAN RO71 BRDE 310S V028 5587 3100 deschis la Banca Romana pentru Dezvoltare , reprezentată prin __________________, CNP ___________________, în calitate de VÂNZĂTOR."}, {"name": "AGROCOOP APA COOP.AGR", "cui": "RO41791689", "regCom": "C30/14/2019", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________", "role": "VÂNZĂTOR", "fullText": "AGROCOOP APA COOP.AGR. cu sediul în loc. APA, NR.727 , jud. Satu Mare, înmatriculata sub nr. C30/14/2019 la Reg.C.C.I. , CIFRO41791689 , reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "INFRATIREA SOC AGR CAREI", "cui": "RO2826972", "regCom": "", "iban": "", "bank": "Banca Romana de Dezvoltare suc", "phone": "0261862452", "representative": "Ciucos Liviu", "role": "VÂNZĂTOR", "fullText": "INFRATIREA SOC AGR CAREI cu sediul/domiciliul în CAREI C-lea Armatei Române nr . 80_, jud. . Satu Mare , înregistrata la Jud.1/1191, CIF RO2826972 tel./fax. 0261862452 , având codul IBAN RO76 BRDE 310 SV022 5146 3100 deschis la Banca Romana de Dezvoltare suc./ag.Carei , reprezentată prin Ciucos Liviu administrator, în calitate de VÂNZĂTOR."}, {"name": "AGROCRONOS SRL", "cui": "RO17249511", "regCom": "J30/215/2005", "iban": "", "bank": "Banca Transilvania ag", "phone": "0744575679", "representative": "ing. Marius Ciucos", "role": "VANZATOR", "fullText": "AGROCRONOS SRL. cu sediul în Carei str.Tireamului nr. 90, jud. Satu Mare, înmatriculata sub nr. J30/215/2005, înregistrata la Reg. C.C.I. , CIF RO17249511 tel. 0744575679, având codul IBAN RO37 BTRL 0310 1202 2181 03XX deschis la Banca Transilvania ag. Carei, reprezentată prin ing. Marius Ciucos , , în calitate de VANZATOR."}, {"name": "COM ABM SRL", "cui": "", "regCom": "J02/756/1995", "iban": "", "bank": "Procredit Bank", "phone": "_____________", "representative": "______________", "role": "VÂNZĂTOR", "fullText": "COM ABM SRL cu sediul în Arad STR. POETULUI, NR.6, jud.Arad, înmatriculata sub nr. J02/756/1995, înregistrata la Reg. C.C.I. RO7987023 tel. _____________, având codul IBAN RO45 MIRO 0000 4589 9678 0101 deschis la Procredit Bank, reprezentată prin ______________, CNP ___________________, în calitate de VÂNZĂTOR."}, {"name": "S.C. CARIN AGRAR SRL", "cui": "", "regCom": "J02/55/2000", "iban": "", "bank": "Procredit Bank", "phone": "_____________", "representative": "______________", "role": "VÂNZĂTOR", "fullText": "S.C. CARIN AGRAR SRL cu sediul în COM VLADIMIRESCU NR.458, jud.Arad, înmatriculata sub nr. J02/55/2000, înregistrata la Reg. C.C.I. RO12657080 tel. _____________, având codul IBAN RO82 MIRO 0000 4588 9160 0201 deschis la Procredit Bank, reprezentată prin ______________, CNP ___________________, în calitate de VÂNZĂTOR."}, {"name": "ALBY MAXAGRONOMIA SRL", "cui": "RO36479258", "regCom": "J30/788/2016", "iban": "RO42BTRLRONCRT0483311101", "bank": "Raiffeisen Bank suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "ALBY MAXAGRONOMIA SRL cu sediul/domiciliul în Odoreu, jud. Satu Mare, str. str. Plopilor, nr. 1, înmatriculată sub nr. J30/788/2016, înregistrata la Reg. C.C.I. _____, CIF RO36479258 , tel./fax. ______________, având codul IBAN RO42 BTRL RONC RT04 8331 1101 deschis la Raiffeisen Bank suc./ag.______________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "COMODORE SA", "cui": "RO670108", "regCom": "", "iban": "RO96RZBR0000060000906876", "bank": "Raiffeisen Bank suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "COMODORE SA cu sediul/domiciliul în Odoreu, jud. Satu Mare, str. str. Plopilor, nr. 1, înmatriculată sub nr. J___/_____/________, înregistrata la Reg. C.C.I. _____, CIF RO670108 , tel./fax. ______________, având codul IBAN RO96 RZBR 0000 0600 0090 6876 deschis la Raiffeisen Bank suc./ag.______________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "SOMOGYI C. CAROL PFA", "cui": "RO21811102", "regCom": "F05 /804 /2019", "iban": "RO27BTRL00501202J57455XX", "bank": "Banca Transilvania __________________ suc", "phone": "", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "SOMOGYI C. CAROL PFA cu sediul/domiciliul în Valea lui Mihai, jud. Bihor, STR. KOSUTH LAJOS NR.50 , înmatriculată sub nr. F05 /804 /2019, înregistrata la Reg. C.C.I. , CIF RO21811102 , tel./fax. , având codul IBAN RO27 BTRL 0050 1202 J574 55XX deschis la Banca Transilvania __________________ suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "VALEA GANASULUI SRL", "cui": "RO15895443", "regCom": "J05/1456/2003", "iban": "RO27BTRL00501202J57455XX", "bank": "Banca Transilvania __________________ suc", "phone": "", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "VALEA GANASULUI SRL cu sediul/domiciliul în Valea lui Mihai, jud. Bihor, STR. KOSUTH LAJOS NR.50 , înmatriculată sub nr. J05/1456/2003, înregistrata la Reg. C.C.I. , CIF RO15895443 , tel./fax. , având codul IBAN RO27 BTRL 0050 1202 J574 55XX deschis la Banca Transilvania __________________ suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "RUBEN PREST SRL TARCEA", "cui": "RO7072810", "regCom": "", "iban": "RO77BRDE050SV35091590500", "bank": "BRD suc", "phone": "___________________________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "RUBEN PREST SRL TARCEA cu sediul/domiciliul în Tarcea nr. 160, jud. BIHOR înmatriculată sub nr J05/236/1995 înregistrata la Reg. C.C.I. , CIF RO7072810, tel./fax. ___________________________, având codul IBAN RO77 BRDE 050S V350 9159 0500 deschis la BRD suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "OROS OVIDIU PFA", "cui": "RO23735648", "regCom": "F05/604/2008", "iban": "", "bank": "Banca __________________ suc", "phone": "", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "OROS OVIDIU PFA cu sediul/domiciliul în Spinus, jud. Bihor, str. Nr.223 , înmatriculată sub nr. F05/604/2008, înregistrata la Reg. C.C.I. , CIF RO23735648 7 , tel./fax. , având codul IBAN ________________ deschis la Banca __________________ suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "ORDOG NAGY AGROPREST", "cui": "RO6122686", "regCom": "J05 /3212 /1994", "iban": "", "bank": "Raiffeisen", "phone": "", "representative": "_______________", "role": "VÂNZĂTOR", "fullText": "ORDOG NAGY AGROPREST . cu sediul în loc. Chet nr. 330, jud . Bihor, înmatriculată sub nr. J05 /3212 /1994, înregistrata la Reg. C.C.I. Satu Mare, CIF RO6122686, tel./fax , având codul IBANRO07 RZBR 0000 0600 0149 6007 deschis la Raiffeisen., reprezentată prin _______________ administrator, în calitate de VÂNZĂTOR."}, {"name": "SAMPAX SRL", "cui": "RO640492", "regCom": "J30/5/1991", "iban": "", "bank": "", "phone": "_______", "representative": "Costin Ioan Mircea", "role": "VÂNZĂTOR", "fullText": "SAMPAX SRL cu sediul/domiciliul în SATU MARE, jud. SATU MARE, str. STR. DRUM CAREI NR160 , înmatriculată sub nr. J30/5/1991 , înregistrata la Reg. C.C.I. , CIF RO640492, tel./fax. _______, având codul IBAN RO36 BRDE 310S V025 7818 3100 la BRD _ suc./ag.______________________, reprezentată prin Costin Ioan Mircea administrator, în calitate de VÂNZĂTOR."}, {"name": "POP DANIEL AGRO I.I", "cui": "", "regCom": "F05/1426/2016", "iban": "", "bank": "Banca Transilvania", "phone": "0740353044", "representative": "______________", "role": "VÂNZĂTOR", "fullText": "POP DANIEL AGRO I.I. cu sediul în SAT TARCEA NR 4, jud. Bihor, înmatriculata sub nr. F05/1426/2016 , înregistrata la Reg. C.C.I. RO36718894 tel. 0740353044, având codul IBAN RO65 BTRL RONC RT03 9743 2901 deschis la Banca Transilvania, reprezentată prin ______________, CNP ___________________, în calitate de VÂNZĂTOR."}, {"name": "AGROMEC SACUENI S.A", "cui": "RO111661", "regCom": "J05/670/1991", "iban": "", "bank": "CEC Bank", "phone": "", "representative": "", "role": "VÂNZĂTOR", "fullText": "AGROMEC SACUENI S.A. cu sediul în Sacueni , STR. IRINYI JANOS, NR.156, jud. Bihor, înmatriculata sub nr. J05/670/1991 , înregistrata la Reg. C.C.I. Bihor, CIF RO111661 tel. , având codul IBAN RO25 CECE BH01 01RO N037 9675 deschis la CEC Bank , reprezentată prin_ , în calitate de VÂNZĂTOR."}, {"name": "CALUGAR TIMEA NICAGRO I.I", "cui": "RO32714539", "regCom": "F30/54/2014", "iban": "RO26CECESM0230RON0429914", "bank": "CEC BANK SA suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "CALUGAR TIMEA NICAGRO I.I. cu sediul/domiciliul în GHENCI NR.264, jud. Satu Mare, înmatriculată sub nr. F30/54/2014, înregistrata la Reg. C.C.I. , CIF RO32714539, tel./fax. ______________, având codul IBAN RO26 CECE SM02 30RO N042 9914 deschis la CEC BANK SA suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "AGROMOLNAR SRL", "cui": "RO20762567", "regCom": "J05/176/2007", "iban": "", "bank": "Banca Transilvania", "phone": "", "representative": "", "role": "VANZATOR", "fullText": "AGROMOLNAR SRL cu sediul în ADONI NR 15, jud. BIHOR, înmatriculata sub nr. J05/176/2007, înregistrata la Reg. C.C.I. Bihor, CIF RO20762567 tel. , având codul IBAN RO11 BTRL RONC RT02 1741 3901 deschis la Banca Transilvania , reprezentată prin , în calitate de VANZATOR."}, {"name": "CHIS IOAN ALEXANDRU I.I", "cui": "RO 35530808", "regCom": "F30/24/2016", "iban": "", "bank": "Banca Transilvania", "phone": "", "representative": "", "role": "VANZATOR", "fullText": "CHIS IOAN ALEXANDRU I.I cu sediul în TASNAD STR. TRANDAFIRILOR NR, jud. BIHOR, înmatriculata sub nr. F30/24/2016 , înregistrata la Reg. C.C.I. Bihor, CIF RO 35530808 tel. , având codul IBAN RO40BTRLRONCRT0338423401 deschis la Banca Transilvania , reprezentată prin , în calitate de VANZATOR."}, {"name": "Societatea Agricolă PETREŞTI", "cui": "RO648410", "regCom": "", "iban": "RO72RZBR0000060001473400", "bank": "Raiffeisen ag", "phone": "0744570372", "representative": "ing. Mozer Francisc presedinte", "role": "VÂNZĂTOR", "fullText": "Societatea Agricolă PETREŞTI , cu sediul în Petreşti, jud. Satu Mare, str. Principală nr. 1, CIF RO648410, tel./fax. 0744570372, avand contul IBAN RO72 RZBR 0000 0600 0147 3400 deschis la Raiffeisen ag. Carei, reprezentată prin ing. Mozer Francisc presedinte, în calitate de VÂNZĂTOR."}, {"name": "S.C. ALE AGROZONE AVT S.R.L", "cui": "RO36874818", "regCom": "J30/1067/2016", "iban": "RO632RZBR0000060019135340", "bank": "Raiffeisen ag", "phone": "0745477240", "representative": "Constantin Oneţ", "role": "VÂNZĂTOR", "fullText": "S.C. ALE AGROZONE AVT S.R.L. cu sediul în Carei, jud. Satu Mare, str. Gheorghe Lazăr nr. 4, înmatriculată sub nr. J30/1067/2016 la Reg. C.C.I. Satu Mare, CIF RO36874818, tel./fax. 0745477240, avand contul IBAN RO632 RZBR 0000 0600 1913 5340 deschis la Raiffeisen ag. Carei, reprezentată prin Constantin Oneţ administrator, în calitate de VÂNZĂTOR."}, {"name": "S.C. IANCULEŞTI S.R.L", "cui": "RO24864594", "regCom": "J30/1564/2008", "iban": "RO18RZBR0000060014714484", "bank": "Raiffeisen ag", "phone": "0745477240", "representative": "Voichița Oneţ", "role": "VÂNZĂTOR", "fullText": "S.C. IANCULEŞTI S.R.L. cu sediul în Carei, jud. Satu Mare, str. Gheorghe Lazăr nr. 4, înmatriculată sub nr. J30/1564/2008 la Reg. C.C.I. Satu Mare, CIF RO24864594, tel./fax. 0745477240, avand contul IBAN RO18 RZBR 0000 0600 1471 4484 deschis la Raiffeisen ag. Carei, reprezentată prin Voichița Oneţ administrator, în calitate de VÂNZĂTOR."}, {"name": "S.C. FARMLAND S.R.L", "cui": "RO19275134", "regCom": "J05/2541/2006", "iban": "RO51FNNB001702452073RO01", "bank": "Credit Europe Bank suc", "phone": "0259464121", "representative": "Mircea Ciobanu", "role": "VÂNZĂTOR", "fullText": "S.C. FARMLAND S.R.L. cu sediul În Tarcea, jud. Bihor, str. Mică nr. 174/B, înregistrata la C.C.I. Bihor, sub nr. J05/2541/2006, CIF RO19275134, tel./fax. 0259464121, având contul IBAN RO51 FNNB 0017 0245 2073 RO01 deschis la Credit Europe Bank suc. Oradea, reprezentat prin Mircea Ciobanu administrator, în calitate de VÂNZĂTOR."}, {"name": "GABITAR SRL", "cui": "RO 12534614", "regCom": "J05/940/99", "iban": "", "bank": "Banca Transilvania ag", "phone": "0745-643098", "representative": "", "role": "VÂNZĂTOR", "fullText": "GABITAR SRL cu sediul în Valea lui Mihai str. Ady Endre nr.1, jud. Bihor, înmatriculata sub nr. J05/940/99, înregistrata la Reg. C.C.I. Bihor, CIF RO 12534614 tel. 0745-643098, având codul IBAN RO05 BTRL RONC RT02 3804 9401 deschis la Banca Transilvania ag. Valea lui Mihai, reprezentată prin , în calitate de VÂNZĂTOR."}, {"name": "FURTOS FLORICA PFA", "cui": "", "regCom": "F5/570/2012", "iban": "", "bank": "BANCA TRANSILVANIA suc", "phone": "", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "FURTOS FLORICA PFA cu sediul/domiciliul FEGERNICU NOU, NR.26, jud. BIHOR, înmatriculată sub nr. F5/570/2012 , înregistrata la Reg. . , CIF RO RO29710499 , tel./fax. având codul IBAN RO30 BTRL 0050 1202 W822 75XX deschis la BANCA TRANSILVANIA suc./ag.__________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "SC INA AGRICULTURA VERDE SRL", "cui": "RO 30869693", "regCom": "J02/1216/2012", "iban": "", "bank": "", "phone": "", "representative": "Avram Alina Claudia-", "role": "VÂNZĂTOR", "fullText": "SC INA AGRICULTURA VERDE SRL cu sediul în com.Sofronea, jud. Arad , nr.592, înmatriculată sub nr. J02/1216/2012, CIF RO 30869693 , reprezentată prin Avram Alina Claudia-administrator, în calitate de VÂNZĂTOR."}, {"name": "SZABO CONST SRL", "cui": "RO21262195", "regCom": "J30/342/2007", "iban": "", "bank": "Banca Romana de Dezvoltare", "phone": "", "representative": "", "role": "VANZATOR", "fullText": "SZABO CONST SRL cu sediul în Bogdand NR 61, jud.Satu Mare, înmatriculata sub nr. J30/342/2007 , înregistrata la Reg. C.C.I. Bihor, CIF RO21262195 tel. , având codul IBAN RO36BRDE310SV61817053100 deschis la Banca Romana de Dezvoltare , reprezentată prin , în calitate de VANZATOR."}, {"name": "HAR PAPI SRL", "cui": "RO23326937", "regCom": "J31 /165 /2008", "iban": "", "bank": "Banca Comeriala Romana", "phone": "", "representative": "", "role": "VANZATOR", "fullText": "HAR PAPI SRL cu sediul în LOC. ULCIUG ORS. CEHU SILVANIEI, ULCIUG, NR.214, jud.Salaj, înmatriculata sub nr. J31 /165 /2008 , înregistrata la Reg. C.C.I. , CIF RO23326937 tel. , având codul IBAN RO05RNCB0215098152000001 deschis la Banca Comeriala Romana , reprezentată prin , în calitate de VANZATOR."}, {"name": "CONTEX SOC.AGR. SANISLAU", "cui": "", "regCom": "", "iban": "RO55RZBR0000060001473415", "bank": "Raiffeisen Bank", "phone": "_____________", "representative": "______________", "role": "VÂNZĂTOR", "fullText": "CONTEX SOC.AGR. SANISLAU cu sediul în Sanislau nr . 562 ______, jud. Satu Mare, înmatriculata sub nr. J_________, înregistrata la Reg. C.C.I. RO648763__________ tel. _____________, având codul IBAN RO55 RZBR 0000 0600 0147 3415 deschis la Raiffeisen Bank , reprezentată prin ______________, CNP ___________________, în calitate de VÂNZĂTOR."}, {"name": "SC AVENA PRODCOMEXIM SRL", "cui": "RO 5431462", "regCom": "J05/1134/1994", "iban": "RO89RNCB0035022152090001", "bank": "BCR", "phone": "", "representative": "Olah Sandor-", "role": "VÂNZĂTOR", "fullText": "SC AVENA PRODCOMEXIM SRL cu sediul/domiciliul în BUDUSLAU, jud. BIHOR, str. PRINCIPALA NR 10 , înmatriculată sub nr. J05/1134/1994 , înregistrata la Reg. C.C.I. , CIF RO 5431462, având codul RO89 RNCB 0035 0221 5209 0001 deschis la BCR, reprezentată prin Olah Sandor- administrator, în calitate de VÂNZĂTOR."}, {"name": "S.C. FERMA SZABO AGROTEH S.R.L", "cui": "RO33912526", "regCom": "J31/436/2014", "iban": "RO46RZBR0000060017372265", "bank": "Raiffeisen Bank suc", "phone": "0745251094", "representative": "Szabo Adalbert - Adorian CNP 1780422311841", "role": "VÂNZĂTOR", "fullText": "S.C. FERMA SZABO AGROTEH S.R.L. cu sediul în Carastelec, jud. Sălaj, nr.14, cam.2, înmatriculată sub nr. J31/436/2014, înregistrata la Reg. C.C.I. Sălaj, CIF RO33912526, tel./fax. 0745251094, având codul IBAN RO46 RZBR 0000 0600 1737 2265 deschis la Raiffeisen Bank suc. Zalau, reprezentată prin Szabo Adalbert - Adorian CNP 1780422311841, în calitate de VÂNZĂTOR."}, {"name": "S.C. EURO TRANS PRODUCT S.R.L", "cui": "RO23360351", "regCom": "J31/178/2008", "iban": "RO20BRDE320SV07903623200", "bank": "BRD suc", "phone": "0745251094", "representative": "Szabo Adalbert - Adorian CNP 1780422311841", "role": "VÂNZĂTOR", "fullText": "S.C. EURO TRANS PRODUCT S.R.L. cu sediul în Carastelec, jud. Sălaj, nr.14, înmatriculată sub nr. J31/178/2008, înregistrata la Reg. C.C.I. Sălaj, CIF RO23360351, tel./fax. 0745251094, având codul IBAN RO20 BRDE 320S V079 0362 3200 deschis la BRD suc. Zalau, reprezentată prin Szabo Adalbert - Adorian CNP 1780422311841, în calitate de VÂNZĂTOR."}, {"name": "SZABO J BEATA I.I", "cui": "RO32467145", "regCom": "F30/1091/2013", "iban": "RO09BRDE310SV61742903100", "bank": "BRD S", "phone": "0763993635", "representative": "Szabo Beata", "role": "VÂNZĂTOR", "fullText": "SZABO J BEATA I.I. cu sediul în loc. Ser nr.240, jud. Satu Mare, înmatriculată sub nr. F30/1091/2013, înregistrata la Reg. C.C.I. Satu Mare, CIF RO32467145, tel./fax. 0763993635, având codul IBAN RO09 BRDE 310S V617 4290 3100 deschis la BRD S.A., reprezentată prin Szabo Beata administrator, în calitate de VÂNZĂTOR."}, {"name": "SEMAGRI S.R.L", "cui": "RO29106191", "regCom": "J05/1647/2011", "iban": "RomansatBerechiunr", "bank": "Banca Transilvania", "phone": "________________", "representative": "________________", "role": "VÂNZĂTOR", "fullText": "SEMAGRI S.R.L. cu sediul în loc. Sanicolau Roman sat Berechiu nr.165, jud.Bihor, înmatriculată sub nr. J05/1647/2011, înregistrata la Reg. C.C.I. Satu Mare, CIF RO29106191, tel./fax.________________ , având codul IBAN RO70 BTRL 0050 1202 W487 30XX deschis la Banca Transilvania., reprezentată prin ________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "PRIETENIA SOC.AGR.TIREAM", "cui": "RO 4376327", "regCom": "", "iban": "", "bank": "BANCA TRANSILVANIA suc", "phone": "_______", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "PRIETENIA SOC.AGR.TIREAM cu sediul/domiciliul în TIREAM, jud. SATU MARE , STR VEZENDIULUI 311/A , înmatriculată sub nr. HJ3/SA/1993, înregistrata la Reg. C.C.I. , CIF RO 4376327, tel./fax. _______, având codul IBAN RO42BTRL03101202C51517XX_DESCHIS LA BANCA TRANSILVANIA suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "NAGY BARNABA SRL", "cui": "RO11094957", "regCom": "J05/979/1998", "iban": "RO36BRDE050SV02859310500", "bank": "BRD suc", "phone": "_______", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "NAGY BARNABA SRL cu sediul/domiciliul în TARCEA NR. 66, jud. BIHOR, str. _____________ nr. _207/A, înmatriculată sub nr. J05/979/1998, înregistrata la Reg. C.C.I. , CIF RO11094957, tel./fax. _______, având codul IBAN RO36 BRDE 050S V028 5931 0500 deschis la BRD suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "BOCSKAI BIHOR AGRO SRL", "cui": "RO 16131827", "regCom": "J05/198/2004", "iban": "RO51RNCB0035022178070001", "bank": "BCR _ suc", "phone": "_______", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "BOCSKAI BIHOR AGRO SRL cu sediul/domiciliul în SALACEA, jud. BIHOR, str. _____________ nr. _____, înmatriculată sub nr. J05/198/2004 , înregistrata la Reg. C.C.I. , CIF RO 16131827, tel./fax. _______, având codul IBAN RO51 RNCB 0035 0221 7807 0001 deschis la BCR _ suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "ALCONOR COMPANY SRL", "cui": "RO12381480", "regCom": "J05/198/2004", "iban": "RO71BRDE310SV02241863100", "bank": "BRD _ suc", "phone": "_______", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "ALCONOR COMPANY SRL cu sediul/domiciliul în CAREI, jud. SATU MARE, str. ALEXANDRU IOAN CUZA NR.27 , înmatriculată sub nr. J05/198/2004 , înregistrata la Reg. C.C.I. , CIFRO12381480, tel./fax. _______, având codul IBAN RO71 BRDE 310S V022 4186 3100deschis la BRD _ suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "AGRO LEG SRL", "cui": "RO 13357286", "regCom": "J24/1659/2005", "iban": "", "bank": "", "phone": "_______", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "AGRO LEG SRL cu sediul/domiciliul în BAIA MARE, jud. MARAMURES, str. PALTINISULUI 1A , înmatriculată sub nr. J24/1659/2005, înregistrata la Reg. C.C.I. , CIF RO 13357286, tel./fax. _______, având codul IBAN RO83BTRL RONC RT04 3164 3701 la BANCA TRANSILVANIA _ suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "VALEA IERULUI SOC AGR SACUIENI", "cui": "RO3468341", "regCom": "", "iban": "RO90RZBR0000060001478217", "bank": "Raiffeisen suc", "phone": "059/352171", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "VALEA IERULUI SOC AGR SACUIENI cu sediul/domiciliul în Săcuieni, str. Morii nr.34, jud. BIHOR înmatriculată sub nr. ................, înregistrata la Reg. C.C.I. , CIF RO3468341, tel./fax. 059/352171, având codul IBAN RO90 RZBR 0000 0600 0147 8217 deschis la Raiffeisen suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "UNIREA SOC.AGR. BOIU", "cui": "RO 109696", "regCom": "", "iban": "RO80BTRLRONCRT0412080601", "bank": "Banca Transilvania", "phone": "________________", "representative": "________________", "role": "VÂNZĂTOR", "fullText": "UNIREA SOC.AGR. BOIU cu sediul în loc. BOIU NR 439, jud.Bihor, înmatriculată sub nr. HJ36/1992, înregistrata la Reg. C.C.I. Satu Mare, CIF RO 109696 , tel./fax.________________ , având codul IBAN RO80BTRLRONCRT0412080601 deschis la Banca Transilvania, reprezentată prin ________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "NEDROSIMAGRO SRL", "cui": "RO21795252", "regCom": "J05/1320/2007", "iban": "RO05OTPV220000159325RO01", "bank": "OTP Bank Romania", "phone": "________________", "representative": "________________", "role": "VÂNZĂTOR", "fullText": "NEDROSIMAGRO SRL cu sediul în loc. ORADEA STR.AUREL LAZAR NR.11 AP.3, jud.Bihor, înmatriculată sub nr. J05/1320/2007, înregistrata la Reg. C.C.I. Satu Mare, CIF RO21795252 , tel./fax.________________ , având codul IBAN RO05 OTPV 2200 0015 9325 RO01 deschis la OTP Bank Romania, reprezentată prin ________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "KOKA AGRO SRL", "cui": "RO27026878", "regCom": "", "iban": "RO05BRDE050SV82008050500", "bank": "BRD suc", "phone": "___________________________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "KOKA AGRO SRL cu sediul/domiciliul în Tarcea nr. 160, jud. BIHOR înmatriculată sub nr J05/731/2010 înregistrata la Reg. C.C.I. , CIF RO27026878, tel./fax. ___________________________, având codul IBAN RO05 BRDE 050S V820 0805 0500 deschis la BRD suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "VERES CIPRIAN IONUT PFA", "cui": "RO29743313", "regCom": "", "iban": "RO79CECEBH0730RON0623020", "bank": "CEC Bank ag", "phone": "0749768906", "representative": "administrator", "role": "VÂNZĂTOR", "fullText": "VERES CIPRIAN IONUT PFA cu sediul în Chişlaz, jud. Bihor, nr. 90, înmatriculată sub nr. la Reg. C.C.I. Bihor, CIF RO29743313 , tel./fax. 0749768906, avand contul IBAN RO79 CECE BH07 30RO N062 3020 deschis la CEC Bank ag. Decebal Oradea, reprezentată prin administrator în calitate de VÂNZĂTOR."}, {"name": "MOISE A .CRISTIAN PFA", "cui": "RO29477599", "regCom": "F05/2336/2011", "iban": "", "bank": "Raiffeisen Bank ag", "phone": "0745773969", "representative": "Moisa Augustin", "role": "VÂNZĂTOR", "fullText": "MOISE A .CRISTIAN PFA. cu sediul în Balc, str. Petofi Sandor nr. 52, jud. Bihor, înmatriculata sub nr. F05/2336/2011, înregistrata la Reg. C.C.I. Bihor, CIF RO29477599 tel. 0745773969, având codul IBAN RO56 RZBR 0000 0600 1437 1972 deschis la Raiffeisen Bank ag. Marghita, reprezentată prin Moisa Augustin, CNP 1510122311830 , administrator, în calitate de VÂNZĂTOR."}, {"name": "S.C. DERGAVA LAND S.R.L", "cui": "RO45945900", "regCom": "J05/945/2022", "iban": "", "bank": "Banca Transilvania ag", "phone": "0744513034", "representative": "ing. _________________", "role": "VÂNZĂTOR", "fullText": "S.C. DERGAVA LAND S.R.L. cu sediul în Valea lui Mihai, str.Kosuth Lajos, nr.54, jud. Bihor, înmatriculata sub nr. J05/945/2022, înregistrata la Reg. C.C.I. Bihor, CIF RO45945900 tel. 0744513034, având codul RO33BTRLRONCRT0CG4989201 deschis la Banca Transilvania ag. Valea lui Mihai, reprezentată prin ing. _________________, CNP ____________, în calitate de VÂNZĂTOR."}, {"name": "JULA IOAN DOREL", "cui": "", "regCom": "", "iban": "RO08CECESM0208RON0358982", "bank": "CEC Bank", "phone": "", "representative": "JULA IOAN DOREL", "role": "VÂNZĂTOR", "fullText": "JULA IOAN DOREL cu sediul în GHENCI NR.102, jud. Satu Mare , înmatriculata sub nr., înregistrata la Reg. C.C.I. Bihor, CNP 1610713300011 tel. , având codul IBAN RO08 CECE SM02 08RO N035 8982 deschis la CEC Bank , reprezentată prin JULA IOAN DOREL , în calitate de VÂNZĂTOR."}, {"name": "BTK GRUNE HASE SRL", "cui": "", "regCom": "J30/252/2013", "iban": "", "bank": "Banca Romana pentru Dezvoltare", "phone": "_____________", "representative": "______________", "role": "VÂNZĂTOR", "fullText": "BTK GRUNE HASE SRL cu sediul în BELTIUG NR 109, jud. Satu Mare , înmatriculata sub nr. J30/252/2013 , înregistrata la Reg. C.C.I. RO31429461 tel. _____________, având codul IBAN RO89 BRDE 310S V481 9525 3100 deschis la Banca Romana pentru Dezvoltare , reprezentată prin ______________, CNP ___________________, în calitate de VÂNZĂTOR."}, {"name": "S.C. HETEI S.R.L", "cui": "RO665713", "regCom": "J30/244/1992", "iban": "", "bank": "BCR ag", "phone": "0744939699", "representative": "ing. Hetei Laszlo", "role": "VÂNZĂTOR", "fullText": "S.C. HETEI S.R.L. cu sediul în Beltiug, nr. 611, jud. Satu Mare, înmatriculata sub nr. J30/244/1992, înregistrata la Reg. C.C.I. Satu Mare, CIF RO665713 tel. 0744939699, având codul IBAN RO51 RNCB 0226 0122 3509 0001 deschis la BCR ag. Horea, reprezentată prin ing. Hetei Laszlo, în calitate de VÂNZĂTOR."}, {"name": "AGRO TRANS SRL", "cui": "RO21360088", "regCom": "J30/384/2007", "iban": "RO59RNCB0224093870780001", "bank": "Banca Comerciala Romana suc", "phone": "______________", "representative": "________________________", "role": "VÂNZĂTOR", "fullText": "AGRO TRANS SRL cu sediul/domiciliul în Eriu Sincrai , jud. Satu Mare , str. SAT. ERIU SINCRAI NR.234, înmatriculată sub nr. J30/384/2007 , CIF RO21360088 , tel./fax. ______________, având codul IBAN RO59 RNCB 0224 0938 7078 0001 deschis la Banca Comerciala Romana suc./ag.______________________, reprezentată prin ________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "KISS IOSIF AGRO P.F.A", "cui": "RO27800943", "regCom": "F30/1412/2010", "iban": "RO76RNCB0222120263820001", "bank": "BCR ag", "phone": "0740920466", "representative": "Kiss Iosif CNP 1841224303701", "role": "VÂNZĂTOR", "fullText": "KISS IOSIF AGRO P.F.A. cu sediul în Carei, str. Vasile Lucaciu nr.11, jud. Satu Mare, înmatriculată sub nr. F30/1412/2010, înregistrata la Reg. C.C.I. Satu Mare, CIF RO27800943, tel./fax. 0740920466, având codul IBAN RO76 RNCB 0222 1202 6382 0001 deschis la BCR ag. Carei, reprezentată prin Kiss Iosif CNP 1841224303701 în calitate de. în calitate de VÂNZĂTOR."}, {"name": "Soc. Agr. RECOLTA", "cui": "RO2387672", "regCom": "", "iban": "RO11RNCB0222011951040001", "bank": "BCR Carei", "phone": "0261874390", "representative": "ing. Gnandt Ferenc preşedinte CNP 1411201300051", "role": "VÂNZĂTOR", "fullText": "Soc. Agr. RECOLTA cu sediul in Urziceni, jud. Satu Mare, str. Urziceni nr. 438, Hot. Jud nr. 21/SA/91, CIF RO2387672, tel./fax. 0261874390, având contul IBAN RO11 RNCB 0222 0119 5104 0001 deschis la BCR Carei, reprezentat prin ing. Gnandt Ferenc preşedinte CNP 1411201300051, în calitate de VÂNZĂTOR."}, {"name": "TILLINGER I ROBERT JANOS I.I", "cui": "RO37014196", "regCom": "F30/43/2017", "iban": "", "bank": "Banca Comerciala Romana", "phone": "________________", "representative": "________________", "role": "VÂNZĂTOR", "fullText": "TILLINGER I ROBERT JANOS I.I. cu sediul în loc. Capleni NR.520, jud.Satu Mare, înmatriculată sub nr. F30/43/2017, înregistrata la Reg. C.C.I. Satu Mare, CIF RO37014196 , tel./fax.________________ , având codul IBAN RO63 RNCB 0222 1536 8349 0001 deschis la Banca Comerciala Romana, reprezentată prin ________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "S.C. AGRO PARTENER S.R.L", "cui": "RO19004488", "regCom": "J30/859/2006", "iban": "RO85RNCB0222061585430001", "bank": "Banca Comercială S", "phone": "0744379203", "representative": "Bekes Arnold", "role": "VÂNZĂTOR", "fullText": "S.C. AGRO PARTENER S.R.L. cu sediul în Petreşti, jud. Satu Mare, str. Pişcoltului nr. 547, înmatriculată sub nr. J30/859/2006, înregistrata la Reg. C.C.I. Satu Mare, CIF RO19004488, tel./fax. 0744379203, având codul IBAN RO85 RNCB 0222 0615 8543 0001 deschis la Banca Comercială S.A. ag. Carei, reprezentată prin Bekes Arnold administrator CNP 180050130378, în calitate de VÂNZĂTOR."}, {"name": "Societatea agricolă AGROFIEN", "cui": "RO23872816", "regCom": "", "iban": "RO14RNCB0222011950980001", "bank": "BCR ag", "phone": "0261874615", "representative": "ing. Stefan Pop", "role": "VÂNZĂTOR", "fullText": "Societatea agricolă AGROFIEN cu sediul în Foieni, jud. Satu Mare, nr. 434, constituită conform Legii 36, CIF RO23872816, tel./fax. 0261874615, codul IBAN RO14 RNCB 0222 0119 5098 0001 deschis la BCR ag. Carei, reprezentată prin ing. Stefan Pop, în calitate de VÂNZĂTOR."}, {"name": "JAKAB & BEATA S.R.L", "cui": "RO27227103", "regCom": "J30/426/2010", "iban": "RO31BRDE310SV62032493100", "bank": "BRD S", "phone": "0763993635", "representative": "Szabo Beata", "role": "VÂNZĂTOR", "fullText": "JAKAB & BEATA S.R.L. cu sediul în loc. Ser nr.240, jud. Satu Mare, înmatriculată sub nr. J30/426/2010, înregistrata la Reg. C.C.I. Satu Mare, CIF RO27227103, tel./fax. 0763993635, având codul IBAN RO31 BRDE 310S V620 3249 3100 deschis la BRD S.A., reprezentată prin Szabo Beata administrator, în calitate de VÂNZĂTOR."}];

function seedDefaultPartnersIfEmpty() {
  try {
    const row = db.prepare('SELECT COUNT(*) AS c FROM partners WHERE deleted_at IS NULL').get();
    if (row && row.c > 0) return;
    const insert = db.prepare("INSERT INTO partners (data, created_at, updated_at) VALUES (?, datetime('now'), datetime('now'))");
    const tx = db.transaction((items) => {
      for (const p of items) insert.run(JSON.stringify({ ...p, type: 'supplier', source: 'DATE CLIENTI.doc' }));
    });
    tx(DEFAULT_PARTNERS_SEED);
  } catch (err) {
    console.error('Partner seed error:', err.message);
  }
}
seedDefaultPartnersIfEmpty();

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


// ── PARTNERS / FURNIZORI ────────────────────────────────────────────────────
function normalizePartner(partner) {
  const p = partner && typeof partner === 'object' ? { ...partner } : {};
  p.type = p.type || 'supplier';
  p.name = String(p.name || '').trim();
  p.cui = String(p.cui || '').trim();
  p.regCom = String(p.regCom || '').trim();
  p.address = String(p.address || '').trim();
  p.phone = String(p.phone || '').trim();
  p.iban = String(p.iban || '').trim();
  p.bank = String(p.bank || '').trim();
  p.representative = String(p.representative || '').trim();
  p.representativeRole = String(p.representativeRole || 'administrator').trim();
  p.fullText = String(p.fullText || '').trim();
  p.notes = String(p.notes || '').trim();
  if (!p.fullText && p.name) {
    const bits = [
      p.name,
      p.address ? `cu sediul in ${p.address}` : '',
      p.regCom ? `inmatriculata sub nr. ${p.regCom}` : '',
      p.cui ? `CIF ${p.cui}` : '',
      p.phone ? `tel./fax. ${p.phone}` : '',
      p.iban ? `avand codul IBAN ${p.iban}` : '',
      p.bank ? `deschis la ${p.bank}` : '',
      p.representative ? `reprezentata prin ${p.representative} ${p.representativeRole || ''}` : '',
      'in calitate de VANZATOR'
    ].filter(Boolean);
    p.fullText = bits.join(', ') + '.';
  }
  return p;
}

app.get('/api/partners', requireAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT id, data, created_at, updated_at FROM partners WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC').all();
    const partners = rows.map(r => ({ ...safeJsonParse(r.data), id: r.id, _createdAt: r.created_at, _UpdatedAt: r.updated_at }));
    res.json(partners);
  } catch (err) {
    console.error('Partners GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/partners', requireAuth, (req, res) => {
  try {
    const partner = normalizePartner(sanitizeObjectForStorage(req.body));
    if (!partner.name && !partner.fullText) return res.status(400).json({ error: 'Lipseste denumirea furnizorului.' });
    if (!partner.name && partner.fullText) partner.name = partner.fullText.split(',')[0].slice(0, 120).trim();
    const info = db.prepare('INSERT INTO partners (data, created_at, updated_at) VALUES (?, datetime(\'now\'), datetime(\'now\'))').run(JSON.stringify(partner));
    audit(req, 'create', 'partner', info.lastInsertRowid, { partner });
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    console.error('Partners POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/partners/:id', requireAuth, (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const before = db.prepare('SELECT data FROM partners WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!before) return res.status(404).json({ error: 'Not found' });
    const partner = normalizePartner(sanitizeObjectForStorage(req.body));
    db.prepare('UPDATE partners SET data = ?, updated_at = datetime(\'now\') WHERE id = ?').run(JSON.stringify(partner), id);
    audit(req, 'update', 'partner', id, { before: safeJsonParse(before.data), after: partner });
    res.json({ ok: true });
  } catch (err) {
    console.error('Partners PUT error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/partners/:id', requireAuth, (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const info = db.prepare('UPDATE partners SET deleted_at = datetime(\'now\'), deleted_by = ? WHERE id = ? AND deleted_at IS NULL').run(req.session.user || null, id);
    if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
    audit(req, 'soft_delete', 'partner', id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Partners DELETE error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PURCHASE CONTRACTS / CONTRACTE ACHIZITIE ────────────────────────────────
const PURCHASE_PRODUCTS = {
  wheat: {
    label: 'GRAU',
    templateFile: 'GRAU.CTR  2026.docx',
    defaultPeriodText: '01.06.2026 – 31.08.2026',
  },
  corn: {
    label: 'PORUMB',
    templateFile: 'PORUMB contract  2026 .docx',
    defaultPeriodText: '30.11.2026',
  },
  rapeseed: {
    label: 'RAPITA',
    templateFile: 'RAPITA Contract  2026.doc .docx',
    defaultPeriodText: 'iulie-august 2026',
  },
  sunflower: {
    label: 'FLOAREA SOARELUI',
    templateFile: 'FLS .2026_Fls_CVC_sp.docx',
    defaultPeriodText: '01.09.2026 -31.10.2026',
  },
};

const CONTRACT_TEMPLATE_DIRS = [
  path.join(__dirname, 'contract_templates'),
  path.join(DB_DIR, 'contract_templates'),
  path.join(__dirname, 'templates'),
  path.join(DB_DIR, 'templates'),
];

function findContractTemplate(productKey) {
  const spec = PURCHASE_PRODUCTS[productKey];
  if (!spec) throw new Error('Produs invalid.');
  for (const dir of CONTRACT_TEMPLATE_DIRS) {
    const full = path.join(dir, spec.templateFile);
    if (fs.existsSync(full)) return full;
  }
  throw new Error(`Template-ul Word lipseste pentru ${spec.label}. Pune fisierul in folderul contract_templates langa server.js.`);
}

function formatRoDate(value) {
  if (!value) return '';
  const d = new Date(`${value}T12:00:00`);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('ro-RO', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function safeFilenamePart(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'contract';
}

function buildSellerText(contract) {
  if (contract.sellerMode === 'manual') return String(contract.manualSellerFullText || '').trim();
  if (contract.sellerFullText) return String(contract.sellerFullText).trim();
  if (contract.partner && contract.partner.fullText) return String(contract.partner.fullText).trim();
  return '';
}

function validatePurchaseContractPayload(raw) {
  const c = raw && typeof raw === 'object' ? { ...raw } : {};
  c.product = String(c.product || '').trim();
  c.productLabel = PURCHASE_PRODUCTS[c.product]?.label || c.product;
  c.contractNo = String(c.contractNo || '').trim();
  c.contractDate = String(c.contractDate || '').trim();
  c.cropYear = String(c.cropYear || '2026').trim();
  c.quantity = Number(c.quantity);
  c.priceRon = Number(c.priceRon);
  c.parity = String(c.parity || '').trim().toUpperCase();
  c.deliveryPlace = String(c.deliveryPlace || '').trim();
  c.deliveryStart = String(c.deliveryStart || '').trim();
  c.deliveryEnd = String(c.deliveryEnd || '').trim();
  c.paymentTerm = String(c.paymentTerm || '30 zile de la facturare').trim();
  c.notes = String(c.notes || '').trim();
  c.sellerMode = String(c.sellerMode || 'existing');
  c.partnerId = c.partnerId ? Number(c.partnerId) : null;
  c.sellerName = String(c.sellerName || '').trim();
  c.sellerFullText = String(c.sellerFullText || '').trim();
  c.manualSellerFullText = String(c.manualSellerFullText || '').trim();

  if (!PURCHASE_PRODUCTS[c.product]) throw new Error('Produs invalid.');
  if (!c.contractNo) throw new Error('Numarul contractului lipseste.');
  if (!c.contractDate) throw new Error('Data contractului lipseste.');
  if (!c.quantity || c.quantity <= 0) throw new Error('Cantitatea este invalida.');
  if (!c.priceRon || c.priceRon <= 0) throw new Error('Pretul este invalid.');
  if (!['FCA', 'DAP'].includes(c.parity)) throw new Error('Paritatea trebuie sa fie FCA sau DAP.');
  if (!c.deliveryPlace) throw new Error('Locul de livrare trebuie completat manual.');
  const sellerText = buildSellerText(c);
  if (!sellerText) throw new Error('Datele furnizorului lipsesc.');
  c.sellerFullTextFinal = sellerText;
  return c;
}

function xmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlUnescape(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function paragraphText(paragraphXml) {
  const pieces = [];
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = re.exec(paragraphXml))) pieces.push(xmlUnescape(m[1]));
  return pieces.join('');
}

function makeParagraphLike(originalParagraphXml, text) {
  const open = (originalParagraphXml.match(/^<w:p\b[^>]*>/) || ['<w:p>'])[0];
  const pPr = (originalParagraphXml.match(/<w:pPr[\s\S]*?<\/w:pPr>/) || [''])[0];
  const rPr = (originalParagraphXml.match(/<w:rPr[\s\S]*?<\/w:rPr>/) || [''])[0];
  const lines = String(text || '').split(/\r?\n/);
  const runs = lines.map((line, idx) => {
    const br = idx === 0 ? '' : '<w:br/>';
    return `<w:r>${rPr}${br}<w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r>`;
  }).join('');
  return `${open}${pPr}${runs}</w:p>`;
}

function normalizeForMatch(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function deliveryPeriodForContract(contract, spec) {
  if (contract.deliveryStart && contract.deliveryEnd) return `${formatRoDate(contract.deliveryStart)} - ${formatRoDate(contract.deliveryEnd)}`;
  if (contract.deliveryStart) return formatRoDate(contract.deliveryStart);
  if (contract.deliveryEnd) return formatRoDate(contract.deliveryEnd);
  return spec.defaultPeriodText || '';
}

function replaceContractParagraphs(documentXml, contract) {
  const spec = PURCHASE_PRODUCTS[contract.product];
  const qty = String(contract.quantity).replace('.', ',');
  const price = String(contract.priceRon).replace('.', ',');
  const period = deliveryPeriodForContract(contract, spec);
  const sellerText = contract.sellerFullTextFinal;

  return documentXml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (p) => {
    const text = paragraphText(p);
    const n = normalizeForMatch(text);

    if (/^nr\.?\s*_+\s*$/.test(n) || /^nr\.?\s*_+/.test(n)) {
      return makeParagraphLike(p, text.replace(/NR\.\s*_+|NR\s*_+/i, `NR. ${contract.contractNo}`));
    }

    if (n.includes('cu sediul') && n.includes('vanzator') && text.includes('____')) {
      return makeParagraphLike(p, sellerText);
    }

    if (contract.product === 'corn' && n.includes('obiectul contractului priveste')) {
      let out = text;
      out = out.replace(/cantității\s+de\s+_+\s+tone/i, `cantității de ${qty} tone`);
      out = out.replace(/cantitatii\s+de\s+_+\s+tone/i, `cantitatii de ${qty} tone`);
      out = out.replace(/FCA\s*\/\s*DAP/i, contract.parity);
      return makeParagraphLike(p, out);
    }

    if (contract.product === 'corn' && n.startsWith('cantitatea :')) {
      const out = text.replace(/Cantitatea\s*:\s*_+\s*tone/i, `Cantitatea : ${qty} tone`);
      return makeParagraphLike(p, out);
    }

    if (contract.product === 'corn' && n.startsWith('pretul')) {
      const out = text.replace(/Prețul\s+_+/i, `Prețul ${price}`).replace(/Pretul\s+_+/i, `Pretul ${price}`);
      return makeParagraphLike(p, out);
    }

    if (contract.product === 'corn' && n.startsWith('perioada si termenii de livrare')) {
      const out = text.replace(/pana\s+la\s+data\s+de\s+[0-9.]+/i, `pana la data de ${period}`);
      return makeParagraphLike(p, out);
    }

    if (n.includes('art.3') && n.includes('cantitate') && text.includes('____')) {
      let out = text.replace(/_+\s*tone/i, `${qty} tone`);
      out = out.replace(/\bto\b\s*/i, '');
      out = out.replace(/FCA\s*\/\s*DAP/i, contract.parity);
      out = out.replace(/\.FCA/i, ` ${contract.parity}`);
      return makeParagraphLike(p, out);
    }

    if (n.startsWith('pretul este') && text.includes('___')) {
      const out = text.replace(/Prețul\s+este\s+_+/i, `Prețul este ${price}`).replace(/Pretul\s+este\s+_+/i, `Pretul este ${price}`);
      return makeParagraphLike(p, out);
    }

    if (n.startsWith('perioada livrare')) {
      let out = text;
      if (contract.deliveryStart || contract.deliveryEnd) {
        if (contract.product === 'rapeseed') out = out.replace(/iulie\s*-\s*august\s+2026/i, period);
        if (contract.product === 'wheat') out = out.replace(/01\.06\.2026\s*[–-]\s*31\.08\.2026/i, period);
        if (contract.product === 'sunflower') out = out.replace(/01\.09\.2026\s*-\s*31\.10\.2026/i, period);
      }
      return makeParagraphLike(p, out);
    }

    return p;
  });
}

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function readZipEntries(zipBuffer) {
  let eocd = -1;
  for (let i = zipBuffer.length - 22; i >= Math.max(0, zipBuffer.length - 66000); i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('DOCX invalid: lipseste EOCD.');
  const total = zipBuffer.readUInt16LE(eocd + 10);
  let cdOffset = zipBuffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < total; i++) {
    if (zipBuffer.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('DOCX invalid: central directory.');
    const method = zipBuffer.readUInt16LE(cdOffset + 10);
    const compSize = zipBuffer.readUInt32LE(cdOffset + 20);
    const nameLen = zipBuffer.readUInt16LE(cdOffset + 28);
    const extraLen = zipBuffer.readUInt16LE(cdOffset + 30);
    const commentLen = zipBuffer.readUInt16LE(cdOffset + 32);
    const localOffset = zipBuffer.readUInt32LE(cdOffset + 42);
    const name = zipBuffer.slice(cdOffset + 46, cdOffset + 46 + nameLen).toString('utf8');
    if (zipBuffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('DOCX invalid: local header.');
    const localNameLen = zipBuffer.readUInt16LE(localOffset + 26);
    const localExtraLen = zipBuffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = zipBuffer.slice(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    else throw new Error(`DOCX invalid: metoda ZIP neacceptata ${method}.`);
    entries.push({ name, data });
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosTime, dosDate } = dosDateTime();

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const isDir = entry.name.endsWith('/');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
    const method = isDir ? 0 : 8;
    const compressed = method === 0 ? Buffer.alloc(0) : zlib.deflateRawSync(data, { level: 6 });
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(isDir ? 0x10 : 0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centralParts.push(central);

    offset += local.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDir, eocd]);
}

function renderPurchaseContractDocx(contract) {
  const templatePath = findContractTemplate(contract.product);
  const zip = fs.readFileSync(templatePath);
  const entries = readZipEntries(zip);
  const doc = entries.find(e => e.name === 'word/document.xml');
  if (!doc) throw new Error('Template DOCX invalid: lipseste word/document.xml.');
  const xml = doc.data.toString('utf8');
  doc.data = Buffer.from(replaceContractParagraphs(xml, contract), 'utf8');
  return buildZip(entries);
}

app.get('/api/purchase-contracts', requireAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT id, data, created_at, updated_at FROM purchase_contracts WHERE deleted_at IS NULL ORDER BY id DESC').all();
    const contracts = rows.map(r => ({ ...safeJsonParse(r.data), id: r.id, _createdAt: r.created_at, _updatedAt: r.updated_at }));
    res.json(contracts);
  } catch (err) {
    console.error('Purchase contracts GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/purchase-contracts/generate', requireAuth, (req, res) => {
  try {
    const contract = validatePurchaseContractPayload(req.body);
    const trade = {
      product: contract.product,
      crop: contract.cropYear,
      dir: 'long',
      qty: contract.quantity,
      parity: contract.parity,
      loc: contract.deliveryPlace,
      cpty: contract.sellerName || (contract.sellerFullTextFinal.split(',')[0] || '').trim(),
      note: `Generat automat din contract achizitie nr. ${contract.contractNo}${contract.notes ? ' | ' + contract.notes : ''}`,
      ptype: 'fix',
      price: contract.priceRon,
      currency: 'ron',
      date: contract.contractDate,
      transport: 0,
      contractNo: contract.contractNo,
      sourceModule: 'purchase_contracts',
      purchaseContractGenerated: true,
      incomplete: false,
    };
    const tx = db.transaction(() => {
      const tradeInfo = db.prepare('INSERT INTO trades (data, created_at, updated_at) VALUES (?, datetime(\'now\'), datetime(\'now\'))').run(JSON.stringify(trade));
      trade.id = tradeInfo.lastInsertRowid;
      const storedContract = { ...contract, tradeId: trade.id, status: 'generated' };
      const contractInfo = db.prepare('INSERT INTO purchase_contracts (data, created_at, updated_at) VALUES (?, datetime(\'now\'), datetime(\'now\'))').run(JSON.stringify(storedContract));
      const fileName = `${safeFilenamePart(contract.contractNo)}_${safeFilenamePart(contract.productLabel)}_${contractInfo.lastInsertRowid}.docx`;
      const docx = renderPurchaseContractDocx(storedContract);
      fs.writeFileSync(path.join(GENERATED_CONTRACTS_DIR, fileName), docx);
      storedContract.generatedFile = fileName;
      db.prepare('UPDATE purchase_contracts SET data = ?, updated_at = datetime(\'now\') WHERE id = ?').run(JSON.stringify(storedContract), contractInfo.lastInsertRowid);
      return { contractId: contractInfo.lastInsertRowid, tradeId: trade.id, fileName };
    });
    const out = tx();
    audit(req, 'generate', 'purchase_contract', out.contractId, { contractNo: contract.contractNo, tradeId: out.tradeId, product: contract.product, quantity: contract.quantity });
    res.json({ ok: true, contractId: out.contractId, tradeId: out.tradeId, downloadUrl: `/api/purchase-contracts/${out.contractId}/download`, trade });
  } catch (err) {
    console.error('Purchase contract generate error:', err);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/purchase-contracts/:id/download', requireAuth, (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const row = db.prepare('SELECT data FROM purchase_contracts WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const contract = safeJsonParse(row.data, {});
    if (!contract.generatedFile) return res.status(404).json({ error: 'Fisier negasit' });
    const full = path.join(GENERATED_CONTRACTS_DIR, path.basename(contract.generatedFile));
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'Fisier negasit' });
    res.download(full, contract.generatedFile);
  } catch (err) {
    console.error('Purchase contract download error:', err);
    res.status(500).json({ error: err.message });
  }
});


app.patch('/api/purchase-contracts/:id/signed', requireAuth, (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });

    const row = db.prepare('SELECT data FROM purchase_contracts WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const contract = safeJsonParse(row.data, {});
    const signedReturned = !!req.body?.signedReturned;
    contract.signedReturned = signedReturned;
    contract.signedReturnedAt = signedReturned ? new Date().toISOString() : null;
    contract.signedReturnedBy = signedReturned ? (req.session.user || null) : null;

    db.prepare(`UPDATE purchase_contracts SET data = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(contract), id);
    audit(req, signedReturned ? 'mark_signed_returned' : 'unmark_signed_returned', 'purchase_contract', id, { contractNo: contract.contractNo || null });
    res.json({ ok: true, contract: { ...contract, id } });
  } catch (err) {
    console.error('Purchase contract signed update error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/purchase-contracts/:id', requireAuth, (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });

    const row = db.prepare('SELECT data FROM purchase_contracts WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const contract = safeJsonParse(row.data, {});
    const deleteTrade = String(req.query.deleteTrade || '') === '1';
    const tradeId = validateId(contract.tradeId);

    const tx = db.transaction(() => {
      db.prepare(`UPDATE purchase_contracts SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ? AND deleted_at IS NULL`)
        .run(req.session.user || null, id);
      if (deleteTrade && tradeId) {
        db.prepare(`UPDATE trades SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ? AND deleted_at IS NULL`)
          .run(req.session.user || null, tradeId);
      }
    });
    tx();

    try {
      if (contract.generatedFile) {
        const full = path.join(GENERATED_CONTRACTS_DIR, path.basename(contract.generatedFile));
        if (fs.existsSync(full)) fs.unlinkSync(full);
      }
    } catch (fileErr) {
      console.error('Purchase contract file delete warning:', fileErr.message);
    }

    audit(req, 'soft_delete', 'purchase_contract', id, { contractNo: contract.contractNo || null, tradeId: tradeId || null, tradeDeleted: !!(deleteTrade && tradeId) });
    res.json({ ok: true, id, tradeId: tradeId || null, tradeDeleted: !!(deleteTrade && tradeId) });
  } catch (err) {
    console.error('Purchase contract delete error:', err);
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


// ── EMAIL ASSISTANT OPENAI ──────────────────────────────────────────────────
const emailLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Prea multe cereri email. Încearcă din nou imediat.' },
});

function limitText(input, max = 12000) {
  const text = String(input || '').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function extractResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const parts = [];
  for (const item of data?.output || []) {
    for (const c of item?.content || []) {
      if (typeof c?.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('\n').trim();
}

async function callOpenAIEmail({ instructions, userInput }) {
  if (!OPENAI_API_KEY) {
    const err = new Error('OPENAI_API_KEY lipseste din Render Environment.');
    err.status = 500;
    throw err;
  }

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions,
      input: userInput,
      temperature: 0.25,
      max_output_tokens: 1800,
    }),
    signal: AbortSignal.timeout(45000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `OpenAI error ${res.status}`;
    const err = new Error(msg);
    err.status = 502;
    throw err;
  }

  const text = extractResponseText(data);
  if (!text) {
    const err = new Error('OpenAI nu a returnat text.');
    err.status = 502;
    throw err;
  }
  return text;
}

const EMAIL_BASE_INSTRUCTIONS = `
Ești asistent de execuție pentru o firmă românească de trading cereale și oleaginoase.
Lucrezi cu emailuri operaționale despre contracte, livrări, trenuri, camioane, cantități, gări, documente, facturi și instrucțiuni de încărcare.
Nu inventa date, cantități, numere de contract, confirmări sau promisiuni.
Păstrează exact numerele, datele, cantitățile, numele firmelor, locațiile și termenii comerciali.
Scrie clar, profesionist și scurt.
Evită limbajul pompos.
Dacă informația lipsește, cere clarificare.
`;

app.post('/api/email/understand', requireAuth, emailLimiter, async (req, res) => {
  try {
    const mode = String(req.body?.mode || 'explain');
    const text = limitText(req.body?.text);
    if (!text) return res.status(400).json({ error: 'Text lipsă.' });

    let task;
    if (mode === 'translate') {
      task = 'Tradu emailul de mai jos în română, fidel, păstrând structura și termenii operaționali. Nu adăuga comentarii.';
    } else if (mode === 'actions') {
      task = 'Extrage în română acțiunile de făcut din emailul de mai jos. Separă: ce se cere, cine trebuie să răspundă, termene, documente/cantități/contracte menționate, întrebări deschise.';
    } else {
      task = 'Explică emailul de mai jos în română pentru o persoană din execuție care nu vorbește engleză. Include: rezumat scurt, ce trebuie făcut, termeni importanți, riscuri/atenționări și un răspuns recomandat pe scurt.';
    }

    const result = await callOpenAIEmail({
      instructions: `${EMAIL_BASE_INSTRUCTIONS}\n${task}`,
      userInput: text,
    });
    audit(req, 'email_assist', 'email', mode, { mode, chars: text.length });
    res.json({ ok: true, result });
  } catch (err) {
    console.error('Email understand error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/email/draft', requireAuth, emailLimiter, async (req, res) => {
  try {
    const instructionsRo = limitText(req.body?.instructions, 6000);
    const incoming = limitText(req.body?.incoming, 6000);
    const tone = String(req.body?.tone || 'neutral');
    if (!instructionsRo) return res.status(400).json({ error: 'Instrucțiunile lipsesc.' });

    const toneMap = {
      neutral: 'neutral, direct și profesionist',
      polite: 'politicos, cald și profesionist',
      firm: 'ferm, clar și profesionist, fără agresivitate',
      urgent: 'urgent, clar și profesionist, cu cerere concretă de acțiune',
    };

    const result = await callOpenAIEmail({
      instructions: `${EMAIL_BASE_INSTRUCTIONS}\nScrie un email profesional în engleză de business. Ton: ${toneMap[tone] || toneMap.neutral}. Fără explicații în română. Fără markdown. Păstrează emailul scurt și clar. Dacă instrucțiunea în română nu conține suficiente detalii, scrie o variantă prudentă și cere clarificarea necesară în email.`,
      userInput: `${incoming ? `Context email primit:\n${incoming}\n\n` : ''}Instrucțiuni în română pentru răspuns:\n${instructionsRo}`,
    });
    audit(req, 'email_draft', 'email', tone, { tone, instructionChars: instructionsRo.length, hasIncoming: !!incoming });
    res.json({ ok: true, result });
  } catch (err) {
    console.error('Email draft error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── STATIC ───────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Agrotex running on port ${PORT}`));
