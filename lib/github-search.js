/**
 * lib/github-search.js  — WatchHub Edition
 *
 * Searches GitHub's code-search API for M3U files, with focus on:
 *   • BeIn Sports / Sky Sports / Spacetoon / MBC / Rotana / Al Jazeera
 *   • Prioritizes recently-updated repositories
 *   • Uses targeted keyword queries for higher hit rate
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { URL } = require('url');
const { parseM3U } = require('./updater');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'search-results.m3u');
const DEAD_FILE   = path.join(DATA_DIR, 'search-dead.m3u');
const REPORT_FILE = path.join(DATA_DIR, 'search-report.json');

const GH_TOKEN     = process.env.GITHUB_TOKEN || '';
const USER_AGENT   = 'watchhub-iptv/4.0';
const FETCH_TO     = 18000;
const CHECK_TO     = 5000;
const CHECK_PARA   = 25;
const SEARCH_DELAY = 2200;
const FETCH_PARA   = 6;
const MAX_FILES    = 500;   // cap files fetched to avoid OOM (was unbounded → 4000+ files)
const MAX_ENTRIES  = 15000; // cap total unique stream entries kept in memory

// ── Targeted search queries — ordered by priority ────────────────────────────
// These use GitHub's code search to find M3U files that mention specific
// channels. We interleave generic extension queries with keyword queries.
const SEARCH_QUERIES = [
  // Generic M3U extension searches (broad)
  'extension:m3u EXTM3U',
  'extension:m3u8 EXTM3U',

  // BeIn Sports specific — highest priority
  'extension:m3u beinsports',
  'extension:m3u8 beinsports',
  'filename:m3u bein sport',
  'filename:m3u bein+sports',

  // Sports channels
  'extension:m3u "sky sports" EXTINF',
  'extension:m3u "sky sport" EXTINF',
  'extension:m3u eurosport EXTINF',
  'extension:m3u "fox sports" EXTINF',

  // Arabic Kids
  'extension:m3u spacetoon EXTINF',
  'extension:m3u "space toon" EXTINF',

  // Arabic entertainment
  'extension:m3u mbc EXTINF',
  'extension:m3u rotana EXTINF',
  'extension:m3u "al jazeera" EXTINF',

  // Sports playlists by filename
  'filename:sports.m3u EXTM3U',
  'filename:sport.m3u EXTM3U',
  'filename:arabic.m3u EXTM3U',
  'filename:iptv.m3u beinsports',
  'filename:playlist.m3u beinsports',
  'filename:channels.m3u beinsports',

  // Recently updated repos — generic
  'filename:.m3u EXTM3U',
  'filename:.m3u8 EXTM3U',
];

// ── Priority channel keywords (channels that get LIVE-checked first) ─────────
const PRIORITY_CHANNEL_KEYWORDS = [
  'bein', 'beinsport', 'sky sport', 'sky sport',
  'spacetoon', 'mbc', 'rotana', 'al jazeera', 'aljazeera',
  'nile sport', 'abu dhabi sport', 'dubai sport', 'saudi sport',
  'fox sport', 'espn', 'eurosport',
];

function isPriority(name) {
  const n = (name || '').toLowerCase();
  return PRIORITY_CHANNEL_KEYWORDS.some(k => n.includes(k));
}

// ── Abort controller ─────────────────────────────────────────────────────────
let _abortFlag = false;
function abort()      { _abortFlag = true; }
function resetAbort() { _abortFlag = false; }
function isAborted()  { return _abortFlag; }

// ── Low-level HTTP ────────────────────────────────────────────────────────────
function httpGet(urlStr, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(urlStr); } catch { return resolve({ status: 0, body: null, headers: {} }); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  { 'User-Agent': USER_AGENT, ...headers },
      timeout:  timeoutMs,
    };
    const req = lib.request(opts, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        return resolve(httpGet(res.headers.location, headers, timeoutMs));
      }
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => { body += c; if (body.length > 8_000_000) req.destroy(); });
      res.on('end',  () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null, headers: {} }); });
    req.on('error',   () =>                  resolve({ status: 0, body: null, headers: {} }));
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── GitHub API ────────────────────────────────────────────────────────────────
function ghHeaders() {
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GH_TOKEN) h['Authorization'] = `Bearer ${GH_TOKEN}`;
  return h;
}

/**
 * Search one page, sorting by recently indexed (best proxy for fresh repos).
 */
async function searchPage(query, page) {
  // sort=indexed gives us the most recently indexed files first
  const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&sort=indexed&order=desc&per_page=100&page=${page}`;
  const res  = await httpGet(url, ghHeaders(), 20000);
  if (!res.body || res.status !== 200) return null;
  try {
    const json = JSON.parse(res.body);
    return { totalCount: json.total_count || 0, items: json.items || [] };
  } catch { return null; }
}

function rawUrl(item) {
  try {
    const m = item.html_url.match(/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)/);
    if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
  } catch {}
  return null;
}

// ── Stream check ──────────────────────────────────────────────────────────────
function checkStream(url) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { return resolve({ ok: false, error: 'Invalid URL' }); }
    const lib  = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'HEAD',
      headers:  { 'User-Agent': USER_AGENT },
      timeout:  CHECK_TO,
    };
    const req = lib.request(opts, (res) => {
      if (res.statusCode < 400) return resolve({ ok: true, error: null });
      resolve({ ok: false, error: `HTTP ${res.statusCode}` });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
    req.on('error',   (e) =>               resolve({ ok: false, error: e.message.slice(0,50) }));
    req.end();
  });
}

// ── M3U writer ────────────────────────────────────────────────────────────────
function writeM3U(filePath, entries) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const lines = ['#EXTM3U'];
  for (const e of entries) lines.push(e.extinf || `#EXTINF:-1,${e.name}`, e.url);
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function runSearch(emit) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  resetAbort();

  const startTime    = Date.now();
  const seenUrls     = new Set();
  const seenStreams   = new Set();
  const allItems     = [];
  const active       = [];
  const dead         = [];

  const stats = {
    startedAt:      new Date().toISOString(),
    pagesSearched:  0,
    filesFound:     0,
    filesFetched:   0,
    filesFailed:    0,
    channelsTotal:  0,
    channelsUnique: 0,
    priorityHits:   0,
    active:         0,
    dead:           0,
    stopped:        false,
  };

  // ── Phase 1: search ────────────────────────────────────────────────────────
  emit('phase', { phase: 'search', message: 'Searching GitHub for M3U files (BeIn Sports & sports focus)…' });

  for (const query of SEARCH_QUERIES) {
    if (isAborted()) break;
    emit('phase', { phase: 'search', message: `Query: "${query}"` });

    // Only fetch first 3 pages per query to keep things fast and fresh
    const maxPages = query.includes('beinsport') || query.includes('bein sport') ? 10 : 3;

    for (let page = 1; page <= maxPages; page++) {
      if (isAborted()) break;
      let result = await searchPage(query, page);
      if (!result) {
        emit('error', { message: `Search page ${page} failed — waiting 15s…` });
        await sleep(15000);
        result = await searchPage(query, page);
        if (!result) break;
      }

      stats.pagesSearched++;
      for (const item of (result.items || [])) {
        const raw = rawUrl(item);
        if (!raw || seenUrls.has(raw)) continue;
        seenUrls.add(raw);
        allItems.push({
          repo:    item.repository?.full_name || 'unknown/unknown',
          path:    item.path || '',
          rawUrl:  raw,
          // Track repo update time for sorting
          updated: item.repository?.updated_at || '',
        });
        stats.filesFound++;
      }

      emit('page', {
        query, page,
        totalCount:    result.totalCount,
        itemsThisPage: (result.items||[]).length,
        filesQueued:   stats.filesFound,
      });

      if ((result.items||[]).length < 100) break;
      await sleep(SEARCH_DELAY);
    }

    await sleep(SEARCH_DELAY);
  }

  if (isAborted()) {
    stats.stopped = true;
    stats.elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    fs.writeFileSync(REPORT_FILE, JSON.stringify({ ...stats, stoppedAt: new Date().toISOString() }, null, 2));
    emit('phase', { phase: 'stopped', message: 'Stopped.' });
    emit('done', { stats }); return;
  }

  // Sort all items: recently updated repos first, then cap to avoid OOM
  allItems.sort((a, b) => (b.updated > a.updated ? 1 : -1));
  if (allItems.length > MAX_FILES) {
    console.log(`[github-search] Capping ${allItems.length} → ${MAX_FILES} files to prevent OOM`);
    allItems.splice(MAX_FILES);
  }

  // ── Phase 2: fetch raw files ───────────────────────────────────────────────
  emit('phase', { phase: 'fetch', message: `Fetching ${allItems.length} raw M3U files (newest repos first)…` });

  const allEntries = [];

  for (let i = 0; i < allItems.length; i += FETCH_PARA) {
    if (isAborted()) break;
    await Promise.all(allItems.slice(i, i + FETCH_PARA).map(async (item) => {
      if (isAborted()) return;
      emit('file_start', { repo: item.repo, path: item.path, rawUrl: item.rawUrl });
      const res = await httpGet(item.rawUrl, {}, FETCH_TO);
      stats.filesFetched++;
      if (!res.body || res.status !== 200 || res.body.trim().length < 10) {
        stats.filesFailed++;
        emit('file_done', { repo: item.repo, path: item.path, rawUrl: item.rawUrl, channels: 0, ok: false, error: `HTTP ${res.status}` });
        return;
      }
      if (!res.body.includes('#EXTM3U') && !res.body.includes('#EXTINF')) {
        stats.filesFailed++;
        emit('file_done', { repo: item.repo, path: item.path, rawUrl: item.rawUrl, channels: 0, ok: false, error: 'Not an M3U' });
        return;
      }
      const entries = parseM3U(res.body);
      stats.channelsTotal += entries.length;
      const newEntries = [];
      for (const e of entries) {
        const key = e.url.trim().toLowerCase();
        if (!key || seenStreams.has(key)) continue;
        seenStreams.add(key);
        newEntries.push({ ...e, _repo: item.repo, _path: item.path, _priority: isPriority(e.name) });
      }
      stats.channelsUnique += newEntries.length;
      if (allEntries.length < MAX_ENTRIES) {
        allEntries.push(...newEntries.slice(0, MAX_ENTRIES - allEntries.length));
      }
      emit('file_done', { repo: item.repo, path: item.path, rawUrl: item.rawUrl, channels: entries.length, unique: newEntries.length, ok: true });
    }));
  }

  if (isAborted()) {
    stats.stopped = true;
    stats.elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    fs.writeFileSync(REPORT_FILE, JSON.stringify({ ...stats, stoppedAt: new Date().toISOString() }, null, 2));
    emit('phase', { phase: 'stopped', message: 'Stopped.' });
    emit('done', { stats }); return;
  }

  // ── Phase 3: check streams — priority channels first ──────────────────────
  // Sort: priority channels (BeIn, Sky, etc.) checked first
  allEntries.sort((a, b) => (b._priority ? 1 : 0) - (a._priority ? 1 : 0));

  const total = allEntries.length;
  emit('phase', { phase: 'check', message: `Checking ${total} unique streams (priority channels first)…` });

  for (let i = 0; i < total; i += CHECK_PARA) {
    if (isAborted()) break;
    const batch   = allEntries.slice(i, i + CHECK_PARA);
    const results = await Promise.all(batch.map((e) => checkStream(e.url).then((r) => ({ e, r }))));
    for (const { e, r } of results) {
      if (r.ok) {
        active.push(e);
        stats.active++;
        if (e._priority) stats.priorityHits++;
        emit('hit', { repo: e._repo, path: e._path, name: e.name, url: e.url, group: e.group, priority: e._priority });
      } else {
        dead.push({ ...e, _checkError: r.error });
        stats.dead++;
      }
    }
    emit('check_prog', { checked: Math.min(i + CHECK_PARA, total), total, active: stats.active, dead: stats.dead });
  }

  // Sort final output: priority channels first
  active.sort((a, b) => (b._priority ? 1 : 0) - (a._priority ? 1 : 0));

  writeM3U(OUTPUT_FILE, active);
  writeM3U(DEAD_FILE,   dead);

  stats.elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
  stats.stopped = isAborted();
  fs.writeFileSync(REPORT_FILE, JSON.stringify(stats, null, 2), 'utf-8');

  emit('phase', { phase: 'done', message: `Done! ${stats.active} working streams (${stats.priorityHits} priority channels).` });
  emit('done', { stats });
}

module.exports = { runSearch, abort, isAborted };
