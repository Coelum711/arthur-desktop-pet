// Copy the page (shared with the Mac app) into windows/web for packaging.
'use strict';
const fs = require('fs'), path = require('path');
const from = path.join(__dirname, '..', '..', 'desktop_companion', 'web');
const to = path.join(__dirname, '..', 'web');
fs.cpSync(from, to, {recursive: true, force: true, filter: src => !/(_test_live\.json|test_[^/]*\.js|\.DS_Store)$/.test(src)});
console.log('copied', from, '->', to);
