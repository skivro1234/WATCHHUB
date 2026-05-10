/**
 * lib/scheduler.js — WatchHub 24/7 Auto-Refresh
 *
 * Continuous loop:
 *   - GitHub M3U fetch (quality sources):  every 4h (env: GITHUB_INTERVAL_HOURS)
 *   - Main IPTV update (Arabic/sports):    every 6h (env: UPDATE_INTERVAL_HOURS)
 *   - GitHub CODE search (deep crawl):     every 24h (env: SEARCH_INTERVAL_HOURS)
 *
 * All three run on startup immediately (staggered by 30s to avoid API bursts).
 */

const { updateIPTV }          = require('./updater');
const { generatePlaylist }    = require('./playlist');
const { fetchAndCheckGitHub } = require('./github-fetcher');
const { runSearch, isAborted }= require('./github-search');

const UPDATE_INTERVAL_MS = parseInt(process.env.UPDATE_INTERVAL_HOURS  || '6',  10) * 3_600_000;
const GITHUB_INTERVAL_MS = parseInt(process.env.GITHUB_INTERVAL_HOURS  || '4',  10) * 3_600_000;
const SEARCH_INTERVAL_MS = parseInt(process.env.SEARCH_INTERVAL_HOURS  || '24', 10) * 3_600_000;

let _updateRunning = false;
let _githubRunning = false;
let _searchRunning = false;

const _status = {
  lastUpdate:    null, lastGithub:    null, lastSearch:    null,
  nextUpdate:    null, nextGithub:    null, nextSearch:    null,
  updateRunning: false, githubRunning: false, searchRunning: false,
  cycleCount:    0,
};

function getStatus() { return { ..._status }; }

/* ── Runners ─────────────────────────────────────────────────────────────── */

async function runUpdate() {
  if (_updateRunning) return;
  _updateRunning = true; _status.updateRunning = true;
  console.log('[scheduler] ▶ IPTV update…');
  try {
    await updateIPTV();
    await generatePlaylist();
    _status.lastUpdate = new Date().toISOString();
    _status.cycleCount++;
    console.log('[scheduler] ✓ IPTV update done.');
  } catch (e) { console.error('[scheduler] ✗ IPTV update:', e.message); }
  _updateRunning = false; _status.updateRunning = false;
  _status.nextUpdate = new Date(Date.now() + UPDATE_INTERVAL_MS).toISOString();
}

async function runGitHubFetch() {
  if (_githubRunning) return;
  _githubRunning = true; _status.githubRunning = true;
  console.log('[scheduler] ▶ GitHub M3U fetch…');
  try {
    await fetchAndCheckGitHub();
    _status.lastGithub = new Date().toISOString();
    console.log('[scheduler] ✓ GitHub fetch done.');
  } catch (e) { console.error('[scheduler] ✗ GitHub fetch:', e.message); }
  _githubRunning = false; _status.githubRunning = false;
  _status.nextGithub = new Date(Date.now() + GITHUB_INTERVAL_MS).toISOString();
}

async function runDeepSearch() {
  if (_searchRunning) return;
  _searchRunning = true; _status.searchRunning = true;
  console.log('[scheduler] ▶ GitHub deep code-search (BeIn Sports focus)…');
  try {
    await runSearch((type, payload) => {
      if (type === 'phase') console.log('[search]', payload.message);
      if (type === 'check_prog') {
        const { checked, total, active } = payload;
        if (checked % 100 === 0) console.log(`[search] ${checked}/${total} checked — ${active} live`);
      }
    });
    _status.lastSearch = new Date().toISOString();
    console.log('[scheduler] ✓ Deep search done.');
  } catch (e) { console.error('[scheduler] ✗ Deep search:', e.message); }
  _searchRunning = false; _status.searchRunning = false;
  _status.nextSearch = new Date(Date.now() + SEARCH_INTERVAL_MS).toISOString();
}

/* ── Public ──────────────────────────────────────────────────────────────── */

function scheduleUpdates() {
  console.log(`[scheduler] ═══════════════════════════════════`);
  console.log(`[scheduler] 📺 WatchHub — 24/7 auto-refresh`);
  console.log(`[scheduler]   GitHub fetch every ${GITHUB_INTERVAL_MS/3_600_000}h`);
  console.log(`[scheduler]   IPTV update    every ${UPDATE_INTERVAL_MS/3_600_000}h`);
  console.log(`[scheduler]   Deep search    every ${SEARCH_INTERVAL_MS/3_600_000}h`);
  console.log(`[scheduler] ═══════════════════════════════════`);

  // Startup: stagger by 30s intervals to avoid API bursts
  runGitHubFetch();
  setTimeout(runUpdate,     30_000);
  setTimeout(runDeepSearch, 60_000);

  _status.nextGithub = new Date(Date.now() + GITHUB_INTERVAL_MS).toISOString();
  _status.nextUpdate = new Date(Date.now() + UPDATE_INTERVAL_MS + 30_000).toISOString();
  _status.nextSearch = new Date(Date.now() + SEARCH_INTERVAL_MS + 60_000).toISOString();

  setInterval(runGitHubFetch, GITHUB_INTERVAL_MS);
  setInterval(runUpdate,      UPDATE_INTERVAL_MS);
  setInterval(runDeepSearch,  SEARCH_INTERVAL_MS);
}

module.exports = { scheduleUpdates, runUpdate, runGitHubFetch, runDeepSearch, getStatus };
