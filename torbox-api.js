/**
 * TorBox API Client — based on Torrentio's implementation
 */

const axios = require('axios');
const FormData = require('form-data');
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
    timeout: 15000,
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

  // ─── Cache check — POST with hashes (Torrentio style) ────────
  // Returns map of hash → { files, ... } so we get file info directly

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

  // ─── Resolve a cached torrent to a download URL (Torrentio style) ─

  async resolve(infoHash) {
    try {
      // Create or locate the torrent (requires form-encoded body, not JSON)
      const data = await tbRequest(this.apiKey, 'POST', '/api/torrents/createtorrent', {
        body: new URLSearchParams({ magnet: `magnet:?xt=urn:btih:${infoHash}` }),
      });

      if (!data?.torrent_id && !data?.queued_id) return null;
      const torrentId = data.torrent_id || data.queued_id;

      // Get torrent info (files list)
      const torrents = await tbRequest(this.apiKey, 'GET', '/api/torrents/mylist', {
        params: { id: torrentId },
      });

      const torrent = Array.isArray(torrents) ? torrents[0] : torrents;
      if (!torrent) return null;

      // Check if ready
      if (!torrent.download_present) {
        // Not ready yet — retry up to 3 times for cached torrents
        for (let i = 0; i < 3; i++) {
          await sleep(1000);
          const retry = await tbRequest(this.apiKey, 'GET', '/api/torrents/mylist', {
            params: { id: torrentId },
          });
          const rt = Array.isArray(retry) ? retry[0] : retry;
          if (rt?.download_present) return this._buildUrl(rt, torrentId);
          if (['error', 'dead'].includes(rt?.download_state)) return null;
        }
        return null;
      }

      return this._buildUrl(torrent, torrentId);
    } catch (err) {
      const detail = err?.detail || err?.error || err?.message || '';
      console.error(`[torbox] resolve error: ${typeof detail === 'string' ? detail.substring(0, 200) : JSON.stringify(detail).substring(0, 200)}`);
      return null;
    }
  }

  _buildUrl(torrent, torrentId) {
    const files = torrent.files ?? [];
    const VIDEO_EXTS = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts)$/i;

    const videos = files.filter(f => VIDEO_EXTS.test(f.short_name ?? f.name ?? ''));
    const target = videos.length
      ? videos.reduce((a, b) => (a.size ?? 0) >= (b.size ?? 0) ? a : b)
      : files[0];

    if (!target) return null;

    // Torrentio-style permalink — no requestdl API call needed
    const params = {
      token: this.apiKey,
      torrent_id: torrentId,
      file_id: target.id,
      redirect: true,
    };
    return `${TB_BASE}/api/torrents/requestdl?${querystring.stringify(params)}`;
  }

  // ─── Main search ──────────────────────────────────────────────

  async searchAll(imdbId, type, season, episode) {
    console.log(`[torbox] Searching for ${imdbId} (${type})...`);

    const records = await searchAllProviders(imdbId, type, season, episode);
    if (records.length === 0) return [];

    // Deduplicate by hash, keep highest seeders
    const byHash = new Map();
    for (const r of records) {
      if (!r.hash) continue;
      const existing = byHash.get(r.hash);
      if (!existing || (r.seeders || 0) > (existing.seeders || 0)) {
        byHash.set(r.hash, r);
      }
    }

    const sorted = sortByQualityThenSeeders([...byHash.values()]);

    // Cap at 100 candidates (TorBox checkcached handles up to 100 hashes)
    const candidates = sorted.slice(0, 100);
    console.log(`[torbox] Checking cache for ${candidates.length} candidates...`);

    const hashes = candidates.map(r => r.hash);
    const cachedMap = await this.getCachedStreams(hashes);

    if (cachedMap.size === 0) {
      console.log(`[torbox] No cached results found`);
      return [];
    }

    const results = [];
    for (const record of candidates) {
      if (!cachedMap.has(record.hash)) continue;
      results.push({
        type: 'torrent',
        title: record.title,
        hash: record.hash,
        size: record.size || 0,
        seeders: record.seeders || 0,
        source: record.source || '',
        quality: extractQuality(record.title),
      });
    }

    console.log(`[torbox] ${results.length} cached results (${cachedMap.size} hashes matched)`);
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
