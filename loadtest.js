'use strict';
/*
 * Load test for Tug of War.
 *   node loadtest.js --url ws://localhost:3000/ws --pin 1234 --players 500 --rate 5 --seconds 30
 * Opens many fake phones, starts a round as the host, taps at the chosen rate, and reports what the server did.
 */
const { WebSocket } = require('ws');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const URL_ = arg('url', 'ws://localhost:3000/ws');
const PIN = arg('pin', process.env.HOST_PIN || '');
const N = parseInt(arg('players', '300'), 10);
const RATE = parseFloat(arg('rate', '5'));
const SECS = parseInt(arg('seconds', '30'), 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let received = 0, bytes = 0, stateCount = 0, connectFail = 0;
const phones = [];
function openPhone(i) {
  return new Promise(resolve => {
    const ws = new WebSocket(URL_);
    const ph = { ws, team: i % 2, timer: null, open: false };
    ws.on('open', () => { ph.open = true; ws.send(JSON.stringify({ t: 'join', team: ph.team })); resolve(ph); });
    ws.on('message', d => { received++; bytes += d.length; stateCount++; });
    ws.on('error', () => { connectFail++; resolve(ph); });
    ws.on('close', () => { ph.open = false; });
    phones.push(ph);
  });
}
(async () => {
  if (!PIN) { console.error('Pass --pin <HOST_PIN>'); process.exit(1); }
  console.log(`Connecting ${N} phones to ${URL_} ...`);
  const t0 = Date.now();
  for (let i = 0; i < N; i += 50) { await Promise.all(Array.from({ length: Math.min(50, N - i) }, (_, k) => openPhone(i + k))); await sleep(30); }
  console.log(`Connected ${phones.filter(p => p.open).length}/${N} in ${((Date.now() - t0) / 1000).toFixed(1)}s (${connectFail} failed)`);

  const host = new WebSocket(URL_); let info = null, last = null;
  await new Promise(r => host.on('open', r));
  host.on('message', d => { try { const m = JSON.parse(d); if (m.t === 'hostinfo') info = m; else if (m.v === 1) last = m; } catch (e) {} });
  host.send(JSON.stringify({ t: 'host', pin: PIN })); await sleep(500);
  if (!info) { console.error('Host PIN rejected or no host info'); process.exit(1); }
  host.send(JSON.stringify({ t: 'ctl', cmd: 'cfg', dur: 60 })); await sleep(300);
  host.send(JSON.stringify({ t: 'ctl', cmd: 'start' }));
  console.log('Round started. Waiting for the countdown ...'); await sleep(3300);

  for (const ph of phones) {
    ph.pending = 0;
    ph.timer = setInterval(() => { ph.pending += RATE * 0.12 * (0.7 + Math.random() * 0.6); const n = Math.floor(ph.pending); if (n > 0 && ph.open) { ph.ws.send(JSON.stringify({ t: 'tap', n })); ph.pending -= n; } }, 120);
  }
  received = 0; bytes = 0;
  const samples = [];
  for (let s = 0; s < SECS; s++) {
    await sleep(1000);
    if (info) samples.push({ msgIn: info.msgIn, kbOut: info.kbOut, tickAvg: info.tickAvg, tickMax: info.tickMax, lag: info.lag });
    process.stdout.write(`\r  t=${s + 1}s  rope=${last ? last.p : '?'}  taps/s=${last ? last.tps : '?'}  server msgs in/s=${info ? info.msgIn : '?'}   `);
    if (last && last.ph === 'result') break;
  }
  console.log('');
  for (const ph of phones) clearInterval(ph.timer);
  const avg = k => samples.length ? samples.reduce((a, b) => a + b[k], 0) / samples.length : 0;
  const mx = k => samples.reduce((a, b) => Math.max(a, b[k]), 0);
  console.log('\n===== Result =====');
  console.log(`Phones connected:            ${phones.filter(p => p.open).length} of ${N}`);
  console.log(`Taps per second (peak):      ${last ? last.pk : '?'}`);
  console.log(`Server messages in / sec:    avg ${avg('msgIn').toFixed(0)}, max ${mx('msgIn')}`);
  console.log(`Server data out / sec (KB):  avg ${avg('kbOut').toFixed(0)}, max ${mx('kbOut')}`);
  console.log(`Server tick (ms):            avg ${avg('tickAvg').toFixed(1)}, worst ${mx('tickMax')}  (the tick budget is 100 ms)`);
  console.log(`Event loop lag (ms):         worst ${mx('lag')}`);
  const secs = Math.max(1, SECS);
  console.log(`One phone received:          ${(received / phones.length / secs).toFixed(1)} state messages/sec, ${(bytes / phones.length / secs / 1024).toFixed(2)} KB/sec`);
  const bad = mx('tickMax') > 60 || mx('lag') > 150;
  console.log(bad ? '\nVERDICT: the server was struggling at this size. Use a bigger instance or fewer players.' : '\nVERDICT: the server kept up comfortably at this size.');
  host.send(JSON.stringify({ t: 'ctl', cmd: 'reset' })); await sleep(200);
  for (const ph of phones) try { ph.ws.close(); } catch (e) {} host.close(); await sleep(300); process.exit(0);
})();
