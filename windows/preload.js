// The bridge the page already knows from the Mac app (window.webkit.messageHandlers.arthurHost),
// plus the few things the Mac app could see natively and Electron can't: whether the
// left button is down, and files dragged onto him (name and folder-or-not only).
'use strict';
const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('webkit', {
  messageHandlers: {arthurHost: {postMessage: message => ipcRenderer.send('host', message)}}
});

const button = (down, e) => { if (e.button === 0 || e.type === 'pointercancel') ipcRenderer.send('mouse', down); };
window.addEventListener('pointerdown', e => button(true, e), true);
window.addEventListener('pointerup', e => button(false, e), true);
window.addEventListener('pointercancel', e => button(false, e), true);
window.addEventListener('mouseup', e => button(false, e), true);

const hasFiles = e => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
let hovering = false;
const hover = on => { if (on !== hovering) { hovering = on; ipcRenderer.send('file-hover', on); } };
window.addEventListener('dragenter', e => { if (hasFiles(e)) { e.preventDefault(); hover(true); } }, true);
window.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }, true);
window.addEventListener('dragleave', e => { if (!e.relatedTarget) hover(false); }, true);
window.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  hover(false);
  const files = Array.from(e.dataTransfer.files || []);
  if (!files.length) return;
  const item = e.dataTransfer.items && e.dataTransfer.items[0];
  const entry = item && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
  ipcRenderer.send('file-drop', {name: String(files[0].name || ''), dir: !!(entry && entry.isDirectory), count: files.length});
}, true);
