/**
 * IPTV M3U Server v4 – Smart 24/7 Node.js
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { updateIPTV }          = require('./lib/updater');
const { generatePlaylist }    = require('./lib/playlist');
const { scheduleUpdates, getStatus } = require('./lib/scheduler');
const { fetchAndCheckGitHub } = require('./lib/github-fetcher');
const { runSearch, abort, isAborted } = require('./lib/github-search');

const app      = express();
const PORT     = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Helpers ──────────────────────────────────────────────────────────────────
function serveM3U(res, filePath, notFoundMsg) {
  if (!fs.existsSync(filePath)) return res.status(404).send(notFoundMsg + '\n');
  res.setHeader('Content-Type', 'application/x-mpegurl');
  res.sendFile(filePath);
}
function serveJSON(res, reportPath, emptyMsg) {
  if (!fs.existsSync(reportPath)) return res.json({ message: emptyMsg });
  try { res.json(JSON.parse(fs.readFileSync(reportPath, 'utf-8'))); }
  catch { res.json({ message: 'Report file is corrupt.' }); }
}

// ─── Proxy: fahadfayi default playlist (avoids CORS in browser) ──────────────
const FAHADFAYI_RAW = 'https://raw.githubusercontent.com/fahadfayi/iptv/main/tv_channels_MIsne7ehs6et_plus.m3u';
app.get('/fahadfayi.m3u', async (_, res) => {
  try {
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      https.get(FAHADFAYI_RAW, { headers: { 'User-Agent': 'WatchHub/4' } }, (r) => {
        let buf = '';
        r.on('data', d => buf += d);
        r.on('end', () => resolve(buf));
        r.on('error', reject);
      }).on('error', reject);
    });
    res.setHeader('Content-Type', 'application/x-mpegurl');
    res.send(data);
  } catch (e) {
    res.status(502).send('# Proxy error: ' + e.message + '\n');
  }
});

// ─── Stream Proxy (fixes Mixed Content + CORS for HTTP streams on HTTPS) ────
//
// Strategy for raw .ts IPTV streams (fastsky.ae style):
//   Instead of HLS wrapping (which stalls on live streams), we pipe the raw
//   TS bytes directly as a <video src> using MediaSource Extensions (MSE).
//   The frontend switches to MSE mode when the proxy URL is a .ts stream.
//
// Routes:
//   /stream-proxy?url=http://...67691.ts        → pipe raw MPEG-TS bytes
//   /stream-proxy?url=http://...playlist.m3u8   → rewrite & proxy HLS playlist
//   /stream-proxy?url=http://...seg.ts&seg=1    → pipe HLS segment bytes
//
function makeTransport(parsedUrl) {
  return parsedUrl.protocol === 'https:' ? require('https') : require('http');
}

function proxyPipe(targetUrl, res, extraHeaders = {}) {
  let parsed;
  try { parsed = new URL(targetUrl); } catch { return res.status(400).send('Invalid URL'); }

  const transport = makeTransport(parsed);
  const req = transport.request({
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path:     parsed.pathname + parsed.search,
    method:   'GET',
    headers:  { 'User-Agent': 'Mozilla/5.0 WatchHub/4', ...extraHeaders },
    timeout:  20000,
  }, (proxyRes) => {
    res.statusCode = proxyRes.statusCode;
    // Forward content-type from upstream if not already set
    if (!res.getHeader('Content-Type') && proxyRes.headers['content-type']) {
      res.setHeader('Content-Type', proxyRes.headers['content-type']);
    }
    proxyRes.pipe(res);
  });
  req.on('error',   (e) => { if (!res.headersSent) res.status(502).send('Upstream error: ' + e.message); });
  req.on('timeout', ()  => { req.destroy(); if (!res.headersSent) res.status(504).send('Upstream timeout'); });
  req.end();
}

app.get('/stream-proxy', (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing ?url= parameter');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store');

  const isHLSSegment = req.query.seg === '1';
  const isM3U8 = targetUrl.includes('.m3u8') ||
                 (req.query.type === 'm3u8');
  // Raw IPTV .ts stream (not an HLS segment — the stream itself IS the .ts)
  const isLiveTS = !isHLSSegment && !isM3U8 &&
                   (targetUrl.includes('.ts') || targetUrl.includes('/live/'));

  // ── Live raw MPEG-TS stream → pipe directly ───────────────────────────────
  // Browser <video> with src pointing here plays it natively (like VLC does)
  if (isLiveTS) {
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Transfer-Encoding', 'chunked');
    return proxyPipe(targetUrl, res);
  }

  // ── HLS .m3u8 manifest → rewrite segment URLs through proxy ──────────────
  if (isM3U8) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    let parsed;
    try { parsed = new URL(targetUrl); } catch { return res.status(400).send('Invalid URL'); }

    const transport = makeTransport(parsed);
    const reqM = transport.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  { 'User-Agent': 'Mozilla/5.0 WatchHub/4' },
      timeout:  15000,
    }, (proxyRes) => {
      res.statusCode = proxyRes.statusCode;
      let body = '';
      proxyRes.setEncoding('utf8');
      proxyRes.on('data', c => body += c);
      proxyRes.on('end', () => {
        const base = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
        const rewritten = body.replace(/^(?!#)(\S+)$/gm, (line) => {
          const abs = line.startsWith('http') ? line : base + line;
          // Mark as HLS segment so it gets piped, not wrapped again
          return '/stream-proxy?seg=1&url=' + encodeURIComponent(abs);
        });
        res.send(rewritten);
      });
    });
    reqM.on('error',   (e) => { if (!res.headersSent) res.status(502).send('Upstream error: ' + e.message); });
    reqM.on('timeout', ()  => { reqM.destroy(); if (!res.headersSent) res.status(504).send('Upstream timeout'); });
    reqM.end();
    return;
  }

  // ── HLS segment (.ts within a real HLS stream) → pipe bytes ──────────────
  if (isHLSSegment) {
    res.setHeader('Content-Type', 'video/mp2t');
    return proxyPipe(targetUrl, res);
  }

  // ── Fallback: generic pipe ────────────────────────────────────────────────
  proxyPipe(targetUrl, res);
});

// ─── Playlist routes ──────────────────────────────────────────────────────────
app.get('/health',          (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/index.m3u',       (_, res) => serveM3U(res, path.join(DATA_DIR,'index.m3u'),         '# Not generated yet.'));
app.get('/dead.m3u',        (_, res) => serveM3U(res, path.join(DATA_DIR,'index_dead.m3u'),    '# No dead channels yet.'));
app.get('/playlist.m3u',    (_, res) => serveM3U(res, path.join(DATA_DIR,'playlist.m3u'),      '# Not generated yet.'));
app.get('/github.m3u',      (_, res) => serveM3U(res, path.join(DATA_DIR,'github-merged.m3u'), '# POST /api/github-fetch first.'));
app.get('/github-dead.m3u', (_, res) => serveM3U(res, path.join(DATA_DIR,'github-dead.m3u'),  '# No dead GitHub channels yet.'));
app.get('/search.m3u',      (_, res) => serveM3U(res, path.join(DATA_DIR,'search-results.m3u'),'# POST /api/search/start first.'));
app.get('/search-dead.m3u', (_, res) => serveM3U(res, path.join(DATA_DIR,'search-dead.m3u'),  '# No dead search channels yet.'));

// ─── Stats & config routes ────────────────────────────────────────────────────
app.get('/api/stats',            (_, res) => serveJSON(res, path.join(DATA_DIR,'report.json'),        'No report yet.'));
app.get('/api/github-stats',     (_, res) => serveJSON(res, path.join(DATA_DIR,'github-report.json'),'No GitHub report yet.'));
app.get('/api/search-stats',     (_, res) => serveJSON(res, path.join(DATA_DIR,'search-report.json'),'No search report yet.'));
app.get('/api/github-sources',   (_, res) => {
  const { GITHUB_M3U_SOURCES } = require('./lib/github-sources');
  res.json({ total: GITHUB_M3U_SOURCES.length, sources: GITHUB_M3U_SOURCES });
});
app.get('/api/scheduler-status', (_, res) => res.json(getStatus()));

// ─── Action routes ────────────────────────────────────────────────────────────
app.post('/api/update', async (req, res) => {
  res.json({ message: 'Update started.' });
  try { await updateIPTV(); } catch (e) { console.error('[server] update:', e.message); }
});
app.post('/api/generate-playlist', async (req, res) => {
  res.json({ message: 'Playlist generation started.' });
  try { await generatePlaylist(); } catch (e) { console.error('[server] playlist:', e.message); }
});
app.post('/api/github-fetch', async (req, res) => {
  res.json({ message: 'GitHub fetch started.' });
  try { await fetchAndCheckGitHub(); } catch (e) { console.error('[server] gh-fetch:', e.message); }
});

// ─── GitHub Search SSE ────────────────────────────────────────────────────────
const sseClients = new Set();
let searchRunning = false;

app.get('/api/search/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write(`event: init\ndata: ${JSON.stringify({ running: searchRunning })}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  sseClients.add(res);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

function broadcast(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) { try { client.write(msg); } catch {} }
}

app.post('/api/search/start', async (req, res) => {
  if (searchRunning) return res.json({ ok: false, message: 'Search already running.' });
  res.json({ ok: true, message: 'Search started.' });
  searchRunning = true;
  broadcast('status', { running: true });
  try {
    await runSearch((type, payload) => broadcast(type, payload));
  } catch (err) {
    broadcast('error', { message: err.message });
    console.error('[server] search error:', err.message);
  }
  searchRunning = false;
  broadcast('status', { running: false });
});

app.post('/api/search/stop', (req, res) => {
  if (!searchRunning) return res.json({ ok: false, message: 'No search running.' });
  abort();
  res.json({ ok: true, message: 'Stop signal sent.' });
});

app.get('/api/search/status', (req, res) => {
  res.json({ running: searchRunning, aborted: isAborted() });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n[server] ═══════════════════════════════════`);
  console.log(`[server] 📡 StreamHub IPTV Server v4`);
  console.log(`[server] Port: ${PORT}`);
  console.log(`[server] GET  /github.m3u       → GitHub quality playlist`);
  console.log(`[server] GET  /index.m3u        → Arabic/sports playlist`);
  console.log(`[server] GET  /tv.html          → Live TV player`);
  console.log(`[server] GET  /api/search/stream→ SSE live events`);
  console.log(`[server] ═══════════════════════════════════\n`);
  scheduleUpdates();
});
