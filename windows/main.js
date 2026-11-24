// Arthur on the desktop — the Windows (Electron) shell.
//
// A port of desktop_companion/macos/ArthurDesktopCompanion.swift: the same page,
// the same messages both ways, the same physics. His day comes from life.js (the
// mechanical schedule), served to the page on 127.0.0.1 like standalone.py does.
//
// Coordinates here are Electron's: screen DIPs, y grows DOWNWARDS. (The Swift
// original is y-up; every comparison below is flipped accordingly.)
// Phase 1 has no window-climbing: he stands on the bottom of each screen (on top
// of the taskbar).
'use strict';

const {app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage, globalShortcut, powerMonitor} = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const {ScheduleLife, statusDocument} = require('./life');
const winwindows = require('./winwindows');

const BASE = {w: 390, h: 560};
const GRAVITY = 2600, WALK_SPEED = 46, DIZZY_SPEED = 650, SPLAT_SPEED = 1500, HOVER_FADE = 0.12;
const SCALES = [['小', 0.4], ['中', 0.6], ['原始大小', 1.0]];
const OPACITIES = [['不透明', 1.0], ['半透明', 0.65], ['很淡', 0.35]];
const GLASSES = [['偶尔（出门、看书时随他）', 'auto'], ['一直戴', 'on'], ['不戴', 'off']];
const OUTFITS = [
  ['自动（出门穿他自己挑的，在家白天便服、夜里睡衣）', 'auto'],
  ['海军蓝风衣+格子围巾', 'coat'], ['米色雨衣', 'raincoat'], ['粗花呢外套', 'tweed'],
  ['圣诞毛衣', 'jumper'], ['金融城绅士（圆顶礼帽）', 'city'], ['红色礼服', 'dress'],
  ['海盗船长', 'pirate'], ['七十年代朋克', 'punk'], ['旧军装风衣', 'trench'], ['居家便服', 'homewear'], ['条纹睡衣', 'pajamas'],
  ['学院袍', 'gown'], ['园艺装', 'garden'], ['不列颠天使', 'angel'], ['乡村蜡夹克', 'barbour'], ['女仆装', 'maid']
];
const rand = (a, b) => a + Math.random() * (b - a);
const debugLog = text => console.log('Arthur ' + text);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const nowS = () => performance.now() / 1000;

// ── preferences (the Mac app's UserDefaults) ───────────────────────────────
const PREF_DEFAULTS = {scale: 0.6, opacity: 1, alwaysOnTop: true, clickThrough: false, wanders: true,
  outfit: 'auto', outfitUntil: null, awayUntil: null, letterRead: '', lastGreetDay: '', patCount: 0, touchCount: 0,
  pockets: '', pageKV: '{}', awaySide: 1, glasses: 'auto', hidden: false, anchor: null, autoStartSet: false, climbsWindows: true};
let prefsFile, prefs, prefsTimer;
function loadPrefs() {
  prefsFile = path.join(app.getPath('userData'), 'prefs.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(prefsFile, 'utf8')) || {}; } catch (_e) { /* first run */ }
  prefs = Object.assign({}, PREF_DEFAULTS, saved);
}
function savePrefs() {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    try { fs.mkdirSync(path.dirname(prefsFile), {recursive: true}); fs.writeFileSync(prefsFile + '.tmp', JSON.stringify(prefs)); fs.renameSync(prefsFile + '.tmp', prefsFile); } catch (_e) { /* next time */ }
  }, 400);
}
function setPref(k, v) { prefs[k] = v; savePrefs(); }

// ── local server: the page, his status, and the little item windows ───────
const WEB_ROOT = [path.join(__dirname, 'web'), path.join(__dirname, '..', 'desktop_companion', 'web')].find(p => fs.existsSync(path.join(p, 'index.html')));
const MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.webp': 'image/webp', '.jpg': 'image/jpeg'};
let life, port;
function startServer() {
  life = new ScheduleLife(path.join(app.getPath('userData'), 'life.json'));
  const root = fs.realpathSync(WEB_ROOT);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, type, body, csp = true) => {
      const headers = {'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'};
      if (csp) headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'";
      res.writeHead(status, headers); res.end(body);
    };
    if (url.pathname === '/api/companion-status') {
      const doc = statusDocument(life);
      // Testing at any hour: awake, at home, free to move.
      if (process.env.ARTHUR_DEBUG_AWAKE) Object.assign(doc.arthur, {availability: 'awake', place: 'home', pose: 'awake',
        activity: {key: 'learned_activity', type: 'home', resources: {hands: 'none', mobility: 'mobile', body_locked: false}}});
      return send(200, MIME['.json'], JSON.stringify(doc) + '\n');
    }
    if (url.pathname === '/api/companion-preview' || url.pathname === '/api/companion-envelope') return send(200, MIME['.json'], '{"available":false}\n');
    if (url.pathname === '/_item') {
      const icon = String(url.searchParams.get('icon') || '?').slice(0, 8).replace(/[<>&"']/g, '');
      const size = clamp(Number(url.searchParams.get('s')) || 60, 20, 200);
      return send(200, MIME['.html'], `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden;user-select:none;cursor:grab}
div{width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;font-size:${Math.round(size * 0.72)}px;line-height:1;font-family:"Segoe UI Emoji","Apple Color Emoji",sans-serif}</style><div>${icon}</div>`, false);
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!/^[A-Za-z0-9_./-]{1,200}$/.test(rel) || rel.split('/').includes('..')) return send(404, 'text/plain', 'not found\n');
    const file = path.join(root, rel);
    fs.realpath(file, (err, real) => {
      if (err || !real.startsWith(root + path.sep)) return send(404, 'text/plain', 'not found\n');
      fs.readFile(real, (e2, data) => e2 ? send(404, 'text/plain', 'not found\n') : send(200, MIME[path.extname(real).toLowerCase()] || 'application/octet-stream', data));
    });
  });
  return new Promise(resolve => {
    const tryListen = p => {
      server.once('error', () => tryListen(0));
      server.listen(p, '127.0.0.1', () => { port = server.address().port; resolve(); });
    };
    tryListen(15174);
  });
}

// ── state (mirrors the Swift app) ──────────────────────────────────────────
let win, tray;
let pos = {x: 0, y: 0};                 // window top-left, floats
let size = {w: BASE.w, h: BASE.h};
let hitRects = [], feetCSS = null, pageCanWander = false, pageCanSit = false, pageSeated = false;
let sittingUntil = null;
let motion = {kind: 'resting'};         // resting | dragging{ox,oy} | falling{vx,vy} | walking{targetX,dir} | leaving{dir} | entering{targetX,dir}
let ledge = null;
let lastTick = nowS(), nextSupportCheck = 0, nextOutfitCheck = 0;
let dragSamples = [], flungHard = false;
let fleeing = false;
let stamina = 1, tiredAt = rand(0.15, 0.35), tired = false, catchBreathUntil = 0, nextBreather = 0;
let visitingCursor = false;
let lastMouse = {x: 0, y: 0}, lastMouseMoveAt = nowS(), nextIdleReport = 0;
let cornerSeekUntil = null, nextCornerStep = 0;
let carried = false, dragStartY = 0, dragStartX = 0, dragStartLedgeY = null, dragMaxLift = 0, dragStartedAt = 0, nextLiftReport = 0;
let dragTrail = [], nextDragMotionRead = 0, dragTurn = 0, dragMotionSaid = {};
let hopping = false, fallPeakY = 0, splatOnLanding = false, hopAimY = null, noHopsUntil = 0, peekUntil = 0, edgeFearOn = false;
let dropThroughY = null;
let rideFrame = null, rideId = null, rideLevel = 0, rideSpeed = 0, rideStillSince = 0;                // hopping down through the edge he stood on (he's drawn in front of windows)
let leaveWhenGrounded = false, pendingAwayUntil = null;
let nextWanderAt = nowS() + 20;
let lastPointerSent = null, lastPointerAt = 0;
let settledOnce = false;
let supportLost = false, floating = false;
let chasePaused = false, stealStartedAt = 0, snatchReachSince = null, snatchArmed = false;
let item = null;                        // {win, size, x, y (top-left), state:'held'|'falling'|'lying'|'unreachable', vy, spot}
let gift = null;                        // {win, size, x, y, state:'falling'|'lying'|'held', vy, start, moved, born}
let nextFetchPlan = 0;
let ignoring = null;
let mouseDown = false, mouseDownAt = 0, mouseFromPet = false;
let shownOpacity = null;

const zoom = () => prefs.scale;
const isMotion = k => motion.kind === k;

function js(src) {
  if (!win || win.isDestroyed()) return Promise.resolve(null);
  return win.webContents.executeJavaScript(src, true).catch(() => null);
}
const host = (call) => js(`window.ArthurHost && ArthurHost.${call.split('(')[0]} && ArthurHost.${call}`);

function setFleeing(on) {
  if (on === fleeing) return;
  fleeing = on;
  js(`window.ArthurHost && ArthurHost.walkRate && ArthurHost.walkRate(${on ? (tired ? 1.3 : 2.3) : 1})`);
}

// ── geometry ───────────────────────────────────────────────────────────────
function placeWindow() {
  if (!win || win.isDestroyed()) return;
  win.setBounds({x: Math.round(pos.x), y: Math.round(pos.y), width: size.w, height: size.h});
}
function frame() { return {x: pos.x, y: pos.y, w: size.w, h: size.h}; }
function feetOnScreen() {
  if (!feetCSS) return null;
  return {x: pos.x + feetCSS.x * zoom(), y: pos.y + feetCSS.y * zoom()};
}
function screenRects() {
  return hitRects.map(r => ({x: pos.x + r[0] * zoom(), y: pos.y + r[1] * zoom(), w: r[2] * zoom(), h: r[3] * zoom()}));
}
const inRect = (p, r, pad = 0) => p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
function isOverArthur(p) { return screenRects().some(r => inRect(p, r, 2)); }
function overHisMiddle(p) { const f = frame(); return inRect(p, {x: f.x + f.w * 0.2, y: f.y + f.h * 0.15, w: f.w * 0.6, h: f.h * 0.7}); }
function bodyHeight() {
  const feet = feetOnScreen(), rects = screenRects();
  if (!feet || !rects.length) return size.h * 0.45;
  const top = Math.min(...rects.map(r => r.y));
  return feet.y - top > 20 ? feet.y - top : size.h * 0.45;
}
function displays() { return screen.getAllDisplays(); }
function displayAtX(x) { return displays().find(d => d.bounds.x <= x && x <= d.bounds.x + d.bounds.width) || screen.getPrimaryDisplay(); }
/// The bottom of every screen's work area (on top of the taskbar), and the top edges
/// of other windows wherever no window in front of them covers that line.
let ledgeCache = null, ledgeCacheAt = 0;
function ledges() {
  const t = nowS();
  if (ledgeCache && t - ledgeCacheAt < 0.1) return ledgeCache;
  const out = displays().map(d => ({y: d.workArea.y + d.workArea.height, minX: d.bounds.x, maxX: d.bounds.x + d.bounds.width, kind: 'floor'}));
  if (prefs.climbsWindows) {
    const areas = displays().map(d => d.workArea);
    const inFront = [];
    for (const w of winwindows.windows(screen)) {
      const r = {x: w.x, y: w.y, w: w.w, h: w.h};
      const top = r.y;
      // Full-height / maximised windows reach the top of the work area: no ledge there.
      const usable = r.w >= 160 && r.h >= 80 && !w.maximized &&
        areas.some(a => top > a.y + 4 && top < a.y + a.height - 40 && r.x + r.w > a.x && r.x < a.x + a.width);
      if (usable) {
        let spans = [[r.x, r.x + r.w]];
        for (const c of inFront) {
          if (!(c.y < top + 2 && c.y + c.h > top + 2)) continue;
          spans = spans.flatMap(([a, b]) => (c.x + c.w <= a || c.x >= b) ? [[a, b]] : [[a, c.x], [c.x + c.w, b]].filter(([p, q]) => q - p > 0));
        }
        for (const [a, b] of spans) if (b - a >= 80) out.push({y: top, minX: a, maxX: b, kind: 'window', id: w.id});
      }
      inFront.push(r);
    }
  }
  ledgeCache = out; ledgeCacheAt = t;
  return out;
}
const hasDropAtEnds = l => l && l.kind === 'window';
/// How far down from this edge, just past x.
function dropHeight(l, x) {
  let below = null;
  for (const o of ledges()) if (o.y > l.y + 2 && o.minX <= x && x <= o.maxX && (below == null || o.y < below)) below = o.y;
  return (below == null ? lowestBottom() : below) - l.y;
}
/// Room above an edge for him to hop up onto it (his head under the top of the work area).
function headroom(l, x) {
  const d = displayAtX(x);
  return l.y - bodyHeight() - 46 - 8 >= d.workArea.y;
}
// Whether he dares jump off the end of this road: a dice roll by the drop (in his own
// heights). One roll per road end, kept a few seconds so he doesn't flip-flop.
const edgeDares = new Map();
function dareChance(drop, tries) {
  const h = drop / Math.max(1, bodyHeight());
  if (h <= 1.5) return 1;
  let p = clamp(1.25 - 0.27 * h, 0.08, 1);
  if (item && item.state === 'held') p += 0.2;
  p += 0.15 * tries;
  return clamp(p, 0.05, 1);
}
function tooHighToDrop(l, x) {
  if (!hasDropAtEnds(l)) return false;
  const [lo, hi] = span(l);
  const left = x < (lo + hi) / 2;
  const endX = left ? lo - 30 : hi + 30;
  const drop = dropHeight(l, endX);
  if (drop <= bodyHeight() * 1.5) return false;
  const key = `${Math.round(l.y)}:${Math.round(left ? lo : hi)}:${left ? 'L' : 'R'}`;
  const t = nowS(), prev = edgeDares.get(key);
  if (prev && t < prev.until) return !prev.dares;
  const tries = prev && t - prev.until < 30 ? prev.tries + 1 : 0;
  const dares = Math.random() < dareChance(drop, tries);
  edgeDares.set(key, {until: t + (dares ? 6 : rand(6, 14)), dares, tries});
  if (edgeDares.size > 40) for (const [k, v] of edgeDares) if (t - v.until > 30) edgeDares.delete(k);
  debugLog(`at an edge: drop ${(drop / Math.max(1, bodyHeight())).toFixed(1)} heights, ${dares ? 'jumps' : "won't"} (try ${tries})`);
  return !dares;
}
function span(l) {
  const same = ledges().filter(o => Math.abs(o.y - l.y) < 3).sort((a, b) => a.minX - b.minX);
  let lo = l.minX, hi = l.maxX, grew = true;
  while (grew) {
    grew = false;
    for (const o of same) if (o.maxX >= lo - 14 && o.minX <= hi + 14 && (o.minX < lo || o.maxX > hi)) { lo = Math.min(lo, o.minX); hi = Math.max(hi, o.maxX); grew = true; }
  }
  return [lo, hi];
}
/// The highest surface at or below y (y-down: the smallest y that is >= y) under x.
function ledgeBelow(y, x) {
  let best = null;
  for (const l of ledges()) if (l.y >= y - 1 && x >= l.minX + 6 && x <= l.maxX - 6 && (!best || l.y < best.y)) best = l;
  return best;
}
function lowestBottom() { return Math.max(...displays().map(d => d.bounds.y + d.bounds.height)); }
function moveFeet(p) { if (!feetCSS) return; pos.x = p.x - feetCSS.x * zoom(); pos.y = p.y - feetCSS.y * zoom(); placeWindow(); }
let fakeCursor = null;             // ARTHUR_DEBUG_SCRIPT drives a pretend mouse
function cursor() { return fakeCursor ? {x: fakeCursor.x, y: fakeCursor.y} : screen.getCursorScreenPoint(); }
function screenUnderFeet() {
  const f = feetOnScreen() || {x: pos.x + size.w / 2};
  return displayAtX(f.x).bounds;
}

function applyScale() {
  const s = prefs.scale;
  size = {w: Math.round(BASE.w * s), h: Math.round(BASE.h * s)};
  if (win && !win.isDestroyed()) win.webContents.setZoomFactor(s);
  const anchor = prefs.anchor || defaultAnchor();
  pos = clampFrame({x: anchor[0] - size.w / 2, y: anchor[1] - size.h});
  placeWindow();
  settledOnce = false;          // re-stand him on whatever is under his feet
  if (feetCSS) { settledOnce = true; startFalling(); }
}
function defaultAnchor() {
  const wa = screen.getPrimaryDisplay().workArea;
  return [wa.x + wa.width - size.w / 2 - 24, wa.y + wa.height];
}
function clampFrame(p) {
  const ok = displays().some(d => {
    const a = d.workArea;
    const ix = Math.min(a.x + a.width, p.x + size.w) - Math.max(a.x, p.x);
    const iy = Math.min(a.y + a.height, p.y + size.h) - Math.max(a.y, p.y);
    return ix > size.w * 0.4 && iy > size.h * 0.3;
  });
  if (ok) return p;
  const a = screen.getPrimaryDisplay().workArea;
  return {x: clamp(p.x, a.x - size.w * 0.3, a.x + a.width - size.w * 0.7), y: clamp(p.y, a.y, a.y + a.height - size.h * 0.7)};
}
function rememberPosition() { setPref('anchor', [pos.x + size.w / 2, pos.y + size.h]); }

// ── page messages ──────────────────────────────────────────────────────────
function onHostMessage(body) {
  if (!body || typeof body.type !== 'string') return;
  switch (body.type) {
    case 'hit':
      if (Array.isArray(body.rects)) hitRects = body.rects.filter(r => Array.isArray(r) && r.length === 4).map(r => r.map(Number));
      if (Array.isArray(body.feet) && body.feet.length === 2) feetCSS = {x: Number(body.feet[0]), y: Number(body.feet[1])};
      pageCanWander = !!body.canWander; pageCanSit = !!body.canSit; pageSeated = !!body.seated;
      if (!settledOnce && feetCSS) { settledOnce = true; startFalling(); }
      break;
    case 'drag-begin': {
      const m = cursor(), t = nowS();
      mouseDown = true; mouseDownAt = t; mouseFromPet = true;
      dragSamples = [{t, p: m}];
      carried = true; supportLost = false; setFloating(false); cornerSeekUntil = null;
      const f = feetOnScreen();
      dragStartY = f ? f.y : 0; dragStartX = f ? f.x : 0; dragStartLedgeY = ledge ? ledge.y : null;
      dragMaxLift = 0; dragStartedAt = t; dragTrail = [{t, p: m}]; dragTurn = 0; dragMotionSaid = {};
      setTimeout(() => { if (isMotion('dragging') && liftNow() >= 0.6) host('pickedUp()'); }, 500);
      hopping = false; splatOnLanding = false; leaveWhenGrounded = false; pendingAwayUntil = null;
      stopWalking(false);
      sittingUntil = null;
      motion = {kind: 'dragging', ox: m.x - pos.x, oy: m.y - pos.y};
      setIgnore(false);
      break;
    }
    case 'drag-end': if (isMotion('dragging')) releaseDrag(); break;
    case 'log': console.log('Arthur page:', String(body.text || '').slice(0, 400)); break;
    case 'leave': sendAway(typeof body.until === 'number' ? body.until : null); break;
    case 'kv': if (typeof body.json === 'string' && body.json.length < 16000) setPref('pageKV', body.json); break;
    case 'go-corner': cornerSeekUntil = nowS() + 60; nextCornerStep = 0; break;
    case 'pockets': if (typeof body.json === 'string' && body.json.length < 8000) setPref('pockets', body.json); break;
    case 'gift-drop': if (typeof body.icon === 'string') dropGift(body.icon); break;
    case 'steal-start': if (typeof body.icon === 'string') beginSteal(body.icon); break;
    case 'chase-pause':
      chasePaused = body.on === true;
      if (chasePaused && isMotion('walking') && fleeing) stopWalking();
      break;
    case 'pat-count': if (Number.isInteger(body.n)) setPref('patCount', Math.max(0, body.n)); break;
    case 'touch-count': if (Number.isInteger(body.n)) setPref('touchCount', Math.max(0, body.n)); break;
    case 'flee': flee(Number(body.direction) < 0 ? -1 : 1); break;
    case 'letter-read': if (typeof body.id === 'string' && /^[0-9a-f]{12}$/.test(body.id)) setPref('letterRead', body.id); break;
    case 'outfit': if (typeof body.mode === 'string') wear(body.mode, typeof body.until === 'number' ? body.until : null); break;
    default: break;
  }
}

// ── movement ───────────────────────────────────────────────────────────────
function setFloating(on) {
  if (on === floating) return;
  floating = on;
  host(`floatDown(${on})`);
}
function startFalling(vx = 0, vy = 0, hop = false) {
  supportLost = false;
  const feet = feetOnScreen();
  if (!feet) return;
  sittingUntil = null;
  const areas = displays().map(d => d.workArea);
  if (!areas.some(a => feet.x >= a.x + 20 && feet.x <= a.x + a.width - 20)) {
    const near = areas.reduce((b, a) => Math.abs(a.x + a.width / 2 - feet.x) < Math.abs(b.x + b.width / 2 - feet.x) ? a : b);
    const x = clamp(feet.x, near.x + 40, near.x + near.width - 40);
    pos.x += x - feet.x; placeWindow();
  }
  ledge = null;
  fallPeakY = feet.y;
  if (hop) host(`hop(${vx < 0 ? -1 : 1})`); else js('window.ArthurHost && ArthurHost.fall()');
  motion = {kind: 'falling', vx, vy};
}
function liftNow() {
  const feet = feetOnScreen();
  if (!feet) return 0;
  return Math.max(0, dragStartY - feet.y) / Math.max(1, size.h * 0.6);
}
function bonk(speed) {
  if (hopping) return;
  if (speed >= SPLAT_SPEED) { splatOnLanding = true; host("knock('dizzy', true)"); }
  else if (speed >= DIZZY_SPEED) host("knock('dizzy')");
}
function walk(dir, then) {
  js(`window.ArthurHost ? ArthurHost.walk(${dir > 0 ? 1 : -1}) : false`).then(ok => { if (ok === true) then(); });
}
function stopWalking(tellPage = true) {
  setFleeing(false);
  if (visitingCursor) {
    visitingCursor = false;
    const m = cursor();
    host(`visitCursor(${Math.round((m.x - pos.x) / zoom())}, ${Math.round((m.y - pos.y) / zoom())})`);
  }
  if (isMotion('walking')) {
    motion = {kind: 'resting'};
    if (tellPage) js('window.ArthurHost && ArthurHost.stop()');
    rememberPosition();
  }
}
function sit(on, seconds) {
  js(`window.ArthurHost ? ArthurHost.sit(${on}) : false`).then(ok => {
    if (ok === true) sittingUntil = on && seconds ? nowS() + rand(seconds[0], seconds[1]) : null;
  });
}
function updateStamina(now, dt) {
  if (isMotion('walking') && fleeing) stamina -= 0.035 * dt;
  else if (isMotion('resting')) stamina += 0.05 * dt;
  stamina = clamp(stamina, 0, 1);
  if (!tired && stamina < tiredAt) {
    tired = true; nextBreather = now + rand(1.5, 3);
    host('tired(true)');
    if (fleeing) js('window.ArthurHost && ArthurHost.walkRate && ArthurHost.walkRate(1.3)');
  } else if (tired && stamina > Math.min(0.9, tiredAt + 0.35)) {
    tired = false; tiredAt = rand(0.15, 0.35);
    host('tired(false)');
  }
}

// Off to the snuggest corner (late at night, before the blanket comes out).
function stepTowardsCorner(now) {
  if (cornerSeekUntil == null || now < nextCornerStep) return;
  nextCornerStep = now + 0.5;
  const feet = feetOnScreen();
  if (!isMotion('resting') || !ledge || !feet) return;
  if (now > cornerSeekUntil || item) { arrivedInCorner(); return; }
  const scr = screenUnderFeet();
  const inset = size.w * 0.32;
  const [lo, hi] = span(ledge);
  const nearRight = (scr.x + scr.width - feet.x) < (feet.x - scr.x);
  const target = nearRight ? Math.min(hi, scr.x + scr.width) - inset : Math.max(lo, scr.x) + inset;
  if (Math.abs(target - feet.x) < 30) { arrivedInCorner(); return; }
  const dir = target > feet.x ? 1 : -1;
  walk(dir, () => { if (isMotion('resting')) motion = {kind: 'walking', targetX: target, dir}; });
}
function arrivedInCorner() { cornerSeekUntil = null; host('inCorner()'); }

// ── a stolen thing of his, out on the desktop ──────────────────────────────
function makeThingWindow(icon) {
  const s = Math.round(40 + 34 * zoom());
  const w = new BrowserWindow({width: s, height: s, frame: false, transparent: true, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, show: false, backgroundColor: '#00000000',
    webPreferences: {preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true}});
  w.setAlwaysOnTop(true, 'screen-saver');
  w.loadURL(`http://127.0.0.1:${port}/_item?icon=${encodeURIComponent(icon)}&s=${s}`);
  w.setIgnoreMouseEvents(true);
  w.once('ready-to-show', () => w.showInactive());
  return {win: w, size: s, x: 0, y: 0};
}
function thingAt(t, cx, cy) { t.x = cx - t.size / 2; t.y = cy - t.size / 2; t.win.setPosition(Math.round(t.x), Math.round(t.y)); }
function thingRest(t, fx, fy) { t.x = fx - t.size / 2; t.y = fy - t.size; t.win.setPosition(Math.round(t.x), Math.round(t.y)); }
const thingFoot = t => ({x: t.x + t.size / 2, y: t.y + t.size});
function closeThing(t) { if (t && t.win && !t.win.isDestroyed()) t.win.destroy(); }

function beginSteal(icon) {
  closeThing(item);
  item = Object.assign(makeThingWindow(icon), {state: 'held', vy: 0});
  item.win.setIgnoreMouseEvents(false);
  const m = cursor(); thingAt(item, m.x, m.y);
  mouseDown = true; mouseDownAt = nowS(); mouseFromPet = true;   // she pulled it out of his hands
  chasePaused = false; stealStartedAt = nowS(); snatchReachSince = null; snatchArmed = false;
  sittingUntil = null;
  if (pageSeated) sit(false);
}
function finishItem(how) {
  closeThing(item); item = null;
  setFleeing(false);
  host(`itemBack('${how}')`);
}
function trySnatch(m, now) {
  const feet = feetOnScreen();
  if (!feet) return false;
  if (!isMotion('resting') && !isMotion('walking')) { snatchReachSince = null; return false; }
  const h = bodyHeight(), reachX = h * 0.75;
  const within = Math.abs(m.x - feet.x) < reachX && m.y < feet.y + 10 && m.y > feet.y - h * 1.05;
  if (!within) {
    snatchReachSince = null;
    if (Math.abs(m.x - feet.x) > reachX * 1.6 || m.y < feet.y - h * 1.6) snatchArmed = true;
    return false;
  }
  if (!snatchArmed || now - stealStartedAt <= 1.2) return false;
  if (snatchReachSince == null) snatchReachSince = now;
  if (now - snatchReachSince <= 0.6) return false;
  snatchReachSince = null;
  finishItem('snatched');
  return true;
}
function chase(x) {
  const feet = feetOnScreen();
  if (!ledge || !feet || !(isMotion('resting') || isMotion('walking'))) return;
  const now = nowS();
  if (tired) {
    if (now < catchBreathUntil) { if (isMotion('walking')) stopWalking(); return; }
    if (now >= nextBreather) {
      catchBreathUntil = now + rand(1.5, 3.2); nextBreather = catchBreathUntil + rand(2.5, 5);
      if (isMotion('walking')) stopWalking();
      return;
    }
  }
  const [lo, hi] = span(ledge);
  const target = clamp(x, lo + 20, hi - 20);
  if (Math.abs(target - feet.x) < 26) { if (isMotion('walking')) stopWalking(); return; }
  const dir = target > feet.x ? 1 : -1;
  if (isMotion('walking') && motion.dir === dir) { motion.targetX = target; setFleeing(true); return; }
  walk(dir, () => { setFleeing(true); motion = {kind: 'walking', targetX: target, dir}; });
}
function planFetch(spot) {
  const feet = feetOnScreen();
  if (!isMotion('resting') || !ledge || !feet || !item) return;
  const itemX = thingFoot(item).x;
  const [lo, hi] = span(ledge);
  if (Math.abs(ledge.y - spot.y) < 3 && lo <= itemX && itemX <= hi) {
    if (Math.abs(itemX - feet.x) < 28) { finishItem('fetched'); return; }
    const dir = itemX > feet.x ? 1 : -1;
    walk(dir, () => { if (isMotion('resting')) { setFleeing(true); motion = {kind: 'walking', targetX: itemX, dir}; } });
  } else {
    item.state = 'unreachable';
    host('itemUnreachable()');
  }
}
function ledgeUnder(t) {
  const f = thingFoot(t);
  return ledges().find(l => l.minX <= f.x && f.x <= l.maxX && Math.abs(l.y - f.y) < 2);
}
function fallThing(t, dt) {           // shared by item and gift; returns 'landed' | 'lost' | null
  t.vy += GRAVITY * dt;
  const f = thingFoot(t);
  const nextY = f.y + t.vy * dt;
  const target = ledgeBelow(f.y, f.x);
  if (target && nextY >= target.y) { thingRest(t, f.x, target.y); t.spot = target; return 'landed'; }
  if (nextY > lowestBottom() + 100) return 'lost';
  thingRest(t, f.x, nextY);
  return null;
}
function updateItem(now, dt) {
  if (!item) return;
  const m = cursor();
  switch (item.state) {
    case 'held':
      thingAt(item, m.x, m.y - 6);
      if (!mouseDown) {
        if (isOverArthur(m) || overHisMiddle(m)) finishItem('returned');
        else { item.state = 'falling'; item.vy = 0; item.win.setIgnoreMouseEvents(true); stopWalking(); host('itemDropped()'); }
      } else if (!chasePaused && !trySnatch(m, now)) chase(m.x);
      break;
    case 'falling': {
      const r = fallThing(item, dt);
      if (r === 'landed') { item.state = 'lying'; item.win.setIgnoreMouseEvents(false); nextFetchPlan = now + 0.6; }
      else if (r === 'lost') finishItem('fetched');
      break;
    }
    case 'lying':
      if (!ledgeUnder(item)) { item.state = 'falling'; item.vy = 0; item.win.setIgnoreMouseEvents(true); break; }
      if (!chasePaused && now >= nextFetchPlan) { nextFetchPlan = now + 0.6; planFetch(item.spot); }
      break;
    case 'unreachable':
      if (!ledgeUnder(item)) { item.state = 'falling'; item.vy = 0; item.win.setIgnoreMouseEvents(true); }
      break;
  }
}

// ── a peace offering ───────────────────────────────────────────────────────
function dropGift(icon) {
  closeThing(gift);
  gift = Object.assign(makeThingWindow(icon), {state: 'falling', vy: 0, born: Date.now()});
  const feet = feetOnScreen() || {x: pos.x + size.w / 2, y: pos.y + size.h};
  const side = Math.random() < 0.5 ? 1 : -1;
  thingAt(gift, feet.x + side * rand(110, 200) * Math.max(zoom(), 0.5), feet.y - size.h * 0.6);
}
function clearGift(how) {
  closeThing(gift); gift = null;
  if (how) host(`giftDone('${how}')`);
}
function updateGift(dt) {
  if (!gift) return;
  const born = new Date(gift.born);
  if (Date.now() - gift.born > 20 * 3600 * 1000 || born.toDateString() !== new Date().toDateString()) { clearGift(null); return; }
  const m = cursor();
  switch (gift.state) {
    case 'falling': {
      const r = fallThing(gift, dt);
      if (r === 'landed') { gift.state = 'lying'; gift.win.setIgnoreMouseEvents(false); }
      else if (r === 'lost') clearGift(null);
      break;
    }
    case 'lying':
      if (!ledgeUnder(gift)) { gift.win.setIgnoreMouseEvents(true); gift.state = 'falling'; gift.vy = 0; }
      break;
    case 'held':
      if (Math.hypot(m.x - gift.start.x, m.y - gift.start.y) > 6) gift.moved = true;
      if (!mouseDown) {
        if (!gift.moved) clearGift('accepted');
        else if (isOverArthur(m) || overHisMiddle(m)) {
          host('giftRefused()');
          const feet = feetOnScreen() || m;
          thingAt(gift, feet.x + (m.x >= feet.x ? 1 : -1) * 150 * Math.max(zoom(), 0.5), m.y);
          gift.win.setIgnoreMouseEvents(true); gift.state = 'falling'; gift.vy = -300;
        } else { gift.win.setIgnoreMouseEvents(true); gift.state = 'falling'; gift.vy = 0; }
      } else if (gift.moved) thingAt(gift, m.x, m.y - 6);
      break;
  }
}
// A press on one of the little windows.
function thingPressed(sender) {
  if (item && item.win.webContents === sender && (item.state === 'lying' || item.state === 'unreachable')) {
    item.state = 'held'; mouseDown = true; mouseDownAt = nowS(); mouseFromPet = false;
  } else if (gift && gift.win.webContents === sender && gift.state === 'lying') {
    gift.state = 'held'; gift.start = cursor(); gift.moved = false; mouseDown = true; mouseDownAt = nowS(); mouseFromPet = false;
  }
}

// ── touched somewhere he isn't used to: hurries off ───────────────────────
function flee(direction) {
  const feet = feetOnScreen();
  if (!isMotion('resting') || !ledge || !feet) return;
  const reach = rand(180, 320) * Math.max(zoom(), 0.5);
  const [l0, h0] = span(ledge);
  const lo = l0 + size.w * 0.25, hi = h0 - size.w * 0.25;
  let dir = direction;
  if ((dir > 0 && feet.x + reach > hi) || (dir < 0 && feet.x - reach < lo)) dir = -dir;
  const target = clamp(feet.x + dir * reach, lo, hi);
  if (Math.abs(target - feet.x) <= 40) return;
  sittingUntil = null;
  walk(dir, () => { if (isMotion('resting')) { setFleeing(true); motion = {kind: 'walking', targetX: target, dir}; } });
}

// ── how she moves him while holding him ───────────────────────────────────
function readDragMotion(now, lift) {
  dragTrail = dragTrail.filter(s => now - s.t <= 3);
  if (dragTrail.length <= 6) return;
  const vels = [];
  let prev = dragTrail[0];
  for (const s of dragTrail.slice(1)) {
    if (s.t - prev.t < 0.05) continue;
    const dt = s.t - prev.t;
    vels.push({t: s.t, dx: (s.p.x - prev.p.x) / dt, dy: (s.p.y - prev.p.y) / dt});
    prev = s;
  }
  if (vels.length <= 3) return;
  const recent = vels.filter(v => now - v.t < 1.5);
  let reversals = 0, lastSign = 0;
  for (const v of recent) if (Math.abs(v.dx) > 500) { const sg = v.dx > 0 ? 1 : -1; if (lastSign && sg !== lastSign) reversals++; lastSign = sg; }
  const a = vels[vels.length - 2], b = vels[vels.length - 1];
  if (Math.hypot(a.dx, a.dy) > 250 && Math.hypot(b.dx, b.dy) > 250) {
    let d = Math.atan2(b.dy, b.dx) - Math.atan2(a.dy, a.dx);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    dragTurn += d;
  } else dragTurn *= 0.9;
  const avgX = recent.length ? recent.reduce((s, v) => s + Math.abs(v.dx), 0) / recent.length : 0;
  const avgY = recent.length ? recent.reduce((s, v) => s + Math.abs(v.dy), 0) / recent.length : 0;
  let kind = null;
  if (Math.abs(dragTurn) > 2 * Math.PI) { kind = 'spin'; dragTurn = 0; }
  else if (reversals >= 3) kind = 'shake';
  else if (lift < 0.15 && avgX > 60 && avgY < 120) kind = 'scrape';
  else if (lift < 0.6 && avgX > 30 && avgX < 350 && avgY < 120 && recent.length >= 6) kind = 'stroll';
  if (!kind || now - (dragMotionSaid[kind] || 0) <= 3.5) return;
  dragMotionSaid[kind] = now;
  host(`dragMotion('${kind}')`);
}
function setDownKind(target, x) {
  const scr = screenUnderFeet();
  if (dragStartLedgeY != null && Math.abs(dragStartLedgeY - target.y) < 4 && Math.abs(x - dragStartX) < 50) return 'same';
  if (x - scr.x < scr.width * 0.1 || scr.x + scr.width - x < scr.width * 0.1) return 'corner';
  return 'floor';
}
function releaseDrag() {
  let vx = 0, vy = 0;
  const first = dragSamples[0], last = dragSamples[dragSamples.length - 1];
  if (first && last && last.t - first.t > 0.012) {
    const sp = last.t - first.t;
    vx = (last.p.x - first.p.x) / sp;
    vy = (last.p.y - first.p.y) / sp;      // y-down: already "downward speed"
  }
  vx = clamp(vx, -2600, 2600); vy = clamp(vy, -2600, 2600);
  flungHard = Math.hypot(vx, vy) > 1100;
  dragSamples = [];
  host(`dropped(${dragMaxLift.toFixed(2)}, ${flungHard}, ${(nowS() - dragStartedAt).toFixed(2)})`);
  startFalling(vx, vy);
}
function land(target, x) {
  if (hopAimY != null && target.y > hopAimY + 3) { noHopsUntil = nowS() + 20; debugLog(`jump fell short (aimed ${Math.round(hopAimY)}, landed ${Math.round(target.y)})`); }
  hopAimY = null;
  dropThroughY = null;
  hopping = false;
  moveFeet({x, y: target.y});
  ledge = target;
  motion = {kind: 'resting'};
  nextSupportCheck = nowS() + 0.8;
  js('window.ArthurHost && ArthurHost.landed()');
  debugLog(`landed at y=${Math.round(target.y)} on ${target.kind}`);
  rememberPosition();
  const fell = target.y - fallPeakY;
  fallPeakY = target.y;
  const floated = supportLost;
  supportLost = false;
  setFloating(false);
  if (floated) { /* drifted down under his umbrella */ }
  else if (splatOnLanding) { splatOnLanding = false; flungHard = false; host("knock('splat')"); }
  else if (fell > bodyHeight() * 2.8) { flungHard = false; host('hardLanding()'); }
  else if (flungHard) { flungHard = false; host('thrown()'); }
  else if (carried) host(`setDown('${setDownKind(target, x)}')`);
  carried = false;
  if (leaveWhenGrounded) { leaveWhenGrounded = false; beginExit(); }
}

// ── sent away, coming back ─────────────────────────────────────────────────
function tellPresence() { host(`present(${!prefs.hidden})`); }
function sendAway(untilMs) {
  pendingAwayUntil = untilMs != null ? untilMs / 1000 : 0;
  sittingUntil = null;
  if (pageSeated) sit(false);
  stopWalking(true);
  if (ledge) beginExit(); else leaveWhenGrounded = true;
}
function beginExit() {
  const scr = screenUnderFeet();
  const fx = (feetOnScreen() || {x: pos.x + size.w / 2}).x;
  const dir = fx > scr.x + scr.width / 2 ? 1 : -1;
  setPref('awaySide', dir);
  js(`window.ArthurHost ? ArthurHost.walk(${dir}) : false`).then(ok => { if (ok === true) motion = {kind: 'leaving', dir}; else finishExit(); });
}
function finishExit() {
  js('window.ArthurHost && ArthurHost.stop()');
  motion = {kind: 'resting'};
  win.hide();
  setPref('hidden', true);
  setPref('awayUntil', pendingAwayUntil != null ? pendingAwayUntil : 0);
  pendingAwayUntil = null;
  tellPresence();
}
function checkAwayReturn() {
  const until = prefs.awayUntil;
  if (until && until > 0 && Date.now() / 1000 >= until) comeBack();
}
function comeBack() {
  setPref('awayUntil', null); setPref('hidden', false);
  leaveWhenGrounded = false;
  tellPresence();
  if (!feetCSS) { win.showInactive(); startFalling(); return; }
  const d = screen.getDisplayNearestPoint({x: Math.round(pos.x + size.w / 2), y: Math.round(pos.y + size.h / 2)});
  const b = d.bounds, floorY = d.workArea.y + d.workArea.height;
  const side = prefs.awaySide >= 0 ? 1 : -1;
  const startX = side > 0 ? b.x + b.width + size.w * 0.5 : b.x - size.w * 0.5;
  moveFeet({x: startX, y: floorY});
  ledge = ledges().find(l => l.minX <= b.x + b.width / 2 && b.x + b.width / 2 <= l.maxX) || null;
  win.showInactive();
  const inward = -side;
  const target = side > 0 ? b.x + b.width - rand(160, 360) * Math.max(zoom(), 0.5) : b.x + rand(160, 360) * Math.max(zoom(), 0.5);
  js(`window.ArthurHost ? ArthurHost.walk(${inward}) : false`).then(ok => {
    if (ok === true) motion = {kind: 'entering', targetX: target, dir: inward};
    else { moveFeet({x: target, y: floorY}); arrivedBack(); }
  });
}
function arrivedBack() {
  js('window.ArthurHost && ArthurHost.stop()');
  motion = {kind: 'resting'};
  rememberPosition();
  startFalling();
  host('returned()');
}

// ── window edges: up, along, and off ───────────────────────────────────────
function hopTo(target, landX) {
  const feet = feetOnScreen();
  if (!feet) return;
  const clearance = 46;
  const up = Math.sqrt(2 * GRAVITY * Math.max(0, feet.y - target.y + clearance));
  const flight = up / GRAVITY + Math.sqrt(2 * clearance / GRAVITY);
  stamina -= 0.08;                       // climbing is tiring
  sittingUntil = null;
  hopping = true;
  hopAimY = target.y;
  startFalling((landX - feet.x) / flight, -up, true);
}
/// A window edge a little above and within reach: up he goes (one step at a time,
/// so windows stacked like stairs get him all the way up).
function climb(from) {
  const feet = feetOnScreen();
  if (tired || nowS() < noHopsUntil || !feet) return false;
  const maxRise = size.h * 0.75, reach = 420 * Math.max(zoom(), 0.5), margin = 36;
  let best = null;
  for (const l of ledges()) {
    if (l.kind !== 'window' || l.maxX - l.minX < margin * 2 + 20) continue;
    const rise = from.y - l.y;
    if (rise <= 30 || rise > maxRise) continue;
    const x = clamp(feet.x, l.minX + margin, l.maxX - margin);
    if (Math.abs(x - feet.x) > reach || !headroom(l, x)) continue;
    if (!best || l.y > best.l.y) best = {l, x};      // the nearest step up, not the tallest leap
  }
  if (!best) return false;
  const aimX = Math.abs(best.x - feet.x) < 12 ? best.x + (best.x < (best.l.minX + best.l.maxX) / 2 ? 14 : -14) : best.x;
  hopTo(best.l, aimX);
  return true;
}
/// Down from where he stands (not only off the ends): a little hop, then through the
/// edge he was on to whatever is below, if he dares that drop. dir leans him that way.
function hopDownHere(dir = 0) {
  const feet = feetOnScreen();
  if (!feet || !hasDropAtEnds(ledge)) return false;
  const below = ledges().filter(o => o.y > ledge.y + 2 && o.minX + 6 <= feet.x && feet.x <= o.maxX - 6).sort((a, b) => a.y - b.y)[0];
  const drop = (below ? below.y : lowestBottom()) - ledge.y;
  const key = `${Math.round(ledge.y)}:mid:${Math.round(feet.x / 120)}`;
  const t = nowS(), prev = edgeDares.get(key);
  let dares;
  if (prev && t < prev.until) dares = prev.dares;
  else {
    const tries = prev && t - prev.until < 30 ? prev.tries + 1 : 0;
    dares = Math.random() < dareChance(drop, tries);
    edgeDares.set(key, {until: t + (dares ? 6 : rand(6, 14)), dares, tries});
    debugLog(`hop down here: drop ${(drop / Math.max(1, bodyHeight())).toFixed(1)} heights, ${dares ? 'jumps' : "won't"} (try ${tries})`);
  }
  if (!dares) return false;
  dropThroughY = ledge.y;
  hopping = false;
  startFalling(dir * 70, -280);
  return true;
}
// Riding the window he's standing on while she drags it about.
function setRide(level) { if (level === rideLevel) return; rideLevel = level; host(`ride(${level})`); }
function rideWindow(now, dt) {
  const standing = isMotion('resting') || isMotion('walking');
  if (!standing || !ledge || ledge.kind !== 'window' || !ledge.id || dt <= 0) { rideFrame = null; rideId = null; setRide(0); return; }
  const r = winwindows.rectOf(ledge.id, screen);
  if (r.state !== 'ok') {
    // Minimised, closed, or on another virtual desktop now: the ground went, not her
    // flinging him. Umbrella up.
    debugLog(`the window under him went (${r.state})`);
    rideFrame = null; rideId = null; setRide(0);
    ledge = null; startFalling(); supportLost = true;
    return;
  }
  const last = rideFrame, sameWindow = rideId === ledge.id;
  rideFrame = r; rideId = ledge.id;
  if (!sameWindow || !last) return;
  // Resized (not just moved): let the support check decide. A pixel or two either way is
  // only DPI rounding while it moves.
  if (Math.abs(last.w - r.w) > 3 || Math.abs(last.h - r.h) > 3) { debugLog(`window under him resized ${Math.round(last.w)}x${Math.round(last.h)} -> ${Math.round(r.w)}x${Math.round(r.h)}`); return; }
  const dx = r.x - last.x, dy = r.y - last.y;
  const speed = Math.hypot(dx, dy) / dt;
  rideSpeed = rideSpeed * 0.7 + speed * 0.3;
  if (dx === 0 && dy === 0) { if (rideLevel > 0 && now - rideStillSince > 0.6) setRide(0); return; }
  rideStillSince = now;
  if (Math.hypot(dx, dy) > 160) {
    // Jumped a long way in one frame (snapped into place, a desktop switch): no hand
    // could drag it that fast. He floats down.
    debugLog('the window under him jumped; floating down');
    setRide(0); ledge = null; startFalling(); supportLost = true;
    return;
  }
  if (speed > 2600) {
    // Yanked out from under him: off he flies, with the window's speed.
    setRide(0);
    pos.x += dx; pos.y += dy; placeWindow();
    ledge = null; startFalling(dx / dt * 0.8, dy / dt * 0.8);
    return;
  }
  if (rideLevel === 0) debugLog(`riding: the window under him moves (${dx.toFixed(1)}, ${dy.toFixed(1)})`);
  pos.x += dx; pos.y += dy; placeWindow();
  ledge = {...ledge, y: r.y, minX: ledge.minX + dx, maxX: ledge.maxX + dx};
  if (isMotion('walking')) stopWalking();
  setRide(rideSpeed > 700 ? 2 : 1);
}

function setEdgeFear(on) { if (on === edgeFearOn) return; edgeFearOn = on; host(`edgeFear(${on})`); }

// ── wandering about ────────────────────────────────────────────────────────
function maybeWander(now) {
  if (item || cornerSeekUntil != null) return;
  if (!prefs.wanders || now < nextWanderAt || !ledge) return;
  if (pageSeated) {
    if (sittingUntil == null || now < sittingUntil) return;
    sit(false);
    nextWanderAt = now + rand(3, 8);
    return;
  }
  if (prefs.climbsWindows && pageCanWander && Math.random() < 0.3 && climb(ledge)) { nextWanderAt = now + rand(4, 10); return; }
  // Up on a window, now and then he hops back down (from the middle, not only the ends).
  if (hasDropAtEnds(ledge) && pageCanWander && Math.random() < 0.12 && hopDownHere(Math.random() < 0.5 ? -1 : 1)) { nextWanderAt = now + rand(6, 14); return; }
  const feet = feetOnScreen();
  const [lo0, hi0] = span(ledge);
  if (pageCanWander && Math.random() < 0.07 && feet) {
    const m = cursor();
    if (m.x > lo0 + 40 && m.x < hi0 - 40 && m.y < feet.y + 40 && feet.y - m.y < size.h * 2.2 && Math.abs(m.x - feet.x) > 80 && now - lastMouseMoveAt < 20) {
      const dir = m.x > feet.x ? 1 : -1;
      const target = m.x - dir * 50 * Math.max(zoom(), 0.5);
      nextWanderAt = now + rand(20, 40);
      walk(dir, () => { if (isMotion('resting')) { visitingCursor = true; motion = {kind: 'walking', targetX: target, dir}; } });
      return;
    }
  }
  if (pageCanSit && Math.random() < 0.2) { nextWanderAt = now + rand(14, 45); sit(true, [45, 200]); return; }
  if (!pageCanWander || !feet) return;
  nextWanderAt = now + rand(14, 45);
  if (Math.random() >= 0.55) return;
  const reach = rand(90, 360) * Math.max(zoom(), 0.5);
  const margin = size.w * 0.25;
  let dir = Math.random() < 0.5 ? 1 : -1;
  let target = feet.x + dir * reach;
  const lo = lo0 + margin, hi = hi0 - margin;
  if (target < lo || target > hi) { dir = -dir; target = feet.x + dir * reach; }
  target = clamp(target, lo, hi);
  if (Math.abs(target - feet.x) <= 30) return;
  walk(dir, () => { if (isMotion('resting')) motion = {kind: 'walking', targetX: target, dir}; });
}

// ── the frame ──────────────────────────────────────────────────────────────
function tick() {
  if (!win || win.isDestroyed()) return;
  const now = nowS();
  const dt = Math.min(now - lastTick, 1 / 20);
  lastTick = now;
  if (now >= nextOutfitCheck) { nextOutfitCheck = now + 1; checkOutfitExpiry(); checkAwayReturn(); }
  if (mouseDown && now - mouseDownAt > 120) mouseDown = false;     // a release we never heard about
  updateStamina(now, dt);
  stepTowardsCorner(now);
  const m = cursor();
  if (Math.hypot(m.x - lastMouse.x, m.y - lastMouse.y) > 1) { lastMouse = m; lastMouseMoveAt = now; }
  if (now >= nextIdleReport) { nextIdleReport = now + 15; host(`idleFor(${Math.round(now - lastMouseMoveAt)})`); }
  updateItem(now, dt);
  updateGift(dt);
  if (!win.isVisible()) return;
  rideWindow(now, dt);

  switch (motion.kind) {
    case 'dragging':
      if (!mouseDown) { releaseDrag(); break; }
      pos.x = m.x - motion.ox; pos.y = m.y - motion.oy; placeWindow();
      {
        const lift = liftNow();
        dragMaxLift = Math.max(dragMaxLift, lift);
        if (now >= nextLiftReport) { nextLiftReport = now + 0.25; host(`lifted(${lift.toFixed(2)}, ${(now - dragStartedAt).toFixed(1)})`); }
        dragSamples.push({t: now, p: m}); dragSamples = dragSamples.filter(s => now - s.t <= 0.1);
        dragTrail.push({t: now, p: m});
        if (now >= nextDragMotionRead) { nextDragMotionRead = now + 0.1; readDragMotion(now, lift); }
      }
      break;
    case 'falling': {
      const feet = feetOnScreen();
      if (!feet) break;
      let {vx, vy} = motion;
      vy += GRAVITY * dt;
      if (supportLost && vy > 240) { vy = 240; setFloating(true); }
      if (!hopping) vx *= Math.max(0, 1 - 0.35 * dt);
      let nextX = feet.x + vx * dt;
      const nextY = feet.y + vy * dt;
      const d = displayAtX(feet.x), b = d.bounds;
      const margin = size.w * 0.22;
      const neighbourLeft = displays().some(o => o !== d && o.bounds.x + o.bounds.width >= b.x - 1 && o.bounds.x < b.x);
      const neighbourRight = displays().some(o => o !== d && o.bounds.x <= b.x + b.width + 1 && o.bounds.x + o.bounds.width > b.x + b.width);
      if (nextX < b.x + margin && vx < 0 && !neighbourLeft) { bonk(Math.abs(vx)); nextX = b.x + margin; vx = -vx * 0.45; }
      else if (nextX > b.x + b.width - margin && vx > 0 && !neighbourRight) { bonk(Math.abs(vx)); nextX = b.x + b.width - margin; vx = -vx * 0.45; }
      const rects = screenRects();
      const headTop = rects.length ? Math.min(...rects.map(r => r.y)) : feet.y - size.h * 0.6;
      const ceiling = d.workArea.y;
      if (vy < 0 && headTop + vy * dt < ceiling) { bonk(-vy); vy = 0; }
      fallPeakY = Math.min(fallPeakY, feet.y);
      let target = vy > 0 ? ledgeBelow(feet.y, nextX) : null;
      if (target && dropThroughY != null && Math.abs(target.y - dropThroughY) < 3) target = ledgeBelow(dropThroughY + 4, nextX);
      if (target && nextY >= target.y) land(target, nextX);
      else if (nextY > lowestBottom() + 200) { setPref('anchor', null); applyScale(); }
      else { pos.x += nextX - feet.x; pos.y += vy * dt; placeWindow(); motion = {kind: 'falling', vx, vy}; }
      break;
    }
    case 'leaving': {
      pos.x += WALK_SPEED * 2.2 * zoom() * dt * motion.dir; placeWindow();
      const scr = screenUnderFeet();
      const f = feetOnScreen();
      const gone = motion.dir > 0 ? pos.x > scr.x + scr.width - size.w * 0.1 : pos.x + size.w < scr.x + size.w * 0.1;
      if (gone || (f && (f.x > scr.x + scr.width + 40 || f.x < scr.x - 40))) finishExit();
      break;
    }
    case 'entering': {
      const f = feetOnScreen();
      if (!f) { arrivedBack(); break; }
      const step = WALK_SPEED * 2.2 * zoom() * dt * motion.dir;
      if ((motion.dir > 0 && f.x + step >= motion.targetX) || (motion.dir < 0 && f.x + step <= motion.targetX)) arrivedBack();
      else { pos.x += step; placeWindow(); }
      break;
    }
    case 'walking': {
      const f = feetOnScreen();
      if (!f || !ledge) { stopWalking(); break; }
      const step = WALK_SPEED * zoom() * dt * motion.dir * (fleeing ? (tired ? 1.4 : 3.2) : 1);
      const x = f.x + step;
      if ((motion.dir > 0 && x >= motion.targetX) || (motion.dir < 0 && x <= motion.targetX) || !pageCanWander) { stopWalking(); break; }
      if (x < ledge.minX + 4 || x > ledge.maxX - 4) {
        const l = ledge, dir = motion.dir;
        const next = ledges().find(o => Math.abs(o.y - l.y) < 3 && o.minX !== l.minX &&
          (dir > 0 ? (o.minX <= l.maxX + 14 && o.maxX > l.maxX + 10) : (o.maxX >= l.minX - 14 && o.minX < l.minX - 10)));
        if (next) { ledge = next; pos.x += step; placeWindow(); }
        else if (hasDropAtEnds(l) && !tooHighToDrop(l, x)) {
          // Step right off the end, then drop with a little outward speed (straight down
          // from a step short of the edge would land him on the same window again).
          js('window.ArthurHost && ArthurHost.stop()');
          setFleeing(false);
          pos.x += (dir > 0 ? l.maxX + 4 : l.minX - 4) - f.x; placeWindow();
          startFalling(dir * 90, 0);
        } else {
          js('window.ArthurHost && ArthurHost.stop()'); motion = {kind: 'resting'}; setFleeing(false); rememberPosition();
          if (hasDropAtEnds(l)) {
            // Peered over, decided against it: a frown, and later he wanders back.
            peekUntil = now + rand(1.5, 3);
            nextWanderAt = Math.max(nextWanderAt, now + rand(3, 7));
          }
        }
      } else { pos.x += step; placeWindow(); }
      break;
    }
    case 'resting': {
      const f = feetOnScreen();
      // (While the window under him is moving, the ride keeps him on it; the ledge list
      // is a tenth of a second stale and would say he'd lost it.)
      if (now >= nextSupportCheck && f && !(ledge && ledge.kind === 'window' && rideId === ledge.id && now - rideStillSince < 1)) {
        nextSupportCheck = now + 0.7;
        // The window under him moved, shrank, was minimised or closed (or the taskbar
        // moved): down he goes. At the very end of an edge his feet sit a hair past it.
        const still = ledge && ledges().find(o => o.kind === ledge.kind && Math.abs(o.y - ledge.y) < 2 &&
          o.minX - 14 <= f.x && f.x <= o.maxX + 14 && Math.abs(f.y - o.y) <= 3);
        if (still) ledge = still;
        else {
          debugLog(`support check: nothing under him at (${Math.round(f.x)}, ${Math.round(f.y)})`);
          const t = ledgeBelow(f.y - 2, f.x);
          if (t) { if (t.y - f.y > 3) { startFalling(); supportLost = true; } else ledge = t; }
          else { startFalling(); supportLost = true; }
        }
      }
      maybeWander(now);
      break;
    }
  }
  setEdgeFear(isMotion('resting') && now < peekUntil);
  updateHitTesting(m);
  forwardPointer(m, now);
}

function setIgnore(on) {
  if (on === ignoring || !win) return;
  ignoring = on;
  win.setIgnoreMouseEvents(on);
}
function updateHitTesting(m) {
  const over = isOverArthur(m);
  // While the button is held from a press on him (carrying him, pulling his things
  // away) the window must keep the mouse, or the release goes somewhere else.
  const holding = mouseDown && mouseFromPet;
  setIgnore(prefs.clickThrough || !(over || isMotion('dragging') || holding));
  const target = prefs.clickThrough && over ? Math.min(HOVER_FADE, prefs.opacity) : prefs.opacity;
  if (shownOpacity !== target) { shownOpacity = target; win.setOpacity(target); }
}
/// The page can't see the mouse while it passes through: tell it, so his eyes follow.
function forwardPointer(m, now) {
  if (!ignoring || prefs.clickThrough) return;
  const pad = 120 * zoom();
  const near = m.x >= pos.x - pad && m.x <= pos.x + size.w + pad && m.y >= pos.y - pad && m.y <= pos.y + size.h + pad;
  if (!near) { if (lastPointerSent) { lastPointerSent = null; js('window.ArthurHost && ArthurHost.leave()'); } return; }
  if (now - lastPointerAt <= 0.08) return;
  const css = {x: (m.x - pos.x) / zoom(), y: (m.y - pos.y) / zoom()};
  if (lastPointerSent && Math.abs(lastPointerSent.x - css.x) < 2 && Math.abs(lastPointerSent.y - css.y) < 2) return;
  lastPointerSent = css; lastPointerAt = now;
  js(`window.ArthurHost && ArthurHost.pointer(${Math.round(css.x)},${Math.round(css.y)})`);
}

// ── looks ──────────────────────────────────────────────────────────────────
function wear(mode, untilMs) {
  if (!OUTFITS.some(o => o[1] === mode)) return;
  setPref('outfit', mode);
  setPref('outfitUntil', mode === 'auto' || untilMs == null ? null : untilMs / 1000);
}
function checkOutfitExpiry() {
  const until = prefs.outfitUntil;
  if (until == null || Date.now() / 1000 < until) return;
  setPref('outfit', 'auto'); setPref('outfitUntil', null);
  applyLooks();
  host('outfitExpired()');
}
function applyLooks() {
  const until = prefs.outfitUntil != null ? String(Math.round(prefs.outfitUntil * 1000)) : 'null';
  js(`window.ArthurHost && ArthurHost.outfit(${JSON.stringify(prefs.outfit)}, ${until})`);
  host(`letterRead(${JSON.stringify(prefs.letterRead)})`);
  host(`touchCount(${Number(prefs.touchCount) || 0})`);
  host(`patCount(${Number(prefs.patCount) || 0})`);
  host(`kv(${JSON.stringify(prefs.pageKV)})`);
  host(`pockets(${JSON.stringify(prefs.pockets)})`);
  tellPresence();
  js(`window.ArthurHost && ArthurHost.glasses(${JSON.stringify(prefs.glasses)})`);
}
function greetIfFirstToday(attempt = 0) {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (prefs.lastGreetDay === today || !win.isVisible() || prefs.awayUntil != null) return;
  js("window.ArthurHost && ArthurHost.greet ? ArthurHost.greet() : 'not-ready'").then(r => {
    if (r === true) setPref('lastGreetDay', today);
    else if (attempt < 4) setTimeout(() => greetIfFirstToday(attempt + 1), 4000);
  });
}

// ── tray menu ──────────────────────────────────────────────────────────────
function trayIcon() {
  // A small paw print, drawn by hand (no image files to ship).
  const S = 32, buf = Buffer.alloc(S * S * 4);
  const blobs = [[16, 21, 7.5, 6.5], [8, 12, 3.4, 4.2], [13.5, 7.5, 3.4, 4.2], [18.5, 7.5, 3.4, 4.2], [24, 12, 3.4, 4.2]];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let a = 0;
    for (const [cx, cy, rx, ry] of blobs) { const d = Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry); a = Math.max(a, clamp((1 - d) * rx, 0, 1)); }
    const i = (y * S + x) * 4;
    buf[i] = 0x3a; buf[i + 1] = 0x2a; buf[i + 2] = 0x1f; buf[i + 3] = Math.round(a * 255);   // BGRA, a navy-brown
  }
  return nativeImage.createFromBitmap(buf, {width: S, height: S, scaleFactor: 2});
}
function buildMenu() {
  const t = [];
  if (prefs.awayUntil != null) {
    const until = prefs.awayUntil;
    const hm = until > 0 ? new Date(until * 1000).toTimeString().slice(0, 5) : '';
    t.push({label: until > 0 ? `他走开了，${hm} 回来` : '他走开了，等你叫他回来', enabled: false});
  }
  t.push({label: win.isVisible() ? '隐藏 Arthur' : (prefs.awayUntil != null ? '叫他回来' : '显示 Arthur'), accelerator: 'CommandOrControl+Alt+A', click: toggleVisible});
  t.push({label: '完全穿透（连他身上也点不到）', type: 'checkbox', checked: !!prefs.clickThrough, accelerator: 'CommandOrControl+Alt+P', click: toggleClickThrough});
  t.push({label: '总在最前面', type: 'checkbox', checked: !!prefs.alwaysOnTop, click: () => { setPref('alwaysOnTop', !prefs.alwaysOnTop); applyLevel(); }});
  t.push({label: '自己到处走', type: 'checkbox', checked: !!prefs.wanders, click: () => { setPref('wanders', !prefs.wanders); if (!prefs.wanders) stopWalking(); }});
  t.push({label: pageSeated ? '让他站起来' : '让他坐下', enabled: pageSeated || pageCanSit, click: () => { stopWalking(); sit(!pageSeated); nextWanderAt = nowS() + 30; }});
  t.push({type: 'separator'}, {label: '大小', enabled: false});
  for (const [label, v] of SCALES) t.push({label: '   ' + label, type: 'radio', checked: Math.abs(prefs.scale - v) < 0.01, click: () => { stopWalking(); rememberPosition(); setPref('scale', v); applyScale(); }});
  t.push({label: '衣服（在“戳一下”里给他换）', enabled: false});
  if (prefs.outfit !== 'auto') {
    const name = (OUTFITS.find(o => o[1] === prefs.outfit) || [prefs.outfit])[0];
    let line = `现在穿着：${name}`;
    if (prefs.outfitUntil != null) { const d = new Date(prefs.outfitUntil * 1000); line += `，到 ${d.getMonth() + 1}月${d.getDate()}日 ${d.toTimeString().slice(0, 5)}`; }
    else line += '，没有期限';
    t.push({label: '   ' + line, enabled: false});
    t.push({label: '   恢复自动（让他自己挑）', click: () => { setPref('outfit', 'auto'); setPref('outfitUntil', null); applyLooks(); }});
  } else t.push({label: '   自动：出门穿他自己挑的，在家睡衣', enabled: false});
  t.push({label: '眼镜', enabled: false});
  for (const [label, v] of GLASSES) t.push({label: '   ' + label, type: 'radio', checked: prefs.glasses === v, click: () => { setPref('glasses', v); js(`window.ArthurHost && ArthurHost.glasses(${JSON.stringify(v)})`); }});
  t.push({label: '透明度', enabled: false});
  for (const [label, v] of OPACITIES) t.push({label: '   ' + label, type: 'radio', checked: Math.abs(prefs.opacity - v) < 0.01, click: () => { setPref('opacity', v); shownOpacity = null; }});
  t.push({type: 'separator'});
  t.push({label: '开机自动启动', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: item => app.setLoginItemSettings({openAtLogin: item.checked})});
  t.push({label: '放回右下角', click: () => { stopWalking(); setPref('anchor', null); applyScale(); showCompanion(); }});
  t.push({label: '重新读取状态', click: () => { loadCompanion(); showCompanion(); }});
  t.push({type: 'separator'}, {label: '退出桌宠', click: () => app.quit()});
  return Menu.buildFromTemplate(t);
}
function makeTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Arthur 桌宠');
  const pop = () => tray.popUpContextMenu(buildMenu());
  tray.on('click', pop);
  tray.on('right-click', pop);
}
function applyLevel() { win.setAlwaysOnTop(!!prefs.alwaysOnTop, 'screen-saver'); }
function toggleVisible() { win.isVisible() ? hideCompanion() : showCompanion(); }
function showCompanion() {
  if (prefs.awayUntil != null) { comeBack(); return; }
  setPref('hidden', false);
  win.showInactive();
  startFalling();
  tellPresence();
}
function hideCompanion() {
  setPref('awayUntil', null); setPref('hidden', true);
  stopWalking();
  win.hide();
  tellPresence();
}
function toggleClickThrough() { setPref('clickThrough', !prefs.clickThrough); shownOpacity = null; if (!win.isVisible()) showCompanion(); }

// ── page ───────────────────────────────────────────────────────────────────
function loadCompanion() {
  hitRects = []; feetCSS = null; settledOnce = false;
  win.loadURL(`http://127.0.0.1:${port}/?pet=1`);   // pet-only page: no server status
}
function makeWindow() {
  win = new BrowserWindow({
    width: size.w, height: size.h, frame: false, transparent: true, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, show: false, backgroundColor: '#00000000',
    title: 'Arthur Desktop Companion',
    webPreferences: {preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false, spellcheck: false}
  });
  win.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true});
  setIgnore(true);
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(prefs.scale);
    setTimeout(greetIfFirstToday, 3000);
    for (const d of [500, 1500, 4000]) setTimeout(applyLooks, d);
  });
  win.webContents.on('did-fail-load', () => setTimeout(loadCompanion, 2000));
  win.webContents.on('render-process-gone', () => setTimeout(loadCompanion, 2000));
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`http://127.0.0.1:${port}/`)) e.preventDefault(); });
  const occluded = on => host(`occluded(${on})`);
  win.on('hide', () => occluded(true));
  win.on('show', () => occluded(false));
  powerMonitor.on('lock-screen', () => occluded(true));
  powerMonitor.on('suspend', () => occluded(true));
  const opened = () => { occluded(false); setTimeout(greetIfFirstToday, 2500); };
  powerMonitor.on('unlock-screen', opened);
  powerMonitor.on('resume', opened);
}

// A pretend mouse for testing on a machine nobody is sitting at: press on his
// chest, carry him up, and fling him (or just set him down).
async function debugScript(kind) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (kind === 'climbonce') {
    // Up onto a window and stay there (for riding tests).
    for (let i = 0; i < 10; i++) {
      await sleep(1500);
      if (isMotion('resting') && ledge && ledge.kind === 'window') { console.log('script: on a window, staying'); nextWanderAt = nowS() + 600; return; }
      if (isMotion('resting') && ledge) console.log('script: climb ->', climb(ledge));
    }
    return;
  }
  if (kind === 'climb') {
    // Up onto the nearest window he can reach, along it, and back down: every few seconds.
    for (let round = 0; round < 12; round++) {
      await sleep(3500);
      if (!isMotion('resting') || !ledge) { console.log('script: busy', motion.kind); continue; }
      if (ledge.kind === 'floor') console.log('script: climb ->', climb(ledge));
      else if (round % 3 === 2) console.log('script: hop down here ->', hopDownHere(1));
      else {
        const [lo, hi] = span(ledge), f = feetOnScreen(), dir = f.x - lo < hi - f.x ? -1 : 1;
        console.log('script: walk to the', dir < 0 ? 'left' : 'right', 'end');
        walk(dir, () => { motion = {kind: 'walking', targetX: dir < 0 ? lo - 60 : hi + 60, dir}; });
      }
    }
    return;
  }
  if (kind === 'steal') {
    const f = feetOnScreen();
    fakeCursor = {x: f.x - 60, y: f.y - 120};
    await win.webContents.executeJavaScript("window.webkit.messageHandlers.arthurHost.postMessage({type:'steal-start', icon:'📕', id:'x', name:'书'})");
    for (let i = 0; i < 40; i++) { fakeCursor.x -= 10; await sleep(30); }
    console.log('script: dropping item at', fakeCursor.x);
    mouseDown = false;
    await sleep(500); fakeCursor = null;
    for (let i = 0; i < 30 && item; i++) await sleep(500);
    console.log('script: item now', item ? item.state : 'gone (back with him)');
    await win.webContents.executeJavaScript("window.webkit.messageHandlers.arthurHost.postMessage({type:'gift-drop', icon:'🌹'})");
    for (let i = 0; i < 20 && gift && gift.state !== 'lying'; i++) await sleep(200);
    console.log('script: gift', gift && gift.state, gift && thingFoot(gift));
    fakeCursor = {x: gift.x + gift.size / 2, y: gift.y + gift.size / 2};
    thingPressed(gift.win.webContents); await sleep(200); mouseDown = false; await sleep(200);
    console.log('script: gift after click', gift ? gift.state : 'taken');
    fakeCursor = null;
    return;
  }
  const rects = screenRects().sort((a, b) => b.w * b.h - a.w * a.h);
  const r = rects[0];
  fakeCursor = {x: r.x + r.w / 2, y: r.y + r.h * 0.55};
  const send = (type, extra = {}) => win.webContents.sendInputEvent(Object.assign({type, x: Math.round(fakeCursor.x - pos.x), y: Math.round(fakeCursor.y - pos.y), button: 'left', clickCount: 1}, extra));
  setIgnore(false);
  console.log('script: press at', fakeCursor);
  send('mouseMove'); await sleep(100);
  send('mouseDown'); await sleep(120);
  const path = kind === 'fling' ? {dx: 900, dy: -420, ms: 500} : {dx: -300, dy: -250, ms: 1500};
  const steps = Math.round(path.ms / 16);
  for (let i = 0; i < steps; i++) {
    fakeCursor.x += path.dx / steps; fakeCursor.y += path.dy / steps;
    send('mouseMove'); await sleep(16);
  }
  if (kind !== 'fling') await sleep(1500);
  send('mouseUp');
  console.log('script: released, motion', motion.kind);
  await sleep(300);
  fakeCursor = null;
}

ipcMain.on('host', (e, body) => { if (win && e.sender === win.webContents) onHostMessage(body); });
ipcMain.on('mouse', (e, down) => {
  if (down) {
    mouseDown = true; mouseDownAt = nowS();
    mouseFromPet = !!(win && e.sender === win.webContents);
    if (!mouseFromPet) thingPressed(e.sender);
  } else mouseDown = false;
});
ipcMain.on('file-hover', (e, on) => { if (win && e.sender === win.webContents) host(`fileHover(${!!on})`); });
ipcMain.on('file-drop', (e, f) => {
  if (!win || e.sender !== win.webContents || !f) return;
  js(`window.ArthurHost && ArthurHost.fileGiven && ArthurHost.fileGiven(${JSON.stringify(String(f.name).slice(0, 200))}, ${!!f.dir}, ${Number(f.count) || 1})`);
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showCompanion());
  app.whenReady().then(async () => {
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
    loadPrefs();
    if (!prefs.autoStartSet) { setPref('autoStartSet', true); if (app.isPackaged) app.setLoginItemSettings({openAtLogin: true}); }
    await startServer();
    size = {w: Math.round(BASE.w * prefs.scale), h: Math.round(BASE.h * prefs.scale)};
    makeWindow();
    makeTray();
    applyScale();
    applyLevel();
    loadCompanion();
    if (!prefs.hidden) win.showInactive();
    globalShortcut.register('CommandOrControl+Alt+A', toggleVisible);
    globalShortcut.register('CommandOrControl+Alt+P', toggleClickThrough);
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, () => applyScale());
    setInterval(tick, 1000 / 60);
    if (process.env.ARTHUR_DEBUG_SCRIPT) setTimeout(() => debugScript(process.env.ARTHUR_DEBUG_SCRIPT), 6000);
    if (process.env.ARTHUR_DEBUG_SHOT) setInterval(() => win.webContents.capturePage().then(img => fs.writeFileSync(process.env.ARTHUR_DEBUG_SHOT, img.toPNG())), 3000);
    if (process.env.ARTHUR_DEBUG) setInterval(() => {
      const err = winwindows.loadError();
      const ws = winwindows.windows(screen);
      console.log('windows', JSON.stringify({err, n: ws.length, list: ws.slice(0, 12).map(w => [w.cls, (w.title || '').slice(0, 20), Math.round(w.x), Math.round(w.y), Math.round(w.w), Math.round(w.h), w.maximized ? 'max' : ''])}));
      console.log('ledges', JSON.stringify(ledges().map(l => [l.kind, Math.round(l.y), Math.round(l.minX), Math.round(l.maxX)])));
    }, 4000);
    if (process.env.ARTHUR_DEBUG) setInterval(() => console.log('debug', JSON.stringify({motion: motion.kind, pos: [Math.round(pos.x), Math.round(pos.y)], size, feet: feetOnScreen(), ledge, hits: hitRects.length, ignoring, visible: win.isVisible(), port, item: item && item.state, gift: gift && gift.state})), 2000);
  });
  app.on('window-all-closed', () => { /* he lives in the tray */ });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
