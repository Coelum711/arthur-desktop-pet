#!/usr/bin/env node
'use strict';

const assert = require('assert');
require('./arthur-local-poke-menu-v1.js');
require('./live-client.js');

const now = Date.parse('2026-08-13T12:00:00Z');
const preview = {
  schema_version:'arthur.companion-local-preview/1',
  observed_at:'2026-08-13T11:59:59Z',
  host:'mac',
  mode:'legacy-generation-zero',
  writers:{state:'ACTIVE'},
  arthur:{
    availability:'awake',
    place:'home',
    pose:'reading',
    activity:{
      key:'reading',
      type:'home',
      resources:{hands:'both',mobility:'stationary',body_locked:false}
    }
  },
  maintenance:{health:'healthy'},
  can_drive_visual:true,
  can_propose:false
};

const accepted = globalThis.ArthurLiveStatusClient.validatePreview(preview, now);
assert(accepted);
assert.strictEqual(accepted.can_propose, false);

const extra = JSON.parse(JSON.stringify(preview));
extra.private_activity = 'must never be accepted';
assert.strictEqual(globalThis.ArthurLiveStatusClient.validatePreview(extra, now), null);

const authority = JSON.parse(JSON.stringify(preview));
authority.can_propose = true;
assert.strictEqual(globalThis.ArthurLiveStatusClient.validatePreview(authority, now), null);

const stale = JSON.parse(JSON.stringify(preview));
stale.observed_at = '2026-08-13T11:00:00Z';
assert.strictEqual(globalThis.ArthurLiveStatusClient.validatePreview(stale, now), null);

const calls = [];
const runtime = {
  state:'awake',
  setProjectedActivity(...args) { calls.push(['activity', ...args]); },
  stopDesktopMotion() { calls.push(['stop']); },
  setOutfit(value) { calls.push(['outfit', value]); },
  setLifeState(value) { this.state = value; calls.push(['life', value]); },
  playGuitar(value) { calls.push(['guitar', value]); }
};
globalThis.ArthurLiveStatusClient.applyPreview(runtime, accepted);
assert(calls.some(call => call[0] === 'life' && call[1] === 'reading'));
assert(calls.some(call => call[0] === 'activity' && call[1] === 'reading'));

const vps = globalThis.ArthurLiveStatusClient.labelFor({
  applied:true,
  host:'vps',
  health:'healthy',
  arthur:{activity:{key:'tea'}}
}, null);
assert.strictEqual(vps.text, 'VPS · 喝茶');
assert.strictEqual(vps.className, 'vps');

const previewAnswer = globalThis.ArthurLocalPokeMenu.answerFor('activity', {
  status:accepted,
  snapshot:{state:'awake',desktop:{motion:'guitar'}}
});
assert.ok(['在读东西。你这一戳正好把我打断了。', '在看书。……你也该看看。', '读书呢。这章刚到精彩的地方。'].includes(previewAnswer.text), previewAnswer.text);
assert.strictEqual(previewAnswer.source, 'Mac 本机只读预览');
assert.strictEqual(previewAnswer.remote, false);

console.log('desktop companion live client tests passed');
