(function (global) {
  'use strict';

  if (!global.ArthurLifeRuntime) throw new Error('ArthurDesktopRuntime requires ArthurLifeRuntime v2');

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  const easeInQuad = t => t * t;
  const smoothstep = t => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  // Wrap an angle difference into [-90, 90) — for shapes symmetric under a half turn.
  const nearestHalfTurn = deg => ((deg % 180) + 270) % 180 - 90;
  const nowMs = () => (global.performance && performance.now ? performance.now() : Date.now());
  const RUNTIME_BUILD = 'desktop-runtime-v4.4.1-local-poke-menu-r14';
  const CLICK_MAX_MS = 360;
  const HOLD_MIN_MS = 520;
  const DRAG_THRESHOLD_PX = 10;
  const HEAD_PAT_MIN_PLEASURE_MS = 3000;
  const HEAD_PAT_MAX_PLEASURE_MS = 20000;
  const HEAD_PAT_CONTACT_GRACE_MS = 760;
  const HEAD_PAT_REALIZE_MS = 680;
  const HEAD_PAT_RETREAT_MS = 1240;
  const HAIR_ROTATION_LIMIT_DEG = 6;
  const POKE_MENU_OPTIONS = Object.freeze([
    Object.freeze({id:'status', label:'你现在怎么样？'}),
    Object.freeze({id:'activity', label:'你在做什么？'}),
    Object.freeze({id:'just-poke', label:'只是想戳你一下'})
  ]);
  const HAND_COLORS = {skin:'#fffdf6', black:'#27302a', white:'#f5f1e7', brown:'#5a3d31', garden:'#b08a55'};
  const OUTFIT_GLOVES = {trench:'black', coat:'brown', dress:'white', raincoat:'black', city:'black', punk:'black', garden:'garden', barbour:'brown'};
  const ACTIVITY_RESOURCES = {
    guitar:{hands:['left','right'], awake:true, mobile:false},
    reading:{hands:['left','right'], awake:true, mobile:false},
    tea:{hands:['right'], awake:true, mobile:false},
    sleep:{hands:['left','right'], awake:false, mobile:false},
    walking:{hands:[], awake:true, mobile:true}
  };
  const ACTIVITY_RESOURCE_RULES = [
    {pattern:/\b(knitting|embroidery|piano|guitar|cooking|cook|reading|book|writing|diary|work|occult|craft)\b/i,hands:['left','right'],awake:true,mobile:false},
    {pattern:/\b(tea|coffee|drink|drinking|minibar|phone|online|browsing)\b/i,hands:['right'],awake:true,mobile:false},
    {pattern:/\b(garden|gardening|exercise|gym|workout|swimming|bathing|bath|shower)\b/i,hands:['left','right'],awake:true,mobile:true,bodyLocked:true},
    {pattern:/\b(sleep|sleeping|nap|resting)\b/i,hands:['left','right'],awake:false,mobile:false,bodyLocked:true},
    {pattern:/\b(watching|television|tv|museum|gallery|casino|restaurant)\b/i,hands:[],awake:true,mobile:false},
    {pattern:/\b(transit|walking|walk|travel|exploring|market|park|city)\b/i,hands:[],awake:true,mobile:true}
  ];
  const TAIL_PUFF_D = 'M-117-12 C-125-59-83-88-41-68 C-13-104 47-87 51-52 C97-62 126-28 111 8 C138 39 100 77 61 65 C31 98-27 86-35 55 C-78 78-123 43-117-12Z';
  const TAIL_LINE_D = 'M-117-4 C-117-14-80-18-41-14 C-5-18 36-17 51-12 C84-15 115-10 117 0 C118 10 84 15 51 12 C22 17-10 16-35 12 C-75 17-117 12-117-4Z';

  class ArthurDesktopRuntime extends global.ArthurLifeRuntime {
    constructor(svg, options={}) {
      super(svg, options);
      this.onInteractionRequest = typeof options.onInteractionRequest === 'function' ? options.onInteractionRequest : () => {};
      // When running inside the Mac app, the native window is the body that
      // moves around the screen: dragging carries the whole window, walking is
      // done on a treadmill while the window slides, and landing waits for it.
      this.host = options.host && typeof options.host.post === 'function' ? options.host : null;
      this.hostCarry = false;
      this.treadmill = null;
      // Sitting on a ledge (a window's top edge): hips on the line where his
      // feet were, legs dangling below it.  seat eases 0..1.
      this.seat = 0;
      this.seatTarget = 0;
      // 'auto': now and then when he goes out or sits down to read -- decided
      // once per outing / reading session, so they don't flicker; never asleep.
      this.glassesMode = ['auto','on','off'].includes(options.glasses) ? options.glasses : 'auto';
      this.glassesChance = Object.assign({reading:.45, out:.3}, options.glassesChance || {});
      this._glassesShown = null;
      this._glassesOccasion = null;
      this._glassesOccasionWears = false;
      this.seatPose = Object.assign({drop:92, legScale:.95, swing:9, handX:-6, handY:34, tailDroop:40, tailTuck:6}, options.seatPose || {});
      this.desktopScale = Number(options.desktopScale) || 0.76;
      this.desktopX = Number(options.desktopX) || 0;
      this.desktopY = Number(options.desktopY) || 0;
      this.direction = options.direction === -1 ? -1 : 1;
      this.facingTarget = options.direction === -1 || options.direction === 1 ? this.direction : 0;
      this.facingOffset = this.facingTarget;
      this.walkSpeed = Number(options.walkSpeed) || 82;
      this.walkBounds = Array.isArray(options.walkBounds) ? options.walkBounds.slice(0, 2) : [-105, 235];
      this.walkMotion = null;
      this.jumpMotion = null;
      this.landingMotion = null;
      this.tailAction = null;
      this.tailDrama = clamp(Number(options.tailDrama) || 1, .35, 1.6);
      this.held = null;
      this.performanceMode = 'idle';
      this.singingUntil = 0;
      this.flowerStart = 0;
      this.flowerDuration = 1900;
      this.gloomOverride = null;
      this.gloomUntil = 0;
      this.proximityGaze = options.proximityGaze !== false;
      this.attention = {targetX:0, targetY:0, x:0, y:0, strength:0};
      this.hairPhysics = {
        fringe:{x:0,y:0,vx:0,vy:0},
        cheekLeft:{x:0,y:0,vx:0,vy:0},
        cheekRight:{x:0,y:0,vx:0,vy:0},
        side:{x:0,y:0,vx:0,vy:0},
        outer:{x:0,y:0,vx:0,vy:0},
        tuft:{x:0,y:0,vx:0,vy:0}
      };
      this.hairInput = {x:0,y:0,vx:0,vy:0};
      this.desktopAutonomy = false;
      this.desktopTimer = null;
      this.desktopTimers = [];
      this.runtimeBuild = RUNTIME_BUILD;
      this.partReaction = null;
      this._reactionFaceActive = false;
      this._headPatTrack = null;
      this._headPatCooldownUntil = 0;
      this.headPatSession = null;
      this.hoverIntent = {zone:null,since:0,lastReactionAt:0,nuzzled:false};
      this.sleepSequence = null;
      // Lying-down pose; tuned so the whole sleeping body stays inside the window.
      this.sleepPose = Object.assign({x:420, y:-150, rotate:-78, scale:.86}, options.sleepPose || {});
      this.handTheme = 'skin';
      this.observedActivity = null;
      this._desktopLast = nowMs();
      this._pointerHandlers = null;
      this._prepareDesktop();
      this._applyHandTheme();
      this._captureTailMorphGeometry();
      this._bindPointer();
      if (this.svg.dataset) this.svg.dataset.arthurRuntime = RUNTIME_BUILD;
      global.ARTHUR_DESKTOP_RUNTIME = RUNTIME_BUILD;
      this._emit('desktop-ready', RUNTIME_BUILD);
    }

    _prepareDesktop() {
      this._display(this.q('desktop-guitar'), false);
      this._display(this.q('desktop-music-notes'), false);
      this._display(this.q('desktop-flowers'), false);
      this._display(this.q('desktop-angry-mark'), false);
      this._display(this.q('desktop-landing-dust'), false);
      this._display(this.q('desktop-gloom'), false);
      this._display(this.q('desktop-tail-straight'), false);
      // Static glove circles from the first trench drawing: they stay put when
      // the hands move, leaving stray dots.  The hands themselves are recoloured.
      this._display(this.q('trench-hands'), false);
      const scarfEnd = this.q('coat-scarf-end');
      if (scarfEnd) { scarfEnd.style.transformBox = 'view-box'; scarfEnd.style.transformOrigin = '444px 240px'; }
      const origins = {
        'motion-leg-left':[345,454], 'motion-leg-right':[418,460],
        'trench-boot-left':[345,454], 'trench-boot-right':[418,460],
        'coat-boot-left':[345,454], 'coat-boot-right':[418,460],
        'dress-leg-left':[345,440], 'dress-leg-right':[418,446],
        'pajama-leg-left':[345,440], 'pajama-cuff-left':[345,440],
        'pajama-leg-right':[418,446], 'pajama-cuff-right':[418,446]
      };
      Object.entries(origins).forEach(([id,[x,y]]) => {
        const el = this.q(id); if (!el) return;
        el.style.transformBox = 'view-box';
        el.style.transformOrigin = `${x}px ${y}px`;
      });
      // Outfits tag their legs (data-leg="left|right", data-origin="x y") so
      // every outfit walks, swings and dangles without being listed here.
      this._legEls = {left:[], right:[]};
      const named = {
        left:['motion-leg-left','trench-boot-left','coat-boot-left','dress-leg-left','pajama-leg-left','pajama-cuff-left'],
        right:['motion-leg-right','trench-boot-right','coat-boot-right','dress-leg-right','pajama-leg-right','pajama-cuff-right']
      };
      ['left','right'].forEach(side => {
        named[side].forEach(id => { const el = this.q(id); if (el) this._legEls[side].push(el); });
      });
      if (this.svg.querySelectorAll) {
        this.svg.querySelectorAll('[data-leg]').forEach(el => {
          const side = el.getAttribute('data-leg');
          if (!this._legEls[side] || this._legEls[side].includes(el)) return;
          const [x, y] = String(el.getAttribute('data-origin') || '').split(/\s+/).map(Number);
          el.style.transformBox = 'view-box';
          if (Number.isFinite(x) && Number.isFinite(y)) el.style.transformOrigin = `${x}px ${y}px`;
          this._legEls[side].push(el);
        });
      }
      const root = this.q('desktop-motion-root');
      if (root) {
        root.style.transformBox = 'view-box';
        root.style.transformOrigin = '382px 623px';
      }
      this.svg.style.touchAction = 'none';
      this.svg.style.userSelect = 'none';
      this.svg.style.cursor = 'grab';
      const guitarOrigins = {
        'guitar-hand-left':'335px 389px',
        'guitar-hand-right':'500px 238px'
      };
      Object.entries(guitarOrigins).forEach(([id, origin]) => {
        const el = this.q(id); if (!el) return;
        el.style.transformBox = 'view-box';
        el.style.transformOrigin = origin;
      });
      const hairRootOrigins = {
        'motion-hair-cheek-left':'156px 42px',
        'motion-hair-cheek-right':'609px 50px',
        'motion-hair-side-left':'197px -43px',
        'motion-hair-side-right':'571px -58px',
        'motion-hair-outer-left':'100px -199px',
        'motion-hair-outer-right':'661px -247px',
        'motion-hair-tuft-top-left':'293px -382px',
        'motion-hair-crown-right':'490px -355px',
        'motion-hair-tuft-left':'115px -58px',
        'motion-hair-tuft-right':'676px -134px'
      };
      Object.entries(hairRootOrigins).forEach(([id, origin]) => {
        const el = this.q(id); if (!el) return;
        el.style.transformBox = 'view-box';
        el.style.transformOrigin = origin;
      });
      this._attentionFaceIds = [
        'g-blush-left-back','g-blush-right-back','g-blush-left','g-blush-right','g-nose',
        'g-mouth-neutral','g-mouth-smile','g-mouth-open-small','g-mouth-open-wide','g-mouth-pout',
        'viseme-bank','expression-closed-eyes'
      ];
    }

    _activityConflicts(a, b) {
      const left = ACTIVITY_RESOURCES[a], right = ACTIVITY_RESOURCES[b];
      if (!left || !right) return false;
      if (left.hands.some(hand => right.hands.includes(hand))) return true;
      return (left.mobile === false && b === 'walking') || (right.mobile === false && a === 'walking');
    }

    inferActivityResources(name='', type='') {
      const key = String(name || '').trim().toLowerCase();
      if (ACTIVITY_RESOURCES[key]) return Object.assign({source:'exact'}, ACTIVITY_RESOURCES[key]);
      const haystack = `${name || ''} ${type || ''}`;
      const rule = ACTIVITY_RESOURCE_RULES.find(item => item.pattern.test(haystack));
      return rule
        ? {hands:rule.hands.slice(),awake:rule.awake,mobile:rule.mobile,bodyLocked:!!rule.bodyLocked,source:'keyword'}
        : {hands:[],awake:true,mobile:false,bodyLocked:false,source:'conservative-default'};
    }

    setObservedActivity(name='', type='') {
      const resources = this.inferActivityResources(name, type);
      this.observedActivity = {name:String(name),type:String(type),resources};
      const guitarResources = ACTIVITY_RESOURCES.guitar;
      if (this.performanceMode === 'guitar' && resources.hands.some(hand => guitarResources.hands.includes(hand))) this.playGuitar(false);
      this._emit('observed-activity', `${name}:${resources.source}`);
      return this.observedActivity;
    }

    setProjectedActivity(key='unknown', type='unknown', hints={}) {
      const handMap = {
        none:[],
        left:['left'],
        right:['right'],
        both:['left','right'],
        unknown:[]
      };
      const handsState = Object.prototype.hasOwnProperty.call(handMap, hints.hands) ? hints.hands : 'unknown';
      const mobilityState = ['stationary','mobile','unknown'].includes(hints.mobility) ? hints.mobility : 'unknown';
      const bodyLocked = typeof hints.body_locked === 'boolean' ? hints.body_locked : null;
      const resources = {
        hands:handMap[handsState].slice(),
        handsState,
        awake:key !== 'sleeping' && type !== 'sleep',
        mobile:mobilityState === 'mobile',
        mobilityState,
        bodyLocked,
        source:'companion-projection'
      };
      this.observedActivity = {name:String(key),type:String(type),resources};
      const handsUnavailable = handsState === 'unknown' || resources.hands.length > 0;
      if (this.performanceMode === 'guitar' && (handsUnavailable || bodyLocked !== false)) this.playGuitar(false);
      if (bodyLocked === true) {
        this.walkMotion = null;
        this.jumpMotion = null;
        this.landingMotion = null;
      }
      this._emit('projected-activity', `${key}:${handsState}:${mobilityState}:${bodyLocked}`);
      return this.observedActivity;
    }

    _applyHandTheme(theme=null) {
      const resolved = theme || OUTFIT_GLOVES[this.outfit] || 'skin';
      this.handTheme = HAND_COLORS[resolved] ? resolved : 'skin';
      const color = HAND_COLORS[this.handTheme];
      ['g-hand-left','g-hand-right','hand-left','hand-right','trench-glove-left','trench-glove-right','guitar-hand-left','guitar-hand-right']
        .forEach(id => {
          const el = this.q(id);
          if (!el) return;
          if (el.setAttribute) el.setAttribute('fill', color);
          if (el.style) el.style.fill = color;
        });
      if (this.svg.style && this.svg.style.setProperty) this.svg.style.setProperty('--arthur-hand-fill', color);
      return color;
    }

    setHandTheme(theme='auto') {
      const resolved = theme === 'auto' ? (OUTFIT_GLOVES[this.outfit] || 'skin') : theme;
      if (!HAND_COLORS[resolved]) throw new Error('Unknown hand theme: '+theme);
      this._applyHandTheme(resolved);
      this._emit('hand-theme', resolved);
    }

    // Her menu choice wins; under 'auto' he wears what he chose for the
    // outing (status hint), else the place decides (pyjamas home, coat out).
    setOutfitChoice(mode='auto') {
      this.outfitChoice = mode || 'auto';
      return this._applyOutfitPolicy();
    }

    // What 'auto' dresses him in follows where he is, not his mood of the moment: a pat
    // or a gift sets him 'happy' for a while, and that used to put him in homewear while
    // he was out (then back into his coat at the next status read).
    _resolvedOutfit(state=this.state) {
      if (this.outfitMode === 'auto' && state !== 'sleep' && state !== 'sleepy' && ['outdoors','transit'].includes(this.statusPlace)) return 'coat';
      return super._resolvedOutfit(state);
    }

    applyStatusOutfit(hint) {
      this.statusOutfit = hint || null;
      return this._applyOutfitPolicy();
    }

    _applyOutfitPolicy() {
      const choice = this.outfitChoice || 'auto';
      const wanted = choice !== 'auto' ? choice : (this.statusOutfit || 'auto');
      if (wanted !== this.outfitMode) {
        try { this.setOutfit(wanted); } catch (_error) { this.setOutfit('auto'); }
      }
      return this.outfit;
    }

    setOutfit(next) {
      super.setOutfit(next);
      this._applyHandTheme();
    }

    setLifeState(next, options={}) {
      // Already asleep (or lying down): every status refresh says 'sleeping' again.
      // Don't start the lie-down over from standing each time.
      if (next === 'sleep' && (this.state === 'sleep' || (this.transition && this.transition.next === 'sleep'))) return undefined;
      const incoming = next === 'reading' ? 'reading' : next === 'tea' ? 'tea' : next === 'sleep' ? 'sleep' : null;
      if (incoming && this.performanceMode === 'guitar' && this._activityConflicts('guitar', incoming)) this.playGuitar(false);
      if (next === 'sleep') {
        this.sleepSequence = {phase:'lie-down',start:nowMs(),duration:1150};
        this.tailAction = null;
        this._restoreTailMorph();
      }
      else if (this.state === 'sleep' || next === 'waking') this.sleepSequence = {phase:'stand-up',start:nowMs(),duration:1280};
      const result = super.setLifeState(next, options);
      this._applyHandTheme();
      return result;
    }

    _captureTailMorphGeometry() {
      const definitions = [
        {group:'g-tail-base', path:'tail-base', start:[527.2,455.55,17.2,1,1], target:[540,437,-21,.86,.62]},
        {group:'g-tail-mid', path:'tail-mid', start:[725.18,478.16,-14.42,1.3048,1.3048], target:[690,383,-21,.94,.62]},
        {group:'g-tail-tip', path:'tail-tip', start:[892.32,391.98,126.06,1.4641,1.4641], target:[840,327,-21,1.03,.62]}
      ];
      this._tailMorphGeometry = definitions.map(def => {
        const group = this.q(def.group), path = this.q(def.path);
        const sourceTransform = group && group.getAttribute ? group.getAttribute('transform') : '';
        const match = sourceTransform && sourceTransform.match(/translate\(\s*([-+.\d]+)[ ,]+([-+.\d]+)\s*\)\s*rotate\(\s*([-+.\d]+)\s*\)\s*scale\(\s*([-+.\d]+)[ ,]+([-+.\d]+)\s*\)/);
        const start = match ? match.slice(1).map(Number) : def.start.slice();
        const sourceD = path && path.getAttribute ? (path.getAttribute('d') || TAIL_PUFF_D) : TAIL_PUFF_D;
        // The straightened segment (TAIL_LINE_D) looks the same turned 180°, so
        // aim for whichever equivalent angle is nearest.  Otherwise the tip
        // (drawn at 126°) whips 147° round to -21° and back, which reads as a
        // full spin before it reconnects.
        const target = def.target.slice();
        target[2] = start[2] + nearestHalfTurn(target[2] - start[2]);
        return {group, path, sourceTransform:sourceTransform || `translate(${start[0]} ${start[1]}) rotate(${start[2]}) scale(${start[3]} ${start[4]})`, sourceD, start, target};
      });
    }

    _mixNumberTemplate(from, to, t) {
      const numbers = String(to).match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi);
      let index = 0;
      if (!numbers) return from;
      const mixed = String(from).replace(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi, value => {
        if (index >= numbers.length) return value;
        const next = lerp(Number(value), Number(numbers[index++]), t);
        return Math.abs(next) < .0001 ? '0' : Number(next.toFixed(3)).toString();
      });
      return index === numbers.length ? mixed : from;
    }

    _applyTailMorph(amounts, wobble=0) {
      const values = Array.isArray(amounts) ? amounts : [amounts, amounts, amounts];
      (this._tailMorphGeometry || []).forEach((part, index) => {
        const m = clamp(Number(values[index]) || 0, 0, 1);
        const start = part.start, target = part.target;
        const follow = wobble * index;
        const x = lerp(start[0], target[0], m) + follow * 2.2;
        const y = lerp(start[1], target[1], m) - follow * 1.7;
        const r = lerp(start[2], target[2], m) + follow * 2.8;
        const sx = lerp(start[3], target[3], m) * (1 + Math.abs(follow) * .018);
        const sy = lerp(start[4], target[4], m) * (1 - Math.abs(follow) * .025);
        if (part.group && part.group.setAttribute) part.group.setAttribute('transform', `translate(${x.toFixed(3)} ${y.toFixed(3)}) rotate(${r.toFixed(3)}) scale(${sx.toFixed(4)} ${Math.max(.08, sy).toFixed(4)})`);
        if (part.path && part.path.setAttribute) part.path.setAttribute('d', this._mixNumberTemplate(part.sourceD, TAIL_LINE_D, m));
      });
    }

    _restoreTailMorph() {
      (this._tailMorphGeometry || []).forEach(part => {
        if (part.group && part.group.setAttribute) part.group.setAttribute('transform', part.sourceTransform);
        if (part.path && part.path.setAttribute) part.path.setAttribute('d', part.sourceD);
      });
    }

    _pointInRect(x, y, rect, pad=0) {
      return !!rect && x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;
    }

    _headRect() {
      const head = this.q('motion-head-root');
      const rect = head && head.getBoundingClientRect ? head.getBoundingClientRect() : null;
      return rect && rect.width > 20 && rect.height > 20 ? rect : null;
    }

    _isHeadPatPoint(event) {
      const rect = this._headRect();
      if (!rect) return false;
      const x = Number(event.clientX), y = Number(event.clientY);
      return x >= rect.left + rect.width * .24 && x <= rect.left + rect.width * .76
        && y >= rect.top - rect.height * .03 && y <= rect.top + rect.height * .34;
    }

    _eventAncestorIds(event) {
      const ids = [];
      let node = event && event.target;
      while (node && node !== this.svg) {
        if (node.id) ids.push(String(node.id));
        node = node.parentNode;
      }
      if (this.svg && this.svg.id) ids.push(String(this.svg.id));
      return ids;
    }

    // The little parts: hat, the sticking-up hair on top, ears, brows, nose, collar.
    _smallPart(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const box = (id, pad=0) => { const e = this.q(id); const r = e && e.getBoundingClientRect && e.getBoundingClientRect();
        return r && r.width > 2 && x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad ? r : null; };
      const shown = id => { const e = this.q(id); return e && e.getAttribute('display') !== 'none' && e.style.display !== 'none'; };
      const hat = ['hat-city','hat-pirate','hat-gown','hat-garden','hat-barbour','hat-maid'].find(id => shown(id) && box(id, 4));
      if (hat) return 'hat';
      const earL = this.q('twitch-ear-left'), earTop = earL ? earL.getBoundingClientRect().top : -1e9;
      if ((box('motion-hair-tuft-top-left') || box('motion-hair-crown-right')) && y < earTop + 4) return 'ahoge';
      if (box('twitch-ear-left', -6)) return 'ear-left';
      if (box('twitch-ear-right', -6)) return 'ear-right';
      if (box('motion-brow-left', 6) || box('motion-brow-right', 6)) return 'brow';
      if (box('g-nose', 4)) return 'nose';
      const head = this.q('g-head-back'), torso = this.q('torso-root');
      const hb = head && head.getBoundingClientRect(), tb = torso && torso.getBoundingClientRect();
      if (hb && tb && tb.width && y > hb.bottom - 14 && y < hb.bottom + 40 && Math.abs(x - (tb.left + tb.width / 2)) < tb.width * .25) return 'collar';
      return null;
    }

    _zoneFromEvent(event) {
      const ids = this._eventAncestorIds(event).join(' ');
      if (/mint-bunny/.test(ids)) return 'bunny';
      if (/fx-note/.test(ids)) return 'note';
      const part = this._smallPart(Number(event.clientX), Number(event.clientY));
      if (part) return part;
      if (this._isHeadPatPoint(event)) return 'head-top';
      if (/tail/i.test(ids)) return 'tail';
      if (this._isCrotchPoint(event)) return 'crotch';
      if (/hand-left/i.test(ids)) return 'hand-left';
      if (/hand-right/i.test(ids)) return 'hand-right';
      if (/(leg-left|boot-left|pajama-leg-left|pajama-cuff-left)/i.test(ids)) return 'foot-left';
      if (/(leg-right|boot-right|pajama-leg-right|pajama-cuff-right)/i.test(ids)) return 'foot-right';
      // Whole words only: 'ear' used to match 'homewear', so in his house clothes
      // anywhere on his body counted as his face.
      if (/(^|[-_ ])(head|eye|eyes|brow|mouth|nose|blush|hair|ear|face)([-_ ]|$)/i.test(ids)) return 'face';
      if (/(torso|body|outfit|trench|pajama|coat|scarf|dress|tweed|jumper|city|pirate|punk)/i.test(ids)) return 'torso';

      const x = Number(event.clientX), y = Number(event.clientY);
      const boxes = [
        ['hand-left', this.q('motion-hand-left')], ['hand-right', this.q('motion-hand-right')],
        ['foot-left', this.q('motion-leg-left')], ['foot-right', this.q('motion-leg-right')],
        ['tail', this.q('tail-root')], ['face', this.q('motion-head-root')], ['torso', this.q('torso-root')]
      ];
      for (const [zone, el] of boxes) {
        const rect = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (rect && rect.width > 8 && rect.height > 8 && this._pointInRect(x, y, rect, zone.startsWith('hand') ? 12 : 0)) return zone;
      }
      return 'body';
    }

    _resetHeadPatTrack() { this._headPatTrack = null; }

    // Where she took hold of him, for how he hangs: by the front of his shirt
    // (the chest: he only has a front), the head, a hand, a foot, the tail, or the body.
    _gripFrom(event, zone) {
      if (zone === 'ear-left' || zone === 'ear-right') return zone;
      if (zone === 'collar') return 'chest';
      if (['head-top','face','hat','ahoge','brow','nose'].includes(zone)) return 'head';
      if (zone === 'hand-left' || zone === 'hand-right') return zone;
      if (zone === 'foot-left' || zone === 'foot-right') return zone;
      if (zone === 'tail') return 'tail';
      const torso = this.q('torso-root');
      const t = torso && torso.getBoundingClientRect && torso.getBoundingClientRect();
      // His big head hides the top of his body: the chest is the visible part
      // from under his chin down to about halfway.
      const hb = this.q('g-head-back') && this.q('g-head-back').getBoundingClientRect();
      const top = hb && hb.height ? Math.max(t ? t.top : 0, hb.bottom - hb.height * .08) : (t ? t.top : 0);
      if (t && t.height && Number(event.clientY) < top + (t.bottom - top) * .5) return 'chest';
      return 'body';
    }
    gripZone() {
      const g = this._lastGrab;
      return g && this._isActuallyHeld() && Date.now() - g.at < 10 * 60 * 1000 ? g.zone : null;
    }

    // How long the frame loop may rest after this frame. Anything moving or
    // recently touched runs at the display rate; standing about, 20 fps;
    // asleep, 10 fps. (Every animation here is time-based, so fewer frames
    // only means fewer pictures, never slower motion.)
    noteActivity() { this._activeAt = nowMs(); this.wakeFrames && this.wakeFrames(); }

    // Calm: stop redrawing the vector drawing (every redraw repaints all of it)
    // and let the GPU breathe the finished picture instead. Returns whether the
    // frame may be skipped.
    _freezeCalm(on) {
      const mount = this.svg && this.svg.parentNode;
      if (!mount || !mount.classList) return false;
      if (on) {
        if (!this._frozen) {
          // One last proper frame first, then hold it.
          this._frozen = 'pending';
          return false;
        }
        if (this._frozen === 'pending') {
          this._frozen = true;
          mount.classList.toggle('calm-asleep', this.state === 'sleep');
          mount.classList.add('calm-breathe');
        }
        return true;
      }
      if (this._frozen) {
        this._frozen = false;
        mount.classList.remove('calm-breathe', 'calm-asleep');
      }
      return false;
    }
    _frameGap(now) {
      const until = t => t && now < t;
      const checks = [
        ['touched', now - (this._activeAt || 0) < 3000], ['held', this.held], ['carry', this.hostCarry], ['leap', this.hostLeap],
        ['walk', this.treadmill || this.walkMotion], ['transition', this.transition], ['sleepSeq', this.sleepSequence],
        ['jump', this.jumpMotion || this.landingMotion], ['knock', this.knockout || this.dizzy], ['part', this.partReaction],
        ['tail', this.tailAction], ['flowers', this.flowerStart || this.fairyScatter], ['blink', this.blinkDuration],
        ['talk', this.viseme !== 'idle'], ['guitar', this.performanceMode === 'guitar'],
        ['face', until(this.flusterUntil) || until(this.squeezeUntil) || until(this.puzzledUntil) || until(this.hideStitchingUntil) || until(this.sleepTalkUntil) || until(this.stirUntil)],
        ['spell', this.spell], ['slump', this._slumped && this._slumped(now)], ['ride', this.ride || this.floating],
        ['antic', this.antic && (!this.antic.long || this.antic.type === 'fairies' || now - this.antic.start < 1500)],
        ['bunny', this.bunny && this.bunny.leaving], ['tuck', this._tuckK > 0 && this._tuckK < 1],
        ['scared', this.worried || this.heldAngry || this.edgeFear], ['tired', this.tired],
        ['cry', until(this.cryUntil) || until(this.lyingTearsUntil)],
        ['dragmotion', until(this.strollUntil) || until(this.scrapeUntil)],
        ['cheek', this.cheekLean],
        ['acts', this.lookAway || this.handsHidden || this.handReach || this.lookHand || this.slumpPeek || until(this.glareUntil) || until(this.hugUntil) || this.cradle],
        ['beat', this.antic && (this.antic.beatNow || (this.antic.beatAt && now >= this.antic.beatAt))],
        ['parts', this.selfFix || this.earTwitch || this.ahogeSpring || this.hatTilt || until(this.browRuffleUntil) || until(this.collarPleasedUntil) || this._browFixDue],
        ['tailaway', this.tailAwayUntil && now < this.tailAwayUntil + 700],
        ['tailplay', this._tailTease || until(this.tailFluffUntil) || until(this.tailPuffUntil) || until(this.tailNoticedUntil)],
        // A long, slow antic (dozing, reading, tea, embroidery) still moves the whole time:
        // never frozen, just fewer frames (see _render).
        ['lull', this.antic && this.antic.long]
      ];
      const hit = checks.find(c => c[1]);
      this.frameReason = hit ? hit[0] : 'calm';            // for debugging from the console
      if (hit) return 0;
      if (this.hostOccluded) return 2000;                 // nobody can see him: barely tick
      return this.state === 'sleep' ? 500 : 250;           // breathing reads fine at a few frames a second
    }

    // Between the tops of his legs, just under the body.
    _isCrotchPoint(event) {
      const torso = this.q('torso-root'), legL = this.q('motion-leg-left'), legR = this.q('motion-leg-right');
      if (!torso || !legL || !legR || !torso.getBoundingClientRect) return false;
      const t = torso.getBoundingClientRect(), l = legL.getBoundingClientRect(), r = legR.getBoundingClientRect();
      const x = Number(event.clientX), y = Number(event.clientY);
      const cx = (l.right + r.left) / 2, half = Math.max(10, (r.right - l.left) * .26);
      return Math.abs(x - cx) <= half && y >= t.top + t.height * .78 && y <= Math.min(l.top, r.top) + (l.height * .28);
    }

    // A spell, on request. Usually it works (flowers); now and then: smoke.
    castSpell(fail=Math.random() < .28) {
      // A stretch or a hand through his hair is no reason to refuse her: he stops and does it.
      if (this.antic && !this.antic.long && this.stopAntic) this.stopAntic('poked');
      if (this._busyBody() || this.antic || this._slumped()) return null;
      this.putBlanketAway && this.putBlanketAway();
      this.spell = {start:nowMs(), fail, ms:fail ? 3600 : 2600, burst:false};
      return fail ? 'fail' : 'ok';
    }

    // A mint bunny, now and then, lying on top of his head. He never mentions it.
    _mintBunny() {
      if (this._bunnyEl !== undefined) return this._bunnyEl;
      const head = this.q('motion-head-root');
      if (!head || !this.svg.ownerDocument) return (this._bunnyEl = null);
      const g = this.svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('id', 'fx-mint-bunny');
      g.setAttribute('display', 'none');
      g.innerHTML = '<g id="mint-bunny-body" transform="translate(440 -392)">'
        + '<path d="M-34 -40 C-54 -96 -34 -120 -22 -112 C-12 -104 -14 -70 -18 -44Z" fill="#c9f2d8"/>'
        + '<path d="M-8 -42 C4 -100 30 -112 36 -100 C42 -88 22 -62 8 -40Z" fill="#c9f2d8"/>'
        + '<path d="M-28 -78 C-36 -96 -30 -104 -25 -100 M8 -74 C16 -92 24 -98 28 -94" stroke="#f4b6c2" stroke-width="6" fill="none" stroke-linecap="round"/>'
        + '<ellipse cx="0" cy="0" rx="72" ry="42" fill="#c9f2d8"/>'
        + '<ellipse cx="-40" cy="34" rx="16" ry="12" fill="#c9f2d8"/>'
        + '<ellipse cx="14" cy="38" rx="16" ry="12" fill="#c9f2d8"/>'
        + '<circle cx="64" cy="-6" r="13" fill="#e6fbee"/>'
        + '<path d="M-34 -8 q8 -7 16 0 M2 -8 q8 -7 16 0" stroke="#2d4a3a" stroke-width="5" fill="none" stroke-linecap="round"/>'
        + '<path d="M-14 6 l4 4 l4 -4" stroke="#e48a9c" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
        + '</g>';
      head.appendChild(g);
      return (this._bunnyEl = g);
    }

    // A note left by his feet while she was away.
    leaveNote(lines) {
      const root = this.q('character-motion-root');
      if (!root || !this.svg.ownerDocument) return false;
      let g = this.q('fx-note');
      const NS = 'http://www.w3.org/2000/svg';
      if (!g) {
        g = this.svg.ownerDocument.createElementNS(NS, 'g');
        g.setAttribute('id', 'fx-note');
        root.appendChild(g);
      }
      const esc = t => String(t).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
      const text = lines.slice(0, 3).map((t, i) => `<text x="0" y="${-34 + i * 40}" font-size="30" font-family="'PingFang SC','Hiragino Sans GB',sans-serif" fill="#3a3026" text-anchor="middle">${esc(t)}</text>`).join('');
      g.innerHTML = `<g transform="translate(130 540) rotate(6)"><rect x="-104" y="-82" width="208" height="164" rx="6" fill="#fbe7a1" stroke="#d8b85a" stroke-width="4"/>`
        + `<rect x="-104" y="-82" width="208" height="24" fill="#f5d878"/>${text}</g>`;
      g.setAttribute('display', 'inline');
      this.note = {since:nowMs()};
      return true;
    }

    takeNote() {
      const g = this.q('fx-note');
      if (g) g.setAttribute('display', 'none');
      const had = !!this.note;
      this.note = null;
      return had;
    }

    showMintBunny(ms) {
      const b = this._mintBunny();
      if (!b || this.state === 'sleep') return false;
      this.bunny = {since:nowMs(), until:nowMs() + ms};
      b.setAttribute('display', 'inline');
      b.removeAttribute('opacity');
      return true;
    }

    shooBunny() {
      if (!this.bunny || this.bunny.leaving) return false;
      this.bunny.leaving = nowMs();
      return true;
    }

    _renderBunny(now) {
      const bn = this.bunny, el = this._bunnyEl;
      if (!bn || !el) return;
      const body = this.q('mint-bunny-body');
      if (bn.leaving) {
        const k = clamp((now - bn.leaving) / 900, 0, 1);
        if (body) body.setAttribute('transform', `translate(${(440 + 160 * k).toFixed(1)} ${(-392 - 320 * k).toFixed(1)}) rotate(${(-25 * k).toFixed(1)})`);
        el.setAttribute('opacity', (1 - k).toFixed(2));
        if (k >= 1) { this.bunny = null; el.setAttribute('display', 'none'); }
        return;
      }
      if (now > bn.until || this.state === 'sleep') { this.shooBunny(); return; }
      // Breathing, and the odd ear flick.
      const br = (Math.sin(now / 1000 * 2) + 1) / 2;
      if (body) body.setAttribute('transform', `translate(440 ${(-392 - 3 * br).toFixed(1)}) scale(1,${(1 + .03 * br).toFixed(3)})`);
    }

    _smoke() {
      if (this._smokeEl !== undefined) return this._smokeEl;
      const root = this.q('character-motion-root');
      if (!root || !this.svg.ownerDocument) return (this._smokeEl = null);
      const NS = 'http://www.w3.org/2000/svg';
      const g = this.svg.ownerDocument.createElementNS(NS, 'g');
      g.setAttribute('id', 'fx-smoke');
      g.setAttribute('display', 'none');
      g.setAttribute('pointer-events', 'none');
      [[330,-150,80],[430,-170,90],[380,-80,70],[290,-40,60],[470,-60,64],[520,-220,56],[250,-210,50]].forEach(([x,y,r]) => {
        const c = this.svg.ownerDocument.createElementNS(NS, 'circle');
        c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', r);
        c.setAttribute('fill', '#8d9096');
        g.appendChild(c);
      });
      root.appendChild(g);
      return (this._smokeEl = g);
    }

    _renderSpell(now) {
      const sp = this.spell;
      if (!sp) return;
      const t = now - sp.start;
      if (t > sp.ms) { this.spell = null; const sm = this._smoke(); if (sm) sm.setAttribute('display', 'none'); return; }
      // Wand up and a flourish, then the moment.
      const up = smoothstep(clamp(t / 500, 0, 1)) * (1 - smoothstep(clamp((t - sp.ms + 500) / 500, 0, 1)));
      const wave = t < 1000 ? Math.sin(t / 1000 * 14) : 0;
      this._appendTransform(this.q('motion-hand-right'), `translate(${(-40 * up + 30 * wave * up).toFixed(1)}px,${(-260 * up).toFixed(1)}px) rotate(${(-20 * wave * up).toFixed(1)}deg)`);
      if (t >= 1000 && !sp.burst) {
        sp.burst = true;
        if (!sp.fail && typeof this.spawnFlowers === 'function') this.spawnFlowers();
      }
      if (sp.fail && t >= 1000) {
        const k = clamp((t - 1000) / 250, 0, 1) * clamp((sp.ms - t) / 900, 0, 1);
        const sm = this._smoke();
        if (sm) {
          sm.setAttribute('display', 'inline');
          sm.setAttribute('opacity', (.9 * k).toFixed(2));
          sm.setAttribute('transform', `translate(0 ${(-60 * clamp((t - 1000) / 2600, 0, 1)).toFixed(1)})`);
        }
        // Coughing: eyes screwed shut, little jolts.
        const cough = Math.max(0, Math.sin((t - 1000) / 1000 * 11));
        this._appendTransform(this.q('character-motion-root'), `translateY(${(4 * cough).toFixed(1)}px)`);
        this._appendTransform(this.q('motion-head-root'), `translateY(${(8 * cough).toFixed(1)}px) rotate(${(3 * cough).toFixed(1)}deg)`);
        this._display(this.q('g-eye-left'), false);
        this._display(this.q('g-eye-right'), false);
        this._display(this.q('motion-eye-left'), false);
        this._display(this.q('motion-eye-right'), false);
        this._display(this.q('expression-closed-eyes'), true);
        sp.dirty = true;
      } else if (sp.dirty) {
        sp.dirty = false;
      }
    }

    // Giving in turned into tears: hands over his face, shoulders shaking,
    // tears running out from under his fingers.
    cry(ms=6000) {
      if (this.state === 'sleep') return false;
      const now = nowMs();
      if (!(this.cryUntil && now < this.cryUntil)) { this.cryStart = now; this._cryAim = null; }
      this.cryUntil = Math.max(this.cryUntil || 0, now + ms);
      this._emit('body-reaction', 'cry');
      return true;
    }

    // ---- small parts ------------------------------------------------------
    noseBoop() {
      const sneeze = Math.random() < .75 && !this.antic && this.startAntic && this.startAntic('sneeze');
      return sneeze ? 'sneeze' : 'touched';
    }
    browPoke() { this.browRuffleUntil = Math.max(this.browRuffleUntil || 0, nowMs() + 400); return 'poked'; }
    _trackBrowRub(event) {
      const now = nowMs();
      const x = Number(event.clientX), y = Number(event.clientY);
      const on = this._smallPart(x, y) === 'brow';
      let t = this._browTrack;
      if (!on) { this._browTrack = null; return; }
      if (!t || now - t.at > 500) { this._browTrack = {x, y, at:now, travel:0, turns:0, dir:0}; return; }
      const dx = x - t.x; t.x = x; t.y = y; t.at = now;
      if (Math.abs(dx) < 1) return;
      const dir = dx < 0 ? -1 : 1;
      t.travel += Math.abs(dx);
      if (t.dir && dir !== t.dir) t.turns += 1;
      t.dir = dir;
      if (t.travel > 40 && t.turns >= 2 && !(this.browRuffleUntil && now < this.browRuffleUntil)) {
        this._browTrack = null;
        this.browRuffleUntil = now + 2600;          // ruffled; he'll smooth them himself
        this._browFixDue = now + 2600;
        if (this.onPart) this.onPart('brow-rub');
      }
    }
    // Stroking a cheek back and forth: he leans into her hand a little, and if
    // she keeps on, his eyes slide shut. The face stays perfectly straight.
    _trackCheekRub(event) {
      const now = nowMs();
      const x = Number(event.clientX), y = Number(event.clientY);
      const side = ['left','right'].find(sd => {
        const e = this.q(`g-blush-${sd}`); const r = e && e.getBoundingClientRect();
        return r && r.width && x > r.left - 16 && x < r.right + 16 && y > r.top - 16 && y < r.bottom + 16;
      });
      let t = this._cheekTrack;
      if (!side) { this._cheekTrack = null; return; }
      if (!t || t.side !== side || now - t.at > 500) { this._cheekTrack = {side, x, y, at:now, travel:0, turns:0, dir:0}; return; }
      const dx = x - t.x, dy = y - t.y; t.x = x; t.y = y; t.at = now;
      const along = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
      if (Math.abs(along) < 1) return;
      const dir = along < 0 ? -1 : 1;
      t.travel += Math.abs(along);
      if (t.dir && dir !== t.dir) t.turns += 1;
      t.dir = dir;
      if (t.travel > 30 && t.turns >= 2) {
        t.travel = 0; t.turns = 0;
        this._cheekRubs = (this._cheekRubs || []).filter(s2 => now - s2 < 15000).concat(now);
        this.cheekLean = {side, until:now + 1800, content:this._cheekRubs.length >= 3};
      }
    }

    // He's a fold: his ears don't flick or twitch.
    earFlick(side) { return 'touched'; }
    _earHover(x, y) {
      return;
      const now = nowMs();
      if (this.earTwitch && now - this.earTwitch.start < 1600) return;
      ['left','right'].forEach(side => {
        const e = this.q(`twitch-ear-${side}`); const r = e && e.getBoundingClientRect();
        if (r && r.width && x > r.left - 30 && x < r.right + 30 && y > r.top - 30 && y < r.bottom + 10) this.earTwitch = {side, start:now, big:false};
      });
    }
    ahogeFlick() {
      const now = nowMs();
      this.ahogeSpring = {start:now};
      this._ahogeFlicks = (this._ahogeFlicks || []).filter(t => now - t < 10000).concat(now);
      if (this._ahogeFlicks.length >= 4 && !this.selfFix) { this._ahogeFlicks = []; this.startSelfFix('ahoge', 2600); return 'covered'; }
      return 'boing';
    }
    collarTouch() {
      const now = nowMs();
      const messed = now - (this._collarAt || 0) < 700;
      this._collarAt = now;
      if (messed) { if (!this.selfFix) this.startSelfFix('collar', 1500); return 'messed'; }
      this.collarPleasedUntil = now + 1600;
      return 'tidied';
    }
    hatKnock() {
      const now = nowMs();
      const again = this.hatTilt && now - this.hatTilt.start < 10000;
      this.hatTilt = {start:now, side:Math.random() < .5 ? -1 : 1, fixAt:now + 2200};
      return again ? 'again' : 'knocked';
    }

    // He tidies himself up: one free hand to the spot for a moment.
    startSelfFix(target, ms=1400) {
      const side = this._handBusy('right') ? (this._handBusy('left') ? null : 'left') : 'right';
      if (!side) return false;
      const pick = id => { const e = this.q(id); return e && e.getBoundingClientRect(); };
      let r = null, yk = .5;
      if (target === 'brow') r = pick(side === 'right' ? 'motion-brow-right' : 'motion-brow-left');
      else if (target === 'hat') { r = ['hat-city','hat-pirate','hat-gown','hat-garden','hat-barbour','hat-maid'].map(pick).find(b => b && b.width); yk = .8; }
      else if (target === 'ahoge') { r = pick('motion-hair-tuft-top-left'); yk = .75; }
      else if (target === 'eye') r = pick(side === 'right' ? 'motion-eye-right' : 'motion-eye-left');
      else if (target === 'collar') { const h = pick('g-head-back'); if (h) r = {left:h.left + h.width * .45, width:h.width * .1, top:h.bottom, height:20}; }
      if (!r || !r.width) return false;
      const hand = this.q(`motion-hand-${side}`);
      if (!hand || !hand.parentNode || !hand.parentNode.getScreenCTM) return false;
      const hb = hand.getBoundingClientRect();
      const inv = hand.parentNode.getScreenCTM().inverse();
      const p0 = new DOMPoint(hb.left + hb.width / 2, hb.top + hb.height / 2).matrixTransform(inv);
      const p1 = new DOMPoint(r.left + r.width / 2, r.top + r.height * yk).matrixTransform(inv);
      this.selfFix = {target, side, start:nowMs(), ms, dx:p1.x - p0.x, dy:p1.y - p0.y};
      return true;
    }

    // Bend the tail like a tail: the tip is carried round with the middle
    // (about the middle's joint) and then bends on from there, so the pieces
    // stay joined instead of each turning about its own point.
    _bendTail(midDeg, tipDeg) {
      const mid = this.q('motion-tail-mid'), tip = this.q('motion-tail-tip');
      if (!mid || !tip) return;
      const pv = el => String(el.getAttribute('data-pivot') || '0,0').split(',').map(Number);
      const [mx, my] = pv(mid), [tx, ty] = pv(tip);
      this._appendTransform(mid, `rotate(${midDeg.toFixed(1)}deg)`);
      this._appendTransform(tip, `translate(${(mx - tx).toFixed(1)}px,${(my - ty).toFixed(1)}px) rotate(${midDeg.toFixed(1)}deg) translate(${(tx - mx).toFixed(1)}px,${(ty - my).toFixed(1)}px) rotate(${tipDeg.toFixed(1)}deg)`);
    }

    _aimHands(cx, cy, spread=.5) {
      const aim = {};
      [['left', -1], ['right', 1]].forEach(([side, sign]) => {
        const hand = this.q(`motion-hand-${side}`);
        if (!hand || !hand.parentNode || !hand.parentNode.getScreenCTM) return;
        const hb = hand.getBoundingClientRect();
        const inv = hand.parentNode.getScreenCTM().inverse();
        const p0 = new DOMPoint(hb.left + hb.width / 2, hb.top + hb.height / 2).matrixTransform(inv);
        const p1 = new DOMPoint(cx + sign * hb.width * spread, cy).matrixTransform(inv);
        aim[side] = [p1.x - p0.x, p1.y - p0.y];
      });
      return aim;
    }

    _tears() {
      if (this._tearsEl !== undefined) return this._tearsEl;
      const head = this.q('motion-head-root');
      if (!head || !this.svg.ownerDocument) return (this._tearsEl = null);
      const g = this.svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('id', 'fx-tears');
      g.setAttribute('display', 'none');
      g.setAttribute('pointer-events', 'none');
      const drop = 'M0 -14 C6 -4 10 2 10 8 C10 14 5 18 0 18 C-5 18 -10 14 -10 8 C-10 2 -6 -4 0 -14Z';
      g.innerHTML = [0, 1, 2, 3].map(i => `<path class="tear" data-i="${i}" d="${drop}" fill="#9fd3f5" stroke="#5aa7d8" stroke-width="3"/>`).join('');
      head.appendChild(g);
      return (this._tearsEl = g);
    }

    // Came down from much too high: sat in a heap on the floor, legs splayed,
    // face in his hands. He can't move for a few seconds.
    // opts.cry: it hurt more than his pride will say: he sobs behind his hands.
    hardLanding(ms=4200 + Math.random() * 2400, opts={}) {
      if (this.held || this.state === 'sleep') return false;
      this.slumpCry = !!opts.cry;
      if (this.antic) this.stopAntic && this.stopAntic();
      this.treadmill = null;
      this.seatTarget = 0;
      this.slumpStart = nowMs();
      this.slumpUntil = this.slumpStart + ms;
      this._slumpAim = null;
      this._emit('body-reaction', 'hard-landing');
      return true;
    }

    _tuckedTip() {
      if (this._tuckTipEl !== undefined) return this._tuckTipEl;
      const root = this.q('character-motion-root'), legs = this.q('outfits-root'), src = this.q('tail-tip');
      if (!root || !legs || !src || !this.svg.ownerDocument) return (this._tuckTipEl = null);
      const NS = 'http://www.w3.org/2000/svg';
      const g = this.svg.ownerDocument.createElementNS(NS, 'g');
      g.setAttribute('id', 'fx-tail-tucked');
      g.setAttribute('display', 'none');
      g.setAttribute('fill', '#f2b570');
      g.setAttribute('pointer-events', 'none');
      const path = this.svg.ownerDocument.createElementNS(NS, 'path');
      path.setAttribute('d', src.getAttribute('d'));
      g.appendChild(path);
      root.insertBefore(g, legs.nextSibling);         // in front of his trousers, curled up between them
      return (this._tuckTipEl = g);
    }

    _angelHalo() {
      if (this._haloEl !== undefined) return this._haloEl;
      const head = this.q('motion-head-root');
      if (!head || !this.svg.ownerDocument) return (this._haloEl = null);
      const NS = 'http://www.w3.org/2000/svg';
      const g = this.svg.ownerDocument.createElementNS(NS, 'g');
      g.setAttribute('id', 'fx-angel-halo');
      g.setAttribute('display', 'none');
      g.setAttribute('pointer-events', 'none');
      const [cx, cy] = this.HALO_AT || [386, -470];
      g.innerHTML = `<ellipse cx="${cx}" cy="${cy}" rx="150" ry="36" fill="none" stroke="#fff3b8" stroke-width="30" opacity=".45"/>`
        + `<ellipse cx="${cx}" cy="${cy}" rx="150" ry="36" fill="none" stroke="#e9c75f" stroke-width="14"/>`
        + `<ellipse cx="${cx}" cy="${cy - 3}" rx="146" ry="32" fill="none" stroke="#fff6cf" stroke-width="4"/>`;
      head.appendChild(g);
      return (this._haloEl = g);
    }

    _handEdge(on) {
      if (!this.svg || !this.svg.ownerDocument) return;
      if (on && !this.q('fx-hand-edge')) {
        const NS = 'http://www.w3.org/2000/svg', doc = this.svg.ownerDocument;
        let defs = this.svg.querySelector('defs');
        if (!defs) { defs = doc.createElementNS(NS, 'defs'); this.svg.insertBefore(defs, this.svg.firstChild); }
        const f = doc.createElementNS(NS, 'filter');
        f.setAttribute('id', 'fx-hand-edge');
        f.setAttribute('x', '-20%'); f.setAttribute('y', '-20%'); f.setAttribute('width', '140%'); f.setAttribute('height', '140%');
        f.innerHTML = '<feMorphology in="SourceAlpha" operator="dilate" radius="3.5" result="grow"/>'
          + '<feFlood flood-color="#b98a72" flood-opacity=".9"/><feComposite in2="grow" operator="in" result="edge"/>'
          + '<feMerge><feMergeNode in="edge"/><feMergeNode in="SourceGraphic"/></feMerge>';
        defs.appendChild(f);
      }
      ['motion-hand-left','motion-hand-right'].forEach(id => {
        const el = this.q(id); if (!el) return;
        if (on) el.setAttribute('filter', 'url(#fx-hand-edge)'); else el.removeAttribute('filter');
      });
    }

    _slumped(now=nowMs()) {
      if (this.slumpUntil && (now >= this.slumpUntil || this.held)) { this.slumpUntil = 0; this._slumpAim = null; }
      return !!this.slumpUntil && now < this.slumpUntil;
    }

    // Flustered: deep blush, hands over it, a step back.
    fluster(ms=2600) {
      this.flusterStart = nowMs();
      this.flusterUntil = this.flusterStart + ms;
      this._flusterAim = null;                       // re-aim the hands at the spot
      this._emit('body-reaction', 'fluster');
    }

    // Hands: stroking one (back and forth over it), not poking it.
    _isHandPoint(event) {
      const x = Number(event.clientX), y = Number(event.clientY);
      return ['left','right'].some(side => {
        const el = this.q(`motion-hand-${side}`);
        const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        return r && r.width > 6 && x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 6 && y <= r.bottom + 6;
      });
    }

    // The cursor resting on one of his hands: after a while he quietly holds it.
    // The moment it moves, he lets go as if burnt.
    _trackHandHold(event) {
      const now = nowMs();
      const x = Number(event.clientX), y = Number(event.clientY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const hh = this._handHover;
      if (!hh || Math.hypot(x - hh.x, y - hh.y) > 10) {
        if (hh && hh.gripAt) this._letGoOfHand();
        this._handHover = {x, y, since:now, gripAt:0, side:null};
      }
    }

    // Which hand (if either) is under the resting cursor right now.
    _handUnder(x, y) {
      return ['left','right'].find(sd => {
        const el = this.q(`motion-hand-${sd}`);
        const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        return r && r.width > 6 && x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 8 && y <= r.bottom + 8;
      }) || null;
    }

    // Playing with his tail. The cursor near the tip: the tip can't help following
    // it (his face stays straight). Stroking along the tail, root to tip: it
    // fluffs and he half-melts; tip to root: it puffs up and he yelps.
    _tailPoints() {
      const root = this.q('motion-tail-base'), tip = this.q('g-tail-tip');
      if (!root || !tip || !root.parentNode || !root.parentNode.getScreenCTM) return null;
      const p = new DOMPoint(470, 455).matrixTransform(root.parentNode.getScreenCTM());
      const t = tip.getBoundingClientRect();
      if (!t.width) return null;
      return {root:{x:p.x, y:p.y}, tip:{x:t.left + t.width / 2, y:t.top + t.height / 2}, tipR:Math.max(t.width, t.height) / 2};
    }

    // Small things he does instead of saying them (line pools write '@name').
    act(name) {
      const now = nowMs();
      if (this.state === 'sleep' || this.held || this._isActuallyHeld && this._isActuallyHeld()) return false;
      const away = () => {
        const tx = this.attention && this.attention.strength > .05 ? this.attention.targetX : (Math.random() < .5 ? -1 : 1);
        return tx > 0 ? -1 : 1;                          // the side away from her
      };
      if (name === 'lookaway' || name === 'ignore' || name === 'turnback') {
        const long = name === 'turnback';
        this.lookAway = {start:now, until:now + (long ? 5200 : name === 'ignore' ? 3200 : 2600), side:away(), down:long};
      } else if (name === 'hidehands') {
        this.handsHidden = {start:now, until:now + 4200 + Math.random() * 2000};
      } else if (name === 'reach') {
        this.handReach = {start:now, until:now + 6000, side:away() > 0 ? 'left' : 'right'};
      } else if (name === 'puzzledhand') {
        this.lookHand = {start:now, until:now + 900};
        this.puzzledUntil = now + 2600;
      } else if (name === 'peek') {
        if (this._slumped && this._slumped(now)) this.slumpPeek = {start:now, until:now + 1600};
      } else if (name === 'rubeyes') {
        this.startSelfFix && this.startSelfFix('eye', 1500);
      } else if (name === 'glare') {
        this.glareUntil = now + 2600;
      } else return false;
      return true;
    }

    _renderActs(now) {
      const ease = (a, total, inMs=260, outMs=320) => clamp(Math.min((now - a.start) / inMs, (a.until - now) / outMs), 0, 1);
      const show = (id, on) => this._display(this.q(id), on);
      // How he takes being held, as a face: content (eyes shut, a small smile), shy (eyes
      // away, very pink, a hand half over his mouth) or cross with it (brows down, a pout,
      // arms folded, the angry mark). side = which way his head tips.
      const heldFace = (style, side, k) => {
        if (k <= .3) return;
        if (style !== 'content' && style !== 'doze') {
          // Eyes-open moods: undo whatever a sleepier mood left (shut eyes, Zz).
          show('expression-closed-eyes', false); show('motion-eye-left', true); show('motion-eye-right', true);
          if (this._dozeZz) { this._dozeZz = false; show('fx-zz', false); }
        }
        if (style === 'squirm') {
          // Had enough: wriggling to be put down. Not frightened, just done.
          const t = now / 1000;
          if (this.attention) { this.attention.targetX = side * 14; this.attention.targetY = 6; this.attention.strength = 1; }
          this._appendTransform(this.q('character-motion-root'), `rotate(${(Math.sin(t * 7) * 3).toFixed(2)}deg)`);
          this._appendTransform(this.q('motion-hand-left'), `translate(${(-30 * k).toFixed(1)}px,${(-40 * k + Math.sin(t * 7) * 8).toFixed(1)}px)`);
          this._appendTransform(this.q('motion-hand-right'), `translate(${(30 * k).toFixed(1)}px,${(-40 * k + Math.sin(t * 7 + 1.4) * 8).toFixed(1)}px)`);
          show('fx-blush-deep', true);
          if (this.viseme === 'idle') { this._hideAllMouths(); show('g-mouth-pout', true); }
          this._heldFace = true;
          return;
        }
        if (style === 'doze') {
          show('motion-eye-left', false); show('motion-eye-right', false); show('expression-closed-eyes', true);
          show('fx-zz', true);
          this._appendTransform(this.q('motion-head-root'), `rotate(${(side * 10 * k).toFixed(2)}deg) translateY(${(6 * k).toFixed(1)}px)`);
          this._heldFace = true; this._dozeZz = true;
          return;
        }
        if (style === 'cool') {
          // He lets her, but there's nothing in it: eyes wandering, no colour, no smile.
          const t = now / 1000;
          if (this.attention) { this.attention.targetX = side * 12 + Math.sin(t * .4) * 6; this.attention.targetY = 6; this.attention.strength = 1; }
          this._appendTransform(this.q('motion-head-root'), `rotate(${(side * 3).toFixed(2)}deg)`);
          this._heldFace = true;
          return;
        }
        if (style === 'curious') {
          // Settled in her arms like a kitten, looking about at everything.
          const t = now / 1000;
          if (this.attention) { this.attention.targetX = Math.sin(t * .9) * 18; this.attention.targetY = Math.cos(t * .7) * 8; this.attention.strength = 1; }
          this._appendTransform(this.q('motion-head-root'), `rotate(${(side * 4 + Math.sin(t * .9) * 5).toFixed(2)}deg)`);
          if (this.viseme === 'idle' && Math.sin(t * .5) > .7) { this._hideAllMouths(); show('g-mouth-open-small', true); }
          this._heldFace = true;
          return;
        }
        this._appendTransform(this.q('motion-head-root'), `rotate(${(side * 7 * k).toFixed(2)}deg)`);
        show('fx-blush-deep', true);
        if (style === 'content') {
          show('motion-eye-left', false); show('motion-eye-right', false); show('expression-closed-eyes', true);
          if (this.viseme === 'idle') { this._hideAllMouths(); show('g-mouth-smile', true); }
        } else if (style === 'shy') {
          if (this.attention) { this.attention.targetX = side * 16; this.attention.targetY = 4; this.attention.strength = 1; }
          this._appendTransform(this.q(side > 0 ? 'motion-hand-left' : 'motion-hand-right'), `translate(${(side * 90 * k).toFixed(1)}px,${(-200 * k).toFixed(1)}px)`);
        } else {
          show('desktop-angry-mark', true);
          this._appendTransform(this.q('motion-brow-left'), 'translate(6px,4px) rotate(14deg)');
          this._appendTransform(this.q('motion-brow-right'), 'translate(-6px,4px) rotate(-14deg)');
          if (this.viseme === 'idle') { this._hideAllMouths(); show('g-mouth-pout', true); }
          this._appendTransform(this.q('motion-hand-left'), `translate(${(85 * k).toFixed(1)}px,${(-50 * k).toFixed(1)}px)`);
          this._appendTransform(this.q('motion-hand-right'), `translate(${(-85 * k).toFixed(1)}px,${(-40 * k).toFixed(1)}px)`);
        }
        this._heldFace = true;
      };
      const clearHeldFace = () => {
        if (!this._heldFace) return;
        this._heldFace = false;
        if (this._dozeZz) { this._dozeZz = false; show('fx-zz', false); }
        show('expression-closed-eyes', false); show('motion-eye-left', true); show('motion-eye-right', true); show('fx-blush-deep', false);
        show('desktop-angry-mark', !!this.sulk);
        if (this.attention) { this.attention.targetX = this.attention.targetY = 0; this.attention.strength = 0; }
        if (typeof this._applyFace === 'function') this._applyFace();
      };
      // Hugged: a squeeze, his head tips one way, and he takes it his way.
      const hugging = this.hugUntil && now < this.hugUntil;
      if (hugging) {
        const k = smoothstep(clamp(Math.min((now - this.hugStart) / 220, (this.hugUntil - now) / 400), 0, 1));
        this._appendTransform(this.q('character-motion-root'), `translateY(${(5 * k).toFixed(1)}px) scale(${(1 - .05 * k).toFixed(3)},${(1 - .03 * k).toFixed(3)})`);
        if (!['cross', 'squirm'].includes(this.hugStyle)) {
          this._appendTransform(this.q('motion-hand-left'), `translate(${(40 * k).toFixed(1)}px,${(-10 * k).toFixed(1)}px)`);
          this._appendTransform(this.q('motion-hand-right'), `translate(${(-40 * k).toFixed(1)}px,${(-10 * k).toFixed(1)}px)`);
        }
        this._appendTransform(this.q('tail-root'), `rotate(${(12 * k).toFixed(1)}deg)`);
        heldFace(this.hugStyle || 'content', this.hugSide || 1, k);
        this._hugEyes = true;
      } else if (this._hugEyes) {
        this._hugEyes = false; this.hugUntil = 0;
        clearHeldFace();
      }
      // Cradled in her arms: knees up, leaning back a little, hands together, eyes shut.
      if (this.cradle && this.cradleMood === 'panic') {
        // He doesn't trust her arms: kicking, pushing her off, eyes screwed shut.
        const k = smoothstep(clamp((now - this.cradle.start) / 250, 0, 1));
        const s1 = Math.sin(now / 1000 * 13), s2 = Math.sin(now / 1000 * 13 + 1.7);
        this._appendTransform(this.q('character-motion-root'), `rotate(${(4 * s1 * k).toFixed(2)}deg) translateX(${(3 * s2 * k).toFixed(1)}px)`);
        this._legTransform('left', 28 * s1 * k, -20 * k);
        this._legTransform('right', -28 * s2 * k, -20 * k);
        this._appendTransform(this.q('motion-hand-left'), `translate(${(-40 * k).toFixed(1)}px,${(-60 * k + 12 * s2).toFixed(1)}px)`);
        this._appendTransform(this.q('motion-hand-right'), `translate(${(40 * k).toFixed(1)}px,${(-60 * k + 12 * s1).toFixed(1)}px)`);
        if (this.state !== 'sleep') this.squeezeUntil = Math.max(this.squeezeUntil || 0, now + 150);
        this._cradlePanic = true;
      } else if (this.cradle) {
        const tense = this.cradleMood === 'tense';
        const k = smoothstep(clamp((now - this.cradle.start) / 350, 0, 1));
        const side = this.cradle.side || -1;
        const sway = Math.sin(now / 1000 * 1.4) * 1.5 * k + (tense ? Math.sin(now / 1000 * 22) * .8 * k : 0);
        this._appendTransform(this.q('character-motion-root'), `rotate(${(side * 9 * k + sway).toFixed(2)}deg) translateY(${(-6 * k).toFixed(1)}px)`);
        if (this.cradle.style === 'squirm') {
          const t = now / 1000;
          this._legTransform('left', -10 * k + Math.sin(t * 8) * 16 * k, -30 * k);
          this._legTransform('right', 10 * k + Math.sin(t * 8 + 1.6) * 16 * k, -30 * k);
        } else {
          this._legTransform('left', -18 * k, -46 * k);
          this._legTransform('right', 18 * k, -46 * k);
        }
        if (tense || ['content', 'curious', 'cool', 'doze'].includes(this.cradle.style || 'content') || this.state === 'sleep') {   // hands together on his chest
          this._appendTransform(this.q('motion-hand-left'), `translate(${(70 * k).toFixed(1)}px,${(-30 * k).toFixed(1)}px)`);
          this._appendTransform(this.q('motion-hand-right'), `translate(${(-70 * k).toFixed(1)}px,${(-30 * k).toFixed(1)}px)`);
        }
        this._appendTransform(this.q('tail-root'), `rotate(${(25 * k).toFixed(1)}deg)`);
        if (this.state !== 'sleep' && !tense) { heldFace(this.cradle.style || 'content', side, k); this._cradleEyes = true; }
      } else if (this._cradleEyes || this._cradlePanic) {
        this._cradlePanic = false;
        this._cradleEyes = false;
        clearHeldFace();
        this._legTransform('left', 0, 0); this._legTransform('right', 0, 0);
      }
      const la = this.lookAway;
      if (la) {
        if (now >= la.until) { this.lookAway = null; if (this.attention) { this.attention.targetX = this.attention.targetY = 0; this.attention.strength = 0; } }
        else {
          const k = smoothstep(ease(la, 0));
          // Eyes and head both away from her; a long one hangs his head too.
          if (this.attention) { this.attention.targetX = la.side * 16; this.attention.targetY = la.down ? 9 : 2; this.attention.strength = 1; }
          this._appendTransform(this.q('motion-head-root'), `rotate(${(la.side * 9 * k).toFixed(2)}deg) translateX(${(la.side * 8 * k).toFixed(1)}px)${la.down ? ` translateY(${(7 * k).toFixed(1)}px)` : ''}`);
          this._appendTransform(this.q('character-motion-root'), `translateX(${(la.side * 3 * k).toFixed(1)}px)`);
        }
      }
      const hh = this.handsHidden;
      if (hh) {
        if (now >= hh.until) this.handsHidden = null;
        else {
          const k = smoothstep(ease(hh, 0, 300, 380));
          this._appendTransform(this.q('motion-hand-left'), `translate(${(112 * k).toFixed(1)}px,${(48 * k).toFixed(1)}px)`);
          this._appendTransform(this.q('motion-hand-right'), `translate(${(-112 * k).toFixed(1)}px,${(48 * k).toFixed(1)}px)`);
        }
      }
      const hr = this.handReach;
      if (hr) {
        if (now >= hr.until) this.handReach = null;
        else {
          const k = smoothstep(ease(hr, 0, 600, 400));
          const sign = hr.side === 'left' ? -1 : 1;
          this._appendTransform(this.q(`motion-hand-${hr.side}`), `translate(${(sign * 58 * k).toFixed(1)}px,${(30 * k).toFixed(1)}px) rotate(${(sign * -16 * k).toFixed(1)}deg)`);
        }
      }
      const lh = this.lookHand;
      if (lh) {
        if (now >= lh.until) { this.lookHand = null; if (this.attention) { this.attention.targetX = this.attention.targetY = 0; this.attention.strength = 0; } }
        else {
          const k = smoothstep(ease(lh, 0, 200, 250));
          if (this.attention) { this.attention.targetX = 4; this.attention.targetY = 14; this.attention.strength = 1; }
          this._appendTransform(this.q('motion-head-root'), `translateY(${(8 * k).toFixed(1)}px) rotate(${(6 * k).toFixed(1)}deg)`);
        }
      }
      if (this.glareUntil) {
        if (now >= this.glareUntil) { this.glareUntil = 0; this._display(this.q('desktop-angry-mark'), !!this.sulk); }
        else {
          this._display(this.q('desktop-angry-mark'), true);
          this._appendTransform(this.q('motion-brow-left'), 'translate(6px,4px) rotate(14deg)');
          this._appendTransform(this.q('motion-brow-right'), 'translate(-6px,4px) rotate(-14deg)');
        }
      }
    }

    tailAway(ms=7000) {
      const now = nowMs();
      if (!(this.tailAwayUntil && now < this.tailAwayUntil)) this.tailAwayStart = now;
      this.tailAwayUntil = now + ms;
      this._tailTease = null; this._tailStroke = null;
      if (this.onTailAway) this.onTailAway();
    }

    _trackTailPlay(event) {
      if (this.state === 'sleep' || this.held || this.blanket) return;
      const now = nowMs();
      const x = Number(event.clientX), y = Number(event.clientY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const tp = this._tailPoints();
      if (!tp) return;
      const dTip = Math.hypot(x - tp.tip.x, y - tp.tip.y);
      if (this.sulk) {
        // Cross with her: hands off the tail. It goes to his other side.
        const onIt = ['g-tail-base','g-tail-mid','g-tail-tip'].some(id => {
          const el = this.q(id); const r = el && el.getBoundingClientRect();
          return r && r.width && x >= r.left - 10 && x <= r.right + 10 && y >= r.top - 10 && y <= r.bottom + 10;
        });
        if (onIt) this.tailAway();
        return;
      }
      // Teasing: near the tip, but not on him.
      if (dTip < tp.tipR + 120 && dTip > tp.tipR * .4) {
        const te = this._tailTease || (this._tailTease = {total:0, last:now});
        if (now - te.last < 400) te.total += now - te.last;
        te.last = now; te.x = x; te.y = y;
        if (te.total > 4000 && !te.noticed) { te.noticed = true; this.tailNoticedUntil = now + 2200; if (this.onTailNoticed) this.onTailNoticed(); }
      }
      // Stroking along it.
      const onTail = ['g-tail-base','g-tail-mid','g-tail-tip'].some(id => {
        const el = this.q(id); const r = el && el.getBoundingClientRect();
        return r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      });
      const st = this._tailStroke;
      if (!onTail) { this._tailStroke = null; return; }
      const ax = tp.tip.x - tp.root.x, ay = tp.tip.y - tp.root.y, len = Math.hypot(ax, ay) || 1;
      if (!st || now - st.at > 350) { this._tailStroke = {x, y, at:now, along:0, start:now}; return; }
      st.along += ((x - st.x) * ax + (y - st.y) * ay) / len;
      st.x = x; st.y = y; st.at = now;
      if (now - st.start > 1400) { st.start = now; st.along = 0; }
      if (st.along > 110) {
        this._tailStroke = null;
        this.tailFluffUntil = now + 1700;
        if (this.onTailStroke) this.onTailStroke(true);
      } else if (st.along < -110) {
        this._tailStroke = null;
        this.tailPuffUntil = now + 2000;
        if (typeof this.startleFromPoke === 'function') this.startleFromPoke({duration:900});
        this.squeezeUntil = Math.max(this.squeezeUntil || 0, now + 1000);   // fur the wrong way: a >< wince
        if (this.onTailStroke) this.onTailStroke(false);
      }
    }

    _letGoOfHand() {
      const hh = this._handHover;
      this._handHover = null;
      if (hh && hh.gripAt) {
        this._handLetGoAt = nowMs();
        this._emit('body-reaction', 'hand-let-go');
        if (this.onHandLetGo) this.onHandLetGo(nowMs() - hh.gripAt);
      }
    }

    _trackHandRub(event) {
      const now = nowMs();
      if (!this._isHandPoint(event) || now < (this._handRubCooldownUntil || 0)) { this._handTrack = null; return false; }
      const x = Number(event.clientX), y = Number(event.clientY);
      let track = this._handTrack;
      if (!track || now - track.lastAt > 560) { this._handTrack = {lastX:x, lastY:y, lastAt:now, travel:0, turns:0, lastDir:0}; return false; }
      const dx = x - track.lastX, dy = y - track.lastY;
      track.lastX = x; track.lastY = y; track.lastAt = now;
      const along = Math.abs(dx) >= Math.abs(dy) ? dx : dy;   // any direction will do on a hand
      if (Math.abs(along) < 1.2) return false;
      const dir = along < 0 ? -1 : 1;
      track.travel += Math.abs(along);
      if (track.lastDir && dir !== track.lastDir) track.turns += 1;
      track.lastDir = dir;
      if (track.travel >= 26 && track.turns >= 2) {
        this._handTrack = null;
        this._handRubCooldownUntil = now + 1800;
        this.puzzledUntil = now + 1900;
        this.puzzledQuiet = false;
        this._emit('body-reaction', 'hand-rub');
        if (this.onHandRub) this.onHandRub();
        return true;
      }
      return false;
    }

    // Belly: the middle of his body (the same back-and-forth rub as a head pat).
    _isBellyPoint(event) {
      if (this._isCrotchPoint(event)) return false;
      const el = this.q('torso-root');
      const rect = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!rect || rect.width < 10) return false;
      const x = Number(event.clientX), y = Number(event.clientY);
      return x >= rect.left + rect.width * .18 && x <= rect.left + rect.width * .82
        && y >= rect.top + rect.height * .2 && y <= rect.top + rect.height * .9;
    }

    _trackBellyRub(event) {
      const now = nowMs();
      if (!this._isBellyPoint(event) || now < (this._bellyCooldownUntil || 0)) { this._bellyTrack = null; return false; }
      const x = Number(event.clientX), y = Number(event.clientY);
      let track = this._bellyTrack;
      if (!track || now - track.lastAt > 560) {
        this._bellyTrack = {lastX:x, lastY:y, lastAt:now, travel:0, turns:0, lastDir:0};
        return false;
      }
      const dx = x - track.lastX, dy = y - track.lastY;
      track.lastX = x; track.lastY = y; track.lastAt = now;
      const along = Math.abs(dx) >= Math.abs(dy) ? dx : dy;   // side to side or up and down
      if (Math.abs(along) < 1.5) return false;
      const dir = along < 0 ? -1 : 1;
      track.travel += Math.abs(along);
      if (track.lastDir && dir !== track.lastDir) track.turns += 1;
      track.lastDir = dir;
      if (track.travel >= 44 && track.turns >= 2) {
        this._bellyTrack = null;
        this._bellyCooldownUntil = now + 1400;
        this._startPartReaction('torso-poke', 520);
        this._emit('body-reaction', 'belly-rub');
        if (this.onBellyRub) this.onBellyRub();
        return true;
      }
      return false;
    }

    _isActuallyHeld() { return this.hostCarry || !!(this.held && this.held.mode === 'drag' && !this.held.wasPat); }

    _activeHeadPat() {
      return this.partReaction && this.partReaction.type === 'head-pat' ? this.partReaction : null;
    }

    _continueHeadPat(event) {
      const reaction = this._activeHeadPat();
      if (!reaction || reaction.realizing || !this._isHeadPatPoint(event)) return false;
      const now = nowMs();
      const x = Number(event.clientX), y = Number(event.clientY);
      const dx = Number.isFinite(reaction.lastPointerX) ? x - reaction.lastPointerX : 0;
      const dy = Number.isFinite(reaction.lastPointerY) ? y - reaction.lastPointerY : 0;
      reaction.lastPointerX = x;
      reaction.lastPointerY = y;
      reaction.lastContactAt = now;
      if (Math.abs(dx) > Math.abs(dy) * 1.15) reaction.strokePhase += dx * .045;
      return true;
    }

    _trackHeadPat(event, pressed=false) {
      const now = nowMs();
      if (this._activeHeadPat()) return this._continueHeadPat(event);
      if (now < this._headPatCooldownUntil || !this._isHeadPatPoint(event)) {
        if (!pressed) this._resetHeadPatTrack();
        return false;
      }
      const x = Number(event.clientX), y = Number(event.clientY);
      let track = this._headPatTrack;
      if (!track || now - track.lastAt > 560 || track.pointerId !== event.pointerId) {
        this._headPatTrack = {pointerId:event.pointerId, lastX:x, lastY:y, lastAt:now, travel:0, turns:0, lastDir:0};
        return false;
      }
      const dx = x - track.lastX, dy = y - track.lastY;
      track.lastX = x; track.lastY = y; track.lastAt = now;
      if (Math.abs(dx) < 1.5 || Math.abs(dx) < Math.abs(dy) * 1.25) return false;
      const dir = dx < 0 ? -1 : 1;
      track.travel += Math.abs(dx);
      if (track.lastDir && dir !== track.lastDir) track.turns += 1;
      track.lastDir = dir;
      if (track.travel >= 38 && track.turns >= 1) {
        this.triggerHeadPat({source:pressed ? 'pressed-rub' : 'hover-rub', pointerId:event.pointerId, clientX:x, clientY:y});
        this._resetHeadPatTrack();
        return true;
      }
      return false;
    }

    _startPartReaction(type, duration=760) {
      if (this._activeHeadPat() && (type === 'hover-curious' || type === 'hover-nuzzle')) return this.partReaction;
      if (this._reactionFaceActive) this._applyFace();
      this._reactionFaceActive = false;
      this.partReaction = {type, start:nowMs(), duration};
      this._emit('body-reaction', type);
      return this.partReaction;
    }

    triggerHeadPat(options={}) {
      const active = this._activeHeadPat();
      if (active && !active.realizing) {
        active.lastContactAt = nowMs();
        return active.pleasantMs;
      }
      this.dismissGloom({silent:true});
      const now = nowMs();
      const requested = Number(options.pleasantMs != null ? options.pleasantMs : options.duration);
      const pleasantMs = Number.isFinite(requested)
        ? clamp(requested, HEAD_PAT_MIN_PLEASURE_MS, HEAD_PAT_MAX_PLEASURE_MS)
        : HEAD_PAT_MIN_PLEASURE_MS + Math.random() * (HEAD_PAT_MAX_PLEASURE_MS - HEAD_PAT_MIN_PLEASURE_MS);
      const openLeft = Math.max(0, this.desktopX - this.walkBounds[0]);
      const openRight = Math.max(0, this.walkBounds[1] - this.desktopX);
      const pointerSide = Math.sign(this.attention.targetX || 0);
      const preferredDirection = pointerSide ? -pointerSide : openRight >= openLeft ? 1 : -1;
      const preferredRoom = preferredDirection > 0 ? openRight : openLeft;
      const retreatDirection = options.retreatDirection === -1 || options.retreatDirection === 1
        ? options.retreatDirection
        : preferredRoom >= 90 ? preferredDirection : -preferredDirection;
      const startDesktopX = this.desktopX;
      const targetDesktopX = clamp(startDesktopX + retreatDirection * 150, this.walkBounds[0], this.walkBounds[1]);
      const source = options.source || 'direct';
      const autoSustain = options.autoSustain === true || source === 'button' || source === 'tap' || source === 'direct';
      const duration = pleasantMs + HEAD_PAT_REALIZE_MS + HEAD_PAT_RETREAT_MS;
      if (this._reactionFaceActive) this._applyFace();
      this._reactionFaceActive = false;
      this.walkMotion = null;
      this.partReaction = {
        type:'head-pat', start:now, duration, pleasantMs,
        realizationAt:now + pleasantMs,
        retreatAt:now + pleasantMs + HEAD_PAT_REALIZE_MS * .72,
        endAt:now + duration,
        lastContactAt:now,
        lastPointerX:Number(options.clientX),
        lastPointerY:Number(options.clientY),
        strokePhase:0,
        source,
        autoSustain,
        realizing:false,
        startDesktopX,
        targetDesktopX,
        retreatDx:targetDesktopX - startDesktopX,
        positionCommitted:false
      };
      this.headPatSession = this.partReaction;
      this.tailAction = {type:'pat', start:now, duration:pleasantMs + 460, pleasantMs};
      this._headPatCooldownUntil = this.partReaction.endAt + 420;
      this._emit('body-reaction', 'head-pat');
      this._emit('desktop-interaction', `head-pat:${options.source || 'direct'}`);
      this._emit('head-pat-window', `${Math.round(pleasantMs)}ms`);
      return pleasantMs;
    }

    _reactToZone(zone, event) {
      // Being poked ends whatever he was absorbed in (and wakes a dozing one).
      if (this.antic && this.antic.long) this.stopAntic(this.antic.type === 'doze' ? 'woken' : 'poked');
      if (zone === 'head-top') {
        this.triggerHeadPat({source:'tap'});
        return;
      }
      if (zone === 'tail') {
        this._startPartReaction('tail-poke', 900);
        this.startleFromPoke({duration:1280});
        return;
      }
      if (zone === 'hand-left' || zone === 'hand-right') {
        this._startPartReaction(zone + '-poke', 720);
        return;
      }
      if (zone === 'foot-left' || zone === 'foot-right') {
        this._startPartReaction(zone + '-poke', 780);
        return;
      }
      if (zone === 'torso') {
        this._startPartReaction('torso-poke', 820);
        return;
      }
      this.startleFromPoke();
      this.requestInteraction('menu', event);
    }

    _bindPointer() {
      if (!this.svg.addEventListener) return;
      const down = event => this._pointerDown(event);
      const move = event => this._pointerMove(event);
      const up = event => this._pointerUp(event);
      const leave = () => this._pointerLeave();
      this._pointerHandlers = {down, move, up, leave};
      this.svg.addEventListener('pointerdown', down);
      this.svg.addEventListener('pointermove', move);
      this.svg.addEventListener('pointerup', up);
      this.svg.addEventListener('pointercancel', up);
      this.svg.addEventListener('pointerleave', leave);
      // A two-finger click is a hug, not WebKit's 'Reload' menu.
      this.svg.addEventListener('contextmenu', event => event.preventDefault());
      // A two-finger swipe that starts on him: she picks him up in her arms.
      this.svg.addEventListener('wheel', event => this._wheel(event), {passive:false});
    }

    _wheel(event) {
      if (event.preventDefault) event.preventDefault();
      if (!this.host || this.held || this.cradle || this.hostCarry || this.hostLeap) return;
      this._wheelSum = (this._wheelSum || 0) + Math.abs(event.deltaX || 0) + Math.abs(event.deltaY || 0);
      if (this._wheelSum < 8) return;
      this._wheelSum = 0;
      this.startCradle();
      this.host.post({type:'cradle-start'});
    }

    // Held in her arms (a two-finger swipe or right-button drag): not dangled.
    startCradle() {
      this.cradle = {start:nowMs(), side:Math.random() < .5 ? -1 : 1, style:'content'};
      this.hostCarry = true;
      this.treadmill = null; this.seatTarget = 0; this.seat = 0;
      if (this.antic && this.antic.long && this.antic.type !== 'doze') this.stopAntic('poked');
      if (this.onCradle) this.onCradle('start');
    }

    // A two-finger click on him: a hug.
    hug(held=false) {
      const now = nowMs();
      if (this.state === 'sleep' && !this.bedAwake) { if (this.stir) this.stir(2500); if (this.onHug) this.onHug('asleep'); return; }
      this.hugStart = now; this.hugUntil = now + (held ? 10 * 60 * 1000 : 2600);
      this.hugHeld = !!held;
      this.hugSide = Math.random() < .5 ? -1 : 1; this.hugStyle = 'content';
      // Comfort: tears dry up sooner.
      if (this.cryUntil && now < this.cryUntil) this.cryUntil = now + 1400;
      if (this.slumpCry && this.slumpUntil > now) this.slumpUntil = Math.min(this.slumpUntil, now + 1800);
      if (this.onHug) this.onHug('awake');
      this._emit('body-reaction', 'hug');
    }

    _pointerDown(event) {
      this.noteActivity();
      if (event.button === 2) return this._hugDown(event);
      if (event.button != null && event.button !== 0) return;
      const t = nowMs();
      this.held = {
        pointerId:event.pointerId,
        startClientX:event.clientX,
        startClientY:event.clientY,
        startX:this.desktopX,
        startY:this.desktopY,
        startedAt:t,
        moved:false,
        mode:'pending',
        zone:this._zoneFromEvent(event),
        patCandidate:this._isHeadPatPoint(event),
        bellyCandidate:!this._isHeadPatPoint(event) && this._isBellyPoint(event),
        handCandidate:this._isHandPoint(event),
        wasPat:false,
        wasRub:false
      };
      this._lastGrab = {zone:this._gripFrom(event, this.held.zone), at:Date.now(), x:Number(event.clientX), y:Number(event.clientY)};
      this.svg.style.cursor = 'pointer';
      if (this.svg.setPointerCapture && event.pointerId != null) {
        try { this.svg.setPointerCapture(event.pointerId); } catch (_error) {}
      }
      if (event.preventDefault) event.preventDefault();
      this._emit('gesture', 'pointer-pending');
    }

    _hugDown(event) {
      this.held = {pointerId:event.pointerId, startClientX:event.clientX, startClientY:event.clientY,
        startX:this.desktopX, startY:this.desktopY, startedAt:nowMs(), moved:false, mode:'pending', cradle:true,
        zone:this._zoneFromEvent(event), wasPat:false, wasRub:false};
      if (this.svg.setPointerCapture && event.pointerId != null) { try { this.svg.setPointerCapture(event.pointerId); } catch (_e) {} }
      if (event.preventDefault) event.preventDefault();
      this.hug(true);                       // the hug starts at the press and lasts while she holds on
    }

    _pointerMove(event) {
      this.noteActivity();
      this._updateAttentionTarget(event);
      const held = this.held;
      if (!held) {
        this._trackHeadPat(event, false);
        this._trackBellyRub(event);
        this._trackHandRub(event);
        this._trackHandHold(event);
        this._trackTailPlay(event);
        this._trackBrowRub(event);
        this._trackCheekRub(event);
        this._earHover(Number(event.clientX), Number(event.clientY));
        return;
      }
      if (held.pointerId != null && event.pointerId != null && held.pointerId !== event.pointerId) return;
      const rect = this.svg.getBoundingClientRect ? this.svg.getBoundingClientRect() : {width:1102,height:1140};
      const sx = 1102 / Math.max(1, rect.width || 1102);
      const sy = 1140 / Math.max(1, rect.height || 1140);
      const dx = (event.clientX - held.startClientX) * sx;
      const dy = (event.clientY - held.startClientY) * sy;
      if (held.wasPat) {
        this._continueHeadPat(event);
        if (event.preventDefault) event.preventDefault();
        return;
      }
      if (held.handCandidate) {
        // Pressed on a hand and stroking it, not picking him up by it.
        if (this._trackHandRub(event)) held.wasRub = true;
        const cdx = Number(event.clientX) - held.startClientX, cdy = Number(event.clientY) - held.startClientY;
        if (Math.hypot(cdx, cdy) > 5) held.rubbing = true;
        if (held.wasRub || (this._isHandPoint(event) && Math.abs(cdx) < 50 && Math.abs(cdy) < 50)) {
          if (event.preventDefault) event.preventDefault();
          return;
        }
        held.handCandidate = false;
      }
      if (held.bellyCandidate) {
        // Pressed on his belly and rubbing, not dragging him off.
        if (this._trackBellyRub(event)) held.wasRub = true;
        const clientDx = Number(event.clientX) - held.startClientX;
        const clientDy = Number(event.clientY) - held.startClientY;
        const stillRubbing = this._isBellyPoint(event) && Math.abs(clientDy) < 26 && Math.abs(clientDx) < 90;
        if (Math.abs(clientDx) > 6) held.rubbing = true;   // a stroke, not a jab
        if (held.wasRub || stillRubbing) {
          if (event.preventDefault) event.preventDefault();
          return;
        }
        held.bellyCandidate = false;
      }
      if (held.patCandidate && !held.wasPat) {
        if (this._trackHeadPat(event, true)) {
          held.wasPat = true;
          held.moved = false;
          this.desktopX = held.startX;
          this.desktopY = held.startY;
        }
        const clientDx = Number(event.clientX) - held.startClientX;
        const clientDy = Number(event.clientY) - held.startClientY;
        const stillRubbing = this._isHeadPatPoint(event) && Math.abs(clientDy) < 24 && Math.abs(clientDx) < 78;
        if (held.wasPat || stillRubbing) {
          if (event.preventDefault) event.preventDefault();
          return;
        }
        held.patCandidate = false;
      }
      const clientDistance = Math.hypot(Number(event.clientX)-held.startClientX, Number(event.clientY)-held.startClientY);
      if (clientDistance >= DRAG_THRESHOLD_PX && held.mode !== 'drag') {
        held.mode = 'drag';
        held.moved = true;
        this.svg.style.cursor = 'grabbing';
        this.dismissGloom({silent:true});
        this.stopDesktopMotion({keepPosition:true, keepEffects:true});
        this.treadmill = null;
        this.seatTarget = 0;
        this.seat = 0;
        if (this.host) {
          if (held.cradle) { this.hugUntil = 0; this.hugHeld = false; this.startCradle(); }
          this.hostCarry = true;
          this.host.post({type:'drag-begin', cradle:!!held.cradle});
        }
        this._emit('gesture', 'drag-start');
      }
      if (held.mode !== 'drag') {
        if (event.preventDefault) event.preventDefault();
        return;
      }
      held.moved = true;
      if (this.host) {
        // The window follows the pointer; he stays put inside it and dangles.
        if (Math.abs(dx) > 4) this.direction = this.facingTarget = dx < 0 ? -1 : 1;
        if (event.preventDefault) event.preventDefault();
        return;
      }
      this.desktopX = clamp(held.startX + dx, this.walkBounds[0] - 90, this.walkBounds[1] + 90);
      this.desktopY = clamp(held.startY + dy, -430, 90);
      if (Math.abs(dx) > 4) this.direction = dx < 0 ? -1 : 1;
      if (Math.abs(dx) > 4) this.facingTarget = this.direction;
      if (event.preventDefault) event.preventDefault();
    }

    _pointerLeave() {
      if (this._handHover) this._letGoOfHand();
      if (this.held) return;
      const headPat = this._activeHeadPat();
      if (headPat && !headPat.autoSustain && !headPat.realizing) headPat.releasedAt = nowMs();
      this._resetHeadPatTrack();
      this.attention.targetX = 0;
      this.attention.targetY = 0;
      this.attention.strength = 0;
      this.hoverIntent = {zone:null,since:0,lastReactionAt:this.hoverIntent.lastReactionAt||0,nuzzled:false};
    }

    _updateAttentionTarget(event) {
      if (!this.proximityGaze || this._isActuallyHeld() || this.state === 'sleep') {
        this.attention.targetX = 0;
        this.attention.targetY = 0;
        this.attention.strength = 0;
        return;
      }
      const head = this.q('motion-head-root');
      const svgRect = this.svg.getBoundingClientRect ? this.svg.getBoundingClientRect() : {left:0,top:0,width:1102,height:1140};
      const headRect = head && head.getBoundingClientRect ? head.getBoundingClientRect() : null;
      const hasHeadRect = headRect && headRect.width > 20 && headRect.height > 20;
      const cx = hasHeadRect ? headRect.left + headRect.width / 2 : svgRect.left + svgRect.width * .376;
      const cy = hasHeadRect ? headRect.top + headRect.height * .53 : svgRect.top + svgRect.height * .36;
      const dx = Number(event.clientX) - cx;
      const dy = Number(event.clientY) - cy;
      const distance = Math.hypot(dx, dy);
      const headSize = hasHeadRect ? Math.max(headRect.width, headRect.height) : Math.min(svgRect.width, svgRect.height) * .34;
      const radius = Math.max(185, headSize * 1.22);
      const inner = Math.max(22, headSize * .07);
      const proximity = clamp((radius - distance) / Math.max(1, radius - inner), 0, 1);
      const strength = Math.pow(smoothstep(proximity), 1.55);
      const length = Math.max(1, distance);
      this.attention.strength = strength;
      const alarm = 6 * strength + 37 * strength * strength;
      this.attention.targetX = dx / length * alarm;
      this.attention.targetY = dy / length * alarm * .82;
      this._updateHoverIntent(event);
    }

    _updateHoverIntent(event) {
      if (this.held || this.state === 'sleep' || event.target === this.svg) return;
      if (this._activeHeadPat()) return;
      const now = nowMs();
      const zone = this._zoneFromEvent(event);
      if (zone !== this.hoverIntent.zone) this.hoverIntent = {zone,since:now,lastReactionAt:this.hoverIntent.lastReactionAt||0,nuzzled:false};
      const dwell = now - this.hoverIntent.since;
      if (dwell > 720 && now - this.hoverIntent.lastReactionAt > 1900 && ['face','head-top','hand-left','hand-right'].includes(zone)) {
        this._startPartReaction('hover-curious', 900);
        this.hoverIntent.lastReactionAt = now;
      }
      if (dwell > 1650 && !this.hoverIntent.nuzzled && ['face','head-top'].includes(zone) && Math.random() < .28) {
        this.hoverIntent.nuzzled = true;
        this._startPartReaction('hover-nuzzle', 1150);
        this._emit('desktop-interaction', 'hover-nuzzle');
      }
      // Stroking his cheek for a while: poker face, just a question mark.
      if (zone === 'face' && dwell > 3200 && now - (this.hoverIntent.lastWonderAt || 0) > 5500) {
        this.hoverIntent.lastWonderAt = now;
        this.puzzledUntil = now + 1700;
        this.puzzledQuiet = true;
      }
    }

    setProximityGaze(on=true) {
      this.proximityGaze = !!on;
      if (!this.proximityGaze) this._pointerLeave();
      this._emit('desktop-attention', this.proximityGaze ? 'on' : 'off');
    }

    blink() {
      const now = nowMs();
      this.blinkStart = now;
      this.blinkDuration = 245;
      this.nextBlink = now + 2200 + Math.random() * 2600;
    }

    _pointerUp(event) {
      const held = this.held;
      if (!held || (held.pointerId != null && event.pointerId != null && held.pointerId !== event.pointerId)) return;
      if (this.svg.releasePointerCapture && held.pointerId != null) {
        try { this.svg.releasePointerCapture(held.pointerId); } catch (_error) {}
      }
      this.svg.style.cursor = 'grab';
      this.held = null;
      this._display(this.q('desktop-angry-mark'), false);
      if (held.cradle && held.mode !== 'drag') {
        // Let go of the hug (a quick tap still gets its moment).
        const now = nowMs(), held2 = this.hugHeld;
        this.hugHeld = false;
        if (this.hugUntil) this.hugUntil = Math.max(now + 350, (this.hugStart || now) + 2600);
        if (held2 && this.onHug) this.onHug('release', now - (this.hugStart || now));
        if (event.preventDefault) event.preventDefault();
        return;
      }
      if (held.wasRub || (held.rubbing && held.mode !== 'drag')) {
        this._applyFace();
        this.desktopY = held.startY;
        this._emit('desktop-action', 'belly-rub-release');
      } else if (held.wasPat) {
        this.desktopX = held.startX;
        this.desktopY = held.startY;
        const headPat = this._activeHeadPat();
        if (headPat && !headPat.realizing && !headPat.autoSustain) headPat.releasedAt = nowMs();
        this._emit('desktop-action', 'head-pat-release');
      } else if (held.mode === 'drag' && held.moved && this.host) {
        // Keep dangling while the window falls; hostLanded() finishes it.
        this.host.post({type:'drag-end'});
        this._emit('desktop-action', 'released');
      } else if (held.mode === 'drag' && held.moved) {
        this._applyFace();
        this._startLanding();
        this._emit('desktop-action', 'released');
      } else if (nowMs() - held.startedAt >= HOLD_MIN_MS) {
        this._applyFace();
        this.desktopY = held.startY;
        this._startPartReaction('hold-curious', 920);
        this.requestInteraction('hold', event);
        this._emit('gesture', 'hold');
      } else {
        this._applyFace();
        this.desktopY = held.startY;
        this._reactToZone(held.zone || this._zoneFromEvent(event), event);
        this._emit('gesture', nowMs() - held.startedAt <= CLICK_MAX_MS ? 'click' : 'slow-click');
      }
      if (event.preventDefault) event.preventDefault();
    }

    requestInteraction(type='menu', event=null) {
      const payload = {
        type,
        anchor: event ? {clientX:event.clientX, clientY:event.clientY} : null,
        snapshot:this.getDesktopSnapshot(),
        options:POKE_MENU_OPTIONS.map(option => ({id:option.id, label:option.label}))
      };
      this.onInteractionRequest(payload);
      this._emit('interaction-request', type);
      return payload;
    }

    acknowledgePoke() {
      this._startPartReaction('hold-curious', 920);
      this._emit('desktop-interaction', 'poke-acknowledged');
      return true;
    }

    walkTo(x, options={}) {
      this.dismissGloom({silent:true});
      const target = clamp(Number(x) || 0, this.walkBounds[0], this.walkBounds[1]);
      if (Math.abs(target - this.desktopX) < 2) {
        this.walkMotion = null;
        this._emit('desktop-action', 'walk-arrived');
        return;
      }
      this.playGuitar(false);
      if (['reading','tea'].includes(this.state)) super.setLifeState('awake');
      this.direction = target < this.desktopX ? -1 : 1;
      this.facingTarget = this.direction;
      this.walkMotion = {target, speed:Number(options.speed) || this.walkSpeed, startedAt:nowMs()};
      this._emit('desktop-action', `walk:${Math.round(target)}`);
    }

    jump(options={}) {
      if (this.held || this.seat > .02) return;
      this.dismissGloom({silent:true});
      this.playGuitar(false);
      this.jumpMotion = {
        start:nowMs(),
        duration:Number(options.duration) || 760,
        height:Number(options.height) || 158
      };
      this.landingMotion = null;
      this._emit('desktop-action', 'jump');
    }

    sweepTail(options={}) {
      this.dismissGloom({silent:true});
      this.tailAction = {
        type:'sweep',
        start:nowMs(),
        duration:Number(options.duration) || 1550
      };
      this._emit('desktop-action', 'tail-sweep');
    }

    startleFromPoke(options={}) {
      this.dismissGloom({silent:true});
      this.tailAction = {
        type:'startle',
        start:nowMs(),
        duration:Number(options.duration) || 1280
      };
      this.playAction('startle');
      this._emit('desktop-action', 'poke-startle');
    }

    _startLanding() {
      this.jumpMotion = null;
      this.landingMotion = {start:nowMs(), duration:520, fromY:this.desktopY};
      this._display(this.q('desktop-landing-dust'), true);
    }

    /// Lying down (asleep or knocked flat), dizzy, mid-air or being carried:
    /// no guitar, no little desktop antics.
    _busyBody(now=nowMs()) {
      return this.state === 'sleep' || !!this.sleepSequence || this._knockedOut(now) || this._dizzy(now)
        || !!this.hostLeap || !!this.hostCarry || !!this.held || this._slumped(now);
    }

    // Under the blanket he stays put; asked to do something, he gets up and folds it first.
    putBlanketAway() {
      if (!this.blanket) return false;
      this.blanket = null;
      this.blanketPutAwayAt = Date.now();
      if (this.antic && this.antic.type === 'doze') this.stopAntic('blanket');
      this._emit('desktop-action', 'blanket-away');
      return true;
    }

    playGuitar(on=true) {
      const next = !!on;
      if (next && this.state !== 'sleep' && this._busyBody()) return false;
      if (next) this.putBlanketAway();
      if (next) this.dismissGloom({silent:true});
      if (next && this.state === 'sleep') {
        this.setLifeState('awake');
        this._emit('activity-blocked', 'guitar:wait-for-waking');
        return false;
      }
      if (next && ['reading','tea'].includes(this.state)) super.setLifeState('awake');
      this.performanceMode = next ? 'guitar' : 'idle';
      if (next) {
        this.walkMotion = null;
        this.jumpMotion = null;
        this.landingMotion = null;
        this.desktopY = 0;
      }
      this._display(this.q('desktop-guitar'), next);
      this._display(this.q('hands-root'), !next);
      this._display(this.q('trench-hands'), false);
      this._applyHandTheme();
      if (!next) this._display(this.q('desktop-music-notes'), false);
      this._emit('desktop-action', next ? 'guitar-on' : 'guitar-off');
      return next;
    }

    sing(sequence='HH EH L OW / DH EH R') {
      this.playGuitar(true);
      const mapped = this.speakArpabet(sequence, 145);
      this.singingUntil = nowMs() + Math.max(1200, mapped.length * 145 + 350);
      this._display(this.q('desktop-music-notes'), true);
      this._emit('desktop-action', 'sing');
      return mapped;
    }

    spawnFlowers() {
      this.dismissGloom({silent:true});
      this.flowerStart = nowMs();
      this._display(this.q('desktop-flowers'), true);
      this._emit('desktop-effect', 'flowers');
    }

    setGloom(on='auto', options={}) {
      this.gloomOverride = on === 'auto' ? null : !!on;
      this.gloomUntil = this.gloomOverride === true
        ? nowMs() + (Number(options.duration) || 3800)
        : 0;
      if (this.gloomOverride === false) this._display(this.q('desktop-gloom'), false);
      this._emit('desktop-effect', this.gloomOverride == null ? 'gloom-auto' : this.gloomOverride ? 'gloom-on' : 'gloom-off');
    }

    dismissGloom(options={}) {
      const changed = this.gloomOverride !== false || this.gloomUntil !== 0;
      this.gloomOverride = false;
      this.gloomUntil = 0;
      this._display(this.q('desktop-gloom'), false);
      if (changed && !options.silent) this._emit('desktop-effect', 'gloom-dismissed');
    }

    setMood(next) {
      super.setMood(next);
      this.gloomUntil = 0;
      this.gloomOverride = ['bored','annoyed','anxious'].includes(next) ? null : false;
      if (this.gloomOverride === false) this._display(this.q('desktop-gloom'), false);
      if (next === 'happy' || next === 'excited') {
        this.spawnFlowers();
        this.sweepTail({duration:next === 'excited' ? 1250 : 1650});
      }
    }

    // ---- native window host API -------------------------------------------
    canWander() {
      return !this.hostCarry && !this.hostLeap && !this.knockout && !this.dizzy && !this.held && this.performanceMode !== 'guitar'
        && !(this.antic && this.antic.long) && !this._slumped() && !this.blanket
        && ['awake','happy','bored','annoyed','visitor','outdoors'].includes(this.state)
        && !this.sleepSequence && !this.jumpMotion && !this.landingMotion;
    }

    // Out after his stolen things right now (not gone to bed on it, not refusing).
    chasingStolen() { return !!this.stolen && !this._chasePaused && !this._chaseRefused; }

    hostWalk(direction) {
      if (!this.canWander() || this.seat > .02) return false;
      this.direction = this.facingTarget = direction < 0 ? -1 : 1;
      if (!this.treadmill) this.treadmill = {startedAt:nowMs()};
      this._emit('desktop-action', 'host-walk');
      return true;
    }

    hostStop() {
      this.treadmill = null;
      this._emit('desktop-action', 'host-walk-stop');
    }

    // Hit a wall (or the ceiling) hard enough to hurt: 'dizzy' = stars and
    // spiral eyes for a few seconds; 'splat' = flat on the ground with X eyes
    // for a while, then he gets up.  The native app grades it by speed.
    knock(level='dizzy') {
      const now = nowMs();
      this.treadmill = null;
      this.seatTarget = 0;
      this.seat = 0;
      this.playGuitar(false);
      if (level === 'splat') {
        this.knockout = {start:now, holdUntil:now + 4200 + Math.random() * 3600, getUpMs:1100};
        this.dizzy = {until:this.knockout.holdUntil + 1600};
      } else {
        this.dizzy = {until:now + 2600 + Math.random() * 1400};
      }
      this._emit('desktop-action', `knock:${level}`);
      return true;
    }

    _knockedOut(now=nowMs()) {
      const k = this.knockout;
      if (!k) return false;
      if (now > k.holdUntil + k.getUpMs) { this.knockout = null; return false; }
      return true;
    }

    _dizzy(now=nowMs()) {
      if (this.dizzy && now > this.dizzy.until) this.dizzy = null;
      return !!this.dizzy;
    }

    _renderKnock(now) {
      const out = this._knockedOut(now);
      const dizzy = this._dizzy(now);
      const show = (id, on) => { const el = this.q(id); if (el) el.setAttribute('display', on ? 'inline' : 'none'); };
      const lying = out && now < this.knockout.holdUntil;
      show('fx-eyes-x', lying);
      show('fx-eyes-swirl', dizzy && !lying);
      show('motion-eye-left', !(dizzy || lying));
      show('motion-eye-right', !(dizzy || lying));
      // Eyes shut / mouth shape for an antic (yawn, sneeze, doze, bow, chatting).
      // Only while one is running, so blinks and other expressions keep working.
      if (this.antic && !dizzy && !lying && this.state !== 'sleep') {
        const shut = this._anticEyes === 'closed';
        this._display(this.q('g-eye-left'), !shut);
        this._display(this.q('g-eye-right'), !shut);
        this._display(this.q('expression-closed-eyes'), shut);
        if (this._anticMouth && this.viseme === 'idle') { this._hideAllMouths(); this._display(this.q(this._anticMouth), true); }
      }
      show('fx-dizzy-stars', dizzy);
      // Auto outfit follows the clock at home (homewear by day, pyjamas at night).
      if (!this._outfitClockAt || now - this._outfitClockAt > 60000) {
        this._outfitClockAt = now;
        if (this.outfitMode === 'auto' && typeof this._resolvedOutfit === 'function' && this._resolvedOutfit() !== this.outfit) this._applyOutfit();
      }
      // The special expressions ride the same face shift as his own features
      // (the runtime moves eyes, nose, mouth and blush together with style.translate).
      const faceShift = (this.q('g-nose') && this.q('g-nose').style.translate) || '';
      ['fx-eyes-swirl','fx-eyes-x','fx-eyes-squeeze','fx-blush-deep','fx-mouth-square'].forEach(id => {
        const el = this.q(id);
        if (el && el.style.translate !== faceShift) el.style.translate = faceShift;
      });
      // Frightened: the tail tucks down between his legs, like a scared cat's.
      const tuckOn = (this.worried || this.scaredHigh) && !lying && this.gripZone() !== 'tail';
      this._tuckK = clamp((this._tuckK || 0) + (tuckOn ? .08 : -.1), 0, 1);
      if (this._tuckK > 0) {
        const k = this._tuckK, t = this.TAIL_TUCK || {root:[60, -90, -100], mid:100, tip:140, scale:.5};
        this._appendTransform(this.q('tail-root'), `translate(${(t.root[1] * k).toFixed(1)}px,${(t.root[2] * k).toFixed(1)}px) rotate(${(t.root[0] * k).toFixed(1)}deg) scale(${(1 - (1 - t.scale) * k).toFixed(3)})`);
        this._bendTail(t.mid * k, (t.tip - t.mid) * k);
      }
      // Tucked right in, the tail behind him is out of sight: it fades as the tip comes out
      // in front (it used to stay half there and keep swishing on its own).
      const tailRoot = this.q('tail-root');
      if (tailRoot) {
        const behind = this._tuckK > 0 ? clamp(1 - this._tuckK / .7, 0, 1) : 1;
        if (behind < 1 || this._tailFaded) { tailRoot.style.opacity = behind.toFixed(2); this._tailFaded = behind < 1; }
      }
      // The tip pokes out between his legs from under the hem.
      const tucked = this._tuckedTip();
      if (tucked) {
        tucked.setAttribute('display', this._tuckK > .05 ? 'inline' : 'none');
        tucked.setAttribute('opacity', clamp((this._tuckK - .3) / .7, 0, 1).toFixed(2));
        const sway = Math.sin(now / 1000 * 2.4) * 4;
        tucked.setAttribute('transform', `translate(${(this.TUCK_TIP_AT || [384, 540])[0]} ${(this.TUCK_TIP_AT || [384, 540])[1]}) rotate(${((this.TUCK_TIP_ROT || -78) + sway).toFixed(1)}) scale(${this.TUCK_TIP_SCALE || 1.02})`);
      }
      // She's run off with something of his: cross, brows flipped like his >< face.
      if (this.stolen && !lying && !this.edgeFear && !this.pleading && !this._isActuallyHeld()
          && !(this.squeezeUntil && now < this.squeezeUntil) && !(this.flusterUntil && now < this.flusterUntil)) {
        this._appendTransform(this.q('motion-brow-left'), 'translateY(6px) rotate(10deg) scale(1,-1)');
        this._appendTransform(this.q('motion-brow-right'), 'translateY(6px) rotate(-10deg) scale(1,-1)');
      }
      // Caught embroidering: hands (and the hoop) whipped behind his back, pink in the face.
      if (this.hideStitchingUntil && now < this.hideStitchingUntil && !lying) {
        this._display(this.q('hands-root'), false);
        show('fx-blush-deep', true);
        this._appendTransform(this.q('character-motion-root'), `rotate(${(-2 * (this.direction || 1)).toFixed(2)}deg)`);
      } else if (this.hideStitchingUntil) {
        this.hideStitchingUntil = 0;
        if (this.performanceMode !== 'guitar' && !this.blanket) this._display(this.q('hands-root'), true);
      }
      // Holding her cursor: the hand closes round it, a faint blush, eyes elsewhere.
      const hh = this._handHover;
      if (hh && !hh.gripAt && now - hh.since > 4000 && !lying && !(this.antic && this.antic.long) && !this.blanket && !this._isActuallyHeld()) {
        const side = this._handUnder(hh.x, hh.y);
        if (side) {
          hh.side = side;
          hh.gripAt = now;
          if (this.onHandHold && this.onHandHold() === false) { hh.gripAt = 0; hh.since = now + 60000; }   // he won't (sulking at her)
        }
      }
      if (hh && hh.gripAt) {
        const k = clamp((now - hh.gripAt) / 900, 0, 1);
        const hand = this.q(`motion-hand-${hh.side}`);
        this._appendTransform(hand, `translate(${((hh.side === 'left' ? 6 : -6) * k).toFixed(1)}px,${(-4 * k).toFixed(1)}px) scale(${(1 - .08 * k).toFixed(3)})`);
        show('g-blush-left', true); show('g-blush-right', true);
        this._appendTransform(this.q('motion-head-root'), `rotate(${((hh.side === 'left' ? 4 : -4) * k).toFixed(2)}deg)`);
        this.attention.targetX = (hh.side === 'left' ? 1 : -1) * .9 * k;     // looking anywhere but at it
        this.attention.targetY = -.3 * k;
      }
      // Just let go: the hand snaps back.
      if (this._handLetGoAt && now - this._handLetGoAt < 500) {
        const j = 1 - (now - this._handLetGoAt) / 500;
        ['left','right'].forEach(sd => this._appendTransform(this.q(`motion-hand-${sd}`), `translateY(${(14 * j).toFixed(1)}px)`));
      }
      // Asleep: mouth shut, unless he's mumbling in his sleep.
      if (this.state === 'sleep' && !this.sleepSequence && !lying && this.viseme === 'idle') {
        const talking = this.sleepTalkUntil && now < this.sleepTalkUntil;
        const open = talking && Math.sin(now / 1000 * 13) > .1;
        this._hideAllMouths();
        this._display(this.q(open ? 'g-mouth-open-small' : 'g-mouth-neutral'), true);
      }
      // In bed but not asleep yet (or jolted awake for a moment): eyes open, blinking.
      const stirring = this.stirUntil && now < this.stirUntil;
      if ((this.bedAwake || stirring) && this.state === 'sleep' && !this.sleepSequence && !lying) {
        this._display(this.q('g-eye-left'), true);
        this._display(this.q('g-eye-right'), true);
        this._display(this.q('expression-closed-eyes'), false);
        this._display(this.q('overlay-zzz'), false);
        this._display(this.q('fx-zz'), false);
        const b = stirring && !this.bedAwake ? .45 : Math.max(.08, (typeof this._blinkScale === 'function' ? this._blinkScale(now) : 1) * .8);
        const drift = Math.sin(now / 1000 * .4) * 3;
        ['motion-eye-left','motion-eye-right'].forEach(id => { const el = this.q(id); if (el) el.style.transform = `translate(${drift.toFixed(1)}px,-3px) scale(1,${b.toFixed(3)})`; });
      }
      // Drifting down under his umbrella: the umbrella hand up, legs dangling.
      if (this.floating && this.state !== 'sleep' && !lying && !this._isActuallyHeld()) {
        const sw = Math.sin(now / 1000 * 2.2);
        this._appendTransform(this.q('motion-hand-right'), 'translate(-10px,-70px)');
        this._appendTransform(this.q('character-motion-root'), `rotate(${(sw * 3).toFixed(2)}deg)`);
        this._legTransform('left', 8 + sw * 6, -4);
        this._legTransform('right', -8 + sw * 6, -4);
      }
      // ---- small parts
      const sf = this.selfFix;
      if (sf) {
        const u2 = (now - sf.start) / sf.ms;
        if (u2 >= 1) {
          if (sf.target === 'brow') this.browRuffleUntil = 0;
          if (sf.target === 'hat') this.hatTilt = null;
          this.selfFix = null;
        } else if (!lying) {
          const k = smoothstep(clamp(Math.min(u2 / .3, (1 - u2) / .3), 0, 1));
          const rub = sf.target === 'brow' || sf.target === 'collar' || sf.target === 'eye' ? Math.sin(now / 1000 * 14) * 8 * k : 0;
          this._appendTransform(this.q(`motion-hand-${sf.side}`), `translate(${(sf.dx * k + rub).toFixed(1)}px,${(sf.dy * k).toFixed(1)}px)`);
          if (sf.target === 'ahoge') { this._appendTransform(this.q('motion-brow-left'), 'translateY(4px) rotate(9deg)'); this._appendTransform(this.q('motion-brow-right'), 'translateY(4px) rotate(-9deg)'); }
        }
      }
      // Leaning into her hand on his cheek.
      if (this.cheekLean && !lying && this.state !== 'sleep') {
        const cl = this.cheekLean;
        if (now > cl.until + 500) this.cheekLean = null;
        else {
          const k = clamp(Math.min((cl.until + 500 - now) / 500, 1), 0, 1);
          const sign = cl.side === 'left' ? -1 : 1;
          this._appendTransform(this.q('motion-head-root'), `rotate(${(sign * 6 * k).toFixed(2)}deg) translateX(${(sign * 6 * k).toFixed(1)}px)`);
          if (cl.content && k > .3) {
            ['g-eye-left','g-eye-right','motion-eye-left','motion-eye-right'].forEach(id => this._display(this.q(id), false));
            this._display(this.q('expression-closed-eyes'), true);
            this._cheekEyesShut = true;
          }
        }
      }
      if (this._cheekEyesShut && !(this.cheekLean && this.cheekLean.content)) {
        this._cheekEyesShut = false;
        this._display(this.q('expression-closed-eyes'), false);
        this._display(this.q('motion-eye-left'), true);
        this._display(this.q('motion-eye-right'), true);
        if (typeof this._applyFace === 'function') this._applyFace();
      }
      // Brows ruffled up the wrong way; once she stops, he smooths them back.
      if (this.browRuffleUntil && now < this.browRuffleUntil + (this.selfFix && this.selfFix.target === 'brow' ? 2000 : 0) && !lying) {
        const j = Math.sin(now / 1000 * 30) * 2;
        // Ruffled = tipped every which way, same size as ever.
        this._appendTransform(this.q('motion-brow-left'), `translate(0px,-4px) rotate(${(-14 + j).toFixed(1)}deg)`);
        this._appendTransform(this.q('motion-brow-right'), `translate(0px,-4px) rotate(${(14 - j).toFixed(1)}deg)`);
      }
      if (this._browFixDue && now >= this._browFixDue) { this._browFixDue = 0; if (!this.startSelfFix('brow', 1600)) this.browRuffleUntil = 0; }
      // Ears: a twitch when the cursor comes close; a big flick when she flicks one.
      if (this.earTwitch) {
        const et = this.earTwitch, d = now - et.start, dur = et.big ? 700 : 380;
        const ear = this.q(`twitch-ear-${et.side}`);
        if (d > dur) { if (ear) ear.style.transform = ''; this.earTwitch = null; }
        else if (ear) {
          const a = Math.sin(d / dur * Math.PI * (et.big ? 5 : 3)) * (1 - d / dur) * (et.big ? 26 : 12) * (et.side === 'left' ? -1 : 1);
          ear.style.transform = `rotate(${a.toFixed(1)}deg)`;
        }
      }
      // Held by an ear: head tipped towards it, that ear stretched.
      const eg = this.gripZone();
      if ((eg === 'ear-left' || eg === 'ear-right') && !lying) {
        const left = eg === 'ear-left';
        this._appendTransform(this.q('motion-head-root'), `rotate(${(left ? -12 : 12)}deg)`);
        // (A folded ear doesn't stretch.)
        this._appendTransform(this.q('motion-brow-left'), 'translate(8px,-6px) rotate(-12deg)');
        this._appendTransform(this.q('motion-brow-right'), 'translate(-8px,-6px) rotate(12deg)');
        this._earGripOn = true;
      } else if (this._earGripOn) {
        this._earGripOn = false;
        ['left','right'].forEach(sd => { const e = this.q(`twitch-ear-${sd}`); if (e) e.style.transform = ''; });
      }
      // The sticking-up hair: boing, springing back.
      if (this.ahogeSpring) {
        const d = now - this.ahogeSpring.start;
        const tufts = ['motion-hair-tuft-top-left','motion-hair-crown-right'].map(id => this.q(id));
        if (d > 1400) { tufts.forEach(t => { if (t) t.style.rotate = ''; }); this.ahogeSpring = null; }
        else {
          const a = Math.sin(d / 1000 * 22) * 16 * Math.exp(-d / 420);
          tufts.forEach((t, i) => { if (t) t.style.rotate = `${(i ? -a : a).toFixed(1)}deg`; });
        }
      }
      // Collar straightened by her: a pleased little look.
      if (this.collarPleasedUntil && now < this.collarPleasedUntil && !lying && this.viseme === 'idle' && !this.sulk) {
        this._hideAllMouths(); this._display(this.q('g-mouth-smile'), true);
        show('g-blush-left', true); show('g-blush-right', true);
        this._collarSmile = true;
      } else if (this._collarSmile) { this._collarSmile = false; if (typeof this._applyFace === 'function') this._applyFace(); }
      // Hat knocked askew until he puts it straight.
      if (this.hatTilt && !lying) {
        const ht = this.hatTilt;
        if (!this.selfFix && now >= ht.fixAt) { if (!this.startSelfFix('hat', 1400)) this.hatTilt = null; }
        const back = this.selfFix && this.selfFix.target === 'hat' ? 1 - clamp((now - this.selfFix.start) / this.selfFix.ms, 0, 1) : 1;
        const k = clamp((now - ht.start) / 180, 0, 1) * back;
        ['lift-hat-city','lift-hat-pirate','lift-hat-gown','lift-hat-garden','lift-hat-barbour','lift-hat-maid'].forEach(id => {
          const e = this.q(id); if (e) e.style.transform = `translate(${(ht.side * 40 * k).toFixed(1)}px,${(10 * k).toFixed(1)}px) rotate(${(ht.side * 18 * k).toFixed(1)}deg)`;
        });
        if (this.hatTilt) this._hatTiltOn = true;
      } else if (this._hatTiltOn) {
        this._hatTiltOn = false;
        ['lift-hat-city','lift-hat-pirate','lift-hat-gown','lift-hat-garden','lift-hat-barbour','lift-hat-maid'].forEach(id => { const e = this.q(id); if (e) e.style.transform = ''; });
      }
      // Whisked away to his other side (sulking, and she went for the tail).
      if (this.tailAwayUntil && now < this.tailAwayUntil + 700 && !lying) {
        const inK = clamp((now - this.tailAwayStart) / 260, 0, 1);
        const outK = clamp((this.tailAwayUntil + 700 - now) / 700, 0, 1);
        const k = smoothstep(Math.min(inK, outK));
        const flick = Math.sin(now / 1000 * 5) * 6 * k;
        this._appendTransform(this.q('tail-root'), `rotate(${(-150 * k + flick).toFixed(1)}deg)`);
        this._bendTail(-25 * k, -5 * k + flick);
      }
      // Tail play.
      const te = this._tailTease;
      if (te && now - te.last > 1500) this._tailTease = null;
      if (this._tailTease && !lying && this.state !== 'sleep') {
        // The tip leans toward the cursor; he doesn't look.
        const tp = this._tailPoints();
        if (tp) {
          const want = Math.atan2(te.y - tp.tip.y, te.x - tp.tip.x) - Math.atan2(tp.tip.y - tp.root.y, tp.tip.x - tp.root.x);
          let deg = ((want * 180 / Math.PI) + 540) % 360 - 180;
          deg = clamp(deg, -40, 40);
          te.lean = (te.lean || 0) * .8 + deg * .2;
          this._bendTail(te.lean * .4, te.lean * .5 + Math.sin(now / 1000 * 9) * 4);
        }
      }
      if (this.tailNoticedUntil && now < this.tailNoticedUntil && !lying) {
        // Caught his own tail at it: a glare over his shoulder at it.
        this._appendTransform(this.q('motion-head-root'), 'rotate(-6deg)');
        this.attention.targetX = .9; this.attention.targetY = .5;
        this._appendTransform(this.q('motion-brow-left'), 'translateY(4px) rotate(9deg)');
        this._appendTransform(this.q('motion-brow-right'), 'translateY(4px) rotate(-9deg)');
      }
      const fluff = this.tailFluffUntil && now < this.tailFluffUntil, puff = this.tailPuffUntil && now < this.tailPuffUntil;
      if ((fluff || puff) && !lying) {
        const k = puff ? clamp((this.tailPuffUntil - now) / 500, 0, 1) : clamp((this.tailFluffUntil - now) / 600, 0, 1);
        const sc = 1 + (puff ? .32 : .1) * k;
        const jit = puff ? Math.sin(now / 1000 * 40) * 2 * k : 0;
        this._appendTransform(this.q('tail-root'), `scale(${sc.toFixed(3)}) rotate(${(puff ? -14 * k + jit : 0).toFixed(1)}deg)`);
        if (fluff && this.viseme === 'idle') {
          // Melting a little: eyes shut, a hint of a smile, pink.
          this._display(this.q('g-eye-left'), false);
          this._display(this.q('g-eye-right'), false);
          this._display(this.q('motion-eye-left'), false);
          this._display(this.q('motion-eye-right'), false);
          this._display(this.q('expression-closed-eyes'), true);
          this._hideAllMouths(); this._display(this.q('g-mouth-smile'), true);
          this._tailMelted = true;
        }
      } else if (this._tailMelted) {
        this._tailMelted = false;
        this._display(this.q('expression-closed-eyes'), false);
        this._display(this.q('motion-eye-left'), true);
        this._display(this.q('motion-eye-right'), true);
        if (typeof this._applyFace === 'function') this._applyFace();
      }
      // In the maid's dress: not speaking to her. Face turned away, pout, red to the ears.
      if (this.outfit === 'maid' && !lying && this.state !== 'sleep' && !this._isActuallyHeld()) {
        this._appendTransform(this.q('motion-head-root'), `rotate(${(-5 * (this.direction || 1)).toFixed(1)}deg)`);
        this.attention.targetX = -.95 * (this.direction || 1); this.attention.targetY = .2;
        show('fx-blush-deep', true);
        this._display(this.q('desktop-angry-mark'), true);
        if (this.viseme === 'idle') { this._hideAllMouths(); this._display(this.q('g-mouth-pout'), true); }
        this._appendTransform(this.q('motion-brow-left'), 'translateY(4px) rotate(9deg)');
        this._appendTransform(this.q('motion-brow-right'), 'translateY(4px) rotate(-9deg)');
        this._maidSulk = true;
      } else if (this._maidSulk) {
        this._maidSulk = false;
        this._display(this.q('desktop-angry-mark'), !!this.sulk);
        if (typeof this._applyFace === 'function') this._applyFace();
      }
      // Crying: both hands over his face, shoulders shaking, tears under the fingers.
      const crying = this.cryUntil && now < this.cryUntil && !lying && this.state !== 'sleep';
      if (crying) {
        const k = clamp(Math.min((now - this.cryStart) / 400, (this.cryUntil - now) / 500), 0, 1);
        if (!this._cryAim) {
          const aim = {};
          const eL = this.q('motion-eye-left'), eR = this.q('motion-eye-right');
          const lb = eL && eL.getBoundingClientRect(), rb = eR && eR.getBoundingClientRect();
          if (lb && rb && lb.width && rb.width) {
            const cx = (lb.left + lb.right + rb.left + rb.right) / 4, cy = (lb.top + lb.bottom + rb.top + rb.bottom) / 4;
            [['left', -1], ['right', 1]].forEach(([side, sign]) => {
              const hand = this.q(`motion-hand-${side}`);
              if (!hand || !hand.parentNode || !hand.parentNode.getScreenCTM) return;
              const hb = hand.getBoundingClientRect();
              const inv = hand.parentNode.getScreenCTM().inverse();
              const p0 = new DOMPoint(hb.left + hb.width / 2, hb.top + hb.height / 2).matrixTransform(inv);
              const p1 = new DOMPoint(cx + sign * hb.width * .55, cy - hb.height * .05).matrixTransform(inv);
              const [ox, oy] = String(hand.getAttribute('data-pivot') || '0,0').split(',').map(Number);
              const S = 1.5;
              aim[side] = [p1.x - p0.x - (S - 1) * (p0.x - ox), p1.y - p0.y - (S - 1) * (p0.y - oy)];
            });
            // Where the tears run from: just under the outer edge of each hand.
            const head = this.q('motion-head-root');
            const hctm = head && head.getScreenCTM && head.getScreenCTM();
            if (hctm) {
              const inv = hctm.inverse();
              const w = (rb.right - lb.left);
              aim.tearL = new DOMPoint(lb.left - w * .08, lb.bottom + lb.height * .9).matrixTransform(inv);
              aim.tearR = new DOMPoint(rb.right + w * .08, rb.bottom + rb.height * .9).matrixTransform(inv);
            }
          }
          this._cryAim = aim;
        }
        const aL = this._cryAim.left || [120, -250], aR = this._cryAim.right || [-120, -250];
        const hs = 1 + .5 * k;
        const sob = Math.max(0, Math.sin(now / 1000 * 9)) * k;
        this._appendTransform(this.q('motion-hand-left'), `translate(${(aL[0] * k).toFixed(1)}px,${(aL[1] * k + sob * 4).toFixed(1)}px) scale(${hs.toFixed(3)})`);
        this._appendTransform(this.q('motion-hand-right'), `translate(${(aR[0] * k).toFixed(1)}px,${(aR[1] * k + sob * 4).toFixed(1)}px) scale(${hs.toFixed(3)})`);
        this._appendTransform(this.q('motion-head-root'), `translateY(${(6 * k + sob * 5).toFixed(1)}px) rotate(${(3 * k).toFixed(1)}deg)`);
        this._appendTransform(this.q('character-motion-root'), `translateY(${(sob * 3).toFixed(1)}px)`);
        this._handEdge(true);
        show('fx-blush-deep', true);
        this._appendTransform(this.q('motion-brow-left'), 'translate(8px,-6px) rotate(-12deg)');
        this._appendTransform(this.q('motion-brow-right'), 'translate(-8px,-6px) rotate(12deg)');
        if (this.viseme === 'idle') { this._hideAllMouths(); this._display(this.q(sob > .5 ? 'g-mouth-open-small' : 'g-mouth-pout'), true); }
        const tears = this._tears();
        if (tears && this._cryAim.tearL) {
          tears.setAttribute('display', 'inline');
          tears.setAttribute('opacity', k.toFixed(2));
          tears.querySelectorAll('.tear').forEach(t => {
            const i = Number(t.getAttribute('data-i'));
            const from = i % 2 ? this._cryAim.tearR : this._cryAim.tearL;
            const phase = ((now / 1000 * .9) + (i > 1 ? .5 : 0)) % 1;
            t.setAttribute('transform', `translate(${(from.x + (i % 2 ? 6 : -6) * phase).toFixed(1)} ${(from.y + 70 * phase).toFixed(1)}) scale(${(1 - .4 * phase).toFixed(2)})`);
            t.setAttribute('opacity', (1 - phase * .8).toFixed(2));
          });
        }
        this._wasCrying = true;
      } else if (this._wasCrying) {
        this._wasCrying = false;
        const tears = this._tears(); if (tears) tears.setAttribute('display', 'none');
        if (!this._slumped(now) && !(this.antic && this.antic.type === 'embroider')) this._handEdge(false);
        if (typeof this._applyFace === 'function') this._applyFace();
      }
      // Lying dazed on the floor and crying: tears from his screwed-up eyes.
      if (lying && this.lyingTearsUntil && now < this.lyingTearsUntil) {
        const tears = this._tears(), eyes = this.q('fx-eyes-x');
        const head = this.q('motion-head-root');
        const eb = eyes && eyes.getBoundingClientRect(), hctm = head && head.getScreenCTM && head.getScreenCTM();
        if (tears && eb && eb.width && hctm) {
          const inv = hctm.inverse();
          const a = new DOMPoint(eb.left + eb.width * .15, eb.bottom).matrixTransform(inv);
          const b = new DOMPoint(eb.right - eb.width * .15, eb.bottom).matrixTransform(inv);
          tears.setAttribute('display', 'inline');
          tears.removeAttribute('opacity');
          tears.querySelectorAll('.tear').forEach(t => {
            const i = Number(t.getAttribute('data-i'));
            const from = i % 2 ? b : a;
            const phase = ((now / 1000 * .8) + (i > 1 ? .5 : 0)) % 1;
            t.setAttribute('transform', `translate(${from.x.toFixed(1)} ${(from.y + 50 * phase).toFixed(1)}) scale(${(1 - .4 * phase).toFixed(2)})`);
            t.setAttribute('opacity', (1 - phase * .8).toFixed(2));
          });
          this._lyingTearsOn = true;
        }
      } else if (this._lyingTearsOn && !(this.cryUntil && now < this.cryUntil)) {
        this._lyingTearsOn = false;
        const tears = this._tears(); if (tears) tears.setAttribute('display', 'none');
      }
      // How he hangs depends on what she's holding him by.
      const grip = this.gripZone();
      if (grip && !lying) {
        const s3 = now / 1000;
        const around = (px, py, deg) => `translate(${px - 382}px,${py - 623}px) rotate(${deg.toFixed(1)}deg) translate(${382 - px}px,${623 - py}px)`;
        if (grip === 'chest') {
          // Hoisted by the front of his shirt, like someone spoiling for a fight:
          // both hands clutching his collar, brows up in outrage.
          if (!this._gripAim || this._gripAim.zone !== 'chest') {
            // Both hands up to where she's got hold of him, clutching at her hand.
            const g = this._lastGrab;
            const tr = this.q('torso-root') && this.q('torso-root').getBoundingClientRect();
            const gx = g && Number.isFinite(g.x) ? g.x : (tr ? tr.left + tr.width / 2 : 0);
            const gy = g && Number.isFinite(g.y) ? g.y : (tr ? tr.top + tr.height * .12 : 0);
            this._gripAim = {zone:'chest', aim:this._aimHands(gx, gy + 6, .35)};
          }
          const a = this._gripAim.aim, tug = Math.sin(s3 * 9) * 5;
          if (a.left) this._appendTransform(this.q('motion-hand-left'), `translate(${a.left[0].toFixed(1)}px,${(a.left[1] + tug).toFixed(1)}px)`);
          if (a.right) this._appendTransform(this.q('motion-hand-right'), `translate(${a.right[0].toFixed(1)}px,${(a.right[1] - tug).toFixed(1)}px)`);
          if (!(this.cryUntil && now < this.cryUntil) && !this.worried) {
            this._appendTransform(this.q('motion-brow-left'), 'translateY(6px) rotate(10deg) scale(1,-1)');
            this._appendTransform(this.q('motion-brow-right'), 'translateY(6px) rotate(-10deg) scale(1,-1)');
          }
        } else if (grip === 'head') {
          // Held by the head: hands flapping at his sides (where you can see them), wincing.
          const flap = Math.sin(s3 * 10) * 18;
          this._appendTransform(this.q('motion-hand-left'), `translate(-14px,${(-30 + flap).toFixed(1)}px)`);
          this._appendTransform(this.q('motion-hand-right'), `translate(14px,${(-30 - flap).toFixed(1)}px)`);
          this._appendTransform(this.q('motion-brow-left'), 'translate(8px,-6px) rotate(-12deg)');
          this._appendTransform(this.q('motion-brow-right'), 'translate(-8px,-6px) rotate(12deg)');
        } else if (grip === 'hand-left' || grip === 'hand-right') {
          // Dangling from one hand, swinging under it; the other arm flails.
          const left = grip === 'hand-left';
          const swing = (left ? 16 : -16) + Math.sin(s3 * 2.4) * 6;
          this._appendTransform(this.q('character-motion-root'), around(left ? 160 : 604, 299, swing));
          this._appendTransform(this.q(`motion-hand-${left ? 'right' : 'left'}`), `translate(0px,${(Math.sin(s3 * 11) * 22).toFixed(1)}px)`);
        } else if (grip === 'foot-left' || grip === 'foot-right') {
          // Hauled up by one foot: that leg held still where she has it, the other kicking,
          // a lean away from it and arms flailing. (Turning him right over
          // carried him out of his window.)
          const left = grip === 'foot-left';
          // The held foot is simply held: it doesn't move at all. Only the other one kicks.
          this._legTransform(left ? 'left' : 'right', (left ? 1 : -1) * 12, -6);
          this._legTransform(left ? 'right' : 'left', Math.sin(s3 * 15) * 34, -6);
          this._appendTransform(this.q('character-motion-root'), around(left ? 345 : 418, 520, (left ? 1 : -1) * (14 + Math.sin(s3 * 3) * 4)));
          this._appendTransform(this.q('motion-hand-left'), `translate(-20px,${(-60 + Math.sin(s3 * 12) * 26).toFixed(1)}px)`);
          this._appendTransform(this.q('motion-hand-right'), `translate(20px,${(-60 - Math.sin(s3 * 12) * 26).toFixed(1)}px)`);
          this._appendTransform(this.q('motion-brow-left'), 'translate(8px,-6px) rotate(-12deg)');
          this._appendTransform(this.q('motion-brow-right'), 'translate(-8px,-6px) rotate(12deg)');
        }
      }
      if (this._gripFaceOn) {
        this._gripFaceOn = false;
        show('fx-eyes-squeeze', false);
        this._display(this.q('motion-eye-left'), true);
        this._display(this.q('motion-eye-right'), true);
        if (typeof this._applyFace === 'function') this._applyFace();
      }
      if (grip === 'tail' && !lying) {
        // Hauled up by the tail: it's pulled out straight towards her hand,
        // and he hangs off it, tilted towards it, rigid with fright.
        const g = this._lastGrab, root = this.q('tail-root');
        if (g && root && root.parentNode && root.parentNode.getScreenCTM) {
          const ctm = root.parentNode.getScreenCTM();
          const base = new DOMPoint(470, 455).matrixTransform(ctm);
          const tip = this.q('g-tail-tip') && this.q('g-tail-tip').getBoundingClientRect();
          if (!this._tailPull || this._tailPull.at !== g.at) {
            // Angle between the tail's resting direction and the grab point (measured once).
            const restTip = tip && tip.width ? {x:tip.left + tip.width / 2, y:tip.top + tip.height / 2} : {x:base.x + 100, y:base.y};
            const rest = Math.atan2(restTip.y - base.y, restTip.x - base.x);
            const want = Math.atan2(g.y - base.y, g.x - base.x);
            let deg = ((want - rest) * 180 / Math.PI + 540) % 360 - 180;
            // Some times he yells, some times he grits his teeth.
            this._tailPull = {at:g.at, deg:clamp(deg, -150, 150), mouthOpen:Math.random() < .5};
          }
          const tremble = Math.sin(now / 1000 * 26) * 1.5;
          // Pulled taut: its natural upward bend taken out, stretched a little,
          // aimed at her hand, trembling.
          this._appendTransform(root, `rotate(${(this._tailPull.deg - 4 + tremble).toFixed(1)}deg) scale(1.12,.88)`);
          this._bendTail(18, -6);
          // Eyes screwed shut (><) the whole time; the squeeze face handles eyes and mouth.
          if (!(this.cryUntil && now < this.cryUntil)) this.squeezeUntil = Math.max(this.squeezeUntil || 0, now + 200);
          this._tailPullFace = true;
        }
      } else if (this._tailPullFace) {
        this._tailPullFace = false; this._tailPull = null;
      }
      if (!grip) this._gripAim = null;
      // Carried along at a walking pace low down: his legs walk in the air.
      if (this.strollUntil && now < this.strollUntil && this._isActuallyHeld()) {
        const step = Math.sin(now / 1000 * 7) * 24;
        this._legTransform('left', step, -4);
        this._legTransform('right', -step, -4);
      }
      // Dragged along the floor: feet trailing behind, scuffing.
      if (this.scrapeUntil && now < this.scrapeUntil && this._isActuallyHeld()) {
        const back = (this.scrapeDir || 1) * -24;
        this._legTransform('left', back + Math.sin(now / 1000 * 20) * 4, 0);
        this._legTransform('right', back + Math.sin(now / 1000 * 20 + 1) * 4, 0);
      }
      // Riding a window she's dragging: arms out for balance; fast, he crouches and hangs on.
      if (this.ride && !lying && !this._isActuallyHeld()) {
        const s2 = now / 1000;
        if (this.ride >= 2) {
          this._appendTransform(this.q('character-motion-root'), `translateY(22px) scale(1.04,.9) rotate(${(Math.sin(s2 * 9) * 1.5).toFixed(2)}deg)`);
          this._appendTransform(this.q('motion-hand-left'), 'translate(10px,70px)');
          this._appendTransform(this.q('motion-hand-right'), 'translate(-10px,70px)');
          this._appendTransform(this.q('motion-brow-left'), 'translate(8px,-6px) rotate(-12deg)');
          this._appendTransform(this.q('motion-brow-right'), 'translate(-8px,-6px) rotate(12deg)');
        } else {
          const sway = Math.sin(s2 * 2.6);
          this._appendTransform(this.q('character-motion-root'), `rotate(${(sway * 2.4).toFixed(2)}deg)`);
          this._appendTransform(this.q('motion-hand-left'), `translate(-34px,${(-40 + sway * 10).toFixed(1)}px)`);
          this._appendTransform(this.q('motion-hand-right'), `translate(34px,${(-40 - sway * 10).toFixed(1)}px)`);
        }
      }
      // At the edge of a drop he daren't jump: brows shot right up, trembling.
      if (this.edgeFear && !lying && !this.pleading) {
        const shake = Math.sin(now / 1000 * 31) * 1.6;
        this._appendTransform(this.q('motion-brow-left'), `translate(-2px,-16px) rotate(${(8 + shake).toFixed(1)}deg) scale(1,.8)`);
        this._appendTransform(this.q('motion-brow-right'), `translate(2px,-16px) rotate(${(-8 - shake).toFixed(1)}deg) scale(1,.8)`);
      }
      // Slammed down at the floor: >< eyes, mouth wide, a yell.
      const squeeze = this.squeezeUntil && now < this.squeezeUntil && !lying;
      if (squeeze) {
        show('fx-eyes-squeeze', true);
        show('fx-mouth-square', true);
        this._display(this.q('g-eye-left'), false);
        this._display(this.q('g-eye-right'), false);
        this._display(this.q('expression-closed-eyes'), false);
        this._display(this.q('motion-eye-left'), false);
        this._display(this.q('motion-eye-right'), false);
        this._hideAllMouths();
        this._appendTransform(this.q('motion-brow-left'), 'translateY(6px) rotate(10deg) scale(1,-1)');
        this._appendTransform(this.q('motion-brow-right'), 'translateY(6px) rotate(-10deg) scale(1,-1)');
      }
      // Pleading (held up far too long, or stuck somewhere high): brows knitted, inner ends raised.
      if (this.pleading && !lying) {
        this._appendTransform(this.q('motion-brow-left'), 'translate(8px,-6px) rotate(-12deg)');
        this._appendTransform(this.q('motion-brow-right'), 'translate(-8px,-6px) rotate(12deg)');
      }
      if (this.tired && !lying && this.state !== 'sleep') {
        const heave = Math.sin(now / 1000 * 7) * .5 + .5;
        this._appendTransform(this.q('character-motion-root'), `translateY(${(3 * heave).toFixed(1)}px) scale(1,${(1 - .015 * heave).toFixed(3)})`);
        if (this.viseme === 'idle' && !(this.flusterUntil && now < this.flusterUntil)) { this._hideAllMouths(); this._display(this.q('g-mouth-open-small'), true); }
      }
      // What VPS Arthur is busy with, in his hand (and an apron for cooking);
      // not while his hands are taken or he's lying down.
      const handsBusy = this.performanceMode === 'guitar' || this._isActuallyHeld() || lying || this.state === 'sleep'
        || (this.flusterUntil && now < this.flusterUntil) || (this.antic && ['stretch','hair','bow','read','tea','embroider'].includes(this.antic.type));
      const spelling = this.spell && now < this.spell.start + this.spell.ms;
      // The Britannia Angel never goes anywhere without his star wand.
      const prop = spelling ? 'wand' : handsBusy ? null : (this.vpsProp || (this.outfit === 'angel' ? 'wand' : null));
      ['spatula','wateringcan','quill','duster','wand','pint','rod'].forEach(name => show(`prop-${name}`, prop === name));
      show('prop-apron', this.vpsApron && !lying && this.state !== 'sleep');
      if (prop) show('prop-umbrella', false);
      // Late at night: a blanket over him (one of the two he was given).
      show('prop-blanket-francis', this.blanket === 'francis');
      show('prop-blanket-alfred', this.blanket === 'alfred');
      // Wrapped up: his hands are under it (unless something needs them).
      const wrapped = !!this.blanket && !this._isActuallyHeld() && !lying && !(this.flusterUntil && now < this.flusterUntil) && !this._slumped(now);
      if (wrapped) this._display(this.q('hands-root'), false);
      else if (this._handsWrapped && this.performanceMode !== 'guitar') this._display(this.q('hands-root'), true);
      this._handsWrapped = wrapped;
      // Punk: the gig bag rides on his back; when he plays, the guitar's out
      // and the empty bag lies at his feet.
      const punk = this.outfit === 'punk';
      const playing = this.performanceMode === 'guitar';
      show('punk-gigbag-back', punk && !playing);
      show('angel-wings-back', this.outfit === 'angel');
      // Britannia Angel: a halo over his head, and an edge on his hands so they still
      // read in front of the white wings and robe.
      const angel = this.outfit === 'angel';
      const halo = this._angelHalo();
      if (halo) {
        halo.setAttribute('display', angel ? 'inline' : 'none');
        if (angel) halo.setAttribute('transform', `translate(0 ${(Math.sin(now / 1000 * 1.6) * 6).toFixed(1)})`);
      }
      if (angel) this._handEdge(true); else if (this._wasAngel) this._handEdge(false);
      this._wasAngel = angel;
      show('punk-strap', !playing);
      show('punk-gigbag-ground', punk && playing && !lying && this.state !== 'sleep');
      // Puzzled (someone is stroking his hand): head tilted, a question mark.
      const puzzled = this.puzzledUntil && now < this.puzzledUntil && !lying;
      show('fx-puzzled', !!puzzled);
      if (puzzled && !this.puzzledQuiet) {
        const pk = clamp(Math.min((this.puzzledUntil - now) / 300, (now - (this.puzzledUntil - 1900)) / 200), 0, 1);
        this._appendTransform(this.q('motion-head-root'), `rotate(${(9 * pk).toFixed(2)}deg)`);
        this._appendTransform(this.q('motion-brow-left'), `translateY(${(-8 * pk).toFixed(1)}px) rotate(${(-6 * pk).toFixed(2)}deg)`);
        this._appendTransform(this.q('motion-brow-right'), `translateY(${(4 * pk).toFixed(1)}px)`);
      }
      // Flustered: big blush, both hands over the front, leaning away.
      const flustered = this.flusterUntil && now < this.flusterUntil;
      show('fx-blush-deep', !!flustered || (this.sulk && false));
      // >< eyes and a square open mouth while flustered; hands in front of the clothes.
      const squeezing = this.squeezeUntil && now < this.squeezeUntil;
      show('fx-eyes-squeeze', (!!flustered || squeezing) && !lying);
      show('fx-mouth-square', (!!flustered || squeezing) && !lying);
      const handsRoot = this.q('hands-root'), outfits = this.q('outfits-root');
      if (handsRoot && outfits && handsRoot.parentNode) {
        const front = flustered || this._slumped(now) || (this.antic && this.antic.type === 'embroider') || (this.cryUntil && now < this.cryUntil) || this.gripZone() === 'chest';
        if (front && !this._handsInFront) { handsRoot.parentNode.appendChild(handsRoot); this._handsInFront = true; }
        else if (!front && this._handsInFront) { outfits.parentNode.insertBefore(handsRoot, outfits); this._handsInFront = false; }
      }
      if (flustered && !lying) {
        this._display(this.q('g-eye-left'), false);
        this._display(this.q('g-eye-right'), false);
        this._display(this.q('expression-closed-eyes'), false);
        this._display(this.q('motion-eye-left'), false);
        this._display(this.q('motion-eye-right'), false);
        this._hideAllMouths();
        // Ease in over a quarter second, out over the last 0.4 s; never outside 0..1.
        const k = clamp(Math.min((this.flusterUntil - now) / 400, (now - (this.flusterStart || now)) / 250), 0, 1);
        // Aim both hands at the spot between the tops of his legs (worked out once,
        // in each hand's own units), one a little left, one a little right.
        if (!this._flusterAim) {
          const legL = this.q('motion-leg-left'), legR = this.q('motion-leg-right'), torso = this.q('torso-root');
          const aim = {};
          if (legL && legR && torso) {
            const l = legL.getBoundingClientRect(), r = legR.getBoundingClientRect(), t = torso.getBoundingClientRect();
            const tx = (l.right + r.left) / 2;
            const ty = Math.max(t.top + t.height * .84, Math.min(l.top, r.top) + 2);
            [['left', -1], ['right', 1]].forEach(([side, sign]) => {
              const hand = this.q(`motion-hand-${side}`);
              if (!hand || !hand.parentNode || !hand.parentNode.getScreenCTM) return;
              const hb = hand.getBoundingClientRect();
              const inv = hand.parentNode.getScreenCTM().inverse();
              const p0 = new DOMPoint(hb.left + hb.width / 2, hb.top + hb.height / 2).matrixTransform(inv);
              const p1 = new DOMPoint(tx + sign * hb.width * .28, ty).matrixTransform(inv);
              aim[side] = [p1.x - p0.x, p1.y - p0.y];
            });
          }
          this._flusterAim = aim;
        }
        // Brows flipped upside down and pulled in: cross and embarrassed.
        if (k > .3) {
          this._appendTransform(this.q('motion-brow-left'), 'translateY(6px) rotate(10deg) scale(1,-1)');
          this._appendTransform(this.q('motion-brow-right'), 'translateY(6px) rotate(-10deg) scale(1,-1)');
        }
        const aimL = this._flusterAim.left || [150, 230], aimR = this._flusterAim.right || [-150, 235];
        this._appendTransform(this.q('motion-hand-left'), `translate(${(aimL[0] * k).toFixed(1)}px,${(aimL[1] * k).toFixed(1)}px)`);
        this._appendTransform(this.q('motion-hand-right'), `translate(${(aimR[0] * k).toFixed(1)}px,${(aimR[1] * k).toFixed(1)}px)`);
        this._appendTransform(this.q('character-motion-root'), `translateY(${(6 * k).toFixed(1)}px) rotate(${(-3 * k * (this.direction || 1)).toFixed(2)}deg)`);
      } else if (this._flusterWasOn || (this._squeezeWasOn && !(this.squeezeUntil && now < this.squeezeUntil))) {
        this._display(this.q('motion-eye-left'), true);
        this._display(this.q('motion-eye-right'), true);
        if (typeof this._applyFace === 'function') this._applyFace();
      }
      this._flusterWasOn = !!flustered && !lying;
      this._squeezeWasOn = !!(this.squeezeUntil && now < this.squeezeUntil);
      // Teeth gritted instead of a yell (decided per grab).
      if (this._tailPullFace && this._tailPull && !this._tailPull.mouthOpen && !lying && this.viseme === 'idle') {
        show('fx-mouth-square', false);
        this._hideAllMouths();
        this._display(this.q('g-mouth-pout'), true);
      }
      // Hard landing: legs out to the sides, sat on the floor, hands over his face.
      const slumped = this._slumped(now) && !lying;
      if (slumped) {
        const k = clamp(Math.min((this.slumpUntil - now) / 600, (now - this.slumpStart) / 180), 0, 1);
        const drop = 100 * k;
        this._appendTransform(this.q('character-motion-root'), `translateY(${drop.toFixed(1)}px) scale(${(1 + .03 * k).toFixed(3)},${(1 - .03 * k).toFixed(3)})`);
        this._appendTransform(this.q('tail-root'), `translateY(${drop.toFixed(1)}px) rotate(${(30 * k).toFixed(1)}deg)`);
        this._legTransform('left', 66 * k, -4 * k);
        this._legTransform('right', -66 * k, -4 * k);
        this._appendTransform(this.q('motion-head-root'), `translateY(${(10 * k).toFixed(1)}px) rotate(${(4 * k * (this.direction || 1)).toFixed(2)}deg)`);
        // Hands over his eyes (aimed once, in each hand's own units).
        if (!this._slumpAim) {
          const aim = {};
          // Both hands to the middle of his face, one partly over the other.
          const eL = this.q('motion-eye-left'), eR = this.q('motion-eye-right');
          const lb = eL && eL.getBoundingClientRect(), rb = eR && eR.getBoundingClientRect();
          if (lb && rb && lb.width && rb.width) {
            const cx = (lb.left + lb.right + rb.left + rb.right) / 4;
            const cy = (lb.top + lb.bottom + rb.top + rb.bottom) / 4;
            [['left', -1], ['right', 1]].forEach(([side, sign]) => {
              const hand = this.q(`motion-hand-${side}`);
              if (!hand || !hand.parentNode || !hand.parentNode.getScreenCTM) return;
              const hb = hand.getBoundingClientRect();
              const inv = hand.parentNode.getScreenCTM().inverse();
              const p0 = new DOMPoint(hb.left + hb.width / 2, hb.top + hb.height / 2).matrixTransform(inv);
              const p1 = new DOMPoint(cx + sign * hb.width * .5, cy - hb.height * .12 + (side === 'left' ? -1 : 1) * hb.height * .06).matrixTransform(inv);
              // Scaled up about its pivot, so allow for the shift that brings.
              const [ox, oy] = String(hand.getAttribute('data-pivot') || '0,0').split(',').map(Number);
              const S = this.SLUMP_HAND_SCALE || 1.5;
              aim[side] = [p1.x - p0.x - (S - 1) * (p0.x - ox), p1.y - p0.y - (S - 1) * (p0.y - oy)];
            });
          }
          this._slumpAim = aim;
        }
        let aL = this._slumpAim.left || [120, -250];
        const aR = this._slumpAim.right || [-120, -250];
        // Peeking at her between his fingers: one hand slips down, then covers again.
        const pe = this.slumpPeek;
        if (pe) {
          if (now >= pe.until) this.slumpPeek = null;
          else { const pk = clamp(Math.min((now - pe.start) / 350, (pe.until - now) / 400), 0, 1); aL = [aL[0] * (1 - .25 * pk), aL[1] * (1 - .32 * pk)]; }
        }
        const hs = 1 + ((this.SLUMP_HAND_SCALE || 1.5) - 1) * k;
        // Crying where he landed: shoulders heaving, hands never leave his face.
        const sob = this.slumpCry ? Math.max(0, Math.sin(now / 1000 * 8)) * k : 0;
        this._appendTransform(this.q('motion-hand-left'), `translate(${(aL[0] * k).toFixed(1)}px,${(aL[1] * k + sob * 4).toFixed(1)}px) scale(${hs.toFixed(3)})`);
        this._appendTransform(this.q('motion-hand-right'), `translate(${(aR[0] * k).toFixed(1)}px,${(aR[1] * k + sob * 4).toFixed(1)}px) scale(${hs.toFixed(3)})`);
        if (sob) {
          this._appendTransform(this.q('motion-head-root'), `translateY(${(sob * 4).toFixed(1)}px)`);
          this._appendTransform(this.q('character-motion-root'), `translateY(${(sob * 2.5).toFixed(1)}px)`);
        }
        const tears = this.slumpCry && this._tears();
        if (tears) {
          if (!this._slumpTearAim) {
            const eL = this.q('motion-eye-left'), eR = this.q('motion-eye-right'), head = this.q('motion-head-root');
            const lb = eL && eL.getBoundingClientRect(), rb = eR && eR.getBoundingClientRect();
            const hctm = head && head.getScreenCTM && head.getScreenCTM();
            if (lb && rb && lb.width && rb.width && hctm) {
              const inv = hctm.inverse(), w = rb.right - lb.left;
              this._slumpTearAim = {L:new DOMPoint(lb.left - w * .1, lb.bottom + lb.height * .9).matrixTransform(inv),
                                    R:new DOMPoint(rb.right + w * .1, rb.bottom + rb.height * .9).matrixTransform(inv)};
            }
          }
          const aim = this._slumpTearAim;
          if (aim) {
            tears.setAttribute('display', 'inline');
            tears.setAttribute('opacity', k.toFixed(2));
            tears.querySelectorAll('.tear').forEach(t => {
              const i = Number(t.getAttribute('data-i'));
              const from = i % 2 ? aim.R : aim.L;
              const phase = ((now / 1000 * .8) + (i > 1 ? .5 : 0)) % 1;
              t.setAttribute('transform', `translate(${(from.x + (i % 2 ? 6 : -6) * phase).toFixed(1)} ${(from.y + 60 * phase).toFixed(1)}) scale(${(1 - .4 * phase).toFixed(2)})`);
              t.setAttribute('opacity', (1 - phase * .8).toFixed(2));
            });
          }
        }
        if (handsRoot && handsRoot.parentNode && !this._handsInFront) { handsRoot.parentNode.appendChild(handsRoot); this._handsInFront = true; }
        // Skin on skin: a soft dark edge so the hands read against his face.
        this._handEdge(true);
        show('fx-blush-deep', true);
        this._display(this.q('g-eye-left'), false);
        this._display(this.q('g-eye-right'), false);
        this._display(this.q('motion-eye-left'), false);
        this._display(this.q('motion-eye-right'), false);
        this._display(this.q('expression-closed-eyes'), true);
        if (this.viseme === 'idle') { this._hideAllMouths(); this._display(this.q('g-mouth-pout'), true); }
        this._appendTransform(this.q('motion-brow-left'), 'translate(6px,-4px) rotate(-10deg)');
        this._appendTransform(this.q('motion-brow-right'), 'translate(-6px,-4px) rotate(10deg)');
      } else if (this._slumpWasOn) {
        this._handEdge(false);
        if (this.slumpCry && !(this.cryUntil && now < this.cryUntil)) { const t = this._tears(); if (t) t.setAttribute('display', 'none'); }
        this.slumpCry = false;
        this._slumpTearAim = null;
        if (!flustered && handsRoot && outfits && this._handsInFront) { outfits.parentNode.insertBefore(handsRoot, outfits); this._handsInFront = false; }
        this._display(this.q('expression-closed-eyes'), false);
        this._display(this.q('motion-eye-left'), true);
        this._display(this.q('motion-eye-right'), true);
        if (typeof this._applyFace === 'function') this._applyFace();
      }
      this._slumpWasOn = slumped;
      // Sulking after being thrown about: anger mark, pout, frowning brows.
      if (this.sulk && now > this.sulk.until) this.sulk = null;
      if (this.sulk && !lying) {
        this._display(this.q('desktop-angry-mark'), true);
        if (this.viseme === 'idle') { this._hideAllMouths(); this._display(this.q('g-mouth-pout'), true); }
        this._appendTransform(this.q('motion-brow-left'), 'translateY(4px) rotate(9deg)');
        this._appendTransform(this.q('motion-brow-right'), 'translateY(4px) rotate(-9deg)');
        this._sulkShown = true;
      } else if (this._sulkShown && !this.sulk) {
        // Made up (or it blew over): the mark and the pout go with it, not some while later.
        this._sulkShown = false;
        if (!(this.glareUntil && now < this.glareUntil) && !this._maidSulk) this._display(this.q('desktop-angry-mark'), false);
        if (typeof this._applyFace === 'function') this._applyFace();
      }
      if (dizzy) {
        // Four stars on a flat ring above his head; the far side smaller.
        const base = now / 1000 * 3.6;
        for (let i = 0; i < 4; i++) {
          const star = this.q(`fx-star-${i}`);
          if (!star) continue;
          const a = base + i * Math.PI / 2;
          const depth = .78 + .22 * Math.sin(a);
          star.setAttribute('transform', `translate(${(378 + 270 * Math.cos(a)).toFixed(1)} ${(-470 + 70 * Math.sin(a)).toFixed(1)}) scale(${depth.toFixed(3)}) rotate(${(a * 40).toFixed(1)})`);
        }
      }
    }

    // ---- antics: little things he does by himself ---------------------------
    // Instant ones last a couple of seconds; long ones run for a random while
    // (mostly under two minutes, now and then several) until something
    // interrupts: being picked up, poked, knocked, falling asleep.
    static get INSTANT_ANTICS() { return {stretch:2600, hair:2300, bow:2500, sneeze:1900}; }
    static get LONG_ANTICS() { return ['doze','fairies','read','tea','guitar','embroider']; }

    _anticDuration(random=Math.random) {
      const r = random();
      if (r < .6) return 20000 + random() * 70000;       // 20–90 s
      if (r < .9) return 90000 + random() * 150000;      // 1.5–4 min
      return 240000 + random() * 240000;                 // 4–8 min: he's really into it
    }

    // Is that hand holding something (a cup, a book, a prop, the guitar)?
    _handBusy(side) {
      if (this.performanceMode === 'guitar' || this.state === 'reading') return true;
      if (side === 'right' && this.state === 'tea') return true;
      const hand = this.q(`motion-hand-${side}`);
      if (!hand) return false;
      return [...hand.children].some(c => /^prop-/.test(c.id || '') && c.getAttribute('display') !== 'none' && c.style.display !== 'none');
    }

    startAntic(type, options={}) {
      if (this._busyBody() || this.seat > .02 || this.sulk || this.antic) return false;
      // Hands full: no reaching up to his hair with a cup in that hand, no stretching with things in them.
      let hairHand = 'right';
      if (type === 'hair') {
        const rBusy = this._handBusy('right'), lBusy = this._handBusy('left');
        if (rBusy && lBusy) return false;
        hairHand = rBusy ? 'left' : 'right';
      }
      if (type === 'stretch' && (this._handBusy('right') || this._handBusy('left'))) return false;
      const now = nowMs();
      const instant = ArthurDesktopRuntime.INSTANT_ANTICS[type];
      const long = ArthurDesktopRuntime.LONG_ANTICS.includes(type);
      if (!instant && !long) return false;
      if (this.anticAllowed && !this.anticAllowed(type)) return false;
      if (this.blanket && !['doze', 'fairies', 'sneeze', 'hair'].includes(type)) return false;   // wrapped up: nothing big
      this.treadmill = null;
      this.walkMotion = null;
      const duration = instant || Number(options.duration) || this._anticDuration();
      this.antic = {type, start:now, until:now + duration, long, side:Math.random() < .5 ? -1 : 1, nextBeat:now + 4000 + Math.random() * 6000, hand:hairHand};
      if (type === 'guitar') { this.playGuitar(true); this._display(this.q('desktop-music-notes'), true); }
      if (type === 'read' || type === 'tea') {
        this.localHoldUntil = Date.now() + duration;
        this.setLifeState(type === 'read' ? 'reading' : 'tea');
      }
      if (type === 'fairies') {
        this.direction = this.facingTarget = this.antic.side;
        this.antic.region = options.region || this.fairyRegion || 'home';
      }
      this._emit('desktop-action', `antic:${type}`);
      if (this.onAntic) this.onAntic(type, 'start');
      return true;
    }

    stopAntic(reason='done') {
      const a = this.antic;
      if (!a) return false;
      this.antic = null;
      if (a.type === 'guitar') this.playGuitar(false);
      if (a.type === 'fairies' && ['poked','interrupted','startled'].includes(reason)) {
        // Startled away: they burst off in every direction and are gone.
        this.fairyScatter = {start:nowMs(), x:a.fairyAt ? a.fairyAt.x : 378, y:a.fairyAt ? a.fairyAt.y : -170, spin:Math.random() * Math.PI * 2};
      }
      if ((a.type === 'read' || a.type === 'tea') && ['reading','tea'].includes(this.state)) {
        this.localHoldUntil = 0;
        if (reason !== 'status') super.setLifeState('awake');
      }
      this._display(this.q('fx-zz'), false);
      this._display(this.q('prop-embroidery'), false);
      if (a.type === 'embroider' && !this._slumped()) this._handEdge(false);
      if (a.type === 'embroider' && reason === 'poked') this.hideStitchingUntil = nowMs() + 2600;
      if (!this.fairyScatter) this._display(this.q('fx-fairy'), false);
      if (typeof this._applyFace === 'function') this._applyFace();   // eyes and mouth back to normal
      this._emit('desktop-action', `antic-end:${a.type}:${reason}`);
      if (this.onAntic) this.onAntic(a.type, 'end', reason);
      return true;
    }

    _renderAntic(now) {
      const a = this.antic;
      this._anticEyes = null;
      this._anticMouth = null;
      // Wrappers only antics move (ears, hats): set fresh every frame, never stacked.
      const FRINGE = ['motion-hair-fringe-left','motion-hair-fringe-right','motion-hair-fringe-center','motion-hair-fringe-center-right','motion-hair-cheek-left','motion-hair-cheek-right'];
      const OWNED = ['twitch-ear-left','twitch-ear-right','lift-hat-city','lift-hat-pirate','lift-hat-gown','lift-hat-garden','lift-hat-barbour','lift-hat-maid','tilt-face'].concat(FRINGE);
      OWNED.forEach(id => { const el = this.q(id); if (el && el.style.transform) el.style.transform = ''; });
      const own = (id, transform) => { const el = this.q(id); if (el) el.style.transform = transform; };
      if (this.fairyScatter) {
        const sc = this.fairyScatter;
        const e = clamp((now - sc.start) / 850, 0, 1);
        if (e >= 1 || (a && a.type === 'fairies')) {
          this.fairyScatter = null;
          if (!(a && a.type === 'fairies')) this._display(this.q('fx-fairy'), false);
        } else {
          this._display(this.q('fx-fairy'), true);
          const out = 1 - Math.pow(1 - e, 3);
          for (let i = 0; i < 5; i++) {
            const sp = this.q(`fx-spark-${i}`);
            if (!sp) continue;
            const ang = sc.spin + i * Math.PI * 2 / 5;
            sp.setAttribute('transform', `translate(${(sc.x + Math.cos(ang) * 900 * out).toFixed(1)} ${(sc.y + Math.sin(ang) * 700 * out - 200 * out).toFixed(1)}) scale(${(1 - .6 * e).toFixed(2)})`);
            sp.setAttribute('opacity', (1 - e).toFixed(2));
          }
        }
      }
      if (!a) return;
      // Interrupted by the world. Only her hands on him are her doing: a fall he didn't
      // ask for (the window under him went: a desktop switch, say) still startles the
      // fairies off, but that's nobody's fault; sleep or a hop of his own just ends it.
      if (this.held && this.held.mode === 'drag' && !this.held.wasPat) { this.stopAntic('interrupted'); return; }
      if (this.hostCarry || this._knockedOut(now)) { this.stopAntic('startled'); return; }
      if (this.state === 'sleep' || this.sleepSequence || this.hostLeap) { this.stopAntic('ended'); return; }
      if (a.type === 'read' && this.state !== 'reading' || a.type === 'tea' && this.state !== 'tea') {
        if (!this.transition) { this.stopAntic('status'); return; }
      }
      if (now >= a.until) { this.stopAntic('done'); return; }
      const t = now - a.start;
      const total = a.until - a.start;
      const u = clamp(t / total, 0, 1);
      const ease = x => smoothstep(clamp(x, 0, 1));
      // in-and-out envelope for the instant ones
      const env = (inEnd, outStart) => Math.min(ease(u / inEnd), ease((1 - u) / (1 - outStart)));
      const hands = (lx, ly, rx, ry) => {
        if (this.performanceMode === 'guitar') return;
        this._appendTransform(this.q('motion-hand-left'), `translate(${lx.toFixed(1)}px,${ly.toFixed(1)}px)`);
        this._appendTransform(this.q('motion-hand-right'), `translate(${rx.toFixed(1)}px,${ry.toFixed(1)}px)`);
      };
      const head = transform => this._appendTransform(this.q('motion-head-root'), transform);
      const body = transform => this._appendTransform(this.q('character-motion-root'), transform);
      // Little things that fit what he's doing, now and then, a second or two each.
      // Returns {kind, p} (p: 0..1 through it) while one is happening.
      const beat = (kinds, gap=[9000, 20000]) => {
        if (!a.beatAt) a.beatAt = now + 5000 + Math.random() * 7000;
        if (!a.beatNow && now >= a.beatAt) {
          const [kind, ms] = kinds[Math.floor(Math.random() * kinds.length)];
          a.beatNow = {kind, ms, start:now};
          a.beatAt = now + gap[0] + Math.random() * (gap[1] - gap[0]);
          if (this.onAntic) this.onAntic(a.type, 'beat', kind);
        }
        const b = a.beatNow;
        if (!b) return null;
        const p = (now - b.start) / b.ms;
        if (p >= 1) { a.beatNow = null; return null; }
        return {kind:b.kind, p, k:Math.sin(Math.min(1, p) * Math.PI)};
      };
      this._display(this.q('prop-embroidery'), a.type === 'embroider');
      switch (a.type) {
        case 'embroider': {
          // Hoop in front of his chest, eyes on it; the right hand stitches up and away.
          if (!a.aim) {
            a.aim = {};
            const hoop = this.q('embroidery-hoop');
            const hb = hoop && hoop.getBoundingClientRect();
            if (hb && hb.width) {
              [['left', hb.left + hb.width * .02, hb.top + hb.height * .66], ['right', hb.left + hb.width * .98, hb.top + hb.height * .36]].forEach(([side, tx, ty]) => {
                const hand = this.q(`motion-hand-${side}`);
                if (!hand || !hand.parentNode || !hand.parentNode.getScreenCTM) return;
                const r = hand.getBoundingClientRect();
                const inv = hand.parentNode.getScreenCTM().inverse();
                const p0 = new DOMPoint(r.left + r.width / 2, r.top + r.height / 2).matrixTransform(inv);
                const p1 = new DOMPoint(tx, ty).matrixTransform(inv);
                a.aim[side] = [p1.x - p0.x, p1.y - p0.y];
              });
            }
          }
          const k = ease(t / 700);
          const eb = beat([['prick', 1100], ['admire', 1900]]);
          const pause = eb ? 1 - eb.k : 1;
          const stitch = Math.max(0, Math.sin(t / 1000 * 2.2)) * pause;          // pull the thread up, then back down
          const L = a.aim.left || [180, 60], R = a.aim.right || [-150, 40];
          let rx = 0, ry = 0, lift = 0;
          if (eb && eb.kind === 'prick') {
            // Needle in the finger: the right hand snaps away and shakes.
            rx = 70 * eb.k + Math.sin(now / 1000 * 40) * 10 * eb.k; ry = -30 * eb.k;
            if (eb.p < .5) this.squeezeUntil = Math.max(this.squeezeUntil || 0, now + 120);
          } else if (eb && eb.kind === 'admire') {
            // Holds it up and away to see how it's coming on.
            lift = -40 * eb.k;
            head(`rotate(${(-6 * eb.k).toFixed(2)}deg)`);
            if (eb.p > .4) this._anticMouth = 'g-mouth-smile';
          }
          hands(L[0] * k, L[1] * k + lift, R[0] * k + 40 * stitch + rx, R[1] * k - 90 * stitch + ry + lift);
          head(`translateY(${(14 * k).toFixed(1)}px) rotate(${(3 * k).toFixed(2)}deg)`);
          const hoopEl = this.q('embroidery-hoop');
          // Its place in the drawing is its own transform attribute: a CSS transform would
          // replace that (and the hoop flew to the corner while he admired it). Add to it.
          if (hoopEl) {
            if (hoopEl._baseTransform === undefined) hoopEl._baseTransform = hoopEl.getAttribute('transform') || '';
            hoopEl.setAttribute('transform', lift ? `${hoopEl._baseTransform} translate(0 ${(lift / 1.2).toFixed(1)})` : hoopEl._baseTransform);
          }
          const needle = this.q('embroidery-needle');
          if (needle) needle.setAttribute('transform', `translate(${(40 * stitch - 30).toFixed(1)} ${(-90 * stitch + 10).toFixed(1)})`);
          const thread = this.q('embroidery-thread');
          if (thread) thread.setAttribute('d', `M392 342 C${(400 + 20 * stitch).toFixed(0)} ${(330 - 40 * stitch).toFixed(0)} ${(410 + 30 * stitch).toFixed(0)} ${(290 - 60 * stitch).toFixed(0)} ${(422 + 40 * stitch).toFixed(0)} ${(254 - 90 * stitch).toFixed(0)}`);
          this._handEdge(true);
          break;
        }
        case 'stretch': {
          const k = env(.3, .72);
          hands(-50 * k, -820 * k, 50 * k, -820 * k);
          body(`translateY(${(-10 * k).toFixed(1)}px) scale(${(1 - .04 * k).toFixed(3)},${(1 + .07 * k).toFixed(3)})`);
          head(`translateY(${(-18 * k).toFixed(1)}px) rotate(${(-3 * k).toFixed(2)}deg)`);
          if (k > .55) { this._anticEyes = 'closed'; this._anticMouth = 'g-mouth-open-wide'; }
          break;
        }
        case 'hair': {
          const k = env(.28, .62);
          const flick = Math.sin(clamp((u - .28) / .34, 0, 1) * Math.PI * 3) * k;
          if (a.hand === 'left') {
            // The right hand's full: the left one goes up instead (mirrored).
            hands(110 * k - 40 * flick, -660 * k, 0, 0);
            head(`rotate(${(5 * k - 3 * flick).toFixed(2)}deg)`);
          } else {
            hands(0, 0, -110 * k + 40 * flick, -660 * k);
            head(`rotate(${(-5 * k + 3 * flick).toFixed(2)}deg)`);
          }
          if (u > .66) { this._anticMouth = 'g-mouth-smile'; head(`translateY(${(Math.sin((u - .66) / .34 * Math.PI * 2) * 10).toFixed(1)}px)`); }
          break;
        }
        case 'bow': {
          const k = env(.3, .66);
          const hat = ['city','pirate','gown','garden','barbour'].includes(this.outfit);
          hands(hat ? 20 * k : 0, hat ? -650 * k : 0, -165 * k, 85 * k);
          // The head only dips a little; the face, fringe, brows and ears slide
          // further down/forward over it, so it reads as a nod, not a squashed bun.
          head(`translateY(${(22 * k).toFixed(1)}px) rotate(${(2 * k).toFixed(2)}deg)`);
          own('tilt-face', `translateY(${(46 * k).toFixed(1)}px)`);
          // Brows are rewritten every frame by the base runtime, so appending is safe;
          // hair locks only use translate/rotate/scale, so their transform is ours.
          ['motion-brow-left','motion-brow-right'].forEach(id => this._appendTransform(this.q(id), `translateY(${(40 * k).toFixed(1)}px)`));
          FRINGE.forEach(id => own(id, `translateY(${(40 * k).toFixed(1)}px)`));
          ['twitch-ear-left','twitch-ear-right'].forEach(id => own(id, `translateY(${(30 * k).toFixed(1)}px)`));
          body(`translateY(${(8 * k).toFixed(1)}px)`);
          if (hat) ['lift-hat-city','lift-hat-pirate','lift-hat-gown','lift-hat-garden','lift-hat-barbour'].forEach(id => own(id, `translateY(${(-90 * k).toFixed(1)}px) rotate(${(-10 * k).toFixed(2)}deg)`));
          if (k > .5) this._anticEyes = 'closed';
          break;
        }
        case 'sneeze': {
          // wind-up (0–.45), achoo (.45–.55), recover
          const wind = ease(u / .45) * (u < .5 ? 1 : 0);
          const snap = u >= .45 ? Math.max(0, 1 - (u - .45) / .45) : 0;
          head(`translateY(${(-14 * wind + 22 * snap).toFixed(1)}px) rotate(${(-7 * wind + 6 * snap).toFixed(2)}deg)`);
          body(`scale(${(1 + .05 * snap).toFixed(3)},${(1 - .06 * snap).toFixed(3)})`);
          // (Folded ears: they stay put.)
          if (u > .15 && u < .7) this._anticEyes = 'closed';
          this._anticMouth = u < .45 ? (u > .2 ? 'g-mouth-open-small' : null) : (snap > .4 ? 'g-mouth-open-wide' : null);
          break;
        }
        case 'doze': {
          // Head nods slowly; now and then he jerks awake and pretends nothing happened.
          if (now >= a.nextBeat) { a.jolt = now; a.nextBeat = now + 18000 + Math.random() * 30000; }
          const jolt = a.jolt ? clamp(1 - (now - a.jolt) / 1400, 0, 1) : 0;
          const settle = ease(t / 2500);
          const nod = (Math.sin(t / 1000 * 1.1) + 1) / 2;
          head(`translateY(${((22 + 14 * nod) * settle * (1 - jolt)).toFixed(1)}px) rotate(${((5 + 3 * nod) * settle * (1 - jolt)).toFixed(2)}deg)`);
          body(`translateY(${(4 * settle * (1 - jolt)).toFixed(1)}px)`);
          if (jolt < .2) this._anticEyes = 'closed';
          const db = jolt ? null : beat([['smack', 900], ['shift', 1400]], [14000, 30000]);
          if (db && db.kind === 'smack') this._anticMouth = Math.floor(db.p * 6) % 2 ? 'g-mouth-open-small' : 'g-mouth-neutral';
          if (db && db.kind === 'shift') body(`translateX(${(8 * db.k * (a.side || 1)).toFixed(1)}px) rotate(${(3 * db.k * (a.side || 1)).toFixed(2)}deg)`);
          this._display(this.q('fx-zz'), jolt < .1);
          for (let i = 0; i < 3; i++) {
            const z = this.q(`fx-z-${i}`);
            if (!z) continue;
            const phase = ((t / 1000 * .45) + i / 3) % 1;
            z.setAttribute('transform', `translate(${(560 + 90 * phase + 30 * i).toFixed(1)} ${(-330 - 240 * phase).toFixed(1)})`);
            z.setAttribute('opacity', (Math.sin(phase * Math.PI)).toFixed(2));
          }
          break;
        }
        case 'fairies': {
          // Side-on, with friends only he can see. He's at ease with them: he talks,
          // listens with a smile, laughs, goes soft, and now and then tells one off.
          // They flit all round him; he turns and looks wherever they are.
          if (!a.flight) {
            const rnd = () => Math.random() * Math.PI * 2;
            a.flight = {fx:[.11 + Math.random() * .08, .27 + Math.random() * .12], fy:[.14 + Math.random() * .1, .33 + Math.random() * .14], px:[rnd(), rnd()], py:[rnd(), rnd()]};
          }
          const fl = a.flight, ts = t / 1000;
          const fcx = 378 + 600 * (.65 * Math.sin(ts * fl.fx[0] * Math.PI * 2 + fl.px[0]) + .35 * Math.sin(ts * fl.fx[1] * Math.PI * 2 + fl.px[1]));
          const fcy = -170 + 280 * (.6 * Math.sin(ts * fl.fy[0] * Math.PI * 2 + fl.py[0]) + .4 * Math.sin(ts * fl.fy[1] * Math.PI * 2 + fl.py[1]));
          a.fairyAt = {x:fcx, y:fcy};
          if (fcx > 378 + 70) a.side = 1; else if (fcx < 378 - 70) a.side = -1;
          this.direction = this.facingTarget = a.side;
          if (this.attention) {
            this.attention.strength = .75;
            this.attention.targetX = clamp((fcx - 378) / 600, -1, 1) * 30;
            this.attention.targetY = clamp((fcy - 20) / 420, -1, 1) * 24;
          }
          if (now >= a.nextBeat) {
            const r = Math.random();
            a.mood = r < .28 ? 'talk' : r < .5 ? 'listen' : r < .72 ? 'laugh' : r < .88 ? 'fond' : 'huff';
            a.moodStart = now;
            a.nextBeat = now + (a.mood === 'laugh' ? 2200 + Math.random() * 1800 : 3500 + Math.random() * 4500);
            if (this.onAntic) this.onAntic('fairies', 'mood', a.mood);
            if ((a.mood === 'fond' || a.mood === 'laugh') && Math.random() < .25 && typeof this.spawnFlowers === 'function') this.spawnFlowers();
          }
          const mt = now - (a.moodStart || a.start);
          switch (a.mood || 'listen') {
            case 'talk':
              head(`rotate(${(a.side * 4).toFixed(2)}deg)`);
              this._anticMouth = Math.floor(t / 170) % 2 ? 'g-mouth-open-small' : 'g-mouth-smile';
              break;
            case 'listen':
              head(`rotate(${(a.side * 7).toFixed(2)}deg) translateY(${(Math.max(0, Math.sin(t / 1000 * 2.4)) * 8).toFixed(1)}px)`);
              this._anticMouth = 'g-mouth-smile';
              break;
            case 'laugh': {
              const shake = Math.sin(mt / 1000 * 18) * Math.max(0, 1 - mt / 2600);
              head(`rotate(${(a.side * 3 - 5).toFixed(2)}deg) translateY(${(-6 + 5 * shake).toFixed(1)}px)`);
              body(`translateY(${(4 * Math.abs(shake)).toFixed(1)}px)`);
              this._anticEyes = 'closed';
              this._anticMouth = 'g-mouth-open-wide';
              break;
            }
            case 'fond':
              head(`rotate(${(a.side * 9).toFixed(2)}deg)`);
              this._anticEyes = mt % 3000 < 1400 ? 'closed' : null;
              this._anticMouth = 'g-mouth-smile';
              break;
            case 'huff':
              head(`rotate(${(-a.side * 5).toFixed(2)}deg)`);
              this._anticMouth = 'g-mouth-pout';
              this._appendTransform(this.q('motion-brow-left'), 'translateY(4px) rotate(9deg)');
              this._appendTransform(this.q('motion-brow-right'), 'translateY(4px) rotate(-9deg)');
              break;
          }
          this._display(this.q('fx-fairy'), true);
          const cx = fcx, cy = fcy;
          for (let i = 0; i < 5; i++) {
            const sp = this.q(`fx-spark-${i}`);
            if (!sp) continue;
            const ang = t / 1000 * (1.3 + i * .21) + i * 1.3;
            const tw = .35 + .65 * Math.abs(Math.sin(t / 1000 * (2.2 + i * .4) + i));
            sp.setAttribute('transform', `translate(${(cx + Math.cos(ang) * (60 + i * 18)).toFixed(1)} ${(cy + Math.sin(ang * 1.3) * (50 + i * 10)).toFixed(1)}) scale(${tw.toFixed(2)})`);
            sp.setAttribute('opacity', tw.toFixed(2));
          }
          break;
        }
        case 'guitar': {
          // Long session: hums now and then, bobs to the beat.
          if (this.performanceMode !== 'guitar') { this.stopAntic('status'); return; }
          if (now >= a.nextBeat) {
            a.nextBeat = now + 9000 + Math.random() * 9000;
            this.speakArpabet(['L AA L AA / L AA','HH M M / HH M M','D UW D UW / D AA'][Math.floor(Math.random() * 3)], 170);
          }
          body(`translateY(${(Math.max(0, Math.sin(t / 1000 * Math.PI * 2 * 1.6)) * -5).toFixed(1)}px)`);
          const gb = beat([['flourish', 1600], ['wrong', 1500]], [12000, 26000]);
          if (gb && gb.kind === 'flourish') {
            // Lost in a big chord: eyes shut, head thrown back.
            this._anticEyes = 'closed';
            head(`rotate(${(-8 * gb.k).toFixed(2)}deg) translateY(${(-8 * gb.k).toFixed(1)}px)`);
            this._anticMouth = 'g-mouth-smile';
          } else if (gb && gb.kind === 'wrong') {
            // A wrong note: stops dead and glares at the guitar.
            head(`rotate(${(6 * gb.k).toFixed(2)}deg) translateY(${(10 * gb.k).toFixed(1)}px)`);
            this._anticMouth = 'g-mouth-pout';
            this._appendTransform(this.q('motion-brow-left'), `translateY(${(4 * gb.k).toFixed(1)}px) rotate(${(9 * gb.k).toFixed(1)}deg)`);
            this._appendTransform(this.q('motion-brow-right'), `translateY(${(4 * gb.k).toFixed(1)}px) rotate(${(-9 * gb.k).toFixed(1)}deg)`);
          }
          break;
        }
        case 'read': {
          // Reading: a page turned, a push at his glasses, a frown at something, a small smile.
          const rb = beat([['page', 800], ['glasses', 1000], ['frown', 1600], ['smile', 1600]], [8000, 18000]);
          if (rb && rb.kind === 'page') hands(0, 0, -60 * rb.k, -20 * rb.k);
          else if (rb && rb.kind === 'glasses') {
            if (!a.noseAim) { const nb = this.q('g-nose') && this.q('g-nose').getBoundingClientRect(); a.noseAim = nb && nb.width ? (this._aimHands(nb.left + nb.width / 2, nb.top - nb.height * .3, 0).right || [-120, -300]) : [-120, -300]; }
            hands(0, 0, a.noseAim[0] * rb.k, a.noseAim[1] * rb.k);
          } else if (rb && rb.kind === 'frown') {
            this._appendTransform(this.q('motion-brow-left'), `translate(${(8 * rb.k).toFixed(1)}px,${(-4 * rb.k).toFixed(1)}px) rotate(${(-10 * rb.k).toFixed(1)}deg)`);
            this._appendTransform(this.q('motion-brow-right'), `translate(${(-8 * rb.k).toFixed(1)}px,${(-4 * rb.k).toFixed(1)}px) rotate(${(10 * rb.k).toFixed(1)}deg)`);
            head(`translateY(${(6 * rb.k).toFixed(1)}px)`);
          } else if (rb && rb.kind === 'smile') this._anticMouth = 'g-mouth-smile';
          break;
        }
        case 'tea': {
          // Tea: blows on it, a sip (eyes shut, a little sigh), now and then too hot.
          const tb = beat([['blow', 1000], ['sip', 1300], ['hot', 900]], [8000, 16000]);
          if (tb && tb.kind === 'blow') { this._anticMouth = 'g-mouth-open-small'; head(`translateY(${(8 * tb.k).toFixed(1)}px)`); }
          else if (tb && tb.kind === 'sip') { this._anticEyes = 'closed'; head(`rotate(${(-5 * tb.k).toFixed(2)}deg) translateY(${(-4 * tb.k).toFixed(1)}px)`); this._anticMouth = tb.p > .6 ? 'g-mouth-smile' : null; }
          else if (tb && tb.kind === 'hot' && tb.p < .6) this.squeezeUntil = Math.max(this.squeezeUntil || 0, now + 120);
          break;
        }
        default: break;
      }
    }

    // How fast his legs go while the app moves him (running after something = faster).
    // Keeps the stride phase continuous when the rate changes.
    setWalkRate(rate=1) {
      const next = Math.max(.3, Math.min(3, Number(rate) || 1));
      if (this.treadmill) {
        const now = nowMs();
        const phase = (now - this.treadmill.startedAt) / 1000 * 8.6 * (this.walkRate || 1);
        this.treadmill.startedAt = now - phase / (8.6 * next) * 1000;
      }
      this.walkRate = next;
    }

    // Out of breath: mouth open, shoulders heaving.
    setTired(on) { this.tired = !!on; }

    // He jumps up by himself (to a window edge above): springy, not dangling.
    hostHop(direction=0) {
      if (direction) this.direction = this.facingTarget = direction < 0 ? -1 : 1;
      this.treadmill = null;
      this.seatTarget = 0;
      this.seat = 0;
      this.hostLeap = {start:nowMs()};
      this._emit('desktop-action', 'host-hop');
      return true;
    }

    hostFall() {
      this.treadmill = null;
      this.hostCarry = true;
      this.seatTarget = 0;
      this.seat = 0;
    }

    canSit() {
      return !this.hostCarry && !this.hostLeap && !this.knockout && !this.dizzy && !this.held && !this.treadmill && this.performanceMode !== 'guitar'
        && !this.antic && !this._slumped()
        && this.state !== 'sleep' && !this.sleepSequence && !this.jumpMotion && !this.landingMotion;
    }

    hostSit(on=true) {
      if (on && !this.canSit()) return false;
      this.seatTarget = on ? 1 : 0;
      this._emit('desktop-action', on ? 'sit' : 'stand');
      return true;
    }

    // Jolted while asleep: eyes open a crack for a moment, then back off.
    stir(ms=2600) {
      if (this.state !== 'sleep') return false;
      this.stirUntil = nowMs() + ms;
      this._emit('body-reaction', 'stir');
      return true;
    }

    // Talking in his sleep: the mouth moves for a little while.
    sleepTalk(ms=2400) {
      if (this.state !== 'sleep') return false;
      this.sleepTalkUntil = nowMs() + ms;
      return true;
    }

    hostLanded() {
      if (this.cradle) { this.cradle = null; if (this.onCradle) this.onCradle('down'); }
      if (this.state === 'sleep' && this.hostCarry) this.stir();
      if (this.hostLeap) {
        this.hostLeap = null;
        this.desktopY = 0;
        this._startLanding();
        return;
      }
      if (!this.hostCarry) return;
      this.hostCarry = false;
      this.desktopY = 0;
      this._applyFace();
      this._startLanding();
    }

    hostPointer(clientX, clientY) {
      this._trackHandHold({clientX, clientY});
      this._trackTailPlay({clientX, clientY});
      this._earHover(clientX, clientY);
      if (this.antic && this.antic.type === 'fairies') return;   // he's looking at them, not at you
      this._updateAttentionTarget({clientX, clientY, target:this.svg});
    }

    hostPointerLeave() {
      if (!this.held) this._pointerLeave();
    }

    stopDesktopMotion(options={}) {
      this.walkMotion = null;
      this.jumpMotion = null;
      this.landingMotion = null;
      if (!options.keepPosition) { this.desktopX = 0; this.desktopY = 0; }
      if (!options.keepEffects) {
        this.playGuitar(false);
        this._display(this.q('desktop-flowers'), false);
        this._display(this.q('desktop-angry-mark'), false);
        this._display(this.q('desktop-landing-dust'), false);
        this._display(this.q('desktop-tail-straight'), false);
        this._display(this.q('tail-root'), true);
        if (this.gloomOverride === false) this._display(this.q('desktop-gloom'), false);
      }
      this._emit('desktop-action', 'stop');
    }

    setDesktopAutonomy(on) {
      this.desktopAutonomy = !!on;
      clearTimeout(this.desktopTimer);
      this.desktopTimer = null;
      const choose = () => {
        if (!this.desktopAutonomy || this.destroyed) return;
        if (this._busyBody() || this.seat > .02 || this.sulk || this.antic || this.treadmill || this.chasingStolen()) {
          this.desktopTimer = setTimeout(choose, 3600 + Math.random() * 4200);
          return;
        }
        const r = Math.random();
        const pickOne = list => list[Math.floor(Math.random() * list.length)];
        if (r < .30) { if (!this.host) this.walkTo(this.walkBounds[0] + Math.random() * (this.walkBounds[1] - this.walkBounds[0])); }
        else if (r < .40) { if (!this.treadmill) this.jump({height:82 + Math.random() * 55}); }
        else if (r < .47 && (this.mood === 'happy' || this.mood === 'excited')) this.spawnFlowers();
        else if (r < .70) this.startAntic(pickOne(['stretch','hair','hair','bow','sneeze']));
        else if (r < .84) this.startAntic(pickOne(ArthurDesktopRuntime.LONG_ANTICS));
        else this.playAction(Math.random() < .5 ? 'look-left' : 'look-right');
        this.desktopTimer = setTimeout(choose, 3600 + Math.random() * 4200);
      };
      if (on) choose();
      this._emit('desktop-autonomy', on ? 'on' : 'off');
    }

    _appendTransform(el, transform) {
      if (!el || !transform) return;
      el.style.transform = `${el.style.transform || ''} ${transform}`.trim();
    }

    _legTransform(side, angle, lift=0) {
      ((this._legEls || {})[side === 'left' ? 'left' : 'right'] || []).forEach(el => {
        el.style.transform = `translateY(${lift}px) rotate(${angle}deg)`;
      });
    }

    _renderFlowers(now) {
      const root = this.q('desktop-flowers');
      if (!root || !this.flowerStart) return;
      const t = (now - this.flowerStart) / this.flowerDuration;
      if (t >= 1) {
        this.flowerStart = 0;
        this._display(root, false);
        return;
      }
      this._display(root, true);
      this.qa('[id^="desktop-flower-"]').forEach((flower, index) => {
        const local = clamp((t - index * .075) / .52, 0, 1);
        const fade = t > .72 ? 1 - (t - .72) / .28 : 1;
        const pop = 1 + Math.sin(local * Math.PI) * .22;
        flower.style.opacity = String(clamp(local * 1.8, 0, 1) * clamp(fade, 0, 1));
        flower.style.transform = `translateY(${-34 * easeOutCubic(t)}px) rotate(${(index % 2 ? 1 : -1) * 10 * Math.sin(t * Math.PI)}deg) scale(${pop})`;
      });
    }

    _renderGloom(now) {
      const root = this.q('desktop-gloom');
      if (!root) return;
      if (this.gloomOverride === true && this.gloomUntil && now >= this.gloomUntil) {
        this.gloomOverride = false;
        this.gloomUntil = 0;
        this._display(root, false);
        this._emit('desktop-effect', 'gloom-timeout');
      }
      const automatic = {bored:.52, anxious:.82, annoyed:.64}[this.mood] || 0;
      const strength = this.gloomOverride === true ? 1 : this.gloomOverride === false ? 0 : automatic;
      this._display(root, strength > 0);
      if (!strength) return;
      const s = now / 1000;
      root.style.opacity = String(.26 + strength * .58 + Math.sin(s * 1.2) * .04);
      const aura = this.q('desktop-gloom-aura');
      const spiral = this.q('desktop-gloom-spiral');
      const drops = this.q('desktop-gloom-drops');
      if (aura) aura.style.transform = `scale(${.96 + Math.sin(s * 1.1) * .025},${1 + Math.sin(s * 1.1) * .035})`;
      if (spiral) spiral.style.transform = `translateY(${Math.sin(s * 1.7) * 6}px) rotate(${s * (18 + strength * 18)}deg)`;
      if (drops) drops.style.transform = `translateY(${(s * 24) % 34}px)`;
      this._appendTransform(this.q('character-motion-root'), `translateY(${strength * 5}px) rotate(${Math.sin(s * .72) * strength * .65}deg)`);
      this._appendTransform(this.q('motion-head-root'), `translateY(${strength * 4}px) rotate(${-strength * 1.8}deg)`);
    }

    _renderPerformance(now) {
      // Picked up (by the shell, or her mouse dragging him): he isn't playing
      // while he dangles. The guitar and its hands go; his own hands come back
      // and swing with him; set down, he plays on. (The guitar hands came
      // loose from him when she lifted him by the neck mid-song.)
      const lifted = this._isActuallyHeld() || !!(this.held && this.held.mode === 'drag');
      const active = this.performanceMode === 'guitar' && !lifted;
      this._display(this.q('desktop-guitar'), active);
      this._display(this.q('hands-root'), !active);
      this._display(this.q('trench-hands'), false);
      if (!active) return;
      const s = now / 1000;
      const beat = Math.sin(s * 7.6);
      const accent = Math.max(0, beat);
      this._appendTransform(this.q('character-motion-root'), `translateY(${accent * -4}px) scale(${1 + accent * .012},${1 - accent * .009})`);
      this._appendTransform(this.q('motion-head-root'), `rotate(${Math.sin(s * 3.8) * 2.2}deg) translateY(${accent * -2}px)`);
      const guitar = this.q('motion-guitar');
      if (guitar) guitar.style.transform = 'rotate(-3deg)';
      const strumPhase = (s * 3.8) % 1;
      const strumArc = Math.sin(strumPhase * Math.PI * 2);
      const pluckEnvelope = Math.exp(-strumPhase * 7.5);
      const stringWobble = Math.sin(strumPhase * Math.PI * 12) * pluckEnvelope * 8;
      const strumHand = this.q('guitar-hand-left');
      const fretHand = this.q('guitar-hand-right');
      if (strumHand) strumHand.style.transform = `translate(${strumArc * 5}px,${strumArc * 15}px) rotate(${strumArc * 9}deg) scale(${1 + Math.abs(strumArc) * .045},${1 - Math.abs(strumArc) * .035})`;
      if (fretHand) fretHand.style.transform = `translate(${Math.sin(s * 1.9) * 3}px,${Math.sin(s * 1.9) * -2}px)`;
      const strings = [
        ['guitar-string-1',[333,386],[568,168]],
        ['guitar-string-2',[336,389],[571,171]],
        ['guitar-string-3',[339,392],[574,174]],
        ['guitar-string-4',[342,395],[577,177]],
        ['guitar-string-5',[345,398],[580,180]],
        ['guitar-string-6',[348,401],[583,183]]
      ];
      strings.forEach(([id, a, b], index) => {
        const el = this.q(id); if (!el || !el.setAttribute) return;
        const mx = (a[0] + b[0]) / 2 + stringWobble * .58;
        const my = (a[1] + b[1]) / 2 + stringWobble * (index - 1) * .24;
        el.setAttribute('d', `M${a[0]} ${a[1]} Q${mx.toFixed(2)} ${my.toFixed(2)} ${b[0]} ${b[1]}`);
      });
      this._legTransform('left', accent * -4.2, accent * -8);
      this._legTransform('right', 0, 0);
      const notes = this.q('desktop-music-notes');
      const singing = now < this.singingUntil;
      this._display(notes, singing);
      if (singing) this.qa('[id^="desktop-note-"]').forEach((note,index) => {
        const phase = (s * .86 + index * .23) % 1;
        note.style.opacity = String(Math.sin(phase * Math.PI));
        note.style.transform = `translateY(${-78 * phase}px) translateX(${Math.sin(phase * Math.PI * 2 + index) * 8}px) scale(${.82 + .26 * Math.sin(phase * Math.PI)})`;
      });
    }

    _renderAttention(dt) {
      const blocked = this._isActuallyHeld() || this.state === 'sleep';
      const targetX = blocked ? 0 : this.attention.targetX;
      const targetY = blocked ? 0 : this.attention.targetY;
      const activeStrength = blocked ? 0 : this.attention.strength;
      const follow = clamp(dt * (6.8 + activeStrength * 18), 0, 1);
      this.attention.x += (targetX - this.attention.x) * follow;
      this.attention.y += (targetY - this.attention.y) * follow;
      const x = this.attention.x + this.facingOffset * 7.5;
      const y = this.attention.y + Math.abs(this.facingOffset) * .8;
      const closeAlarm = activeStrength * activeStrength;

      this._appendTransform(this.q('motion-head-root'), `translate(${x * .11}px,${y * .08}px) scale(${1 + closeAlarm * .012},${1 - closeAlarm * .008})`);

      ['motion-eye-left','motion-eye-right','motion-brow-left','motion-brow-right']
        .forEach(id => this._appendTransform(this.q(id), `translate(${x}px,${y}px)`));
      this._attentionFaceIds.forEach(id => {
        const el = this.q(id);
        if (!el || !el.style) return;
        el.style.translate = `${x}px ${y}px`;
      });
      this._renderHairPhysics(dt, x, y, activeStrength);
    }

    _stepHairSpring(name, targetX, targetY, dt, stiffness, damping) {
      const spring = this.hairPhysics[name];
      if (!spring) return {x:0,y:0};
      const step = clamp(dt, 0, .05);
      spring.vx += (targetX - spring.x) * stiffness * step;
      spring.vy += (targetY - spring.y) * stiffness * step;
      const drag = Math.exp(-damping * step);
      spring.vx *= drag;
      spring.vy *= drag;
      spring.x += spring.vx * step;
      spring.y += spring.vy * step;
      if (Math.abs(spring.x) < .0005 && Math.abs(spring.vx) < .0005) spring.x = spring.vx = 0;
      if (Math.abs(spring.y) < .0005 && Math.abs(spring.vy) < .0005) spring.y = spring.vy = 0;
      return spring;
    }

    _setHairMotion(el, x, y, rotation, scaleX=1, scaleY=1) {
      if (!el || !el.style) return;
      const safeX = clamp(Number(x) || 0, -3.2, 3.2);
      const safeY = clamp(Number(y) || 0, -2.2, 2.2);
      const safeRotation = clamp(Number(rotation) || 0, -HAIR_ROTATION_LIMIT_DEG, HAIR_ROTATION_LIMIT_DEG);
      el.style.translate = `${safeX.toFixed(3)}px ${safeY.toFixed(3)}px`;
      el.style.rotate = `${safeRotation.toFixed(3)}deg`;
      el.style.scale = `${clamp(Number(scaleX) || 1, .97, 1.03).toFixed(4)} ${clamp(Number(scaleY) || 1, .97, 1.03).toFixed(4)}`;
    }

    _renderHairPhysics(dt, gazeX, gazeY, strength) {
      // Cubism-like hierarchy: face angle/velocity drive separate deformers.
      // Roots stay pinned; the short cheek locks react first while longer locks
      // lag, overshoot and settle. Left/right cheek locks keep independent mass.
      const step = Math.max(.001, clamp(dt, 0, .05));
      const rawVx = (gazeX - this.hairInput.x) / step;
      const rawVy = (gazeY - this.hairInput.y) / step;
      const velocityFollow = clamp(step * 17, 0, 1);
      this.hairInput.vx += (rawVx - this.hairInput.vx) * velocityFollow;
      this.hairInput.vy += (rawVy - this.hairInput.vy) * velocityFollow;
      this.hairInput.x = gazeX;
      this.hairInput.y = gazeY;
      const close = strength * strength;
      const inertiaX = clamp(this.hairInput.vx * .0016, -2.4, 2.4);
      const inertiaY = clamp(this.hairInput.vy * .001, -1.5, 1.5);
      const driveX = gazeX * (.018 + strength * .08) - inertiaX * (.25 + strength * .45);
      const driveY = gazeY * (.009 + strength * .032) - inertiaY * (.22 + strength * .36);
      const fringe = this._stepHairSpring('fringe', driveX * .52, driveY * .46, dt, 270, 21.5);
      const side = this._stepHairSpring('side', driveX * .86, driveY * .9, dt, 145, 14.8);
      const outer = this._stepHairSpring('outer', driveX * .68, driveY * .72, dt, 92, 11.6);
      const tuft = this._stepHairSpring('tuft', driveX * .72, driveY * .56, dt, 118, 12.8);
      const direction = Math.sign(gazeX || 1);

      ['left','right'].forEach(sideName => {
        const near = (direction > 0 && sideName === 'right') || (direction < 0 && sideName === 'left');
        const depth = near ? 1.15 : .84;
        const cheek = this._stepHairSpring(sideName === 'left' ? 'cheekLeft' : 'cheekRight', driveX * depth, driveY * (near ? 1.05 : .9), dt, near ? 238 : 218, near ? 18.8 : 19.6);
        this._setHairMotion(
          this.q(`motion-hair-cheek-${sideName}`),
          cheek.x*.28*depth,
          cheek.y*.16,
          clamp(cheek.x*.72*depth, -3.2, 3.2),
          1+close*(near?.009:-.004)
        );
        this._setHairMotion(
          this.q(`motion-hair-side-${sideName}`),
          side.x*.3*depth,
          side.y*.18,
          clamp(side.x*.72*depth, -3.4, 3.4)
        );
      });

      ['left','right'].forEach(sideName => {
        const near = (direction > 0 && sideName === 'right') || (direction < 0 && sideName === 'left');
        const depth = near ? 1.1 : .88;
        this._setHairMotion(
          this.q(`motion-hair-outer-${sideName}`),
          outer.x*.24*depth,
          outer.y*.14,
          clamp(outer.x*.68*depth, -2.8, 2.8)
        );
      });

      this.qa('[id^="motion-hair-fringe-"]').forEach((lock, index) => {
        const centerWeight = index === 1 || index === 2 ? 1 : .76;
        const faceCarryX = clamp(gazeX*.055*centerWeight, -2.2, 2.2);
        const faceCarryY = clamp(gazeY*.04, -1.2, 1.2);
        this._setHairMotion(
          lock,
          faceCarryX + fringe.x*.1*centerWeight,
          faceCarryY + fringe.y*.07,
          clamp(fringe.x*.28*centerWeight, -1.8, 1.8)
        );
      });
      ['motion-hair-tuft-top-left','motion-hair-crown-right','motion-hair-tuft-left','motion-hair-tuft-right']
        .forEach((id,index) => {
          const sign = index % 2 ? 1 : -1;
          this._setHairMotion(
            this.q(id),
            tuft.x*.12,
            tuft.y*.07,
            clamp(tuft.x*.4 + sign*strength*.12, -2.4, 2.4)
          );
        });
    }

    _renderFacing(dt) {
      const follow = clamp(dt * 6.5, 0, 1);
      this.facingOffset += (this.facingTarget - this.facingOffset) * follow;
      const turn = this.facingOffset;
      const narrow = 1 - Math.abs(turn) * .009;
      ['torso-root','lower-body-root','outfits-root'].forEach(id => {
        const el = this.q(id);
        if (el) el.style.transform = `translateX(${turn * 1.25}px) skewX(${turn * .7}deg) scale(${narrow},1)`;
      });
      const hands = this.q('hands-root');
      if (hands) hands.style.transform = `translateX(${turn * 1.5}px)`;
      const guitar = this.q('desktop-guitar');
      if (guitar) guitar.style.transform = `translateX(${turn * 1.25}px) skewX(${turn * .35}deg)`;
      this._appendTransform(this.q('motion-head-root'), `translateX(${turn * 1.4}px) rotate(${turn * .18}deg)`);
    }

    _renderExpressiveTail(now) {
      const tail = this.q('tail-root');
      const straight = this.q('desktop-tail-straight');
      const base = this.q('motion-tail-base');
      const mid = this.q('motion-tail-mid');
      const tip = this.q('motion-tail-tip');
      if (!tail) return;

      const sleepLie = this._sleepLieAmount(now);
      if (sleepLie > 0) {
        this._display(tail, true);
        this._display(straight, false);
        const asleep = this.state === 'sleep' && !this.sleepSequence;
        const micro = asleep ? Math.sin(now / 1000 * 1.12) * .75 : 0;
        // The outer sleep-tail-root follows the pelvis onto the ground.  This
        // inner counter-rotation keeps the fluffy chain stretched along the
        // floor instead of pointing upward with the side-lying body.
        this._appendTransform(tail, `rotate(${86 * sleepLie + micro}deg)`);
        this._appendTransform(base, `rotate(${-4 * sleepLie}deg) scale(${1 + .012 * sleepLie},${1 - .018 * sleepLie})`);
        this._appendTransform(mid, `rotate(${6 * sleepLie + micro * .35}deg) scale(${1 + .018 * sleepLie},${1 - .026 * sleepLie})`);
        this._appendTransform(tip, `rotate(${14 * sleepLie + micro}deg) scale(${1 + .025 * sleepLie},${1 - .034 * sleepLie})`);
        return;
      }

      let active = this.tailAction;
      let t = 0;
      if (active) {
        t = clamp((now - active.start) / active.duration, 0, 1);
        if (t >= 1) {
          if (active.type === 'sweep') {
            this.tailAction = {type:'settle', start:now, duration:540};
            active = this.tailAction;
            t = 0;
          } else {
            if (active.type === 'startle') this._restoreTailMorph();
            this.tailAction = null;
            active = null;
          }
        }
      }

      if (active && active.type === 'startle') {
        this._display(tail, true);
        this._display(straight, false);
        const shoot = offset => easeOutCubic(clamp((t - (.055 + offset)) / .15, 0, 1));
        let amounts = [shoot(0), shoot(.018), shoot(.038)];
        let releaseWave = 0;
        if (t > .36) {
          const release = (t - .36) / .64;
          amounts = [0,.09,.18].map(delay => {
            const u = clamp((release - delay) / (1 - delay), 0, 1);
            return clamp(Math.pow(1 - u, 2.35) * (1 + Math.sin(u * Math.PI * 5) * .16 * (1 - u)), 0, 1);
          });
          releaseWave = Math.sin(release * Math.PI * 5) * Math.pow(1 - release, 1.8);
        }
        this._applyTailMorph(amounts, releaseWave);
        const prep = t < .055 ? Math.sin(t / .055 * Math.PI) : 0;
        this._appendTransform(tail, `rotate(${prep * 9}deg) scale(${1 - prep * .08},${1 + prep * .12})`);
        const shock = Math.sin(Math.min(1, t / .34) * Math.PI) * (1 - t * .45);
        this._appendTransform(this.q('character-motion-root'), `translateY(${-22 * shock}px) scale(${1 + .15 * shock},${1 - .12 * shock})`);
        this._appendTransform(this.q('motion-head-root'), `translateY(${-15 * shock}px) rotate(${Math.sin(t * Math.PI * 6) * 4 * (1 - t)}deg)`);
        this._legTransform('left', 24 * shock, -18 * shock);
        this._legTransform('right', -24 * shock, -18 * shock);
        this._appendTransform(this.q('motion-hand-left'), `translate(-${28 * shock}px,${-14 * shock}px)`);
        this._appendTransform(this.q('motion-hand-right'), `translate(${28 * shock}px,${-14 * shock}px)`);
        return;
      }

      this._display(tail, true);
      this._display(straight, false);
      let whole = 0, baseLag = 0, midLag = 0, tipLag = 0;
      const s = now / 1000;

      if (active && active.type === 'sweep') {
        const phase = t * Math.PI * 2;
        const settle = Math.sin(Math.PI * t);
        const snap = Math.sin(phase * 2) * 10 * settle;
        whole = (-62.5 + Math.cos(phase) * 72.5 + snap) * this.tailDrama;
        baseLag = (Math.sin(phase - .24) * 15 + Math.sin(phase * 2 - .38) * 5) * settle;
        midLag = (Math.sin(phase - .62) * 29 + Math.sin(phase * 2 - .88) * 9) * settle;
        tipLag = (Math.sin(phase - 1.08) * 47 + Math.sin(phase * 2 - 1.46) * 15 + Math.sin(phase * 3 - 1.8) * 5) * settle;
      } else if (active && active.type === 'settle') {
        const decay = Math.pow(1 - t, 1.7);
        const phase = t * Math.PI * 5;
        whole = 10 + Math.sin(phase) * 18 * decay;
        baseLag = Math.sin(phase - .28) * 7 * decay;
        midLag = Math.sin(phase - .72) * 15 * decay;
        tipLag = (Math.sin(phase - 1.18) * 27 + Math.sin(phase * 2 - 1.5) * 5) * decay;
      } else if (active && active.type === 'pat') {
        const elapsed = Math.max(0, now - active.start);
        const pleasantMs = Number(active.pleasantMs) || active.duration - 460;
        const ramp = smoothstep(clamp(elapsed / 360, 0, 1));
        const release = 1 - smoothstep(clamp((elapsed - pleasantMs) / 460, 0, 1));
        const envelope = ramp * release;
        const phase = elapsed / 1000 * Math.PI * 3.6;
        whole = (-20 + Math.sin(phase) * 36) * envelope;
        baseLag = Math.sin(phase - .25) * 9 * envelope;
        midLag = Math.sin(phase - .7) * 19 * envelope;
        tipLag = (Math.sin(phase - 1.18) * 31 + Math.sin(phase * 2 - 1.5) * 6) * envelope;
      } else if (this._isActuallyHeld()) {
        whole = -16 + Math.sin(s * 10.5) * 13;
        baseLag = Math.sin(s * 11.2) * 5;
        midLag = Math.sin(s * 11.2 - .5) * 7;
        tipLag = Math.sin(s * 11.2 - .9) * 10;
      } else if (this.mood === 'excited') {
        whole = (-62.5 + Math.sin(s * 2.8) * 72.5) * this.tailDrama;
        baseLag = Math.sin(s * 2.8 - .22) * 14;
        midLag = Math.sin(s * 2.8 - .62) * 28 + Math.sin(s * 5.6 - .82) * 6;
        tipLag = Math.sin(s * 2.8 - 1.12) * 45 + Math.sin(s * 5.6 - 1.38) * 12 + Math.sin(s * 8.4 - 1.7) * 3;
      } else if (this.mood === 'happy') {
        whole = (-45 + Math.sin(s * 2.05) * 56) * this.tailDrama;
        baseLag = Math.sin(s * 2.05 - .22) * 9;
        midLag = Math.sin(s * 2.05 - .58) * 17;
        tipLag = Math.sin(s * 2.05 - 1.02) * 28 + Math.sin(s * 4.1 - 1.2) * 4;
      } else if (this.mood === 'annoyed') {
        whole = -12 + Math.sin(s * 7.2) * 23;
        baseLag = Math.sin(s * 7.2 - .18) * 7;
        midLag = Math.sin(s * 7.2 - .42) * 15;
        tipLag = Math.sin(s * 7.2 - .8) * 25;
      } else if (this.mood === 'anxious') {
        whole = -24 + Math.sin(s * 4.7) * 17;
        baseLag = Math.sin(s * 4.7 - .25) * 5;
        midLag = Math.sin(s * 4.7 - .52) * 8;
        tipLag = Math.sin(s * 4.7 - .84) * 12;
      } else if (this.mood === 'bored') {
        whole = -24 + Math.sin(s * .72) * 11;
        tipLag = Math.sin(s * .72 - .8) * 5;
      } else {
        whole = -3 + Math.sin(s * 1.18) * 10;
        midLag = Math.sin(s * 1.18 - .45) * 3;
        tipLag = Math.sin(s * 1.18 - .85) * 5;
      }

      const baseFlex = clamp(Math.abs(baseLag) / 400, 0, .05);
      const midFlex = clamp(Math.abs(midLag) / 320, 0, .09);
      const tipFlex = clamp(Math.abs(tipLag) / 250, 0, .16);
      this._appendTransform(tail, `rotate(${whole}deg)`);
      this._appendTransform(base, `rotate(${baseLag}deg) scale(${1 + baseFlex},${1 - baseFlex * .5})`);
      this._appendTransform(mid, `rotate(${midLag}deg) scale(${1 + midFlex},${1 - midFlex * .5})`);
      this._appendTransform(tip, `rotate(${tipLag}deg) scale(${1 + tipFlex},${1 - tipFlex * .45})`);
    }

    _renderHeadPatReaction(reaction, now) {
      const elapsed = Math.max(0, now - reaction.start);
      if (!reaction.autoSustain && !reaction.realizing && now < reaction.realizationAt) {
        const contactEndedAt = reaction.releasedAt || reaction.lastContactAt;
        if (now - contactEndedAt > HEAD_PAT_CONTACT_GRACE_MS && reaction.cancelAt == null) reaction.cancelAt = now;
      }
      if (reaction.cancelAt != null) {
        const fade = smoothstep(clamp((now - reaction.cancelAt) / 380, 0, 1));
        const remaining = 1 - fade;
        const rub = Math.sin(elapsed / 1000 * 9.4 + reaction.strokePhase) * remaining;
        this._appendTransform(this.q('motion-head-root'), `translateY(${remaining*6}px) rotate(${rub*3.4}deg) scale(${1+remaining*.022},${1-remaining*.03})`);
        this._appendTransform(this.q('motion-hand-left'), `translate(8px,${remaining*-6}px)`);
        this._appendTransform(this.q('motion-hand-right'), `translate(-8px,${remaining*-6}px)`);
        if (this.viseme === 'idle' && remaining > .06) {
          this._hideAllMouths();
          this._display(this.q('g-mouth-smile'), true);
          this._reactionFaceActive = true;
        }
        if (fade >= 1) {
          this.partReaction = null;
          this.headPatSession = null;
          if (this.tailAction && this.tailAction.type === 'pat') this.tailAction = null;
          if (this._reactionFaceActive) this._applyFace();
          this._reactionFaceActive = false;
        }
        return;
      }

      const joyIn = smoothstep(clamp(elapsed / 520, 0, 1));
      const realization = smoothstep(clamp((now - reaction.realizationAt) / HEAD_PAT_REALIZE_MS, 0, 1));
      if (realization > 0) reaction.realizing = true;
      const flee = smoothstep(clamp((now - reaction.retreatAt) / HEAD_PAT_RETREAT_MS, 0, 1));
      const pleasure = joyIn * (1 - realization);
      const rub = Math.sin(elapsed / 1000 * 9.4 + reaction.strokePhase) * (1 - flee) * (.35 + pleasure*.65);
      const nestle = .62 + Math.sin(elapsed / 1000 * 2.15) * .18;
      this._appendTransform(this.q('motion-head-root'), `translateY(${pleasure*(5+nestle*4)}px) rotate(${rub*4.8 + realization*2.4}deg) scale(${1+pleasure*.035},${1-pleasure*.045})`);
      this._appendTransform(this.q('motion-hand-left'), `translate(10px,${pleasure*-8}px)`);
      this._appendTransform(this.q('motion-hand-right'), `translate(-10px,${pleasure*-8}px)`);
      this._appendTransform(this.q('motion-brow-left'), `translateY(${pleasure*-4 + realization*3}px) rotate(${realization*7 - pleasure*3}deg)`);
      this._appendTransform(this.q('motion-brow-right'), `translateY(${pleasure*-4 + realization*3}px) rotate(${pleasure*3 - realization*7}deg)`);

      if (flee > 0) {
        const stepWave = Math.sin(flee * Math.PI * 4);
        const lift = Math.abs(Math.sin(flee * Math.PI * 2)) * -12 * (1 - flee*.35);
        const retreatX = reaction.retreatDx * flee;
        this.direction = reaction.retreatDx < 0 ? -1 : 1;
        this.facingTarget = this.direction;
        this._appendTransform(this.q('character-motion-root'), `translate(${retreatX}px,${lift}px) rotate(${this.direction*stepWave*2.8}deg)`);
        this._legTransform('left', stepWave*20, Math.max(0,stepWave)*-10);
        this._legTransform('right', -stepWave*20, Math.max(0,-stepWave)*-10);
      }

      if (this.viseme === 'idle') {
        this._hideAllMouths();
        this._display(this.q(realization < .72 ? 'g-mouth-smile' : 'g-mouth-pout'), true);
        this._reactionFaceActive = true;
      }

      if (now >= reaction.endAt) {
        // Keep the final local offset for this frame, then commit exactly the
        // same bounded distance to the desktop root for the next frame.
        this.desktopX = reaction.targetDesktopX;
        reaction.positionCommitted = true;
        this.partReaction = null;
        this.headPatSession = null;
        if (this._reactionFaceActive) this._applyFace();
        this._reactionFaceActive = false;
        this._emit('desktop-action', `head-pat-retreated:${reaction.targetDesktopX}`);
      }
    }

    _renderPartReaction(now) {
      const reaction = this.partReaction;
      if (!reaction) return;
      const type = reaction.type;
      if (type === 'head-pat') {
        this._renderHeadPatReaction(reaction, now);
        return;
      }
      const t = clamp((now - reaction.start) / reaction.duration, 0, 1);
      if (t >= 1) {
        this.partReaction = null;
        if (this._reactionFaceActive) this._applyFace();
        this._reactionFaceActive = false;
        return;
      }
      const wave = Math.sin(t * Math.PI);
      const settle = Math.sin(t * Math.PI * 4) * (1 - t);

      if (type === 'hover-curious' || type === 'hold-curious') {
        const tilt = Math.sin(t*Math.PI) * (type === 'hold-curious' ? 7 : 4.5);
        this._appendTransform(this.q('motion-head-root'), `translateY(${wave*4}px) rotate(${tilt}deg)`);
        this._appendTransform(this.q('motion-brow-left'), `translateY(${-wave*3}px)`);
        this._appendTransform(this.q('motion-brow-right'), `translateY(${wave*2}px)`);
      } else if (type === 'hover-nuzzle') {
        const lean = Math.sin(t*Math.PI);
        this._appendTransform(this.q('motion-head-root'), `translate(${lean*24}px,${lean*5}px) rotate(${lean*6}deg) scale(${1+lean*.025},${1-lean*.018})`);
        this._appendTransform(this.q('character-motion-root'), `translateX(${lean*9}px)`);
      } else if (type === 'torso-poke') {
        const recoil = Math.sin(t * Math.PI * 5) * (1 - t);
        this._appendTransform(this.q('character-motion-root'), `translateX(${recoil * 18}px) rotate(${recoil * 2.5}deg) scale(${1 + wave * .08},${1 - wave * .07})`);
        this._appendTransform(this.q('motion-head-root'), `translateX(${-recoil * 8}px) rotate(${-recoil * 2}deg)`);
        this._appendTransform(this.q('motion-hand-left'), `translate(-${wave * 18}px,${wave * -7}px)`);
        this._appendTransform(this.q('motion-hand-right'), `translate(${wave * 18}px,${wave * -7}px)`);
        if (this.viseme === 'idle') {
          this._hideAllMouths();
          this._display(this.q('g-mouth-pout'), true);
          this._reactionFaceActive = true;
        }
      } else if (type === 'hand-left-poke' || type === 'hand-right-poke') {
        const isLeft = type.startsWith('hand-left');
        const hand = this.q(isLeft ? 'motion-hand-left' : 'motion-hand-right');
        this._appendTransform(hand, `translate(${(isLeft ? -1 : 1) * wave * 38}px,${wave * -24}px) scale(${1 + wave * .18},${1 - wave * .12})`);
        this._appendTransform(this.q('motion-head-root'), `rotate(${(isLeft ? -1 : 1) * settle * 3.2}deg)`);
      } else if (type === 'foot-left-poke' || type === 'foot-right-poke') {
        const isLeft = type.startsWith('foot-left');
        this._appendTransform(this.q('character-motion-root'), `translateY(${wave * -17}px) rotate(${(isLeft ? 1 : -1) * settle * 3}deg)`);
        this._legTransform(isLeft ? 'left' : 'right', (isLeft ? -1 : 1) * wave * 31, wave * -25);
        this._appendTransform(this.q('motion-head-root'), `translateY(${wave * 5}px)`);
      } else if (type === 'tail-poke') {
        this._appendTransform(this.q('motion-head-root'), `translateX(${wave * 8}px) rotate(${settle * 4}deg)`);
      }
    }

    _renderDesktop(now) {
      const dt = clamp((now - this._desktopLast) / 1000, 0, .05);
      this._desktopLast = now;
      let vertical = this.desktopY;
      let bodyScaleX = 1, bodyScaleY = 1;
      let walkPhase = 0;
      let jumpPhase = -1;

      if (this.walkMotion && !this._isActuallyHeld() && this.performanceMode !== 'guitar') {
        const remain = this.walkMotion.target - this.desktopX;
        const step = Math.sign(remain) * this.walkMotion.speed * dt;
        this.direction = remain < 0 ? -1 : 1;
        this.facingTarget = this.direction;
        if (Math.abs(step) >= Math.abs(remain)) {
          this.desktopX = this.walkMotion.target;
          this.walkMotion = null;
          this._emit('desktop-action', 'walk-arrived');
        } else this.desktopX += step;
        walkPhase = (now - (this.walkMotion ? this.walkMotion.startedAt : now)) / 1000 * 8.6;
      }

      if (this.treadmill && !this._isActuallyHeld() && this.performanceMode !== 'guitar' && !walkPhase) {
        walkPhase = (now - this.treadmill.startedAt) / 1000 * 8.6 * (this.walkRate || 1) || .001;
      }

      if (this.jumpMotion && !this._isActuallyHeld()) {
        const t = clamp((now - this.jumpMotion.start) / this.jumpMotion.duration, 0, 1);
        const anticipationEnd = .14;
        if (t < anticipationEnd) {
          const a = smoothstep(t / anticipationEnd);
          vertical = this.desktopY + 10 * a;
          bodyScaleX = 1 + .13 * a;
          bodyScaleY = 1 - .14 * a;
        } else {
          const u = clamp((t - anticipationEnd) / (1 - anticipationEnd), 0, 1);
          const arc = 4 * u * (1 - u);
          const takeoff = clamp(1 - u / .22, 0, 1);
          const apex = Math.sin(u * Math.PI);
          jumpPhase = u;
          vertical = this.desktopY - this.jumpMotion.height * arc;
          bodyScaleX = 1 - .1 * takeoff + .025 * apex;
          bodyScaleY = 1 + .17 * takeoff - .02 * apex;
        }
        if (t >= 1) { this.jumpMotion = null; this.desktopY = 0; this._startLanding(); }
      }

      if (this.hostLeap && !this._isActuallyHeld()) {
        // In the air on his own jump: stretched out, mid-jump limbs.
        const k = clamp((now - this.hostLeap.start) / 140, 0, 1);
        jumpPhase = .45;
        bodyScaleX = 1 - .07 * k;
        bodyScaleY = 1 + .12 * k;
      }

      if (this.landingMotion && !this._isActuallyHeld()) {
        const t = clamp((now - this.landingMotion.start) / this.landingMotion.duration, 0, 1);
        vertical = this.landingMotion.fromY * (1 - easeInQuad(t));
        const impact = Math.sin(t * Math.PI) * (1 - t);
        bodyScaleX = 1 + impact * .24;
        bodyScaleY = 1 - impact * .19;
        const dust = this.q('desktop-landing-dust');
        if (dust) {
          dust.style.opacity = String(1 - t);
          dust.style.transform = `scale(${.55 + t * .8},${.55 + t * .25})`;
        }
        if (t >= 1) {
          this.landingMotion = null;
          this.desktopY = 0;
          this._display(dust, false);
          this._emit('desktop-action', 'landed');
        }
      }

      const root = this.q('desktop-motion-root');
      if (root) root.style.transform = `translate(${this.desktopX}px,${vertical}px) scale(${this.desktopScale * bodyScaleX},${this.desktopScale * bodyScaleY})`;

      if (this.held && this.held.mode === 'pending' && now - this.held.startedAt >= HOLD_MIN_MS) this.held.mode = 'hold';
      if (this._isActuallyHeld()) {
        const s = now / 1000;
        // While the native window falls after release, held is already gone.
        const held = this.held || {startedAt:now, complained:true};
        const elapsed = now - held.startedAt;
        // After he's begged to be put down he stops struggling and just hangs there.
        const struggle = this.resigned ? .06 : 1;
        const kick = Math.sin(s * 17.5) * struggle;
        this._appendTransform(this.q('character-motion-root'), `rotate(${Math.sin(s * (this.resigned ? 1.4 : 6.2)) * 1.8}deg) scale(${1 + Math.abs(kick) * .025},${1 - Math.abs(kick) * .02})`);
        this._appendTransform(this.q('motion-head-root'), `translateY(${this.resigned ? 22 : 16}px) rotate(${Math.sin(s * (this.resigned ? 1.4 : 6.2)) * 4.2 * (this.resigned ? .5 : 1)}deg)`);
        this._legTransform('left', 31 * kick, -22 * Math.max(0, kick));
        this._legTransform('right', -31 * kick, -22 * Math.max(0, -kick));
        this._appendTransform(this.q('motion-hand-left'), `translate(-8px,${11 + kick * 8}px)`);
        this._appendTransform(this.q('motion-hand-right'), `translate(8px,${11 - kick * 8}px)`);
        if (this.viseme === 'idle') {
          this._hideAllMouths();
          this._display(this.q('g-mouth-pout'), true);
        }
        if (this.heldAngry && !this.worried) {
          // Properly angry at being kept up here: brows flipped like his >< face.
          this._appendTransform(this.q('motion-brow-left'), 'translateY(6px) rotate(10deg) scale(1,-1)');
          this._appendTransform(this.q('motion-brow-right'), 'translateY(6px) rotate(-10deg) scale(1,-1)');
        } else if (!this.worried) {
          // Cross at being picked up.
          this._appendTransform(this.q('motion-brow-left'), 'translateY(3px) rotate(7deg)');
          this._appendTransform(this.q('motion-brow-right'), 'translateY(3px) rotate(-7deg)');
        }
        this._display(this.q('desktop-angry-mark'), elapsed > 430 && !this.worried);
        if (elapsed > 720 && !held.complained) {
          held.complained = true;
          this.requestInteraction('drag-complaint');
        }
      } else if (jumpPhase >= 0) {
        const tuck = Math.sin(jumpPhase * Math.PI);
        const reach = clamp(1 - jumpPhase / .28, 0, 1);
        this._legTransform('left', -14 - tuck * 19, -8 - tuck * 15);
        this._legTransform('right', 14 + tuck * 19, -8 - tuck * 15);
        this._appendTransform(this.q('motion-hand-left'), `translate(-${12 + tuck * 14}px,${-10 - reach * 20}px)`);
        this._appendTransform(this.q('motion-hand-right'), `translate(${12 + tuck * 14}px,${-10 - reach * 20}px)`);
        this._appendTransform(this.q('motion-head-root'), `translateY(${reach * -10 + tuck * 5}px) rotate(${Math.sin(jumpPhase * Math.PI * 2) * 2.4}deg)`);
      } else if (walkPhase) {
        const stride = Math.sin(walkPhase);
        const contact = Math.abs(stride);
        this._legTransform('left', stride * 22, Math.max(0, stride) * -13);
        this._legTransform('right', -stride * 22, Math.max(0, -stride) * -13);
        this._appendTransform(this.q('character-motion-root'), `translateY(${contact * -11}px) rotate(${stride * 1.8}deg) scale(${1 + contact * .045},${1 - contact * .035})`);
        this._appendTransform(this.q('motion-head-root'), `translateY(${contact * 3}px) rotate(${-stride * 1.15}deg)`);
        this._appendTransform(this.q('motion-hand-left'), `translateY(${stride * 10}px)`);
        this._appendTransform(this.q('motion-hand-right'), `translateY(${-stride * 10}px)`);
      } else if (!this.jumpMotion && !this.landingMotion && this.performanceMode !== 'guitar') {
        this._legTransform('left', 0, 0);
        this._legTransform('right', 0, 0);
      }

      this._renderPerformance(now);
      this._renderExpressiveTail(now);
      this._renderFlowers(now);
      this._renderGloom(now);
      this._renderPartReaction(now);
      this._renderFacing(dt);
      this._renderAttention(dt);
      this._renderSleepSequence(now);
      this._renderSeat(now);
      this._renderScarf(now);
      this._renderGlasses();
    }

    setGlasses(mode='auto') {
      this.glassesMode = ['auto','on','off'].includes(mode) ? mode : 'auto';
      this._glassesShown = null;
      this._emit('glasses', this.glassesMode);
      return this.glassesMode;
    }

    _renderGlasses() {
      // The glasses sit on his eyes: when his gaze shifts the eyes (looking at the
      // mouse, at the fairies), the frames go with them.
      const glasses = this.q('glasses');
      if (glasses) {
        // The eyes carry a base translate plus the gaze shift appended after it: add them up.
        const at = id => {
          const text = (this.q(id) && this.q(id).style.transform) || '';
          let x = 0, y = 0;
          for (const m of text.matchAll(/translate\(\s*([-\d.]+)px\s*,\s*([-\d.]+)px\s*\)/g)) { x += Number(m[1]); y += Number(m[2]); }
          return [x, y];
        };
        const [lx, ly] = at('motion-eye-left'), [rx, ry] = at('motion-eye-right');
        const gx = (lx + rx) / 2, gy = (ly + ry) / 2;
        glasses.style.transform = Math.abs(gx) + Math.abs(gy) > .01 ? `translate(${gx.toFixed(2)}px,${gy.toFixed(2)}px)` : '';
      }
      // Follow where he is heading: on as he picks up the book, off as he lies down.
      const heading = this.transition && this.transition.next ? this.transition.next : this.state;
      const asleep = heading === 'sleep' || this.state === 'sleep' || !!this.sleepSequence;
      const occasion = heading === 'reading' ? 'reading'
        : ['outdoors','visitor'].includes(heading) ? 'out' : null;
      if (occasion !== this._glassesOccasion) {
        this._glassesOccasion = occasion;
        this._glassesOccasionWears = !!occasion && Math.random() < (this.glassesChance[occasion] || 0);
      }
      const wanted = this.glassesMode === 'on' ? true
        : this.glassesMode === 'off' ? false
        : this._glassesOccasionWears;
      const show = wanted && !asleep;
      if (show !== this._glassesShown) {
        this._glassesShown = show;
        this._display(this.q('glasses'), show);
      }
    }

    _renderScarf(now) {
      const end = this.q('coat-scarf-end');
      if (!end || this.outfit !== 'coat') return;
      const s = now / 1000;
      let angle;
      if (this._isActuallyHeld()) {
        // Dangling or falling: the loose end flaps.
        angle = Math.sin(s * 9.5) * 11 + Math.sin(s * 15.3) * 3 - 4;
      } else if (this.walkMotion || this.treadmill) {
        angle = Math.sin(s * 8.6) * 5 - this.direction * 3;
      } else if (this.jumpMotion || this.landingMotion) {
        angle = Math.sin(s * 12) * 7;
      } else {
        angle = Math.sin(s * 1.3) * 1.4 + Math.sin(s * .53) * .8;
      }
      end.style.transform = `rotate(${angle.toFixed(2)}deg)`;
    }

    _setSeatClip(on, k=1) {
      const holder = this.q('sleep-tail-root');
      if (!holder || !holder.setAttribute) return;
      if (!on) {
        if (this._seatClipOn) { holder.removeAttribute('clip-path'); this._seatClipOn = false; }
        return;
      }
      // The clip edge slides down from well above him to the ledge as he sits,
      // so the tail tucks in (and comes back out) gradually instead of popping.
      // Keep what is above the ledge; the edge slides up from far below as he
      // sits, so the tail tucks away (and comes back) without popping.
      const place = rect => {
        rect.setAttribute('y', '-4000');
        rect.setAttribute('height', (4000 + this._seatClipLine + (1 - k) * 700).toFixed(1));
      };
      if (this._seatClipRect) place(this._seatClipRect);
      if (this._seatClipOn) return;
      const doc = this.svg.ownerDocument;
      let clip = doc && doc.getElementById('arthur-seat-clip');
      if (!clip && doc) {
        const ns = 'http://www.w3.org/2000/svg';
        const shadow = this.q('desktop-ground-shadow');
        let line = 623;
        try { const b = shadow.getBBox(); if (b && b.height) line = b.y + b.height / 2; } catch (_error) {}
        clip = doc.createElementNS(ns, 'clipPath');
        clip.setAttribute('id', 'arthur-seat-clip');
        clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
        const rect = doc.createElementNS(ns, 'rect');
        rect.setAttribute('x', '-4000');
        this._seatClipLine = line - this.seatPose.tailTuck;
        rect.setAttribute('width', '8000');
        place(rect);
        clip.appendChild(rect);
        let defs = this.svg.querySelector('defs');
        if (!defs) { defs = doc.createElementNS(ns, 'defs'); this.svg.insertBefore(defs, this.svg.firstChild); }
        defs.appendChild(clip);
        this._seatClipRect = rect;
      }
      holder.setAttribute('clip-path', 'url(#arthur-seat-clip)');
      this._seatClipOn = true;
    }

    _renderSeat(now) {
      const dt = clamp((now - (this._seatLast || now)) / 1000, 0, .05);
      this._seatLast = now;
      if (this.seatTarget > 0 && this.state === 'sleep') this.seatTarget = 0;
      const speed = 1 / .55;   // about half a second to sit down or get up
      this.seat = this.seat < this.seatTarget
        ? Math.min(this.seatTarget, this.seat + dt * speed)
        : Math.max(this.seatTarget, this.seat - dt * speed);
      const shadow = this.q('desktop-ground-shadow');
      if (shadow) shadow.style.opacity = this.seat > 0 ? String(1 - smoothstep(this.seat)) : (this._groundFade != null ? String(this._groundFade) : '');
      if (this.seat <= 0) { this._seatLast = now; this._setSeatClip(false); return; }
      const k = smoothstep(this.seat);
      const pose = this.seatPose;
      // A little hop up and over the edge at the midpoint, then settle down.
      const hop = Math.sin(k * Math.PI) * 18;
      const drop = pose.drop * k - hop;
      const lift = `translateY(${drop.toFixed(2)}px)`;
      const body = this.q('character-motion-root');
      if (body) body.style.transform = `${lift} ${body.style.transform || ''}`.trim();
      const tail = this.q('tail-root');
      if (tail) tail.style.transform = `${lift} ${tail.style.transform || ''} rotate(${(pose.tailDroop * k).toFixed(2)}deg)`.trim();
      // Whatever he sits on (window edge, screen edge) is in front of him:
      // the tail drops behind it, leaving only its root showing by his seat.
      this._setSeatClip(true, k);
      // Legs hang over the edge (foreshortened thighs) and swing out of step.
      const t = now / 1000;
      const swingL = Math.sin(t * 2.3) * pose.swing * k;
      const swingR = Math.sin(t * 2.3 + 1.9) * pose.swing * k;
      const squash = 1 - (1 - pose.legScale) * k;
      [['left', swingL], ['right', swingR]].forEach(([side, angle]) => {
        ((this._legEls || {})[side] || []).forEach(el => {
          el.style.transform = `${el.style.transform || ''} rotate(${angle.toFixed(2)}deg) scale(1,${squash.toFixed(3)})`.trim();
        });
      });
      // Hands come down to rest on the ledge beside him.
      this._appendTransform(this.q('motion-hand-left'), `translate(${(-pose.handX * k).toFixed(2)}px,${(pose.handY * k).toFixed(2)}px)`);
      this._appendTransform(this.q('motion-hand-right'), `translate(${(pose.handX * k).toFixed(2)}px,${(pose.handY * k).toFixed(2)}px)`);
    }

    _sleepLieAmount(now) {
      const sleeping = this.state === 'sleep';
      const sequence = this.sleepSequence;
      let lie = sleeping ? 1 : 0;
      if (!sleeping && this._knockedOut(now)) {
        // Knocked flat: down fast, stay down, get up slowly.
        const k = this.knockout;
        if (now < k.start + 260) return smoothstep((now - k.start) / 260);
        if (now < k.holdUntil) return 1;
        return 1 - smoothstep((now - k.holdUntil) / k.getUpMs);
      }
      if (sequence) {
        const t = clamp((now-sequence.start)/sequence.duration,0,1);
        lie = sequence.phase === 'lie-down' ? smoothstep(t) : 1-smoothstep(t);
      }
      return clamp(lie, 0, 1);
    }

    // Lying down, the little round shadow under his feet ends up under his
    // head only and he looks to float: a long shadow goes under all of him.
    // (The original one stays put, just faded: the app reads his feet from it.)
    _sleepShadow(lie) {
      const ground = this.q('desktop-ground-shadow');
      if (!ground || !ground.parentNode || !this.svg.ownerDocument) return;
      let el = this.q('fx-sleep-shadow');
      if (!el) {
        el = this.svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
        el.setAttribute('id', 'fx-sleep-shadow');
        el.setAttribute('fill', '#2a261f');
        el.setAttribute('pointer-events', 'none');
        ground.parentNode.insertBefore(el, ground.nextSibling);
      }
      if (lie <= .02) { el.setAttribute('display', 'none'); this._groundFade = null; ground.style.opacity = ''; this._sleepShadowAt = null; this._sleepPillow(0); return; }
      if (lie >= .98 && !this._sleepShadowAt) {
        // Measure once he's down: from the far side of his head to the end of him.
        const parts = ['g-head-back','torso-root','prop-blanket-alfred','prop-blanket-francis','g-tail-tip','g-tail-mid']
          .map(id => this.q(id)).filter(e => e && e.getAttribute('display') !== 'none')
          .map(e => e.getBoundingClientRect()).filter(r => r.width > 4);
        const torso = this.q('torso-root') && this.q('torso-root').getBoundingClientRect();
        const ctm = ground.parentNode.getScreenCTM && ground.parentNode.getScreenCTM();
        if (parts.length && torso && ctm) {
          const inv = ctm.inverse();
          const left = Math.min(...parts.map(r => r.left)) + 10, right = Math.max(...parts.map(r => r.right)) - 30;
          const tip = this.q('g-tail-tip') && this.q('g-tail-tip').getBoundingClientRect();
          const y = Math.max(torso.bottom, tip && tip.width ? tip.bottom - 10 : 0);
          const a = new DOMPoint(left, y).matrixTransform(inv), b = new DOMPoint(right, y).matrixTransform(inv);
          this._sleepShadowAt = {cx:(a.x + b.x) / 2, cy:a.y, rx:Math.abs(b.x - a.x) / 2, ry:34};
        }
      }
      const at = this._sleepShadowAt;
      if (at) {
        el.setAttribute('cx', at.cx.toFixed(1)); el.setAttribute('cy', at.cy.toFixed(1));
        el.setAttribute('rx', at.rx.toFixed(1)); el.setAttribute('ry', at.ry);
        el.setAttribute('opacity', (.2 * lie).toFixed(3));
        el.setAttribute('display', 'inline');
      }
      this._groundFade = 1 - lie;
      ground.style.opacity = String(this._groundFade);
      this._sleepPillow(lie);
    }

    // A little pillow under his head when he's lying down, between it and the floor.
    _sleepPillow(lie) {
      const ground = this.q('desktop-ground-shadow');
      if (!ground || !ground.parentNode || !this.svg.ownerDocument) return;
      let el = this.q('fx-pillow');
      if (!el) {
        el = this.svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
        el.setAttribute('id', 'fx-pillow');
        el.setAttribute('pointer-events', 'none');
        el.innerHTML = '<path d="M-1 -.35 C-1 -.95 -.55 -1 0 -1 C.55 -1 1 -.95 1 -.35 L1 .35 C1 .95 .55 1 0 1 C-.55 1 -1 .95 -1 .35Z" fill="#f6efe2" stroke="#b9a98d" stroke-width="5" vector-effect="non-scaling-stroke"/>'
          + '<path d="M-.82 -.62 C-.3 -.78 .3 -.78 .82 -.62" fill="none" stroke="#7d9a6a" stroke-width="4" vector-effect="non-scaling-stroke" stroke-linecap="round"/>'
          + '<path d="M-.8 .3 C-.4 .12 .1 .5 .6 .2" fill="none" stroke="#e5d8c1" stroke-width="5" vector-effect="non-scaling-stroke" stroke-linecap="round"/>';
        ground.parentNode.insertBefore(el, ground.nextSibling);   // behind him, in front of the floor
      }
      const at = this._sleepShadowAt;
      if (lie <= .02 || !at) { el.setAttribute('display', 'none'); this._pillowAt = null; return; }
      if (!this._pillowAt) {
        const head = this.q('g-head-back') && this.q('g-head-back').getBoundingClientRect();
        const ctm = ground.parentNode.getScreenCTM && ground.parentNode.getScreenCTM();
        if (!head || !head.width || !ctm) return;
        const inv = ctm.inverse();
        const c = new DOMPoint(head.left + head.width * .55, head.bottom - head.height * .3).matrixTransform(inv);
        const w = Math.abs(new DOMPoint(head.right, 0).matrixTransform(inv).x - new DOMPoint(head.left, 0).matrixTransform(inv).x);
        const top = c.y, bottom = at.cy - 6;
        if (bottom - top < 20) return;
        this._pillowAt = {cx:c.x, cy:(top + bottom) / 2, rx:w * .3, ry:(bottom - top) / 2};
      }
      const p = this._pillowAt;
      el.setAttribute('transform', `translate(${p.cx.toFixed(1)} ${p.cy.toFixed(1)}) scale(${p.rx.toFixed(1)} ${p.ry.toFixed(1)})`);
      el.setAttribute('opacity', smoothstep(clamp((lie - .5) / .5, 0, 1)).toFixed(2));
      el.setAttribute('display', 'inline');
    }

    _renderSleepSequence(now) {
      const sleeping = this.state === 'sleep';
      const sequence = this.sleepSequence;
      const lie = this._sleepLieAmount(now);
      const sleepTailRoot = this.q('sleep-tail-root');
      if (lie <= 0) {
        if (this._sleepShadowAt !== undefined || this.q('fx-sleep-shadow')) this._sleepShadow(0);
        if (sleepTailRoot) sleepTailRoot.style.transform = '';
        if (sequence) {
          const t = clamp((now-sequence.start)/sequence.duration,0,1);
          if (t >= 1) this.sleepSequence = null;
        }
        return;
      }
      const settle = Math.sin(lie*Math.PI) * (1-lie) * 8;
      const pose = this.sleepPose;
      // Same scale both ways: squashing it flattened his head into an oval.
      const sidePose = `translate(${pose.x*lie}px,${pose.y*lie}px) rotate(${pose.rotate*lie + settle}deg) scale(${1+(pose.scale-1)*lie})`;
      this._appendTransform(this.q('character-motion-root'), sidePose);
      if (sleepTailRoot) sleepTailRoot.style.transform = sidePose;
      // The tail drops from his hip and lies along the floor, not stuck out in the air.
      this._appendTransform(this.q('tail-root'), `rotate(${(30 * lie).toFixed(1)}deg)`);
      this._bendTail(-15 * lie, -20 * lie);
      this._sleepShadow(lie);
      this._appendTransform(this.q('motion-head-root'), `translate(${40*lie}px,${26*lie}px) rotate(${22*lie}deg)`);
      this._appendTransform(this.q('motion-hand-left'), `translate(${182*lie}px,${74*lie}px) scale(${1-.16*lie},${1-.16*lie})`);
      this._appendTransform(this.q('motion-hand-right'), `translate(${-66*lie}px,${138*lie}px) scale(${1+.05*lie},${1-.1*lie})`);
      this._legTransform('left', -28*lie, 22*lie);
      this._legTransform('right', 24*lie, 8*lie);
      if (sleeping && !sequence) {
        const breathe=(Math.sin(now/1000*1.45)+1)/2;
        this._appendTransform(this.q('character-motion-root'), `scale(${1+breathe*.008},${1+breathe*.022})`);
        this._appendTransform(sleepTailRoot, `scale(${1+breathe*.003},${1+breathe*.007})`);
      }
      if (sequence) {
        const t = clamp((now-sequence.start)/sequence.duration,0,1);
        if (t >= 1) this.sleepSequence = null;
      }
    }

    _render(now) {
      // A little desktop pet doesn't need every display refresh: every other 60 Hz frame,
      // 30 a second (animation runs at 24), and WebKit repaints far less often. Moving
      // his window about is the shell's job and stays smooth regardless.
      // Slow, long antics (a nodding doze) look smooth at 15.
      if (now - (this._lastRenderAt || 0) < (this.frameReason === 'lull' ? 62 : 30)) return;
      this._lastRenderAt = now;
      super._render(now);
      this._renderDesktop(now);
      this._renderAntic(now);
      this._renderKnock(now);
      this._renderActs(now);
      this._renderBunny(now);
      const wasSpell = !!this.spell;
      this._renderSpell(now);
      if (wasSpell && !this.spell) {
        this._display(this.q('expression-closed-eyes'), false);
        this._display(this.q('motion-eye-left'), true);
        this._display(this.q('motion-eye-right'), true);
        if (typeof this._applyFace === 'function') this._applyFace();
      }
      // Dizzy or knocked flat: the spiral / X eyes are his only eyes. Whatever
      // else drew eyes this frame (a hard landing's shut eyes, a squeeze, a blink)
      // stays hidden underneath them.
      const knocked = this._knockedOut(now) && now < this.knockout.holdUntil;
      // A class with !important rules (companion.css), not attributes: mid-air renderers
      // set inline display on his own eyes, which beat the attribute and left them open.
      if (this.svg && this.svg.classList) this.svg.classList.toggle('eyes-knocked', !!(knocked || this._dizzy(now)));
      if (knocked || this._dizzy(now)) {
        const fx = this.q(knocked ? 'fx-eyes-x' : 'fx-eyes-swirl');
        if (fx) fx.setAttribute('display', 'inline');
      }
    }

    getDesktopSnapshot() {
      const base = super.getSnapshot();
      return Object.assign(base, {
        version:3,
        baseVersion:2,
        runtimeBuild:RUNTIME_BUILD,
        desktop:{
          x:this.desktopX,
          y:this.desktopY,
          direction:this.direction,
          scale:this.desktopScale,
          motion:this._isActuallyHeld() ? 'held' : this.partReaction ? this.partReaction.type : this.jumpMotion ? 'jumping' : this.landingMotion ? 'landing' : this.walkMotion ? 'walking' : this.performanceMode,
          performance:this.performanceMode,
          handTheme:this.handTheme,
          gesture:this.held ? this.held.mode : 'none',
          observedActivity:this.observedActivity,
          reaction:this.partReaction ? this.partReaction.type : 'none',
          autonomy:this.desktopAutonomy,
          proximityGaze:this.proximityGaze,
          gloom:this.gloomOverride == null ? 'auto' : this.gloomOverride
        }
      });
    }

    getSnapshot() { return this.getDesktopSnapshot(); }

    loadSnapshot(data) {
      if (!data || ![2,3].includes(data.version)) throw new Error('Not an Arthur Life/desktop snapshot');
      const base = Object.assign({}, data, {version:2});
      super.loadSnapshot(base);
      if (data.version === 3 && data.desktop) {
        this.desktopX = Number(data.desktop.x) || 0;
        this.desktopY = Number(data.desktop.y) || 0;
        this.direction = data.desktop.direction === -1 ? -1 : 1;
        this.facingTarget = this.direction;
        this.facingOffset = this.direction;
        this.desktopScale = Number(data.desktop.scale) || this.desktopScale;
        this.setProximityGaze(data.desktop.proximityGaze !== false);
        this.gloomOverride = data.desktop.gloom === 'auto' || data.desktop.gloom == null ? null : !!data.desktop.gloom;
        this.gloomUntil = this.gloomOverride === true ? nowMs() + 3800 : 0;
        this.setDesktopAutonomy(!!data.desktop.autonomy);
      }
      this._emit('desktop-snapshot', 'loaded');
    }

    destroy() {
      clearTimeout(this.desktopTimer);
      this.desktopTimers.forEach(clearTimeout);
      if (this._pointerHandlers && this.svg.removeEventListener) {
        this.svg.removeEventListener('pointerdown', this._pointerHandlers.down);
        this.svg.removeEventListener('pointermove', this._pointerHandlers.move);
        this.svg.removeEventListener('pointerup', this._pointerHandlers.up);
        this.svg.removeEventListener('pointercancel', this._pointerHandlers.up);
        this.svg.removeEventListener('pointerleave', this._pointerHandlers.leave);
      }
      super.destroy();
    }
  }

  ArthurDesktopRuntime.desktopActions = ['walk-left','walk-right','jump','guitar','sing','flowers','proximity-gaze','stop','autonomy'];
  ArthurDesktopRuntime.runtimeBuild = RUNTIME_BUILD;
  ArthurDesktopRuntime.bodyZones = ['head-top','face','torso','hand-left','hand-right','foot-left','foot-right','tail'];
  ArthurDesktopRuntime.interactionOptions = POKE_MENU_OPTIONS;
  ArthurDesktopRuntime.activityResources = ACTIVITY_RESOURCES;
  ArthurDesktopRuntime.activityResourceRules = ACTIVITY_RESOURCE_RULES;
  ArthurDesktopRuntime.handThemes = HAND_COLORS;
  global.ArthurDesktopRuntime = ArthurDesktopRuntime;
})(typeof window !== 'undefined' ? window : globalThis);
