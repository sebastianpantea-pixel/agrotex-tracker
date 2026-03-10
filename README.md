# Agrotex Position Tracker — Deploy pe Render.com

## Pași de instalare (15 minute)

### 1. Creează cont GitHub (dacă nu ai)
- Mergi la https://github.com și creează un cont gratuit

### 2. Creează un repository nou
- Click pe "+" → "New repository"
- Nume: `agrotex-tracker`
- Lasă-l Public (sau Private dacă ai cont Pro)
- Click "Create repository"

### 3. Încarcă fișierele
Pe pagina repository-ului nou creat, click "uploading an existing file" și încarcă:
- `server.js`
- `package.json`
- `render.yaml`
- Folderul `public/` cu `index.html` în interior

Alternativ, dacă ai Git instalat:
```bash
cd agrotex-app
git init
git add .
git commit -m "initial"
git remote add origin https://github.com/USERNAME/agrotex-tracker.git
git push -u origin main
```

### 4. Creează cont Render.com
- Mergi la https://render.com
- Sign up cu contul GitHub (mai simplu)

### 5. Deploy
- Dashboard Render → "New +" → "Web Service"
- Conectează repository-ul `agrotex-tracker`
- Render detectează automat `render.yaml` și configurează totul
- Click "Create Web Service"

### 6. Setează parola
- În Render dashboard → serviciul tău → "Environment"
- Găsește variabila `APP_PASSWORD`
- Schimb-o cu parola dorită (ex: `Agrotex#2025`)
- Click "Save Changes" → serviciul se restartează automat

### 7. Acces
- URL-ul aplicației apare în dashboard: `https://agrotex-position-tracker.onrender.com`
- Trimite URL-ul și parola colegilor

---

## Note importante

**Date persistente**: Baza de date SQLite se salvează pe disk-ul persistent `/data` — datele nu se pierd la restart.

**Free tier Render**: Serviciul se "adoarme" după 15 minute de inactivitate și la primul acces durează ~30 secunde să pornească. Pentru uz constant (fără delay) poți upgrade la $7/lună.

**Schimbare parolă**: Oricând din Render → Environment → `APP_PASSWORD`.

**Backup date**: Poți descărca baza de date SQLite din Render → Disk, sau implementa un endpoint de export.

---

## Structura fișierelor

```
agrotex-app/
├── server.js          # Backend Node.js + API
├── package.json       # Dependențe
├── render.yaml        # Configurare Render
└── public/
    └── index.html     # Frontend complet (login + dashboard)
```
