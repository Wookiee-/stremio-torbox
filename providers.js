/**
 * Torrent Search Providers — only working providers with live domains
 * Working: TPB, BitSearch, BT4G, BTDig, TorLock, TheRarBG, LimeTorrents, TorrentGalaxy, 1337x, YTS, EZTV
 */

const fetch = require('node-fetch');
const cheerio = require('cheerio');

// ─── Shared Helpers ──────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

function extractInfoHash(magnet) {
  const m = magnet.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  return m ? m[1].toLowerCase() : null;
}

function parseSize(str) {
  if (!str) return 0;
  const m = str.match(/([\d.]+)\s*(B|KB|MB|GB|TB)\b/i);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  const u = { b: 1, kb: 1024, mb: 1024**2, gb: 1024**3, tb: 1024**4 };
  return Math.round(v * (u[m[2].toLowerCase()] || 1));
}

function parseIntSafe(v) { return parseInt(String(v || '').replace(/,/g, '').trim(), 10) || 0; }

const https = require('https');
const http = require('http');

async function httpGet(url, { params = {}, timeout = 10000, retries = 1 } = {}) {
  const qs = new URLSearchParams(params).toString();
  const fullUrl = qs ? `${url}?${qs}` : url;
  for (let i = 0; i <= retries; i++) {
    try {
      const parsed = new URL(fullUrl);
      const lib = parsed.protocol === 'https:' ? https : http;
      const text = await new Promise((resolve, reject) => {
        const req = lib.get(fullUrl, {
          headers: HEADERS,
          timeout,
          rejectUnauthorized: false,
        }, (res) => {
          // Follow redirects
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            httpGet(res.headers.location, { timeout, retries: 0 }).then(resolve, reject);
            return;
          }
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(data));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });
      try { return JSON.parse(text); } catch { return text; }
    } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

// ─── 1. The Pirate Bay (JSON API — apibay.org) ───────────────────

async function thepiratebay(query) {
  const data = await httpGet('https://apibay.org/q.php', { params: { q: query, cat: '0' }, timeout: 8000 });
  if (!Array.isArray(data) || data[0]?.id === '0') return [];
  return data.map(t => ({
    title: t.name || '',
    hash: (t.info_hash || '').toLowerCase(),
    size: parseInt(t.size || '0', 10),
    seeders: parseInt(t.seeders || '0', 10),
    source: 'TPB',
  })).filter(t => t.hash);
}

// ─── 2. YTS (JSON API — movies only) ─────────────────────────────

async function yts(imdbId) {
  const id = imdbId.replace(/^tt/, '');
  const data = await httpGet('https://yts.mx/api/v2/list_movies.json', {
    params: { query_term: id, limit: 50, sort_by: 'seeds' },
    timeout: 8000,
  });
  const movies = data?.data?.movies || [];
  return movies.flatMap(m => (m.torrents || []).map(t => ({
    title: `${m.title_long} [${t.quality}] [${t.type}]`,
    hash: (t.hash || '').toLowerCase(),
    size: t.size_bytes || 0,
    seeders: t.seeds || 0,
    source: 'YTS',
  }))).filter(t => t.hash);
}

// ─── 3. EZTV (JSON API — series only) ────────────────────────────

async function eztv(imdbId, season, episode) {
  const id = imdbId.replace(/^tt/, '');
  const data = await httpGet('https://eztv.re/api/get-torrents', {
    params: { imdb_id: id, limit: 100 },
    timeout: 8000,
  });
  let torrents = data?.torrents || [];
  if (season != null) {
    torrents = torrents.filter(t => {
      if (parseInt(t.season) !== season) return false;
      if (episode != null && parseInt(t.episode) !== episode) return false;
      return true;
    });
  }
  return torrents.map(t => ({
    title: t.title || '',
    hash: (t.hash || '').toLowerCase(),
    size: parseInt(t.size_bytes || '0', 10),
    seeders: t.seeds || 0,
    source: 'EZTV',
  })).filter(t => t.hash);
}

// ─── 4. BitSearch (HTML scraper) ─────────────────────────────────

async function bitsearch(query) {
  const html = await httpGet('https://bitsearch.eu/search', {
    params: { q: query, sort: 'seeders' },
    timeout: 10000,
  });
  const $ = cheerio.load(html);
  const results = [];
  $('a[href^="magnet:"]').each((_, el) => {
    const $card = $(el).closest('div.bg-white');
    if (!$card.length) return;
    const magnet = $(el).attr('href') || '';
    const hash = extractInfoHash(magnet);
    if (!hash || results.some(r => r.hash === hash)) return;
    const title = $card.find('a[href^="/torrent/"]').first().text().replace(/\s+/g, ' ').trim();
    if (!title) return;
    const text = $card.text().replace(/\s+/g, ' ');
    const seedM = text.match(/([\d,]+)\s+seeders/i);
    results.push({
      title, hash,
      seeders: seedM ? parseInt(seedM[1].replace(/,/g, ''), 10) : 0,
      size: parseSize(text),
      source: 'BitSearch',
    });
  });
  return results.slice(0, 30);
}

// ─── 5. BT4G (HTML scraper) ──────────────────────────────────────

async function bt4g(query) {
  const html = await httpGet(`https://bt4gprx.com/search/${encodeURIComponent(query)}/byseeders/1`, { timeout: 10000 });
  const $ = cheerio.load(html);
  const results = [];
  $('div.search-ret-item, div.one-result').each((_, el) => {
    const $el = $(el);
    const title = $el.find('h5 a, a.item-title').first().text().trim();
    const magnet = $el.find('a[href^="magnet:"]').first().attr('href') || '';
    const hash = extractInfoHash(magnet);
    if (!hash || !title) return;
    const text = $el.text();
    const sizeM = text.match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
    results.push({
      title, hash,
      seeders: parseInt((text.match(/(\d+)\s*seeder/i) || [,'0'])[1], 10),
      size: sizeM ? parseSize(sizeM[0]) : 0,
      source: 'BT4G',
    });
  });
  return results;
}

// ─── 6. BTDig (HTML scraper) ─────────────────────────────────────

async function btdig(query) {
  const html = await httpGet('https://btdig.com/search', {
    params: { q: query, order: 0 },
    timeout: 10000,
  });
  const $ = cheerio.load(html);
  const results = [];
  $('div.one_result').each((_, el) => {
    const $el = $(el);
    const titleEl = $el.find('div.torrent_name a').first();
    const title = titleEl.text().trim();
    const href = titleEl.attr('href') || '';
    const hashFromUrl = (href.match(/([a-fA-F0-9]{40})/i) || [])[1]?.toLowerCase();
    const magnet = $el.find('a[href^="magnet:"]').first().attr('href') || '';
    const hash = extractInfoHash(magnet) || hashFromUrl;
    if (!hash || !title) return;
    const statsText = $el.find('div.torrent_stats, span.torrent_size').text();
    results.push({
      title, hash, seeders: 0,
      size: parseSize(statsText),
      source: 'BTDig',
    });
  });
  return results;
}

// ─── 7. TorLock (HTML scraper) ───────────────────────────────────

async function torlock(query, type) {
  const cat = type === 'movie' ? 'movies' : 'television';
  const data = await httpGet(`https://torlock2.com/${cat}/torrents/${encodeURIComponent(query)}.html`, { timeout: 10000 });
  const $ = cheerio.load(data);
  const results = [];
  $('table tbody tr, div.table-striped article').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 5) return;
    const title = cells.eq(0).find('a').first().text().trim();
    const magnet = $(row).find('a[href^="magnet:"]').first().attr('href') || '';
    const hash = extractInfoHash(magnet);
    if (!hash || !title) return;
    results.push({
      title, hash,
      seeders: parseIntSafe(cells.eq(3).text()),
      size: parseSize(cells.eq(2).text()),
      source: 'TorLock',
    });
  });
  return results;
}

// ─── 8. TheRarBG (HTML scraper, detail pages) ────────────────────

async function therarbg(query, type) {
  const cat = type === 'movie' ? 'Movies' : 'TV';
  const html = await httpGet(`https://therarbg.com/get-posts/order:-se:category:${cat}:keywords:${encodeURIComponent(query)}/`, { timeout: 10000 });
  const $ = cheerio.load(html);
  const urls = [];
  $('table tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 3) return;
    const href = $(cells[1]).find('a').first().attr('href');
    if (href) urls.push(href.startsWith('http') ? href : `https://therarbg.com${href}`);
  });
  const results = [];
  for (const url of urls.slice(0, 15)) {
    try {
      const detail = await httpGet(url, { timeout: 8000 });
      const $d = cheerio.load(detail);
      const magnet = $d('a[href^="magnet:"]').first().attr('href') || '';
      const hash = extractInfoHash(magnet);
      if (!hash) continue;
      const title = $d('h1').first().text().trim() || $d('title').text().replace(/ - TheRarBG.*/, '').trim();
      results.push({ title, hash, seeders: 0, size: 0, source: 'TheRarBG' });
    } catch { /* skip */ }
  }
  return results;
}

// ─── 9. TorrentGalaxy (HTML scraper) ─────────────────────────────

async function torrentgalaxy(query) {
  const html = await httpGet('https://torrentgalaxy.to/torrents.php', {
    params: { search: query, nox: 1, sort: 'seeders', order: 'desc' },
    timeout: 10000,
  });
  const $ = cheerio.load(html);
  const results = [];
  $('div.tgxtablerow').each((_, row) => {
    const $r = $(row);
    const title = $r.find('a.txlight').first().text().trim();
    const magnet = $r.find('a[href^="magnet:"]').first().attr('href') || '';
    const hash = extractInfoHash(magnet);
    if (!hash || !title) return;
    results.push({
      title, hash,
      seeders: parseIntSafe($r.find('span.badge-success').first().text()),
      size: parseSize($r.find('span.badge-secondary').first().text()),
      source: 'TorrentGalaxy',
    });
  });
  return results;
}

// ─── 10. 1337x (HTML scraper, detail pages) ──────────────────────

async function leetx(query, type) {
  const cat = type === 'movie' ? 'Movies' : 'TV';
  const html = await httpGet(`https://1337x.to/category-search/${encodeURIComponent(query)}/${cat}/1/`, { timeout: 10000 });
  const $ = cheerio.load(html);
  const detailUrls = [];
  $('table.table-list tbody tr').each((_, row) => {
    const href = $(row).find('td.name a').last().attr('href');
    if (href) detailUrls.push(href.startsWith('http') ? href : `https://1337x.to${href}`);
  });
  const results = [];
  for (const url of detailUrls.slice(0, 15)) {
    try {
      const detail = await httpGet(url, { timeout: 8000 });
      const $d = cheerio.load(detail);
      const magnet = $d('a[href^="magnet:"]').first().attr('href') || '';
      const hash = extractInfoHash(magnet);
      if (!hash) continue;
      results.push({
        title: $d('div.box-info-heading h1').text().trim() || '',
        hash,
        seeders: parseIntSafe($d('span.seeds').first().text()),
        size: parseSize($d('div.file-size').text()),
        source: '1337x',
      });
    } catch { /* skip */ }
  }
  return results;
}

// ─── 11. LimeTorrents (HTML scraper) ─────────────────────────────

async function limetorrents(query, type) {
  const cat = type === 'movie' ? 'movies' : 'tv';
  const html = await httpGet(`https://www.limetorrents.lol/search/${cat}/${encodeURIComponent(query)}/seeds/1/`, { timeout: 10000 });
  const $ = cheerio.load(html);
  const results = [];
  $('table.table2 tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 5) return;
    const title = cells.eq(0).find('a[href*="-torrent-"]').first().text().trim();
    const torrentHref = cells.eq(0).find('a[href*="itorrents.net/torrent/"]').first().attr('href');
    const hashFromUrl = (torrentHref || '').match(/\/torrent\/([a-fA-F0-9]{40})\.torrent/i);
    const hash = hashFromUrl ? hashFromUrl[1].toLowerCase() : null;
    if (!title || !hash) return;
    results.push({
      title, hash,
      seeders: parseIntSafe(cells.eq(3).text()),
      size: parseSize(cells.eq(2).text()),
      source: 'LimeTorrents',
    });
  });
  return results;
}

// ─── 12. EXT.to (HTML scraper) ───────────────────────────────────

async function extto(query, type) {
  const cat = type === 'movie' ? 'movies' : 'series';
  const html = await httpGet(`https://ext.to/search/${encodeURIComponent(query)}/${cat}/`, { timeout: 10000 });
  const $ = cheerio.load(html);
  const results = [];
  $('table tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 5) return;
    const title = cells.eq(1).find('a').first().text().trim();
    const magnet = $(row).find('a[href^="magnet:"]').first().attr('href') || '';
    const hash = extractInfoHash(magnet);
    if (!hash || !title) return;
    results.push({
      title, hash,
      seeders: parseIntSafe(cells.eq(3).text()),
      size: parseSize(cells.eq(2).text()),
      source: 'EXT',
    });
  });
  return results;
}

// ─── Metadata Lookup ────────────────────────────────────────────

async function lookupMeta(imdbId, type) {
  try {
    const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
    const data = await httpGet(url, { timeout: 8000 });
    return data?.meta || null;
  } catch { return null; }
}

// ─── Unified Search ──────────────────────────────────────────────

// ─── 13. Knaben (multi-source aggregator, 100 results per search) ──

async function knaben(query, type) {
  const cat = type === 'movie' ? 'Movies' : 'TV';
  const html = await httpGet(`https://knaben.org/search`, {
    params: { q: query, category: cat },
    timeout: 10000,
  });
  const $ = cheerio.load(html);
  const results = [];
  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 6) return;
    const titleCell = cells.eq(1);
    const title = titleCell.text().trim();
    const magnet = titleCell.find('a[href^="magnet:"]').attr('href') || '';
    const hash = extractInfoHash(magnet);
    if (!hash || !title) return;
    const sizeText = cells.eq(2).text().trim();
    const seeders = parseIntSafe(cells.eq(4).text());
    const source = cells.eq(6).text().trim() || 'Knaben';
    results.push({
      title, hash,
      size: parseSize(sizeText),
      seeders,
      source,
    });
  });
  return results;
}

const PROVIDERS = {
  knaben, thepiratebay, yts, eztv, bitsearch, bt4g, btdig, torlock,
  therarbg, torrentgalaxy, leetx, limetorrents, extto,
};

/**
 * Search all providers in parallel with per-provider timeout and logging.
 */
async function searchAllProviders(imdbId, type, season, episode) {
  const meta = await lookupMeta(imdbId, type);
  const name = meta?.name || '';
  const year = meta?.year || '';

  let query = name ? (year ? `${name} ${year}` : name) : imdbId;
  if (type === 'series' && season && episode && name) {
    query = `${name} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  } else if (type === 'series' && name) {
    query = name;
  }

  console.log(`[providers] Query: "${query}" (from ${imdbId})`);

  const PROVIDER_TIMEOUT = 12000;

  const tasks = Object.entries(PROVIDERS).map(([name, fn]) => {
    return (async () => {
      if (name === 'yts' && type !== 'movie') return [];
      if (name === 'eztv' && type !== 'series') return [];
      const args = name === 'eztv' ? [imdbId, season, episode]
        : name === 'thepiratebay' ? [query]
        : name === 'yts' ? [imdbId]
        : [query, type];
      const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), PROVIDER_TIMEOUT));
      return Promise.race([fn(...args), timer]);
    })().catch(() => []);
  });

  const allSettled = await Promise.allSettled(tasks);
  const allResults = [];
  const providerNames = Object.keys(PROVIDERS);
  const providerStats = [];

  for (let i = 0; i < allSettled.length; i++) {
    const s = allSettled[i];
    const name = providerNames[i];
    if (s.status === 'fulfilled' && Array.isArray(s.value)) {
      allResults.push(...s.value);
      providerStats.push(`${name}:${s.value.length}`);
    } else {
      providerStats.push(`${name}:FAIL`);
    }
  }
  console.log(`[providers] Results: ${providerStats.join(', ')}`);

  // Deduplicate by hash, keep highest seeders
  const byHash = new Map();
  for (const r of allResults) {
    if (!r.hash) continue;
    const existing = byHash.get(r.hash);
    if (!existing || (r.seeders || 0) > (existing.seeders || 0)) {
      byHash.set(r.hash, r);
    }
  }

  const deduped = [...byHash.values()].sort((a, b) => (b.seeders || 0) - (a.seeders || 0));

  const matched = filterByContent(deduped, name, type, season, episode);
  if (deduped.length !== matched.length) {
    console.log(`[providers] Content filter: ${deduped.length} -> ${matched.length} (dropped ${deduped.length - matched.length} unrelated)`);
  }

  console.log(`[providers] ${matched.length} unique results from ${providerNames.length} providers`);
  return matched;
}

// ─── Content filter (ported from Magnetio) ──────────────────────

function filterByContent(records, name, type, season, episode) {
  if (!name) return records;

  const nameWords = normalizeTitle(name).split(/\s+/).filter(w => w.length > 1);
  if (!nameWords.length) return records;

  return records.filter(r => {
    if (!r.title) return false;
    const norm = normalizeTitle(r.title);

    if (nameWords.length <= 2) {
      const phraseRegex = new RegExp(`\\b${nameWords.map(w => escapeRegex(w)).join('\\s+')}\\b`);
      if (!phraseRegex.test(norm)) return false;
    } else {
      const matchCount = nameWords.filter(w =>
        new RegExp(`\\b${escapeRegex(w)}\\b`).test(norm)
      ).length;
      if (matchCount < Math.max(1, Math.ceil(nameWords.length * 0.5))) return false;
    }

    if (type === 'series' && season != null) {
      const s = season;
      const e = episode;
      const hasSeasonEp = new RegExp(
        e != null
          ? `s0*${s}\\s*e0*${e}\\b`
          : `s0*${s}(e\\d|\\b)`,
        'i'
      ).test(r.title);
      const hasLooseEp = e != null && new RegExp(`\\b${s}x0*${e}\\b`, 'i').test(r.title);
      const hasSeasonPack = new RegExp(
        `\\bseason\\s*0*${s}\\b|\\bcomplete\\b.*\\bs0*${s}\\b`,
        'i'
      ).test(r.title);
      if (!hasSeasonEp && !hasLooseEp && !hasSeasonPack) return false;
    }

    return true;
  });
}

function normalizeTitle(str) {
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { searchAllProviders, PROVIDERS };
