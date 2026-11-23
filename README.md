# 🔄 Skyra Sync Worker

Background worker yang sync catalog UniPlay → Supabase tiap 15 menit.  
Deploy di Railway dengan static IP (whitelist di UniPlay).

## 📂 Struktur

```
skyra-sync/
├── index.js           Entry point + cron scheduler
├── src/
│   ├── uniplay.js     UniPlay API client (signature, endpoints)
│   ├── supabase.js    Supabase client
│   └── sync.js        Main sync logic (DTU + Voucher + PPOB)
├── package.json
├── railway.json       Railway deployment config
└── .env.example       Template env vars
```

## 🚀 Deploy ke Railway

### 1. Push project ini ke GitHub
Bikin repo baru `skyra-sync` di GitHub, lalu dari folder ini:

```bash
cd "C:\Users\Hera Ayu\Documents\skyra-sync"
git init
git branch -M main
git remote add origin https://github.com/skyrastore/skyra-sync.git
git add .
git commit -m "Initial Skyra Sync worker"
git push -u origin main
```

### 2. Buat Project di Railway
1. https://railway.com → **New Project** → **Deploy from GitHub repo**
2. Pilih repo `skyra-sync`
3. Railway auto-detect Node.js → deploy

### 3. Set Environment Variables
Di dashboard Railway project → **Variables** tab → Add:

| Variable | Value |
|---|---|
| `UNIPLAY_API_KEY` | API key dari UniPlay dashboard |
| `UNIPLAY_PINCODE` | PIN code buat confirm order |
| `SUPABASE_URL` | `https://xyqgopojgnimiisitfvw.supabase.co` |
| `SUPABASE_SERVICE_KEY` | **service_role** key dari Supabase (bukan anon!) |
| `MARKUP_PCT` | `2.5` (default) |
| `CRON_SCHEDULE` | `*/15 * * * *` (tiap 15 menit) |

### 4. Enable Static Outbound IP
1. Railway project → **Settings** → **Networking**
2. Toggle **"Static Outbound IP"** (feature varies per plan)
3. Copy IP yang Railway kasih

### 5. Whitelist IP di UniPlay
1. UniPlay Arena Dashboard → Akses API → **Whitelist IP** → Add
2. Paste IP Railway → Save

### 6. Verify Sync
Cek Railway **Logs** tab — harus muncul:
```
🚀 Skyra Sync Worker starting...
⚡ Running initial sync...
💰 UniPlay Saldo: Rp 2.500.000
──── Syncing DTU (Game) ────
✓ Fetched X items from UniPlay
...
✅ Sync complete in Xs
```

### 7. Verify Supabase
Buka Supabase → Table Editor → `games` dan `products` → data baru dari UniPlay.

## 🔧 Development Local

```bash
npm install
cp .env.example .env.local
# edit .env.local dengan keys asli

# Run sync sekali manual
npm run sync:once

# Run worker + cron
npm start
```

## 📊 Margin Calculation

`price_idr = ceil(cost_idr × (1 + MARKUP_PCT/100))` lalu rounded up ke kelipatan 50.

Contoh: UniPlay price = Rp 2.000, markup = 2.5% → sell = Rp 2.050.

## 🔄 Flow Order (Nanti)

Worker ini **belum handle order flow**. Order flow (customer checkout) akan handle terpisah via:
- Next.js API route di `skyra.id` call UniPlay API via Railway worker endpoint (HTTP proxy)
- Atau via Supabase Edge Function (kalau UniPlay bisa whitelist CF IPs)

Untuk sekarang: **worker ini cuma sync catalog**. Order handling TODO.
