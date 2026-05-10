/**
 * lib/github-fetcher.js  (v4)
 * Fetches M3U playlists from quality-curated repos,
 * applies smart filtering (no Chinese, quality score gate),
 * deduplicates, checks streams, writes merged playlist.
 */

const fs   = require('fs');
const path = require('path');
const { fetchText, parseM3U, shouldKeep, qualityScore, normaliseExtinf } = require('./updater');
const { GITHUB_M3U_SOURCES } = require('./github-sources');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const MERGED_FILE = path.join(DATA_DIR, 'github-merged.m3u');
const DEAD_FILE   = path.join(DATA_DIR, 'github-dead.m3u');
const REPORT_FILE = path.join(DATA_DIR, 'github-report.json');

const MAX_PARALLEL  = 40;
const FETCH_TIMEOUT = 20000;
const EPG_URL       = 'https://www.epgdata.com/epg.php?type=m3u';

const https = require('https');
const http  = require('http');
const { URL } = require('url');

// ─── Stream check (HEAD with GET fallback) ────────────────────────────────────

function checkStream(url) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { return resolve({ ok: false, error: 'Invalid URL' }); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const baseOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 6000,
    };
    const req = lib.request({ ...baseOpts, method: 'HEAD' }, (res) => {
      if (res.statusCode < 400) return resolve({ ok: true, error: null });
      if (res.statusCode === 405) {
        // HEAD not allowed — try GET
        const g = lib.request({ ...baseOpts, method: 'GET' }, (r) => {
          r.destroy();
          resolve({ ok: r.statusCode < 400, error: r.statusCode >= 400 ? `HTTP ${r.statusCode}` : null });
        });
        g.on('timeout', () => { g.destroy(); resolve({ ok: false, error: 'Timeout' }); });
        g.on('error',   (e) => resolve({ ok: false, error: e.message.slice(0,60) }));
        g.end(); return;
      }
      resolve({ ok: false, error: `HTTP ${res.statusCode}` });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
    req.on('error',   (e) => resolve({ ok: false, error: e.message.slice(0,60) }));
    req.end();
  });
}

// ─── Fetch one source ─────────────────────────────────────────────────────────

async function fetchSource(source) {
  try {
    const content = await fetchText(source.raw, FETCH_TIMEOUT);
    if (!content || content.trim().length < 20) return { source, entries: [], error: 'Empty' };
    const all     = parseM3U(content);
    const entries = all.filter(shouldKeep).map(normaliseExtinf);
    return { source, entries, error: null, raw: all.length };
  } catch (err) {
    return { source, entries: [], error: err.message, raw: 0 };
  }
}

async function fetchAllSources() {
  console.log(`[github-fetcher] Fetching ${GITHUB_M3U_SOURCES.length} M3U sources…`);
  const results = await Promise.all(GITHUB_M3U_SOURCES.map(fetchSource));
  for (const r of results) {
    const status = r.error
      ? `❌ ${r.error}`
      : `✅ ${r.entries.length}/${r.raw} kept`;
    console.log(`  [${r.source.label}] ${status}`);
  }
  return results;
}

// ─── Deduplication (prefer highest quality score on collision) ────────────────

function mergeAndDeduplicate(results) {
  const byUrl = new Map();
  for (const { source, entries } of results) {
    for (const entry of entries) {
      const key = entry.url.trim().toLowerCase();
      if (!key || key.startsWith('#')) continue;
      if (byUrl.has(key)) {
        const existing = byUrl.get(key);
        existing.repos.push(source.label);
        // Keep whichever has a higher quality score
        if (qualityScore(entry) > qualityScore(existing.entry)) {
          existing.entry = entry;
        }
      } else {
        byUrl.set(key, { entry, repos: [source.label] });
      }
    }
  }
  const merged = [...byUrl.values()].map(({ entry, repos }) => ({ ...entry, sources: repos }));
  console.log(`[github-fetcher] Deduplicated → ${merged.length} unique quality URLs`);
  return merged;
}

// ─── Parallel stream check ────────────────────────────────────────────────────

async function checkStreamsParallel(entries) {
  const active = [], dead = [];
  const total  = entries.length;
  let   done   = 0;

  for (let i = 0; i < total; i += MAX_PARALLEL) {
    const batch   = entries.slice(i, i + MAX_PARALLEL);
    const results = await Promise.all(batch.map(e => checkStream(e.url).then(r => ({ e, r }))));
    for (const { e, r } of results) {
      if (r.ok) active.push(e);
      else       dead.push({ ...e, _checkError: r.error });
    }
    done += batch.length;
    const pct = ((done / total) * 100).toFixed(0);
    process.stdout.write(
      `\r[github-fetcher] ${done}/${total} (${pct}%) | ✅ ${active.length}  ❌ ${dead.length}   `
    );
  }
  process.stdout.write('\n');
  return { active, dead };
}

// ─── M3U writer ───────────────────────────────────────────────────────────────

function writeM3U(filePath, entries) {
  const lines = [`#EXTM3U url-tvg="${EPG_URL}"`];
  // Sort: by quality score desc within group, then name
  const sorted = [...entries].sort((a, b) => {
    const ga = a.group || 'ZZ', gb = b.group || 'ZZ';
    if (ga !== gb) return ga.localeCompare(gb);
    return qualityScore(b) - qualityScore(a);
  });
  for (const e of sorted) lines.push(e.extinf, e.url);
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
  console.log(`[github-fetcher] Wrote ${sorted.length} entries → ${path.basename(filePath)}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function fetchAndCheckGitHub() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const startTime = Date.now();
  console.log('\n[github-fetcher] ═══ GitHub Smart Fetch Started ═══');

  const results      = await fetchAllSources();
  const fetchedCount = results.reduce((n, r) => n + r.entries.length, 0);
  const sourcesOk    = results.filter(r => !r.error).length;
  console.log(`[github-fetcher] ${fetchedCount} quality channels from ${sourcesOk}/${GITHUB_M3U_SOURCES.length} sources`);

  const merged = mergeAndDeduplicate(results);
  console.log(`[github-fetcher] Checking ${merged.length} unique streams…`);
  const { active, dead } = await checkStreamsParallel(merged);

  writeM3U(MERGED_FILE, active);
  writeM3U(DEAD_FILE,   dead);

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const errorBreakdown = {};
  for (const d of dead) { const k = d._checkError || 'Unknown'; errorBreakdown[k] = (errorBreakdown[k] || 0) + 1; }

  const summary = results.map(r => ({
    label: r.source.label, repo: r.source.repo,
    fetched: r.raw || 0, kept: r.entries.length, error: r.error,
  }));

  const report = {
    updatedAt: new Date().toISOString(),
    elapsedSeconds: parseFloat(elapsedSec),
    sources: { total: GITHUB_M3U_SOURCES.length, ok: sourcesOk, detail: summary },
    channels: {
      fetched: fetchedCount, unique: merged.length,
      active: active.length, dead: dead.length,
      activeRatio: merged.length ? ((active.length / merged.length) * 100).toFixed(1) + '%' : '0%',
    },
    errorBreakdown,
  };
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`[github-fetcher] ═══ Done in ${elapsedSec}s | Active: ${active.length} | Dead: ${dead.length} ═══\n`);
  return report;
}

module.exports = { fetchAndCheckGitHub };
