// Other apps' windows, front to back, in Electron's DIP coordinates (y down).
// On Windows this asks user32/dwmapi through koffi; elsewhere it returns nothing,
// unless ARTHUR_FAKE_WINDOWS points at a JSON file of rects (for testing on a Mac).
//
// Skipped: invisible, minimised, cloaked (other virtual desktops, suspended store
// apps, hidden shell bits), tool windows, click-through overlays, the desktop and
// taskbar, and anything belonging to this process (Arthur and his little windows).
'use strict';
const fs = require('fs');

const SKIP_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd',
  'Windows.UI.Core.CoreWindow', 'NotifyIconOverflowWindow', 'TopLevelWindowForOverflowXamlIsland',
  'XamlExplorerHostIslandWindow', 'ForegroundStaging', 'MultitaskingViewFrame']);
const GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80, WS_EX_TRANSPARENT = 0x20, WS_EX_NOACTIVATE = 0x08000000;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;

let api = null, loadError = null;
function load() {
  if (api || loadError) return api;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const dwm = koffi.load('dwmapi.dll');
    const HWND = koffi.pointer('HWND', koffi.opaque());
    const RECT = koffi.struct('RECT', {left: 'long', top: 'long', right: 'long', bottom: 'long'});
    const EnumProc = koffi.proto('bool __stdcall EnumWindowsProc(HWND hwnd, intptr_t lParam)');
    api = {
      koffi, EnumProc,
      EnumWindows: user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(HWND hwnd)'),
      IsWindow: user32.func('bool __stdcall IsWindow(HWND hwnd)'),
      IsIconic: user32.func('bool __stdcall IsIconic(HWND hwnd)'),
      IsZoomed: user32.func('bool __stdcall IsZoomed(HWND hwnd)'),
      GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(HWND hwnd, int index)'),
      GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(HWND hwnd, _Out_ uint32_t *pid)'),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(HWND hwnd, _Out_ RECT *rect)'),
      GetClassNameW: user32.func('int __stdcall GetClassNameW(HWND hwnd, _Out_ uint16_t *name, int max)'),
      GetWindowTextW: user32.func('int __stdcall GetWindowTextW(HWND hwnd, _Out_ uint16_t *text, int max)'),
      DwmRect: dwm.func('long __stdcall DwmGetWindowAttribute(HWND hwnd, uint32_t attr, _Out_ RECT *value, uint32_t size)'),
      DwmInt: dwm.func('long __stdcall DwmGetWindowAttribute(HWND hwnd, uint32_t attr, _Out_ int *value, uint32_t size)'),
    };
  } catch (e) { loadError = e; api = null; }
  return api;
}

const text = (fn, hwnd) => { const buf = new Uint16Array(256); const n = fn(hwnd, buf, 256); return n > 0 ? String.fromCharCode(...buf.subarray(0, n)) : ''; };

const handles = new Map();     // id -> HWND from the last full listing (for quick rect lookups)

/// [{x, y, w, h, id, title, maximized}] front to back, in screen pixels (physical).
function rawWindows() {
  const a = load();
  if (!a) return [];
  const list = [];
  handles.clear();
  const cb = a.koffi.register((hwnd) => {
    try {
      if (!a.IsWindowVisible(hwnd) || a.IsIconic(hwnd)) return true;
      const ex = Number(a.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
      if (ex & (WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE)) return true;
      const pid = [0];
      a.GetWindowThreadProcessId(hwnd, pid);
      if (pid[0] === process.pid) return true;
      const cls = text(a.GetClassNameW, hwnd);
      if (SKIP_CLASSES.has(cls)) return true;
      const cloaked = [0];
      if (a.DwmInt(hwnd, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked[0]) return true;
      const r = {};
      // The visible frame, without Windows 10/11's invisible resize border.
      if (a.DwmRect(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, r, 16) !== 0 && !a.GetWindowRect(hwnd, r)) return true;
      const w = r.right - r.left, h = r.bottom - r.top;
      if (w < 1 || h < 1) return true;
      const id = a.koffi.address(hwnd).toString();
      handles.set(id, hwnd);
      list.push({x: r.left, y: r.top, w, h, id, cls, title: text(a.GetWindowTextW, hwnd), maximized: !!a.IsZoomed(hwnd)});
    } catch (_) { /* one odd window shouldn't stop the rest */ }
    return true;
  }, a.koffi.pointer(a.EnumProc));
  try { a.EnumWindows(cb, 0); } finally { a.koffi.unregister(cb); }
  return list;
}

let fakeCache = null, fakeAt = 0;
function fakeWindows() {
  const file = process.env.ARTHUR_FAKE_WINDOWS;
  if (!file) return [];
  const now = Date.now();
  if (fakeCache && now - fakeAt < 300) return fakeCache;
  try { fakeCache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { fakeCache = []; }
  fakeAt = now;
  return fakeCache;
}

/// Windows in DIP (what Electron's screen and BrowserWindow use), front to back.
function windows(screen) {
  if (process.platform !== 'win32') return fakeWindows();
  return rawWindows().map(w => {
    const d = screen && screen.screenToDipRect ? screen.screenToDipRect(null, {x: w.x, y: w.y, width: w.w, height: w.h}) : {x: w.x, y: w.y, width: w.w, height: w.h};
    return {x: d.x, y: d.y, w: d.width, h: d.height, id: w.id, cls: w.cls, title: w.title, maximized: w.maximized};
  });
}

/// Just one window, by the id a listing gave it: {state:'ok', x, y, w, h} in DIP, or
/// {state:'hidden'} (minimised, cloaked: another virtual desktop) or {state:'gone'}.
function rectOf(id, screen) {
  if (process.platform !== 'win32') {
    const w = fakeWindows().find(o => String(o.id) === String(id));
    return w ? (w.hidden ? {state: 'hidden'} : {state: 'ok', x: w.x, y: w.y, w: w.w, h: w.h}) : {state: 'gone'};
  }
  const a = load(), hwnd = handles.get(String(id));
  if (!a || !hwnd || !a.IsWindow(hwnd)) return {state: 'gone'};
  if (!a.IsWindowVisible(hwnd) || a.IsIconic(hwnd)) return {state: 'hidden'};
  const cloaked = [0];
  if (a.DwmInt(hwnd, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked[0]) return {state: 'hidden'};
  const r = {};
  if (a.DwmRect(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, r, 16) !== 0 && !a.GetWindowRect(hwnd, r)) return {state: 'gone'};
  const d = screen && screen.screenToDipRect ? screen.screenToDipRect(null, {x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top})
    : {x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top};
  return {state: 'ok', x: d.x, y: d.y, w: d.width, h: d.height};
}

module.exports = {windows, rectOf, loadError: () => loadError && String(loadError.message || loadError)};
