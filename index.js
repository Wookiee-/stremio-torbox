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
  background: 'https://dl.strem.io/addon-background.jpg',
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
    { key: 'exclude_qualities', title: 'Exclude Resolutions', type: 'text' },
    { key: 'max_size', title: 'Max Size (GB)', type: 'text' },
    { key: 'sort', title: 'Sort Order', type: 'text' },
    { key: 'dedupe', title: 'Deduplicate Streams', type: 'checkbox' },
  ],
};

// ─── Builder ─────────────────────────────────────────────────────

const builder = new addonBuilder(manifest);

// ─── Stream Handler ──────────────────────────────────────────────

builder.defineStreamHandler(async ({ type, id, config }) => {
  const apiKey = config?.torbox_api_key || config?.torbox;
  if (!apiKey) {
    console.error('[stream] No TorBox API key provided');
    return { streams: [] };
  }

  // Parse excluded qualities (comma-separated list of resolutions to EXCLUDE)
  const excludeQualitiesRaw = (config?.exclude_qualities || config?.qualityfilter || '');
  const excludedQualities = (Array.isArray(excludeQualitiesRaw) ? excludeQualitiesRaw : excludeQualitiesRaw.split(','))
    .map(q => q.trim().toLowerCase())
    .filter(Boolean);

  const maxSizeGB = parseFloat(config?.max_size || config?.sizefilter) || 0;
  const sortKey = (config?.sort || 'qualityseeders').toLowerCase();
  const dedupe = config?.dedupe === true || config?.dedupe === 'true' || config?.dedupe === '1';

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

    const cached = await torbox.searchAll(imdbId, type, season, episode, {
      excludedQualities,
      maxSizeBytes: maxSizeGB > 0 ? maxSizeGB * 1024 * 1024 * 1024 : 0,
      dedupe,
    });

    if (cached.length === 0) {
      return { streams: [] };
    }

    // Apply config filters (Exclude chosen resolutions)
    let filtered = cached.filter(r => {
      const q = (r.quality || 'unknown').toLowerCase();
      if (excludedQualities.includes(q)) return false;
      if (maxSizeGB > 0 && r.size > maxSizeGB * 1024 * 1024 * 1024) return false;
      return true;
    });

    // Sort first based on preference (seeders / size / quality)
    if (sortKey === 'seeders') {
      filtered.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
    } else if (sortKey === 'size') {
      filtered.sort((a, b) => (b.size || 0) - (a.size || 0));
    }

    // Deduplicate streams if enabled (only keep 1 stream per provider per resolution)
    if (dedupe) {
      const seen = new Set();
      filtered = filtered.filter(r => {
        const provider = (r.source || 'unknown').toLowerCase();
        const quality = (r.quality || 'unknown').toLowerCase();
        const key = `${provider}:${quality}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    // Cap at 50
    filtered = filtered.slice(0, 50);

    const baseUrl = process.env.BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `${HOST}:${PORT}`);

    // Return instant lazy-resolved stream URLs (Torrentio style)
    const streams = filtered.map(result => {
      const safeTitle = encodeURIComponent(result.title.replace(/[/\\?%*:|"<>]/g, ''));
      const resolveUrl = `${baseUrl}/resolve/${encodeURIComponent(apiKey)}/${result.hash}/${safeTitle}`;

      return {
        url: resolveUrl,
        name: `⚡ ${result.quality.toUpperCase()}`,
        description: `${result.title}\n${result.quality.toUpperCase()} | ${result.source}\n👥 ${result.seeders || 0} seeders | 💾 ${formatSize(result.size)}`,
        behaviorHints: {
          notWebReady: false,
          bingeGroup: `torbox|${result.hash}`,
          filename: result.title,
          videoSize: result.size || undefined,
        },
      };
    });

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

// Enable trust proxy for correct protocol / host resolution behind reverse proxies
app.enable('trust proxy');

// Resolve endpoint: called when Stremio plays a stream (Torrentio-style on-demand resolution)
async function handleResolve(req, res) {
  const { apiKey, hash, fileName } = req.params;
  const decodedFileName = fileName ? decodeURIComponent(fileName) : '';
  console.log(`[resolve] Resolving ${hash} (${decodedFileName || 'default'})...`);

  try {
    const torbox = new TorBoxAPI(apiKey);
    const downloadUrl = await torbox.resolve(hash, decodedFileName);

    if (downloadUrl) {
      console.log(`[resolve] Success -> 302 redirecting to TorBox CDN`);
      res.setHeader('Cache-Control', 'max-age=21600, public'); // 6 hours
      return res.redirect(302, downloadUrl);
    } else {
      console.error(`[resolve] Could not resolve download URL for ${hash}`);
      return res.status(404).send('Stream not ready or failed');
    }
  } catch (err) {
    console.error(`[resolve] Error:`, err.message);
    return res.status(500).send('Error resolving stream');
  }
}

app.get('/resolve/:apiKey/:hash/:fileName', handleResolve);
app.get('/resolve/:apiKey/:hash', handleResolve);

// Custom configure page (Torrentio styled)
function renderConfigureHtml(config = {}) {
  const apiKey = config.torbox_api_key || config.torbox || '';
  const excluded = (config.exclude_qualities || config.qualityfilter || '')
    .split(',')
    .map(q => q.trim().toLowerCase())
    .filter(Boolean);
  const maxSize = config.max_size || config.sizefilter || '';
  const sort = config.sort || 'qualityseeders';
  const dedupe = config.dedupe === true || config.dedupe === 'true' || config.dedupe === '1';

  const resolutions = [
    { key: '4k', label: '4K UHD (2160p)' },
    { key: '1440p', label: '1440p (QHD)' },
    { key: '1080p', label: '1080p (FHD)' },
    { key: '720p', label: '720p (HD)' },
    { key: '576p', label: '576p (SD)' },
    { key: '480p', label: '480p (SD)' },
    { key: '360p', label: '360p (LD)' },
    { key: '240p', label: '240p (LD)' },
    { key: 'cam', label: 'CAM / TeleSync' },
    { key: 'unknown', label: 'Unknown Quality' }
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>TorBox Scraper - Configuration</title>
<link rel="shortcut icon" href="https://torbox.app/favicon.ico" type="image/x-icon">
<script src="https://cdn.tailwindcss.com"></script>
<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap" rel="stylesheet">
<style>
  body { font-family: 'Inter', sans-serif; }
  .glass {
    background: rgba(17, 24, 39, 0.92);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid rgba(255, 255, 255, 0.1);
  }
  [x-cloak] { display: none !important; }
</style>
<script>
document.addEventListener('alpine:init', () => {
  Alpine.data('addonConfig', () => ({
    apiKey: ${JSON.stringify(apiKey)},
    excludedQualities: ${JSON.stringify(excluded)},
    maxSize: ${JSON.stringify(maxSize)},
    sort: ${JSON.stringify(sort)},
    dedupe: ${JSON.stringify(dedupe)},
    installUrl: '#',
    copiedInstall: false,
    resolutions: ${JSON.stringify(resolutions)},

    generateLink() {
      if (!this.apiKey.trim()) {
        this.installUrl = '#';
        return;
      }
      const configObj = {
        torbox_api_key: this.apiKey.trim(),
        exclude_qualities: this.excludedQualities.join(','),
        max_size: this.maxSize ? this.maxSize.trim() : '',
        sort: this.sort,
        dedupe: this.dedupe
      };

      const encoded = encodeURIComponent(JSON.stringify(configObj));
      this.installUrl = 'stremio://' + window.location.host + '/' + encoded + '/manifest.json';
    },

    copyLink() {
      if (this.installUrl === '#') return;
      const httpsLink = this.installUrl.replace('stremio://', window.location.protocol + '//');
      navigator.clipboard.writeText(httpsLink).then(() => {
        this.copiedInstall = true;
        setTimeout(() => { this.copiedInstall = false }, 2000);
      });
    }
  }));
});
</script>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen flex items-center justify-center p-3 md:p-6"
      style="background-image: radial-gradient(circle at top right, rgba(99, 102, 241, 0.15), transparent 40%), radial-gradient(circle at bottom left, rgba(233, 69, 96, 0.12), transparent 50%), url('https://dl.strem.io/addon-background.jpg'); background-size: cover; background-position: center; background-attachment: fixed;">
  <div class="fixed inset-0 bg-black/75 z-0"></div>

  <div x-data="addonConfig" x-effect="generateLink()" x-cloak class="relative z-10 w-full max-w-2xl glass rounded-2xl shadow-2xl overflow-hidden my-auto border border-gray-800">
    <!-- Header -->
    <div class="text-center py-6 px-6 bg-gray-900/60 border-b border-gray-800">
      <img src="https://torbox.app/favicon.ico" class="w-14 h-14 mx-auto rounded-xl shadow-lg mb-3" alt="TorBox Logo">
      <div class="flex items-center justify-center gap-2 mb-1">
        <h1 class="text-2xl font-bold tracking-tight text-white">TorBox Scraper</h1>
        <span class="text-xs font-mono bg-indigo-950/80 text-indigo-400 border border-indigo-800/60 px-2 py-0.5 rounded-full">v1.0.0</span>
      </div>
      <p class="text-xs md:text-sm text-gray-400 max-w-md mx-auto">
        Stream cached torrents directly via TorBox debrid service with instant scraping.
      </p>
    </div>

    <!-- Form Body -->
    <div class="p-6 space-y-6">
      <!-- TorBox API Key -->
      <div>
        <div class="flex justify-between items-center mb-2">
          <label class="text-xs font-bold text-gray-300 uppercase tracking-wider">TorBox API Key <span class="text-red-400">*</span></label>
          <a href="https://torbox.app/settings" target="_blank" class="text-xs text-indigo-400 hover:text-indigo-300 hover:underline">Get API Key &rarr;</a>
        </div>
        <input type="password" x-model="apiKey" placeholder="Enter your TorBox API key" autocomplete="off"
               class="w-full bg-gray-900/90 border border-gray-700 text-sm text-white rounded-xl px-4 py-3 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 outline-none transition-all font-mono">
      </div>

      <!-- Exclude Resolutions -->
      <div>
        <div class="flex justify-between items-center mb-2">
          <label class="text-xs font-bold text-gray-300 uppercase tracking-wider">Exclude Resolutions</label>
          <span class="text-[11px] text-gray-500">Checked resolutions will be hidden</span>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <template x-for="q in resolutions" :key="q.key">
            <label class="flex items-center space-x-2.5 cursor-pointer bg-gray-900/80 px-3.5 py-2.5 rounded-xl border border-gray-800 hover:border-gray-700 transition-colors select-none">
              <input type="checkbox" :value="q.key" x-model="excludedQualities" class="w-4 h-4 text-red-500 rounded bg-gray-800 border-gray-700 focus:ring-red-500">
              <span class="text-xs font-medium text-gray-300" x-text="q.label"></span>
            </label>
          </template>
        </div>
      </div>

      <!-- Row: Max Size & Sorting -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-bold text-gray-300 uppercase tracking-wider mb-2">Max Video Size (GB)</label>
          <input type="number" step="0.5" min="0" x-model="maxSize" placeholder="0 (No limit)"
                 class="w-full bg-gray-900/90 border border-gray-700 text-sm text-white rounded-xl px-4 py-3 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 outline-none transition-all">
        </div>
        <div>
          <label class="block text-xs font-bold text-gray-300 uppercase tracking-wider mb-2">Sort Order</label>
          <select x-model="sort" class="w-full bg-gray-900/90 border border-gray-700 text-sm text-white rounded-xl px-4 py-3 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 outline-none transition-all">
            <option value="qualityseeders">Quality + Most Seeders</option>
            <option value="seeders">Most Seeders</option>
            <option value="size">Largest Size</option>
          </select>
        </div>
      </div>

      <!-- Deduplicate Option -->
      <div>
        <label class="flex items-center space-x-3 cursor-pointer bg-gray-900/80 px-4 py-3 rounded-xl border border-gray-800 hover:border-gray-700 transition-colors select-none">
          <input type="checkbox" x-model="dedupe" class="w-4 h-4 text-indigo-600 rounded bg-gray-800 border-gray-700 focus:ring-indigo-500">
          <div>
            <span class="text-xs font-bold text-gray-200 block">Deduplicate Streams</span>
            <span class="text-[11px] text-gray-400 block">Limit to 1 stream per provider per resolution (hides duplicates from the same scraper)</span>
          </div>
        </label>
      </div>
    </div>

    <!-- Action Buttons -->
    <div class="p-6 bg-gray-900/90 border-t border-gray-800/80 space-y-3">
      <!-- Install to Stremio Button -->
      <a :href="installUrl" :class="apiKey.trim() ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 cursor-pointer' : 'bg-gray-800 text-gray-500 cursor-not-allowed pointer-events-none'"
         class="block w-full text-center py-3.5 rounded-xl font-bold tracking-wide text-sm uppercase transition-all duration-200 transform active:scale-[0.99]">
        Install to Stremio
      </a>

      <!-- Copy Install URL Button -->
      <button @click="copyLink" :disabled="!apiKey.trim()"
              :class="apiKey.trim() ? 'border-gray-700 hover:border-gray-500 text-gray-300 hover:text-white bg-gray-800/50' : 'border-gray-800 text-gray-600 cursor-not-allowed'"
              class="w-full py-3 rounded-xl font-semibold text-xs uppercase border transition-all duration-200 flex items-center justify-center gap-2">
        <span x-text="copiedInstall ? '✅ Copied to Clipboard!' : '📋 Copy Install Link'"></span>
      </button>

      <p class="text-center text-[11px] text-gray-500 pt-1">
        Click "Install to Stremio" to open directly in the app, or copy the URL and paste into Stremio's Addon search bar.
      </p>
    </div>
  </div>
</body>
</html>`;
}

app.get('/', (req, res) => res.redirect('/configure'));

app.get('/configure', (req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(renderConfigureHtml());
});

app.get('/:configuration/configure', (req, res) => {
  let config = {};
  try {
    config = JSON.parse(decodeURIComponent(req.params.configuration));
  } catch {}
  res.setHeader('content-type', 'text/html');
  res.end(renderConfigureHtml(config));
});

app.use(getRouter(addonInterface));

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

// ─── Start / Export ──────────────────────────────────────────────

if (process.env.VERCEL !== '1' && !process.env.VERCEL_URL) {
  const server = app.listen(PORT, () => {
    console.log(`TorBox Stremio Addon running at ${HOST}:${PORT}`);
  });

  function shutdown(signal) {
    console.log(`Stopping TorBox Stremio Addon (${signal})...`);
    server.close(() => {
      console.log('TorBox Stremio Addon stopped.');
      process.exit(0);
    });
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = app;
