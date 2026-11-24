// Arthur's mechanical day (a port of desktop_companion/schedule_life.py) and
// the companion-status document the page reads (what standalone.py serves).
// No language model, no decisions of his own: weighted draws every ~45 min.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RUN_MINUTES = 45;
const MAX_CATCH_UP_RUNS = 64;

// type: as the status mapping knows it; runs: [min, max]; cost: energy per run.
const ACTIVITIES = {
  reading:   {type:'reading',  text:'reading a book',        runs:[1, 3], cost:0.05},
  tea:       {type:'tea',      text:'making a pot of tea',   runs:[1, 1], cost:-0.04},
  guitar:    {type:'music',    text:'playing the guitar',    runs:[1, 2], cost:0.03},
  music:     {type:'music',    text:'listening to records',  runs:[1, 2], cost:0.02},
  cooking:   {type:'cooking',  text:'cooking',               runs:[1, 2], cost:0.05},
  garden:    {type:'garden',   text:'seeing to the roses',   runs:[1, 3], cost:0.07},
  writing:   {type:'writing',  text:'writing',               runs:[1, 3], cost:0.10},
  housework: {type:'domestic', text:'tidying the flat',      runs:[1, 2], cost:0.05},
  occult:    {type:'occult',   text:'an old grimoire',       runs:[1, 2], cost:0.08},
  watching:  {type:'watching', text:'watching television',   runs:[1, 2], cost:0.03},
  online:    {type:'online',   text:'on his laptop',         runs:[1, 2], cost:0.06},
  hobby:     {type:'hobby',    text:'embroidery',            runs:[1, 2], cost:0.02},
  rest:      {type:'rest',     text:'resting',               runs:[1, 2], cost:-0.08},
  walk:      {type:'neighbourhood', text:'a walk',     runs:[1, 3], cost:0.06, outing:true},
  park:      {type:'park',     text:'the park',              runs:[2, 3], cost:0.05, outing:true},
  museum:    {type:'museum',   text:'a museum',              runs:[2, 4], cost:0.08, outing:true},
  market:    {type:'market',   text:'the market',            runs:[1, 3], cost:0.08, outing:true},
  pub:       {type:'pub',      text:'the pub',               runs:[2, 3], cost:0.06, outing:true}
};

const WEIGHTS = {
  morning:   {reading:3, tea:3, garden:3, housework:2, writing:2, online:2, cooking:1, walk:2, market:1, hobby:1},
  midday:    {cooking:3, reading:2, writing:3, online:2, garden:2, walk:2, park:1.5, museum:1, market:1, occult:1, hobby:1, tea:1},
  afternoon: {tea:2, reading:3, writing:2, garden:2, guitar:1.5, hobby:2, occult:1.5, walk:2, park:1.5, museum:1.5, online:1, rest:1},
  evening:   {cooking:3, reading:3, watching:2, guitar:2, music:2, hobby:2, pub:1.5, online:1, rest:1, tea:1},
  late:      {reading:3, music:2, guitar:1.5, occult:2, watching:1, rest:2, writing:1, hobby:1}
};
const WEEKEND_OUTING_BOOST = 1.8;
const SKIES = [['light rain', 30], ['drizzle', 8], ['overcast clouds', 30], ['broken clouds', 10], ['clear sky', 15], ['mist', 7]];
const MONTH_TEMP = [4, 4, 6, 9, 12, 15, 18, 17, 15, 11, 7, 5];

const partOfDay = h => h >= 6 && h < 11 ? 'morning' : h >= 11 && h < 14 ? 'midday' : h >= 14 && h < 18 ? 'afternoon' : h >= 18 && h < 22 ? 'evening' : 'late';

function sleepChance(h, energy) {
  if (h >= 6 && h < 21.5) return energy < 0.03 && h >= 20 ? 0.1 : 0;
  const base = h < 22 ? 0.1 : h < 23 ? 0.25 : h < 24 ? 0.5 : 0.8;
  return Math.min(0.95, base + Math.max(0, 0.4 - energy));
}
function wakeChance(h) { return h >= 6 && h < 7 ? 0.2 : h >= 7 && h < 8 ? 0.55 : h >= 8 && h < 12 ? 0.9 : 0; }

function weighted(rng, entries) {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [name, w] of entries) { r -= w; if (r <= 0) return name; }
  return entries[entries.length - 1][0];
}
function gauss(rng) { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

class ScheduleLife {
  constructor(file, rng = Math.random) {
    this.file = file;
    this.rng = rng;
    this.state = this._load();
  }
  _load() {
    try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (d && d.version === 1) return d; } catch (_e) { /* fresh */ }
    return {};
  }
  _save() {
    fs.mkdirSync(path.dirname(this.file), {recursive:true});
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }
  _fresh(now) {
    const h = now.getHours() + now.getMinutes() / 60;
    const asleep = h >= 23.5 || h < 7;
    this.state = {version:1, last_run_ts:now.getTime() / 1000, energy:0.9, asleep, activity:asleep ? null : 'tea',
      runs_left:asleep ? 0 : 1, last_activity:null, transit_runs:0, weather:null, fairy_ts:0};
  }
  _pick(at) {
    const h = at.getHours() + at.getMinutes() / 60;
    const w = Object.assign({}, WEIGHTS[partOfDay(h)]);
    const weekend = at.getDay() === 0 || at.getDay() === 6;
    const energy = Number(this.state.energy ?? 0.8);
    if (h >= 15.5 && h < 17) w.tea = (w.tea || 0) + 6;
    for (const name of Object.keys(w)) {
      const act = ACTIVITIES[name];
      if (act.outing && weekend) w[name] *= WEEKEND_OUTING_BOOST;
      if (act.outing && energy < 0.35) w[name] *= 0.3;
      if (name === this.state.last_activity) w[name] *= 0.25;
    }
    if (energy < 0.3) { w.rest = (w.rest || 0) + 3; w.tea = (w.tea || 0) + 2; }
    const sky = ((this.state.weather || {}).description) || '';
    if (sky.includes('rain') || sky.includes('drizzle')) for (const n of Object.keys(w)) if (ACTIVITIES[n].outing) w[n] *= 0.6;
    return weighted(this.rng, Object.entries(w));
  }
  _weatherFor(at) {
    const block = Math.floor(at.getTime() / 1000 / (3 * 3600));
    const cur = this.state.weather || {};
    if (cur.block === block) return cur;
    const desc = cur.description && this.rng() < 0.55 ? cur.description : weighted(this.rng, SKIES);
    const diurnal = 3.5 * Math.sin((at.getHours() - 9) / 24 * 2 * Math.PI);
    const feels = Math.round((MONTH_TEMP[at.getMonth()] + diurnal + gauss(this.rng) * 2.5 - (desc.includes('rain') ? 2 : 0)) * 10) / 10;
    return {block, description:desc, feels_c:feels};
  }
  _run(at) {
    const s = this.state;
    const h = at.getHours() + at.getMinutes() / 60;
    s.weather = this._weatherFor(at);
    if (s.asleep) {
      s.energy = Math.min(1, Number(s.energy) + 0.12);
      if (this.rng() < wakeChance(h)) { s.asleep = false; s.energy = Math.max(Number(s.energy), 0.85); s.activity = 'tea'; s.runs_left = 1; }
      return;
    }
    if (this.rng() < sleepChance(h, Number(s.energy))) { s.asleep = true; s.activity = null; s.runs_left = 0; s.transit_runs = 0; return; }
    if (s.transit_runs) { s.transit_runs -= 1; return; }
    s.runs_left = Number(s.runs_left || 0) - 1;
    if (s.runs_left <= 0 || !s.activity) {
      const was = s.activity;
      const wasOut = !!(was && ACTIVITIES[was].outing);
      const name = this._pick(at);
      s.last_activity = was;
      s.activity = name;
      const [lo, hi] = ACTIVITIES[name].runs;
      s.runs_left = lo + Math.floor(this.rng() * (hi - lo + 1));
      if (wasOut !== !!ACTIVITIES[name].outing && this.rng() < 0.6) s.transit_runs = 1;
    }
    const act = ACTIVITIES[s.activity];
    s.energy = Math.max(0, Math.min(1, Number(s.energy) - act.cost));
    if (!act.outing && this.rng() < 0.04) s.fairy_ts = at.getTime() / 1000;
  }
  advance(now = new Date()) {
    if (!this.state.version) this._fresh(now);
    const last = new Date(this.state.last_run_ts * 1000);
    const step = RUN_MINUTES * 60 * 1000;
    let runs = Math.floor((now - last) / step);
    if (runs > MAX_CATCH_UP_RUNS) { this._fresh(now); runs = 0; }
    for (let i = 1; i <= runs; i++) this._run(new Date(last.getTime() + step * i));
    if (runs) this.state.last_run_ts = (last.getTime() + step * runs) / 1000;
    this._save();
  }
}

// ---- status document (the same shape standalone.py serves) ----------------
const DETAIL = {cooking:'cooking', garden:'garden', writing:'writing', music:'music', domestic:'housework', occult:'occult',
  watching:'watching', online:'online', rest:'resting', hobby:'hobby', pub:'pub', museum:'museum', park:'park',
  market:'market', neighbourhood:'walking'};
const RUNTIME_ID = crypto.createHash('sha256').update('arthur-desktop-pet standalone schedule').digest('hex');

function weatherOf(w) {
  if (!w || !w.description) return null;
  const d = w.description;
  const sky = /rain|drizzle|shower|sleet|storm|thunder/.test(d) ? 'rain' : /snow|blizzard|flurr/.test(d) ? 'snow'
    : /fog|mist|haze/.test(d) ? 'fog' : /cloud|overcast/.test(d) ? 'cloud' : 'clear';
  const f = w.feels_c;
  const temp = typeof f !== 'number' ? 'unknown' : f <= 0 ? 'freezing' : f < 8 ? 'cold' : f < 20 ? 'mild' : f < 26 ? 'warm' : 'hot';
  return {sky, temp};
}

function statusDocument(life, now = new Date()) {
  life.advance(now);
  const s = life.state;
  let a;
  if (s.asleep) a = {availability:'sleeping', place:'unknown', pose:'sleeping', key:'sleeping', type:'sleep', hands:'none', mobility:'stationary', locked:true};
  else if (s.transit_runs) a = {availability:'awake', place:'transit', pose:'outdoors', key:'outdoors', type:'transit', hands:'none', mobility:'mobile', locked:false};
  else {
    const name = s.activity || 'rest', act = ACTIVITIES[name];
    if (act.outing) a = {availability:'awake', place:'outdoors', pose:'outdoors', key:'outdoors', type:'outdoors', hands:'none', mobility:'mobile', locked:false, detail:DETAIL[act.type]};
    else if (name === 'reading') a = {availability:'awake', place:'home', pose:'reading', key:'reading', type:'home', hands:'both', mobility:'stationary', locked:false};
    else if (name === 'tea') a = {availability:'awake', place:'home', pose:'tea', key:'tea', type:'home', hands:'right', mobility:'stationary', locked:false};
    else if (name === 'guitar') a = {availability:'awake', place:'home', pose:'awake', key:'guitar', type:'home', hands:'both', mobility:'stationary', locked:false};
    else a = {availability:'awake', place:'home', pose:'awake', key:'learned_activity', type:'home', hands:'unknown', mobility:'stationary', locked:null, detail:DETAIL[act.type]};
  }
  const doc = {
    schema_version:'arthur.companion-status/1',
    observed_at:now.toISOString(),
    selection:{phase:'stable', host:'mac', generation:1, runtime_generation_id:RUNTIME_ID, transition_id:'switch-to-mac-standalone-schedule'},
    writers:{state:'ACTIVE'},
    arthur:{availability:a.availability, place:a.place, pose:a.pose,
      activity:{key:a.key, type:a.type, resources:{hands:a.hands, mobility:a.mobility, body_locked:a.locked}}},
    maintenance:{health:'healthy'},
    freshness:{source_age_ms:0, stale_after_ms:15000, stale:false}
  };
  if (a.detail) doc.arthur.activity.detail = a.detail;
  const w = weatherOf(s.weather);
  if (w) doc.arthur.weather = w;
  if (!s.asleep && s.fairy_ts && now.getTime() / 1000 - s.fairy_ts <= 50 * 60) doc.arthur.fairies = 'home';
  return doc;
}

module.exports = {ScheduleLife, statusDocument, ACTIVITIES};
