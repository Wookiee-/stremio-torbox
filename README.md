# TorBox Stremio Addon

A Stremio addon that streams movies and TV shows via [TorBox](https://torbox.app) cached torrents and Usenet NZBs. Uses TorBox's debrid service to instantly serve cached content — no waiting for downloads.

## How It Works

1. **Search** — Queries TorBox's search API for torrents and Usenet NZBs matching the IMDB ID
2. **Cache Check** — Filters results to only show content already cached on TorBox servers
3. **Stream** — Generates direct download links from TorBox's CDN for instant playback in Stremio

## Prerequisites

- **Node.js** (v18+)
- **TorBox account** — Free tier works for torrents; Usenet requires Pro plan
- **TorBox API Key** — Get it from your [TorBox Settings](https://torbox.app/settings)

## Setup

```bash
cd stremio-torbox
npm install
npm start
```

The server starts at `http://127.0.0.1:7000` by default.

## Install in Stremio

1. Open Stremio
2. Go to **Addons** → **Community Addons**
3. Click **Install via URL**
4. Enter: `http://127.0.0.1:7000/manifest.json`

Or open this URL directly in your browser:
```
stremio://http://127.0.0.1:7000/manifest.json
```

You'll be prompted to enter your TorBox API key during configuration.

## Test Manually

```bash
# Validate API key and search for a movie
curl "http://127.0.0.1:7000/test/tt1234567?key=YOUR_API_KEY"

# Test a TV episode
curl "http://127.0.0.1:7000/test/tt1234567/1/1?key=YOUR_API_KEY"
```

## Configuration

| Environment Variable | Default            | Description                       |
|---------------------|--------------------|-----------------------------------|
| `PORT`              | `7000`             | Server port                       |
| `HOST`              | `http://127.0.0.1` | Server host                       |
| `TORBOX_API_KEY`    | —                  | Default API key (optional)        |

## Project Structure

```
stremio-torbox/
├── index.js          # Stremio addon server
├── torbox-api.js     # TorBox API client (search, cache, download)
├── package.json
└── README.md
```

## How the TorBox Integration Works

### Torrents
1. Searches TorBox's search API by IMDB ID
2. Filters results to cached torrents only
3. Selects the best video file (largest MKV/MP4, or matches SxxExx for series)
4. Generates a direct CDN download link via TorBox's `requestdl` API

### Usenet (Pro only)
1. Searches TorBox's Usenet indexers by IMDB ID
2. Filters to cached NZB results
3. Generates download links the same way as torrents

### Cache Status
- TorBox caches popular torrents server-side
- Cached content streams instantly at full speed
- Non-cached content would need to download first (not supported in this addon)

## API Endpoints

| Endpoint                          | Description                     |
|----------------------------------|---------------------------------|
| `GET /manifest.json`             | Stremio manifest                |
| `GET /health`                    | Health check                    |
| `GET /test/:imdbId?key=KEY`      | Test movie search               |
| `GET /test/:imdbId/:s/:e?key=KEY`| Test TV episode search          |
| `GET /configure`                 | Configuration page (SDK)        |

## Notes

- Only cached content is returned — this ensures instant streaming
- The addon uses TorBox's own search API (not third-party torrent trackers)
- API rate limit: 300 requests/minute per API key
- Usenet content requires a TorBox Pro subscription
- Torrents are available on all TorBox plans (including free)

## License

ISC
