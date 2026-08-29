# TorBox Stremio Addon

A fast Stremio addon that streams movies and TV shows via [TorBox](https://torbox.app) cached torrents. Built with multi-provider scraping and Torrentio-style on-demand stream resolution.

## Features

- ⚡ **Instant Playback** — Cached torrents stream directly from TorBox CDN via 302 redirects
- 🔍 **Multi-Provider Scraping** — Aggregates torrents from TPB, Knaben, BitSearch, YTS, EZTV, and more
- 🎯 **Deduplication** — Clean, duplicate-free stream lists
- 🎛️ **Torrentio-Style Setup** — Modern configuration UI with resolution exclusion and direct Stremio installation
- 🚀 **VPS & Docker Ready** — Built for high-speed continuous Node.js runtime

---

## Deployment on VPS

### Option 1: Docker / Docker Compose (Recommended)

```bash
git clone https://github.com/Wookiee-/stremio-torbox.git
cd stremio-torbox

# Edit BASE_URL in docker-compose.yml if using a custom domain
docker compose up -d --build
```

The addon will be available at `http://YOUR_SERVER_IP:7000/configure`.

---

### Option 2: PM2 (Node.js)

```bash
git clone https://github.com/Wookiee-/stremio-torbox.git
cd stremio-torbox
npm install

# Install PM2 globally if not already installed
npm install -g pm2

# Start the addon
pm2 start index.js --name "stremio-torbox"
pm2 save
pm2 startup
```

---

### Option 3: Systemd Service

Create `/etc/systemd/system/stremio-torbox.service`:

```ini
[Unit]
Description=TorBox Stremio Addon
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/stremio-torbox
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10
Environment=PORT=7000
Environment=HOST=0.0.0.0
Environment=BASE_URL=https://your-domain.com

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
systemctl daemon-reload
systemctl enable stremio-torbox
systemctl start stremio-torbox
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7000` | Port for the HTTP server |
| `HOST` | `0.0.0.0` | Listen host interface |
| `BASE_URL` | `http://127.0.0.1:7000` | Public URL (e.g. `https://torbox.yourdomain.com`) used for stream resolve links |
| `TORBOX_API_KEY` | — | Default API key for `/test` endpoints |

---

## Setup & Configuration

1. Open `http://YOUR_SERVER_IP:7000/configure` (or your domain)
2. Enter your **TorBox API Key** from [torbox.app/settings](https://torbox.app/settings)
3. Select your preferred resolutions to exclude and sorting order
4. Click **Install to Stremio** or copy the installation link
