/**
 * TorBox API Client — Torrentio-style cached check and lazy resolve
 */

const axios = require('axios');
const querystring = require('querystring');
const { searchAllProviders } = require('./providers');

const TB_BASE = 'https://api.torbox.app/v1';

// ─── Quality tiers ───────────────────────────────────────────────

const QUALITY_ORDER = ['8k', '4k', '1440p', '1080p', '720p', '576p', '480p', '360p', '240p', 'cam', 'unknown'];

function extractQuality(title) {
  const t = (title || '').toLowerCase();
  if (/\b(cam|camrip|ts|telesync|hdcam)\b/.test(t)) return 'cam';
  if (/\b(8k|7680)\b/.test(t)) return '8k';
  if (/\b(4k|2160p|uhd)\b/.test(t)) return '4k';
  if (/\b(1440p|qhd)\b/.test(t)) return '1440p';
  if (/\b(1080p|fhd)\b/.test(t)) return '1080p';
  if (/\b(720p)\b/.test(t)) return '720p';
  if (/\b(576p)\b/.test(t)) return '576p';
  if (/\b(480p)\b/.test(t)) return '480p';
  if (/\b(360p)\b/.test(t)) return '360p';
  if (/\b(240p)\b/.test(t)) return '240p';
  return 'unknown';
}

function sortByQualityThenSeeders(results) {
  const groups = new Map();
  for (const q of QUALITY_ORDER) groups.set(q, []);
  groups.set('unknown', []);

  for (const r of results) {
    const q = extractQuality(r.title);
    const group = groups.get(q) || groups.get('unknown');
    group.push(r);
  }

  const sorted = [];
  for (const group of groups.values()) {
    group.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
    sorted.push(...group);
  }
  return sorted;
}

// ─── HTTP helpers ────────────────────────────────────────────────

async function tbRequest(apiKey, method, path, { params, body } = {}) {
  const query = params ? `?${new URLSearchParams(params)}` : '';
  const isJson = body && !(body instanceof URLSearchParams);
  const response = await axios({
    method,
    url: `${TB_BASE}${path}${query}`,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(isJson ? { 'Content-Type': 'application/json' } : {}),
    },
    data: isJson ? JSON.stringify(body) : body,
    timeout: 10000,
  });
  const result = response.data;
  if (!result?.success) throw result;
  return result.data;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── TorBox API class ──────────────────────────────────────────

class TorBoxAPI {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  // ─── Cache check (batch check up to 100 hashes) ─────────────
  async getCachedStreams(hashes) {
    if (!hashes || hashes.length === 0) return new Map();

    try {
      const data = await tbRequest(this.apiKey, 'POST', '/api/torrents/checkcached', {
        params: { format: 'list' },
        body: { hashes },
      });

      const result = new Map();
      const entries = Array.isArray(data) ? data : [];
      for (const entry of entries) {
        if (entry.hash) {
          result.set(entry.hash.toLowerCase(), entry);
        }
      }
      return result;
    } catch (err) {
      const detail = err?.detail || err?.error || err?.message || '';
      console.error(`[torbox] checkcached error: ${typeof detail === 'string' ? detail.substring(0, 200) : JSON.stringify(detail).substring(0, 200)}`);
      return new Map();
    }
  }

  // ─── Resolve a single torrent to direct stream URL (On-demand when played) ─
  async resolve(infoHash, fileName) {
    const start = Date.now();
    console.log(`[torbox] resolve() start hash=${infoHash}, fileName="${(fileName || '').substring(0, 60)}"`);
    try {
      const data = await tbRequest(this.apiKey, 'POST', '/api/torrents/createtorrent', {
        body: new URLSearchParams({ magnet: `magnet:?xt=urn:btih:${infoHash}` }),
      });
      console.log(`[torbox]   createtorrent ok in ${Date.now() - start}ms torrent_id=${data?.torrent_id} queued_id=${data?.queued_id} detail=${data?.detail || ''}`);

      if (!data?.torrent_id && !data?.queued_id) {
        console.error(`[torbox]   createtorrent returned no id: ${JSON.stringify(data).substring(0, 200)}`);
        return null;
      }
      const torrentId = data.torrent_id || data.queued_id;

      let torrents = await tbRequest(this.apiKey, 'GET', '/api/torrents/mylist', {
        params: { id: torrentId },
      });

      let torrent = Array.isArray(torrents) ? torrents[0] : torrents;
      if (!torrent) {
        console.error(`[torbox]   mylist returned nothing for id=${torrentId} (raw=${JSON.stringify(torrents).substring(0, 200)})`);
        return null;
      }
      console.log(`[torbox]   mylist ok: id=${torrent.id || torrentId} download_present=${torrent.download_present} download_state=${torrent.download_state} files=${(torrent.files || []).length} in ${Date.now() - start}ms`);

      // If not ready, brief poll
      if (!torrent.download_present) {
        console.log(`[torbox]   not download_present, polling up to 3x...`);
        for (let i = 0; i < 3; i++) {
          await sleep(800);
          const retry = await tbRequest(this.apiKey, 'GET', '/api/torrents/mylist', {
            params: { id: torrentId },
          });
          const rt = Array.isArray(retry) ? retry[0] : retry;
          console.log(`[torbox]   poll#${i + 1}: download_present=${rt?.download_present} state=${rt?.download_state} files=${(rt?.files || []).length}`);
          if (rt?.download_present) {
            torrent = rt;
            break;
          }
          if (['error', 'dead'].includes(rt?.download_state)) {
            console.error(`[torbox]   torrent in ${rt.download_state} state, giving up`);
            return null;
          }
        }
      }

      const url = this._buildUrl(torrent, torrentId, fileName);
      if (url) {
        console.log(`[torbox]   SUCCESS built download URL in ${Date.now() - start}ms: ${url.substring(0, 120)}...`);
      } else {
        console.error(`[torbox]   FAILED to build download URL (no video file selected) in ${Date.now() - start}ms`);
      }
      return url;
    } catch (err) {
      const detail = err?.detail || err?.error || err?.message || '';
      console.error(`[torbox] resolve error (${Date.now() - start}ms): ${typeof detail === 'string' ? detail.substring(0, 300) : JSON.stringify(detail).substring(0, 300)}`);
      return null;
    }
  }

  _buildUrl(torrent, torrentId, targetFileName) {
    const files = torrent?.files ?? [];
    const VIDEO_EXTS = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts)$/i;

    const videos = files.filter(f => VIDEO_EXTS.test(f.short_name ?? f.name ?? ''));
    if (!files.length) console.error(`[torbox]   _buildUrl: torrent has NO files (state=${torrent?.download_state})`);
    if (!videos.length) console.error(`[torbox]   _buildUrl: ${files.length} files but none look like video`);
    let target = null;

    if (targetFileName) {
      const fn = targetFileName.toLowerCase();
      target = videos.find(v => (v.name || '').toLowerCase().includes(fn)) ||
               files.find(f => (f.name || '').toLowerCase().includes(fn));
      console.log(`[torbox]   _buildUrl: targetFileName match => ${target ? 'FOUND id=' + target.id : 'none, fallback to largest video'}`);
    }

    if (!target) {
      target = videos.length
        ? videos.reduce((a, b) => (a.size ?? 0) >= (b.size ?? 0) ? a : b)
        : files[0];
    }

    if (!target) return null;

    const params = {
      token: this.apiKey,
      torrent_id: torrentId,
      file_id: target.id,
      redirect: true,
    };
    return `${TB_BASE}/api/torrents/requestdl?${querystring.stringify(params)}`;
  }

  // ─── Main search — returns cached torrents directly ───────────
  async searchAll(imdbId, type, season, episode, options = {}) {
    const records = await searchAllProviders(imdbId, type, season, episode);
    if (records.length === 0) return [];

    const { excludedQualities = [], maxSizeBytes = 0, dedupe = false } = options;

    // Deduplicate by infohash, keeping the entry with the highest seeders
    const byHash = new Map();
    for (const r of records) {
      if (!r.hash) continue;
      const existing = byHash.get(r.hash);
      if (!existing || (r.seeders || 0) > (existing.seeders || 0)) {
        byHash.set(r.hash, r);
      }
    }

    let candidates = [...byHash.values()];

    // Early filter: prune excluded qualities and size limits BEFORE cache checking
    if (excludedQualities.length > 0 || maxSizeBytes > 0) {
      candidates = candidates.filter(r => {
        const q = extractQuality(r.title);
        if (excludedQualities.includes(q)) return false;
        if (maxSizeBytes > 0 && r.size > maxSizeBytes) return false;
        return true;
      });
    }

    candidates = sortByQualityThenSeeders(candidates);

    // Early deduplication before cache checking: only check top stream per provider per resolution
    if (dedupe) {
      const seen = new Set();
      candidates = candidates.filter(r => {
        const provider = (r.source || 'unknown').toLowerCase();
        const quality = extractQuality(r.title);
        const key = `${provider}:${quality}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    candidates = candidates.slice(0, 100);

    const hashes = candidates.map(r => r.hash);
    const cachedMap = await this.getCachedStreams(hashes);

    if (cachedMap.size === 0) {
      return [];
    }

    const results = [];
    for (const record of candidates) {
      if (!cachedMap.has(record.hash)) continue;
      const cachedInfo = cachedMap.get(record.hash);
      results.push({
        type: 'torrent',
        title: record.title,
        hash: record.hash,
        size: record.size || cachedInfo?.size || 0,
        seeders: record.seeders || 0,
        source: record.source || '',
        quality: extractQuality(record.title),
        files: cachedInfo?.files || [],
      });
    }

    return results;
  }

  async validateKey() {
    try {
      const data = await tbRequest(this.apiKey, 'GET', '/api/user/me');
      return { valid: true, user: data };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }
}

module.exports = TorBoxAPI;
