'use strict';
/*
 * Tug of War: game server
 * - Serves the web app from ./public
 * - Runs the game on the server (one shared room): phones send tap counts, the server moves the rope
 *   and broadcasts one small state message to everybody about 5 times a second.
 * - The host screen (/host) needs a PIN to control rounds.
 *
 * Run:  HOST_PIN=1234 PORT=3000 node server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const BIND = process.env.BIND || '0.0.0.0';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
let HOST_PIN = (process.env.HOST_PIN || '').trim();
if (!HOST_PIN) {
  HOST_PIN = String(crypto.randomInt(1000, 10000));
  console.log('[tug] HOST_PIN was not set. Generated one for this run: ' + HOST_PIN);
}

/* ---------- game constants (same as the design doc) ---------- */
const GAIN = 0.16;        // how fast a lead in power moves the rope (per second)
const REF_RATE = 6;       // taps per second per player that count as full power
const MAX_RATE = 12;      // taps per second per player above which extra taps are ignored
const TICK_MS = 100;      // physics step
const STATE_MS = 200;     // how often the state is broadcast
const COUNTDOWN_MS = 3000;

/* ---------- game state ---------- */
const S = {
  ph: 'lobby', round: 0, seq: 0,
  names: ['Team Orange', 'Team Purple'], dur: 45,
  p: 0, pa: 0, pb: 0, rA: 0, rB: 0,
  tapsA: 0, tapsB: 0, tps: 0, peak: 0,
  w: -1, series: [0, 0], bots: [0, 0], bias: 0,
  phaseEnd: 0, liveAt: 0, results: [],
  pendA: 0, pendB: 0, final: { na: 0, nb: 0 }
};
const clients = new Set();

function now() { return Number(process.hrtime.bigint() / 1000000n); }

function counts() {
  let a = 0, b = 0, act = 0, partA = 0, partB = 0;
  const t = now();
  for (const ws of clients) {
    const m = ws.meta;
    if (m.team === 0) { a++; if (m.tapsRound > 0) partA++; }
    else if (m.team === 1) { b++; if (m.tapsRound > 0) partB++; }
    if (m.team !== null && t - m.lastTap < 2000) act++;
  }
  return { a, b, act, partA, partB };
}

function startCountdown() {
  if (S.ph === 'countdown' || S.ph === 'live') return;
  S.round++; S.ph = 'countdown'; S.p = 0; S.pa = 0; S.pb = 0; S.rA = 0; S.rB = 0;
  S.tapsA = 0; S.tapsB = 0; S.peak = 0; S.tps = 0; S.w = -1; S.pendA = 0; S.pendB = 0;
  for (const ws of clients) ws.meta.tapsRound = 0;
  S.phaseEnd = now() + COUNTDOWN_MS;
  broadcastState();
}
function startLive() {
  S.ph = 'live'; S.liveAt = now(); S.phaseEnd = S.liveAt + S.dur * 1000;
  broadcastState();
}
function endRound(c) {
  S.ph = 'result';
  S.w = S.p < -0.02 ? 0 : (S.p > 0.02 ? 1 : -1);
  if (S.w >= 0) S.series[S.w]++;
  const na = c.a + S.bots[0], nb = c.b + S.bots[1];
  S.final = { na, nb };
  S.results.push({
    round: S.round, when: new Date().toISOString(), a: S.names[0], b: S.names[1],
    pa: na, pb: nb, real: c.a + c.b, sim: S.bots[0] + S.bots[1],
    ta: Math.round(S.tapsA), tb: Math.round(S.tapsB),
    ca: na ? S.tapsA / na : 0, cb: nb ? S.tapsB / nb : 0,
    w: S.w, peak: Math.round(S.peak), dur: Math.round((now() - S.liveAt) / 1000),
    tappedA: c.partA, tappedB: c.partB
  });
  if (S.results.length > 200) S.results.shift();
  broadcastState(); sendHostInfo();
}

function gauss() { let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function simTaps(dt, t) {
  const out = [0, 0];
  if (S.ph !== 'live') return out;
  for (let k = 0; k < 2; k++) {
    const n = S.bots[k]; if (!n) continue;
    const eff = 1 + (k === 0 ? 1 : -1) * S.bias / 200;
    const rate = (3.6 + 1.2 * Math.sin(t / 1900 + k * 2)) * eff;
    const mean = n * rate * dt, sd = Math.sqrt(Math.max(mean, 0.01));
    out[k] = Math.max(0, mean + gauss() * sd);
  }
  return out;
}

let lastTick = now();
const tickStats = { sum: 0, n: 0, max: 0, avg: 0, maxOut: 0 };
function tick() {
  const t0 = now();
  const dt = Math.min(Math.max((t0 - lastTick) / 1000, 0.01), 0.5); lastTick = t0;
  const c = counts();
  const nA = c.a + S.bots[0], nB = c.b + S.bots[1];
  if (S.ph === 'countdown') {
    if (t0 >= S.phaseEnd) startLive();
  } else if (S.ph === 'live') {
    const sim = simTaps(dt, t0);
    const dA = S.pendA + sim[0], dB = S.pendB + sim[1]; S.pendA = 0; S.pendB = 0;
    S.tapsA += dA; S.tapsB += dB;
    const rA = nA ? dA / dt / nA : 0, rB = nB ? dB / dt / nB : 0;
    const k = 1 - Math.exp(-dt / 0.6);
    S.rA += (rA - S.rA) * k; S.rB += (rB - S.rB) * k;
    S.pa = Math.min(1.6, Math.max(0, S.rA / REF_RATE)); S.pb = Math.min(1.6, Math.max(0, S.rB / REF_RATE));
    S.p = Math.min(1, Math.max(-1, S.p + GAIN * dt * (S.pb - S.pa)));
    const tps = (dA + dB) / dt; S.tps += (tps - S.tps) * (1 - Math.exp(-dt / 1.0));
    if (S.tps > S.peak) S.peak = S.tps;
    if (Math.abs(S.p) >= 1 || t0 >= S.phaseEnd) endRound(c);
  } else {
    S.tps += (0 - S.tps) * (1 - Math.exp(-dt / 0.5));
  }
  const used = now() - t0; tickStats.sum += used; tickStats.n++; if (used > tickStats.max) tickStats.max = used;
}

function remMs() { return (S.ph === 'countdown' || S.ph === 'live') ? Math.max(0, S.phaseEnd - now()) : 0; }
function stateJson() {
  const c = counts();
  const na = S.ph === 'result' ? S.final.na : c.a + S.bots[0];
  const nb = S.ph === 'result' ? S.final.nb : c.b + S.bots[1];
  S.seq++;
  return JSON.stringify({
    v: 1, seq: S.seq, ph: S.ph, r: S.round, rem: Math.round(remMs()), dur: S.dur * 1000,
    p: Math.round(S.p * 1000) / 1000, pa: Math.round(S.pa * 100) / 100, pb: Math.round(S.pb * 100) / 100,
    ra: Math.round(S.rA * 10) / 10, rb: Math.round(S.rB * 10) / 10,
    na, nb, nm: S.names, w: S.w, s: S.series, ta: Math.round(S.tapsA), tb: Math.round(S.tapsB),
    tps: Math.round(S.tps), pk: Math.round(S.peak)
  });
}

/* ---------- networking ---------- */
const stats = { msgIn: 0, bytesOut: 0, msgInPS: 0, bytesOutPS: 0, lag: 0 };
function sendTo(ws, str) {
  if (ws.readyState !== 1) return;
  if (ws.bufferedAmount > 256 * 1024) return;   // slow client: skip this update, it will catch up on the next one
  ws.send(str); stats.bytesOut += str.length;
}
function broadcastState() {
  const s = stateJson();
  for (const ws of clients) sendTo(ws, s);
}
function sendHostInfo(onlyTo) {
  const c = counts();
  const info = JSON.stringify({
    t: 'hostinfo', clients: clients.size, players: [c.a, c.b], tapped: [c.partA, c.partB], active: c.act, bots: S.bots, bias: S.bias,
    dur: S.dur, names: S.names, msgIn: stats.msgInPS, kbOut: Math.round(stats.bytesOutPS / 1024),
    tickAvg: Math.round(tickStats.avg * 10) / 10, tickMax: Math.round(tickStats.maxOut * 10) / 10, lag: Math.round(stats.lag),
    results: S.results
  });
  if (onlyTo) { sendTo(onlyTo, info); return; }
  for (const ws of clients) if (ws.meta.host) sendTo(ws, info);
}

function handle(ws, m) {
  const meta = ws.meta, t = now();
  switch (m.t) {
    case 'join': {
      const team = m.team === 1 ? 1 : (m.team === 0 ? 0 : null);
      if (team === null) break;
      if ((S.ph === 'live' || S.ph === 'countdown') && meta.team !== null && meta.team !== team) break;
      meta.team = team; meta.lastTap = 0; break;
    }
    case 'leave': {
      if (S.ph === 'live' || S.ph === 'countdown') break;
      meta.team = null; break;
    }
    case 'tap': {
      if (S.ph !== 'live' || meta.team === null) break;
      let n = m.n | 0; if (n <= 0) break;
      const span = Math.max(0.05, (t - (meta.lastTapMsg || (t - 150))) / 1000);
      const cap = Math.ceil(MAX_RATE * span) + 1; if (n > cap) n = cap;
      meta.lastTapMsg = t; meta.lastTap = t; meta.tapsRound += n;
      if (meta.team === 0) S.pendA += n; else S.pendB += n;
      break;
    }
    case 'host': {
      if (String(m.pin || '') === HOST_PIN) {
        meta.host = true; meta.fails = 0; ws.send(JSON.stringify({ t: 'hostok' })); sendHostInfo(ws);
      } else {
        meta.fails++; ws.send(JSON.stringify({ t: 'hosterr' }));
        if (meta.fails >= 5) ws.close(4001, 'too many attempts');
      }
      break;
    }
    case 'ctl': {
      if (!meta.host) break;
      if (m.cmd === 'start') startCountdown();
      else if (m.cmd === 'next') { if (S.ph === 'result') { S.ph = 'lobby'; S.p = 0; S.pa = 0; S.pb = 0; S.rA = 0; S.rB = 0; broadcastState(); } }
      else if (m.cmd === 'reset') { S.series = [0, 0]; S.results = []; S.round = 0; S.ph = 'lobby'; S.p = 0; S.pa = 0; S.pb = 0; S.rA = 0; S.rB = 0; S.tapsA = 0; S.tapsB = 0; broadcastState(); }
      else if (m.cmd === 'cfg') {
        if (Array.isArray(m.names) && m.names.length === 2) S.names = m.names.map((x, i) => String(x || (i ? 'Team Purple' : 'Team Orange')).replace(/[\u0000-\u001f]/g, '').slice(0, 20));
        if ([30, 45, 60].includes(m.dur)) S.dur = m.dur;
        if (Array.isArray(m.bots) && m.bots.length === 2) S.bots = m.bots.map(x => Math.min(5000, Math.max(0, x | 0)));
        if (typeof m.bias === 'number') S.bias = Math.min(40, Math.max(-40, Math.round(m.bias)));
        broadcastState(); sendHostInfo();
      }
      break;
    }
    default: break;
  }
}

/* ---------- http ---------- */
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
const CSP = "default-src 'self'; media-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'self'; base-uri 'self'";

const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end('bad request'); }
  let p; try { p = decodeURIComponent(u.pathname); } catch (e) { res.writeHead(400); return res.end('bad request'); }
  const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP };
  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (p.length > 1 && p.endsWith('/') && /\/host\/$/.test(p)) { res.writeHead(301, { Location: p.slice(0, -1) }); return res.end(); }
  if (p === '/' || p === '/host') p = '/index.html';
  const file = path.join(PUB, path.normalize(p));
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    const base = Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': (ext === '.html') ? 'no-cache' : 'public, max-age=3600', 'Accept-Ranges': 'bytes' }, headers);
    // Byte-range support: iPhones and Safari will not play a video unless the server answers range requests.
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] !== '' || m[2] !== '')) {
      let start = m[1] === '' ? Math.max(0, st.size - parseInt(m[2], 10)) : parseInt(m[1], 10);
      let end = (m[1] === '' || m[2] === '') ? st.size - 1 : Math.min(parseInt(m[2], 10), st.size - 1);
      if (m[1] !== '' && m[2] === '') end = st.size - 1;
      if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
      res.writeHead(206, Object.assign({}, base, { 'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size, 'Content-Length': end - start + 1 }));
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
    }
    res.writeHead(200, Object.assign({}, base, { 'Content-Length': st.size }));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) { socket.destroy(); return; }
  if (!pathname.endsWith('/ws')) { socket.destroy(); return; }
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(req.headers.origin || '')) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
wss.on('connection', ws => {
  ws.meta = { team: null, host: false, fails: 0, tokens: 60, tokT: now(), lastTap: 0, lastTapMsg: 0, tapsRound: 0 };
  ws.isAlive = true; clients.add(ws);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', buf => {
    const t = now(), meta = ws.meta;
    meta.tokens = Math.min(60, meta.tokens + (t - meta.tokT) / 1000 * 30); meta.tokT = t;   // 30 messages per second, burst 60
    if (meta.tokens < 1) return; meta.tokens -= 1;
    stats.msgIn++;
    let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
    if (m && typeof m === 'object') handle(ws, m);
  });
  ws.on('close', () => { clients.delete(ws); });
  ws.on('error', () => { try { ws.terminate(); } catch (e) {} });
  sendTo(ws, stateJson());
});

/* ---------- timers ---------- */
setInterval(tick, TICK_MS);
setInterval(broadcastState, STATE_MS);
setInterval(() => {
  for (const ws of clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) {} }
}, 20000);
let lagLast = now();
setInterval(() => {
  const t = now(); stats.lag = Math.max(0, t - lagLast - 1000); lagLast = t;
  stats.msgInPS = stats.msgIn; stats.bytesOutPS = stats.bytesOut; stats.msgIn = 0; stats.bytesOut = 0;
  tickStats.avg = tickStats.n ? tickStats.sum / tickStats.n : 0; tickStats.maxOut = tickStats.max; tickStats.sum = 0; tickStats.n = 0; tickStats.max = 0;
  sendHostInfo();
}, 1000);

server.listen(PORT, BIND, () => {
  console.log('[tug] listening on http://' + (BIND === '0.0.0.0' ? 'localhost' : BIND) + ':' + PORT);
  console.log('[tug] players open /  and the big screen opens /host  (PIN ' + (process.env.HOST_PIN ? 'from HOST_PIN' : HOST_PIN) + ')');
});
function shutdown() { console.log('[tug] shutting down'); for (const ws of clients) try { ws.close(1001); } catch (e) {} server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
