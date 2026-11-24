'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const {ScheduleLife, statusDocument, ACTIVITIES} = require('../life');

function seeded(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arthur-life-')), 'life.json');

test('a fortnight of documents: asleep, at home and out all appear', () => {
  const life = new ScheduleLife(tmp(), seeded(3));
  let t = new Date(2026, 10, 23, 8, 0).getTime();
  const seen = new Set();
  for (let i = 0; i < 14 * 48; i++) {
    t += 30 * 60 * 1000;
    const a = statusDocument(life, new Date(t)).arthur;
    assert.match(a.availability, /^(awake|sleeping)$/);
    seen.add(a.availability + '/' + a.place);
  }
  assert.ok(seen.has('sleeping/unknown') && seen.has('awake/home') && seen.has('awake/outdoors'), [...seen].join(' '));
});

test('asleep at 3 am, never in bed at 11', () => {
  const life = new ScheduleLife(tmp(), seeded(5));
  let t = new Date(2026, 10, 23, 8, 0).getTime(), night = 0, day = 0;
  for (let i = 0; i < 10 * 96; i++) {
    t += 15 * 60 * 1000;
    const d = new Date(t), asleep = statusDocument(life, d).arthur.availability === 'sleeping';
    if (d.getHours() === 3) night += asleep;
    if (d.getHours() === 11) day += asleep;
  }
  assert.ok(night > 30, `night ${night}`);
  assert.strictEqual(day, 0);
});

test('his day carries on across restarts', () => {
  const file = tmp(), t = new Date(2026, 10, 23, 10, 0);
  const a = new ScheduleLife(file, seeded(1));
  a.advance(t); a.advance(new Date(t.getTime() + 3 * 3600e3));
  const b = new ScheduleLife(file, seeded(1));
  assert.strictEqual(b.state.last_run_ts, a.state.last_run_ts);
  assert.strictEqual(b.state.activity, a.state.activity);
});

test('every activity has a known kind', () => {
  for (const [name, act] of Object.entries(ACTIVITIES)) assert.ok(act.type && act.runs[0] >= 1, name);
});
