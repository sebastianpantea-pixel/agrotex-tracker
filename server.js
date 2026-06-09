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

const DEFAULT_PARTNERS_SEED = [{"name": "SC IGLI & CO SRL", "cui": "RO9824782", "regCom": "J30/664/1997", "iban": "RO63RZBR0000060016900539", "bank": "", "phone": "0261842657", "representative": "", "role": "VANZATOR", "fullText": "SC IGLI & CO SRL cu sediul/domiciliul in Mediesu Aurit str Principala nr 405,jud. Satu Mare,inmatriculata sub nr J30/664/1997,INREGISTRATA LA Reg. CCI Satu Mare,CIF RO9824782 , telefon nr 0261842657 , avand contul banacar IBAN RO63 RZBR 0000 0600 16900539,deschis la____________________________suc./ag____________,reprezentata prin_______________in calitate de VANZATOR."}, {"name": "AGRICULTORUL BIHOREAN COOPERATIVA AGRICOLA", "cui": "RO49923920", "regCom": "C05/2/2024", "iban": "RO62BTRLRONCRT0684496501deschislaBancaTr", "bank": "Banca Transilvania", "phone": "______________", "representative": "Dersidan Vlad Bogdan", "role": "VANZATOR", "fullText": "AGRICULTORUL BIHOREAN COOPERATIVA AGRICOLA cu sediul in loc.Vasad,com Curtuiuseni nr 283,jud Bihor,inmatriculata sub nr C05/2/2024 ,inregistrata la Reg CCI ,CIF RO49923920,tel/fax______________ , avand contul IBAN RO62BTRLRONCRT0684496501 deschis la Banca Transilvania,reprezentata prin Dersidan Vlad Bogdan administrator,in calitate de VANZATOR."}, {"name": "COOPERATIVA AGRICOLA INFRATIREA", "cui": "RO45218120", "regCom": "C05/27/2021", "iban": "", "bank": "", "phone": "", "representative": "________________", "role": "VANZATOR", "fullText": "COOPERATIVA AGRICOLA INFRATIREA cu sediul in loc.Boiu,comuna Ciumeghiu nr 221,jud Bihor,inmatriculata sub nr C05/27/2021 , CIF RO45218120, reprezentata prin ________________ in calitate de VANZATOR."}, {"name": "PINTYE LASZLO LEVENTE PFA", "cui": "RO40723627", "regCom": "F30/102/2019", "iban": "RO53CECEB00030RON0487236deschislaCECBank", "bank": "CEC Bank", "phone": "________________", "representative": "________________", "role": "VÂNZĂTOR", "fullText": "PINTYE LASZLO LEVENTE PFA cu sediul în loc. Livada str. VICTORIEI nr.77, jud.Satu Mare, înmatriculată sub nr. F30/102/2019, înregistrata la Reg. C.C.I. Satu Mare, CIF RO40723627, tel./fax.________________ , având codul IBAN RO53CECEB00030RON0487236 deschis la CEC Bank , reprezentată prin ________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "FITOFARM AGRODAN S.R.L", "cui": "RO43567387", "regCom": "J30/58/2021", "iban": "", "bank": "_____________ suc", "phone": "______________", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "FITOFARM AGRODAN S.R.L. cu sediul/domiciliul în ROSIORI, NR.27B JUD. SATU MARE , J30/58/2021 CIF RO43567387, tel./fax ______________, având codul IBAN _______________________ deschis la _____________ suc./ag. , reprezentată prin _________________ administrator, în calitate de VÂNZĂTOR ."}, {"name": "NAGY Z. ZOLTAN I.I", "cui": "RO19730618", "regCom": "F05/291/2006", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________, CNP ________________", "role": "VÂNZĂTOR", "fullText": "NAGY Z. ZOLTAN I.I. cu sediul în JUD. BIHOR, SAT VAIDA COM. ROSIORI, NR.184, jud.Bihor , înmatriculata sub nr. F05/291/2006 la Reg.C.C.I. Bihor, CIF RO19730618, reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR ."}, {"name": "KASZONI ELEK CSONGOR I.I", "cui": "RO27896752", "regCom": "F05/53/2011", "iban": "RO75BTRL00501202223492XX", "bank": "Banza Transilvania reprezentata prin KASZONI ELEK CSONGOR administrator", "phone": "", "representative": "KASZONI ELEK CSONGOR", "role": "VANZATOR", "fullText": "KASZONI ELEK CSONGOR I.I cu sediul/domiciliul in Cubulcut STR.PRINCIPALA, NR.162 , Jud. BIHOR, inmatriculata sub nr. F05/53/2011 , inregistrata la Reg. C.C.I. BIHOR, CIF RO27896752, telefon nr. : , avand codul IBAN RO75BTRL00501202223492XX, deschis la Banza Transilvania reprezentata prin KASZONI ELEK CSONGOR administrator , in calitate de VANZATOR."}, {"name": "BOITOR L ADRIANA I.I", "cui": "RO41890607", "regCom": "F30/557/2019", "iban": "RO16RZBR0000060021770785deschislaRaiffeis", "bank": "Raiffeisen Bank", "phone": "________________", "representative": "________________", "role": "VÂNZĂTOR", "fullText": "BOITOR L ADRIANA I.I cu sediul în loc. Mediesu Aurit DIN JOS NR.583, jud.Satu Mare, înmatriculată sub nr. F30/557/2019, înregistrata la Reg. C.C.I. Satu Mare, CIF RO41890607, tel./fax.________________ , având codul IBAN RO16RZBR0000060021770785 deschis la Raiffeisen Bank., reprezentată prin ________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "TOTH ISTVAN AGROTIT I.I", "cui": "RO20869823", "regCom": "F05/1455/2006", "iban": "RO88BTRLRONCRT0243208501deschislaBancaTr", "bank": "Banca Transilvania", "phone": "____________________", "representative": "Toth Istvan", "role": "VÂNZĂTOR", "fullText": "TOTH ISTVAN AGROTIT I.I. , cu sediul in SAT. TAMASAU NR.92, jud. Bihor, înregistrata la C.C.I. Bihor, sub nr. F05/1455/2006, CIF RO20869823, tel./fax.____________________, având contul IBAN RO88BTRLRONCRT0243208501 deschis la Banca Transilvania, reprezentată prin Toth Istvan administrator, în calitate de VÂNZĂTOR ."}, {"name": "MADACSI GABOR", "cui": "", "regCom": "", "iban": "RO98CECESM0102RON0307833", "bank": "CEC BANK", "phone": "", "representative": "", "role": "VÂNZĂTOR", "fullText": "MADACSI GABOR cu sediul in GHENCI nr.332, Jud. Satu Mare, inmatriculata sub nr. , inregistrata la Reg. C.C.I. , CIF CNP 1700826300023, telefon , avand codul IBAN RO98CECESM0102RON0307833, deschis la CEC BANK, în calitate de VÂNZĂTOR ."}, {"name": "DELTIS SRL", "cui": "RO23322161", "regCom": "J05/462/2008", "iban": "RO03BTRL00501202E46507XX", "bank": "Banza Transilvania reprezentata prin ________________administrator", "phone": "", "representative": "________________", "role": "VANZATOR", "fullText": "DELTIS SRL cu sediul/domiciliul in Valea lui Mihai STR. KOSSUTH LAJOS, NR.66 , Jud. BIHOR, inmatriculata sub nr. J05/462/2008 , inregistrata la Reg. C.C.I. BIHOR, CIF RO23322161, telefon nr. : , avand codul IBAN RO03BTRL00501202E46507XX, deschis la Banza Transilvania reprezentata prin ________________administrator , in calitate de VANZATOR."}, {"name": "TARCSA NORBERT I.I", "cui": "RO44126583", "regCom": "F30/189/2021", "iban": "RO40BRDE310SV73810053100deschislaBancaRo", "bank": "Banca Romana pentru Dezvoltare suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "TARCSA NORBERT I.I. cu sediul/domiciliul în COM. CAMIN, NR.135, jud. Satu Mare, înmatriculată sub nr. F30/189/2021, înregistrata la Reg. C.C.I. ____________________, CIF RO44126583 , tel./fax. ______________, având codul IBAN RO40BRDE310SV73810053100 deschis la Banca Romana pentru Dezvoltare suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "SALAJAN JESSICA-KATALIN I.I", "cui": "RO49466993", "regCom": "F05/76/2024", "iban": "RO70BTRLRONCRT0CQ5526901deschislaBancaTr", "bank": "Banca Transilvania", "phone": "", "representative": "Salajan Jessica-Katalin", "role": "VANZATOR", "fullText": "SALAJAN JESSICA-KATALIN I.I. . cu sediul în Valea lui Mihai nr. 17, jud. Bihor, înmatriculata sub nr. F05/76/2024, înregistrata la Reg. C.C.I. , CIF RO49466993 , având codul IBAN RO70BTRLRONCRT0CQ5526901 deschis la Banca Transilvania , reprezentată prin Salajan Jessica-Katalin, , în calitate de VANZATOR."}, {"name": "AGRITEHNICA MARA SRL", "cui": "RO30227197", "regCom": "J24/437/2012", "iban": "RO16BTRLRONCRT0332802101deschislaBancaTr", "bank": "Banca Transilvania suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "AGRITEHNICA MARA SRL cu sediul/domiciliul în Miresu Mare STR.PRINCIPALA, NR.210E , jud. Maramures, înmatriculată sub nr. J24/437/2012, înregistrata la Reg. C.C.I. ____________________, CIF RO30227197 , tel./fax. ______________, având codul IBAN RO16BTRLRONCRT0332802101 deschis la Banca Transilvania suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "SC PROD SERV ECO LIVADA SRL", "cui": "27324998", "regCom": "J30/488/2010", "iban": "", "bank": "Banca", "phone": "______________", "representative": "", "role": "VÂNZĂTOR", "fullText": "SC PROD SERV ECO LIVADA SRL cu sediul/domiciliul în ………………………………………. , jud. Satu Mare , înmatriculată sub nr. J30/488/2010 , CIF 27324998 , tel./fax. ______________, având codul ............................................................................ ........................................... deschis la Banca .........................................................................., reprezentată prin .................................................. administrator, în calitate de VÂNZĂTOR."}, {"name": "SZOROS GYULA PFA", "cui": "RO23501736", "regCom": "F05/417/2008", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________, CNP ________________", "role": "VÂNZĂTOR", "fullText": "SZOROS GYULA PFA cu sediul în SAT. VAIDA NR.173 ROSIORI, jud.Bihor , înmatriculata sub nr. F05/417/2008 la Reg.C.C.I. Bihor, CIF RO23501736, reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "DUDAS ATTILA CSABA I.I", "cui": "RO34606240", "regCom": "F05/1136/2015", "iban": "RO60CECEBH3530RON0766535deschislaCECBANK", "bank": "CEC BANK Satu Mare", "phone": "", "representative": "DUDAS ATTILA CSABA", "role": "VÂNZĂTOR", "fullText": "DUDAS ATTILA CSABA I.I cu sediul în Sacueni str. IOSIF VULCAN NR.24, jud. Bihor, înmatriculată sub nr. F05/1136/2015 , înregistrata la Reg. C.C.I. Satu Mare, CIF RO34606240, , având codul IBAN RO60CECEBH3530RON0766535 deschis la CEC BANK Satu Mare, reprezentată prin DUDAS ATTILA CSABA administrator, în calitate de VÂNZĂTOR."}, {"name": "BOROS ISTVAN I.I", "cui": "RO27578538", "regCom": "F05/2278/2010", "iban": "RO39CECEBH3530RON0796110deschislaCECBANK", "bank": "CEC BANK Satu Mare", "phone": "", "representative": "BOROS ISTVAN", "role": "VÂNZĂTOR", "fullText": "BOROS ISTVAN I.I cu sediul în Sacueni str.MORII NR.50 Mărtineşti, jud. Bihor, înmatriculată sub nr. F05/2278/2010 , înregistrata la Reg. C.C.I. Satu Mare, CIF RO27578538, , având codul IBAN RO39CECEBH3530RON0796110 deschis la CEC BANK Satu Mare, reprezentată prin BOROS ISTVAN administrator, în calitate de VÂNZĂTOR."}, {"name": "DUNCA ANUTA-MARIA", "cui": "", "regCom": "", "iban": "RO91BTRLRONCRT0664448601deschislaBankaTr", "bank": "Banka Transilvania suc", "phone": "______________", "representative": "________________________", "role": "VÂNZĂTOR", "fullText": "DUNCA ANUTA-MARIA cu sediul/domiciliul în Feresti nr.12 , jud. Maramures , înmatriculată sub nr., CNP 2980907244506 , tel./fax. ______________, având codul IBAN RO91BTRLRONCRT0664448601 deschis la Banka Transilvania suc./ag.______________________, reprezentată prin ________________________ administrator, în calitate de VÂNZĂTOR ."}, {"name": "POP ALEXANDRU AGRICULTURA II", "cui": "", "regCom": "F30/131/2013", "iban": "RO31265385tel", "bank": "CEC Bank", "phone": "_____________", "representative": "", "role": "VÂNZĂTOR", "fullText": "POP ALEXANDRU AGRICULTURA II cu sediul în ERIU SANCRAI JUD. SATU MARE, , înmatriculata sub nr. F30/131/2013 , înregistrata la Reg. C.C.I. RO31265385 tel. _____________, având codul IBAN RO38CECESM0930RON0415124 deschis la CEC Bank, reprezentată prin_________________________, în calitate de VÂNZĂTOR ."}, {"name": "AGROALI SRL", "cui": "RO23252147", "regCom": "J05/363/2008", "iban": "RO23252147tel", "bank": "Banca Transilvania", "phone": "", "representative": "", "role": "VANZATOR", "fullText": "AGROALI SRL cu sediul în CHIRALEU NR.149, jud. BIHOR, înmatriculata sub nr. J05/363/2008, înregistrata la Reg. C.C.I. Bihor, CIF RO23252147 tel. , având codul IBAN RO84 BTRL 0050 1202 K212 64XX deschis la Banca Transilvania , reprezentată prin , în calitate de VANZATOR."}, {"name": "DUNCA IONUT PAUL PFA", "cui": "", "regCom": "F30/732/2012", "iban": "RO30194340tel", "bank": "Banca Comerciala Romana", "phone": "_____________", "representative": "DUNCA IONUT", "role": "VÂNZĂTOR", "fullText": "DUNCA IONUT PAUL PFA cu sediul în JUD. SATU MARE, SAT POMI COM. POMI, POMI, NR.374 , înmatriculata sub nr. F30/732/2012 , înregistrata la Reg. C.C.I. RO30194340 tel. _____________, având codul IBAN RO29RNCB0221151615970001 deschis la Banca Comerciala Romana , reprezentată prin DUNCA IONUT , în calitate de VÂNZĂTOR ."}, {"name": "HAIDU A ATTILA I.I", "cui": "RO34242017", "regCom": "F30/198/2015", "iban": "", "bank": "_____________ suc", "phone": "______________", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "HAIDU A ATTILA I.I cu sediul/domiciliul în SAT IOJIB,COM. MEDIESU AURIT NR 279 JUD. SATU MARE , F30/198/2015 CIF RO34242017, tel./fax ______________, având codul IBAN _______________________ deschis la _____________ suc./ag. , reprezentată prin _________________ administrator, în calitate de VÂNZĂTOR ."}, {"name": "GODER ATTILA SANDOR I I", "cui": "RO26901931", "regCom": "F05/1036/2010", "iban": "", "bank": "", "phone": "0766404002", "representative": "Goder Attila Sandor -", "role": "VÂNZĂTOR", "fullText": "GODER ATTILA SANDOR I I cu sediul/domiciliul în LOC. CUBULCUT NR.221, jud. Bihor , nr.15, înmatriculată sub nr. F05/1036/2010, CIF RO26901931 , tel./fax 0766404002 , reprezentată prin Goder Attila Sandor -administrator, în calitate de VÂNZĂTOR."}, {"name": "KRASNATAL SOC.AGR. CAPLENI", "cui": "", "regCom": "", "iban": "RO17RZBR0000060001473420deschislaRaif", "bank": "Raiffeisen Bank", "phone": "_____________", "representative": "______________, CNP ___________________", "role": "VÂNZĂTOR", "fullText": "KRASNATAL SOC.AGR. CAPLENI cu sediul în Carei STR.PRINCIPALA, 125, jud. Satu Mare , înmatriculata sub nr. J_________, înregistrata la Reg. C.C.I. RO 5674046 tel. _____________, având codul IBAN RO17 RZBR 0000 0600 0147 3420 deschis la Raiffeisen Bank , reprezentată prin ______________, CNP ___________________, în calitate de VÂNZĂTOR."}, {"name": "BIRO ST TIBOR I.I", "cui": "", "regCom": "F30/567/2014", "iban": "RO33593044tel", "bank": "CEC BanK", "phone": "_____________", "representative": "", "role": "VÂNZĂTOR", "fullText": "BIRO ST TIBOR I.I. cu sediul în Livada ,STR. TRANDAFIRILOR, NR.16 jud. satu Mare , înmatriculata sub nr. F30/567/2014, înregistrata la Reg. C.C.I. RO33593044 tel. _____________, având codul IBAN RO67CECESM0830RON0445687 deschis la CEC BanK, , în calitate de VÂNZĂTOR ."}, {"name": "COOP AGR AGROHOM COMPANY", "cui": "RO50210645", "regCom": "C05/4/2024", "iban": "RO50210645tel", "bank": "Banca Transilvania", "phone": "0743648021", "representative": "____________________", "role": "VÂNZĂTOR", "fullText": "COOP AGR AGROHOM COMPANY cu sediul în Valea lui Mihai str.FERMA 13 , jud. Bihor, înmatriculata sub nr. C05/4/2024, înregistrata la Reg. C.C.I. Bihor, CIF RO50210645 tel. 0743648021, având codul IBAN RO41BTRLRONCRT0686284201 deschis la Banca Transilvania , reprezentată prin ____________________, în calitate de VÂNZĂTOR ."}, {"name": "GYORI EMERIC", "cui": "", "regCom": "", "iban": "", "bank": "Banca _______________", "phone": "_____________", "representative": "____________________", "role": "VÂNZĂTOR", "fullText": "GYORI EMERIC cu sediul în Vaida nr.6 , jud. Bihor, înmatriculata sub nr. , înregistrata la Reg. C.C.I. Bihor, CIF CNP 1670818054788 tel. _____________, având codul IBAN _________________________ deschis la Banca _______________ , reprezentată prin ____________________, în calitate de VÂNZĂTOR ."}, {"name": "SZILAGYI LAJOS", "cui": "", "regCom": "", "iban": "", "bank": "Banca _______________", "phone": "_____________", "representative": "____________________", "role": "VÂNZĂTOR", "fullText": "SZILAGYI LAJOS cu sediul în COM. ROSIORI, SAT.VAIDA NR.138 , jud. Bihor, înmatriculata sub nr. , înregistrata la Reg. C.C.I. Bihor, CIF CNP 1790403054672 tel. _____________, având codul IBAN _________________________ deschis la Banca _______________ , reprezentată prin ____________________, în calitate de VÂNZĂTOR ."}, {"name": "GAL FERENCZ ANDRAS", "cui": "", "regCom": "", "iban": "RO87CECEBH3508RON0580624suc", "bank": "", "phone": "_______", "representative": "", "role": "VÂNZĂTOR", "fullText": "GAL FERENCZ ANDRAS cu sediul/domiciliul în JUD. BIHOR, SAT. SALACEA, COM. SALACEA NR.274 , înmatriculată sub nr , înregistrata la Reg. C.C.I. , CIF CNP1760203052861, tel./fax. _______, având codul IBAN RO87CECEBH3508RON0580624_ suc./ag.CEC Bank, în calitate de VÂNZĂTOR."}, {"name": "ARDELEAN IOAN NORBERT PFA", "cui": "RO43330886", "regCom": "F30/481/2020", "iban": "RO07BTRLRONCRT0CE5401101deschislaBancaTr", "bank": "Banca Transilvania suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "ARDELEAN IOAN NORBERT PFA cu sediul/domiciliul în ORASU NOU-VII, NR.11/A , jud. Satu Mare, str. str. Plopilor, nr. 1, înmatriculată sub nr. F30/481/2020, înregistrata la Reg. C.C.I. _____, CIF RO43330886 , tel./fax. ______________, având codul IBAN RO07BTRLRONCRT0CE5401101 deschis la Banca Transilvania suc./ag.______________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "CRISHIR VIISOARA COOPERATIVA AGRICOLA", "cui": "48704469", "regCom": "C05/11/2023", "iban": "RO05BTRLRONCRT0675092601deschislaBANCATr", "bank": "BANCA Transilvania", "phone": "0744208672", "representative": "Chereji Bianca", "role": "VANZATOR", "fullText": "CRISHIR VIISOARA COOPERATIVA AGRICOLA cu sediul în Viisoara, nr. 179, jud. Bihor, înmatriculata sub nr. C05/11/2023 la Reg. C.C.I. Bihor, CIF 48704469, tel. 0744208672, având codul IBAN RO05BTRLRONCRT0675092601 deschis la BANCA Transilvania, reprezentată prin Chereji Bianca, în calitate de VANZATOR."}, {"name": "APAN IOANA FLORICA I.I", "cui": "RO32049070", "regCom": "F30/797/2013", "iban": "RO30CECESM1230RON0415715deschislaCECBank", "bank": "CEC Bank Transilvania suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "APAN IOANA FLORICA I.I. cu sediul/domiciliul în APA 567 CP447015 , jud. Satu Mare , înmatriculată sub nr. F30/797/2013 , înregistrata la Reg. C.C.I.__________________, CIF RO32049070 , tel./fax. ______________, având codul IBAN RO30CECESM1230RON0415715 deschis la CEC Bank Transilvania suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "POP LUCIAN VALENTIN I.I", "cui": "RO 35462231", "regCom": "F30/14/2016", "iban": "RO60BTRLRONCRT0336180401deschislaBanc", "bank": "Banca Transilvania suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "POP LUCIAN VALENTIN I.I. cu sediul/domiciliul în DUMBRAVA 143/A , jud. Satu Mare , înmatriculată sub nr. F30/14/2016 , înregistrata la Reg. C.C.I.__________________, CIF RO 35462231 , tel./fax. ______________, având codul IBAN RO60 BTRL RONC RT03 3618 0401 deschis la Banca Transilvania suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR ."}, {"name": "POP DORIN LUCIAN I.I", "cui": "RO 25293070", "regCom": "F30/268/2009", "iban": "RO61BTRLRONCRT0243797001deschislaBancaTr", "bank": "Banca Transilvania suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "POP DORIN LUCIAN I.I. cu sediul/domiciliul în DUMBRAVA 143/A , jud. Satu Mare , înmatriculată sub nr. F30/268/2009 , înregistrata la Reg. C.C.I.__________________, CIF RO 25293070 , tel./fax. ______________, având codul IBAN RO61BTRLRONCRT0243797001 deschis la Banca Transilvania suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR ,."}, {"name": "AGRIVITA PROD SRL", "cui": "RO11094973", "regCom": "J05/760/1998", "iban": "RO11094973tel", "bank": "Banca Transilvania", "phone": "0766740312", "representative": "_____________________", "role": "VÂNZĂTOR", "fullText": "AGRIVITA PROD SRL cu sediul în SAT. GHIORAC NR.77 jud.Bihor, înmatriculata sub nr. J05/760/1998, înregistrata la Reg. C.C.I. Bihor, CIF RO11094973 tel. 0766740312, având codul IBAN _ RO29BTRLRONCRT0444761401 deschis la Banca Transilvania , reprezentată prin _____________________, în calitate de VÂNZĂTOR."}, {"name": "KIND EMANUEL I.I", "cui": "RO47653642", "regCom": "F30/102/2023", "iban": "", "bank": "suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "KIND EMANUEL I.I. cu sediul/domiciliul în Capleni NR.321, jud. Satu Mare, înmatriculată sub nr. F30/102/2023 , înregistrata la Reg. C.C.I. _____, CIF RO47653642 , tel./fax. ______________, având codul IBAN deschis la suc./ag.______________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR ."}, {"name": "KIND KLARISZA I.I", "cui": "RO29457621", "regCom": "", "iban": "RO03RZBR0000060014223740deschislaRaif", "bank": "Raiffeisen Bank suc", "phone": "______________", "representative": "KIND KLARISZA", "role": "VÂNZĂTOR", "fullText": "KIND KLARISZA I.I cu sediul/domiciliul în CAPLENI NR.321 , jud. Satu Mare , înmatriculată sub nr. F30/1331/15.12.2011 , CIF RO29457621 , tel./fax. ______________, având codul IBAN RO03 RZBR 0000 0600 1422 3740 deschis la Raiffeisen Bank suc./ag.______________________, reprezentată prin KIND KLARISZA administrator, în calitate de VÂNZĂTOR."}, {"name": "RATYIS DOREL VASILE", "cui": "", "regCom": "", "iban": "", "bank": "", "phone": "", "representative": "", "role": "VÂNZĂTOR", "fullText": "RATYIS DOREL VASILE cu sediul în loc. Dumbrava nr.140 , jud. Satu Mare , cu nr. CNP 1761126302048 , în calitate de VÂNZĂTOR."}, {"name": "TRANS DAGRO FARM S.R.L", "cui": "RO49506974", "regCom": "J24/172/2024", "iban": "RO49506974tel", "bank": "BRD Baia Mare", "phone": "0742799884", "representative": "Dragos Gabriel Vasile", "role": "VÂNZĂTOR", "fullText": "TRANS DAGRO FARM S.R.L. cu sediul Finteusu Mare, Com. Somcuta jud. Maramures înmatriculată sub nr. J24/172/2024 înregistrata la Reg. Comertului Maramures CIF RO49506974 tel. 0742799884 având contul RO40BRDE250SV26048332500 deschis la BRD Baia Mare, reprezentată prin Dragos Gabriel Vasile, administrator, în calitate de VÂNZĂTOR."}, {"name": "VAS ROBERT CEREALE PFA", "cui": "RO23858616", "regCom": "F30/425/2008", "iban": "", "bank": "Raiffeisen Bank suc", "phone": "______________", "representative": "_______________________________________", "role": "VÂNZĂTOR", "fullText": "VAS ROBERT CEREALE PFA cu sediul/domiciliul în LOC. CAPLENI NR.459B , înmatriculată sub nr. F30/425/2008, înregistrata la Reg. C.C.I. _____, CIF RO23858616 , tel./fax. ______________, având codul IBAN deschis la Raiffeisen Bank suc./ag.______________, reprezentată prin _______________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "AGRASINED 2013 SRL , Iojib nr. 364", "cui": "RO31250201", "regCom": "J30/150/2013", "iban": "RO16BTRLRONCRT0204791201deschislaBanc", "bank": "Banca Transilvania", "phone": "______________________", "representative": "____________________________", "role": "VÂNZĂTOR", "fullText": "AGRASINED 2013 SRL , Iojib nr. 364, înregistrata la C.C.I. ____________, sub nr. J30/150/2013 , CIF RO31250201 , tel./fax. ______________________, având contul IBAN RO16 BTRL RONC RT02 0479 1201 deschis la Banca Transilvania, reprezentată prin ____________________________ administrator, calitate de VÂNZĂTOR."}, {"name": "VLAD DRUTA AGRO S.R.L", "cui": "RO36713765", "regCom": "J31/574/2016", "iban": "RO78BTRLRONCRT0372670701deschislaBancaTr", "bank": "Banca Transilvania_suc", "phone": "______________", "representative": "________________________", "role": "VÂNZĂTOR", "fullText": "VLAD DRUTA AGRO S.R.L. cu sediul/domiciliul în Motis , jud. Salaj , înmatriculată sub nr. J31/574/2016 , CIF RO36713765 , tel./fax. ______________, având codul IBAN RO78BTRLRONCRT0372670701 deschis la Banca Transilvania_suc./ag._____________________, reprezentată prin ________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "S.C. AGRO LEND S.R.L", "cui": "RO21012334", "regCom": "J30/198/2007", "iban": "RO31BTRL03101202D37287XXdeschislaBanc", "bank": "Banca Transilvania suc", "phone": "0741045025", "representative": "", "role": "VÂNZĂTOR", "fullText": "S.C. AGRO LEND S.R.L. cu sediul în Lazuri, str. Principală nr. 333, înreg la C.C.I. Satu Mare sub nr. J30/198/2007, CIF RO21012334, tel./fax. 0741045025, având codul IBAN RO31 BTRL 0310 1202 D372 87XX deschis la Banca Transilvania suc. Satu Mare, reprezentată de Popovici Mihai administrator în calitate de VÂNZĂTOR ."}, {"name": "BARTA BELA BENJAMIN PFA", "cui": "RO37020007", "regCom": "F05/135/2017", "iban": "RO69CECEBH3530RON0810314deschislaCECBank", "bank": "CEC Bank suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "BARTA BELA BENJAMIN PFA cu sediul/domiciliul în Sacueni str OLOSIG .64 , jud. Bihor, înmatriculată sub nr. F05/135/2017, înregistrata la Reg. C.C.I. _____, CIF RO37020007 , tel./fax. ______________, având codul IBAN RO69CECEBH3530RON0810314 deschis la CEC Bank suc./ag.______________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR ."}, {"name": "NAGY F. REBEKA PFA", "cui": "RO44799393", "regCom": "F31/591/2021", "iban": "RO96RNCB0215170647010001deschislaBancaCo", "bank": "Banca Comercial Romana suc", "phone": "______________", "representative": "________________________", "role": "VÂNZĂTOR", "fullText": "NAGY F. REBEKA PFA cu sediul/domiciliul în JUD. SALAJ, LOC. ULCIUG ORS. CEHU SILVANIEI, ULCIUG, NR.246 , înmatriculată sub nr. F31/591/2021 , CIF RO44799393 , tel./fax. ______________, având codul IBAN RO96RNCB0215170647010001 deschis la Banca Comercial Romana suc./ag._____________________, reprezentată prin ________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "PETER ADRIANA ANA I.I", "cui": "RO 109696", "regCom": "", "iban": "RO60BTRLRONCRT0418611001deschislaBancaTr", "bank": "Banca Transilvania", "phone": "________________", "representative": "________________", "role": "VÂNZĂTOR", "fullText": "PETER ADRIANA ANA I.I. cu sediul în loc. CIUMEGHIU SAT.BOIU NR.CF50237, C14, jud.Bihor, înmatriculată sub nr. HJ36/1992, înregistrata la Reg. C.C.I. Satu Mare, CIF RO 109696 , tel./fax.________________ , având codul IBAN RO60BTRLRONCRT0418611001 deschis la Banca Transilvania, reprezentată prin ________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "TARCZA TIBERIU GABRIEL I.I", "cui": "RO47618874", "regCom": "F05/287/2023", "iban": "RO47618874tel", "bank": "Banca Romana pentru Dezvoltare", "phone": "0740938243", "representative": "", "role": "VÂNZĂTOR", "fullText": "TARCZA TIBERIU GABRIEL I.I., cu sediul in JUD. BIHOR, SAT SIMIAN COM. SIMIAN, SIMIAN, NR.935 , înregistrata la C.C.I. Bihor, sub nr. F05/287/2023, CIF RO47618874 tel./fax. 0740938243, având contul IBAN RO52BRDE050SV12143830500 deschis la Banca Romana pentru Dezvoltare , reprezentată prin__________________________________________ administrator, în calitate de VÂNZĂTOR ."}, {"name": "TUR AGRAR SRL", "cui": "RO21061957", "regCom": "J30/227/2007", "iban": "RO64BTRL03101202474808XXdeschislaBancaTr", "bank": "Banca Transilvania", "phone": "0740938243", "representative": "____________", "role": "VÂNZĂTOR", "fullText": "TUR AGRAR SRL, cu sediul in Turulung, jud. Satu Mare, str. Principala nr. 114L, înregistrata la C.C.I. Satu Mare, sub nr. J30/227/2007, CIF RO21061957, tel./fax. 0740938243, având contul IBAN RO64BTRL03101202474808XX deschis la Banca Transilvania, reprezentată prin ____________ administrator, în calitate de VÂNZĂTOR ."}, {"name": "DEMETER BALINT JOZSEF PFA", "cui": "RO34153718", "regCom": "F30/134/2015", "iban": "RO31CECESM1230RON0455758deschislaCECBank", "bank": "CEC Bank", "phone": "0746688217", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "DEMETER BALINT JOZSEF PFA cu sediul în APA, NR.496 jud. SATU MARE, înmatriculată sub nr. F30/134/2015 la Reg. C.C.I. Satu Mare, CIF RO34153718, tel./fax. 0746688217, avand contul IBAN RO31CECESM1230RON0455758 deschis la CEC Bank , reprezentată prin _________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "RATYIS MIHALY VIOREL I.I", "cui": "RO18872924", "regCom": "F30/616/2006", "iban": "RO59CECESM0130RON0367964deschislaCEC", "bank": "CEC Bank", "phone": "0742762217", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "RATYIS MIHALY VIOREL I.I cu sediul în Dumbrava jud. SATU MARE, nr.111 , înmatriculată sub nr. F30/616/2006 la Reg. C.C.I. Satu Mare, CIF RO18872924, tel./fax. 0742762217, avand contul IBAN RO59 CECE SM01 30RO N036 7964 deschis la CEC Bank , reprezentată prin _________________ administrator, în calitate de VÂNZĂTOR ."}, {"name": "AGRIND SINCRAI SRL", "cui": "RO15197009", "regCom": "J30/94/2003", "iban": "RO19BTRL03101202E29364XXdeschislaBancaTr", "bank": "Banca Transilvania", "phone": "0744764180/074311612", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "AGRIND SINCRAI SRL cu sediul în JUD. SATU MARE, SAT ERIU SANCRAI COM. CRAIDOROLT, FOSTA SECTIE MECANIZARE , înmatriculată sub nr. J30/94/2003 la Reg. C.C.I. Satu Mare, CIF RO15197009, tel./fax. 0744764180/074311612, avand contul IBAN RO19BTRL03101202E29364XX deschis la Banca Transilvania , reprezentată prin _________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "KIND ZSOLT I.I", "cui": "RO 35309492", "regCom": "F30/743/2015", "iban": "RO35309492tel", "bank": "", "phone": "_________________", "representative": "________________________", "role": "VÂNZĂTOR", "fullText": "KIND ZSOLT I.I. cu sediul CAPLENI, NR.512/B, jud. Satu Mare, înmatriculată sub nr. F30/743/2015 , înregistrata la Reg. Comertului Satu Mare , CIF RO 35309492 tel. _________________, având contul deschis la , reprezentată prin ________________________, în calitate de VÂNZĂTOR."}, {"name": "KIND HENRIETTE I.I", "cui": "RO 28065263", "regCom": "F30/130/2011", "iban": "RO28065263tel", "bank": "Raiffeisen", "phone": "_________________", "representative": "________________________", "role": "VÂNZĂTOR", "fullText": "KIND HENRIETTE I.I cu sediul CAPLENI, NR.512/B, jud. Satu Mare, înmatriculată sub nr. F30/130/2011 , înregistrata la Reg. Comertului Satu Mare , CIF RO 28065263 tel. _________________, având contul RO26RZBR0000060013330053 deschis la Raiffeisen , reprezentată prin ________________________, în calitate de VÂNZĂTOR."}, {"name": "SIRMIS EXIM SRL VALEA LUI MIHAI", "cui": "RO5021586", "regCom": "J05/3853/1993", "iban": "RO98BTRLRONCRT0385656701deschislaBanc", "bank": "Banca Transilvania_suc", "phone": "______________", "representative": "________________________", "role": "VÂNZĂTOR", "fullText": "SIRMIS EXIM SRL VALEA LUI MIHAI cu sediul/domiciliul în Valea lui Mihai , jud. Bihor , înmatriculată sub nr. J05/3853/1993 , CIF RO5021586 , tel./fax. ______________, având codul IBAN RO98 BTRL RONC RT03 8565 6701 deschis la Banca Transilvania_suc./ag._____________________, reprezentată prin ________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "LELENKA IOAN ROBERT I.I", "cui": "RO33577898", "regCom": "F30/565/2014", "iban": "RO46CECESM1630RON0445511", "bank": "CEC BANK S", "phone": "", "representative": "-", "role": "VANZATOR", "fullText": "LELENKA IOAN ROBERT I.I cu sediul/domiciliul in JUD. SATU MARE, ORS. LIVADA, STR. VICTORIEI, NR.65, inmatriculata sub nr. F30/565/2014, inregistrata la Reg. C.C.I. , CIF RO33577898, telefon nr. : , avand codul IBAN RO46CECESM1630RON0445511, deschis la CEC BANK S.A. reprezentata prin - administrator , in calitate de VANZATOR ."}, {"name": "VAMI GHEORGHE I.I", "cui": "RO37021185", "regCom": "F30/47/2017", "iban": "RO51BTRLRONCRT0494868101deschislaBANCATR", "bank": "BANCA TRANSILVANIA_suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "VAMI GHEORGHE I.I. cu sediul/domiciliul în LIVADA STR. SALCIMILOR, , jud. SATU MARE, înmatriculată sub nr. F30/47/2017, înregistrata la Reg. C.C.I. ____________________, CIF RO37021185_, tel./fax.______________, având codul IBAN RO51BTRLRONCRT0494868101 deschis la BANCA TRANSILVANIA_suc./ag.__________________reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR ."}, {"name": "AGROPROD TURISM SRL", "cui": "RO29763922", "regCom": "J30/95/2012", "iban": "", "bank": "", "phone": "", "representative": "asociat unic Trandafir Dorina", "role": "VÂNZĂTOR", "fullText": "AGROPROD TURISM SRL cu sediul în loc. IOJIB, NR.103 , jud. Satu Mare , înmatriculata sub nr. J30/95/2012 la Reg.C.C.I. , CIF RO29763922 , reprezentată prin asociat unic Trandafir Dorina, în calitate de VÂNZĂTOR."}, {"name": "SZUCS F. FERENC AGRO PFA", "cui": "RO19976974", "regCom": "F05/21/2006", "iban": "RO93BTRLRONCRT0393662201", "bank": "Banza Transilvania reprezentata prin ________________administrator", "phone": "", "representative": "________________", "role": "VANZATOR", "fullText": "SZUCS F. FERENC AGRO PFA cu sediul/domiciliul in TAMASEU NR 126, Jud. BIHOR, inmatriculata sub nr. F05/21/2006, inregistrata la Reg. C.C.I. BIHOR, CIF RO19976974, telefon nr. : , avand codul IBAN RO93BTRLRONCRT0393662201, deschis la Banza Transilvania reprezentata prin ________________administrator , in calitate de VANZATOR."}, {"name": "SZUCS A. FERENC I.I", "cui": "RO25161940", "regCom": "F05/304/2009", "iban": "RO94BTRLRONCRT0393681001", "bank": "Banza Transilvania reprezentata prin ________________administrator", "phone": "", "representative": "________________", "role": "VANZATOR", "fullText": "SZUCS A. FERENC I.I cu sediul/domiciliul in TAMASEU NR 126, Jud. BIHOR, inmatriculata sub nr. F05/304/2009, inregistrata la Reg. C.C.I. BIHOR, CIF RO25161940, telefon nr. : , avand codul IBAN RO94BTRLRONCRT0393681001, deschis la Banza Transilvania reprezentata prin ________________administrator , in calitate de VANZATOR."}, {"name": "KADAR A. ATILLA PFA", "cui": "26672218", "regCom": "F05/543/2010", "iban": "RO42CECEBH0130RON0530739", "bank": "CEC BANK reprezentata prin Kadar Attila administrator", "phone": "", "representative": "Kadar Attila", "role": "VANZATOR", "fullText": "KADAR A. ATILLA PFA cu sediul/domiciliul in HODOS NR 272, Jud. BIHOR, inmatriculata sub nr. F05/543/2010, inregistrata la Reg. C.C.I. BIHOR, CIF 26672218, telefon nr. : , avand codul IBAN RO42CECEBH0130RON0530739, deschis la CEC BANK reprezentata prin Kadar Attila administrator , in calitate de VANZATOR ."}, {"name": "FERENAGRO SRL", "cui": "RO26281651", "regCom": "J05/1538/2009", "iban": "RO45BTRLRONCRT0397309101", "bank": "Banza Transilvania reprezentata prin ________________administrator", "phone": "", "representative": "________________", "role": "VANZATOR", "fullText": "FERENAGRO SRL cu sediul/domiciliul in TAMASEU NR 126, Jud. BIHOR, inmatriculata sub nr. J05/1538/2009, inregistrata la Reg. C.C.I. BIHOR, CIF RO26281651, telefon nr. : , avand codul IBAN RO45BTRLRONCRT0397309101, deschis la Banza Transilvania reprezentata prin ________________administrator , in calitate de VANZATOR."}, {"name": "PROMOCIONES ALSINA SRL", "cui": "RO20404178", "regCom": "J30/3/2007", "iban": "RO39BACX0000002453586000deschislaUnicredi", "bank": "Unicredit Bank suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "PROMOCIONES ALSINA SRL cu sediul/domiciliul în Satu Mare BLD. UNIRII NR.7, jud. Satu Mare, înmatriculată sub nr. J30/3/2007, înregistrata la Reg. C.C.I. _____, CIF RO20404178 , tel./fax. ______________, având codul IBAN RO39BACX0000002453586000 deschis la Unicredit Bank suc./ag.______________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "SCHWAB AGRO PROD SRL", "cui": "RO16753072", "regCom": "J30/988/2004", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________, CNP ________________", "role": "VÂNZĂTOR", "fullText": "SCHWAB AGRO PROD SRL cu sediul în loc JUD. SATU MARE, ORAS. ARDUD, STR. BUCURESTIULUI, NR.152V, înmatriculata sub nr. J30/988/2004 la Reg.C.C.I. , CIF RO16753072 , reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "RITLI IOAN I.I", "cui": "RO38828303", "regCom": "F30/81/2018", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________, CNP ________________", "role": "VÂNZĂTOR", "fullText": "RITLI IOAN I.I. cu sediul în loc. CAPLENI, NR.438, jud. Satu Mare , înmatriculata sub nr. F30/81/2018 la Reg.C.C.I. , CIF RO38828303, reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "FERMA KADAR SRL", "cui": "RO17816578", "regCom": "J30/866/2005", "iban": "RO17816578tel", "bank": "", "phone": "", "representative": "", "role": "VÂNZĂTOR", "fullText": "FERMA KADAR SRL cu sediul în Carei STR. PETRU RARES NR.17, jud. Satu Mare , înmatriculata sub nr. J30/866/2005 , înregistrata la Reg. C.C.I. , CIF RO17816578 tel. , având codul IBAN deschis la , reprezentată prin , în calitate de VÂNZĂTOR."}, {"name": "ILUT MIHAELA PFA", "cui": "RO38745267", "regCom": "F30/49/2018", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________, CNP ________________", "role": "VÂNZĂTOR", "fullText": "ILUT MIHAELA PFA cu sediul în loc.Dacia STR.PRINCIPALA, NR.75 , jud. Satu Mare , înmatriculata sub nr. F30/49/2018 la Reg.C.C.I. , CIF RO38745267, reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "FERMA CORPARET SRL", "cui": "RO21118506", "regCom": "J30/267/2007", "iban": "RO21118506tel", "bank": "CEC BANK ag", "phone": "", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "FERMA CORPARET SRL cu sediul în JUD. SATU MARE, MUN. CAREI, înmatriculata sub nr. J30/267/2007 , înregistrata la Reg. C.C.I. , CIF RO21118506 tel. , având codul IBAN RO06CECESM0201RON0296655 deschis la CEC BANK ag. __________, reprezentată prin _________________, în calitate de VÂNZĂTOR."}, {"name": "PASCU MONICA MARIANA PFA", "cui": "RO34263117", "regCom": "", "iban": "RO79BTRLRONCRT0395319601", "bank": "BANCA TRANSILVANIA suc", "phone": "0771773133", "representative": "____________________", "role": "VÂNZĂTOR", "fullText": "PASCU MONICA MARIANA PFA cu sediul/domiciliul in CAUAS, CAUAS NR.132, Jud. SATU MARE, inmatriculata sub nr. F30/213/20.03.2015, inregistrata la Reg. C.C.I. SATU MARE, CIF RO34263117, telefon nr. 0771773133, avand codul IBAN RO79 BTRL RONC RT03 9531 9601, deschis la BANCA TRANSILVANIA suc./ag. ______________________, reprezentata prin ____________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "KISS L ATTILA PFA", "cui": "RO 43943473", "regCom": "F30/130/2021", "iban": "RO43943473tel", "bank": "CEC BANK suc", "phone": "______________", "representative": "Radu Donca", "role": "VÂNZĂTOR", "fullText": "KISS L ATTILA PFA cu sediul/domiciliul în GHENCI, NR.358/A, jud.Satu Mare, înmatriculată sub nr. F30/130/2021, înregistrata la Reg. C.C.I. ____________________, CIF RO 43943473 tel./fax. ______________, având codul IBAN RO52CECEC001946009785121 deschis la CEC BANK suc./ag.______________________, reprezentată prin Radu Donca administrator, în calitate de VÂNZĂTOR."}, {"name": "SOLO IMPEX SRL", "cui": "RO3246612", "regCom": "J31 /917 /1992", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________, CNP ________________", "role": "VÂNZĂTOR", "fullText": "SOLO IMPEX SRL cu sediul în loc. Zalau Aleea BRADULUI , jud. Salaj , înmatriculata sub nr. J31 /917 /1992 la Reg.C.C.I. Bihor, CIF RO3246612, reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "ILUT MIHAI", "cui": "", "regCom": "", "iban": "", "bank": "BankA COMERCIALA ROMANA", "phone": "", "representative": "ILUT MIHAI", "role": "VÂNZĂTOR", "fullText": "ILUT MIHAI cu sediul în Dacia STR.PRINCIPALA, NR.75, jud. Satu Mare , înmatriculata sub nr. înregistrata la Reg. C.C.I. CNP 1620924300021 tel. , având codul IBANRO86RNCB0222012023260001 deschis la BankA COMERCIALA ROMANA , reprezentată prin ILUT MIHAI , în calitate de VÂNZĂTOR ."}, {"name": "AGRODAN COMERT S.R.L", "cui": "RO46820319", "regCom": "J30/1059/2022", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________, CNP ________________", "role": "VÂNZĂTOR", "fullText": "AGRODAN COMERT S.R.L. cu sediul în loc.Rosiori, str.___________, nr.241, jud.Satu Mare , înmatriculata sub nr. J30/1059/2022 la Reg.C.C.I. Bihor, CIF RO46820319, reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "POOSZ ALEX EMERIC", "cui": "", "regCom": "", "iban": "RO04BACX0000001643754000deschislaUnicredi", "bank": "Unicredit Bank", "phone": "", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "POOSZ ALEX EMERIC cu sediul în CAPLENI NR.55 , jud. Satu Mare, înmatriculata sub nr. , înregistrata la Reg. C.C.I. , CIF CNP1871231303711 tel. , având codul IBAN RO04BACX0000001643754000 deschis la Unicredit Bank , reprezentată prin _________________, în calitate de VÂNZĂTOR."}, {"name": "VIRAGH CSABA ISTVAN", "cui": "", "regCom": "", "iban": "RO69CECEC001946268965711deschislaCEC", "bank": "CEC", "phone": "", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "VIRAGH CSABA ISTVAN cu sediul în MOFTINU MIC NR 419, jud. Satu Mare, înmatriculata sub nr. , înregistrata la Reg. C.C.I. r CIF CNP 1790608300024 tel. , având codul IBAN RO69 CECE C001 9462 6896 5711 deschis la CEC, reprezentată prin _________________, în calitate de VÂNZĂTOR."}, {"name": "DAVID MIHAI MIRCEA I.I", "cui": "RO20655307", "regCom": "F30/697/2005", "iban": "RO20655307tel", "bank": "BCR", "phone": "", "representative": "David Mircea", "role": "VÂNZĂTOR", "fullText": "DAVID MIHAI MIRCEA I.I. cu sediul în Moftinu Mic 178, jud. Satu Mare, înmatriculata sub nr. F30/697/2005 , înregistrata la Reg. C.C.I. Bihor, CIF RO20655307 tel. , având codul IBAN RO07 RNCB 0222 0119 6664 0001 deschis la BCR , reprezentată prin David Mircea , în calitate de VÂNZĂTOR."}, {"name": "VIRAG BARBARA I.I", "cui": "RO22645946", "regCom": "F30/893/2007", "iban": "RO28RNCB0222108169850001deschislaBanc", "bank": "Banca Comerciala Romana", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "VIRAG BARBARA I.I. cu sediul/domiciliul în CAPLENI NR.16/A , înmatriculată sub nr. F30/893/2007 , înregistrata la Reg. C.C.I. , CIF RO22645946 , tel./fax. ______________, având codul IBAN RO28 RNCB 0222 1081 6985 0001 deschis la Banca Comerciala Romana , reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR ."}, {"name": "CSABA & GETA TRANS SRL", "cui": "RO18899458", "regCom": "J05/1565/2006", "iban": "RO32BRDE050SV87695590500deschislaBancaRo", "bank": "Banca Romana pentru Dezvoltare suc", "phone": "______________", "representative": "", "role": "VÂNZĂTOR", "fullText": "CSABA & GETA TRANS SRL cu sediul/domiciliul în Valea lui Mihai , jud. Bihor , STR.1 DECEMBRIE 38 , înmatriculată sub nr. J05/1565/2006 , CIF RO18899458 , tel./fax. ______________, având codul IBAN RO32BRDE050SV87695590500 deschis la Banca Romana pentru Dezvoltare suc./ag.______________________, reprezentată prin___________ administrator, în calitate de VÂNZĂTOR ."}, {"name": "S.C. CIRSIUM SRL MARGHITA S.R.L", "cui": "RO15515005", "regCom": "J05/738/2003", "iban": "RO53BRDE050SV23319180500", "bank": "BANCA ROMANA PENTRU DEZVOLTARE suc", "phone": "0767532180", "representative": "____________________", "role": "VÂNZĂTOR", "fullText": "S.C. CIRSIUM SRL MARGHITA S.R.L. cu sediul in loc. Marghita, Closca, nr. 11, Jud. Bihor, inmatriculata sub nr. J05/738/2003, inregistrata la Reg. C.C.I. BIHOR, CIF RO15515005, telefon nr. 0767532180, avand codul IBAN RO53BRDE050SV23319180500, deschis la BANCA ROMANA PENTRU DEZVOLTARE suc./ag. ______________________, reprezentata prin ____________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "S.C. FERMA LIBAGRO SRL", "cui": "RO36367610", "regCom": "J05/1465/2016", "iban": "RO70CECEBH3530RON0804185", "bank": "CEC BANK S", "phone": "0261/861399", "representative": "Nagy Erzsebet-", "role": "VANZATOR", "fullText": "S.C. FERMA LIBAGRO SRL cu sediul/domiciliul in SACUENI, STR.1 MAI NR 22, Jud. BIHOR, inmatriculata sub nr. J05/1465/2016, inregistrata la Reg. C.C.I. BIHOR, CIF RO36367610, telefon nr. : 0261/861399, avand codul IBAN RO70 CECE BH35 30RO N080 4185, deschis la CEC BANK S.A. reprezentata prin Nagy Erzsebet- administrator , in calitate de VANZATOR ."}, {"name": "KOVACS E.STEFAN PFA", "cui": "28808341", "regCom": "F31/696/2011", "iban": "RO21CECESJ0430RON0336520deschislaCECBank", "bank": "CEC Bank suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "KOVACS E.STEFAN PFA cu sediul/domiciliul în CARASTELEC NR.535 , jud.Satu Mare, înmatriculată sub nr. F31/696/2011 , înregistrata la Reg. C.C.I. ____________________, CIF 28808341 tel./fax. ______________, având codul IBAN RO21CECESJ0430RON0336520 deschis la CEC Bank suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "MESZAROS ELEK ELEMER", "cui": "", "regCom": "", "iban": "RO83RZBR0000060009111855deschisRaiffeisen", "bank": "", "phone": "", "representative": "", "role": "VÂNZĂTOR", "fullText": "MESZAROS ELEK ELEMER cu sediul în Marghita STR.KOLCSEY FERENCZ, NR.6 , jud. Bihor, înmatriculata sub nr., înregistrata la Reg. C.C.I. Bihor, CIF CNP 1570814052859 tel, având codul IBAN RO83RZBR0000060009111855 deschis Raiffeisen, reprezentată prin ERDEI IMRE ISTVAN calitate de VÂNZĂTOR."}, {"name": "ERDEI IMRE ISTVAN", "cui": "", "regCom": "", "iban": "RO27RNCB0035022202800001deschisBCR", "bank": "", "phone": "", "representative": "", "role": "VÂNZĂTOR", "fullText": "ERDEI IMRE ISTVAN cu sediul în SAT. OTOMAN NR.245 , jud. Bihor, înmatriculata sub nr., înregistrata la Reg. C.C.I. Bihor, CIF CNP 1600702052853 tel, având codul IBAN RO27RNCB0035022202800001 deschis BCR, reprezentată prin ERDEI IMRE ISTVAN calitate de VÂNZĂTOR."}, {"name": "SOLTESZ LEVENTE PFA", "cui": "RO36318804", "regCom": "J05/1016/2016", "iban": "RO36318804tel", "bank": "Banca Transylvania", "phone": "0745399041", "representative": "", "role": "VÂNZĂTOR", "fullText": "SOLTESZ LEVENTE PFA cu sediul în OTOMANI 226 , jud. Bihor, înmatriculata sub nr. J05/1016/2016 , înregistrata la Reg. C.C.I. Bihor, CIF RO36318804 tel. 0745399041, având codul IBAN RO04BTRLRONCRT0357146601 deschis la Banca Transylvania , reprezentată prin SOLTESZ LEVENTE calitate de VÂNZĂTOR."}, {"name": "GROMAX GRAINS SRL", "cui": "RO34367614", "regCom": "J30/233/2015", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________, CNP ________________", "role": "VÂNZĂTOR", "fullText": "GROMAX GRAINS SRL cu sediul în loc. SAT BERCU NR.110 , jud.Satu Mare , înmatriculata sub nr. J30/233/2015 la Reg.C.C.I. , CIF RO34367614 , reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "SILAGHI ANDREI PAUL PFA", "cui": "RO344851304", "regCom": "F05/894/2015", "iban": "RO344851304tel", "bank": "Banca Transylvania reprezentată prin administrator in calitate de VANZATOR", "phone": "", "representative": "administrator", "role": "VANZATOR", "fullText": "SILAGHI ANDREI PAUL PFA cu sediul în CHIRIBIS, NR.208B jud.Bihor, înmatriculata sub nr. F05/894/2015, înregistrata la Reg. C.C.I. Bihor, CIF RO344851304 tel. , având codul IBAN RO15BTRL00501202995635XX deschis la Banca Transylvania reprezentată prin administrator in calitate de VANZATOR ."}, {"name": "CHICHINESDI EMANUEL-FLORIN PFA", "cui": "RO30549494", "regCom": "F05/1838/2012", "iban": "RO30549494tel", "bank": "Banca Romana de Dezoltare reprezentată prin administrator in calitate de VANZATO", "phone": "", "representative": "administrator", "role": "VANZATOR", "fullText": "CHICHINESDI EMANUEL-FLORIN PFA cu sediul în SAT SUIUG, NR 105/A jud.Bihor, înmatriculata sub nr. F05/1838/2012, înregistrata la Reg. C.C.I. Bihor, CIF RO30549494 tel. , având codul IBAN RO71BRDE050SV59364020500 deschis la Banca Romana de Dezoltare reprezentată prin administrator in calitate de VANZATOR ."}, {"name": "AGROSEM CEREALE COOP AGRIC", "cui": "47178552", "regCom": "C30/5/2022", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________, CNP ________________", "role": "VÂNZĂTOR", "fullText": "AGROSEM CEREALE COOP AGRIC cu sediul în loc. MUN. SATU MARE, STR. FERMA SATMAREL, NR.32v, jud. Satu Mare , înmatriculata sub nr. C30/5/2022 la Reg.C.C.I. Bihor, CIF 47178552 , reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "AGROERH GNANDT SRL", "cui": "RO45573830", "regCom": "J30/127/2022", "iban": "RO24RNCB0222171965860001deschislaBCRCare", "bank": "BCR Carei", "phone": "", "representative": "", "role": "VÂNZĂTOR", "fullText": "AGROERH GNANDT SRL cu sediul in Urziceni, jud. Satu Mare, str. Urziceni nr. 382, Hot. Jud nr. J30/127/2022, CIF RO45573830, tel./fax. , având contul IBAN RO24RNCB0222171965860001 deschis la BCR Carei, reprezentat prin , în calitate de VÂNZĂTOR."}, {"name": "KISS GABOR SZILARD PFA SRL", "cui": "RO34323502", "regCom": "F30/252/2015", "iban": "RO34323502tel", "bank": "Banca Romana de Dezoltare reprezentată prin Kiss Gabor Szilard administrator in", "phone": "0740900213", "representative": "Kiss Gabor Szilard", "role": "VANZATOR", "fullText": "KISS GABOR SZILARD PFA SRL cu sediul în SOCOND jud.Satu Mare, înmatriculata sub nr. F30/252/2015, înregistrata la Reg. C.C.I. Satu Mare, CIF RO34323502 tel. 0740900213, având codul IBAN RO67BRDE310SV54975993100 deschis la Banca Romana de Dezoltare reprezentată prin Kiss Gabor Szilard administrator in calitate de VANZATOR."}, {"name": "ARDELEAN ANDREI FLORIN I.I", "cui": "RO44473795", "regCom": "F24/733/2021", "iban": "RO27BTRLRONCRT0609264901", "bank": "Banca Transilvaia in calitate de VANZATOR", "phone": "0261861399", "representative": "", "role": "VANZATOR", "fullText": "ARDELEAN ANDREI FLORIN I.I cu sediul-domiciliul in Viile Apei nr 7,jud Maramures,inmatriculata sub nr F24/733/2021 inregistrata la Reg CCI Maramures ,CIF RO44473795,TEL 0261861399 ,avand codul IBAN RO27BTRLRONCRT0609264901 ,deschis la Banca Transilvaia in calitate de VANZATOR."}, {"name": "AGRO TIP SRL", "cui": "", "regCom": "J30/1256/2004", "iban": "RO16967548tel", "bank": "CEC Bank", "phone": "_____________", "representative": "______________, CNP ___________________", "role": "VÂNZĂTOR", "fullText": "AGRO TIP SRL cu sediul în Ratesti PRINCIPALA, FN , jud. Satu Mare , înmatriculata sub nr. J30/1256/2004 , înregistrata la Reg. C.C.I. RO16967548 tel. _____________, având codul IBAN RO41CECECJ0130RON0913620 deschis la CEC Bank , reprezentată prin ______________, CNP ___________________, în calitate de VÂNZĂTOR ."}, {"name": "GABOR SANDOR I.I", "cui": "RO47467909", "regCom": "F05/90/2023", "iban": "RO47467909tel", "bank": "Banca Romana pentru Dezvoltare", "phone": "", "representative": "_______________________", "role": "VÂNZĂTOR", "fullText": "GABOR SANDOR I.I. cu sediul în TARCEA, NR.344, jud. Bihor, înmatriculata sub nr. F05/90/2023 , înregistrata la Reg. C.C.I. Bihor, CIF RO47467909 tel. , având codul IBAN RO74BRDE050SV86139840500 deschis la Banca Romana pentru Dezvoltare, reprezentată prin _______________________, în calitate de VÂNZĂTOR."}, {"name": "FILIP SIMINA CORINA PFA", "cui": "RO26231408", "regCom": "F30/946/2009", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________, CNP ________________", "role": "VÂNZĂTOR", "fullText": "FILIP SIMINA CORINA PFA cu sediul în loc.APA, STR PRINCIPALA NR 756 jud.Satu Mare , înmatriculata sub nr. F30/946/2009 la Reg.C.C.I. , CIF RO26231408 , reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "CUBITCHI ALEXANDRU PFA", "cui": "RO39272205", "regCom": "F30/413/2018", "iban": "", "bank": "_______________", "phone": "", "representative": "ing. ____________", "role": "VÂNZĂTOR", "fullText": "CUBITCHI ALEXANDRU PFA. cu sediul în JUD. SATU MARE, SAT ACAS COM. ACAS, NR.99, înmatriculata sub nr. F30/413/2018 , înregistrata la Reg. C.C.I. Satu Mare, CIF RO39272205, având codul IBAN________________ deschis la _______________, reprezentată prin ing. ____________, în calitate de VÂNZĂTOR."}, {"name": "BRUTLER MIHAI PFA", "cui": "RO34973513", "regCom": "F30/595/2015", "iban": "", "bank": "_______________", "phone": "", "representative": "ing. ____________", "role": "VÂNZĂTOR", "fullText": "BRUTLER MIHAI PFA. cu sediul în BELTIUG NR.363, jud. Satu Mare, înmatriculata sub nr. F30/595/2015 , înregistrata la Reg. C.C.I. Satu Mare, CIF RO34973513, având codul IBAN________________ deschis la _______________, reprezentată prin ing. ____________, în calitate de VÂNZĂTOR."}, {"name": "AGROMIRIAM SANISLAU COOPERATIVA AGRICOLA", "cui": "RO44871251", "regCom": "C30/16/2021", "iban": "", "bank": "Banca Transilvania Bank suc", "phone": "______________", "representative": "________________________", "role": "VÂNZĂTOR", "fullText": "AGROMIRIAM SANISLAU COOPERATIVA AGRICOLA cu sediul/domiciliul în SANISLAU NR 1330 , jud. Satu Mare , înmatriculată sub nr. C30/16/2021 , CIF RO44871251 , tel./fax. ______________, având codul IBAN deschis la Banca Transilvania Bank suc./ag.______________________, reprezentată prin ________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "AGRIMANITIU SRL", "cui": "RO35462142", "regCom": "J30/63/2016", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________, CNP ________________", "role": "VÂNZĂTOR", "fullText": "AGRIMANITIU SRL cu sediul în loc. CAREI STR. INDEPENDENTEI NR 34, jud. Satu Mare, înmatriculata sub nr. J30/63/2016 la Reg.C.C.I. , CIF RO35462142 , reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "SHWAB AGRO PROD SRL", "cui": "RO16753072", "regCom": "J30/988/2004", "iban": "", "bank": "", "phone": "", "representative": "SCHITA MIHAI", "role": "VANZATOR", "fullText": "SHWAB AGRO PROD SRL cu sediul în loc. JUD. SATU MARE, ORS. ARDUD, STR. BUCURESTIULUI, NR.152 , înmatriculata sub nr. J30/988/2004 la Reg.C.C.I. , CIF RO16753072 , reprezentată prin SCHITA MIHAI , în calitate de VANZATOR."}, {"name": "MAN FARM COOP AGRICOLA", "cui": "RO44925769", "regCom": "C30/22/2021", "iban": "", "bank": "", "phone": "", "representative": "asociat unic Manitiu Dumitru", "role": "VÂNZĂTOR", "fullText": "MAN FARM COOP AGRICOLA cu sediul în loc. JUD. SATU MARE, MUN. CAREI, STR. GROF KAROLYI SANDOR, NR.4, înmatriculata sub nr. C30/22/2021 la Reg.C.C.I. , CIF RO44925769, reprezentată prin asociat unic Manitiu Dumitru , în calitate de VÂNZĂTOR."}, {"name": "CSIRAK ATTILA OTTO PFA", "cui": "RO23277044", "regCom": "F30/300/2002", "iban": "", "bank": "", "phone": "", "representative": "asociat unic Csirak Attila Otto", "role": "VÂNZĂTOR", "fullText": "CSIRAK ATTILA OTTO PFA cu sediul în loc. COM. MOFTINU MARE, NR.199 jud. Satu Mare , înmatriculata sub nr. F30/300/2002 la Reg.C.C.I. , CIF RO23277044 , reprezentată prin asociat unic Csirak Attila Otto , în calitate de VÂNZĂTOR."}, {"name": "ILUT I DANIELA FLORICA I.I", "cui": "RO33025397", "regCom": "F30 /240 /2014", "iban": "RO08RNCB0035101152450001deschislaBCRsuc", "bank": "BCR suc", "phone": "______________", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "ILUT I DANIELA FLORICA I.I. cu sediul/domiciliul în JUD. SATU MARE , VALEA VINULUI, NR.17 , F30 /240 /2014 CIF RO33025397, tel./fax ______________, având codul IBAN RO08RNCB0035101152450001 deschis la BCR suc./ag. , reprezentată prin _________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "AGROROS SRL", "cui": "RO23940251", "regCom": "J05/1362/2008", "iban": "RO08RNCB0035101152450001deschislaBCRsuc", "bank": "BCR suc", "phone": "______________", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "AGROROS SRL cu sediul/domiciliul în JUD. BIHOR, SAT ROSIORI COM. ROSIORI, ROSIORI, NR.251 , J05/1362/2008 CIF RO23940251, tel./fax ______________, având codul IBAN RO08RNCB0035101152450001 deschis la BCR suc./ag. , reprezentată prin _________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "BOSCONE CEREALE SRL", "cui": "RO35130992", "regCom": "J05/1664/2015", "iban": "RO35130992tel", "bank": "Banca _______________", "phone": "", "representative": "_______________________", "role": "VÂNZĂTOR", "fullText": "BOSCONE CEREALE SRL cu sediul în JUD. BIHOR, SAT ROSIORI COM. ROSIORI, ROSIORI, NR.442, înmatriculata sub nr. J05/1664/2015, înregistrata la Reg. C.C.I. Bihor, CIF RO35130992 tel. , având codul IBANRO57WBAN000596075033RO01 deschis la Banca _______________, reprezentată prin _______________________, în calitate de VÂNZĂTOR . ILUT MIHAELA PFA cu sediul în Dacia STR.PRINCIPALA, NR.75, jud. Satu Mare , înmatriculata sub nr. F30/49/2018, înregistrata la Reg. C.C.I. CIF RO38745267 tel. , având codul IBAN RO58RNCB0221157562460001 deschis la BankA COMERCIALA rOMANA , reprezentată prin DOREL , în calitate de VÂNZĂTOR."}, {"name": "URSU IULIU IOAN PFA", "cui": "RO19886022", "regCom": "F05/643/2006", "iban": "RO19886022tel", "bank": "CEC Bank", "phone": "", "representative": "_______________________", "role": "VÂNZĂTOR", "fullText": "URSU IULIU IOAN PFA cu sediul în Valea lui Mihai ARANY JANOS 2/A , jud. Satu Mare , înmatriculata sub nr. F05/643/2006 , înregistrata la Reg. C.C.I. CIF RO19886022 tel. , având codul IBAN RO11CECEBH1730RON0607304 deschis la CEC Bank , reprezentată prin _______________________ , în calitate de VÂNZĂTOR."}, {"name": "HODOROG ANDREA PFA", "cui": "RO25372859", "regCom": "F30/306/2009", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________", "role": "VÂNZĂTOR", "fullText": "HODOROG ANDREA PFA cu sediul în loc. Sauca nr.62, jud .Satu Mare , înmatriculata sub nr. F30/306/2009 la Reg.C.C.I. Bihor, CIF RO25372859, reprezentată prin asociat unic ___________________, în calitate de VÂNZĂTOR."}, {"name": "GARDAN AGRO SRL", "cui": "RO22376988", "regCom": "J05/2244/2007", "iban": "RO22376988tel", "bank": "Banca Transilvania ag", "phone": "", "representative": "Gardan Grigore", "role": "VÂNZĂTOR", "fullText": "GARDAN AGRO SRL cu sediul în ADONI NR.253, jud. Bihor, înmatriculata sub nr. J05/2244/2007, înregistrata la Reg. C.C.I. Bihor, CIF RO22376988 tel. , având codul IBAN RO50 BTRL RONC RT02 6603 6001 deschis la Banca Transilvania ag. Valea lui Mihai, reprezentată prin Gardan Grigore , în calitate de VÂNZĂTOR."}, {"name": "BUTEAN IOAN I.I", "cui": "RO36725050", "regCom": "F05/1430/2016", "iban": "RO57RNCB0035152558560001deschislaBCRBank", "bank": "BCR Bank", "phone": "", "representative": "_______________", "role": "VANZATOR", "fullText": "BUTEAN IOAN I.I. cu sediul în Marghita ALEEA INFRATIRII NR 9, BL.9, ET.1, AP.1, jud. Bihor, înmatriculată sub nr. F05/1430/2016 la Reg. C.C.I. Bihor, CIF RO36725050, tel./fax. , avand contul IBAN RO57RNCB0035152558560001 deschis la BCR Bank , reprezentată prin _______________ administrator în calitate de VANZATOR."}, {"name": "FANEA VASILE PFA", "cui": "RO38874008", "regCom": "F30/109/2018", "iban": "RO78CECESM0230RON0499012deschislaCEC", "bank": "CEC", "phone": "", "representative": "Fanea Vasile", "role": "VÂNZĂTOR", "fullText": "FANEA VASILE PFA., cu sediul in CAUAS, NR.108/A, jud. Satu Mareihor, înregistrata la C.C.I. Bihor, nr. F30/109/2018, CIF RO38874008, tel./fax. având contul IBAN RO78CECESM0230RON0499012 deschis la CEC , reprezentată prin Fanea Vasile, în calitate de VÂNZĂTOR."}, {"name": "MOISE PAUL PFA", "cui": "RO31605517", "regCom": "F05/820/2013", "iban": "RO31605517tel", "bank": "Raiffeisen Bank ag", "phone": "0745773969", "representative": "Moisa Paul", "role": "VÂNZĂTOR", "fullText": "MOISE PAUL PFA. cu sediul în Balc, str. Petofi Sandor nr. 52, jud. Bihor, înmatriculata sub nr. F05/820/2013, înregistrata la Reg. C.C.I. Bihor, CIF RO31605517 tel. 0745773969, având codul IBAN RO46 RZBR 0000 0600 1561 1812 deschis la Raiffeisen Bank ag. Marghita, reprezentată prin Moisa Paul, administrator, în calitate de VÂNZĂTOR."}, {"name": "TARPAI A. SANDOR I.I", "cui": "", "regCom": "F05/660/2010", "iban": "RO26741490laReg", "bank": "", "phone": "", "representative": "asociat unic Tarpai Sandor", "role": "VÂNZĂTOR", "fullText": "TARPAI A. SANDOR I.I. cu sediul în loc. Valea lui Mihai STR.PETOFI SANDOR, NR.28 , jud. Bihor , înmatriculata sub nr. RO26741490 la Reg.C.C.I. Bihor, CIF F05/660/2010 , reprezentată prin asociat unic Tarpai Sandor , în calitate de VÂNZĂTOR."}, {"name": "FORON SRL", "cui": "RO666077", "regCom": "J30/241/1991", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________, CNP ________________", "role": "VÂNZĂTOR", "fullText": "FORON SRL cu sediul în loc. Craidorolt STR.PRINCIPALA NR.222 , jud. Satu Mare , înmatriculata sub nr. J30/241/1991 la Reg.C.C.I. , CIF RO666077 , reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "SZALLAI EMERIC I.I", "cui": "RO9817971", "regCom": "F05/398/2002", "iban": "RO61RNCB1500000071230001deschislaBanc", "bank": "Banca Comerciala Roman", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "SZALLAI EMERIC I.I. cu sediul/domiciliul în Santaul Mare jud. Bihor, înmatriculată sub nr. F05/398/2002 , înregistrata la Reg. C.C.I. _____, CIF RO9817971 , tel./fax. ______________, având codul IBAN RO61 RNCB 1500 0000 7123 0001 deschis la Banca Comerciala Roman , reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR ."}, {"name": "GHI ANDREI PAUL PFA", "cui": "RO34485130", "regCom": "F05/894/2015", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________, CNP ________________", "role": "VÂNZĂTOR", "fullText": "GHI ANDREI PAUL PFA cu sediul în loc. CHIRIBIS, NR.208B , jud. Bihor, înmatriculata sub nr. F05/894/2015 la Reg.C.C.I. Bihor, CIF RO34485130 , reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "ZSISCU ROBERT PFA", "cui": "31803204", "regCom": "F5/1647/2013", "iban": "RO04BRDE050SV80815940500deschislaBancaRo", "bank": "Banca Romana pentru Dezvoltare", "phone": "", "representative": "", "role": "VÂNZĂTOR", "fullText": "ZSISCU ROBERT PFA cu sediul în VIISOARA, NR.271A , jud. Bihor, înmatriculata sub nr. , înregistrata la Reg. F5/1647/2013 C.C.I. Bihor, CIF 31803204 tel. , având codul IBAN RO04BRDE050SV80815940500 deschis la Banca Romana pentru Dezvoltare , în calitate de VÂNZĂTOR ."}, {"name": "COREMANS AGRO TIPAR SRL", "cui": "RO40030019", "regCom": "J05/2306/2020", "iban": "RO85OTPV220000252909RO01deschislaOTP", "bank": "OTP Bank Romania", "phone": "________________", "representative": "Ruud Lucas", "role": "VÂNZĂTOR", "fullText": "COREMANS AGRO TIPAR SRL cu sediul în loc. Salonta nr.240, jud.Bihor, înmatriculată sub nr. J05/2306/2020, înregistrata la Reg. C.C.I. Satu Mare, CIF RO40030019 , tel./fax.________________ , având codul IBAN RO85 OTPV 2200 0025 2909 RO01 deschis la OTP Bank Romania, reprezentată prin Ruud Lucas administrator, în calitate de VÂNZĂTOR."}, {"name": "AGRO MOLINERO SRL", "cui": "RO19233325", "regCom": "J05/2458/2006", "iban": "RO85OTPV220000252909RO01deschislaOTP", "bank": "OTP Bank Romania", "phone": "________________", "representative": "Ruud Lucas Heikens", "role": "VÂNZĂTOR", "fullText": "AGRO MOLINERO SRL cu sediul în loc. ORADEA STR.AUREL LAZAR NR.11 AP.3, jud.Bihor, înmatriculată sub nr. J05/2458/2006, înregistrata la Reg. C.C.I. Satu Mare, CIF RO19233325 , tel./fax.________________ , având codul IBAN RO85 OTPV 2200 0025 2909 RO01 deschis la OTP Bank Romania, reprezentată prin Ruud Lucas Heikens administrator, în calitate de VÂNZĂTOR."}, {"name": "AGRO IANUS SRL", "cui": "RO18973880", "regCom": "J05/1737/2006", "iban": "RO85OTPV220000252909RO01deschislaOTP", "bank": "OTP Bank Romania", "phone": "________________", "representative": "Ruud Lucas Heikens", "role": "VÂNZĂTOR", "fullText": "AGRO IANUS SRL cu sediul în loc. ORADEA STR.AUREL LAZAR NR. 11, jud.Bihor, înmatriculată sub nr. J05/1737/2006, înregistrata la Reg. C.C.I. Satu Mare, CIF RO18973880 , tel./fax.________________ , având codul IBAN RO85 OTPV 2200 0025 2909 RO01 deschis la OTP Bank Romania, reprezentată prin Ruud Lucas Heikens administrator, în calitate de VÂNZĂTOR."}, {"name": "ERNI ANA", "cui": "", "regCom": "", "iban": "RO32CECESM1408RON0303787deschislaCECBANK", "bank": "CEC BANK", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "ERNI ANA cu sediul/domiciliul în SAT. URZICENI NR 327, jud. Satu Mare , înmatriculată sub nr., înregistrata la Reg. C.C.I., CNP 2470705300042 , tel./fax. ______________, având codul IBAN RO32CECESM1408RON0303787 deschis la CEC BANK, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "HUND GERHARDT", "cui": "", "regCom": "", "iban": "RO35RZBR0000060021642403deschislaRaiffeis", "bank": "Raiffeisen Bank", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "HUND GERHARDT cu sediul/domiciliul în SAT. FOIENI NR.411, jud. Satu Mare , înmatriculată sub nr., înregistrata la Reg. C.C.I., CNP1951022303939 , tel./fax. ______________, având codul IBAN RO35RZBR0000060021642403 deschis la Raiffeisen Bank, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "GABOR AGRO SRL", "cui": "RO20630388", "regCom": "J05/111/2007", "iban": "RO20630388tel", "bank": "Banca Romana pentru Dezvoltare", "phone": "", "representative": "_______________________", "role": "VÂNZĂTOR", "fullText": "GABOR AGRO SRL cu sediul în TARCEA, NR.344, jud. Bihor, înmatriculata sub nr. J05/111/2007, înregistrata la Reg. C.C.I. Bihor, CIF RO20630388 tel. , având codul IBAN RO74BRDE050SV86139840500 deschis la Banca Romana pentru Dezvoltare, reprezentată prin _______________________, în calitate de VÂNZĂTOR."}, {"name": "KUKI AGRO SRL", "cui": "RO28095779", "regCom": "J05 /313 /2011", "iban": "RO28095779tel", "bank": "Banca Transilvania reprezentată prin ____________________", "phone": "0740196972", "representative": "____________________", "role": "VÂNZĂTOR", "fullText": "KUKI AGRO SRL cu sediul în Sacueni Str. LETA MARE 45 , jud. Bihor , înmatriculata sub nr. J05 /313 /2011, înregistrata la Reg. C.C.I. , CIF RO28095779 tel. 0740196972 , având codul RO14BTRL00501202W39239XX deschis la Banca Transilvania reprezentată prin ____________________, în calitate de VÂNZĂTOR."}, {"name": "AGRO CEREAL CRISUL NEGRU SRL", "cui": "RO43783321", "regCom": "J05 /469 /2021", "iban": "RO43783321tel", "bank": "CEC Bank", "phone": "___________", "representative": "__________", "role": "VÂNZĂTOR", "fullText": "AGRO CEREAL CRISUL NEGRU SRL cu sediul în Olcea nr.299 , jud. Bihor , înmatriculata sub nr. J05 /469 /2021, înregistrata la Reg. C.C.I. , CIF RO43783321 tel. ___________ , având codul IBAN RO51CECEB00030RON1498982 deschis la CEC Bank, reprezentată prin __________, în calitate de VÂNZĂTOR."}, {"name": "CRISUL NEGRU TINCA COOP.AGR", "cui": "RO43651444", "regCom": "C05 /5 /2021", "iban": "RO43651444tel", "bank": "Banca Transilvania", "phone": "___________", "representative": "__________", "role": "VÂNZĂTOR", "fullText": "CRISUL NEGRU TINCA COOP.AGR. cu sediul în Nadlac STR. GEORGE COSBUC, NR.51 , jud. Arad , înmatriculata sub nr. C05 /5 /2021, înregistrata la Reg. C.C.I. , CIF RO43651444 tel. ___________ , având codul IBAN RO85BTRLRONCRT0586212001 deschis la Banca Transilvania, reprezentată prin __________, în calitate de VÂNZĂTOR."}, {"name": "SCHRADI ISTVAN IF", "cui": "RO15498320", "regCom": "F30/88/2003", "iban": "RO15498320tel", "bank": "", "phone": "______________", "representative": "", "role": "VANZATOR", "fullText": "SCHRADI ISTVAN IF cu sediul în CAPLENI , str.____________nr. 384 , jud. SATU MARE, înmatriculata sub nr. F30/88/2003 , înregistrata la Reg. C.C.I. r, CIF RO15498320 tel. ______________, având codul IBAN RO74CECESM0255RON0231183 -deschis , CEC BANK , în calitate de VANZATOR."}, {"name": "AGRO SOMPREST SRL", "cui": "RO28856748", "regCom": "J31/338/2011", "iban": "RO28856748tel", "bank": "Banca Transilvania", "phone": "0751623920", "representative": "", "role": "VÂNZĂTOR", "fullText": "AGRO SOMPREST SRL cu sediul în NAPRADEA NR 245, jud. Salaj , înmatriculata sub nr. J31/338/2011, înregistrata la Reg. C.C.I. , CIF RO28856748 tel. 0751623920 , având codul IBAN RO50BTRLRONCRT00B4698501 deschis la Banca Transilvania, reprezentată prin , în calitate de VÂNZĂTOR."}, {"name": "MARCZIN CLAUDIA PFA SRL", "cui": "RO34316165", "regCom": "F05/556/2015", "iban": "RO34316165tel", "bank": "CEC Bank", "phone": "", "representative": "", "role": "VANZATOR", "fullText": "MARCZIN CLAUDIA PFA SRL. cu sediul în SAT.CIOCAIA, NR.379 , jud. Bihor, înmatriculata sub nr. F05/556/2015, înregistrata la Reg. C.C.I. Bihor, CIF RO34316165 tel., având codul IBAN RO58CECEBH3530RON0761527 deschis la CEC Bank , reprezentată prin , în calitate de VANZATOR."}, {"name": "CODREA VASILE DOREL PFA", "cui": "RO27040970", "regCom": "F30/602/2010", "iban": "RO27040970tel", "bank": "CEC Bank", "phone": "", "representative": "", "role": "VANZATOR", "fullText": "CODREA VASILE DOREL PFA cu sediul în CRAIDOROLT NR.413 , jud. Satu Mare, înmatriculata sub nr. F30/602/2010 , înregistrata la Reg. C.C.I. Satu Mare, CIF RO27040970 tel., având codul IBAN RO68 CECE SM01 30RO N031 4258 deschis la CEC Bank , reprezentată prin , în calitate de VANZATOR."}, {"name": "VASY & ALEX SRL", "cui": "RO21791145", "regCom": "J30 /696 /2007", "iban": "RO21791145tel", "bank": "___________", "phone": "", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "VASY & ALEX SRL cu sediul în Pomi nr.56, jud. Satu Mare, înmatriculata sub nr. J30 /696 /2007, înregistrata la Reg. C.C.I. , CIF RO21791145 tel. , având codul IBAN___________________ deschis la ___________, reprezentată prin _________________, în calitate de VÂNZĂTOR."}, {"name": "AGROFLORETOM SRL", "cui": "RO37077305", "regCom": "J05/288/2017", "iban": "RO37077305tel", "bank": "BankA tRANSILVANIA", "phone": "", "representative": "", "role": "VANZATOR", "fullText": "AGROFLORETOM SRL. cu sediul în MARGINE NR 13 , jud. Bihor, înmatriculata sub nr. J05/288/2017 , înregistrata la Reg. C.C.I. Bihor, CIF RO37077305 tel., având codul IBAN RO78BTRLRONCRT0384980001 deschis la BankA tRANSILVANIA , reprezentată prin , în calitate de VANZATOR ."}, {"name": "MURESAN SILVIU IONEL PFA S.R.L", "cui": "", "regCom": "F30/261/2015", "iban": "RO98CECESM0930RON0457015deschislaCEC", "bank": "CEC Bank SA", "phone": "_____________", "representative": "______________, CNP ___________________", "role": "VÂNZĂTOR", "fullText": "MURESAN SILVIU IONEL PFA S.R.L. cu sediul în Sauca sat Silvas nr.15, jud.Satu Mare , înmatriculata sub nr. F30/261/2015 , înregistrata la Reg. C.C.I. RO34330496tel. _____________, având codul IBAN RO98 CECE SM09 30RO N045 7015 deschis la CEC Bank SA, reprezentată prin ______________, CNP ___________________, în calitate de VÂNZĂTOR."}, {"name": "FAZEKAS IMRE IANOS", "cui": "", "regCom": "", "iban": "RO21RZBR0000060016069035deschislaRaiffeis", "bank": "Raiffeisen Bank SA", "phone": "_____________", "representative": "______________, CNP ___________________", "role": "VÂNZĂTOR", "fullText": "FAZEKAS IMRE IANOS cu sediul în Balc STR. PRIMAVERII NR.83, jud. Bihor , înmatriculata sub nr., înregistrata la Reg. C.C.I. CNP 1790719052858tel. _____________, având codul IBAN RO21RZBR0000060016069035 deschis la Raiffeisen Bank SA, reprezentată prin ______________, CNP ___________________, în calitate de VÂNZĂTOR ."}, {"name": "S.C. ROXION AGRO S.R.L", "cui": "RO26777575", "regCom": "J05/487/2010", "iban": "RO26777575tel", "bank": "BRD ag", "phone": "0771750922", "representative": "Briscut Ionut", "role": "VÂNZĂTOR", "fullText": "_S.C. ROXION AGRO S.R.L. cu sediul Margine nr 174, jud. Bihor, înmatriculata sub nr.J05/487/2010, înregistrata la Reg. C.C.I. Bihor, CIF RO26777575 tel.0771750922, având codul IBAN RO84RNCB0664115622120001 deschis la BRD ag. Marghita, reprezentată prin Briscut Ionut administrator, , în calitate de VÂNZĂTOR."}, {"name": "AVI BROILER SKM SRL", "cui": "RO25379652", "regCom": "J30/297/2009", "iban": "RO25379652tel", "bank": "___________", "phone": "", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "AVI BROILER SKM SRL cu sediul în Satu Mare BLD. INDEPENDENTEI, BL.UH10, AP.5, jud. Satu Mare, înmatriculata sub nr. J30/297/2009, înregistrata la Reg. C.C.I. , CIF RO25379652 tel. , având codul IBAN___________________ deschis la ___________, reprezentată prin _________________, în calitate de VÂNZĂTOR."}, {"name": "KAPLONYI JOZSEF ROBERT IF", "cui": "RO 23450985", "regCom": "", "iban": "RO29BTRL03101202H59435XXdeschislaBanc", "bank": "Banca Transilvania", "phone": "", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "KAPLONYI JOZSEF ROBERT IF cu sediul în Capleni nr.381, jud. Satu Mare, înmatriculată sub nr. F30/155/06.03.2008, înregistrata la Reg. C.C.I. Satu Mare, CIF RO 23450985, tel./fax., având codul IBAN RO29 BTRL 0310 1202 H594 35XX deschis la Banca Transilvania , reprezentată prin _________________administrator CNP 2850124303705, în calitate de VÂNZĂTOR."}, {"name": "KONCZ STEFAN IF", "cui": "18186888", "regCom": "F30/1479/2005", "iban": "RO33RNCB0222029507060002deschislaBanc", "bank": "Banca Comerciala Romana", "phone": "", "representative": "______________", "role": "VÂNZĂTOR", "fullText": "KONCZ STEFAN IF. cu sediul în Tiream STR.CIORII 152/ATrifeşti, jud. Satu Mare. , înmatriculată sub nr. F30/1479/2005, înregistrata la Reg. C.C.I. Satu Mare, CIF 18186888, tel./fax. , având codul IBAN RO33 RNCB 0222 0295 0706 0002 deschis la Banca Comerciala Romana, reprezentată prin ______________administrator CNP 180050130378, în calitate de VÂNZĂTOR."}, {"name": "FILIP GHEORGHE DANUT PFA", "cui": "RO30560980", "regCom": "F30/934/2012", "iban": "RO18BRDE310SV56880113100deschislaING", "bank": "ING Bank suc", "phone": "______________", "representative": "Radu Donca", "role": "VÂNZĂTOR", "fullText": "FILIP GHEORGHE DANUT PFA cu sediul/domiciliul în SAT POTAU NR. 73, jud.Satu Mare,înmatriculată sub nr. F30/934/2012 înregistrata la Reg. C.C.I. ____________________, CIFRO30560980 tel./fax. ______________, având codul IBAN RO18 BRDE 310S V568 8011 3100 deschis la ING Bank suc./ag.______________________, reprezentată prin Radu Donca administrator, în calitate de VÂNZĂTOR."}, {"name": "PALOTAS MIHAI I.I", "cui": "RO31265415", "regCom": "F30 /129 /2013", "iban": "RO31265415tel", "bank": "Banca", "phone": "", "representative": "", "role": "VANZATOR", "fullText": "PALOTAS MIHAI I.I. cu sediul în Livada STR VICTORIEI NR69, jud. Satu Mare, înmatriculata sub nr. F30 /129 /2013, înregistrata la Reg. C.C.I, CIF RO31265415 tel. , având codul IBAN RO34CECESM1630RON0406151 deschis la Banca , reprezentată prin , în calitate de VANZATOR."}, {"name": "PALOTAS RICHARD MIHAI I.I", "cui": "RO34358632", "regCom": "F30/270/2015", "iban": "RO34358632tel", "bank": "Banca", "phone": "", "representative": "", "role": "VANZATOR", "fullText": "PALOTAS RICHARD MIHAI I.I. cu sediul în Livada STR VICTORIEI NR69/ACHIRALEU NR.149, jud. Satu Mare, înmatriculata sub nr. F30/270/2015, înregistrata la Reg. C.C.I, CIF RO34358632 tel. , având codul IBAN RO43 CRCO X250 1100 0024 8358 deschis la Banca , reprezentată prin , în calitate de VANZATOR."}, {"name": "A.V.CRASNA SRL", "cui": "RO4625622", "regCom": "J30/410/1991", "iban": "RO53RNCB0222055739880001deschislaBanca", "bank": "Banca Comerciala Romana suc", "phone": "______________", "representative": "________________________", "role": "VÂNZĂTOR", "fullText": "A.V.CRASNA SRL. cu sediul/domiciliul în Moftinu Mare nr.142 , jud. Satu Mare , înmatriculată sub nr. J30/410/1991 , CIF RO4625622 , tel./fax. ______________, având codul IBAN RO53 RNCB 0222 0557 3988 0001deschis la Banca Comerciala Romana suc./ag.______________________, reprezentată prin ________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "DENICRIS AGRO SRL", "cui": "RO30864890", "regCom": "J05/1873/2012", "iban": "RO51RNCB0035022178070001deschislaBCR", "bank": "BCR_____________ suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "DENICRIS AGRO SRL cu sediul/domiciliul în GALOSPETREU NR.218, jud. BIHOR , înmatriculată sub nr. J05/1873/2012 , înregistrata la Reg. C.C.I.__________________, CIF RO30864890 , tel./fax. ______________, având codul IBAN RO51 RNCB 0035 0221 7807 0001 deschis la BCR_____________ suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "BULLS MAN SRL", "cui": "RO37811168", "regCom": "J30/738/2017", "iban": "RO18CECESM0230RON0491071suc", "bank": "", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "BULLS MAN SRL cu sediul/domiciliul în CAUAS STR. INDEPENDENTEI NR.34, jud. Satu Mare, înmatriculată sub nr. J30/738/2017, înregistrata la Reg. C.C.I. , CIF RO37811168, tel./fax. ______________, având codul IBAN RO18CECESM0230RON0491071 suc./ag.CEC BANK SA, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "S.C. AGRO HEVELI 2018 S.R.L", "cui": "RO 39670790", "regCom": "J30/697/2018", "iban": "RO39670790tel", "bank": "", "phone": "0747692000", "representative": "HEVELI CSABA", "role": "VANZATOR", "fullText": "S.C. AGRO HEVELI 2018 S.R.L. cu sediul în CAPLENI , str.____________nr. 1 , jud. SATU MARE, înmatriculata sub nr. J30/697/2018 , înregistrata la Reg. C.C.I. Bihor, CIF RO 39670790 tel. 0747692000_, având codul IBAN RO44BRDE310SV66902603100 deschis BRD BANK , reprezentată prin HEVELI CSABA, în calitate de VANZATOR."}, {"name": "SOCACI CIPRIAN MARIUS PFA", "cui": "RO46918830", "regCom": "F30/398/2022", "iban": "", "bank": "____________________ suc", "phone": "______________", "representative": "_______________________________________", "role": "VÂNZĂTOR", "fullText": "SOCACI CIPRIAN MARIUS PFA cu sediul/domiciliul în JUD. SATU MARE, SAT CRAIDOROLT , NR.420 , înmatriculată sub nr. F30/398/2022 , înregistrata la Reg. C.C.I.__________________, CIF RO46918830 , tel./fax. ______________, având codul IBAN __________________ deschis la ____________________ suc./ag.______________________, reprezentată prin _______________________________________ administrator, în calitate de VÂNZĂTOR ."}, {"name": "AGROMAX GRAINS SRL", "cui": "RO34367614", "regCom": "J30/233/2015", "iban": "RO47BTRLRONCRT0295118401deschislaBancaTr", "bank": "Banca Transilvania suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "AGROMAX GRAINS SRL cu sediul/domiciliul în SAT BERCU NR.110, jud. Satu Mare , înmatriculată sub nr. J30/233/2015 , înregistrata la Reg. C.C.I.__________________, CIF RO34367614 , tel./fax. ______________, având codul IBAN RO47BTRLRONCRT0295118401 deschis la Banca Transilvania suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "RATYIS BOGDAN VASILE I.I", "cui": "RO45205529", "regCom": "F30/542/2021", "iban": "RO93BTRLRONCRT0CF2158901deschislaBancaTr", "bank": "Banca Transilvania suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "RATYIS BOGDAN VASILE I.I. cu sediul/domiciliul în JUD. SATU MARE, SAT DUMBRAVA ORS. LIVADA, DUMBRAVA, NR.140 , înmatriculată sub nr. F30/542/2021 , înregistrata la Reg. C.C.I.__________________, CIF RO45205529 , tel./fax. ______________, având codul IBAN RO93BTRLRONCRT0CF2158901 deschis la Banca Transilvania suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR ."}, {"name": "FAMISAB AGRO SRL", "cui": "RO38820202", "regCom": "J24/179/2018", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________, CNP ________________", "role": "VÂNZĂTOR", "fullText": "FAMISAB AGRO SRL cu sediul în loc. Seini VIILE APEI, NR.216 , jud. Satu Mare , înmatriculata sub nr. J24/179/2018 la Reg.C.C.I. Bihor, CIF RO38820202 , reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR ."}, {"name": "AGROINVEST CAREI SRL SRL", "cui": "RO17521780", "regCom": "J30/535/2005", "iban": "RO34BTRL03101202219855XXdeschislaING", "bank": "ING Bank suc", "phone": "______________", "representative": "Radu Donca", "role": "VÂNZĂTOR", "fullText": "AGROINVEST CAREI SRL SRL cu sediul/domiciliul în Carei, jud.Satu Mare, str. TIREAMULUI 76 , înmatriculată sub nr. J30/535/2005, înregistrata la Reg. C.C.I. ____________________, CIFRO17521780 tel./fax. ______________, având codul IBAN RO34 BTRL 0310 1202 2198 55XX deschis la ING Bank suc./ag.______________________, reprezentată prin Radu Donca administrator, în calitate de VÂNZĂTOR."}, {"name": "ACTA LINE TRANS SRL", "cui": "RO30257260", "regCom": "J24/457/2012", "iban": "RO30257260tel", "bank": "Banca Transilvania", "phone": "_____________", "representative": "Tetis Abraham Claudiu", "role": "VÂNZĂTOR", "fullText": "ACTA LINE TRANS SRL cu sediul în Baia Mare STR. VICTORIEI, NR.71, AP.28 jud. Maramures, înmatriculata sub nr. J24/457/2012, înregistrata la Reg. C.C.I. Bihor, CIF RO30257260 tel._____________, având codul IBAN RO63 BTRL 0250 1202 A023 88XX deschis la Banca Transilvania, reprezentată prin Tetis Abraham Claudiu , în calitate de VÂNZĂTOR."}, {"name": "CHEREJI CRACIUN COOP.AGR", "cui": "RO41409992", "regCom": "C30/9/2019", "iban": "RO41409992tel", "bank": "Banca Comerciala Romana", "phone": "_____________", "representative": "_____________________", "role": "VÂNZĂTOR", "fullText": "CHEREJI CRACIUN COOP.AGR cu sediul în Piscolt STR. UNIRII, NR.911 jud.Satu Mare, înmatriculata sub nr. C30/9/2019, înregistrata la Reg. C.C.I. Bihor, CIF RO41409992 tel._____________, având codul IBAN RO23RNCB0222164162230001 deschis la Banca Comerciala Romana, reprezentată prin _____________________, în calitate de VÂNZĂTOR."}, {"name": "AGROFARM ERIU SANCRAI SRL", "cui": "RO36681205", "regCom": "J30/937/2016", "iban": "RO36681205tel", "bank": "Banca ________________", "phone": "0761415163", "representative": "_____________________", "role": "VÂNZĂTOR", "fullText": "AGROFARM ERIU SANCRAI SRL cu sediul în Eriu Sancrai, nr.102 jud.Satu Mare, înmatriculata sub nr. J30/937/2016, înregistrata la Reg. C.C.I. Bihor, CIF RO36681205 tel. 0761415163, având codul IBAN _________________________________ deschis la Banca ________________, reprezentată prin _____________________, în calitate de VÂNZĂTOR."}, {"name": "VIITORUL SA SANISLAU", "cui": "RO648771", "regCom": "", "iban": "RO66RZBR0000060001473411deschislaRaiffeis", "bank": "Raiffeisen Bank reprezentată prin ___________________ administrator in calitate", "phone": "", "representative": "___________________", "role": "VANZATOR", "fullText": "VIITORUL SA SANISLAU cu sediul în Sanislau jud.Satu Mare, înmatriculata sub nr. 35/13.04.1992, înregistrata la Reg. C.C.I. Satu Mare, CIF RO648771 tel. , având codul IBAN RO66RZBR0000060001473411 deschis la Raiffeisen Bank reprezentată prin ___________________ administrator in calitate de VANZATOR."}, {"name": "KIS M GABOR PFA", "cui": "", "regCom": "F30/99/2021", "iban": "RO43845530tel", "bank": "BRD", "phone": "_____________", "representative": "______________", "role": "VANZATOR", "fullText": "KIS M GABOR PFA cu sediul în Carei str.titulescu nr .19, jud. Satu Mare, înmatriculata sub nr. F30/99/2021, înregistrata la Reg. C.C.I. RO43845530__________ tel. _____________, având codul IBAN RO43BRDE310SV73504443100 deschis la BRD , reprezentată prin ______________, în calitate de VANZATOR."}, {"name": "SCHRADI ERIKA ILONA PFA", "cui": "RO27863186", "regCom": "F30/1475/2010", "iban": "RO27863186tel", "bank": "", "phone": "______________", "representative": "", "role": "VANZATOR", "fullText": "SCHRADI ERIKA ILONA PFA cu sediul în CAPLENI , str.____________nr. 384 , jud. SATU MARE, înmatriculata sub nr. F30/1475/2010 , înregistrata la Reg. C.C.I. r, CIF RO27863186 tel. ______________, având codul IBAN RO76CECESM0230RON0335991 -deschis , CEC BANK , în calitate de VANZATOR."}, {"name": "TERRA SOC.AGR. SANISLAU", "cui": "RO648780", "regCom": "", "iban": "RO07RZBR0000060001473406deschislaRaif", "bank": "Raiffeisen Bank suc", "phone": "", "representative": "administrator", "role": "VÂNZĂTOR", "fullText": "TERRA SOC.AGR. SANISLAU cu sediul în Sanislau, jud. Satu Mare, str LIBERTATII 562, înmatriculată sub nr. , înregistrata la Reg. C.C.I. Satu Mare, CIF RO648780, tel./fax. , având codul IBAN RO07 RZBR 0000 0600 0147 3406 deschis la Raiffeisen Bank suc. , reprezentată prin administrator, în calitate de VÂNZĂTOR."}, {"name": "SCHAMAGOSCH SOC.AGR", "cui": "RO648739", "regCom": "", "iban": "RO31BRDE310SV43317313100deschislaBRD", "bank": "BRD suc", "phone": "", "representative": "Mihai Lochli", "role": "VÂNZĂTOR", "fullText": "SCHAMAGOSCH SOC.AGR. cu sediul în Ciumesti, jud. Satu Mare, str. NISIPULUI 56, înmatriculată sub nr. HJ20/1992, înregistrata la Reg. C.C.I. Satu Mare, CIF RO648739, tel./fax. , având codul IBAN RO31 BRDE 310S V433 1731 3100 deschis la BRD suc. , reprezentată prin Mihai Lochli administrator, în calitate de VÂNZĂTOR."}, {"name": "KOVACS IOZSEF I.I", "cui": "RO26079661", "regCom": "F05/1681/2009", "iban": "RO36BRDE050SV48107870500deschislaBancaRo", "bank": "Banca Romana de Dezvoltare", "phone": "", "representative": "Kovacs Iozsef", "role": "VÂNZĂTOR", "fullText": "KOVACS IOZSEF I.I., cu sediul in BUDUSLAU NR.16, jud. Bihor, înregistrata la C.C.I. Bihor, sub nr. F05/1681/2009, CIF RO26079661, tel./fax. având contul IBAN RO36BRDE050SV48107870500 deschis la Banca Romana de Dezvoltare , reprezentată prin Kovacs Iozsef, în calitate de VÂNZĂTOR."}, {"name": "BOVAGRO PISCARI COOP AGR", "cui": "RO41485736", "regCom": "C30/12/2019", "iban": "RO72BRDE310SV69853753100deschislaBRDsuc", "bank": "BRD suc", "phone": "0728321463", "representative": "Avorniciti Neculai", "role": "VÂNZĂTOR", "fullText": "BOVAGRO PISCARI COOP AGR. cu sediul în Pişcari, jud. Satu Mare, str. Istrău nr. 207, înmatriculată sub nr. C30/12/2019, înregistrata la Reg. C.C.I. Satu Mare, CIF RO41485736, tel./fax. 0728321463, având codul IBAN RO72BRDE310SV69853753100 deschis la BRD suc. Satu Mare, reprezentată prin Avorniciti Neculai administrator, în calitate de VÂNZĂTOR."}, {"name": "VAN DEN HEERIK AGRICOLA SRL", "cui": "RO18961622", "regCom": "J05/1719/2006", "iban": "RO23RZBR0000060010957875deschislaRaif", "bank": "Raiffeisen Bank suc", "phone": "______________", "representative": "Borsi Attila", "role": "VÂNZĂTOR", "fullText": "VAN DEN HEERIK AGRICOLA SRL cu sediul/domiciliul în Marghita , jud. Bihor , STR.TUDOR VLADIMIRESCU NR.273 , înmatriculată sub nr. J05/1719/2006 , CIF RO18961622 , tel./fax. ______________, având codul IBAN RO23 RZBR 0000 0600 1095 7875 deschis la Raiffeisen Bank suc./ag.______________________, reprezentată prin Borsi Attila administrator, în calitate de VÂNZĂTOR."}, {"name": "STOICA TRANS COM SRL", "cui": "", "regCom": "", "iban": "RO85BRDE050SV03643060500deschislaBancaRo", "bank": "Banca Romana Dezvoltare", "phone": "0740353044", "representative": "______________, CNP ___________________", "role": "VÂNZĂTOR", "fullText": "STOICA TRANS COM SRL cu sediul în Valea lui Mihai STR.GEORGE ENESCU, NR.9 , jud. Bihor, înmatriculata sub nr. J05/1857/91 , înregistrata la Reg. C.C.I. RO97290 tel. 0740353044, având codul IBAN RO85BRDE050SV03643060500 deschis la Banca Romana Dezvoltare, reprezentată prin ______________, CNP ___________________, în calitate de VÂNZĂTOR ."}, {"name": "SEMCEREAL SRL S.R.L", "cui": "RO25149424", "regCom": "J05/246/2009", "iban": "RO25149424tel", "bank": "", "phone": "0740344288", "representative": "Bogdan Tirpe", "role": "VANZATOR", "fullText": "SEMCEREAL SRL S.R.L. cu sediul în Salard, NR.431, ET.1, AP.2 , jud. Bih, înmatriculata sub nr. J05/246/2009 , înregistrata la Reg. C.C.I. Bihor, CIF RO25149424 tel. 0740344288, având codul IBAN ___________________ deschis _________________, reprezentată prin Bogdan Tirpe , în calitate de VANZATOR."}, {"name": "BORSI ATTILA", "cui": "", "regCom": "", "iban": "", "bank": "Raiffeisen Bank suc", "phone": "______________", "representative": "Borsi Attila", "role": "VÂNZĂTOR", "fullText": "BORSI ATTILA cu sediul/domiciliul în Marghita , jud. Bihor , înmatriculată sub nr. CNP 1690409052871 , tel./fax. ______________, având codul IBAN deschis la Raiffeisen Bank suc./ag.______________________, reprezentată prin Borsi Attila administrator, în calitate de VÂNZĂTOR."}, {"name": "CAMPIA CAREIULUI COOP AGR", "cui": "", "regCom": "C30/1/2017", "iban": "RO37622967tel", "bank": "Unicredit Bank", "phone": "_____________", "representative": "______________, CNP ___________________", "role": "VÂNZĂTOR", "fullText": "CAMPIA CAREIULUI COOP AGR cu sediul în Petresti nr.68, jud.Satu Mare , înmatriculata sub nr. C30/1/2017, înregistrata la Reg. C.C.I. RO37622967 tel. _____________, având codul IBAN RO74BACX0000001900568000 deschis la Unicredit Bank , reprezentată prin ______________, CNP ___________________, în calitate de VÂNZĂTOR."}, {"name": "ROSCA MARIA I.I", "cui": "RO17309648", "regCom": "F30/223/2005", "iban": "RO15RZBR0000060002388554deschislaRaif", "bank": "Raiffeisen Bank suc", "phone": "______________", "representative": "________________________", "role": "VÂNZĂTOR", "fullText": "ROSCA MARIA I.I.. cu sediul/domiciliul în Sanislau , jud. Satu Mare , str. 30 DECEMBRIE NR , înmatriculată sub nr. F30/223/2005 , CIF RO17309648 , tel./fax. ______________, având codul IBAN RO15 RZBR 0000 0600 0238 8554 deschis la Raiffeisen Bank suc./ag.______________________, reprezentată prin ________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "AGROCOM BOGDANA SRL", "cui": "RO14918549", "regCom": "J30/480/2002", "iban": "RO78BTRL03101202E29343XXdeschislaBanc", "bank": "Banca Transilvania suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "AGROCOM BOGDANA SRL cu sediul/domiciliul în Tasnad sat Cig nr.1, jud. Satu Mare, înmatriculată sub nr. J30/480/2002, înregistrata la Reg. C.C.I. ____________________, CIF RO14918549 , tel./fax. ______________, având codul IBAN RO78 BTRL 0310 1202 E293 43XX deschis la Banca Transilvania suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "BALINT ROBERT JOZSEF PFA", "cui": "", "regCom": "", "iban": "RO55RNCB0226126182850001deschislaBanc", "bank": "Banca Comerciala Romana suc", "phone": "______________", "representative": "______________________________________", "role": "VÂNZĂTOR", "fullText": "BALINT ROBERT JOZSEF PFA cu sediul/domiciliul în HODOD, NR.63, jud. Satu Mare, înmatriculată sub nr. F30/330./2012, înregistrata la Reg. C.C.I. ____________________, CIF _ RO29699196 , tel./fax. ______________, având codul IBAN RO55 RNCB 0226 1261 8285 0001 deschis la Banca Comerciala Romana suc./ag._________________, reprezentată prin ______________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "TOP CRAIDOROLT SRL", "cui": "RO26773590", "regCom": "J30/169/2014", "iban": "RO26773590tel", "bank": "Raiffeisen Bank suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "TOP CRAIDOROLT SRL cu sediul/domiciliul în Craidorolt, jud.Satu Mare, str. PRINCIPALA NR.58/A, înmatriculată sub nr. J30/169/2014, înregistrata la Reg C.C.I. ____________________, CIF RO26773590 tel./fax. ______________, având codul IBAN RO43 RZBR 0000 0600 1288 1122 deschis la Raiffeisen Bank suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "PETKES MIKLOS OLIVER I.I", "cui": "RO43298211", "regCom": "F30/478/2020", "iban": "", "bank": "Raiffeisen Bank suc", "phone": "______________", "representative": "________________________", "role": "VÂNZĂTOR", "fullText": "PETKES MIKLOS OLIVER I.I.. cu sediul/domiciliul în SER, NR.275 , jud. Satu Mare , înmatriculată sub nr. F30/478/2020 , CIF RO43298211 , tel./fax. ______________, având codul IBAN ___________________deschis la Raiffeisen Bank suc./ag.______________________, reprezentată prin ________________________ administrator, în calitate de VÂNZĂTOR ."}, {"name": "AGRIPRODCOM SRL", "cui": "RO6852141", "regCom": "J30/2067/1994", "iban": "RO70CECESM0101RON0057995deschislaCEC", "bank": "CEC Bank suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "AGRIPRODCOM SRL cu sediul/domiciliul în Craidorolt, jud.Satu Mare, str. NR.222, înmatriculată sub nr. J30/2067/1994 , înregistrata la Reg C.C.I. ____________________, CIF RO6852141 tel./fax. ______________, având codul IBAN RO70 CECE SM01 01RO N005 7995 deschis la CEC Bank suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR ."}, {"name": "TOP FERMA SRL", "cui": "RO27484018", "regCom": "J30/168/2014", "iban": "RO27484018tel", "bank": "Raiffeisen Bank suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "TOP FERMA SRL cu sediul/domiciliul în Craidorolt, jud.Satu Mare, str. PRINCIPALA NR.58/A, înmatriculată sub nr. J30/168/2014, înregistrata la Reg C.C.I. ____________________, CIF RO27484018 tel./fax. ______________, având codul IBAN RO77 RZBR 0000 0600 1298 0517 deschis la Raiffeisen Bank suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "POP GH.CLAUDIU I.I", "cui": "RO31100131", "regCom": "", "iban": "RO92BTRLRONCRT0205250001deschislaBank", "bank": "Banka Transilvania suc", "phone": "______________", "representative": "________________________", "role": "VÂNZĂTOR", "fullText": "POP GH.CLAUDIU I.I. cu sediul/domiciliul în Domanesti , jud. Satu Mare , str.__ nr.274 , înmatriculată sub nr. F30/26/17.01.2013 , CIF RO31100131 , tel./fax. ______________, având codul IBAN RO92 BTRL RONC RT02 0525 0001 deschis la Banka Transilvania suc./ag.______________________, reprezentată prin ________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "BUSTEA RENATA MONIKA", "cui": "", "regCom": "", "iban": "RO61CECEC001946253508711deschislaCECBank", "bank": "CEC Bank suc", "phone": "______________", "representative": "", "role": "VÂNZĂTOR", "fullText": "BUSTEA RENATA MONIKA. cu sediul/domiciliul în ROSIORI , jud. Bihor , înmatriculată sub nr. CNP 2860817055054 , CIF , tel./fax. ______________, având codul IBAN RO61CECEC001946253508711 deschis la CEC Bank suc./ag administrator, în calitate de VÂNZĂTOR ."}, {"name": "AGRONOR COMPANY SRL", "cui": "RO20850200", "regCom": "J30/149/2007", "iban": "RO20850200tel", "bank": "ING Bank suc", "phone": "______________", "representative": "Varga Mihaela Florica", "role": "VÂNZĂTOR", "fullText": "AGRONOR COMPANY SRL cu sediul/domiciliul în Carei, jud.Satu Mare, str. STR.CUZA VODA NR 27, înmatriculată sub nr. J30/149/2007, înregistrata la Reg. C.C.I. ____________________, CIF RO20850200 tel./fax. ______________, având codul IBAN RO36 INGB 0022 0000 5046 8911 deschis la ING Bank suc./ag.______________________, reprezentată prin Varga Mihaela Florica administrator, în calitate de VÂNZĂTOR."}, {"name": "AGRIND SA TASNAD", "cui": "RO665284", "regCom": "J30/955/1991", "iban": "RO76BTRL03101202209295XXdeschislaBanc", "bank": "Banca Transilvania suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "AGRIND SA TASNAD cu sediul/domiciliul în Tasnad, jud.Satu Mare, str. INFRATIRII NR 147, înmatriculată sub nr. J30/955/1991, înregistrata la Reg. C.C.I. ____________________, CIF RO665284, tel./fax. ______________, având codul IBAN RO76 BTRL 0310 1202 2092 95XX deschis la Banca Transilvania suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "EUDIS SA", "cui": "RO7895515", "regCom": "", "iban": "RO88BTRL03201202220421XXdeschislaBanc", "bank": "Banca Transilvania suc", "phone": "", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "EUDIS SA cu sediul/domiciliul în Criseni nr.376/E , jud. Salaj , , înmatriculată sub nr. , înregistrata la Reg. C.C.I. , CIF RO7895515 , tel./fax. , având codul I BAN RO88 BTRL 0320 1202 2204 21XX deschis la Banca Transilvania suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "SPIC AGRO SRL", "cui": "RO 9161442", "regCom": "J30/104/1997", "iban": "RO40CECESM0201RON0254333laCECBANKsu", "bank": "", "phone": "_______", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "SPIC AGRO SRL cu sediul/domiciliul în CAREI, jud. SATU MARE, str. , înmatriculată sub nr. J30/104/1997, înregistrata la Reg. C.C.I. , CIF RO 9161442, tel./fax. _______, având codul IBAN RO40 CECE SM02 01RO N025 4333 la CEC BANK_ suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "GOSPODARUL DIN ARDEAL SRL", "cui": "RO29738384", "regCom": "J12/331/2012", "iban": "RO37BTRLRONCRTOP16749602deschislaBanc", "bank": "Banca Comercială S", "phone": "0744854301", "representative": "ing", "role": "VÂNZĂTOR", "fullText": "GOSPODARUL DIN ARDEAL SRL cu sediul în Cluj Napoca, jud.Cluj , str. STR. SITARILOR, NR.44, înmatriculată sub nr. J12/331/2012, înregistrata la Reg. C.C.I. Satu Mare, CIF RO29738384, tel./fax. 0744854301, având codul IBAN RO37 BTRL RONC RTOP 1674 9602 deschis la Banca Comercială S.A. ag. Carei, reprezentată prin ing. administrator , în calitate de VÂNZĂTOR."}, {"name": "EKOBRIK S.R.L", "cui": "", "regCom": "J05/3062/2008", "iban": "RO24905090tel", "bank": "", "phone": "_____________", "representative": "______________, CNP ___________________", "role": "VÂNZĂTOR", "fullText": "EKOBRIK S.R.L. cu sediul în Diosig STR. ARGESULUI, NR.7, jud. Bihor, înmatriculata sub nr. J05/3062/2008, înregistrata la Reg. C.C.I. RO24905090__________ tel. _____________, având codul IBAN ______________________ deschis la____________, reprezentată prin ______________, CNP ___________________, în calitate de VÂNZĂTOR."}, {"name": "NORD GRAIN SRL", "cui": "RO23978957", "regCom": "J30/783/2008", "iban": "RO37BRDE310SV22406903100deschislaBanc", "bank": "Banca Romana pentru Dezvoltare suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "NORD GRAIN SRL cu sediul/domiciliul în Carei , jud. Satu Mare, str. CALEA ARMATEI ROMANE NR 81B, înmatriculată sub nr. J30/783/2008, înregistrata la Reg. C.C.I. _____, CIF RO23978957 , tel./fax. ______________, având codul IBAN RO37 BRDE 310S V224 0690 3100 deschis la Banca Romana pentru Dezvoltare suc./ag.______________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "AGRICOLA TIREAM SRL", "cui": "RO29478691", "regCom": "", "iban": "RO26BRDE310SV59865613100deschislaBanc", "bank": "Banca Romana pentru Dezvoltare suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "AGRICOLA TIREAM SRL cu sediul/domiciliul în Carei , jud. Satu Mare, str. CALEA ARMATEI ROMANE NR 81B, înmatriculată sub nr. J30/922/21.12.2011, înregistrata la Reg. C.C.I. _____, CIF RO29478691 , tel./fax. ______________, având codul IBAN RO26 BRDE 310S V598 6561 3100 deschis la Banca Romana pentru Dezvoltare suc./ag.______________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "PETE KOMAROMY ORS SZILARD PFA", "cui": "RO26121189", "regCom": "", "iban": "RO11BTRLRONCRT0V07346501deschislaBanc", "bank": "Banca Transilvania suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "PETE KOMAROMY ORS SZILARD PFA cu sediul/domiciliul în Carei STR.PETOFI SANDOR NR.59, jud. Satu Mare , înmatriculată sub nr. F30/845/19.10.2009, înregistrata la Reg. C.C.I. ____________________, CIF RO26121189, tel./fax. ______________, având codul IBAN RO11 BTRL RONC RT0V 0734 6501 deschis la Banca Transilvania suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "MAISONS SRL", "cui": "RO13808130", "regCom": "J05/278/2001", "iban": "RO74BRDE050SV63451540500deschislaBanc", "bank": "Banca Romana de Dezvoltare suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "MAISONS SRL cu sediul/domiciliul în Sacueni STR LETA MARE NR 12, jud. Bihor, înmatriculată sub nr. J05/278/2001, înregistrata la Reg. C.C.I. ____, CIF RO13808130 , tel./fax. ______________, având codul IBAN RO74 BRDE 050S V634 5154 0500 deschis la Banca Romana de Dezvoltare suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "SEGAL &CO SRL", "cui": "RO9064237", "regCom": "J30/23/1997", "iban": "RO71BRDE310SV02855873100deschislaBanc", "bank": "Banca Romana pentru Dezvoltare", "phone": "0261766860", "representative": "__________________, CNP ___________________", "role": "VÂNZĂTOR", "fullText": "SEGAL &CO SRL cu sediul în Satu Mare STR. INDEPENDENTEI BL.UH10,AP.5, jud. Satu Mare , înmatriculata sub nr. J30/23/1997, înregistrata la Reg. C.C.I. , CIF RO9064237 tel. 0261766860 , având codul IBAN RO71 BRDE 310S V028 5587 3100 deschis la Banca Romana pentru Dezvoltare , reprezentată prin __________________, CNP ___________________, în calitate de VÂNZĂTOR."}, {"name": "AGROCOOP APA COOP.AGR", "cui": "RO41791689", "regCom": "C30/14/2019", "iban": "", "bank": "", "phone": "", "representative": "asociat unic ___________________, CNP ________________", "role": "VÂNZĂTOR", "fullText": "AGROCOOP APA COOP.AGR. cu sediul în loc. APA, NR.727 , jud. Satu Mare, înmatriculata sub nr. C30/14/2019 la Reg.C.C.I. , CIFRO41791689 , reprezentată prin asociat unic ___________________, CNP ________________, în calitate de VÂNZĂTOR."}, {"name": "INFRATIREA SOC AGR CAREI", "cui": "RO2826972", "regCom": "", "iban": "RO76BRDE310SV02251463100deschislaBanc", "bank": "Banca Romana de Dezvoltare suc", "phone": "0261862452", "representative": "Ciucos Liviu", "role": "VÂNZĂTOR", "fullText": "INFRATIREA SOC AGR CAREI cu sediul/domiciliul în CAREI C-lea Armatei Române nr . 80_, jud. . Satu Mare , înregistrata la Jud.1/1191, CIF RO2826972 tel./fax. 0261862452 , având codul IBAN RO76 BRDE 310 SV022 5146 3100 deschis la Banca Romana de Dezvoltare suc./ag.Carei , reprezentată prin Ciucos Liviu administrator, în calitate de VÂNZĂTOR."}, {"name": "AGROCRONOS SRL", "cui": "RO17249511", "regCom": "J30/215/2005", "iban": "RO17249511tel", "bank": "Banca Transilvania ag", "phone": "0744575679", "representative": "ing. Marius Ciucos", "role": "VANZATOR", "fullText": "AGROCRONOS SRL. cu sediul în Carei str.Tireamului nr. 90, jud. Satu Mare, înmatriculata sub nr. J30/215/2005, înregistrata la Reg. C.C.I. , CIF RO17249511 tel. 0744575679, având codul IBAN RO37 BTRL 0310 1202 2181 03XX deschis la Banca Transilvania ag. Carei, reprezentată prin ing. Marius Ciucos , , în calitate de VANZATOR."}, {"name": "COM ABM SRL", "cui": "", "regCom": "J02/756/1995", "iban": "RO45MIRO0000458996780101deschislaProc", "bank": "Procredit Bank", "phone": "_____________", "representative": "______________, CNP ___________________", "role": "VÂNZĂTOR", "fullText": ". COM ABM SRL cu sediul în Arad STR. POETULUI, NR.6, jud.Arad, înmatriculata sub nr. J02/756/1995, înregistrata la Reg. C.C.I. RO7987023 tel. _____________, având codul IBAN RO45 MIRO 0000 4589 9678 0101 deschis la Procredit Bank, reprezentată prin ______________, CNP ___________________, în calitate de VÂNZĂTOR."}, {"name": "S.C. CARIN AGRAR SRL", "cui": "", "regCom": "J02/55/2000", "iban": "RO12657080tel", "bank": "Procredit Bank", "phone": "_____________", "representative": "______________, CNP ___________________", "role": "VÂNZĂTOR", "fullText": "S.C. CARIN AGRAR SRL cu sediul în COM VLADIMIRESCU NR.458, jud.Arad, înmatriculata sub nr. J02/55/2000, înregistrata la Reg. C.C.I. RO12657080 tel. _____________, având codul IBAN RO82 MIRO 0000 4588 9160 0201 deschis la Procredit Bank, reprezentată prin ______________, CNP ___________________, în calitate de VÂNZĂTOR."}, {"name": "ALBY MAXAGRONOMIA SRL", "cui": "RO36479258", "regCom": "J30/788/2016", "iban": "RO42BTRLRONCRT0483311101deschislaRaif", "bank": "Raiffeisen Bank suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "ALBY MAXAGRONOMIA SRL cu sediul/domiciliul în Odoreu, jud. Satu Mare, str. str. Plopilor, nr. 1, înmatriculată sub nr. J30/788/2016, înregistrata la Reg. C.C.I. _____, CIF RO36479258 , tel./fax. ______________, având codul IBAN RO42 BTRL RONC RT04 8331 1101 deschis la Raiffeisen Bank suc./ag.______________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "COMODORE SA", "cui": "RO670108", "regCom": "", "iban": "RO96RZBR0000060000906876deschislaRaif", "bank": "Raiffeisen Bank suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "COMODORE SA cu sediul/domiciliul în Odoreu, jud. Satu Mare, str. str. Plopilor, nr. 1, înmatriculată sub nr. J___/_____/________, înregistrata la Reg. C.C.I. _____, CIF RO670108 , tel./fax. ______________, având codul IBAN RO96 RZBR 0000 0600 0090 6876 deschis la Raiffeisen Bank suc./ag.______________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "SOMOGYI C. CAROL PFA", "cui": "RO21811102", "regCom": "F05 /804 /2019", "iban": "RO27BTRL00501202J57455XXdeschislaBanc", "bank": "Banca Transilvania __________________ suc", "phone": "", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "SOMOGYI C. CAROL PFA cu sediul/domiciliul în Valea lui Mihai, jud. Bihor, STR. KOSUTH LAJOS NR.50 , înmatriculată sub nr. F05 /804 /2019, înregistrata la Reg. C.C.I. , CIF RO21811102 , tel./fax. , având codul IBAN RO27 BTRL 0050 1202 J574 55XX deschis la Banca Transilvania __________________ suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "VALEA GANASULUI SRL", "cui": "RO15895443", "regCom": "J05/1456/2003", "iban": "RO27BTRL00501202J57455XXdeschislaBanc", "bank": "Banca Transilvania __________________ suc", "phone": "", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "VALEA GANASULUI SRL cu sediul/domiciliul în Valea lui Mihai, jud. Bihor, STR. KOSUTH LAJOS NR.50 , înmatriculată sub nr. J05/1456/2003, înregistrata la Reg. C.C.I. , CIF RO15895443 , tel./fax. , având codul IBAN RO27 BTRL 0050 1202 J574 55XX deschis la Banca Transilvania __________________ suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "VESTAGRAR SRL", "cui": "RO18186896", "regCom": "J30/1313/2005", "iban": "RO18186896tel", "bank": "Banca Romana pentru Dezvoltare", "phone": "", "representative": "", "role": "VANZATOR", "fullText": "VESTAGRAR SRL cu sediul în Carei ARM ROMANA 81B, jud. Satu Mare, înmatriculata sub nr. J30/1313/2005, înregistrata la Reg. C.C.I. Bihor, CIF RO18186896 tel. , având codul IBAN RO20 BRDE 310S V117 8477 3100 deschis la Banca Romana pentru Dezvoltare, reprezentată prin , în calitate de VANZATOR."}, {"name": "SALCAMUL VALEA LUI MIHAI SRL", "cui": "RO36226336", "regCom": "J30/589/2016", "iban": "RO26BRDE310SV59865613100deschislaBanc", "bank": "Banca Romana pentru Dezvoltare suc", "phone": "______________", "representative": "_______________________________________", "role": "VÂNZĂTOR", "fullText": "SALCAMUL VALEA LUI MIHAI SRL cu sediul/domiciliul în Carei , jud. Satu Mare, str. CALEA ARMATEI ROMANE NR 81B, înmatriculată sub nr. J30/589/2016, înregistrata la Reg. C.C.I. _____, CIF RO36226336 , tel./fax. ______________, având codul IBAN RO26 BRDE 310S V598 6561 3100 deschis la Banca Romana pentru Dezvoltare suc./ag.______________, reprezentată prin _______________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "RUBEN PREST SRL TARCEA", "cui": "RO7072810", "regCom": "J05/236/1995", "iban": "RO77BRDE050SV35091590500deschislaBRD", "bank": "BRD suc", "phone": "___________________________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "RUBEN PREST SRL TARCEA cu sediul/domiciliul în Tarcea nr. 160, jud. BIHOR înmatriculată sub nr J05/236/1995 înregistrata la Reg. C.C.I. , CIF RO7072810, tel./fax. ___________________________, având codul IBAN RO77 BRDE 050S V350 9159 0500 deschis la BRD suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "OROS OVIDIU PFA", "cui": "RO23735648", "regCom": "F05/604/2008", "iban": "", "bank": "Banca __________________ suc", "phone": "", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "OROS OVIDIU PFA cu sediul/domiciliul în Spinus, jud. Bihor, str. Nr.223 , înmatriculată sub nr. F05/604/2008, înregistrata la Reg. C.C.I. , CIF RO23735648 7 , tel./fax. , având codul IBAN ________________ deschis la Banca __________________ suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "CHIS IOAN FERMIER PFA", "cui": "RO35591520", "regCom": "F30/31/2016", "iban": "RO89CECESM0908RON0261664deschislaCEC", "bank": "CEC Bank suc", "phone": "______________", "representative": "________________________", "role": "VÂNZĂTOR", "fullText": "CHIS IOAN FERMIER PFA cu sediul/domiciliul în SAT ERIU SANCRAI, NR.364 JUD. Satu Mare , înmatriculată sub nr. F30/31/2016 , CIF RO35591520 , tel./fax. ______________, având codul IBAN RO89 CECE SM09 08RO N026 1664 deschis la CEC Bank suc./ag._____________________, reprezentată prin ________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "CZIRJAK ERIKA MAGDALENA", "cui": "", "regCom": "", "iban": "RO17CECEC001946286262911deschislaCECBank", "bank": "CEC Bank", "phone": "", "representative": "", "role": "VÂNZĂTOR", "fullText": "CZIRJAK ERIKA MAGDALENA cu sediul în Sacueni , STR. Crisana , NR.8, jud. Bihor, înmatriculata sub nr., înregistrata la Reg. C.C.I. Bihor, CIF CNP 2670505052888 tel. , având codul IBAN RO17CECEC001946286262911 deschis la CEC Bank , în calitate de VÂNZĂTOR."}, {"name": "ADAM MARIA", "cui": "", "regCom": "", "iban": "RO94CECEBH3508RON0386110deschislaBancaCE", "bank": "Banca CEC", "phone": "", "representative": "", "role": "VÂNZĂTOR", "fullText": "ADAM MARIA cu sediul în Sacueni ARANY JANOS 22/B , jud. Bihor, înmatriculata sub nr., înregistrata la Reg. C.C.I. Bihor, CIF CNP 2690524052890 . , având codul IBAN RO94CECEBH3508RON0386110 deschis la Banca CEC , în calitate de VÂNZĂTOR ."}, {"name": "HARIS EMERIC PFA", "cui": "RO34167357", "regCom": "", "iban": "RO84BTRLRONCRT0294320201deschislaBankaTr", "bank": "Banka Transilvania", "phone": "", "representative": "", "role": "VÂNZĂTOR", "fullText": "HARIS EMERIC PFA cu sediul în TEREBESTI, NR.83 , jud. Satu Mare, înmatriculata sub nr. F30/147/27.02.2015, înregistrata la Reg. C.C.I. Satu Mare , CIF RO34167357 , având codul IBAN RO84BTRLRONCRT0294320201 deschis la Banka Transilvania , în calitate de VÂNZĂTOR ."}, {"name": "nr. J05 /3212 /1994", "cui": "RO6122686", "regCom": "J05 /3212 /1994", "iban": "", "bank": "Raiffeisen", "phone": "", "representative": "_______________", "role": "VÂNZĂTOR", "fullText": "nr. J05 /3212 /1994, înregistrata la Reg. C.C.I. Satu Mare, CIF RO6122686, tel./fax , având codul IBANRO07 RZBR 0000 0600 0149 6007 deschis la Raiffeisen., reprezentată prin _______________ administrator, în calitate de VÂNZĂTOR."}, {"name": "SAMPAX SRL", "cui": "RO640492", "regCom": "J30/5/1991", "iban": "RO36BRDE310SV02578183100laBRDsuc", "bank": "", "phone": "_______", "representative": "Costin Ioan Mircea", "role": "VÂNZĂTOR", "fullText": "SAMPAX SRL cu sediul/domiciliul în SATU MARE, jud. SATU MARE, str. STR. DRUM CAREI NR160 , înmatriculată sub nr. J30/5/1991 , înregistrata la Reg. C.C.I. , CIF RO640492, tel./fax. _______, având codul IBAN RO36 BRDE 310S V025 7818 3100 la BRD _ suc./ag.______________________, reprezentată prin Costin Ioan Mircea administrator, în calitate de VÂNZĂTOR."}, {"name": "POP DANIEL AGRO I.I", "cui": "", "regCom": "F05/1426/2016", "iban": "RO36718894tel", "bank": "Banca Transilvania", "phone": "0740353044", "representative": "______________, CNP ___________________", "role": "VÂNZĂTOR", "fullText": "POP DANIEL AGRO I.I. cu sediul în SAT TARCEA NR 4, jud. Bihor, înmatriculata sub nr. F05/1426/2016 , înregistrata la Reg. C.C.I. RO36718894 tel. 0740353044, având codul IBAN RO65 BTRL RONC RT03 9743 2901 deschis la Banca Transilvania, reprezentată prin ______________, CNP ___________________, în calitate de VÂNZĂTOR."}, {"name": "AGROMEC SACUENI S.A", "cui": "RO111661", "regCom": "J05/670/1991", "iban": "RO25CECEBH0101RON0379675deschislaCEC", "bank": "CEC Bank", "phone": "", "representative": "", "role": "VÂNZĂTOR", "fullText": "AGROMEC SACUENI S.A. cu sediul în Sacueni , STR. IRINYI JANOS, NR.156, jud. Bihor, înmatriculata sub nr. J05/670/1991 , înregistrata la Reg. C.C.I. Bihor, CIF RO111661 tel. , având codul IBAN RO25 CECE BH01 01RO N037 9675 deschis la CEC Bank , reprezentată prin_ , în calitate de VÂNZĂTOR."}, {"name": "CALUGAR TIMEA NICAGRO I.I", "cui": "RO32714539", "regCom": "F30/54/2014", "iban": "RO26CECESM0230RON0429914deschislaCEC", "bank": "CEC BANK SA suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "CALUGAR TIMEA NICAGRO I.I. cu sediul/domiciliul în GHENCI NR.264, jud. Satu Mare, înmatriculată sub nr. F30/54/2014, înregistrata la Reg. C.C.I. , CIF RO32714539, tel./fax. ______________, având codul IBAN RO26 CECE SM02 30RO N042 9914 deschis la CEC BANK SA suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "SOC AGRIC.SPICUL BOIU", "cui": "RO109700", "regCom": "", "iban": "RO19RNCB0036022258430001deschislaBCRag", "bank": "BCR ag", "phone": "0746028234/0735545964", "representative": "KOVACS TIBOR-ISTVAN CNP 1700402057073 preşedinte", "role": "VANZATOR", "fullText": "SOC AGRIC.SPICUL BOIU cu sediul în Boiu nr. 439, jud. Bihor, înregistrată sub nr. 42/2001 la Jud. Salonta, CIF RO109700, tel. 0746028234/0735545964, având codul IBAN RO19RNCB0036022258430001 deschis la BCR ag. Salonta, reprezentat prin KOVACS TIBOR-ISTVAN CNP 1700402057073 preşedinte, în calitate de VANZATOR."}, {"name": "AGROMOLNAR SRL", "cui": "RO20762567", "regCom": "J05/176/2007", "iban": "RO20762567tel", "bank": "Banca Transilvania", "phone": "", "representative": "", "role": "VANZATOR", "fullText": "AGROMOLNAR SRL cu sediul în ADONI NR 15, jud. BIHOR, înmatriculata sub nr. J05/176/2007, înregistrata la Reg. C.C.I. Bihor, CIF RO20762567 tel. , având codul IBAN RO11 BTRL RONC RT02 1741 3901 deschis la Banca Transilvania , reprezentată prin , în calitate de VANZATOR."}, {"name": "MOLNAR CSONGOR ROLAND", "cui": "", "regCom": "", "iban": "RO60BTRLRONCRT0597808801deschislaBancaTr", "bank": "Banca Transilvania reprezentată prin asociat unic MOLNAR CSONGOR ROLAND", "phone": "", "representative": "asociat unic MOLNAR CSONGOR ROLAND", "role": "VÂNZĂTOR", "fullText": "MOLNAR CSONGOR ROLAND cu sediul în loc. JUD. BIHOR , VIISOARAI, NR.37 A4, înmatriculata sub nr. la Reg.C.C.I. , CIF CNP 1910523054754 , având codul IBAN RO60BTRLRONCRT0597808801 deschis la Banca Transilvania reprezentată prin asociat unic MOLNAR CSONGOR ROLAND , în calitate de VÂNZĂTOR."}, {"name": "CHIS IOAN ALEXANDRU I.I", "cui": "RO 35530808", "regCom": "F30/24/2016", "iban": "RO35530808tel", "bank": "Banca Transilvania", "phone": "", "representative": "", "role": "VANZATOR", "fullText": "CHIS IOAN ALEXANDRU I.I cu sediul în TASNAD STR. TRANDAFIRILOR NR, jud. BIHOR, înmatriculata sub nr. F30/24/2016 , înregistrata la Reg. C.C.I. Bihor, CIF RO 35530808 tel. , având codul IBAN RO40BTRLRONCRT0338423401 deschis la Banca Transilvania , reprezentată prin , în calitate de VANZATOR."}, {"name": "S.C. AGRODAV IMPEX S.R.L", "cui": "RO6463241", "regCom": "J05/4102/1994", "iban": "RO17BTRL00501202J57475XXdeschislaBanc", "bank": "Banca Transilvania ag", "phone": "0744513034", "representative": "ing. Dersidan Dan, CNP 1590724353959", "role": "VANZATOR", "fullText": "S.C. AGRODAV IMPEX S.R.L. cu sediul în Valea lui Mihai, str. Kosuth Lajos nr.66, jud. Bihor, înmatriculata sub nr. J05/4102/1994, înregistrata la Reg. C.C.I. Bihor, CIF RO6463241 tel. 0744513034, având codul IBAN RO17 BTRL 0050 1202 J574 75XX deschis la Banca Transilvania ag. Valea lui Mihai, reprezentată prin ing. Dersidan Dan, CNP 1590724353959, în calitate de VANZATOR."}, {"name": "S.C. H & G AGROPROD S.R.L", "cui": "RO6650720", "regCom": "J05/4995/1994", "iban": "RO19CARP005100496101RO01deschislaBanc", "bank": "Banca Carpatica ag", "phone": "0733929534", "representative": "ing. Gug Florian, CNP 1501016052859", "role": "VANZATOR", "fullText": "S.C. H & G AGROPROD S.R.L. cu sediul în Marghita, str. Nicolae Balcescu nr. 51/A, jud. Bihor, înmatriculata sub nr. J05/4995/1994, înregistrata la Reg. C.C.I. Bihor, CIF RO6650720 tel. 0733929534, având codul IBAN RO19 CARP 0051 0049 6101 RO01 deschis la Banca Carpatica ag. Marghita, reprezentată prin ing. Gug Florian, CNP 1501016052859, în calitate de VANZATOR."}, {"name": "S.C. AGROMEC AGRIȘ S.R.L", "cui": "RO8173309", "regCom": "J30/657/1996", "iban": "RO04BRDE310SV02619563100deschislaBRD", "bank": "BRD ag", "phone": "0744933611", "representative": "Buioer Eugen", "role": "VANZATOR", "fullText": "S.C. AGROMEC AGRIȘ S.R.L. cu sediul în Agriș, jud. Satu Mare, str. Principală FN, înmatriculată sub nr. J30/657/1996 la Reg. C.C.I. Satu Mare, CIF RO8173309, tel./fax. 0744933611, avand contul IBAN RO04 BRDE 310S V026 1956 3100 deschis la BRD ag. Botizului, reprezentată prin Buioer Eugen administrator, în calitate de VANZATOR."}, {"name": "Societatea Agricolă PETREŞTI", "cui": "RO648410", "regCom": "", "iban": "RO72RZBR0000060001473400deschislaRaif", "bank": "Raiffeisen ag", "phone": "0744570372", "representative": "ing. Mozer Francisc presedinte", "role": "VÂNZĂTOR", "fullText": "Societatea Agricolă PETREŞTI , cu sediul în Petreşti, jud. Satu Mare, str. Principală nr. 1, CIF RO648410, tel./fax. 0744570372, avand contul IBAN RO72 RZBR 0000 0600 0147 3400 deschis la Raiffeisen ag. Carei, reprezentată prin ing. Mozer Francisc presedinte, în calitate de VÂNZĂTOR."}, {"name": "S.C. SOLAMOND PROD S.R.L", "cui": "RO7160599", "regCom": "J05/350/1995", "iban": "RO90WBAN2511000050501139deschislaInte", "bank": "Intesa Sanpaolo ag", "phone": "0744512864", "representative": "ing. Panc Ionel", "role": "VANZATOR", "fullText": "S.C. SOLAMOND PROD S.R.L. cu sediul în Valea lui Mihai, str. Gheorghe Doja nr.3, jud. Bihor, înmatriculata sub nr. J05/350/1995, înregistrata la Reg. C.C.I. Bihor, CIF RO7160599 tel. 0744512864, având codul IBAN RO90 WBAN 2511 0000 5050 1139 deschis la Intesa Sanpaolo ag. Valea lui Mihai, reprezentată prin ing. Panc Ionel, în calitate de VANZATOR."}, {"name": "S.C. A B Agro Prod S.R.L", "cui": "RO17975387", "regCom": "J30/1065/2005", "iban": "RO17975387tel", "bank": "BCR ag", "phone": "0766236401", "representative": "ing. Ardelean Anton", "role": "VANZATOR", "fullText": "S.C. A B Agro Prod S.R.L. cu sediul în Moftinu Mare, nr. 479, jud. Satu Mare, înmatriculata sub nr. J30/1065/2005, înregistrata la Reg. C.C.I. Satu Mare, CIF RO17975387 tel. 0766236401, având codul IBAN RO74 RNCB 0222 0354 5967 0001 deschis la BCR ag. Carei, reprezentată prin ing. Ardelean Anton administrator, CNP 1580214300031, în calitate de VANZATOR."}, {"name": "SC GÂRDAN AGRO SRL", "cui": "RO22376988", "regCom": "J05/2244/2007", "iban": "RO22376988tel", "bank": "Intesa Sanpaolo România ag", "phone": "0741161859", "representative": "Gârdan Grigore Daniel, CNP 1800226054757", "role": "VANZATOR", "fullText": "SC GÂRDAN AGRO SRL cu sediul în Adoni, nr. 253, jud. Bihor, înmatriculata sub nr. J05/2244/2007, înregistrata la Reg. C.C.I. Bihor, CIF RO22376988 tel. 0741161859, având codul IBAN RO23 WBAN 2511 0000 580 1687 deschis la Intesa Sanpaolo România ag. Valea lui Mihai, reprezentată prin Gârdan Grigore Daniel, CNP 1800226054757, în calitate de VANZATOR."}, {"name": "S.C. AGROSTY S.R.L", "cui": "RO1690707678", "regCom": "J05/2037/2004", "iban": "RO1690707678tel", "bank": "BRD ag", "phone": "0728121277/0259365332", "representative": "Mal Cristian", "role": "VANZATOR", "fullText": "S.C. AGROSTY S.R.L. cu sediul în Suiug, str. Principală nr. 112, jud. Bihor, înmatriculata sub nr. J05/2037/2004, înregistrata la Reg. C.C.I. Bihor, CIF RO1690707678 tel. 0728121277/0259365332, având codul IBAN RO64 BRDE 050S V104 1505 0500 deschis la BRD ag. Marghita, reprezentată prin Mal Cristian administrator, CNP 1771212052863, în calitate de VANZATOR."}, {"name": "S.C. AGROERIK S.R.L", "cui": "RO28029783", "regCom": "J05/209/2011", "iban": "RO28029783tel", "bank": "Banca Transilvania ag", "phone": "0745916141", "representative": "administrator Oros Mircea-Ioan, CNP 1770420052878", "role": "VANZATOR", "fullText": "S.C. AGROERIK S.R.L. cu sediul în Suiug, str. Principală nr. 19, jud. Bihor, înmatriculata sub nr. J05/209/2011, înregistrata la Reg. C.C.I. Bihor, CIF RO28029783 tel. 0745916141, având codul IBAN RO54 BTRL 0050 1202 W006 50XX deschis la Banca Transilvania ag. Marghita, reprezentată prin administrator Oros Mircea-Ioan, CNP 1770420052878, în calitate de VANZATOR."}, {"name": "S.C. AGRO MADARIO S.R.L", "cui": "37154793", "regCom": "J5/398/2017", "iban": "RO38BTRLRONCRT0386662701deschislaBanc", "bank": "Banca Transilvania ag", "phone": "0744596367", "representative": "Dura Ioan Daniel CNP 1730826052851", "role": "VANZATOR", "fullText": "S.C. AGRO MADARIO S.R.L. cu sediul în sat Ciutelec, com. Tăuteu nr. 152, jud. Bihor, înmatriculata sub nr. J5/398/2017, înregistrata la Reg. C.C.I. Bihor, CIF 37154793, tel. 0744596367, având codul IBAN RO38 BTRL RONC RT03 8666 2701 deschis la Banca Transilvania ag. Marghita, reprezentată prin Dura Ioan Daniel CNP 1730826052851, în calitate de VANZATOR."}, {"name": "S.C. ATIAGRO S.R.L", "cui": "RO21492836", "regCom": "J05/857/2007", "iban": "RO20WBAN2511000090500058deschislaSanp", "bank": "Sanpaolo Imi Bank ag", "phone": "0740938243", "representative": "Nagy Attila", "role": "VANZATOR", "fullText": "S.C. ATIAGRO S.R.L., cu sediul in Săcuieni, jud. Bihor, str. Leta Mare nr. 40, înregistrata la C.C.I. Bihor, sub nr. J05/857/2007, CIF RO21492836, tel./fax. 0740938243, având contul IBAN RO20 WBAN 2511 0000 9050 0058 deschis la Sanpaolo Imi Bank ag. Valea lui Mihai, reprezentată prin Nagy Attila administrator, în calitate de VANZATOR."}, {"name": "S.C. AGROSILEX S.R.L", "cui": "RO7318967", "regCom": "J05/497/1995", "iban": "RO23RNCB0032m046492170001deschislaBCR", "bank": "BCR suc", "phone": "074589565", "representative": "ing. Erdei Dănuţ Eugen, CNP 1691213054659", "role": "VANZATOR", "fullText": "S.C. AGROSILEX S.R.L. cu sediul în Cenalos nr. 177, jud. Bihor, înmatriculata sub nr. J05/497/1995, înregistrata la Reg. C.C.I. Bihor, CIF RO7318967 tel. 074589565, având codul IBAN RO23 RNCB 0032m 0464 9217 0001 deschis la BCR suc. Oradea, reprezentată prin ing. Erdei Dănuţ Eugen, CNP 1691213054659, în calitate de VANZATOR."}, {"name": "S.C. ALE AGROZONE AVT S.R.L", "cui": "RO36874818", "regCom": "J30/1067/2016", "iban": "RO632RZBR0000060019135340deschislaRa", "bank": "Raiffeisen ag", "phone": "0745477240", "representative": "Constantin Oneţ", "role": "VÂNZĂTOR", "fullText": "S.C. ALE AGROZONE AVT S.R.L. cu sediul în Carei, jud. Satu Mare, str. Gheorghe Lazăr nr. 4, înmatriculată sub nr. J30/1067/2016 la Reg. C.C.I. Satu Mare, CIF RO36874818, tel./fax. 0745477240, avand contul IBAN RO632 RZBR 0000 0600 1913 5340 deschis la Raiffeisen ag. Carei, reprezentată prin Constantin Oneţ administrator, în calitate de VÂNZĂTOR."}, {"name": "S.C. IANCULEŞTI S.R.L", "cui": "RO24864594", "regCom": "J30/1564/2008", "iban": "RO18RZBR0000060014714484deschislaRaif", "bank": "Raiffeisen ag", "phone": "0745477240", "representative": "Voichița Oneţ", "role": "VÂNZĂTOR", "fullText": "S.C. IANCULEŞTI S.R.L. cu sediul în Carei, jud. Satu Mare, str. Gheorghe Lazăr nr. 4, înmatriculată sub nr. J30/1564/2008 la Reg. C.C.I. Satu Mare, CIF RO24864594, tel./fax. 0745477240, avand contul IBAN RO18 RZBR 0000 0600 1471 4484 deschis la Raiffeisen ag. Carei, reprezentată prin Voichița Oneţ administrator, în calitate de VÂNZĂTOR."}, {"name": "S.C. FARMLAND S.R.L", "cui": "RO19275134", "regCom": "J05/2541/2006", "iban": "RO51FNNB001702452073RO01deschislaCred", "bank": "Credit Europe Bank suc", "phone": "0259464121", "representative": "Mircea Ciobanu", "role": "VÂNZĂTOR", "fullText": "S.C. FARMLAND S.R.L. cu sediul În Tarcea, jud. Bihor, str. Mică nr. 174/B, înregistrata la C.C.I. Bihor, sub nr. J05/2541/2006, CIF RO19275134, tel./fax. 0259464121, având contul IBAN RO51 FNNB 0017 0245 2073 RO01 deschis la Credit Europe Bank suc. Oradea, reprezentat prin Mircea Ciobanu administrator, în calitate de VÂNZĂTOR."}, {"name": "S.C. ANDRAS ANIMAL FARM S.R.L", "cui": "37129102", "regCom": "J5/363/2017", "iban": "RO33BTRLRONCRT0386054601deschislaBanc", "bank": "Banca Transilvania suc", "phone": "", "representative": "", "role": "VANZATOR", "fullText": "S.C. ANDRAS ANIMAL FARM S.R.L. cu sediul în Oradea, str. Ion Luca Caragiale nr. 4, ap. 6 jud. Bihor, înmatriculata sub nr. J5/363/2017, înregistrata la Reg. C.C.I. Bihor, CUI 37129102, având codul IBAN RO33 BTRL RONC RT03 8605 4601 deschis la Banca Transilvania suc. Oradea, reprezentată de Ciobanu – Andrada Ioana administrator, CNP 2970124055077, în calitate de VANZATOR."}, {"name": "GABITAR SRL", "cui": "RO 12534614", "regCom": "", "iban": "RO12534614tel", "bank": "Banca Transilvania ag", "phone": "", "representative": "", "role": "VÂNZĂTOR", "fullText": "GABITAR SRL cu sediul în Valea lui Mihai str. Ady Endre nr.1, jud. Bihor, înmatriculata sub nr. J05/940/99, înregistrata la Reg. C.C.I. Bihor, CIF RO 12534614 tel. 0745-643098, având codul IBAN RO05 BTRL RONC RT02 3804 9401 deschis la Banca Transilvania ag. Valea lui Mihai, reprezentată prin , în calitate de VÂNZĂTOR."}, {"name": "FURTOS FLORICA PFA", "cui": "", "regCom": "F5/570/2012", "iban": "RO30BTRL00501202W82275XXdeschislaBANC", "bank": "BANCA TRANSILVANIA suc", "phone": "", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "FURTOS FLORICA PFA cu sediul/domiciliul FEGERNICU NOU, NR.26, jud. BIHOR, înmatriculată sub nr. F5/570/2012 , înregistrata la Reg. . , CIF RO RO29710499 , tel./fax. având codul IBAN RO30 BTRL 0050 1202 W822 75XX deschis la BANCA TRANSILVANIA suc./ag.__________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "SC INA AGRICULTURA VERDE SRL", "cui": "RO 30869693", "regCom": "J02/1216/2012", "iban": "", "bank": "", "phone": "", "representative": "Avram Alina Claudia-", "role": "VÂNZĂTOR", "fullText": "SC INA AGRICULTURA VERDE SRL cu sediul în com.Sofronea, jud. Arad , nr.592, înmatriculată sub nr. J02/1216/2012, CIF RO 30869693 , reprezentată prin Avram Alina Claudia-administrator, în calitate de VÂNZĂTOR."}, {"name": "SZABO CONST SRL", "cui": "RO21262195", "regCom": "J30/342/2007", "iban": "RO21262195tel", "bank": "Banca Romana de Dezvoltare", "phone": "", "representative": "", "role": "VANZATOR", "fullText": "SZABO CONST SRL cu sediul în Bogdand NR 61, jud.Satu Mare, înmatriculata sub nr. J30/342/2007 , înregistrata la Reg. C.C.I. Bihor, CIF RO21262195 tel. , având codul IBAN RO36BRDE310SV61817053100 deschis la Banca Romana de Dezvoltare , reprezentată prin , în calitate de VANZATOR."}, {"name": "HAR PAPI SRL", "cui": "RO23326937", "regCom": "J31 /165 /2008", "iban": "RO23326937tel", "bank": "Banca Comeriala Romana", "phone": "", "representative": "", "role": "VANZATOR", "fullText": "HAR PAPI SRL cu sediul în LOC. ULCIUG ORS. CEHU SILVANIEI, ULCIUG, NR.214, jud.Salaj, înmatriculata sub nr. J31 /165 /2008 , înregistrata la Reg. C.C.I. , CIF RO23326937 tel. , având codul IBAN RO05RNCB0215098152000001 deschis la Banca Comeriala Romana , reprezentată prin , în calitate de VANZATOR."}, {"name": "CONTEX SOC.AGR. SANISLAU", "cui": "", "regCom": "", "iban": "RO648763tel", "bank": "Raiffeisen Bank", "phone": "_____________", "representative": "______________, CNP ___________________", "role": "VÂNZĂTOR", "fullText": "CONTEX SOC.AGR. SANISLAU cu sediul în Sanislau nr . 562 ______, jud. Satu Mare, înmatriculata sub nr. J_________, înregistrata la Reg. C.C.I. RO648763__________ tel. _____________, având codul IBAN RO55 RZBR 0000 0600 0147 3415 deschis la Raiffeisen Bank , reprezentată prin ______________, CNP ___________________, în calitate de VÂNZĂTOR."}, {"name": "SC AVENA PRODCOMEXIM SRL", "cui": "RO 5431462", "regCom": "J05/1134/1994", "iban": "RO89RNCB0035022152090001deschislaBCR", "bank": "BCR", "phone": "", "representative": "Olah Sandor-", "role": "VÂNZĂTOR", "fullText": "SC AVENA PRODCOMEXIM SRL cu sediul/domiciliul în BUDUSLAU, jud. BIHOR, str. PRINCIPALA NR 10 , înmatriculată sub nr. J05/1134/1994 , înregistrata la Reg. C.C.I. , CIF RO 5431462, având codul RO89 RNCB 0035 0221 5209 0001 deschis la BCR, reprezentată prin Olah Sandor- administrator, în calitate de VÂNZĂTOR."}, {"name": "S.C. FERMA SZABO AGROTEH S.R.L", "cui": "RO33912526", "regCom": "J31/436/2014", "iban": "RO46RZBR0000060017372265deschislaRaif", "bank": "Raiffeisen Bank suc", "phone": "0745251094", "representative": "Szabo Adalbert - Adorian CNP 1780422311841", "role": "VÂNZĂTOR", "fullText": "S.C. FERMA SZABO AGROTEH S.R.L. cu sediul în Carastelec, jud. Sălaj, nr.14, cam.2, înmatriculată sub nr. J31/436/2014, înregistrata la Reg. C.C.I. Sălaj, CIF RO33912526, tel./fax. 0745251094, având codul IBAN RO46 RZBR 0000 0600 1737 2265 deschis la Raiffeisen Bank suc. Zalau, reprezentată prin Szabo Adalbert - Adorian CNP 1780422311841, în calitate de VÂNZĂTOR."}, {"name": "S.C. EURO TRANS PRODUCT S.R.L", "cui": "RO23360351", "regCom": "J31/178/2008", "iban": "RO20BRDE320SV07903623200deschislaBRD", "bank": "BRD suc", "phone": "0745251094", "representative": "Szabo Adalbert - Adorian CNP 1780422311841", "role": "VÂNZĂTOR", "fullText": "S.C. EURO TRANS PRODUCT S.R.L. cu sediul în Carastelec, jud. Sălaj, nr.14, înmatriculată sub nr. J31/178/2008, înregistrata la Reg. C.C.I. Sălaj, CIF RO23360351, tel./fax. 0745251094, având codul IBAN RO20 BRDE 320S V079 0362 3200 deschis la BRD suc. Zalau, reprezentată prin Szabo Adalbert - Adorian CNP 1780422311841, în calitate de VÂNZĂTOR."}, {"name": "OLAH JOZSEF I.I", "cui": "RO19563323", "regCom": "F05/1110/2006", "iban": "", "bank": "_________________", "phone": "", "representative": "Olah Jozsef", "role": "VÂNZĂTOR", "fullText": "OLAH JOZSEF I.I. cu sediul în Loc Tamasau NR.1A, jud. Bihor, înmatriculată sub nr. F05/1110/2006 , înregistrata la Reg. C.C.I. Bihor, CIF RO19563323, tel./fax. , având codul IBAN deschis la _________________, reprezentată prin Olah Jozsef administrator, în calitate de VÂNZĂTOR ."}, {"name": "JAKO ATTILA ELEK Intreprindere Individuala", "cui": "RO25734665", "regCom": "F05/1084/2009", "iban": "RO25734665tel", "bank": "Banca Transilvania ag", "phone": "0744676522", "representative": "Jako Attila, CNP 1820814054754", "role": "VANZATOR", "fullText": "JAKO ATTILA ELEK Intreprindere Individuala cu sediul în Chesereu, nr. 306, jud. Bihor, înmatriculata sub nr. F05/1084/2009, înregistrata la Reg. C.C.I. Bihor, CIF RO25734665 tel. 0744676522, având codul IBAN RO26 BTRL 0050 1202 R238 54XX deschis la Banca Transilvania ag. Valea lui Mihai, reprezentată prin Jako Attila, CNP 1820814054754, în calitate de VANZATOR."}, {"name": "SZABO J BEATA I.I", "cui": "RO32467145", "regCom": "F30/1091/2013", "iban": "RO09BRDE310SV61742903100deschislaBRD", "bank": "BRD S", "phone": "0763993635", "representative": "Szabo Beata", "role": "VÂNZĂTOR", "fullText": "SZABO J BEATA I.I. cu sediul în loc. Ser nr.240, jud. Satu Mare, înmatriculată sub nr. F30/1091/2013, înregistrata la Reg. C.C.I. Satu Mare, CIF RO32467145, tel./fax. 0763993635, având codul IBAN RO09 BRDE 310S V617 4290 3100 deschis la BRD S.A., reprezentată prin Szabo Beata administrator, în calitate de VÂNZĂTOR."}, {"name": "SEMAGRI S.R.L", "cui": "RO29106191", "regCom": "J05/1647/2011", "iban": "RO70BTRL00501202W48730XXdeschislaBanc", "bank": "Banca Transilvania", "phone": "________________", "representative": "________________", "role": "VÂNZĂTOR", "fullText": "SEMAGRI S.R.L. cu sediul în loc. Sanicolau Roman sat Berechiu nr.165, jud.Bihor, înmatriculată sub nr. J05/1647/2011, înregistrata la Reg. C.C.I. Satu Mare, CIF RO29106191, tel./fax.________________ , având codul IBAN RO70 BTRL 0050 1202 W487 30XX deschis la Banca Transilvania., reprezentată prin ________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "S.C. CSORBA AGRO S.R.L", "cui": "RO18226141", "regCom": "J05/2528/2005", "iban": "RO18226141tel", "bank": "BRD ag", "phone": "0744299344", "representative": "Csorba Attila- Stefan", "role": "VANZATOR", "fullText": "S.C. CSORBA AGRO S.R.L. cu sediul în Cheşereu, nr. 97, jud. Bihor, înmatriculata sub nr. J05/2528/2005, înregistrata la Reg. C.C.I. Bihor, CIF RO18226141 tel. 0744299344, având codul IBAN RO71 BRDE 050S V347 3184 0500 deschis la BRD ag. Valea lui Mihai, reprezentată prin Csorba Attila- Stefan, în calitate de VANZATOR."}, {"name": "S.C. KCOVBEL AGRO S.R.L", "cui": "RO9891706", "regCom": "J05/1483/1997", "iban": "RO71BTRL00501202J57464XXdeschislaBanc", "bank": "Banca Transilvania ag", "phone": "0745638657", "representative": "Kovacs Bela", "role": "VANZATOR", "fullText": "S.C. KCOVBEL AGRO S.R.L. cu sediul în Adoni, com. Tarcea, nr. 271, jud. Bihor, înmatriculata sub nr. J05/1483/1997, înregistrata la Reg. C.C.I. Bihor, CIF RO9891706 tel. 0745638657, având codul IBAN RO71 BTRL 0050 1202 J574 64XX deschis la Banca Transilvania ag. Valea lui Mihai, reprezentată prin Kovacs Bela administrator, CNP 1730305052874, în calitate de VANZATOR."}, {"name": "Moldovan Vlad Ovidiu Î.I", "cui": "RO34557473", "regCom": "F30/382/2015", "iban": "RO26CECESM1030RON0460594deschislaCEC", "bank": "CEC Bank suc", "phone": "0751057796", "representative": "Moldovan Vlad Ovidiu", "role": "VANZATOR", "fullText": "Moldovan Vlad Ovidiu Î.I. cu sediul în Mădăras nr. 13, jud. Satu Mare, înmatriculată sub nr. F30/382/2015, înregistrata la Reg. C.C.I. Satu Mare, CIF RO34557473, tel./fax. 0751057796, având codul IBAN RO26 CECE SM10 30RO N046 0594 deschis la CEC Bank suc. Satu Mare, reprezentată prin Moldovan Vlad Ovidiu, în calitate de VANZATOR."}, {"name": "Chiş Bianca Florica P.F.A", "cui": "RO35071101", "regCom": "F30/643/2015", "iban": "RO13BRDE310SV57597043100deschislaBRD", "bank": "BRD suc", "phone": "0742935412", "representative": "Chiş Bianca Florica", "role": "VANZATOR", "fullText": "Chiş Bianca Florica P.F.A. cu sediul în Mădăras nr. 98, jud. Satu Mare, înmatriculată sub nr. F30/643/2015, înregistrata la Reg. C.C.I. Satu Mare, CIF RO35071101, tel./fax. 0742935412, având codul IBAN RO13 BRDE 310S V575 9704 3100 deschis la BRD suc. Satu Mare, reprezentată prin Chiş Bianca Florica. în calitate de VANZATOR."}, {"name": "PRIETENIA SOC.AGR.TIREAM", "cui": "RO 4376327", "regCom": "", "iban": "RO42BTRL03101202C51517XXDESCHISLABANCATR", "bank": "BANCA TRANSILVANIA suc", "phone": "_______", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "PRIETENIA SOC.AGR.TIREAM cu sediul/domiciliul în TIREAM, jud. SATU MARE , STR VEZENDIULUI 311/A , înmatriculată sub nr. HJ3/SA/1993, înregistrata la Reg. C.C.I. , CIF RO 4376327, tel./fax. _______, având codul IBAN RO42BTRL03101202C51517XX_DESCHIS LA BANCA TRANSILVANIA suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "NAGY BARNABA SRL", "cui": "RO11094957", "regCom": "J05/979/1998", "iban": "RO36BRDE050SV02859310500deschislaBRD", "bank": "BRD suc", "phone": "_______", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "NAGY BARNABA SRL cu sediul/domiciliul în TARCEA NR. 66, jud. BIHOR, str. _____________ nr. _207/A, înmatriculată sub nr. J05/979/1998, înregistrata la Reg. C.C.I. , CIF RO11094957, tel./fax. _______, având codul IBAN RO36 BRDE 050S V028 5931 0500 deschis la BRD suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "BOCSKAI BIHOR AGRO SRL", "cui": "RO 16131827", "regCom": "J05/198/2004", "iban": "RO51RNCB0035022178070001deschislaBCR", "bank": "BCR _ suc", "phone": "_______", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "BOCSKAI BIHOR AGRO SRL cu sediul/domiciliul în SALACEA, jud. BIHOR, str. _____________ nr. _____, înmatriculată sub nr. J05/198/2004 , înregistrata la Reg. C.C.I. , CIF RO 16131827, tel./fax. _______, având codul IBAN RO51 RNCB 0035 0221 7807 0001 deschis la BCR _ suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "ALCONOR COMPANY SRL", "cui": "RO12381480", "regCom": "J05/198/2004", "iban": "RO71BRDE310SV02241863100deschislaBRD", "bank": "BRD _ suc", "phone": "_______", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "ALCONOR COMPANY SRL cu sediul/domiciliul în CAREI, jud. SATU MARE, str. ALEXANDRU IOAN CUZA NR.27 , înmatriculată sub nr. J05/198/2004 , înregistrata la Reg. C.C.I. , CIFRO12381480, tel./fax. _______, având codul IBAN RO71 BRDE 310S V022 4186 3100deschis la BRD _ suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "AGRO LEG SRL", "cui": "RO 13357286", "regCom": "J24/1659/2005", "iban": "RO83BTRLRONCRT0431643701laBANCATRANSI", "bank": "", "phone": "_______", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "AGRO LEG SRL cu sediul/domiciliul în BAIA MARE, jud. MARAMURES, str. PALTINISULUI 1A , înmatriculată sub nr. J24/1659/2005, înregistrata la Reg. C.C.I. , CIF RO 13357286, tel./fax. _______, având codul IBAN RO83BTRL RONC RT04 3164 3701 la BANCA TRANSILVANIA _ suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "VALEA IERULUI SOC AGR SACUIENI", "cui": "RO3468341", "regCom": "", "iban": "RO90RZBR0000060001478217deschislaRaif", "bank": "Raiffeisen suc", "phone": "059/352171", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "VALEA IERULUI SOC AGR SACUIENI cu sediul/domiciliul în Săcuieni, str. Morii nr.34, jud. BIHOR înmatriculată sub nr. ................, înregistrata la Reg. C.C.I. , CIF RO3468341, tel./fax. 059/352171, având codul IBAN RO90 RZBR 0000 0600 0147 8217 deschis la Raiffeisen suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "UNIREA SOC.AGR. BOIU", "cui": "RO 109696", "regCom": "", "iban": "RO80BTRLRONCRT0412080601deschislaBancaTr", "bank": "Banca Transilvania", "phone": "________________", "representative": "________________", "role": "VÂNZĂTOR", "fullText": "UNIREA SOC.AGR. BOIU cu sediul în loc. BOIU NR 439, jud.Bihor, înmatriculată sub nr. HJ36/1992, înregistrata la Reg. C.C.I. Satu Mare, CIF RO 109696 , tel./fax.________________ , având codul IBAN RO80BTRLRONCRT0412080601 deschis la Banca Transilvania, reprezentată prin ________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "UNIREA SA", "cui": "RO3657782", "regCom": "", "iban": "RO02BTRLRONCRT0367837201deschislaBancaTr", "bank": "Banca Transilvania", "phone": "0261873608", "representative": "", "role": "VÂNZĂTOR", "fullText": "UNIREA SA . cu sediul în Tiream STR VEZENDIULUI NR 3, jud. Satu Mare, înmatriculată sub nr. J30/318/93 la Reg. C.C.I. Bihor, CIF RO3657782, tel./fax. 0261873608, avand codul IBAN RO02BTRLRONCRT0367837201 deschis la Banca Transilvania , în calitate de VÂNZĂTOR."}, {"name": "HEIKENS FARM SRL", "cui": "RO39141978", "regCom": "J05/779/2018", "iban": "RO70BTRLRONCRT0580468901deschislaBancaTr", "bank": "Banca Transilvania suc", "phone": "______________", "representative": "Ruud Lucas Heikens", "role": "VÂNZĂTOR", "fullText": "HEIKENS FARM SRL cu sediul/domiciliul în Salonta , jud.Bihor, str. STR. KISS FERENC, NR.6, înmatriculată sub nr. J05/779/2018 , înregistrata la Reg. C.C.I. ____________________, CIF RO39141978 , tel./fax. ______________, având codul IBAN RO70BTRLRONCRT0580468901 deschis la Banca Transilvania suc./ag.______________________, reprezentată prin Ruud Lucas Heikens administrator, în calitate de VÂNZĂTOR."}, {"name": "NEDROSIMAGRO SRL", "cui": "RO21795252", "regCom": "J05/1320/2007", "iban": "RO14BTRLRONCRT0580463701deschislaBancaTr", "bank": "Banca Transilvania", "phone": "________________", "representative": "Kadar Tiberiu", "role": "VÂNZĂTOR", "fullText": "NEDROSIMAGRO SRL cu sediul în loc. ORADEA STR.AUREL LAZAR NR.11 AP.3, jud.Bihor, înmatriculată sub nr. J05/1320/2007, înregistrata la Reg. C.C.I. Satu Mare, CIF RO21795252 , tel./fax.________________ , având codul IBAN RO14BTRLRONCRT0580463701 deschis la Banca Transilvania, reprezentată prin Kadar Tiberiu administrator, în calitate de VÂNZĂTOR."}, {"name": "KOKA AGRO SRL", "cui": "RO27026878", "regCom": "J05/731/2010", "iban": "RO05BRDE050SV82008050500deschislaBRD", "bank": "BRD suc", "phone": "___________________________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "KOKA AGRO SRL cu sediul/domiciliul în Tarcea nr. 160, jud. BIHOR înmatriculată sub nr J05/731/2010 înregistrata la Reg. C.C.I. , CIF RO27026878, tel./fax. ___________________________, având codul IBAN RO05 BRDE 050S V820 0805 0500 deschis la BRD suc./ag.______________________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "S.C. AGROPETRA S.R.L", "cui": "RO17178690", "regCom": "J30/119/2005", "iban": "RO70RNCB0221054210660001deschislaBanc", "bank": "Banca Comercială S", "phone": "079247473/0261778419", "representative": "Erdei Robert", "role": "VANZATOR", "fullText": "S.C. AGROPETRA S.R.L. cu sediul în Satu Mare, jud. Satu Mare, Str. Independenței bl.UH46, ap.7, înmatriculată sub nr. J30/119/2005, înregistrata la Reg. C.C.I. Satu Mare, CIF RO17178690, tel./fax. 079247473/0261778419, având codul IBAN RO70 RNCB 0221 0542 1066 0001 deschis la Banca Comercială S.A. suc. Satu Mare, reprezentată prin Erdei Robert administrator CNP 1780709301972, în calitate de VANZATOR."}, {"name": "DUNCA PETRU", "cui": "", "regCom": "", "iban": "", "bank": "_________________", "phone": "________________", "representative": "Dunca Petru", "role": "VÂNZĂTOR", "fullText": "DUNCA PETRU cu sediul în loc.Giulesti NR.448, jud.Maramures, înmatriculată sub nr. , înregistrata la Reg. C.C.I. Satu Mare, CIF CNP 1940830244492, tel./fax.________________ , având codul IBAN ___________________ deschis la _________________., reprezentată prin Dunca Petru administrator, în calitate de VÂNZĂTOR."}, {"name": "S.C. CHAMPIONS COM S.R.L", "cui": "RO6223664", "regCom": "J05/3447/1994", "iban": "RO77RZBR0000060004559753deschislaRaif", "bank": "Raiffeisen ag", "phone": "0744172632", "representative": "Bajnok Iosif", "role": "VANZATOR", "fullText": "S.C. CHAMPIONS COM S.R.L. cu sediul în Marghita, str. Independenţei nr.14, bloc D, ap. 12, jud. Bihor, înmatriculata sub nr. J05/3447/1994, înregistrata la Reg. C.C.I. Bihor, CIF RO6223664 tel. 0744172632, având codul IBAN RO77 RZBR 0000 0600 0455 9753 deschis la Raiffeisen ag. Marghita, reprezentată prin Bajnok Iosif administrator, CNP 1690107052875, în calitate de VANZATOR."}, {"name": "Hiri Zoltan Persoana Fizica Autorizata", "cui": "RO20080578", "regCom": "F05/824/2006", "iban": "RO88RNCB0035051220100001deschislaBCR", "bank": "BCR ag", "phone": "0745628902", "representative": "Hiri Zoltan CNP 1740503052866", "role": "VANZATOR", "fullText": "Hiri Zoltan Persoana Fizica Autorizata cu sediul în Viisoara, nr. 239, jud. Bihor, înmatriculata sub nr. F05/824/2006 la Reg. C.C.I. Bihor, CIF RO20080578, tel. 0745628902, având codul IBAN RO88 RNCB 0035 0512 2010 0001 deschis la BCR ag. Marghita, reprezentată prin Hiri Zoltan CNP 1740503052866, în calitate de VANZATOR."}, {"name": "VERES CIPRIAN IONUT PFA", "cui": "RO29743313", "regCom": "", "iban": "RO79CECEBH0730RON0623020deschislaCEC", "bank": "CEC Bank ag", "phone": "0749768906", "representative": "administrator", "role": "VÂNZĂTOR", "fullText": "VERES CIPRIAN IONUT PFA cu sediul în Chişlaz, jud. Bihor, nr. 90, înmatriculată sub nr. la Reg. C.C.I. Bihor, CIF RO29743313 , tel./fax. 0749768906, avand contul IBAN RO79 CECE BH07 30RO N062 3020 deschis la CEC Bank ag. Decebal Oradea, reprezentată prin administrator în calitate de VÂNZĂTOR."}, {"name": "JOLTA RAFAEL PFA", "cui": "38989032", "regCom": "F05/549/2018", "iban": "RO77BTRLRONCRT0621612101deschislaBANCATr", "bank": "BANCA Transilvania", "phone": "0744208672", "representative": "_______________", "role": "VANZATOR", "fullText": "JOLTA RAFAEL PFA cu sediul în VIISOARA, NR.300 , jud. Bihor, înmatriculata sub nr. F05/549/2018 la Reg. C.C.I. Bihor, CIF 38989032, tel. 0744208672, având codul IBAN RO77BTRLRONCRT0621612101 deschis la BANCA Transilvania, reprezentată prin _______________, în calitate de VANZATOR."}, {"name": "MOISE A .CRISTIAN PFA", "cui": "RO29477599", "regCom": "F05/2336/2011", "iban": "RO29477599tel", "bank": "Raiffeisen Bank ag", "phone": "0745773969", "representative": "Moisa Augustin, CNP 1510122311830", "role": "VÂNZĂTOR", "fullText": "MOISE A .CRISTIAN PFA. cu sediul în Balc, str. Petofi Sandor nr. 52, jud. Bihor, înmatriculata sub nr. F05/2336/2011, înregistrata la Reg. C.C.I. Bihor, CIF RO29477599 tel. 0745773969, având codul IBAN RO56 RZBR 0000 0600 1437 1972 deschis la Raiffeisen Bank ag. Marghita, reprezentată prin Moisa Augustin, CNP 1510122311830 , administrator, în calitate de VÂNZĂTOR."}, {"name": "S.C. UNIREA GIUNGI S.R.L", "cui": "RO18387431", "regCom": "J30/137/2006", "iban": "RO19RNCB0221043047950001deschislaBanc", "bank": "Banca Comercială S", "phone": "0744627521", "representative": "Micle Ioan-Liviu", "role": "VANZATOR", "fullText": "S.C. UNIREA GIUNGI S.R.L. cu sediul în Giungi, jud. Satu Mare, nr. 150, înmatriculată sub nr. J30/137/2006, înregistrata la Reg. C.C.I. Satu Mare, CIF RO18387431, tel./fax. 0744627521, având codul IBAN RO19 RNCB 0221 0430 4795 0001 deschis la Banca Comercială S.A. suc. Satu Mare, reprezentată prin Micle Ioan-Liviu administrator CNP 1700130242543, în calitate de VANZATOR."}, {"name": "DUNCA MARIA", "cui": "", "regCom": "", "iban": "", "bank": "", "phone": "", "representative": "Dunca Maria", "role": "VANZATOR", "fullText": "DUNCA MARIA cu sediul în Feresti nr.13/A , jud. Maramures, înmatriculată sub nr. la Reg. C.C.I. Bihor, CIF CNP 2730205241645 , tel./fax. , avand contul IBAN _________________ deschis la________________ , reprezentată prin Dunca Maria administrator în calitate de VANZATOR."}, {"name": "DUNCA VASILE", "cui": "", "regCom": "", "iban": "", "bank": "", "phone": "", "representative": "Dunca Vasile", "role": "VANZATOR", "fullText": "DUNCA VASILE cu sediul în Feresti nr.13/A , jud. Maramures, înmatriculată sub nr. la Reg. C.C.I. Bihor, CIF CNP 1700307241631 , tel./fax. , avand contul IBAN _________________ deschis la________________ , reprezentată prin Dunca Vasile administrator în calitate de VANZATOR. ."}, {"name": "ERDEI ADORITA P.F.A", "cui": "RO38787483", "regCom": "F30/47/2018", "iban": "RO76CECESM1030RON0498731deschislaCECBNK", "bank": "CEC BNK", "phone": "07414995053", "representative": "Erdei Adorita", "role": "VANZATOR", "fullText": "ERDEI ADORITA P.F.A. cu sediul în Ghirișa nr.191, jud. Satu Mare, înmatriculată sub nr. F30/47/2018, înregistrata la Reg. C.C.I. Satu Mare, CIF RO38787483, tel./fax. 07414995053, având codul IBAN RO76CECESM1030RON0498731 deschis la CEC BNK, reprezentată prin Erdei Adorita, în calitate de VANZATOR."}, {"name": "S.C. DERGAVA LAND S.R.L", "cui": "RO45945900", "regCom": "J05/945/2022", "iban": "RO45945900tel", "bank": "Banca Transilvania ag", "phone": "0744513034", "representative": "ing. _________________, CNP ____________", "role": "VÂNZĂTOR", "fullText": "S.C. DERGAVA LAND S.R.L. cu sediul în Valea lui Mihai, str.Kosuth Lajos, nr.54, jud. Bihor, înmatriculata sub nr. J05/945/2022, înregistrata la Reg. C.C.I. Bihor, CIF RO45945900 tel. 0744513034, având codul RO33BTRLRONCRT0CG4989201 deschis la Banca Transilvania ag. Valea lui Mihai, reprezentată prin ing. _________________, CNP ____________, în calitate de VÂNZĂTOR."}, {"name": "S.C. SALCÂMUL VALEA LUI MIHAI S.R.L", "cui": "RO36226336", "regCom": "J30/589/2016", "iban": "RO36226336tel", "bank": "BRD ag", "phone": "0745612874", "representative": "Rizo Paul", "role": "VANZATOR", "fullText": "S.C. SALCÂMUL VALEA LUI MIHAI S.R.L. cu sediul în Carei, calea Armatei Române nr. 81/B, jud. Satu Mare, înmatriculata sub nr. J30/589/2016, înregistrata la Reg. C.C.I. Satu Mare, CIF RO36226336 tel. 0745612874, având codul IBAN RO26 BRDE 310S V598 6561 3100 deschis la BRD ag. Carei, reprezentată prin Rizo Paul director, în calitate de VANZATOR."}, {"name": "VITI-MITI FARM SRL", "cui": "RO30947236", "regCom": "J31/504/2012", "iban": "", "bank": "", "phone": "", "representative": "_____________________", "role": "VÂNZĂTOR", "fullText": "VITI-MITI FARM SRL cu sediul în Zalau 22 DECEMBRIE 1989 jud. Salaj, înmatriculată sub nr. J31/504/2012, înregistrata la Reg. C.C.I. Satu Mare, CIF RO30947236 , având codul IBAN ____________________ deschis la______________ , reprezentată prin _____________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "KOCSIS A PAUL I.F", "cui": "RO17494847", "regCom": "F30/633/2005", "iban": "RO78BTRLRONCRT0299755801deschislaBANCATR", "bank": "BANCA TRANSILVANIA ag", "phone": "", "representative": "_____________________", "role": "VÂNZĂTOR", "fullText": "KOCSIS A PAUL I.F. cu sediul în Turulung,str.Viisoara nr.750 jud. Satu Mare, înmatriculată sub nr. F30/633/2005, înregistrata la Reg. C.C.I. Satu Mare, CIF RO17494847 , având codul IBAN RO78BTRLRONCRT0299755801 deschis la BANCA TRANSILVANIA ag. Ardud, reprezentată prin _____________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "S.C. DELAGRO FARM S.R.L", "cui": "RO25921817", "regCom": "J05/1073/2009", "iban": "RO25921817tel", "bank": "Banca Transilvania ag", "phone": "0744513034", "representative": "ing. Dersidan Vlad Bogdan, CNP 1830903350025", "role": "VANZATOR", "fullText": "S.C. DELAGRO FARM S.R.L. cu sediul în Văşad nr. 283, jud. Bihor, înmatriculata sub nr. J05/1073/2009, înregistrata la Reg. C.C.I. Bihor, CIF RO25921817 tel. 0744513034, având codul IBAN RO72 BTRL 0050 1202 R238 59XX deschis la Banca Transilvania ag. Valea lui Mihai, reprezentată prin ing. Dersidan Vlad Bogdan, CNP 1830903350025, în calitate de VANZATOR."}, {"name": "S.C. ROSEVA PRODIMPEX S.R.L", "cui": "RO5232052", "regCom": "J05/723/1994", "iban": "RO86BRDE050SV02752580500deschislaBRD", "bank": "BRD ag", "phone": "0745655959", "representative": "Moisa Augustin, CNP 1510122311830", "role": "VANZATOR", "fullText": "S.C. ROSEVA PRODIMPEX S.R.L. cu sediul în Balc, str. Petofi Sandor nr. 35, bloc SMA, ap.1, jud. Bihor, înmatriculata sub nr. J05/723/1994, înregistrata la Reg. C.C.I. Bihor, CIF RO5232052 tel. 0745655959, având codul IBAN RO86 BRDE 050S V027 5258 0500 deschis la BRD ag. Marghita, reprezentată prin Moisa Augustin, CNP 1510122311830, în calitate de VANZATOR."}, {"name": "S.C. AGRODAN & DIA S.R.L", "cui": "RO18487295", "regCom": "J05/561/2006", "iban": "RO18487295tel", "bank": "BCR ag", "phone": "0724696062", "representative": "Buta Dan CNP 165062550020", "role": "VANZATOR", "fullText": "S.C. AGRODAN & DIA S.R.L. cu sediul în Abram, nr.3, etaj 1, ap.2, jud. Bihor, înmatriculata sub nr. J05/561/2006, înregistrata la Reg. C.C.I. Bihor, CIF RO18487295 tel. 0724696062, având codul IBAN RO44 RNCB 0035 0297 3548 0001 deschis la BCR ag. Marghita, reprezentată prin Buta Dan CNP 165062550020, în calitate de VANZATOR."}, {"name": "S.C. AGRIBEN S.R.L", "cui": "RO21492151", "regCom": "J30/494/2007", "iban": "RO60BTRL03101202W61806XXdeschislaBanc", "bank": "Banca Transilvania S", "phone": "0261865928/0720538608", "representative": "Marian Olga imputernicit/", "role": "VANZATOR", "fullText": "S.C. AGRIBEN S.R.L. cu sediul în Carei, jud. Satu Mare, calea Armatei Române nr. 78, înmatriculată sub nr. J30/494/2007, înregistrata la Reg. C.C.I. Satu Mare, CIF RO21492151, tel./fax. 0261865928/0720538608, având codul IBAN RO60 BTRL 0310 1202 W618 06XX deschis la Banca Transilvania S.A. ag. Carei, reprezentată prin Marian Olga imputernicit/administrator CNP 2600518300011, în calitate de VANZATOR."}, {"name": "S.C. FIZOLAR FRUCT S.R.L", "cui": "RO36412550", "regCom": "J30/731/2016", "iban": "RO89BTRLRONCRT0359394501deschislaBanc", "bank": "Banca Transilvania", "phone": "0745916796", "representative": "Fleisz Zoltan împuternicit prin procura specială 4332/05.10.2016", "role": "VANZATOR", "fullText": "S.C. FIZOLAR FRUCT S.R.L. cu sediul în Căpleni, nr.135, jud. Sălaj, înmatriculată sub nr. J30/731/2016 la Reg. C.C.I. Satu Mare, CIF RO36412550, tel./fax. 0745916796, avand codul IBAN RO89 BTRL RONC RT03 5939 4501 deschis la Banca Transilvania, reprezentată prin Fleisz Zoltan împuternicit prin procura specială 4332/05.10.2016, în calitate de VANZATOR."}, {"name": "JULA IOAN DOREL", "cui": "", "regCom": "", "iban": "RO08CECESM0208RON0358982deschislaCEC", "bank": "CEC Bank", "phone": "", "representative": "JULA IOAN DOREL", "role": "VÂNZĂTOR", "fullText": "JULA IOAN DOREL cu sediul în GHENCI NR.102, jud. Satu Mare , înmatriculata sub nr., înregistrata la Reg. C.C.I. Bihor, CNP 1610713300011 tel. , având codul IBAN RO08 CECE SM02 08RO N035 8982 deschis la CEC Bank , reprezentată prin JULA IOAN DOREL , în calitate de VÂNZĂTOR."}, {"name": "S.C. AGROLAND EMA SERV S.R.L", "cui": "RO29429249", "regCom": "J30/698/2015", "iban": "RO36RZBR0000060014418989deschislaBanc", "bank": "Banca Raiffeisen ag", "phone": "0743813198", "representative": "Nicușor Carpen mandatat (811/22.02.2016)", "role": "VANZATOR", "fullText": "S.C. AGROLAND EMA SERV S.R.L. cu sediul in sat Gelu, com. Terebești nr. 149, jud. Satu Mare, înmatriculată sub nr. J30/698/2015 la Reg. C.C.I. Satu Mare, CIF RO29429249, tel./fax. 0743813198, având codul IBAN RO36 RZBR 0000 0600 1441 8989 deschis la Banca Raiffeisen ag. Soarelui, reprezentată prin Nicușor Carpen mandatat (811/22.02.2016), in calitate de VANZATOR."}, {"name": "S.C. AGROSOL S.R.L", "cui": "RO23366044", "regCom": "J30/305/2008", "iban": "RO89BRDE310SV20480413100deschislaBRD", "bank": "BRD suc", "phone": "0740576521/0361809220", "representative": "Moise Dan", "role": "VANZATOR", "fullText": "S.C. AGROSOL S.R.L. cu sediul în Eriu Sâncrai, jud. Satu Mare, nr. 133, înmatriculată sub nr. J30/305/2008, înregistrata la Reg. C.C.I. Satu Mare, CIF RO23366044, tel./fax. 0740576521/0361809220, având codul IBAN RO89 BRDE 310S V204 8041 3100 deschis la BRD suc. Satu Mare, reprezentată prin Moise Dan administrator CNP 170819300024, în calitate de VANZATOR."}, {"name": "S.C. AGZO MOFTINU MIC S.R.L", "cui": "RO15112549", "regCom": "J30/667/2002", "iban": "RO79RZBR0000060003129549deschislaRaif", "bank": "Raifaissen ag", "phone": "0741040718", "representative": "Boszormenyi Istvan CNP 1580702300012", "role": "VANZATOR", "fullText": "S.C. AGZO MOFTINU MIC S.R.L. cu sediul în Moftinu Mic nr. 137, jud. Satu Mare, înmatriculata sub nr. J30/667/2002 la Reg. C.C.I. Satu Mare, CIF RO15112549, tel. 0741040718, având codul IBAN RO79 RZBR 0000 0600 0312 9549 deschis la Raifaissen ag. Carei, reprezentată prin Boszormenyi Istvan CNP 1580702300012, în calitate de VANZATOR."}, {"name": "S.C. TARCEA AGRO S.R.L", "cui": "RO5120296", "regCom": "", "iban": "RO36BTRLRONCRT0354353201deschislaBanc", "bank": "Banca Transilvania", "phone": "0259464121", "representative": "Ciobanu Mircea", "role": "VANZATOR", "fullText": "S.C. TARCEA AGRO S.R.L. cu sediul in Tarcea, jud. Bihor, str. Mică nr. 174/B, înregistrata la C.C.I. Bihor, sub nr. J05/216/94, CIF RO5120296, tel./fax. 0259464121, având contul bancar IBAN RO36 BTRL RONC RT03 5435 3201 deschis la Banca Transilvania, reprezentat prin Ciobanu Mircea administrator, în calitate de VANZATOR."}, {"name": "S.C. FRAHEN AGRO S.R.L", "cui": "RO25164165", "regCom": "J05/283/2009", "iban": "RO25164165tel", "bank": "BRD ag", "phone": "0742381554", "representative": "Hengye Istvan", "role": "VANZATOR", "fullText": "S.C. FRAHEN AGRO S.R.L. cu sediul în Chesereu, nr. 175, jud. Bihor, înmatriculata sub nr. J05/283/2009, înregistrata la Reg. C.C.I. Bihor, CIF RO25164165 tel. 0742381554, având codul IBAN RO68 BRDE 050S V358 1927 0500 deschis la BRD ag. Valea lui Mihai, reprezentată prin Hengye Istvan administrator, CNP 1660524052851, în calitate de VANZATOR."}, {"name": "S.C. PACIF AGRO S.R.L", "cui": "RO7160580", "regCom": "J05/349/1995", "iban": "RO90WBAN2511000050501139deschislaInte", "bank": "Intesa Sanpaolo ag", "phone": "", "representative": "ing. Adrian Horge", "role": "VANZATOR", "fullText": "S.C. PACIF AGRO S.R.L. cu sediul în Valea lui Mihai, Ferma Nagy Lapos, jud. Bihor, înmatriculata sub nr. J05/349/1995, înregistrata la Reg. C.C.I. Bihor, CIF RO7160580 tel. 07, având codul IBAN RO90 WBAN 2511 0000 5050 1139 deschis la Intesa Sanpaolo ag. Valea lui Mihai, reprezentată prin ing. Adrian Horge, în calitate de VANZATOR."}, {"name": "BTK GRUNE HASE SRL", "cui": "", "regCom": "J30/252/2013", "iban": "RO31429461tel", "bank": "Banca Romana pentru Dezvoltare", "phone": "_____________", "representative": "______________, CNP ___________________", "role": "VÂNZĂTOR", "fullText": "BTK GRUNE HASE SRL cu sediul în BELTIUG NR 109, jud. Satu Mare , înmatriculata sub nr. J30/252/2013 , înregistrata la Reg. C.C.I. RO31429461 tel. _____________, având codul IBAN RO89 BRDE 310S V481 9525 3100 deschis la Banca Romana pentru Dezvoltare , reprezentată prin ______________, CNP ___________________, în calitate de VÂNZĂTOR."}, {"name": "SILAGHI MARIOARA MARIANA I.I", "cui": "RO31285080", "regCom": "F30/140/2013", "iban": "RO46BRDE310SV45934073100deschislaBanc", "bank": "Banca Romana pentru Dezvoltare", "phone": "", "representative": "________________", "role": "VÂNZĂTOR", "fullText": "SILAGHI MARIOARA MARIANA I.I cu sediul în MADARAS NR 82 , jud. Satu Mare, înmatriculata sub nr. F30/140/2013, înregistrata la Reg. C.C.I. Satu Mare, CIF RO31285080 , având codul IBAN RO46 BRDE 310S V459 3407 3100 deschis la Banca Romana pentru Dezvoltare, reprezentată prin ________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "PROAGRO BONADEA COOP.AGR", "cui": "RO44208128", "regCom": "C05/3/2021", "iban": "RO44208128tel", "bank": "Banca Transilvania", "phone": "", "representative": "_________________________", "role": "VANZATOR", "fullText": "PROAGRO BONADEA COOP.AGR. cu sediul în Valea lui Mihai, STR. BRASSAI SAMUEL, NR.1 , jud. Bihor, înmatriculata sub nr. C05/3/2021, înregistrata la Reg. C.C.I. Bihor, CIF RO44208128 tel. având codul IBAN RO21BTRLRONCRT0594980401 deschis la Banca Transilvania , reprezentată prin _________________________, în calitate de VANZATOR."}, {"name": "NEGRUT CRISTIAN PFA", "cui": "RO41296389", "regCom": "F05/1263/2019", "iban": "RO45CECEB00030RON0624344reprezentat", "bank": "", "phone": "", "representative": "asociat unic ___________________", "role": "VÂNZĂTOR", "fullText": "NEGRUT CRISTIAN PFA cu sediul în loc. CHISLAZ, NR.199 , jud. Bihor , înmatriculata sub nr. F05/1263/2019 la Reg.C.C.I. Bihor, CIF RO41296389 , având codul IBAN RO45CECEB00030RON0624344 reprezentată prin asociat unic ___________________, în calitate de VÂNZĂTOR ."}, {"name": "S.C. INUVERES S.R.L", "cui": "35806459", "regCom": "J5/571/2016", "iban": "RO97CECEBH0730RON0791476deschislaCEC", "bank": "CEC Bank ag", "phone": "0749768906", "representative": "Vereş Florian Gabriel", "role": "VANZATOR", "fullText": "S.C. INUVERES S.R.L. cu sediul în Chişlaz, jud. Bihor, nr. 133, înmatriculată sub nr. J5/571/2016 la Reg. C.C.I. Bihor, CIF 35806459, tel./fax. 0749768906, avand contul IBAN RO97 CECE BH07 30RO N079 1476 deschis la CEC Bank ag. Decebal Oradea, reprezentată prin Vereş Florian Gabriel administrator în calitate de VANZATOR."}, {"name": "S.C. TOPAGRAR S.R.L", "cui": "RO15268789", "regCom": "J30/483/2010", "iban": "RO15268789tel", "bank": "Raiffeisen Bank", "phone": "0786513554", "representative": "Wegendt Gerhard Bela", "role": "VANZATOR", "fullText": "S.C. TOPAGRAR S.R.L. cu sediul în Craidorolţ nr. 207/A, jud. Satu Mare, înmatriculata sub nr. J30/483/2010, înregistrata la Reg. C.C.I. Satu Mare, CIF RO15268789 tel.0786513554, având codul IBAN RO06 RZBR 0000 0600 0306 1702 deschis la Raiffeisen Bank, reprezentată prin Wegendt Gerhard Bela administrator, în calitate de VANZATOR."}, {"name": "S.C. BUDA AGRO S.R.L", "cui": "RO23406378", "regCom": "J05/598/2008", "iban": "RO09CARP005000517446RO02deschislaBanc", "bank": "Banca Carpatica ag", "phone": "0766325842", "representative": "Buda Gavril CNP 1690402052864", "role": "VANZATOR", "fullText": "S.C. BUDA AGRO S.R.L. cu sediul în Sânnicolau de Munte, nr. 355, jud. Bihor, înmatriculata sub nr. J05/598/2008, înregistrata la Reg. C.C.I. Bihor, CIF RO23406378, tel. 0766325842, având codul IBAN RO09 CARP 0050 0051 7446 RO02 deschis la Banca Carpatica ag. Sacuieni, reprezentată prin Buda Gavril CNP 1690402052864, în calitate de VANZATOR."}, {"name": "S.C. HETEI S.R.L", "cui": "RO665713", "regCom": "J30/244/1992", "iban": "RO51RNCB0226012235090001deschislaBCR", "bank": "BCR ag", "phone": "0744939699", "representative": "ing. Hetei Laszlo", "role": "VÂNZĂTOR", "fullText": "S.C. HETEI S.R.L. cu sediul în Beltiug, nr. 611, jud. Satu Mare, înmatriculata sub nr. J30/244/1992, înregistrata la Reg. C.C.I. Satu Mare, CIF RO665713 tel. 0744939699, având codul IBAN RO51 RNCB 0226 0122 3509 0001 deschis la BCR ag. Horea, reprezentată prin ing. Hetei Laszlo, în calitate de VÂNZĂTOR."}, {"name": "AGRO TRANS SRL", "cui": "RO21360088", "regCom": "J30/384/2007", "iban": "RO59RNCB0224093870780001deschislaBanc", "bank": "Banca Comerciala Romana suc", "phone": "______________", "representative": "________________________", "role": "VÂNZĂTOR", "fullText": "AGRO TRANS SRL cu sediul/domiciliul în Eriu Sincrai , jud. Satu Mare , str. SAT. ERIU SINCRAI NR.234, înmatriculată sub nr. J30/384/2007 , CIF RO21360088 , tel./fax. ______________, având codul IBAN RO59 RNCB 0224 0938 7078 0001 deschis la Banca Comerciala Romana suc./ag.______________________, reprezentată prin ________________________ administrator, în calitate de VÂNZĂTOR ."}, {"name": "KISS IOSIF AGRO P.F.A", "cui": "RO27800943", "regCom": "F30/1412/2010", "iban": "RO76RNCB0222120263820001deschislaBCR", "bank": "BCR ag", "phone": "0740920466", "representative": "Kiss Iosif CNP 1841224303701", "role": "VÂNZĂTOR", "fullText": "KISS IOSIF AGRO P.F.A. cu sediul în Carei, str. Vasile Lucaciu nr.11, jud. Satu Mare, înmatriculată sub nr. F30/1412/2010, înregistrata la Reg. C.C.I. Satu Mare, CIF RO27800943, tel./fax. 0740920466, având codul IBAN RO76 RNCB 0222 1202 6382 0001 deschis la BCR ag. Carei, reprezentată prin Kiss Iosif CNP 1841224303701 în calitate de. în calitate de VÂNZĂTOR."}, {"name": "Soc. Agr. RECOLTA", "cui": "RO2387672", "regCom": "", "iban": "RO11RNCB0222011951040001deschislaBCR", "bank": "BCR Carei", "phone": "0261874390", "representative": "ing. Gnandt Ferenc preşedinte CNP 1411201300051", "role": "VÂNZĂTOR", "fullText": "Soc. Agr. RECOLTA cu sediul in Urziceni, jud. Satu Mare, str. Urziceni nr. 438, Hot. Jud nr. 21/SA/91, CIF RO2387672, tel./fax. 0261874390, având contul IBAN RO11 RNCB 0222 0119 5104 0001 deschis la BCR Carei, reprezentat prin ing. Gnandt Ferenc preşedinte CNP 1411201300051, în calitate de VÂNZĂTOR."}, {"name": "S.C. DANTERA S.R.L", "cui": "RO23871712", "regCom": "J05/1269/2008", "iban": "RO44RZBR0000060010529630deschislaRAIF", "bank": "RAIFFEISEN S", "phone": "004369911718774/004077337", "representative": "dr. Matthias Untersperger", "role": "VANZATOR", "fullText": "S.C. DANTERA S.R.L. cu sediul Oradea, jud. Bihor, Calea Clujului nr. 144 - 148, înmatriculată sub nr. J05/1269/2008 la Reg. C.C.I. Satu Mare, CIF RO23871712, tel./fax. 004369911718774/0040773373611, avand codul IBAN RO44 RZBR 0000 0600 1052 9630 deschis la RAIFFEISEN S.A. suc. Oradea, reprezentată prin dr. Matthias Untersperger administrator, în calitate de VANZATOR."}, {"name": "S.C. BIODANTERA S.R.L", "cui": "34383350", "regCom": "J05/617/2015", "iban": "RO39RZBR0000060017776299deschislaRAIF", "bank": "RAIFFEISEN S", "phone": "004369911718774/004077337", "representative": "dr. Matthias Untersperger", "role": "VANZATOR", "fullText": "S.C. BIODANTERA S.R.L. cu sediul Oradea, jud. Bihor, Piaţa Unirii nr. 8 ap.10, înmatriculată sub nr. J05/617/2015 la Reg. C.C.I. Bihor, CIF 34383350, tel./fax. 004369911718774/0040773373611, avand codul IBAN RO39 RZBR 0000 0600 1777 6299 deschis la RAIFFEISEN S.A. suc. Oradea, reprezentată prin dr. Matthias Untersperger administrator, în calitate de VANZATOR."}, {"name": "Suceveanu Liliana Simona Persoana Fizica Autorizata", "cui": "RO26967715", "regCom": "F30/541/2010", "iban": "RO26967715tel", "bank": "BRD suc", "phone": "0741917183", "representative": "Suceveanu Liliana Simona CNP 2731108301961", "role": "VANZATOR", "fullText": "Suceveanu Liliana Simona Persoana Fizica Autorizata cu sediul în Terebeşti, nr. 34, jud. Satu Mare, înmatriculata sub nr. F30/541/2010 la Reg. C.C.I. Satu Mare, CIF RO26967715 tel. 0741917183, având codul IBAN RO36 BRDE 310S V321 5251 3100 deschis la BRD suc. Satu Mare, reprezentată prin Suceveanu Liliana Simona CNP 2731108301961, în calitate de VANZATOR."}, {"name": "S.C. TERRE FERTILI S.R.L", "cui": "RO13911399", "regCom": "J30/52/2005", "iban": "RO60BRDE310SV24495823100deschislaBRD", "bank": "BRD suc", "phone": "07283231463", "representative": "Avorniciti Neculai", "role": "VANZATOR", "fullText": "S.C. TERRE FERTILI S.R.L. cu sediul în Pişcari, jud. Satu Mare, str. Istrău nr. 207, înmatriculată sub nr. J30/52/2005, înregistrata la Reg. C.C.I. Satu Mare, CIF RO13911399, tel./fax. 07283231463, având codul IBAN RO60 BRDE 310S V244 9582 3100 deschis la BRD suc. Satu Mare, reprezentată prin Avorniciti Neculai administrator, în calitate de VANZATOR."}, {"name": "S.C. AVOSIM S.R.L", "cui": "RO18665007", "regCom": "J30/476/2006", "iban": "RO30BRDE310SV26493653100deschislaBRD", "bank": "BRD suc", "phone": "0728321463", "representative": "Avorniciti Neculai", "role": "VANZATOR", "fullText": "S.C. AVOSIM S.R.L. cu sediul în Pişcari, jud. Satu Mare, str. Istrău nr. 207, înmatriculată sub nr. J30/476/2006, înregistrata la Reg. C.C.I. Satu Mare, CIF RO18665007, tel./fax. 0728321463, având codul IBAN RO30 BRDE 310S V264 9365 3100 deschis la BRD suc. Satu Mare, reprezentată prin Avorniciti Neculai administrator, în calitate de VANZATOR."}, {"name": "S.C. AGROHOL S.R.L", "cui": "RO15229909", "regCom": "J05/180/2003", "iban": "RO15229909tel", "bank": "Banca Transilvania ag", "phone": "0745569695", "representative": "ing. Holhos Claudiu", "role": "VANZATOR", "fullText": "S.C. AGROHOL S.R.L. cu sediul în com. Simian sat Voivozi, nr.5, jud. Bihor, înmatriculata sub nr. J05/180/2003, înregistrata la Reg. C.C.I. Bihor, CIF RO15229909 tel. 0745569695, având codul IBAN RO61 BTRL 0050 1202 E464 88XX deschis la Banca Transilvania ag. Valea lui Mihai, reprezentată prin ing. Holhos Claudiu, în calitate de VANZATOR."}, {"name": "S.C. SZAKY AGRO PRODUCT S.R.L", "cui": "RO31003775", "regCom": "J31/520/2012", "iban": "RO31003775tel", "bank": "Raiffeisen suc", "phone": "0768801184/0260673921", "representative": "", "role": "VANZATOR", "fullText": "S.C. SZAKY AGRO PRODUCT S.R.L. cu sediul în Carastelec, nr. 1B, jud. Salaj, înmatriculata sub nr. J31/520/2012, înregistrata la Reg. C.C.I. Salaj, CIF RO31003775 tel. 0768801184/0260673921, având codul IBAN RO62 RZBR 0000 0600 1521 7025 deschis la Raiffeisen suc. Zalau, reprezentată de Nagy Szabolcs CNP 1840807313529 administrator, prin Nagy Tibi CNP 1560707311828 mandatat prin Procura generala nr. 153/16.01.2013, în calitate de VANZATOR."}, {"name": "S.C. BIFAE S.R.L", "cui": "RO20416008", "regCom": "J30/7/2007", "iban": "RO51RNCB0222125487770001deschislaBanc", "bank": "Banca Comercială S", "phone": "0261824654/0744567993", "representative": "Jurj Bianca", "role": "VANZATOR", "fullText": "S.C. BIFAE S.R.L. cu sediul în Scarisoara Noua, jud. Satu Mare, str. Principala nr. 7, înmatriculată sub nr. J30/7/2007, înregistrata la Reg. C.C.I. Satu Mare, CIF RO20416008, tel./fax. 0261824654/0744567993, având codul IBAN RO51 RNCB 0222 1254 8777 0001 deschis la Banca Comercială S.A. ag. Carei, reprezentată prin Jurj Bianca administrator CNP 2850124303705, în calitate de VANZATOR."}, {"name": "TILLINGER I ROBERT JANOS I.I", "cui": "RO37014196", "regCom": "F30/43/2017", "iban": "RO63RNCB0222153683490001deschislaBanc", "bank": "Banca Comerciala Romana", "phone": "________________", "representative": "________________", "role": "VÂNZĂTOR", "fullText": "TILLINGER I ROBERT JANOS I.I. cu sediul în loc. Capleni NR.520, jud.Satu Mare, înmatriculată sub nr. F30/43/2017, înregistrata la Reg. C.C.I. Satu Mare, CIF RO37014196 , tel./fax.________________ , având codul IBAN RO63 RNCB 0222 1536 8349 0001 deschis la Banca Comerciala Romana, reprezentată prin ________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "KOVACS M SZABOLCS I.I", "cui": "RO47742898", "regCom": "F30/130/2023", "iban": "RO56RZBR0000060024460554deschislaRaiffeis", "bank": "Raiffeisen Bank suc", "phone": "______________", "representative": "________________________________________", "role": "VÂNZĂTOR", "fullText": "KOVACS M SZABOLCS I.I cu sediul/domiciliul în JUD. SATU MARE, SAT PETRESTI COM. PETRESTI, PETRESTI, NR.450, înmatriculată sub nr. F30/130/2023, înregistrata la Reg. C.C.I. _____, CIF RO47742898 , tel./fax. ______________, având codul IBAN RO56RZBR0000060024460554 deschis la Raiffeisen Bank suc./ag.______________, reprezentată prin ________________________________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "Societatea Agricola GLORIA RESIGHEA", "cui": "RO648984", "regCom": "J30/2181/1992", "iban": "RO21RNCB0222011954723001deschislaBanc", "bank": "Banca Comercială S", "phone": "0261824654/0744567993", "representative": "ing. Bâtea Ilie", "role": "VANZATOR", "fullText": "Societatea Agricola GLORIA RESIGHEA cu sediul în Resighea, jud. Satu Mare, str. Gariin nr. 240, înmatriculată sub nr. J30/2181/1992, înregistrata la Reg. C.C.I. Satu Mare, CIF RO648984, tel./fax. 0261824654/0744567993, având codul IBAN RO21 RNCB 0222 0119 5472 3001 deschis la Banca Comercială S.A. ag. Carei, reprezentată prin ing. Bâtea Ilie administrator CNP 1550424300021, în calitate de VANZATOR."}, {"name": "S.C. HOMEC AGRO S.R.L", "cui": "RO13484646", "regCom": "J05/854/2000", "iban": "RO13484646tel", "bank": "Intesa Sanpaolo Imi ag", "phone": "0752277690", "representative": "ing. Horvath Sandor Krisztian, CNP 1800627054754", "role": "VANZATOR", "fullText": "S.C. HOMEC AGRO S.R.L. cu sediul în Valea lui Mihai, Ferma 13 Csiri, nr.5 jud. Bihor, înmatriculata sub nr. J05/854/2000, înregistrata la Reg. C.C.I. Bihor, CIF RO13484646 tel. 0752277690, având codul IBAN RO13 WBAN 2511 0000 5050 0197 deschis la Intesa Sanpaolo Imi ag. Valea lui Mihai, reprezentată prin ing. Horvath Sandor Krisztian, CNP 1800627054754, în calitate de VANZATOR."}, {"name": "S.C. SIMIANU S.R.L", "cui": "RO26268482", "regCom": "J30/837/2009", "iban": "RO05BRDE310SV29586513100deschislaBRD", "bank": "BRD ag", "phone": "0728321462", "representative": "Gabriel Daniel Simianu", "role": "VANZATOR", "fullText": "S.C. SIMIANU S.R.L. cu sediul în Pişcari, nr. 207, jud. Satu Mare, înmatriculata sub nr.J30/837/2009 la Reg. C.C.I. Satu Mare, CIF RO26268482, tel. 0728321462, având codul IBAN RO05 BRDE 310S V295 8651 3100 deschis la BRD ag. Someşul Satu Mare, reprezentată prin Gabriel Daniel Simianu, în calitate de VANZATOR."}, {"name": "Simianu Viorica Maria Persoana Fizica Autorizata", "cui": "RO28257609", "regCom": "F30/287/2011", "iban": "RO71BRDE310SV36387803100deschislaBRD", "bank": "BRD suc", "phone": "07283231463", "representative": "Simianu Viorica Maria", "role": "VANZATOR", "fullText": "Simianu Viorica Maria Persoana Fizica Autorizata cu sediul în Pişcari, nr. 207, jud. Satu Mare, înmatriculata sub nr. F30/287/2011 la Reg. C.C.I. Salaj, CIF RO28257609, tel. 07283231463, având codul IBAN RO71 BRDE 310S V363 8780 3100 deschis la BRD suc. Satu Mare, reprezentată prin Simianu Viorica Maria, în calitate de VANZATOR."}, {"name": "S.C. IEDERAN GROUP S.R.L", "cui": "RO38954980", "regCom": "J30/186/2018", "iban": "RO05BTRLRONCRT0437452301deschislaBANC", "bank": "BANCA TRANSILVANIA ag", "phone": "0745753556", "representative": "Iederan Mihnea Alexandru", "role": "VANZATOR", "fullText": "S.C. IEDERAN GROUP S.R.L. cu sediul în Mădăras, oraș Ardud jud. Satu Mare, str. Principală nr. 21, înmatriculată sub nr. J30/186/2018, înregistrata la Reg. C.C.I. Satu Mare, CIF RO38954980, tel./fax. 0745753556, având codul IBAN RO05 BTRL RONC RT04 3745 2301 deschis la BANCA TRANSILVANIA ag. Ardud, reprezentată prin Iederan Mihnea Alexandru administrator, în calitate de VANZATOR."}, {"name": "IEDERAN VIORICA IOANA I.I", "cui": "RO48201165", "regCom": "F30/288/2023", "iban": "RO08RNCB0035101152450001deschislaBCRsuc", "bank": "BCR suc", "phone": "______________", "representative": "_________________", "role": "VÂNZĂTOR", "fullText": "IEDERAN VIORICA IOANA I.I. cu sediul/domiciliul în JUD. SATU MARE , DOBA STR.Principala nr.134 , F30/288/2023 CIF RO48201165, tel./fax ______________, având codul IBAN RO08RNCB0035101152450001 deschis la BCR suc./ag. , reprezentată prin _________________ administrator, în calitate de VÂNZĂTOR."}, {"name": "S.C. DANEVOTA S.R.L", "cui": "RO35642046", "regCom": "J5/339/2016", "iban": "RO91BTRLRONCRT0337772001deschislaBTRL", "bank": "BTRL ag", "phone": "0747463974", "representative": "Gal Daniel Paul CNP 1920928054750", "role": "VANZATOR", "fullText": "S.C. DANEVOTA S.R.L. cu sediul în Chiraleu, nr. 166, jud. Bihor, înmatriculata sub nr. J5/339/2016 la Reg. C.C.I. Bihor, CIF RO35642046, tel. 0747463974, având codul IBAN RO91 BTRL RONC RT03 3777 2001 deschis la BTRL ag. Marghita, reprezentată prin Gal Daniel Paul CNP 1920928054750, în calitate de VANZATOR."}, {"name": "S.C. TOT-PAT AGRO S.R.L", "cui": "RO35410364", "regCom": "J5/69/2016", "iban": "RO35410364tel", "bank": "BCR ag", "phone": "0740618143", "representative": "", "role": "VANZATOR", "fullText": "S.C. TOT-PAT AGRO S.R.L. cu sediul în Dolea, nr. 53, jud. Bihor, înmatriculata sub nr. J5/69/2016, înregistrata la Reg. C.C.I. Bihor, CIF RO35410364 tel. 0740618143, având codul IBAN RO86 RNCB 0035 1492 3864 0001 deschis la BCR ag. Marghita, reprezentată de Toth – Suru Attila administrator, CNP 1770409052855 în calitate de VANZATOR."}, {"name": "S.C. AGRO PARTENER S.R.L", "cui": "RO19004488", "regCom": "J30/859/2006", "iban": "RO85RNCB0222061585430001deschislaBanc", "bank": "Banca Comercială S", "phone": "0744379203", "representative": "Bekes Arnold", "role": "VÂNZĂTOR", "fullText": "S.C. AGRO PARTENER S.R.L. cu sediul în Petreşti, jud. Satu Mare, str. Pişcoltului nr. 547, înmatriculată sub nr. J30/859/2006, înregistrata la Reg. C.C.I. Satu Mare, CIF RO19004488, tel./fax. 0744379203, având codul IBAN RO85 RNCB 0222 0615 8543 0001 deschis la Banca Comercială S.A. ag. Carei, reprezentată prin Bekes Arnold administrator CNP 180050130378, în calitate de VÂNZĂTOR."}, {"name": "HIRI MIHAI", "cui": "", "regCom": "", "iban": "RO42BTRL03101201503494XXdeschislaBancaTr", "bank": "Banca Transilvania ag", "phone": "", "representative": "", "role": "VÂNZĂTOR", "fullText": "HIRI MIHAI cu sediul în Petreşti, jud. Satu Mare, str. Pişcoltului nr. NR364 , înmatriculată sub nr., înregistrata la Reg. C.C.I. Satu Mare, CIF CNP 1970724303708, tel./fax, având codul IBAN RO42BTRL03101201503494XX deschis la Banca Transilvania ag. , în calitate de VÂNZĂTOR."}, {"name": "STAŢIUNEA DE CERCETARE DEZVOLTARE AGRICOLĂ", "cui": "RO644346", "regCom": "", "iban": "RO25TREZ23G860200200109XdeschislaTrez", "bank": "Trezoreria Satu Mare", "phone": "0261840001/840361", "representative": "dr.ing. Sârca Crucița şi contabil şef ec. Stekli Elisabeta", "role": "VANZATOR", "fullText": "STAŢIUNEA DE CERCETARE DEZVOLTARE AGRICOLĂ cu sediul în Livada, jud. Satu Mare, str. Baia Mare nr. 7, constituită conform Legii 45/2009, CIF RO644346, tel./fax. 0261840001/840361, scdalivada@yahoo.com, având codul IBAN RO25 TREZ 23G8 6020 0200 109X deschis la Trezoreria Satu Mare, reprezentată prin dr.ing. Sârca Crucița şi contabil şef ec. Stekli Elisabeta, în calitate de VANZATOR."}, {"name": "S.C. STELAGRA S.R.L", "cui": "RO11837890", "regCom": "J30/174/1999", "iban": "RO17BRDE310SV10963243100deschislaBRD", "bank": "BRD suc", "phone": "0745490874", "representative": "ing. Sabău Ioan 1540807301983", "role": "VANZATOR", "fullText": "S.C. STELAGRA S.R.L. cu sediul în Mădăras, str. Principală nr. 435, jud. Satu Mare, înmatriculată sub nr. J30/174/1999, înregistrata la Reg. C.C.I. Satu Mare, CIF RO11837890, tel./fax. 0745490874, având codul IBAN RO17 BRDE 310S V109 6324 3100 deschis la BRD suc. Satu Mare , reprezentată prin ing. Sabău Ioan 1540807301983 administrator, în calitate de VANZATOR."}, {"name": "S.C. FERMA TAGU ROŞU S.R.L", "cui": "RO29877552", "regCom": "J30/157/2012", "iban": "RO18CECESM0830RON0376050deschislacec", "bank": "cec SUC", "phone": "0743944848 / 0744859892", "representative": "KOVACS EUGENIA - FLORICA", "role": "VANZATOR", "fullText": "S.C. FERMA TAGU ROŞU S.R.L. cu sediul în Mărtineşti, jud. Satu Mare, nr. 25, înmatriculată sub nr. J30/157/2012, înregistrata la Reg. C.C.I. Satu Mare, CIF RO29877552, tel./fax. 0743944848 / 0744859892, având codul IBAN RO18 CECE SM08 30RO N037 6050 deschis la cec SUC. Satu Mare, reprezentată prin KOVACS EUGENIA - FLORICA administrator, în calitate de VANZATOR."}, {"name": "Societatea agricolă AGROFIEN", "cui": "RO23872816", "regCom": "", "iban": "RO14RNCB0222011950980001deschislaBCR", "bank": "BCR ag", "phone": "0261874615", "representative": "ing. Stefan Pop", "role": "VÂNZĂTOR", "fullText": "Societatea agricolă AGROFIEN cu sediul în Foieni, jud. Satu Mare, nr. 434, constituită conform Legii 36, CIF RO23872816, tel./fax. 0261874615, codul IBAN RO14 RNCB 0222 0119 5098 0001 deschis la BCR ag. Carei, reprezentată prin ing. Stefan Pop, în calitate de VÂNZĂTOR."}, {"name": "S.C. AGROMEC FOIENI S.A", "cui": "RO8173201", "regCom": "J30/838/1996", "iban": "RO58RNCB4040000013060001deschislaBCR", "bank": "BCR ag", "phone": "0261817611", "representative": "ing. Iosif Progli 1522212300025", "role": "VANZATOR", "fullText": "S.C. AGROMEC FOIENI S.A. cu sediul în Foieni, nr. 444, jud. Satu Mare, înmatriculată sub nr. J30/838/1996 la Reg. C.C.I. Satu Mare, CIF RO8173201, tel./fax. 0261817611, avand contul IBAN RO58 RNCB 4040 0000 1306 0001 deschis la BCR ag. Carei, reprezentată prin ing. Iosif Progli 1522212300025 administrator, în calitate de VANZATOR."}, {"name": "JAKAB & BEATA S.R.L", "cui": "RO27227103", "regCom": "J30/426/2010", "iban": "RO31BRDE310SV62032493100deschislaBRD", "bank": "BRD S", "phone": "0763993635", "representative": "Szabo Beata", "role": "VÂNZĂTOR", "fullText": "JAKAB & BEATA S.R.L. cu sediul în loc. Ser nr.240, jud. Satu Mare, înmatriculată sub nr. J30/426/2010, înregistrata la Reg. C.C.I. Satu Mare, CIF RO27227103, tel./fax. 0763993635, având codul IBAN RO31 BRDE 310S V620 3249 3100 deschis la BRD S.A., reprezentată prin Szabo Beata administrator, în calitate de VÂNZĂTOR."}, {"name": "S.C. HORVAT V&G S.R.L", "cui": "RO17162350", "regCom": "J30/99/2005", "iban": "RO79RNCB0224012395230001deschislaBanc", "bank": "Banca Comercială ag", "phone": "0752969512", "representative": "Horvat Vasile CNP 1650312304004", "role": "VANZATOR", "fullText": "S.C. HORVAT V&G S.R.L. cu sediul în Săuca, jud. Satu Mare, nr.43, înmatriculată sub nr. J30/99/2005, înregistrata la Reg. C.C.I. Satu Mare, CIF RO17162350, tel./fax. 0752969512, având codul IBAN RO79 RNCB 0224 0123 9523 0001 deschis la Banca Comercială ag. Taşnad, reprezentată prin Horvat Vasile CNP 1650312304004, în calitate de VANZATOR."}];

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

app.post('/api/partners/reset-defaults', requireAuth, (req, res) => {
  try {
    makeBackup('before-partners-reset');
    const softDelete = db.prepare("UPDATE partners SET deleted_at = datetime('now'), deleted_by = ? WHERE deleted_at IS NULL");
    const insert = db.prepare("INSERT INTO partners (data, created_at, updated_at) VALUES (?, datetime('now'), datetime('now'))");
    const tx = db.transaction((items) => {
      softDelete.run(req.session.user || null);
      for (const p of items) insert.run(JSON.stringify({ ...p, type: 'supplier', source: 'DATE CLIENTI curatat' }));
    });
    tx(DEFAULT_PARTNERS_SEED);
    audit(req, 'reset_defaults', 'partners', null, { count: DEFAULT_PARTNERS_SEED.length });
    res.json({ ok: true, count: DEFAULT_PARTNERS_SEED.length });
  } catch (err) {
    console.error('Partners reset error:', err);
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
