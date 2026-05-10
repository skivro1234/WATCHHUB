/**
 * lib/updater.js  (v4 – Smart 24/7 Fetcher)
 * 
 * - Targets Arabic, Sports, News, and quality international channels
 * - Blocks Chinese channels and other low-quality noise
 * - Quality scoring: prefers HD, known good groups, penalises SD/test channels
 * - Continuous 24/7 loop with configurable interval
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');
const { URL } = require('url');

const DATA_DIR = path.join(__dirname, '..', 'data');

// ─── Config ──────────────────────────────────────────────────────────────────

const SOURCE_URL  = 'https://iptv-org.github.io/iptv/languages/ara.m3u';
const INDEX_FILE  = path.join(DATA_DIR, 'index.m3u');
const DEAD_FILE   = path.join(DATA_DIR, 'index_dead.m3u');
const REPORT_FILE = path.join(DATA_DIR, 'report.json');
const EPG_URL     = 'https://www.epgdata.com/epg.php?type=m3u';

const TIMEOUT_MS   = 6000;
const MAX_PARALLEL = 30;
const USER_AGENT   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// ─── Quality & Filter Rules ──────────────────────────────────────────────────

/**
 * Groups we WANT to keep (case-insensitive substring match).
 * Empty = allow all groups (filter by block list instead).
 */
const GOOD_GROUPS = [
  'arabic', 'arab', 'عربي', 'عربية', 'sports', 'sport', 'رياضة', 'riyada',
  'news', 'أخبار', 'akhbar', 'entertainment', 'kids', 'أطفال',
  'bein', 'beIN', 'مباشر', 'مباشرة', 'rotana', 'mbc', 'osn',
  'al jazeera', 'aljazeera', 'al arabiya', 'alarabiya', 'france arabic',
  'sahel', 'nile', 'النيل', 'المغرب', 'السعودية', 'الإمارات', 'قطر',
  'general', 'international',
];

/**
 * Groups to BLOCK entirely (Chinese TV, test streams, adult).
 */
const BLOCKED_GROUPS = [
  '央视', '卫视', '地方', 'cctv', 'cgtn', 'chinese', 'china',
  '中文', '粤语', '华语', '综合', '教育', '军事',
  'xxx', 'adult', '+18', 'erotic', 'test', 'demo', 'sample',
];

/**
 * Block channel names containing these substrings.
 */
const BLOCKED_NAME_PATTERNS = [
  /[\u4e00-\u9fff]/,   // any CJK character
  /cctv\s*\d*/i,
  /cgtn/i,
  /\btest\b/i,
  /\bsample\b/i,
  /\bdemo\b/i,
  /xxx/i,
  /adult/i,
];

/**
 * Return a quality score 0-100 for a channel entry.
 * Higher = better. Channels below MIN_QUALITY_SCORE are skipped.
 */
const MIN_QUALITY_SCORE = 10;

function qualityScore(entry) {
  let score = 50;
  const name  = (entry.name  || '').toLowerCase();
  const group = (entry.group || '').toLowerCase();
  const url   = (entry.url   || '').toLowerCase();

  // Boost Arabic/sports heavy-hitters
  if (/bein\s*sport/i.test(name + group))  score += 35;
  if (/al\s*jazeera/i.test(name + group))  score += 30;
  if (/al\s*arabiya/i.test(name + group))  score += 28;
  if (/mbc/i.test(name))                    score += 20;
  if (/rotana/i.test(name))                 score += 20;
  if (/osn/i.test(name))                    score += 18;
  if (/sky\s*sport/i.test(name + group))    score += 15;
  if (/cnn/i.test(name))                    score += 12;
  if (/france\s*2[4-9]/i.test(name))        score += 10;
  if (/bbc/i.test(name))                    score += 10;

  // Boost by group membership
  if (GOOD_GROUPS.some(g => group.includes(g.toLowerCase()))) score += 15;

  // Quality hints in URL
  if (/\bhd\b/.test(url))     score += 12;
  if (/1080/.test(url))       score += 14;
  if (/720/.test(url))        score += 8;
  if (/\.m3u8/.test(url))     score += 5;  // HLS preferred
  if (/rtmp:/.test(url))      score -= 5;  // RTMP less reliable

  // Penalise SD / low-res hints
  if (/\bsd\b/.test(url + name))  score -= 8;
  if (/240p|360p/.test(url))      score -= 10;

  return Math.max(0, Math.min(100, score));
}

/**
 * Return true if the channel should be KEPT.
 */
function shouldKeep(entry) {
  const name  = entry.name  || '';
  const group = entry.group || '';
  const groupLc = group.toLowerCase();
  const nameLc  = name.toLowerCase();

  // Block by group
  if (BLOCKED_GROUPS.some(b => groupLc.includes(b))) return false;

  // Block by name pattern
  if (BLOCKED_NAME_PATTERNS.some(p => p.test(name))) return false;

  // Quality gate
  if (qualityScore(entry) < MIN_QUALITY_SCORE) return false;

  return true;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function fetchText(url, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { return resolve(null); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT },
      timeout: timeoutMs,
    };
    const req = lib.request(options, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        return resolve(fetchText(res.headers.location, timeoutMs));
      }
      if (res.statusCode >= 400) return resolve(null);
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => { data += c; if (data.length > 10_000_000) req.destroy(); });
      res.on('end',  () => resolve(data));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error',   () =>                  resolve(null));
    req.end();
  });
}

function checkStream(url) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { return resolve({ ok: false, error: 'Invalid URL' }); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'HEAD',
      headers: { 'User-Agent': USER_AGENT },
      timeout: TIMEOUT_MS,
    };
    const req = lib.request(options, (res) => {
      if (res.statusCode < 400) return resolve({ ok: true, error: null });
      // Fallback: try GET for servers that reject HEAD
      if (res.statusCode === 405) {
        const getReq = lib.request({ ...options, method: 'GET' }, (r) => {
          r.destroy();
          resolve({ ok: r.statusCode < 400, error: r.statusCode >= 400 ? `HTTP ${r.statusCode}` : null });
        });
        getReq.on('timeout', () => { getReq.destroy(); resolve({ ok: false, error: 'Timeout' }); });
        getReq.on('error',   (e) => resolve({ ok: false, error: e.message.slice(0, 60) }));
        getReq.end();
        return;
      }
      resolve({ ok: false, error: `HTTP ${res.statusCode}` });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
    req.on('error',   (e) => resolve({ ok: false, error: e.message.slice(0, 60) }));
    req.end();
  });
}

// ─── M3U helpers ─────────────────────────────────────────────────────────────

function parseM3U(content) {
  const entries = [];
  const lines = content.split('\n').map(l => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('#EXTINF:')) continue;
    const extinf      = line;
    const groupMatch  = extinf.match(/group-title="([^"]*)"/);
    const nameMatch   = extinf.match(/tvg-name="([^"]+)"/) || extinf.match(/,(.+)$/);
    const logoMatch   = extinf.match(/tvg-logo="([^"]*)"/);
    const group = groupMatch ? groupMatch[1].trim() : '';
    const name  = nameMatch  ? nameMatch[1].trim()  : 'Unknown Channel';
    const logo  = logoMatch  ? logoMatch[1].trim()  : '';
    const urlLine = lines[i + 1] || '';
    if (urlLine && !urlLine.startsWith('#')) {
      entries.push({ extinf, name, url: urlLine, group, logo });
    }
  }
  return entries;
}

function naturalKey(text) {
  return text.split(/(\d+)/).map(p => /^\d+$/.test(p) ? parseInt(p, 10) : p.toLowerCase());
}
function naturalCompare(a, b) {
  const ka = naturalKey(a.name);
  const kb = naturalKey(b.name);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const va = ka[i] ?? ''; const vb = kb[i] ?? '';
    if (va < vb) return -1; if (va > vb) return 1;
  }
  return 0;
}

/**
 * Assign a canonical category to a channel for the TV player.
 */
function categorise(entry) {
  const t = (entry.name + ' ' + entry.group).toLowerCase();
  if (/bein|sport|foot|كرة|رياض|match|liga|premier|champions|ligue|nba|nfl|wrestling/.test(t)) return 'Sports';
  if (/news|أخبار|breaking|cnn|bbc|al\s*jazeera|alarabiya|france\s*24|euronews/.test(t)) return 'News';
  if (/mbc|osn|rotana|series|drama|movie|cinema|أفلام|مسلسل/.test(t)) return 'Entertainment';
  if (/kid|child|cartoon|أطفال|toyor|spacetoon/.test(t)) return 'Kids';
  if (/music|موسيق|nile|مزيكا|clip/.test(t)) return 'Music';
  if (/quran|قرآن|islam|دين|religious/.test(t)) return 'Religious';
  if (/document|وثائق|discovery|national\s*geo/.test(t)) return 'Documentary';
  return 'General';
}

/**
 * Rebuild extinf line to include category as group-title (normalised).
 */
function normaliseExtinf(entry) {
  const cat = categorise(entry);
  // Replace group-title with canonical category
  let extinf = entry.extinf;
  if (/group-title="[^"]*"/.test(extinf)) {
    extinf = extinf.replace(/group-title="[^"]*"/, `group-title="${cat}"`);
  } else {
    // Insert before the comma separator
    extinf = extinf.replace(/^(#EXTINF:[^,]*)/, `$1 group-title="${cat}"`);
  }
  return { ...entry, extinf, group: cat };
}

function writeM3U(filePath, entries) {
  const sorted = [...entries].sort(naturalCompare);
  const lines  = [`#EXTM3U url-tvg="${EPG_URL}"`];
  for (const e of sorted) lines.push(e.extinf, e.url);
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
  console.log(`[updater] Wrote ${sorted.length} channels → ${path.basename(filePath)}`);
}

function loadLocalEntries(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try { return parseM3U(fs.readFileSync(filePath, 'utf-8')); } catch { return []; }
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
      else       dead.push({ ...e, error: r.error });
    }
    done += batch.length;
    const pct = ((done / total) * 100).toFixed(0);
    process.stdout.write(`\r[updater] ${done}/${total} (${pct}%) | ✅ ${active.length}  ❌ ${dead.length}   `);
  }
  process.stdout.write('\n');
  return { active, dead };
}

// ─── Main update function ─────────────────────────────────────────────────────

async function updateIPTV() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const startTime = Date.now();
  console.log('\n[updater] ═══ IPTV Smart Update Started ═══');

  const localActive = loadLocalEntries(INDEX_FILE);
  const localDead   = loadLocalEntries(DEAD_FILE);
  const localUrls   = new Set([...localActive, ...localDead].map(e => e.url.trim().toLowerCase()));
  console.log(`[updater] Local: ${localActive.length} active, ${localDead.length} dead`);

  // Fetch remote + filter
  console.log(`[updater] Fetching remote M3U: ${SOURCE_URL}`);
  const remoteContent = await fetchText(SOURCE_URL);
  let remoteNew = [];

  if (remoteContent) {
    const all  = parseM3U(remoteContent);
    const kept = all.filter(shouldKeep).map(normaliseExtinf);
    const newOnes = kept.filter(e => !localUrls.has(e.url.trim().toLowerCase()));
    console.log(`[updater] Remote: ${all.length} total → ${kept.length} quality-filtered → ${newOnes.length} new`);
    remoteNew = newOnes;
  } else {
    console.warn('[updater] Could not fetch remote M3U. Checking local only.');
  }

  // Re-check everything
  const toCheck = [...localActive, ...localDead, ...remoteNew];
  console.log(`[updater] Checking ${toCheck.length} streams…`);
  const { active, dead } = await checkStreamsParallel(toCheck);

  // Sort active by quality score descending within groups
  active.sort((a, b) => qualityScore(b) - qualityScore(a));

  writeM3U(INDEX_FILE, active);
  writeM3U(DEAD_FILE,  dead);

  const errorCounts = {};
  for (const d of dead) { const k = d.error || 'Unknown'; errorCounts[k] = (errorCounts[k] || 0) + 1; }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const report = {
    updatedAt: new Date().toISOString(),
    elapsedSeconds: parseFloat(elapsedSec),
    source: { url: SOURCE_URL },
    before: { active: localActive.length, dead: localDead.length },
    after:  { active: active.length, dead: dead.length },
    netChange: active.length - localActive.length,
    errorBreakdown: errorCounts,
  };
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`[updater] ═══ Done in ${elapsedSec}s | Active: ${active.length} | Dead: ${dead.length} ═══\n`);
  return report;
}

module.exports = { updateIPTV, parseM3U, fetchText, shouldKeep, qualityScore, normaliseExtinf };
