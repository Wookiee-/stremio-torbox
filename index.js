const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const TorBoxAPI = require('./torbox-api');

const PORT = process.env.PORT || 7000;
const HOST = process.env.HOST || 'http://127.0.0.1';

// ─── Manifest ────────────────────────────────────────────────────

const manifest = {
  id: 'community.torbox',
  version: '1.0.0',
  name: 'TorBox Scraper',
  description: 'Stream movies and TV shows via TorBox cached torrents',
  logo: 'https://torbox.app/favicon.ico',
  catalogs: [],
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'tmdb:'],
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
  },
  config: [
    { key: 'torbox_api_key', title: 'TorBox API Key', type: 'password', required: true },
    { key: 'qualities', title: 'Qualities', type: 'text' },
    { key: 'max_size', title: 'Max Size (GB)', type: 'text' },
    { key: 'sort', title: 'Sort Order', type: 'text' },
  ],
};

// ─── Builder ─────────────────────────────────────────────────────

const builder = new addonBuilder(manifest);

// ─── Stream Handler ──────────────────────────────────────────────

builder.defineStreamHandler(async ({ type, id, config }) => {
  const apiKey = config?.torbox_api_key;
  if (!apiKey) {
    console.error('[stream] No TorBox API key provided');
    return { streams: [] };
  }

  // Parse config
  const allowedQualities = (config?.qualities || '4k,1440p,1080p,720p,576p,480p,360p,240p,cam,unknown').split(',').map(q => q.trim().toLowerCase());
  const maxSizeGB = parseFloat(config?.max_size) || 0;
  const sortKey = (config?.sort || 'qualityseeders').toLowerCase();

  console.log(`\n[stream] Request: type=${type}, id=${id}`);

  const torbox = new TorBoxAPI(apiKey);

  try {
    let imdbId, season, episode;

    if (type === 'movie') {
      imdbId = id.replace(/^tmdb:/, '');
    } else if (type === 'series') {
      const parts = id.split(':');
      imdbId = parts[0].replace(/^tmdb:/, '');
      season = parseInt(parts[1], 10) || undefined;
      episode = parseInt(parts[2], 10) || undefined;
    } else {
      return { streams: [] };
    }

    const cached = await torbox.searchAll(imdbId, type, season, episode);

    if (cached.length === 0) {
      console.log('[stream] No cached results found');
      return { streams: [] };
    }

    // Apply config filters
    let filtered = cached.filter(r => {
      if (!allowedQualities.includes(r.quality)) return false;
      if (maxSizeGB > 0 && r.size > maxSizeGB * 1024 * 1024 * 1024) return false;
      return true;
    });

    // Sort
    if (sortKey === 'seeders') {
      filtered.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
    } else if (sortKey === 'size') {
      filtered.sort((a, b) => (b.size || 0) - (a.size || 0));
    }

    // Cap at 50
    filtered = filtered.slice(0, 50);

    console.log(`[stream] Found ${filtered.length} cached results, resolving...`);
    const resolveStart = Date.now();

    // Resolve with concurrency limit (5 at a time to avoid TorBox rate limits)
    const MAX_CONCURRENT = 5;
    const streams = [];
    for (let i = 0; i < filtered.length; i += MAX_CONCURRENT) {
      const batch = filtered.slice(i, i + MAX_CONCURRENT);
      const batchResults = await Promise.allSettled(
        batch.map(result =>
          torbox.resolve(result.hash).then(url => {
            if (!url) return null;
            return {
              url,
              name: `⚡ ${result.quality.toUpperCase()}`,
              description: `${result.title}\n${result.quality.toUpperCase()} | ${result.source}\n👥 ${result.seeders || 0} seeders | 💾 ${formatSize(result.size)}`,
              behaviorHints: {
                notWebReady: false,
                bingeGroup: `torbox|${result.hash}`,
                filename: result.title,
                videoSize: result.size || undefined,
              },
            };
          }).catch(() => null)
        )
      );
      for (const r of batchResults) {
        if (r.status === 'fulfilled' && r.value) streams.push(r.value);
      }
    }
    console.log(`[stream] Resolved ${streams.length}/${filtered.length} streams in ${((Date.now() - resolveStart) / 1000).toFixed(1)}s`);

    console.log(`[stream] Returning ${streams.length} streams`);
    return {
      streams,
      cacheMaxAge: streams.length > 0 ? 3600 : 60,
      staleRevalidate: streams.length > 0 ? 3600 : 0,
      staleError: streams.length > 0 ? 14400 : 0,
    };

  } catch (err) {
    console.error(`[stream] Error:`, err.message);
    return { streams: [] };
  }
});

// ─── Helpers ─────────────────────────────────────────────────────

function formatSize(bytes) {
  if (!bytes) return 'Unknown size';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(1)} ${units[i]}`;
}

// ─── Express App ─────────────────────────────────────────────────

const addonInterface = builder.getInterface();
const app = express();

app.use(getRouter(addonInterface));

// Custom configure page (Comet-style)
const CONFIGURE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TorBox Scraper - Setup</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#111;color:#eee;min-height:100vh;display:flex;justify-content:center;padding:32px 16px}
.wrap{max-width:640px;width:100%}
.card{background:#1a1a2e;border-radius:12px;padding:28px;margin-bottom:16px;border:1px solid #2a2a3e}
.logo{text-align:center;margin-bottom:8px}
.logo img{height:48px;border-radius:8px}
h1{font-size:22px;text-align:center;margin-bottom:4px}
.sub{text-align:center;color:#777;font-size:13px;margin-bottom:24px}
h2{font-size:15px;color:#aaa;margin-bottom:14px;text-transform:uppercase;letter-spacing:.5px;font-weight:600}
label{display:block;font-size:13px;color:#999;margin-bottom:6px}
input[type="password"],input[type="text"]{width:100%;padding:11px 14px;border-radius:8px;border:1px solid #333;background:#0d1117;color:#eee;font-size:14px;outline:none;transition:border .2s}
input:focus{border-color:#e94560}
.hint{font-size:11px;color:#555;margin-top:4px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:4px}
.chip{padding:7px 14px;border-radius:20px;border:1px solid #333;background:#0d1117;color:#aaa;font-size:13px;cursor:pointer;transition:all .2s;user-select:none}
.chip.active{border-color:#e94560;color:#fff;background:#e9456022}
.chip:hover{border-color:#e94560}
.row{display:flex;gap:12px}
.row>div{flex:1}
.btn{width:100%;padding:14px;border:none;border-radius:10px;background:#e94560;color:#fff;font-size:16px;font-weight:600;cursor:pointer;margin-top:8px;transition:background .2s}
.btn:hover{background:#c73650}
.btn:disabled{background:#333;cursor:not-allowed}
.result{display:none;margin-top:16px}
.result.show{display:block}
.url-box{background:#0d1117;border:1px solid #333;border-radius:8px;padding:12px;font-size:12px;word-break:break-all;color:#4ecca3;margin-bottom:10px;max-height:72px;overflow-y:auto}
.copy-btn{width:100%;padding:12px;border:2px solid #4ecca3;border-radius:8px;background:transparent;color:#4ecca3;font-size:14px;font-weight:600;cursor:pointer;transition:all .2s}
.copy-btn:hover{background:#4ecca3;color:#111}
.error{color:#e94560;font-size:13px;margin-top:6px;display:none}
.steps{margin-top:20px;font-size:12px;color:#666}
.steps li{margin-bottom:6px;line-height:1.5}
a{color:#4ecca3}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="logo"><img src="https://torbox.app/favicon.ico" alt="TorBox"></div>
    <h1>TorBox Scraper</h1>
    <p class="sub">Stremio Addon Configuration</p>

    <h2>🔑 Debrid Service</h2>
    <label>TorBox API Key</label>
    <input type="password" id="apikey" placeholder="Enter your TorBox API key" autocomplete="off">
    <p class="hint">Get your key from <a href="https://torbox.app/settings" target="_blank">torbox.app/settings</a></p>
    <div class="error" id="error">Please enter a valid API key</div>
  </div>

  <div class="card">
    <h2>📺 Resolutions</h2>
    <div class="chips" id="resChips">
      <div class="chip active" data-val="4k">4K UHD - 2160p</div>
      <div class="chip active" data-val="1440p">QHD - 1440p</div>
      <div class="chip active" data-val="1080p">FHD - 1080p</div>
      <div class="chip active" data-val="720p">HD - 720p</div>
      <div class="chip" data-val="576p">SD - 576p</div>
      <div class="chip active" data-val="480p">SD - 480p</div>
      <div class="chip" data-val="360p">LD - 360p</div>
      <div class="chip" data-val="240p">LD - 240p</div>
      <div class="chip" data-val="cam">CAM</div>
      <div class="chip" data-val="unknown">Unknown</div>
    </div>

    <div class="row" style="margin-top:16px">
      <div>
        <label>Max Size (GB, 0 = no limit)</label>
        <input type="text" id="maxsize" placeholder="0" value="0">
      </div>
      <div>
        <label>Sort Order</label>
        <select id="sort" style="width:100%;padding:11px 14px;border-radius:8px;border:1px solid #333;background:#0d1117;color:#eee;font-size:14px;outline:none">
          <option value="qualityseeders">Quality + Seeders</option>
          <option value="seeders">Most Seeders</option>
          <option value="size">Largest Size</option>
        </select>
      </div>
    </div>
  </div>

  <div class="card">
    <button class="btn" id="generate">Generate Install Link</button>
    <div class="result" id="result">
      <label style="display:block;font-size:12px;color:#888;margin-bottom:6px">Your install URL — copy this:</label>
      <div class="url-box" id="url"></div>
      <button class="copy-btn" id="copy">📋 Copy to Clipboard</button>
    </div>
  </div>

  <div class="card">
    <h2>📖 Setup Instructions</h2>
    <ol class="steps">
      <li>Get your API key from <a href="https://torbox.app/settings" target="_blank">torbox.app/settings</a></li>
      <li>Enter it above and configure your preferences</li>
      <li>Click "Generate Install Link" and copy the URL</li>
      <li>Open the URL in Stremio (Addons → Community → Install via URL)</li>
    </ol>
  </div>
</div>

<script>
// Chip toggling
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => chip.classList.toggle('active'));
});

const btn = document.getElementById('generate');
const copyBtn = document.getElementById('copy');

btn.addEventListener('click', () => {
  const key = document.getElementById('apikey').value.trim();
  if (!key) { document.getElementById('error').style.display = 'block'; return; }
  document.getElementById('error').style.display = 'none';

  const qualities = [...document.querySelectorAll('.chip.active')].map(c => c.dataset.val).join(',');
  const maxSize = document.getElementById('maxsize').value || '0';
  const sort = document.getElementById('sort').value;

  const config = encodeURIComponent(JSON.stringify({
    torbox_api_key: key,
    qualities: qualities,
    max_size: maxSize,
    sort: sort,
  }));

  const url = window.location.origin + '/' + config + '/manifest.json';
  document.getElementById('url').textContent = url;
  document.getElementById('result').classList.add('show');
});

copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('url').textContent).then(() => {
    copyBtn.textContent = '✅ Copied!';
    setTimeout(() => copyBtn.textContent = '📋 Copy to Clipboard', 2000);
  });
});

document.getElementById('apikey').addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
</script>
</body>
</html>`;

app.get('/', (req, res) => res.redirect('/configure'));

app.get('/configure', (req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(CONFIGURE_HTML);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', addon: manifest.name, version: manifest.version });
});

// Test endpoints
app.get('/test/:imdbId', async (req, res) => {
  const { imdbId } = req.params;
  const apiKey = req.query.key || process.env.TORBOX_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'Missing API key' });
  const torbox = new TorBoxAPI(apiKey);
  try {
    const validation = await torbox.validateKey();
    if (!validation.valid) return res.status(401).json({ error: 'Invalid API key', detail: validation.error });
    const results = await torbox.searchAll(imdbId, 'movie');
    res.json({ success: true, user: validation.user?.username, plan: validation.user?.subscription?.plan, results_count: results.length, results: results.slice(0, 10) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/test/:imdbId/:season/:episode', async (req, res) => {
  const { imdbId, season, episode } = req.params;
  const apiKey = req.query.key || process.env.TORBOX_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'Missing API key' });
  const torbox = new TorBoxAPI(apiKey);
  try {
    const results = await torbox.searchAll(imdbId, 'series', parseInt(season), parseInt(episode));
    res.json({ success: true, season: parseInt(season), episode: parseInt(episode), results_count: results.length, results: results.slice(0, 10) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Start ───────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║   TorBox Scraper Stremio Addon       ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('  Server:  ' + HOST + ':' + PORT);
  console.log('  Install: stremio://' + HOST + ':' + PORT + '/manifest.json');
  console.log('\n  Configure at: ' + HOST + ':' + PORT + '/configure');
  console.log('  Health: ' + HOST + ':' + PORT + '/health');
  console.log('\n  Test movie:  curl "' + HOST + ':' + PORT + '/test/tt1234567?key=YOUR_API_KEY"');
  console.log('  Test TV:     curl "' + HOST + ':' + PORT + '/test/tt1234567/1/1?key=YOUR_API_KEY"\n');
});
