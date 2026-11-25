(function (global) {
  'use strict';

  const ADAPTER_BUILD = 'companion-status-adapter-v1-offline-fixtures-r13';
  const SCHEMA_VERSION = 'arthur.companion-status/1';
  // The projection carries its own staleness window. v1 documents that window
  // as 15000, so a payload that omits it is an older producer rather than a
  // broken one and still gets the documented default. A present-but-invalid
  // value is a real producer fault and fails closed with everything else.
  const STALE_AFTER_MS_DEFAULT = 15000;
  // Freshness exists to stop the desk showing hours-old state as current, so a
  // producer cannot widen the window past what this renderer will vouch for.
  const STALE_AFTER_MS_CEILING = 60000;
  const MAX_FUTURE_SKEW_MS = 5000;
  const SHA256_LOWER = /^[0-9a-f]{64}$/;

  const ENUMS = Object.freeze({
    phase:['stable','switching','unknown'],
    host:['mac','vps','unknown'],
    writer:['ACTIVE','INACTIVE','UNKNOWN'],
    availability:['awake','sleeping','unknown'],
    place:['home','hotel','outdoors','transit','unknown'],
    pose:['awake','sleeping','waking','reading','tea','outdoors','unknown'],
    activity:['reading','tea','guitar','sleeping','outdoors','learned_activity','unknown'],
    activityType:['home','hotel','outdoors','transit','exercise','bathing','sleep','unknown'],
    hands:['none','left','right','both','unknown'],
    mobility:['stationary','mobile','unknown'],
    health:['healthy','degraded','unknown'],
    activityDetail:['cooking','garden','writing','music','housework','occult','watching','online','work','resting','drinking','hobby','exercise','bathing','pub','museum','park','market','eating_out','walking','fishing','unknown'],
    sky:['clear','cloud','rain','fog','snow','unknown'],
    temp:['freezing','cold','mild','warm','hot','unknown'],
    letter:['waiting','none'],
    fairies:['home','england','scotland','wales','westcountry','none'],
    outfit:['coat','raincoat','tweed','jumper','city','dress','trench','pirate','punk','unknown']
  });

  const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  const enumValue = (value, allowed, field, issues) => {
    if (allowed.includes(value)) return value;
    issues.push(`${field}:invalid-enum`);
    return 'unknown';
  };
  const objectValue = (value, field, issues) => {
    if (isObject(value)) return value;
    issues.push(`${field}:missing-object`);
    return {};
  };
  const stringOrNull = value => typeof value === 'string' && value.trim().length ? value : null;

  class ArthurCompanionStatusAdapter {
    constructor(runtime, options={}) {
      if (!runtime || typeof runtime.setLifeState !== 'function') {
        throw new Error('ArthurCompanionStatusAdapter expects an Arthur desktop runtime');
      }
      this.runtime = runtime;
      this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
      this.clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
      this.lastObservedAtMs = null;
      this.lastCommitted = null;
      this.status = this._unknownStatus('not-consumed');
    }

    _unknownStatus(reason='unknown') {
      return {
        adapter_build:ADAPTER_BUILD,
        schema_version:SCHEMA_VERSION,
        accepted:false,
        applied:false,
        ignored:false,
        can_drive_visual:false,
        can_propose:false,
        phase:'unknown',
        host:'unknown',
        generation:null,
        runtime_generation_id:null,
        transition_id:null,
        stale:true,
        source_age_ms:null,
        health:'unknown',
        observed_at:null,
        issues:[reason]
      };
    }

    reset() {
      this.lastObservedAtMs = null;
      this.lastCommitted = null;
      this.status = this._unknownStatus('reset');
      this.onStatus(clone(this.status));
      return clone(this.status);
    }

    validate(document, options={}) {
      const now = Number.isFinite(options.nowMs) ? Number(options.nowMs) : this.clock();
      const issues = [];
      const root = objectValue(document, 'document', issues);
      if (root.schema_version !== SCHEMA_VERSION) issues.push('schema_version:unsupported');

      const selection = objectValue(root.selection, 'selection', issues);
      const writers = objectValue(root.writers, 'writers', issues);
      const arthur = objectValue(root.arthur, 'arthur', issues);
      const activity = objectValue(arthur.activity, 'arthur.activity', issues);
      const resources = objectValue(activity.resources, 'arthur.activity.resources', issues);
      const maintenance = objectValue(root.maintenance, 'maintenance', issues);
      const freshness = objectValue(root.freshness, 'freshness', issues);

      const phase = enumValue(selection.phase, ENUMS.phase, 'selection.phase', issues);
      const host = enumValue(selection.host, ENUMS.host, 'selection.host', issues);
      const writer = enumValue(writers.state, ENUMS.writer, 'writers.state', issues);
      const availability = enumValue(arthur.availability, ENUMS.availability, 'arthur.availability', issues);
      const place = enumValue(arthur.place, ENUMS.place, 'arthur.place', issues);
      const pose = enumValue(arthur.pose, ENUMS.pose, 'arthur.pose', issues);
      const activityKey = enumValue(activity.key, ENUMS.activity, 'arthur.activity.key', issues);
      const activityType = enumValue(activity.type, ENUMS.activityType, 'arthur.activity.type', issues);
      const hands = enumValue(resources.hands, ENUMS.hands, 'resources.hands', issues);
      const mobility = enumValue(resources.mobility, ENUMS.mobility, 'resources.mobility', issues);
      const health = enumValue(maintenance.health, ENUMS.health, 'maintenance.health', issues);
      // Optional: older exporters send no detail.
      const activityDetail = Object.prototype.hasOwnProperty.call(activity, 'detail')
        ? enumValue(activity.detail, ENUMS.activityDetail, 'arthur.activity.detail', issues)
        : 'unknown';
      // Optional: older exporters send no weather or letter.
      const has = key => Object.prototype.hasOwnProperty.call(arthur, key);
      const weatherRaw = has('weather') ? objectValue(arthur.weather, 'arthur.weather', issues) : null;
      const weather = weatherRaw ? {
        sky:enumValue(weatherRaw.sky, ENUMS.sky, 'arthur.weather.sky', issues),
        temp:enumValue(weatherRaw.temp, ENUMS.temp, 'arthur.weather.temp', issues)
      } : {sky:'unknown', temp:'unknown'};
      const letter = has('letter') ? enumValue(arthur.letter, ENUMS.letter, 'arthur.letter', issues) : 'none';
      const fairies = has('fairies') ? enumValue(arthur.fairies, ENUMS.fairies, 'arthur.fairies', issues) : 'none';
      const letterId = has('letter_id') && typeof arthur.letter_id === 'string' && /^[0-9a-f]{12}$/.test(arthur.letter_id)
        ? arthur.letter_id : null;
      if (has('letter_id') && !letterId) issues.push('arthur.letter_id');
      // Optional (2026-11-25): meals today, who is with him, where exactly. Short lines
      // or keys only; anything odd is dropped (and noted) rather than shown.
      const shortLine = v => typeof v === 'string' && v.length > 0 && v.length <= 60 && v === v.trim() && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(v);
      let meals = null;
      if (has('meals')) {
        const m = arthur.meals;
        const eaten = m && Array.isArray(m.eaten) ? m.eaten.filter(x => ['breakfast', 'lunch', 'dinner'].includes(x)) : [];
        const minutes = m && Number.isInteger(m.last_minutes) && m.last_minutes >= 0 ? m.last_minutes : null;
        const item = m && shortLine(m.item) ? m.item : null;
        if (m && typeof m === 'object') meals = {eaten, last_minutes:minutes, item};
        else issues.push('arthur.meals');
      }
      let company = [];
      if (has('company')) {
        if (Array.isArray(arthur.company)) company = arthur.company.filter(p => p && shortLine(p.name) && (p.with === 'home' || p.with === 'outing')).slice(0, 3).map(p => ({name:p.name, with:p.with}));
        else issues.push('arthur.company');
      }
      let spot = null;
      if (has('spot')) {
        const sp = arthur.spot || {};
        const ROOMS = ['sitting_room', 'study', 'kitchen', 'bedroom', 'bathroom', 'magic_room', 'hall', 'spare_room', 'garden'];
        if (sp.kind === 'room' && ROOMS.includes(sp.room)) spot = {kind:'room', room:sp.room, residence:sp.residence === 'hampshire_house' ? 'hampshire_house' : 'bloomsbury_flat'};
        else if (sp.kind === 'venue' && shortLine(sp.label)) spot = {kind:'venue', label:sp.label};
        else if (sp.kind === 'away' && shortLine(sp.city)) spot = {kind:'away', city:sp.city, label:shortLine(sp.label) ? sp.label : null};
        else issues.push('arthur.spot');
      }
      // Optional: older exporters send no outfit.
      const outfit = Object.prototype.hasOwnProperty.call(arthur, 'outfit')
        ? enumValue(arthur.outfit, ENUMS.outfit, 'arthur.outfit', issues)
        : 'unknown';

      const generation = Number.isInteger(selection.generation) && selection.generation >= 0
        ? selection.generation
        : null;
      if (selection.generation !== null && generation === null) issues.push('selection.generation:invalid');

      const runtimeGenerationId = typeof selection.runtime_generation_id === 'string' && SHA256_LOWER.test(selection.runtime_generation_id)
        ? selection.runtime_generation_id
        : null;
      if (selection.runtime_generation_id !== null && runtimeGenerationId === null) {
        issues.push('selection.runtime_generation_id:invalid');
      }

      const transitionId = stringOrNull(selection.transition_id);
      if ((phase === 'stable' || phase === 'switching') && transitionId === null) {
        issues.push('selection.transition_id:required');
      }

      const bodyLocked = typeof resources.body_locked === 'boolean' || resources.body_locked === null
        ? resources.body_locked
        : null;
      if (!(typeof resources.body_locked === 'boolean' || resources.body_locked === null)) {
        issues.push('resources.body_locked:invalid');
      }

      const sourceAgeMs = Number.isInteger(freshness.source_age_ms) && freshness.source_age_ms >= 0
        ? freshness.source_age_ms
        : null;
      if (freshness.source_age_ms !== null && sourceAgeMs === null) issues.push('freshness.source_age_ms:invalid');
      if (typeof freshness.stale !== 'boolean') issues.push('freshness.stale:invalid');

      let staleAfterMs = STALE_AFTER_MS_DEFAULT;
      if (freshness.stale_after_ms !== undefined) {
        const wireStaleAfterMs = freshness.stale_after_ms;
        if (Number.isInteger(wireStaleAfterMs) && wireStaleAfterMs > 0 &&
            wireStaleAfterMs <= STALE_AFTER_MS_CEILING) {
          staleAfterMs = wireStaleAfterMs;
        } else {
          issues.push('freshness.stale_after_ms:invalid');
        }
      }

      const observedAt = typeof root.observed_at === 'string' ? root.observed_at : null;
      const observedAtMs = observedAt === null ? NaN : Date.parse(observedAt);
      if (!Number.isFinite(observedAtMs)) issues.push('observed_at:invalid');
      else if (observedAtMs - now > MAX_FUTURE_SKEW_MS) issues.push('observed_at:future');

      const stableBindingComplete = phase === 'stable' && host !== 'unknown' && generation !== null &&
        runtimeGenerationId !== null && transitionId !== null && writer === 'ACTIVE';
      if (phase === 'stable' && !stableBindingComplete) issues.push('stable-binding:incomplete');

      const remoteStale = freshness.stale === true;
      const ageStale = sourceAgeMs === null || sourceAgeMs > staleAfterMs;
      const stale = phase !== 'stable' || remoteStale || ageStale || issues.length > 0;
      const canDriveVisual = issues.length === 0 && stableBindingComplete && !stale;
      const canPropose = canDriveVisual && health === 'healthy';

      const normalized = {
        adapter_build:ADAPTER_BUILD,
        schema_version:SCHEMA_VERSION,
        accepted:issues.length === 0,
        applied:false,
        ignored:false,
        can_drive_visual:canDriveVisual,
        can_propose:canPropose,
        phase:issues.length ? 'unknown' : phase,
        host:issues.length ? 'unknown' : host,
        generation:issues.length ? null : generation,
        runtime_generation_id:issues.length ? null : runtimeGenerationId,
        transition_id:issues.length ? null : transitionId,
        stale:stale,
        source_age_ms:sourceAgeMs,
        effective_stale_after_ms:staleAfterMs,
        health:health,
        writer_state:writer,
        observed_at:Number.isFinite(observedAtMs) ? new Date(observedAtMs).toISOString() : null,
        observed_at_ms:Number.isFinite(observedAtMs) ? observedAtMs : null,
        arthur:{
          availability,
          place,
          pose,
          activity:{
            key:activityKey,
            type:activityType,
            detail:activityDetail,
            resources:{hands,mobility,body_locked:bodyLocked}
          },
          outfit,
          weather,
          letter,
          letter_id:letterId,
          fairies,
          meals,
          company,
          spot
        },
        issues:issues.slice()
      };
      return normalized;
    }

    consume(document, options={}) {
      const next = this.validate(document, options);
      if (next.observed_at_ms !== null && this.lastObservedAtMs !== null && next.observed_at_ms <= this.lastObservedAtMs) {
        next.ignored = true;
        next.accepted = false;
        next.can_drive_visual = false;
        next.can_propose = false;
        next.issues.push('observed_at:out-of-order');
        this.status = next;
        this.onStatus(clone(next));
        return clone(next);
      }

      if (next.can_drive_visual) {
        this._applySafeFacts(next.arthur);
        next.applied = true;
        this.lastObservedAtMs = next.observed_at_ms;
        this.lastCommitted = clone(next);
      }
      this.status = next;
      this.onStatus(clone(next));
      return clone(next);
    }

    _applySafeFacts(arthur) {
      this.runtime.statusPlace = arthur.place;          // where he is: decides 'auto' clothes
      const activity = arthur.activity;
      const resources = activity.resources;
      // After his stolen things: his day waits till he has them back (bed still wins).
      const toBed = arthur.availability === 'sleeping' || arthur.pose === 'sleeping' ||
        activity.key === 'sleeping' || activity.type === 'sleep';
      if (this.runtime.chasingStolen && this.runtime.chasingStolen() && !toBed) return;
      if (typeof this.runtime.setProjectedActivity === 'function') {
        this.runtime.setProjectedActivity(activity.key, activity.type, resources);
      } else {
        this.runtime.setObservedActivity(activity.key, activity.type);
        if (resources.hands !== 'none' && this.runtime.performanceMode === 'guitar') this.runtime.playGuitar(false);
      }

      if (resources.body_locked === true && typeof this.runtime.stopDesktopMotion === 'function') {
        this.runtime.stopDesktopMotion();
      }

      const sleeping = arthur.availability === 'sleeping' || arthur.pose === 'sleeping' ||
        activity.key === 'sleeping' || activity.type === 'sleep';
      const dress = hint => {
        if (typeof this.runtime.applyStatusOutfit === 'function') this.runtime.applyStatusOutfit(hint);
        else this.runtime.setOutfit('auto');
      };
      if (sleeping) {
        dress(null);
        this.runtime.setLifeState('sleep');
        return;
      }

      // What he chose to go out in (a category from his own prep words).
      const away = ['outdoors','transit','hotel'].includes(arthur.place);
      dress(away && arthur.outfit && arthur.outfit !== 'unknown' ? arthur.outfit : null);
      // She just handed him something (tea, a book…): let him finish with it.
      if (this.runtime.localHoldUntil && Date.now() < this.runtime.localHoldUntil) return;
      if (arthur.pose === 'waking') {
        this.runtime.setLifeState('waking');
        return;
      }
      if (arthur.pose === 'reading' || activity.key === 'reading') {
        this.runtime.setLifeState('reading');
        return;
      }
      if (arthur.pose === 'tea' || activity.key === 'tea') {
        this.runtime.setLifeState('tea');
        return;
      }
      if (arthur.place === 'outdoors' || arthur.pose === 'outdoors' || activity.key === 'outdoors') {
        this.runtime.setLifeState('outdoors');
        return;
      }

      if (['sleep','reading','tea','outdoors','waking'].includes(this.runtime.state)) {
        this.runtime.setLifeState('awake');
      }
      if (activity.key === 'guitar' && resources.body_locked === false && resources.hands === 'both') {
        this.runtime.playGuitar(true);
      }
    }

    getStatus() { return clone(this.status); }
  }

  ArthurCompanionStatusAdapter.adapterBuild = ADAPTER_BUILD;
  ArthurCompanionStatusAdapter.schemaVersion = SCHEMA_VERSION;
  // Deliberately not `staleAfterMs`: the window is now whatever the projection
  // says, so a single exported number would read as authority it no longer has.
  ArthurCompanionStatusAdapter.staleAfterMsDefault = STALE_AFTER_MS_DEFAULT;
  ArthurCompanionStatusAdapter.staleAfterMsCeiling = STALE_AFTER_MS_CEILING;
  ArthurCompanionStatusAdapter.maxFutureSkewMs = MAX_FUTURE_SKEW_MS;
  ArthurCompanionStatusAdapter.enums = ENUMS;
  global.ArthurCompanionStatusAdapter = ArthurCompanionStatusAdapter;
})(typeof window !== 'undefined' ? window : globalThis);
