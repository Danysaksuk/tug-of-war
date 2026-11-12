(function () {
'use strict';
var REF_RATE = 6;           // must match server.js (used by practice mode only)
var PRACTICE_DUR = 20;
var BASE = new URL('./', location.href).pathname;       // "/" or "/some/prefix/"
var mode = (/\/host\/?$/.test(location.pathname) || location.hash === '#host') ? 'host' : 'player';

function $(id) { return document.getElementById(id); }
function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
function fix1(x) { return (Math.round(x * 10) / 10).toFixed(1); }
var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ================= network ================= */
var ws = null, wsOpen = false, retry = 0, hostAuthed = false, pin = '';
try { pin = sessionStorage.getItem('tug.pin') || ''; } catch (e) {}
var P = { team: null, count: 0, pending: 0, round: -1, st: null, stAt: 0, endAt: 0, practice: false, prac: null, shownP: 0 };
var names = ['Team Orange', 'Team Purple'];
try { var savedTeam = sessionStorage.getItem('tug.team'); if (savedTeam === '0' || savedTeam === '1') P.team = parseInt(savedTeam, 10); } catch (e) {}

function wsUrl() { var u = new URL('ws', location.origin + BASE); u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; return u.href; }
function send(o) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; } return false; }
function connect() {
  try { ws = new WebSocket(wsUrl()); } catch (e) { return later(); }
  ws.onopen = function () {
    wsOpen = true; retry = 0;
    if (mode === 'host') { if (pin) send({ t: 'host', pin: pin }); else showPin(''); }
    else if (P.team !== null && !P.practice) send({ t: 'join', team: P.team });
    paintConn();
  };
  ws.onmessage = function (ev) {
    var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d.v === 1) onState(d);
    else if (d.t === 'hostok') { hostAuthed = true; $('host').setAttribute('data-pin', 'ok'); paintConn(); }
    else if (d.t === 'hosterr') { hostAuthed = false; pin = ''; try { sessionStorage.removeItem('tug.pin'); } catch (e) {} showPin('That PIN is not right'); }
    else if (d.t === 'hostinfo') onHostInfo(d);
  };
  ws.onclose = function () { wsOpen = false; hostAuthed = false; paintConn(); later(); };
  ws.onerror = function () {};
}
function later() { retry++; setTimeout(connect, Math.min(5000, 300 * retry)); }
function showPin(msg) { $('host').setAttribute('data-pin', 'need'); $('pinErr').textContent = msg || ''; setTimeout(function () { try { $('pinIn').focus(); } catch (e) {} }, 50); }

function paintConn() {
  var fresh = P.st && performance.now() - P.stAt < 3500;
  var pc = $('pChip'); pc.classList.toggle('ok', wsOpen && !!fresh);
  $('pChipTxt').textContent = !wsOpen ? 'Connecting' : (fresh ? 'Connected to host' : 'Waiting for the host');
  var hc = $('hConn'); hc.classList.toggle('ok', wsOpen && hostAuthed);
  $('hConnTxt').textContent = !wsOpen ? 'Connecting to server' : (hostAuthed ? 'Server connected' : 'Enter the host PIN');
}

/* ================= shared state from the server ================= */
function onState(d) {
  P.st = d; P.stAt = performance.now(); P.endAt = P.stAt + (d.rem || 0);
  if (d.nm && d.nm.length === 2) names = [String(d.nm[0]).slice(0, 24), String(d.nm[1]).slice(0, 24)];
  if (d.r !== P.round) { P.round = d.r; P.count = 0; P.pending = 0; $('myTaps').textContent = '0'; }
  if (mode === 'host') onHostState(d);
}

/* ================= PLAYER ================= */
function curState() { return P.practice ? P.prac : ((P.st && performance.now() - P.stAt < 4000) ? P.st : null); }
function phaseNow() { var s = curState(); return s ? s.ph : 'wait'; }
function remNow() { var s = curState(); if (!s) return 0; if (P.practice) return Math.max(0, s.rem); return Math.max(0, P.endAt - performance.now()); }
function showScreen(s) { $('player').setAttribute('data-screen', s); }
function pickTeam(t) {
  P.team = t; P.practice = false; P.count = 0; P.pending = 0; $('myTaps').textContent = '0';
  try { sessionStorage.setItem('tug.team', String(t)); } catch (e) {}
  send({ t: 'join', team: t }); showScreen('play'); paintPlayer();
}
function doTap() {
  var ph = phaseNow();
  if (ph !== 'live' || remNow() <= 0 || P.team === null) return;
  P.count++; $('myTaps').textContent = P.count;
  if (P.practice) P.prac.myTaps++; else P.pending++;
  try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) {}
}
setInterval(function () {                                   // batch taps: one small message about 8 times a second
  if (P.pending > 0 && !P.practice && wsOpen) { if (send({ t: 'tap', n: P.pending })) P.pending = 0; }
}, 120);
(function bindTap() {
  var b = $('tapbtn');
  b.addEventListener('pointerdown', function (e) { e.preventDefault(); b.classList.add('dn'); doTap(); });
  var up = function () { b.classList.remove('dn'); };
  b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('pointerleave', up);
  b.addEventListener('keydown', function (e) { if (e.code === 'Space' || e.key === 'Enter') { e.preventDefault(); if (!e.repeat) { b.classList.add('dn'); doTap(); } } });
  b.addEventListener('keyup', up);
  b.addEventListener('contextmenu', function (e) { e.preventDefault(); });
})();
$('pickA').addEventListener('click', function () { pickTeam(0); });
$('pickB').addEventListener('click', function () { pickTeam(1); });
$('changeTeam').addEventListener('click', function () {
  if (P.practice) { endPractice(); return; }
  var ph = phaseNow(); if (ph === 'live' || ph === 'countdown') return;
  P.team = null; try { sessionStorage.removeItem('tug.team'); } catch (e) {} send({ t: 'leave' }); showScreen('pick');
});
$('practiceBtn').addEventListener('click', function () { startPractice(); });

/* ---- games menu and the how-to-play popup ---- */
var htOpen = false;
function updateMute() { var v = $('htVideo'); $('htMute').textContent = v.muted ? 'Sound off' : 'Sound on'; $('htMute').setAttribute('aria-pressed', v.muted ? 'true' : 'false'); }
function openHowTo() {
  var m = $('howto'), v = $('htVideo'); htOpen = true; m.classList.add('open'); $('htEnd').classList.remove('show'); $('htProg').style.width = '0%';
  try { v.currentTime = 0; } catch (e) {}
  v.muted = false; v.preload = 'auto';
  var p = v.play();
  if (p && p.catch) p.catch(function () { v.muted = true; updateMute(); var q = v.play(); if (q && q.catch) q.catch(function () {}); });
  updateMute(); try { $('htSkip').focus(); } catch (e) {}
  $('htLoad').classList.add('show');
  setTimeout(function () { var vv = $('htVideo'); if (htOpen && (vv.error || vv.networkState === 3)) closeHowTo(true); }, 1200);   // video missing or unsupported: go straight to the game
}
function closeHowTo(toPick) {
  var m = $('howto'), v = $('htVideo'); htOpen = false; try { v.pause(); } catch (e) {} m.classList.remove('open');
  if (toPick) showScreen('pick');
}
$('gameTug').addEventListener('click', openHowTo);
$('htSkip').addEventListener('click', function () { closeHowTo(true); });
$('htPlay').addEventListener('click', function () { closeHowTo(true); });
$('htAgain').addEventListener('click', function () { var v = $('htVideo'); $('htEnd').classList.remove('show'); try { v.currentTime = 0; } catch (e) {} v.play(); });
$('htMute').addEventListener('click', function () { var v = $('htVideo'); v.muted = !v.muted; updateMute(); });
$('htVideo').addEventListener('click', function () { var v = $('htVideo'); if (v.paused) v.play(); else v.pause(); });
$('htVideo').addEventListener('timeupdate', function () { var v = $('htVideo'); if (v.duration) $('htProg').style.width = (100 * v.currentTime / v.duration) + '%'; });
$('htVideo').addEventListener('ended', function () { $('htEnd').classList.add('show'); $('htLoad').classList.remove('show'); });
$('htVideo').addEventListener('playing', function () { $('htLoad').classList.remove('show'); });
$('htVideo').addEventListener('waiting', function () { if (htOpen) $('htLoad').classList.add('show'); });
$('htSrc').addEventListener('error', function () { if (htOpen) closeHowTo(true); });   // never block the game if the video cannot load
$('howtoAgain').addEventListener('click', openHowTo);
$('backMenu').addEventListener('click', function () { showScreen('menu'); });
window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && htOpen) closeHowTo(true); });

/* practice mode: one player against a bot, entirely on the phone */
function startPractice() {
  P.practice = true; P.team = 0; P.count = 0; $('myTaps').textContent = '0'; send({ t: 'leave' }); showScreen('play');
  P.prac = { ph: 'countdown', r: 0, rem: 3000, dur: PRACTICE_DUR * 1000, p: 0, pa: 0, pb: 0, na: 1, nb: 1, nm: ['You', 'Bot'], w: -1, s: [0, 0], myTaps: 0, botTaps: 0, phStart: performance.now(), botRate: 4.4 };
  P.shownP = 0;
}
function endPractice() { P.practice = false; P.prac = null; P.team = null; try { sessionStorage.removeItem('tug.team'); } catch (e) {} showScreen('pick'); }
function stepPractice(dt) {
  var s = P.prac; if (!s) return; var now = performance.now();
  if (s.ph === 'countdown') { s.rem = Math.max(0, 3000 - (now - s.phStart)); if (s.rem <= 0) { s.ph = 'live'; s.phStart = now; s.rem = s.dur; s.lastMy = s.myTaps; } }
  else if (s.ph === 'live') {
    s.rem = Math.max(0, s.dur - (now - s.phStart));
    var botNow = s.botRate * (0.75 + 0.35 * Math.sin((now - s.phStart) / 1700)); s.botTaps += botNow * dt;
    var myRate = (s.myTaps - s.lastMy) / dt; s.lastMy = s.myTaps;
    var pa = clamp(myRate / REF_RATE, 0, 1.6), pb = clamp(botNow / REF_RATE, 0, 1.6);
    s.pa += (pa - s.pa) * (1 - Math.exp(-dt / 0.5)); s.pb += (pb - s.pb) * (1 - Math.exp(-dt / 0.5));
    s.p = clamp(s.p + 0.34 * dt * (s.pb - s.pa), -1, 1);
    if (Math.abs(s.p) >= 1 || s.rem <= 0) { s.ph = 'result'; s.w = s.p < -0.02 ? 0 : (s.p > 0.02 ? 1 : -1); s.rem = 0; }
  }
}
function paintPlayer() {
  var s = curState(), ph = s ? s.ph : 'wait', t = P.team;
  var pl = $('pPlay'); pl.className = 'screen ' + (t === 1 ? 't1' : 't0'); pl.setAttribute('data-ph', ph);
  var nm = s && s.nm ? [String(s.nm[0]), String(s.nm[1])] : names;
  $('rbA').textContent = nm[0]; $('rbB').textContent = nm[1];
  $('myTeamName').textContent = t === null ? '' : nm[t];
  var big = $('tapBig'), sm = $('tapSm'), btn = $('tapbtn'), sub = $('myTeamSub'), tm = $('pTimer');
  var secs = Math.ceil(remNow() / 1000);
  btn.disabled = true;
  if (ph === 'wait') { big.textContent = 'Wait'; sm.textContent = 'for the host to start'; sub.textContent = wsOpen ? 'Waiting for the host' : 'Connecting'; tm.textContent = '--'; }
  else if (ph === 'lobby') { big.textContent = 'Ready'; sm.textContent = 'Round starts soon'; sub.textContent = 'You are in. Get ready'; tm.textContent = '--'; }
  else if (ph === 'countdown') { big.textContent = secs > 0 ? String(secs) : 'Go'; sm.textContent = 'Get ready'; sub.textContent = 'Starting'; tm.textContent = ''; }
  else if (ph === 'live') { btn.disabled = false; big.textContent = 'TAP'; sm.textContent = 'as fast as you can'; sub.textContent = 'Pull!'; tm.textContent = String(secs); }
  else if (ph === 'result') { big.textContent = 'Done'; sm.textContent = ''; sub.textContent = 'Round over'; tm.textContent = ''; }
  var lock = (ph === 'live' || ph === 'countdown');
  $('changeTeam').textContent = P.practice ? 'Leave practice' : 'Change team';
  $('changeTeam').style.visibility = (lock && !P.practice) ? 'hidden' : 'visible';
  if (ph === 'result' && s) {
    var w = s.w, mine = P.practice ? P.prac.myTaps : P.count, win = (w === t), draw = (w === -1);
    $('rTitle').textContent = draw ? 'It is a draw' : (win ? 'You win!' : 'Good try');
    $('rSub').textContent = draw ? 'Both teams pulled evenly.' : (nm[w] + ' won this round.');
    $('rTaps').textContent = mine;
    $('rNext').textContent = P.practice ? 'Tap Leave practice to go back.' : 'Next round starts soon';
  }
  var target = s ? s.p : 0; P.shownP += (target - P.shownP) * 0.2;
  $('pMark').style.left = (50 + P.shownP * 47) + '%';
  paintConn();
}

/* ================= HOST ================= */
var H = { ph: 'lobby', round: 0, names: ['Team Orange', 'Team Purple'], dur: 45, p: 0, pa: 0, pb: 0, nA: 0, nB: 0, rem: 0, endAt: 0, w: -1,
  series: [0, 0], tapsA: 0, tapsB: 0, rA: 0, rB: 0, tps: 0, peak: 0, results: [], shownP: 0, prevPh: 'lobby', lastCount: -1, info: null, logN: -1 };
var arenaBuilt = false, figs = [[], []];
var join = '';
try { join = localStorage.getItem('tug.join') || ''; } catch (e) {}

function buildArena() {
  if (arenaBuilt) return; arenaBuilt = true;
  var ns = 'http://www.w3.org/2000/svg';
  [0, 1].forEach(function (t) {
    var g = $(t === 0 ? 'figsA' : 'figsB'); var col = t === 0 ? '#FF5900' : '#8318D8', dir = t === 0 ? 1 : -1;
    for (var i = 0; i < 10; i++) {
      var f = document.createElementNS(ns, 'g');
      function el(tag, at) { var e = document.createElementNS(ns, tag); for (var k in at) e.setAttribute(k, at[k]); return e; }
      f.appendChild(el('line', { x1: 0, y1: -62, x2: dir * 34, y2: -88, stroke: col, 'stroke-width': 9, 'stroke-linecap': 'round' }));
      f.appendChild(el('rect', { x: -13, y: -76, width: 26, height: 76, rx: 11, fill: col }));
      f.appendChild(el('circle', { cx: 0, cy: -92, r: 14, fill: '#F4EDE3' }));
      f.appendChild(el('circle', { cx: dir * 36, cy: -90, r: 6, fill: '#F4EDE3' }));
      g.appendChild(f); figs[t].push(f);
    }
  });
}

function onHostState(d) {
  H.ph = d.ph; H.round = d.r; H.rem = d.rem; H.endAt = performance.now() + d.rem; H.dur = Math.round(d.dur / 1000);
  H.p = d.p; H.pa = d.pa; H.pb = d.pb; H.nA = d.na; H.nB = d.nb; H.names = d.nm; H.w = d.w; H.series = d.s;
  H.tapsA = d.ta; H.tapsB = d.tb; H.rA = d.ra; H.rB = d.rb; H.tps = d.tps; H.peak = d.pk;
  if (d.ph !== H.prevPh) {
    if (d.ph === 'countdown') { H.lastCount = -1; beep(440, .12); }
    else if (d.ph === 'live') { showCount('Go!'); beep(880, .35, 'square'); }
    else if (d.ph === 'result') { showResult(d); if (d.w >= 0) { confetti(d.w); [523, 659, 784, 1047].forEach(function (f, i) { setTimeout(function () { beep(f, .22, 'triangle'); }, i * 140); }); } }
    H.prevPh = d.ph;
  }
}
function onHostInfo(d) {
  H.info = d; H.results = d.results || [];
  if (H.results.length !== H.logN) { H.logN = H.results.length; paintLog(); }
  // reflect server settings in the controls unless the user is editing them
  var act = document.activeElement && document.activeElement.id;
  if (act !== 'nameA') $('nameA').value = d.names[0]; if (act !== 'nameB') $('nameB').value = d.names[1];
  if (act !== 'durSel') $('durSel').value = String(d.dur);
  if (act !== 'simA') $('simA').value = d.bots[0]; if (act !== 'simB') $('simB').value = d.bots[1]; if (act !== 'simBias') $('simBias').value = d.bias;
}
function paintLog() {
  var tb = document.querySelector('#logT tbody'); tb.innerHTML = '';
  H.results.slice(-6).reverse().forEach(function (r) {
    var tr = document.createElement('tr');
    [r.round, r.w === -1 ? 'Draw' : (r.w === 0 ? 'O' : 'P'), r.ta + ' / ' + r.tb, r.peak].forEach(function (c) { var td = document.createElement('td'); td.textContent = c; tr.appendChild(td); });
    tb.appendChild(tr);
  });
}

var shownRem = 0;
function renderHost(now, dt) {
  buildArena();
  var host = $('host'); host.setAttribute('data-ph', H.ph);
  var rem = (H.ph === 'countdown' || H.ph === 'live') ? Math.max(0, H.endAt - now) : 0; H.remNow = rem;
  if (H.ph === 'countdown') { var c = Math.ceil(rem / 1000); if (c !== H.lastCount && c > 0) { H.lastCount = c; showCount(String(c)); if (c < 3) beep(440, .12); } }
  H.shownP += (H.p - H.shownP) * Math.min(1, dt * 9);
  var p = H.shownP, t = now / 1000, fx = 800 + p * 360, powA = H.pa, powB = H.pb;
  var tens = Math.min(1.4, powA + powB);
  var yc = 340 + 14 + tens * 30 + Math.sin(t * 9) * 3 * tens;
  var dd = 'M0 340 Q800 ' + yc.toFixed(1) + ' 1600 340';
  $('ropeA').setAttribute('d', dd); $('ropeB').setAttribute('d', dd); $('ropeB').setAttribute('stroke-dashoffset', (-fx * 0.6).toFixed(1));
  var q = fx / 1600, fy = 340 + 2 * q * (1 - q) * (yc - 340), flagBob = Math.sin(t * 7) * 2 * tens;
  $('flag').setAttribute('transform', 'translate(' + fx.toFixed(1) + ',' + (fy + flagBob).toFixed(1) + ')');
  $('pennant').setAttribute('points', '0,-120 ' + (p < 0 ? '-64,-96' : '64,-96') + ' 0,-72');
  var shown = [Math.min(6, H.nA), Math.min(6, H.nB)], ghost = [false, false];
  for (var tt = 0; tt < 2; tt++) { if (shown[tt] === 0 && H.ph === 'lobby') { shown[tt] = 3; ghost[tt] = true; } }
  for (var team = 0; team < 2; team++) {
    var dir = team === 0 ? 1 : -1, anchor = (team === 0 ? 135 : 1465) + p * 40, pow = team === 0 ? powA : powB;
    for (var i = 0; i < 10; i++) {
      var f = figs[team][i];
      if (i >= shown[team]) { f.style.display = 'none'; continue; }
      f.style.display = '';
      var x = anchor + dir * i * 52, lean = (6 + 16 * pow) * (1 + 0.14 * Math.sin(t * 9 + i * 1.3 + team)), bob = Math.sin(t * 10 + i) * 3 * pow;
      f.setAttribute('transform', 'translate(' + x.toFixed(1) + ',' + (480 + bob).toFixed(1) + ') rotate(' + (-dir * lean).toFixed(1) + ') scale(1.7)');
      f.setAttribute('opacity', ghost[team] ? '.28' : '1');
    }
  }
  $('hTimer').textContent = H.ph === 'live' ? String(Math.ceil(rem / 1000)) : '';
  $('sA').textContent = H.series[0]; $('sB').textContent = H.series[1];
  $('sNameA').textContent = H.names[0]; $('sNameB').textContent = H.names[1];
  $('mNameA').textContent = H.names[0]; $('mNameB').textContent = H.names[1];
  $('mNA').textContent = H.nA; $('mNB').textContent = H.nB; $('lnA').textContent = H.nA; $('lnB').textContent = H.nB;
  $('mRA').textContent = fix1(H.rA); $('mRB').textContent = fix1(H.rB);
  $('barA').style.width = clamp(powA / 1.2 * 100, 0, 100) + '%'; $('barB').style.width = clamp(powB / 1.2 * 100, 0, 100) + '%';
  paintConn();
}
function showCount(txt) { var n = $('countNum'); n.textContent = txt; n.classList.remove('pop'); void n.offsetWidth; if (!reduce) n.classList.add('pop'); }
function showResult(d) {
  var t = $('resTitle');
  if (d.w === -1) { t.textContent = 'It is a draw!'; t.className = ''; }
  else { t.textContent = d.nm[d.w] + ' wins!'; t.className = d.w === 0 ? 'wa' : 'wb'; }
  $('rsNameA').textContent = d.nm[0]; $('rsNameB').textContent = d.nm[1];
  $('rsPA').textContent = d.na; $('rsPB').textContent = d.nb; $('rsTA').textContent = d.ta; $('rsTB').textContent = d.tb;
  $('rsCA').textContent = fix1(d.na ? d.ta / d.na : 0); $('rsCB').textContent = fix1(d.nb ? d.tb / d.nb : 0);
}

/* confetti */
var fxP = [], fxOn = false, fxT0 = 0;
function confetti(team) {
  if (reduce) return;
  var cv = $('fx'), w = cv.clientWidth, h = cv.clientHeight; cv.width = w; cv.height = h;
  var cols = team === 0 ? ['#FF5900', '#CFFF00', '#F4EDE3'] : ['#8318D8', '#CFFF00', '#F4EDE3'];
  fxP = []; for (var i = 0; i < 170; i++) { var sd = team === 0 ? 0.18 : 0.82; fxP.push({ x: w * sd + (Math.random() - .5) * w * .2, y: h * .45, vx: (Math.random() - .5) * 14 + (team === 0 ? 4 : -4), vy: -Math.random() * 16 - 4, r: 5 + Math.random() * 7, c: cols[i % 3], a: Math.random() * 6, va: (Math.random() - .5) * .3 }); }
  fxT0 = performance.now(); fxOn = true;
}
function stepFx() {
  if (!fxOn) return; var cv = $('fx'), ctx = cv.getContext('2d'); ctx.clearRect(0, 0, cv.width, cv.height);
  var age = (performance.now() - fxT0) / 1000; if (age > 4.5) { fxOn = false; return; }
  for (var i = 0; i < fxP.length; i++) { var q = fxP[i]; q.vy += 0.45; q.x += q.vx; q.y += q.vy; q.vx *= 0.992; q.a += q.va; ctx.save(); ctx.globalAlpha = Math.max(0, 1 - age / 4.5); ctx.translate(q.x, q.y); ctx.rotate(q.a); ctx.fillStyle = q.c; ctx.fillRect(-q.r, -q.r / 2, q.r * 2, q.r); ctx.restore(); }
}

/* sound */
var actx = null, soundOn = false;
function beep(f, d, type) {
  if (!soundOn) return;
  try {
    if (!actx) { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; actx = new AC(); }
    if (actx.state === 'suspended') actx.resume();
    var o = actx.createOscillator(), g = actx.createGain(), n = actx.currentTime;
    o.type = type || 'sine'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, n); g.gain.exponentialRampToValueAtTime(0.25, n + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, n + d);
    o.connect(g); g.connect(actx.destination); o.start(n); o.stop(n + d + 0.02);
  } catch (e) {}
}

/* lobby QR: players open this site's root, so the link is worked out automatically */
var qrFor = '';
function playerUrl() { return join || (location.origin + BASE); }
function renderQR() {
  var box = $('qr'), url = playerUrl();
  $('joinText').textContent = url;
  if (url === qrFor) return; qrFor = url; box.innerHTML = '';
  try { new QRCode(box, { text: url, width: 300, height: 300, colorDark: '#411517', colorLight: '#F4EDE3', correctLevel: QRCode.CorrectLevel.M }); }
  catch (e) { box.textContent = 'Open the link below'; }
}
function toast(t) { var e = $('toast'); e.textContent = t; e.style.display = 'block'; clearTimeout(toast.h); toast.h = setTimeout(function () { e.style.display = 'none'; }, 3200); }
function csv() {
  var head = ['round', 'time_utc', 'team_a', 'team_b', 'players_a', 'players_b', 'real_players', 'simulated_players', 'tapped_a', 'tapped_b', 'taps_a', 'taps_b', 'taps_per_player_a', 'taps_per_player_b', 'winner', 'peak_taps_per_sec', 'seconds'];
  var rows = H.results.map(function (r) { return [r.round, r.when, r.a, r.b, r.pa, r.pb, r.real, r.sim, r.tappedA, r.tappedB, r.ta, r.tb, r.ca.toFixed(2), r.cb.toFixed(2), r.w === -1 ? 'draw' : (r.w === 0 ? r.a : r.b), r.peak, r.dur]; });
  return [head].concat(rows).map(function (r) { return r.map(function (c) { c = String(c); return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(','); }).join('\n') + '\n';
}
function cfg(o) { o.t = 'ctl'; o.cmd = 'cfg'; send(o); }
var cfgTimer = 0;
function cfgSoon(fn) { clearTimeout(cfgTimer); cfgTimer = setTimeout(fn, 200); }

if (mode === 'host') {
  $('goBtn').addEventListener('click', function () { send({ t: 'ctl', cmd: 'start' }); });
  $('nextBtn').addEventListener('click', function () { send({ t: 'ctl', cmd: 'next' }); });
  $('nameA').addEventListener('input', function () { cfgSoon(function () { cfg({ names: [$('nameA').value || 'Team Orange', $('nameB').value || 'Team Purple'] }); }); });
  $('nameB').addEventListener('input', function () { cfgSoon(function () { cfg({ names: [$('nameA').value || 'Team Orange', $('nameB').value || 'Team Purple'] }); }); });
  $('durSel').addEventListener('change', function () { cfg({ dur: parseInt($('durSel').value, 10) }); });
  function bots() { cfgSoon(function () { cfg({ bots: [parseInt($('simA').value, 10) || 0, parseInt($('simB').value, 10) || 0] }); }); }
  $('simA').addEventListener('input', bots); $('simB').addEventListener('input', bots);
  $('simBias').addEventListener('input', function () { cfgSoon(function () { cfg({ bias: parseInt($('simBias').value, 10) || 0 }); }); });
  $('joinIn').addEventListener('change', function () { join = $('joinIn').value.trim(); try { localStorage.setItem('tug.join', join); } catch (e) {} renderQR(); });
  $('bReset').addEventListener('click', function () { send({ t: 'ctl', cmd: 'reset' }); toast('Series reset'); });
  $('bExport').addEventListener('click', function () {
    if (!H.results.length) { toast('Play a round first'); return; }
    try {
      var blob = new Blob([csv()], { type: 'text/csv' }), a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'tug-of-war-pilot-results.csv'; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500); toast('Results exported');
    } catch (e) { toast('Could not export'); }
  });
  $('bSound').addEventListener('click', function () { soundOn = !soundOn; $('bSound').setAttribute('aria-pressed', soundOn ? 'true' : 'false'); if (soundOn) beep(660, .12); });
  $('bPilot').addEventListener('click', function () { var o = !$('pilot').classList.contains('open'); $('pilot').classList.toggle('open', o); $('bPilot').setAttribute('aria-pressed', o ? 'true' : 'false'); });
  $('bFs').addEventListener('click', toggleFs);
  function submitPin() { var v = $('pinIn').value.trim(); if (!v) return; pin = v; try { sessionStorage.setItem('tug.pin', pin); } catch (e) {} $('pinErr').textContent = ''; if (!send({ t: 'host', pin: pin })) $('pinErr').textContent = 'Not connected yet. Try again in a moment.'; }
  $('pinGo').addEventListener('click', submitPin);
  $('pinIn').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitPin(); });
  window.addEventListener('keydown', function (e) {
    var tg = e.target && e.target.tagName; if (tg === 'INPUT' || tg === 'SELECT') return;
    if (e.key === 'p' || e.key === 'P') $('bPilot').click(); else if (e.key === 'f' || e.key === 'F') toggleFs();
    else if (e.code === 'Space' || e.key === 'Enter') { if (H.ph === 'lobby') $('goBtn').click(); else if (H.ph === 'result') $('nextBtn').click(); e.preventDefault(); }
  });
}
function toggleFs() { try { var d = document, el = document.documentElement; if (d.fullscreenElement || d.webkitFullscreenElement) { (d.exitFullscreen || d.webkitExitFullscreen).call(d); } else { (el.requestFullscreen || el.webkitRequestFullscreen).call(el); } } catch (e) {} }

var fps = { n: 0, t: performance.now(), v: 0 };
function paintTelemetry() {
  var i = H.info; if (!i) return;
  $('tConn').textContent = wsOpen ? 'yes' : 'no'; $('tBc').textContent = i.clients;
  $('tPl').textContent = i.players[0] + i.players[1]; $('tPlT').textContent = i.players[0] + ' / ' + i.players[1];
  $('tAct').textContent = i.active; $('tTap').textContent = i.tapped[0] + ' / ' + i.tapped[1]; $('tSim').textContent = i.bots[0] + i.bots[1];
  $('tTps').textContent = Math.round(H.tps); $('tPk').textContent = Math.round(H.peak);
  $('tUpd').textContent = i.msgIn; $('tOut').textContent = i.kbOut; $('tTick').textContent = i.tickAvg + ' / ' + i.tickMax; $('tFps').textContent = fps.v;
  $('tCap').classList.toggle('hide', !(i.tickMax > 60 || i.lag > 100));
}

/* ================= main loop ================= */
var last = performance.now(), lastTel = 0;
function frame(now) {
  requestAnimationFrame(frame);
  var dt = Math.min((now - last) / 1000, 0.1); last = now;
  fps.n++; if (now - fps.t >= 1000) { fps.v = Math.round(fps.n * 1000 / (now - fps.t)); fps.n = 0; fps.t = now; }
  if (mode === 'host') {
    renderHost(now, dt); stepFx();
    if (now - lastTel >= 500) { lastTel = now; paintTelemetry(); }
  } else {
    if (P.practice) stepPractice(dt);
    var sc = $('player').getAttribute('data-screen');
    if (sc === 'menu') { paintConn(); }
    else if (sc === 'pick') {
      var s = curState(), c0 = s ? s.na : 0, c1 = s ? s.nb : 0, nm = s && s.nm ? s.nm : names;
      $('pickAName').textContent = nm[0]; $('pickBName').textContent = nm[1];
      $('pickACount').textContent = c0 + (c0 === 1 ? ' player' : ' players'); $('pickBCount').textContent = c1 + (c1 === 1 ? ' player' : ' players'); paintConn();
    } else paintPlayer();
  }
}

function start() {
  $('app').setAttribute('data-mode', mode);
  document.title = mode === 'host' ? 'Tug of War: host screen' : 'Tug of War | Rider Gala Gaming Village';
  if (mode === 'host') { buildArena(); $('joinIn').value = join; renderQR(); $('host').setAttribute('data-pin', 'need'); }
  else if (P.team !== null) { showScreen('play'); } else { showScreen('menu'); }
  connect(); requestAnimationFrame(frame);
}
window.__tug = { H: H, P: P, state: curState, csv: csv };
var started = false; function go() { if (!started) { started = true; start(); } }
if (document.fonts && document.fonts.load) { Promise.race([document.fonts.load('900 40px Poppins'), new Promise(function (r) { setTimeout(r, 1500); })]).then(go, go); } else go();
})();
