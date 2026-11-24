(function (global) {
  'use strict';

  const PREVIEW_SCHEMA = 'arthur.companion-local-preview/1';
  const POLL_VISIBLE_MS = 5000;
  const POLL_HIDDEN_MS = 30000;
  const REQUEST_TIMEOUT_MS = 3500;
  const PREVIEW_ENUMS = Object.freeze({
    availability:['awake','sleeping','unknown'],
    place:['home','hotel','outdoors','transit','unknown'],
    pose:['awake','sleeping','waking','reading','tea','outdoors','unknown'],
    activity:['reading','tea','guitar','sleeping','outdoors','learned_activity','unknown'],
    type:['home','hotel','outdoors','transit','exercise','bathing','sleep','unknown'],
    hands:['none','left','right','both','unknown'],
    mobility:['stationary','mobile','unknown'],
    health:['healthy','degraded','unknown']
  });

  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
  const inEnum = (value, values) => values.includes(value);

  function validatePreview(value, nowMs=Date.now()) {
    if (!exact(value, ['schema_version','observed_at','host','mode','writers','arthur','maintenance','can_drive_visual','can_propose'])) return null;
    if (value.schema_version !== PREVIEW_SCHEMA || value.host !== 'mac' || value.mode !== 'legacy-generation-zero') return null;
    if (value.can_drive_visual !== true || value.can_propose !== false) return null;
    if (!exact(value.writers, ['state']) || value.writers.state !== 'ACTIVE') return null;
    if (!exact(value.arthur, ['availability','place','pose','activity'])) return null;
    if (!exact(value.arthur.activity, ['key','type','resources'])) return null;
    if (!exact(value.arthur.activity.resources, ['hands','mobility','body_locked'])) return null;
    if (!exact(value.maintenance, ['health'])) return null;
    const resources = value.arthur.activity.resources;
    if (!(typeof resources.body_locked === 'boolean' || resources.body_locked === null)) return null;
    if (!inEnum(value.arthur.availability, PREVIEW_ENUMS.availability) ||
        !inEnum(value.arthur.place, PREVIEW_ENUMS.place) ||
        !inEnum(value.arthur.pose, PREVIEW_ENUMS.pose) ||
        !inEnum(value.arthur.activity.key, PREVIEW_ENUMS.activity) ||
        !inEnum(value.arthur.activity.type, PREVIEW_ENUMS.type) ||
        !inEnum(resources.hands, PREVIEW_ENUMS.hands) ||
        !inEnum(resources.mobility, PREVIEW_ENUMS.mobility) ||
        !inEnum(value.maintenance.health, PREVIEW_ENUMS.health)) return null;
    const observed = Date.parse(value.observed_at);
    if (!Number.isFinite(observed) || observed - nowMs > 5000 || nowMs - observed >= 15000) return null;
    return JSON.parse(JSON.stringify(value));
  }

  function applyPreview(runtime, preview) {
    const arthur = preview.arthur;
    runtime.statusPlace = arthur.place;
    const activity = arthur.activity;
    // After his stolen things: his day waits (no sitting down to tea or a book
    // mid-chase). Bed still wins; that's where he gives up and leaves it to her.
    const toBed = arthur.availability === 'sleeping' || arthur.pose === 'sleeping';
    if (runtime.chasingStolen && runtime.chasingStolen() && !toBed) return;
    runtime.setProjectedActivity(activity.key, activity.type, activity.resources);
    if (activity.resources.body_locked === true) runtime.stopDesktopMotion();
    runtime.setOutfit('auto');
    const holding = runtime.localHoldUntil && Date.now() < runtime.localHoldUntil;
    if (holding && !(arthur.availability === 'sleeping' || arthur.pose === 'sleeping')) return;
    // In bed but not asleep yet: lying down, eyes open.
    runtime.bedAwake = arthur.pose === 'sleeping' && arthur.availability === 'awake';
    if (arthur.availability === 'sleeping' || arthur.pose === 'sleeping') runtime.setLifeState('sleep');
    else if (arthur.pose === 'waking') runtime.setLifeState('waking');
    else if (arthur.pose === 'reading' || activity.key === 'reading') runtime.setLifeState('reading');
    else if (arthur.pose === 'tea' || activity.key === 'tea') runtime.setLifeState('tea');
    else if (arthur.pose === 'outdoors' || arthur.place === 'outdoors' || activity.key === 'outdoors') runtime.setLifeState('outdoors');
    else if (['sleep','reading','tea','outdoors','waking'].includes(runtime.state)) runtime.setLifeState('awake');
    if (activity.key === 'guitar' && activity.resources.hands === 'both' && activity.resources.body_locked === false) runtime.playGuitar(true);
  }

  function labelFor(status, preview) {
    if (status && status.applied) {
      const host = status.host === 'vps' ? 'VPS' : 'Mac';
      const activity = status.arthur && status.arthur.activity ? status.arthur.activity.key : 'unknown';
      const detail = status.arthur && status.arthur.activity ? status.arthur.activity.detail : null;
      const labels = {reading:'读东西',tea:'喝茶',guitar:'弹吉他',sleeping:'睡觉',outdoors:'在外面',learned_activity:'忙自己的事',unknown:'状态未知'};
      const details = {cooking:'做饭',garden:'园艺',writing:'写东西',music:'弄音乐',housework:'收拾屋子',occult:'神秘学',watching:'看东西',online:'用电脑',work:'处理正事',resting:'歇着',drinking:'小酌',hobby:'摆弄爱好',exercise:'运动',bathing:'洗澡',pub:'在酒馆',museum:'逛博物馆',park:'在公园',market:'逛市场',eating_out:'在外面吃饭',walking:'在外面走走',fishing:'钓鱼'};
      return {text:`${host} · ${details[detail] || labels[activity] || labels.unknown}`, className:status.health === 'degraded' ? 'degraded' : status.host};
    }
    if (preview) return {text:'Mac · 本机过渡期状态', className:preview.maintenance.health === 'degraded' ? 'degraded' : 'mac'};
    if (status && status.phase === 'switching') return {text:'Arthur 正在搬家', className:'switching'};
    return {text:'暂时无法确认 Arthur 的状态', className:'unknown'};
  }

  async function fetchJSON(path) {
    const controller = new AbortController();
    const timer = global.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await global.fetch(path, {cache:'no-store', credentials:'same-origin', signal:controller.signal});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      global.clearTimeout(timer);
    }
  }

  class ArthurLiveStatusClient {
    constructor(runtime, adapter, options={}) {
      this.runtime = runtime;
      this.adapter = adapter;
      this.document = options.document || global.document;
      this.clock = options.clock || (() => Date.now());
      this.fetchJSON = options.fetchJSON || fetchJSON;
      this.status = null;
      this.preview = null;
      this.timer = null;
      this.running = false;
      this.polling = false;
    }

    _render() {
      const label = labelFor(this.status, this.preview);
      const text = this.document && this.document.querySelector('#hostLabel');
      const dot = this.document && this.document.querySelector('#hostDot');
      if (text) text.textContent = label.text;
      if (dot) dot.className = `host-dot ${label.className}`;
    }

    async poll() {
      if (this.polling) return;
      this.polling = true;
      const refresh = this.document && this.document.querySelector('#refresh');
      if (refresh) refresh.classList.add('busy');
      try {
        const raw = await this.fetchJSON('/api/companion-status');
        this.status = this.adapter.consume(raw, {nowMs:this.clock()});
        this.preview = null;
        if (!this.status.applied) {
          const candidate = await this.fetchJSON('/api/companion-preview');
          const preview = validatePreview(candidate, this.clock());
          if (preview) {
            applyPreview(this.runtime, preview);
            this.preview = preview;
          }
        }
      } catch (_) {
        this.status = null;
        this.preview = null;
      } finally {
        this.polling = false;
        if (refresh) refresh.classList.remove('busy');
        this._render();
        this._schedule();
      }
    }

    _schedule() {
      if (!this.running) return;
      global.clearTimeout(this.timer);
      const hidden = this.document && this.document.visibilityState === 'hidden';
      this.timer = global.setTimeout(() => this.poll(), hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.poll();
    }

    stop() {
      this.running = false;
      global.clearTimeout(this.timer);
    }
  }

  async function bootstrap() {
    // Pet-only builds (Windows, for friends) have no Arthur on a server to watch:
    // no status pill, no refresh button, nothing about hosts or snapshots.
    if (/[?&]pet=1(&|$)/.test(global.location && global.location.search || '')) {
      global.document.body.classList.add('pet-only');
      const eyebrow = global.document.querySelector('.poke-eyebrow');
      if (eyebrow) eyebrow.textContent = 'ARTHUR';   // 'read only' meant: doesn't reach the server Arthur
    }
    const mount = global.document.querySelector('#mount');
    const response = await global.fetch('arthur-desktop-rig-v3.svg', {cache:'no-store'});
    if (!response.ok) throw new Error('Arthur rig unavailable');
    mount.innerHTML = await response.text();
    const svg = mount.querySelector('svg');
    let pokeMenu = null;
    const nativeHandler = global.webkit && global.webkit.messageHandlers && global.webkit.messageHandlers.arthurHost;
    const host = nativeHandler ? {post:message => {
      // Storming off and she grabs him (any drag, lifted or not): that's being stopped.
      if (message && message.type === 'drag-begin' && runtime && runtime.stormGrabbed) runtime.stormGrabbed();
      try { nativeHandler.postMessage(message); } catch (_error) {}
    }} : null;
    const runtime = new global.ArthurDesktopRuntime(svg, {
      host,
      state:'awake',
      mood:'calm',
      idle:true,
      desktopAutonomy:true,
      desktopScale:.74,
      walkBounds:[-90, 185],
      onInteractionRequest:payload => {
        if (payload && payload.type === 'drag-complaint' && global.ArthurDesktopCompanion && global.ArthurDesktopCompanion.lines) return global.ArthurDesktopCompanion.lines.pickedUp();
        return pokeMenu && pokeMenu.handleInteractionRequest(payload);
      }
    });
    runtime.setDesktopAutonomy(true);
    let statusTalk = null;
    const adapter = new global.ArthurCompanionStatusAdapter(runtime, {
      onStatus:status => statusTalk && statusTalk.observe(status)
    });
    const client = new ArthurLiveStatusClient(runtime, adapter);
    startPointingCues(runtime);
    const wardrobe = makeWardrobe(runtime, host);
    const log = text => { if (host) host.post({type:'log', text:String(text)}); };
    const speech = makeSpeech(runtime, log);
    wardrobe.speech = speech;
    wardrobe.log = log;
    const lines = makeLines(speech);
    lines.runtime = runtime;
    statusTalk = makeStatusTalk(runtime, speech);
    const fileHands = makeFileHands(runtime, speech);
    pokeMenu = new global.ArthurLocalPokeMenu({
      runtime,
      wardrobe,
      host,
      statusProvider:() => client.status && client.status.applied ? client.status : client.preview
    });
    const refresh = global.document.querySelector('#refresh');
    if (refresh) refresh.addEventListener('click', () => client.poll());
    global.document.addEventListener('visibilitychange', () => client._schedule());
    client.start();
    pokeMenu.speech = speech;
    global.setInterval(() => { const fixed = pokeMenu.heal && pokeMenu.heal(); if (fixed && host) host.post({type:'log', text:`poke menu healed: ${fixed}`}); }, 1500);
    // His pockets: kept by the app (survive restarts), tidied now and then.
    const pockets = global.ArthurPockets ? global.ArthurPockets.makePockets({save:items => { if (host) host.post({type:'pockets', json:JSON.stringify(items)}); }}) : null;
    if (pockets) {
      if (!host) pockets.seed();
      pokeMenu.pockets = pockets;
      global.setInterval(() => pockets.churn(), 20 * 60 * 1000);
    }
    let chaseTimer = null;
    const stopChase = () => { global.clearInterval(chaseTimer); chaseTimer = null; };
    // The little parts of him.
    const partQuiet = () => Date.now() - (runtime._partSaidAt || 0) < 6000;
    const partSay = (pool, ms=2800) => { if (partQuiet() || (pokeMenu.grudge && pokeMenu.grudge.active() && Math.random() < .6)) return; runtime._partSaidAt = Date.now(); speech.say(pick(pool), ms); };
    const smallPart = zone => {
      if (runtime.state === 'sleep') return;
      if (zone === 'nose') {
        const r = runtime.noseBoop();
        if (r === 'sneeze') global.setTimeout(() => partSay(PART_LINES.sneeze), 1700);
        else partSay(PART_LINES.nose);
      } else if (zone === 'brow') { runtime.browPoke(); partSay(PART_LINES.brow); }
      else if (zone === 'ear-left' || zone === 'ear-right') { runtime.earFlick(zone === 'ear-left' ? 'left' : 'right'); if (Math.random() < .4) partSay(PART_LINES.ear); }
      else if (zone === 'ahoge') { const r = runtime.ahogeFlick(); if (r === 'covered') partSay(PART_LINES.ahogeCover); else if (Math.random() < .35) partSay(PART_LINES.ahoge); }
      else if (zone === 'collar') { const r = runtime.collarTouch(); partSay(r === 'messed' ? PART_LINES.collarMessed : PART_LINES.collar); }
      else if (zone === 'hat') { const r = runtime.hatKnock(); partSay(r === 'again' ? PART_LINES.hatAgain : PART_LINES.hat); }
    };
    runtime.onPart = what => { if (what === 'brow-rub') partSay(PART_LINES.browRub); };
    // Tail play.
    // Every tail line shares one quiet spell, so playing with it isn't a running commentary.
    const tailQuiet = () => Date.now() - (runtime._tailSaidAt || 0) < 15000;
    const tailSaid = () => { runtime._tailSaidAt = Date.now(); };
    runtime.onTailAway = () => {
      if (tailQuiet() || Math.random() < .5) return;
      tailSaid();
      speech.say(pick(['哼。', '……尾巴也不给你碰。', '……现在不许碰。']), 2500);
    };
    runtime.onTailNoticed = () => {
      if (Date.now() - (runtime._tailNoticeSaidAt || 0) < 120000 || tailQuiet()) return;
      runtime._tailNoticeSaidAt = Date.now(); tailSaid();
      speech.say(pick(['……我没在动。', '……那是它自己动的。跟我无关。', '尾巴，安分点。', '……你什么都没看见。']), 3000);
    };
    let tailStrokes = [];
    runtime.onTailStroke = smooth => {
      const now = Date.now();
      if (!smooth) {
        tailStrokes = [];
        if (now - (runtime._tailPuffSaidAt || 0) > 25000 && !tailQuiet() && Math.random() < .5) {
          runtime._tailPuffSaidAt = now; tailSaid();
          speech.say(pick(['喂！！方向反了！', '逆、逆着摸干什么！', '炸毛了！你看你干的好事！', '……！毛全乱了！']), 3000);
        }
        return;
      }
      tailStrokes = tailStrokes.filter(t => now - t < 40000);
      tailStrokes.push(now);
      if (tailQuiet()) return;
      if (tailStrokes.length === 4) { tailSaid(); speech.say(pick(['……够了。', '……别摸了。痒。', '……再摸一下就停。我不该习惯这个的。']), 3000); }
      else if (tailStrokes.length >= 10) { tailStrokes = []; tailSaid(); speech.say(pick(['……你是不是把这当成每日任务了。', '尾巴的毛都被你捋顺了。……谢谢。不对。']), 3500); }
    };
    runtime.onHandHold = () => {
      if (host) host.post({type:'log', text:'hand hold'});
      const g = global.ArthurDesktopCompanion.grudge;
      if (g && g.active()) {
        // Sulking: holding his hand is the make-up he wanted, or he snatches it back.
        const r = g.offer('holdhand');
        if (r === 'wrong') return false;
        if (r === 'made-up') runtime._handMadeUpAt = Date.now();
        return true;
      }
      if (Math.random() < .3) global.setTimeout(() => { if (runtime._handHover && runtime._handHover.gripAt) speech.say(pick(['……', '……我还在生气。']), 2500); }, 2500);
    };
    runtime.onHandLetGo = heldMs => {
      if (host) host.post({type:'log', text:`hand let go after ${Math.round(heldMs)} ms`});
      if (heldMs < 400 || Date.now() - (runtime._handMadeUpAt || 0) < 15000) return;
      speech.say(pick(['我、我只是手冷！', '……什么都没发生。', '你看错了。我没握。', '……手滑了。', '别、别误会！']), 3000);
    };
    pokeMenu.onMagic = () => {
      const how = runtime.castSpell ? runtime.castSpell() : null;
      if (!how) { speech.say(pick(['现在不行。', '……等会儿。']), 2000); return; }
      speech.say(pick(['看好了。', '……就一次。', '站远点。']), 1200);
      global.setTimeout(() => speech.say(how === 'ok'
        ? pick(['……看吧。这才是真正的魔法。', '哼。基本功而已。', '喜欢吗？我练了很久的。', '别告诉阿尔弗雷德。他会以为是什么特效。'])
        : pick(['咳、咳咳……！刚才那个不算！', '……咳。咒语念错了一个音节。', '我的头发……！咳咳……这次不算。', '……你什么都没看见。']), 4000), 1300);
    };
    pokeMenu.onSteal = item => {
      if (!pockets || !pockets.take(item.id)) return;
      noteCrime('stolen');
      grudge.provoked('stolen');
      runtime.stolen = item;
      runtime.putBlanketAway && runtime.putBlanketAway();
      if (host) host.post({type:'steal-start', id:item.id, icon:item.icon, name:item.name});
      // Whatever he was doing, he drops it and goes after her.
      if (runtime.antic && runtime.stopAntic) runtime.stopAntic('poked');
      if (runtime.performanceMode === 'guitar' && runtime.playGuitar) runtime.playGuitar(false);
      runtime.localHoldUntil = 0;
      if (['reading','tea'].includes(runtime.state)) runtime.setLifeState('awake');
      speech.say(pick(['喂！那是我的' + item.name + '！', '还给我！', '你、你这个小偷！']), 3000);
      stopChase();
      chaseTimer = global.setInterval(() => speech.say(pick(runtime.tired ? CHASE_SHOUTS.tired : CHASE_SHOUTS.fresh), 2200), 2600);
    };
    // Led on: he dared a real drop after his things and she lifted them straight
    // back up. Each time it happens (once per theft) a die says how he takes it:
    // sore (stunned, then he stops playing and sulks till she brings it back, and
    // is warier of heights for the rest of the day) or riled (game on: bolder for
    // a while, till the third time, when he's had enough).
    let baitWatch = null;
    const endBaiting = () => {
      global.clearInterval(baitWatch); baitWatch = null;
      if (runtime._chaseRefused) { runtime._chaseRefused = false; if (host) host.post({type:'chase-refuse', on:false}); }
      runtime._baitMood = null;
      runtime._baitQuitAt = null;
    };
    const minutesToMidnight = () => { const d = new Date(); return (24 * 60) - (d.getHours() * 60 + d.getMinutes()); };
    const refuseChase = line => {
      stopChase();
      runtime._chaseRefused = true;
      if (host) host.post({type:'chase-refuse', on:true});
      const name = runtime.stolen ? runtime.stolen.name : '东西';
      if (grudge.active()) grudge.again('baited');
      else grudge.start({mild:true, cause:'baited', line,
        need:{kind:'return', hint:['我的' + name + '。还给我。', '……你知道该怎么做。', '我就在这儿。不动。'], done:'……下次再这样，我就真的不理你了。'}});
      // Sulked it out and she still has it: grumbling, he goes and gets it himself.
      global.clearInterval(baitWatch);
      baitWatch = global.setInterval(() => {
        if (!runtime.stolen) return endBaiting();
        if (grudge.active()) return;
        global.clearInterval(baitWatch); baitWatch = null;
        runtime._chaseRefused = false;
        if (runtime.antic && runtime.stopAntic) runtime.stopAntic('poked');
        runtime.localHoldUntil = 0;
        if (['reading','tea'].includes(runtime.state)) runtime.setLifeState('awake');
        if (host) host.post({type:'chase-refuse', on:false});
        speech.say(pick(['……好吧。还是得我自己去拿。', '哼。指望你是没用的。', '……我自己来。']), 3500);
      }, 2000);
    };
    const baited = (n, way='up') => {
      const down = way === 'down';   // he'd climbed up after it, and down it went
      if (!runtime.stolen) return;
      noteCrime('baited');
      if (!runtime._baitMood) {
        runtime._baitMood = Math.random() < .55 ? 'sore' : 'riled';
        // Riled, he plays along: some days for three or four or five rounds till it
        // dawns on him he's being toyed with, some days for as long as she likes.
        runtime._baitQuitAt = Math.random() < .3 ? Infinity : 3 + Math.floor(Math.random() * 3);
      }
      if (runtime._baitMood === 'sore') {
        if (host) host.post({type:'dare-bias', value:-0.15, minutes:minutesToMidnight()});
        if (n <= 1) {
          stopChase();
          speech.say(pick(['……你。你刚才是故意的。', '……等一下。你是在遛我？', '……我就知道。',
            down ? '我好不容易才爬上来的！' : '我、我刚才可是从那么高跳下来的！']), 3800);
          global.setTimeout(() => { if (runtime.chasingStolen() && !chaseTimer) chaseTimer = global.setInterval(() => speech.say(pick(runtime.tired ? CHASE_SHOUTS.tired : CHASE_SHOUTS.fresh), 2200), 2600); }, 4200);
        } else {
          refuseChase(pick(down
            ? ['我不下去了。你自己拿上来。', '……不追了。你爱放哪儿放哪儿。', '哼。我又不是你养的猫。', '我就坐这儿。你什么时候玩够了，什么时候还给我。']
            : ['我不跳了。你自己拿下来。', '……不追了。你爱拿多高拿多高。', '哼。我又不是你养的猫。', '我看着。你什么时候玩够了，什么时候还给我。']));
        }
      } else if (n < runtime._baitQuitAt) {
        if (host) host.post({type:'dare-bias', value:0.25, minutes:15});
        if (typeof runtime.jump === 'function') runtime.jump({height:60, duration:380});
        speech.say(pick(['……好啊。你想玩是吧。', '来啊！看谁先认输！',
          down ? '爬上爬下而已，难不倒我。' : '你以为这点高度能难住我？', down ? '再来！我爬得比你拿得快。' : '海盗船长可不怕高。']), 3500);
      } else {
        refuseChase(pick(['……够了。你在耍我吧。不玩了。', '……等等。你从头到尾都在耍我？', '哼，我赢了，所以我不玩了。', '……我累了。不是认输。']));
      }
    };
    // Gone to bed (blanket on, or asleep) with his things still out: he stops
    // chasing and fetching, and leaves it to her. Up again, he carries on.
    runtime.bedWithStolen = () => {
      const inBed = !!runtime.blanket || runtime.state === 'sleep';
      if (inBed && runtime.stolen && !runtime._chasePaused) {
        runtime._chasePaused = true;
        stopChase();
        if (host) host.post({type:'chase-pause', on:true});
        speech.say(pick(['哼。你最好自己给我拿回来。', '……我睡了。明天早上之前，给我放回来。', '我不追了。……你自己知道该怎么做。', '哼。反正你会还给我的。对吧。']), 4500, {asleep:true});
      } else if (!inBed && runtime._chasePaused) {
        runtime._chasePaused = false;
        if (host) host.post({type:'chase-pause', on:false});
      }
    };
    const itemBack = (how) => {
      stopChase();
      endBaiting();
      if (runtime._chasePaused && how === 'returned') {
        runtime._chasePaused = false;
        if (host) host.post({type:'chase-pause', on:false});
        const item = runtime.stolen; runtime.stolen = null;
        if (item && pockets) pockets.put(item);
        speech.say(pick(['……嗯。这还差不多。', '……放那儿吧。晚安。', '哼。算你有良心。', '……（他从被子里伸出手，把东西拿了进去）']), 4000, {asleep:true});
        return;
      }
      runtime._chasePaused = false;
      const item = runtime.stolen;
      runtime.stolen = null;
      if (item && pockets) pockets.put(item);
      if (how === 'returned') {
        if (grudge.active() && grudge.offer('return') === 'made-up') return;
        speech.say(pick(['……这还差不多。', '哼。下次再偷试试。', '算你识相。', '……这本来就是我的。']), 4000);
      } else if (how === 'snatched') {
        // Caught her and took it back himself: pleased with himself, not forgiving.
        if (typeof runtime.jump === 'function') runtime.jump({height:90, duration:480});
        if (typeof runtime.spawnFlowers === 'function' && Math.random() < .3) runtime.spawnFlowers();
        if (grudge.active()) grudge.end('fetched');
        speech.say(pick(['抓到了！哼，想跟我抢？', '……再练几百年吧。', '海盗船长的东西你也敢抢？', '拿回来了。手脚这么慢还想当小偷。',
          '哈！我赢了。', '……你以为我追不上你？', '物归原主。这才是正确的秩序。']), 4000);
      } else {
        if (grudge.active()) grudge.end('fetched');
        speech.say(pick(['哼，自己捡回来了。', '……一点礼貌都没有。', '我自己拿回来了。别想有下次。']), 4000);
      }
    };
    touchHost = host;
    patHost = host;
    patSpeech = speech;
    // Head pats stay wordless: he'd never admit to liking them, and after a while
    // he just slips away (the runtime's own retreat).
    pokeMenu.onGift = id => { if (pokeMenu.pockets && (id === 'book' || id === 'rose')) pokeMenu.pockets.gift(id); };
    fileHands.onFile = (name, count) => { if (pokeMenu.pockets && count === 1) pokeMenu.pockets.gift('file', `「${String(name).length > 12 ? String(name).slice(0, 11) + '…' : name}」`); };
    touchSpeech = speech;
    runtime.onBellyRub = () => {
      // Sulking: a belly rub is one more guess at making up (usually the wrong one).
      if (pokeMenu.grudge && pokeMenu.grudge.active()) { pokeMenu.grudge.offer('belly'); return; }
      bodyTouch(runtime);
    };
    // Stroking his hand: he's mostly just baffled, and slowly lets you.
    let handRubs = 0, handDay = 0;
    runtime.onHandRub = () => {
      if (pokeMenu.grudge && pokeMenu.grudge.active()) { pokeMenu.grudge.offer('hand'); return; }
      if (handDay !== localDay()) { handDay = localDay(); handRubs = 0; }   // a new day: baffled all over again
      handRubs += 1;
      const pool = handRubs < 5
        ? ['……你为什么要摸我的手？', '我的手上有什么吗？', '……这是什么新的游戏？', '嗯？……你手冷？', '你在研究我的手？', '……？']
        : ['……你到底喜欢我的手哪里。', '好吧，随你。……我不懂，但随你。', '……要牵就牵，摸来摸去的做什么。', '@puzzledhand'];
      speech.say(pick(pool), 3500);
    };
    const chatter = makeChatter(runtime, speech, statusTalk, wardrobe, () => pokeMenu.active);
    const grudge = makeGrudge(runtime, speech, host);
    runtime.grudge = grudge;
    grudge.peace = makePeaceOfferings(host, speech);
    fileHands.grudge = grudge;
    // Head pats while he sulks add up.
    let patMs = 0;
    global.setInterval(() => {
      if (!grudge.active()) { patMs = 0; return; }
      if (typeof runtime._activeHeadPat === 'function' && runtime._activeHeadPat()) { patMs += 200; grudge.offer('pat', patMs); }
    }, 200);
    watchAntics(runtime, speech, statusTalk);
    chatter.grudge = grudge;
    lines.grudge = grudge;
    pokeMenu.grudge = grudge;
    // Tapping frantically at the envelope in his hand: it counts as read, and he yells.
    const reactToZone = runtime._reactToZone.bind(runtime);
    let letterTaps = [];
    runtime._reactToZone = (zone, event) => {
      if (zone === 'torso' && !(pokeMenu.grudge && pokeMenu.grudge.active())) bellyJab(runtime);
      if (['face','hand-left','hand-right','foot-left','foot-right','tail'].includes(zone)
          && !(pokeMenu.grudge && pokeMenu.grudge.active()) && runtime.q('prop-letter').getAttribute('display') !== 'inline') {
        pokeLine(zone, speech);
      }
      if (zone === 'bunny') { runtime.shooBunny(); return; }
      if (['nose','brow','ear-left','ear-right','ahoge','collar','hat'].includes(zone)) { smallPart(zone); return; }
      if (zone === 'tail' && runtime.sulk && runtime.tailAway) { runtime.tailAway(); return; }
      if (zone === 'note') {
        if (runtime.takeNote()) speech.say(pick(['……那是之前写的。', '看完了就扔掉。', '……字写得急，别挑剔。', '嗯。就那样。']), 3000);
        return;
      }       // off it hops; he carries on as if nothing happened
      if (zone === 'crotch' && runtime.blanket) return;   // under the blanket he doesn't feel a thing, or notice
      if (zone === 'crotch') {
        if (Date.now() - (runtime._crotchSaidAt || 0) > 1500) noteCrime('crotch');
        // He jumps out of his skin first, then yells.
        if (typeof runtime.jump === 'function') runtime.jump({height:150, duration:620});
        if (typeof runtime.fluster === 'function') runtime.fluster();
        if (Date.now() - (runtime._crotchSaidAt || 0) > 1500) {
          runtime._crotchSaidAt = Date.now();
          speech.say(pick(['你在做什么！你知道你在干什么吗！', '很痛的知道吗！', '……！不、不要碰那里！', '你往哪儿戳呢！！', '喂！！你、你、你——！', '……变态！']), 3800);
        }
        return;
      }
      if ((zone === 'hand-left' || zone === 'hand-right') && pokeMenu.grudge && pokeMenu.grudge.active()) {
        pokeMenu.grudge.offer('hand');
        return reactToZone(zone, event);
      }
      const envelope = runtime.q('prop-letter');
      if (zone === 'hand-left' && envelope && envelope.getAttribute('display') === 'inline') {
        const now = Date.now();
        letterTaps = letterTaps.filter(t => now - t < 1800).concat(now);
        if (letterTaps.length >= 4) {
          letterTaps = [];
          const id = statusTalk.unreadLetter();
          if (id) pokeMenu.letters.markRead(id); else statusTalk.markRead('');
          if (typeof runtime.startleFromPoke === 'function') runtime.startleFromPoke({duration:1280});
          speech.say(pick(['不要乱摸我的手！', '喂！手！……行了行了，算你看过了。', '别戳了！我的手又不是门铃！']), 6000);
          return;
        }
      }
      return reactToZone(zone, event);
    };
    pokeMenu.letters = {
      unread:() => statusTalk.unreadLetter(),
      markRead:id => { statusTalk.markRead(id); if (host) host.post({type:'letter-read', id}); }
    };
    global.ArthurDesktopCompanion = {runtime, adapter, client, pokeMenu, wardrobe, speech, lines, fileHands, fileLine};
    global.ArthurDesktopCompanion.baited = baited;
    global.ArthurDesktopCompanion.chatter = chatter;
    global.ArthurDesktopCompanion.pockets = pokeMenu.pockets;
    global.ArthurDesktopCompanion.grudge = grudge;
    memo.host = host;

    // Late at night with her still at the computer: a blanket, the corner of
    // the screen, and a doze. And, once, the day's grudges read out.
    let blanketLineSaid = false;
    global.ArthurDesktopCompanion.night = idle => {
      const now = new Date(), h = now.getHours(), m = now.getMinutes();
      const late = h < 5 || (h === 23 && m >= 30);
      const here = idle < 180;
      if (runtime.bedWithStolen) runtime.bedWithStolen();
      // In bed (asleep or lying awake): the blanket is on him, whatever the hour,
      // and stays on until he's up.
      const inBed = runtime.state === 'sleep';
      if (inBed && !runtime.blanket) {
        runtime.blanket = memo.data.blanketNight && memo.data.blanketNight.day === now.toDateString() ? memo.data.blanketNight.which
          : (Math.random() < .5 ? 'francis' : 'alfred');
      }
      if (runtime.blanket && inBed) {
        memo.data.blanketNight = {day:now.toDateString(), which:runtime.blanket};
      }
      if (late && here && !inBed) {
        const sinceAway = Date.now() - (runtime.blanketPutAwayAt || 0);
        if (!runtime.blanket && !runtime._blanketPending && sinceAway > 10 * 60 * 1000) {
          const which = Math.random() < .5 ? 'francis' : 'alfred';
          blanketLineSaid = false;
          const asleep = runtime.state === 'sleep' || runtime.sleepSequence;
          if (!asleep && !runtime.antic && !(pokeMenu.grudge && pokeMenu.grudge.active())) {
            // Off to the snuggest corner he can reach first; once he's there
            // (the app says so), the blanket and a doze.
            const askedAt = Date.now();
            const settle = () => {
              if (!runtime._blanketPending) return;
              runtime._blanketPending = false;
              global.clearTimeout(runtime._blanketFallback);
              if (runtime.held || (runtime.blanketPutAwayAt || 0) > askedAt) return;
              runtime.blanket = which;
              if (!runtime.antic) runtime.startAntic('doze', {duration:(20 + Math.random() * 20) * 60 * 1000});
              if (runtime.bedWithStolen) runtime.bedWithStolen();
            };
            runtime._blanketPending = true;
            runtime._inCorner = settle;
            runtime._blanketFallback = global.setTimeout(settle, host ? 75000 : 9000);
            if (host) host.post({type:'go-corner'});
          } else {
            runtime.blanket = which;
          }
        }
        if (runtime.blanket && !blanketLineSaid && runtime.state !== 'sleep') {
          blanketLineSaid = true;
          speech.say(runtime.blanket === 'francis'
            ? pick(['……这条是弗朗西斯送的。将就着用吧。', '弗朗西斯的毯子……香水味还没散。……暖和就行。', '格纹的。……那家伙别的不行，挑东西的眼光倒还可以。'])
            : pick(['阿尔弗雷德送的这条。……玫瑰。他说因为我们两边的国花都是玫瑰。', '……那小子送的。别笑。', '这条是阿尔弗雷德送的。他居然知道我喜欢什么样的。……别告诉他我说过这话。']), 5000);
        }
      } else if (runtime.blanket && !inBed && !late) {
        runtime.blanket = null;
        if (runtime.antic && runtime.antic.type === 'doze') runtime.stopAntic('morning');
      }
      // She's been gone a good while (half an hour or more): a note by his feet
      // for when she's back.
      if (idle > 1800 && !runtime.note) runtime._wasAwayLong = true;
      if (here && runtime._wasAwayLong && idle < 60) {
        runtime._wasAwayLong = false;
        const notes = h >= 23 || h < 5
          ? [['还不睡？', '……我先眯一会儿。'], ['这么晚回来。', '快去睡。'], ['我睡了。', '你也是。']]
          : h >= 15 && h < 18
          ? [['去泡茶了。', '……没在等你。'], ['下午茶时间。', '你不在，我就自己喝了。']]
          : [['去泡茶了。', '……没在等你。'], ['出去走了走。', '回来了。'], ['你不在。', '……我也没干什么。'], ['看了会儿书。', '别乱动我的书签。'], ['桌面太乱了。', '……我没动。只是看着。']];
        if (runtime.leaveNote) runtime.leaveNote(pick(notes));
        global.setTimeout(() => { if (runtime.note) runtime.takeNote(); }, 15 * 60 * 1000);
      }
      // Asleep: now and then he mumbles something.
      if (runtime.state === 'sleep' && !runtime.bedAwake && !runtime.sleepSequence && Math.random() < .03 && Date.now() - (runtime._sleepTalkAt || 0) > 4 * 60 * 1000) {
        runtime._sleepTalkAt = Date.now();
        // Half the time it's just his lips moving, no words you could catch.
        const words = Math.random() < .5;
        if (runtime.sleepTalk) runtime.sleepTalk(words ? 2600 : 1500 + Math.random() * 2000);
        if (words) speech.say(pick(SLEEP_TALK), 3200, {asleep:true});
      }
      // Now and then a mint bunny turns up on his head (about once an hour or two).
      if (here && !runtime.bunny && runtime.state !== 'sleep' && Math.random() < .003 && runtime.showMintBunny) {
        runtime.showMintBunny((3 + Math.random() * 7) * 60 * 1000);
      }
      // Afternoon tea, about four o'clock, once a day: he makes a pot, and
      // half the time pours her a cup too.
      const today = now.toDateString();
      if (here && memo.data.teaDay !== today && ((h === 15 && m >= 45) || (h === 16 && m < 40))
          && !runtime.antic && !runtime.blanket && runtime.state !== 'sleep' && !(pokeMenu.grudge && pokeMenu.grudge.active())) {
        if (runtime.startAntic('tea', {duration:(6 + Math.random() * 8) * 60 * 1000})) {
          memo.data.teaDay = today; memo.save();
          speech.say(pick(['四点了。……下午茶时间。', '该泡茶了。', '下午茶。这是原则问题。']), 3500);
          const g = global.ArthurDesktopCompanion.grudge;
          if (Math.random() < .5 && g && g.peace && g.peace.give) {
            const cup = {icon:'🍵', note:['……多泡了一杯。放那儿了。', '给你也倒了一杯。'], take:['趁热喝。', '……加了奶。不知道你要不要，反正加了。', '别光放着，喝。']};
            global.setTimeout(() => {
              if (!g.peace.give(cup)) return;
              global.setTimeout(() => { if (g.peace.waiting(cup)) speech.say(pick(['……茶要凉了。', '你的茶。凉了就不好喝了。', '我给你倒的茶，你是打算供起来吗。']), 3500); }, 10 * 60 * 1000);
            }, 40 * 1000);
          }
        }
      }
      // Once a day, late in the evening, the tally.
      const c = crimes();
      if (!c.read && here && ((h === 22 && m >= 30) || h === 23 || h < 2)) {
        const parts = Object.keys(CRIME_WORDS).filter(k => c[k]).map(k => `${CRIME_WORDS[k]}${CN(c[k])}次`);
        if (parts.length && Object.keys(CRIME_WORDS).reduce((n, k) => n + (c[k] || 0), 0) >= 3) {
          c.read = true; memo.save();
          speech.say(`今日罪状：${parts.join('，')}。……我都记着。`, 7000);
          global.setTimeout(() => speech.say(pick(['……明天给我老实点。', '……不过算了。晚安。', '念完了。……我没在生气。']), 4000), 7500);
        }
      }
    };

    // He walked over to her cursor: a look, a little prod, maybe a word.
    global.ArthurDesktopCompanion.visitCursor = (x, y) => {
      if (typeof runtime.hostPointer === 'function') runtime._updateAttentionTarget({clientX:x, clientY:y, target:runtime.svg});
      if (typeof runtime._startPartReaction === 'function') runtime._startPartReaction('hand-right-poke', 720);
      if (Math.random() < .5) speech.say(pick(['……你在干什么呢？', '嗯。看起来很忙。', '我就看看。别管我。', '……戳。', '这是什么？……看不懂。']), 3000);
    };
    global.ArthurDesktopCompanion.itemBack = itemBack;
    global.ArthurDesktopCompanion.itemDropped = () => {
      stopChase();
      speech.say(pick(['……扔、扔地上了？！', '你就这么扔在那儿？！', '我的东西！']), 3500);
    };
    global.ArthurDesktopCompanion.itemUnreachable = () => {
      stopChase();
      const name = runtime.stolen ? runtime.stolen.name : '东西';
      if (grudge.active()) { grudge.again('stolen'); return; }
      grudge.start({mild:true, cause:'stolen', line:pick(['够不着……！你给我拿下来！', '放那么高，你是故意的吧！', '……把我的' + name + '拿下来。现在。']),
        need:{kind:'return', hint:['我的' + name + '还在上面。', '……你知道该怎么做。'], done:'……还回来就好。这次原谅你。'}});
    };
    if (host) startHostBridge(runtime, host, wardrobe, lines, fileHands, statusTalk, chatter);
  }

  // The status pill: shown only while she points at him, parked over his head.
  function startPointingCues(runtime) {
    const doc = global.document;
    const card = doc.querySelector('.status-card');
    let hideTimer = null;
    const place = () => {
      const head = runtime.q('motion-head-root');
      if (!card || !head || !head.getBoundingClientRect) return;
      const h = head.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      const top = Math.max(4, h.top - c.height - 4);
      card.style.top = `${Math.round(top)}px`;
      card.style.left = `${Math.round(h.left + h.width / 2)}px`;
    };
    doc.addEventListener('pointermove', () => {
      if (!doc.body.classList.contains('pointing')) place();
      doc.body.classList.add('pointing');
      global.clearTimeout(hideTimer);
      hideTimer = global.setTimeout(() => doc.body.classList.remove('pointing'), 2200);
    });
    global.setInterval(() => { if (doc.body.classList.contains('pointing')) place(); }, 250);
  }

  // A line he says on his own, over his head, then lets drop.
  function makeSpeech(runtime, log=() => {}) {
    const doc = global.document;
    const bubble = doc.querySelector('#arthurSay');
    let hideTimer = null;
    let goneTimer = null;
    // One line at a time: each stays up a moment, with a short gap before the next, so
    // three or four don't come tumbling out together. Only the newest waiting line is
    // kept (older reactions are stale by the time it's their turn).
    const MIN_SHOW = 1600, GAP = 400;
    let shownAt = 0, hiddenAt = 0, showing = false, pending = null, pendingTimer = null;
    const clockMs = () => (global.performance ? performance.now() : Date.now());
    const speech = {
      say(text, ms=9000, opts={}) {
        if (!bubble || !text) return false;
        // A move happens at once; only the words wait their turn.
        const tag = /^@(\w+)\s*/.exec(text);
        if (tag) {
          if (((runtime.state === 'sleep' && !runtime.bedAwake) || runtime.sleepSequence) && !opts.asleep) return false;
          if (runtime.act) runtime.act(tag[1]);
          text = text.slice(tag[0].length);
          if (!text) { log(`act ${tag[1]}`); return true; }
        }
        const now = clockMs();
        const readyAt = showing ? Math.max(shownAt + MIN_SHOW, now) + GAP : Math.max(hiddenAt + GAP, now);
        if (readyAt <= now + 5) return speech._show(text, ms, opts);
        pending = {text, ms, opts};
        global.clearTimeout(pendingTimer);
        pendingTimer = global.setTimeout(() => {
          const p = pending; pending = null;
          if (!p) return;
          if (showing) { bubble.classList.remove('open'); showing = false; hiddenAt = clockMs(); global.clearTimeout(hideTimer); }
          global.setTimeout(() => speech._show(p.text, p.ms, p.opts), Math.max(0, hiddenAt + GAP - clockMs()));
        }, Math.max(0, (showing ? Math.max(shownAt + MIN_SHOW, now) : now) - now));
        return true;
      },
      _show(text, ms=9000, opts={}) {
        if (!bubble || !text) { log(`say skipped: bubble=${!!bubble}`); return false; }
        if (((runtime.state === 'sleep' && !runtime.bedAwake) || runtime.sleepSequence) && !opts.asleep) { log(`say skipped: asleep (${runtime.state})`); return false; }
        // In the maid's dress he isn't speaking to her. At all.
        if (runtime.outfit === 'maid' && !opts.force) { log('say skipped: not speaking (maid)'); return false; }
        // How his voice sounds, shown by the bubble: sobbing, trembling, or a yell.
        const now = global.performance ? performance.now() : Date.now();
        const sobbing = (runtime.cryUntil && now < runtime.cryUntil) || (runtime.slumpCry && runtime._slumped && runtime._slumped()) || (runtime.lyingTearsUntil && now < runtime.lyingTearsUntil);
        const byTail = runtime.gripZone && runtime.gripZone() === 'tail' && (runtime.held || runtime.hostCarry);
        const afraid = runtime.worried || runtime.pleading || runtime.scaredHigh || byTail;
        const shake = opts.shake || (sobbing ? 'sob' : afraid ? 'fear' : /！！/.test(text) ? 'jolt' : '');
        bubble.classList.remove('shake-sob', 'shake-fear', 'shake-jolt');
        if (shake) { void bubble.offsetWidth; bubble.classList.add('shake-' + shake); }
        global.clearTimeout(hideTimer);
        global.clearTimeout(goneTimer);
        bubble.textContent = text;
        bubble.hidden = false;
        doc.body.classList.add('speaking');
        const head = runtime.q('motion-head-root');
        const box = bubble.getBoundingClientRect();
        const viewW = global.innerWidth || 390;
        let x = (viewW - box.width) / 2;
        let y = 40;
        let tailX = box.width / 2;
        if (head && head.getBoundingClientRect) {
          const h = head.getBoundingClientRect();
          const cx = h.left + h.width / 2;
          x = Math.max(6, Math.min(cx - box.width / 2, viewW - box.width - 6));
          // Stay clear of the status pill along the top edge.
          // Under the menu bar the top of the window can't be seen: keep the bubble below it.
          y = Math.max(4 + (runtime.topCut || 0), h.top + h.height * .08 - box.height - 10);
          tailX = Math.max(16, Math.min(cx - x, box.width - 16));
        }
        bubble.style.left = `${Math.round(x)}px`;
        bubble.style.top = `${Math.round(y)}px`;
        bubble.style.setProperty('--tail-x', `${Math.round(tailX)}px`);
        global.requestAnimationFrame ? global.requestAnimationFrame(() => bubble.classList.add('open')) : bubble.classList.add('open');
        log(`say "${text}" at ${Math.round(x)},${Math.round(y)} size ${Math.round(box.width)}x${Math.round(box.height)} view ${global.innerWidth}x${global.innerHeight}`);
        showing = true; shownAt = clockMs();
        hideTimer = global.setTimeout(() => {
          bubble.classList.remove('open');
          showing = false; hiddenAt = clockMs();
          goneTimer = global.setTimeout(() => { bubble.hidden = true; doc.body.classList.remove('speaking'); }, 300);
        }, ms);
        return true;
      }
    };
    return speech;
  }

  // Pick a line he hasn't said lately (across every pool), if there is one.
  const RECENT_LINES = [];
  const pick = list => {
    if (!list || !list.length) return '';
    const fresh = list.filter(x => !RECENT_LINES.includes(x));
    const pool = fresh.length ? fresh : list;
    const line = pool[Math.floor(Math.random() * pool.length)];
    RECENT_LINES.push(line);
    if (RECENT_LINES.length > 60) RECENT_LINES.shift();
    return line;
  };
  global.ArthurPickFresh = pick;

  // Files she drops on him. He only ever sees the name; nothing is opened,
  // and the name stays on this Mac.
  const FILE_RULES = [
    // Fandom pairings (the first name is the top). He has opinions.
    [/(威|苏|爱|北爱)英|英(威|苏|爱|北爱)/, ['这怎么可能！他们是我的哥哥！', '……这是什么东西。他们是我哥哥。拿走。']],
    [/英葡|葡英/, ['不是这种关系。完全不是。', '佩德罗和我是盟友。盟——友。']],
    [/(米|美)英|英(米|美)/, ['我才不会对美国那家伙下手！', '……那是我养大的孩子！你在想什么！']],
    [/(仏|法|佛)英/, ['为什么他是上面那个？！', '……谁允许那个红酒混蛋在上面的？']],
    [/英(仏|法|佛)/, ['我才不会喜欢这种胡子拉碴的变态狂！', '……不。绝对不。胡子拉碴的家伙免谈。']],
    [/加英|英加/, ['你疯了吗？加拿大是我的弟弟，我怎么可能这样做！', '马修是我弟弟！……他知道吗？别让他知道。']],
    [/(普|普鲁士)英|英普/, ['基尔伯特？……他只会来抢我的午饭。别闹了。']],
    [/(日|菊)英|英(日|菊)/, ['本田君是很好的朋友。……只是朋友！']],
    // Anything with him in the name.
    [/英|亚瑟|柯克兰|arthur|kirkland|england|britain|british|(^|[^a-z])uk([^a-z]|$)/i, ['这是……跟我有关的东西？', '等等，这上面写着我？……你在研究什么？', '跟我有关？……给我看看。不，我不看内容，我只是问问。']],
    [/final|最终|定稿/i, ['「最终版」。……第几个最终版了？', '“最终版”。我们都知道这不是最后一个。']],
    [/screen ?shot|截屏|截图|^img_|^image/i, ['截图。你又截了什么奇怪的东西。']],
    [/untitled|未命名|无标题|^新建|document\d|^doc\d/i, ['连名字都不起？给文件起名字是起码的礼貌。']],
    [/副本|copy|\(\d+\)/i, ['副本的副本。你的文件夹一定很可怕。']],
    [/论文|essay|thesis|dissertation|paper|draft|草稿|manuscript/i, ['论文？放这儿吧。……希望这次引用格式是对的。', '论文。别交上去之前才想起来让我看。']],
    [/作业|homework|assignment|coursework|习题|pset|problem.?set|lab/i, ['作业。截止日期是什么时候？……别告诉我是今晚。']],
    [/ddl|deadline|due|截止/i, ['文件名里都写着截止日期了。你现在才开始？']],
    [/exam|考试|期末|期中|midterm|quiz|复习|revision|notes|笔记/i, ['复习资料。去复习，别在这儿逗我。', '笔记？……字写得工整点。']],
    [/简历|cv|resume|cover.?letter|申请/i, ['简历。把你的长处写清楚，别谦虚过头。']],
    [/invoice|发票|receipt|收据|账单|bill|bank|银行|tax|税/i, ['账单我不碰。自己收好。']],
    [/francis|bonnefoy|france|法国|french|paris|巴黎|wine|红酒/i, ['……把这个拿开。隔着屏幕都闻到法国味了。']],
    [/alfred|america|美国|usa|burger|汉堡|coke|可乐/i, ['那个小子的东西？……我不想知道。']],
    [/tea|茶|earl.?grey|scone|司康/i, ['茶？……这个文件名我喜欢。']],
    [/london|伦敦|england|英格兰|英国|britain|\buk\b|queen|king|女王|国王/i, ['伦敦？……你在想我吗。不，别回答。']],
    [/pirate|海盗|ship|船|navy|海军/i, ['……啧。往事就别提了。']],
    [/magic|魔法|fairy|精灵|unicorn|独角兽|harry|potter|spell|咒语|occult|tarot|塔罗/i, ['魔法的东西？……这个我收着了。']],
    [/love|爱|heart|心|valentine/i, ['……这什么文件名。拿走。']],
    [/\.(py|js|ts|swift|java|c|cpp|h|rs|go|ipynb|m|r|sh)$/i, ['代码。别指望我帮你调试。', '代码文件。……注释写了吗？']],
    [/\.pdf$/i, ['又一个PDF。你是真打算读，还是只是下载了？']],
    [/\.(docx?|pages|txt|md|rtf)$/i, ['一份文档。放我这儿也不会自己写完的。']],
    [/\.(pptx?|key)$/i, ['幻灯片。讲的时候别念稿。']],
    [/\.(xlsx?|csv|numbers)$/i, ['表格。……数字的事你自己算。']],
    [/\.(png|jpe?g|gif|heic|webp|tiff?)$/i, ['一张图。……还行。']],
    [/\.(mp3|m4a|wav|flac|aac|ogg)$/i, ['音乐？……希望品味比上次好。']],
    [/\.(mp4|mov|mkv|avi|webm)$/i, ['视频。不看，没空。']],
    [/\.(zip|rar|7z|tar|gz)$/i, ['一包东西。来路不明的包裹我不拆。']],
    [/\.(dmg|exe|pkg|app|msi)$/i, ['安装包？给我干什么，我又不用这个。']]
  ];
  function fileLine(name, isFolder, count, random=Math.random) {
    const one = list => list[Math.floor(random() * list.length)];
    if (count > 1) return one(['一下子这么多？……放那儿吧。', `${count} 个文件。你当我是收纳箱？`]);
    if (isFolder) return '一整个文件夹？你是想把整个书房塞给我吗。';
    const base = String(name || '');
    for (const [pattern, lines] of FILE_RULES) if (pattern.test(base)) return one(lines);
    const short = base.length > 18 ? base.slice(0, 16) + '…' : base;
    return `「${short}」……给我这个做什么？`;
  }
  function makeFileHands(runtime, speech) {
    let putDown = null;
    return {
      hover(on) {
        if (on && typeof runtime._startPartReaction === 'function') runtime._startPartReaction('hover-curious', 1400);
      },
      given(name, isFolder, count) {
        if (runtime.state === 'sleep' || runtime.sleepSequence) return false;
        const sulking = this.grudge && this.grudge.active();
        const file = runtime.q('prop-file');
        const letter = runtime.q('prop-letter');
        const hadLetter = letter && letter.getAttribute('display') === 'inline';
        if (file) file.setAttribute('display', 'inline');
        if (hadLetter) letter.setAttribute('display', 'none');
        if (typeof runtime._startPartReaction === 'function') runtime._startPartReaction('hold-curious', 1600);
        if (!sulking || this.grudge.offer('file') === null) speech.say(fileLine(name, isFolder, count));
        if (this.onFile && !isFolder) this.onFile(name, count);
        global.clearTimeout(putDown);
        putDown = global.setTimeout(() => {
          if (file) file.setAttribute('display', 'none');
          if (hadLetter && letter) letter.setAttribute('display', 'inline');
        }, 8000);
        return true;
      }
    };
  }

  // When what the VPS says about him changes, he sometimes says so; the
  // letter and the weather also show on him (envelope, umbrella).
  const ACTIVITY_LINES = {
    cooking:['我去做饭。', '该做饭了。'], garden:['花园里有些东西值得我去看。'], writing:['我打算写点东西。'],
    housework:['该收拾一下了。'], resting:['歇会儿。'], music:['弄会儿音乐。'],
    reading:['读会儿书。'], tea:['泡壶茶。'], guitar:['我打算弹会儿琴，你做自己的事情去，别来打扰我。'], pub:['我打算去酒馆坐坐……干嘛，有什么稀奇的？'],
    museum:['我打算去博物馆一趟。'], park:['今天很适合去公园逛逛。'], walking:['我出去走走。']
  };
  function makeStatusTalk(runtime, speech, random=Math.random) {
    let last = null;
    let lastSaidAt = 0;
    let lastStatus = null;
    let readId = '';
    const say = (text, important=false) => {
      const now = Date.now();
      if (!important && now - lastSaidAt < 20 * 60 * 1000) return;
      if (now - lastSaidAt < 60 * 1000) return;
      if (speech.say(text)) lastSaidAt = now;
    };
    const show = (id, on) => {
      const el = runtime.q && runtime.q(id);
      if (el) el.setAttribute('display', on ? 'inline' : 'none');
    };
    return {
      observe(status) {
        if (!status || !status.applied || !status.arthur) return;
        lastStatus = status;
        const a = status.arthur;
        const unread = a.letter === 'waiting' && !(a.letter_id && a.letter_id === readId);
        const asleep = a.availability === 'sleeping';
        const weather = a.weather || {sky:'unknown', temp:'unknown'};
        const now = {
          asleep, place:a.place, letter:unread ? 'waiting' : 'none', sky:weather.sky, temp:weather.temp,
          doing:(a.activity && (a.activity.detail || a.activity.key)) || 'unknown'
        };
        // What he's busy with on the VPS, in his hand.
        const PROP_FOR = {cooking:'spatula', garden:'wateringcan', writing:'quill', housework:'duster', occult:'wand', pub:'pint', drinking:'pint', fishing:'rod'};
        const detail = a.activity && a.activity.detail;
        runtime.vpsProp = !asleep && detail ? PROP_FOR[detail] || null : null;
        runtime.vpsApron = !asleep && detail === 'cooking';
        // What shows on him.
        show('prop-letter', now.letter === 'waiting' && !asleep && runtime.performanceMode !== 'guitar');
        const brolly = a.place === 'outdoors' && (now.sky === 'rain' || now.sky === 'snow');
        runtime.brollyOut = brolly;
        if (!runtime.floating) show('prop-umbrella-open', brolly);
        if (brolly) show('prop-umbrella', false);
        // His fairy friends are visiting on the VPS: he spends time with them here too,
        // and the local ones if he's away.
        const fairies = a.fairies && a.fairies !== 'none' ? a.fairies : null;
        runtime.fairyRegion = fairies;
        const visitStarted = fairies && (!last || !last.fairies);
        now.fairies = fairies;
        if (visitStarted && !asleep && !runtime.sulk) {
          if (runtime.antic && runtime.antic.type !== 'fairies') runtime.stopAntic('visit');
          if (!runtime.antic) runtime.startAntic('fairies', {region:fairies, duration:(3 + random() * 5) * 60 * 1000});
        }
        if (!last) { last = now; return; }
        const was = last;
        last = now;
        // What he says (first change wins).
        if (was.asleep && !asleep) return say(pick(['……早。', '醒了。茶呢。', '……几点了。', '唔……早上了？', '……我醒了。别吵。', '睡得还行。……你呢？']), true);
        if (!was.asleep && asleep) return say(pick(['我去睡了。你也别熬太晚。', '睡了。……晚安。', '……困了。晚安。', '我先睡了。你也早点。', '晚安。……别熬夜。我是认真的。', '……关灯了。']), true);
        const out = place => ['outdoors','transit'].includes(place);
        if (!out(was.place) && out(now.place)) return say(pick(['我出去一趟。', '出门了。', '出去走走。很快回来。', '……别乱动我的东西。我出门了。', '伞带了。出门。']), true);
        if (now.place === 'hotel' && was.place !== 'hotel') return say('到了，今晚住这儿。', true);
        if (was.place !== 'home' && now.place === 'home') return say(pick(['我回来了。', '到家了。', '……还是家里好。', '回来了。先泡壶茶。', '我回来了。……你还在啊。']), true);
        if (was.letter !== 'waiting' && now.letter === 'waiting') return say('我给你发了消息。……不急，看到再回。', true);
        if (was.sky !== now.sky && (now.sky === 'rain' || now.sky === 'snow')) {
          const snow = now.sky === 'snow';
          return say(a.place === 'outdoors' ? (snow ? '下雪了。……好在带了伞。' : '下雨了。幸好带了伞。') : (snow ? '下雪了。' : '下雨了。'), true);
        }
        if (was.temp !== now.temp && now.temp === 'freezing') return say('冷死了。');
        if (!asleep && was.doing !== now.doing && ACTIVITY_LINES[now.doing] && random() < .35) {
          return say(pick(ACTIVITY_LINES[now.doing]));
        }
      },
      // A waiting message she hasn't marked read on the pet, or null.
      current() { return lastStatus; },
      unreadLetter() {
        const a = lastStatus && lastStatus.arthur;
        if (!a || a.letter !== 'waiting' || !a.letter_id || a.letter_id === readId) return null;
        return a.letter_id;
      },
      markRead(id) {
        readId = id || '';
        if (last && id) last.letter = 'none';
        show('prop-letter', false);
      }
    };
  }
  // The first time she opens the computer each day.
  function greeting(now=new Date()) {
    const h = now.getHours();
    const lines = h >= 5 && h < 11 ? ['早上好。……起这么早，难得。', '早。今天也好好过。', '早上好。先去吃早饭，别直接坐下。']
      : h >= 11 && h < 14 ? ['中午好。吃午饭了吗？', '中午了才开电脑？……午饭呢？', '中午好。今天上午过得怎么样？']
      : h >= 14 && h < 18 ? ['下午好。该喝茶了，你自己去泡。', '下午好。今天过得还行吗？', '下午好。我在这儿，你忙你的。']
      : h >= 18 && h < 23 ? ['晚上好。今天辛苦了。', '晚上好。……我没在等你。随口说的。', '晚上好。晚饭吃了吗？']
      : ['……这么晚才开电脑？', '半夜了。看完就去睡，听见没有。', '你这个点还不睡？……好吧，晚上好。'];
    const lib = global.ArthurIdleChatter;
    const day = lib && lib.holiday ? lib.holiday(now) : null;
    if (day && lib.LINES[day] && Math.random() < .5) return pick(lib.LINES[day]);
    return pick(lines);
  }

  // Shouted after her while she runs off with his things.
  // Sat in a heap after a fall from far too high.
  const HARD_LANDING_LINES = ['……别、别看我。','……别看。我说了别看。','我没事。……真的没事。别看。','……刚才那个不算。','……你看到了？',
    '……绅士偶尔也是会坐在地上的。别看。','腿……麻了。别看我。','……地板怎么这么硬。','我只是……想在这儿坐一会儿。对，就是这样。','咳咳……呜……',
    '……谁把地面放这么低的。','别笑。我听见你在笑了。','……一点都不疼。','我在思考人生。别打扰我。','……当年从桅杆上掉下来都没这么狼狈。',
    '你要是敢截图，我就……别截图。','让我静一静。就一会儿。','你为什么想要这么对待我？把我留在这里就是为了这样吗？'];
  const HARD_LANDING_LATER = ['……还没好。再等一下。','……你到底要羞辱我到什么地步？','……我走不动路了，你满意了吗？满意了？','腿还是麻的。……不许笑。','……起不来。再坐一会儿。'];
  const HARD_LANDING_CRY = ['呜……这是战术性着陆。你不懂。', '走开！不要看！你把我的尊严当作什么了！！', '……没、没哭。是灰尘。','你到底把我当作什么了？玩具？','……我没事。你走开。……别真走。','这是……汗。眼睛出汗而已。','……都怪你。','呜……不对，我没出声。'];
  const HARD_LANDING_CRY_LATER = ['……别看……别看……','……疼。你满意了吧。','@peek','呜……这次真的不算。'];
  const CHASE_SHOUTS = {
    fresh:['还给我！', '站住！', '那是我的！', '别跑！', '……我数到三！', '你给我回来！', '小偷！', '有本事别跑！',
      '我看见了！就在你手上！', '海盗的东西都敢抢？！', '……一、二……', '站住！以女王的名义！', '那个很重要的！', '慢、慢一点！'],
    tired:['呼……还、还给我……', '……站……住……', '你……你跑那么快干什么……', '……我只是……让你一下……', '等……等我喘口气……',
      '……这不公平……你用的是鼠标……', '……不追了。……再追一下。']
  };

  // Trying to make it up to him the wrong way.
  const NOPE = {
    gift:{first:['……不是这个。', '这个不行。', '……你觉得这样就能打发我？', '收下了。但不代表原谅你。', '……不对。再想想。', '哼。礼物不对。'],
      again:['……还是不对。', '你到底有没有在听我说话。', '……送东西也要用心的。', '不是礼物多就行。']},
    pat:{first:['……摸头也没用。', '别以为摸摸头就完了。', '……手拿开。', '我不是小孩子，摸头哄不好。', '@lookaway ……哼。', '这招对我没用。'],
      again:['……我说了，摸头也没用。', '……你是不是只会这一招。', '再摸也是一样的。', '@lookaway']},
    hand:{first:['别碰我的手。', '……戳手也没用。', '手不是这么哄的。', '……哼。'],
      again:['……我说了别碰。', '@hidehands', '戳多少下都一样。']},
    holdhand:{first:['……别握我的手。哼。', '……现在不想牵手。', '@hidehands', '……别以为握握手就算了。'],
      again:['……我说了不要。', '@hidehands', '……哼。手冷也不给你握。']},
    belly:{first:['……别碰我。', '肚子不许摸。……现在不许。', '……走开。', '哼。没用的。'],
      again:['……我说了别碰。', '@turnback', '再摸我就真的生气了。……已经在生气了。']},
    file:{first:['……现在没心情看。', '不看。', '……放着吧。等我气消了再说。', '你的文件我以后再看。现在不想。'],
      again:['……说了不看。', '给我看再多也没用。', '@ignore']},
    outfit:{first:['换衣服也没用。', '……这件不对。', '你以为换件衣服我就会高兴？', '……哼。穿就穿。'],
      again:['……还是不对。', '换来换去，你在玩换装游戏吗。', '……衣服不是问题。']},
    away:{first:['……哼。', '走就走。', '……我会自己回来的。到时候再说。'],
      again:['……哼。', '又让我走？']}
  };

  // Jolted in his sleep: half a word, and back off he goes.
  const SLEEP_STIR = ['……嗯……？', '……谁……', '……地震了？……', '……别闹……', '……唔。', '……几点了……', '……再五分钟……', '……什么……zzz'];
  // Things he mutters in his sleep.
  const SLEEP_TALK = ['……司康……烤好了……', '……弗朗西斯……你这混蛋……', '……茶……放下……', '……阿尔……别哭了……', '……薄荷兔……别跑……',
    '……论文……重写……', '……升帆……', '……Rule……Britannia……', '……威利斯……别抢……', '……我才没有……', '……唔……玫瑰……', '……还……还给我……'];

  // The little parts of him.
  const PART_LINES = {
    sneeze:['……肯定是你在说我坏话。', '阿嚏——！……你故意的。', '……鼻子痒。都怪你。'],
    nose:['……别碰鼻子。', '鼻子不是按钮。', '……嗯？'],
    brow:['……眉毛也不许戳。', '我的眉毛怎么了？！', '……又是眉毛。'],
    browRub:['……不许碰我的眉毛。', '你、你把我眉毛弄乱了！', '……我的眉毛有什么好玩的。'],
    ear:['……耳朵很敏感的。', '别碰耳朵。', '……折着的，天生的。别研究了。'],
    ahoge:['……那撮头发是天生的，别管它。', '它自己会翘回来的。'],
    ahogeCover:['……别弹了。', '再弹就秃了。'],
    collar:['……嗯。还算有眼光。', '帮我整理领子？……谢谢。', '……这样确实好多了。'],
    collarMessed:['喂，扯歪了！', '……你是来帮倒忙的吗。', '我自己来。'],
    hat:['我的帽子！', '……帽子歪了。', '喂！'],
    hatAgain:['……再碰帽子试试。', '你跟我的帽子有仇吗。', '@glare']
  };
  // Held by an ear.
  const EAR_GRIP = ['疼疼疼，耳朵不是把手！', '耳朵！耳朵要掉了！', '……放开耳朵我就跟你走。', '呜！！松手！放开啊！'];

  // Picked up by...
  const GRIP_LINES = {
    chest:['你揪着我衣领想干什么！要打架吗！', '……放手！衬衫要被你扯坏了！', '有话好好说！别揪领子！', '你这是在找我决斗吗？！', '……我的领巾！！', '这种拎法……是对付醉汉的吧！'],
    head:['我的头发！！', '别抓头！发型！我的发型！', '喂！头不是把手！', '……你知道我早上花了多久整理头发吗。'],
    'hand-left':['你、你要牵我去哪儿？', '……拉手就拉手，干嘛拎起来。', '胳膊要掉了！', '……这算牵手吗。不算。'],
    'hand-right':['你、你要牵我去哪儿？', '……拉手就拉手，干嘛拎起来。', '胳膊要掉了！', '……这算牵手吗。不算。'],
    'ear-left':EAR_GRIP, 'ear-right':EAR_GRIP,
    'foot-left':['别拽脚！我又不是被倒提的鸡！', '血、血都冲到头上了！', '我的鞋！要掉了！', '……世界是倒着的。放我下来。'],
    'foot-right':['别拽脚！我又不是被倒提的鸡！', '血、血都冲到头上了！', '我的鞋！要掉了！', '……世界是倒着的。放我下来。']
  };
  // How she moves him about while holding him.
  const DRAG_MOTION = {
    stroll:['……散步？……行吧。', '我们这是去哪儿？', '……这个速度还可以接受。', '嗯。风景不错。', '就当是坐轿子了。'],
    shake:['别、别晃！！', '我要吐了——！', '你在摇调酒壶吗！', '停停停停停！！'],
    spin:['哇啊啊啊——别转了！！', '转、转晕了……！', '我不是陀螺！！', '呕……呕，咳咳咳……'],
    scrape:['我自己会走！', '我的鞋底！！', '别拖！！放开我！！！', '……这样很不体面，你知道吗。']
  };
  // Where she put him down.
  const SET_DOWN = {
    window:['……这上面？我自己可下不去。', '……把我放这么高干什么。', '嗯。视野不错。……下来的时候你负责。'],
    corner:['……角落。挺好。我本来就想待在这儿。', '……你是在罚我站墙角吗。', '……这里安静。'],
    same:['……拎我一圈，就为了放回原地？', '……所以刚才那是在干什么。', '……我又回来了。嗯。']
  };

  // When giving in comes out as tears.
  const CRYING = {
    held:['……呜……放、放我下来……', '我、我才没有哭……！是灰尘……', '……呜。你、你欺负人……', '……求你了……',
      '……你为什么要这样……你很讨厌我，是吗？', '……要是那么讨厌我……为什么要把我留在你的电脑上……', '……我认输了……所以……呜……'],
    still:['……呜……', '……呜……别看我……', '……别、别看……', '……我没哭。', '……我到底做错了什么……'],
    down:['……别看。我没哭。', '……刚才是沙子进眼睛了。', '……你满意了吧。……呜。',
      '……这件事不许告诉任何人。', '……我没事。给我一分钟。']
  };

  // Swung about low down: he can't decide whether he likes it.
  const LOW_LIFT = {
    first:['……你在跟我玩吗？', '嘿……', '这是什么，荡秋千？', '……还挺好玩。我什么都没说。', '哦？', '……离地两寸。嗯。',
      '这个高度……还可以接受。', '你这是在帮我活动筋骨吗。'],
    again:['又来？', '……我不该觉得这个好玩的。', '再高一点点也行。……我随便说说。', '这次轻一点。', '……你今天很闲嘛。',
      '往左边。……我在说什么啊。', '嗯哼。', '……我只是配合你而已。']
  };
  const LOW_DOWN = {
    first:['……还要再来？', '嗯。还行。', '……就这？', '落地。', '……还可以。', '……有点好玩。我怎么会觉得这个好玩。'],
    again:['……结束了？', '你的手不累吗。', '嗯。今天就到这儿吧。……除非你还想。', '……结束了？', '……哼。还行吧。', '好了好了，玩够了吧。']
  };
  // Going up and up: not sure yet what's happening.
  const RISING = ['哎、哎？往上去了……', '等等，你要把我带到哪儿去？', '……喂，越来越高了。', '我、我还以为只是抱一下……',
    '这已经不是"抱一下"的高度了吧。', '……停。停一下。', '喂喂喂——', '我们……这是要去哪儿？', '你是不是举错方向了。', '……地面离我越来越远了。'];
  const TOO_HIGH = {
    tricked:['哇啊啊啊！', '等、等等等——太高了！！', '你骗我！！', '说好的只是玩玩呢！！', '不、不是这个高度！！', '我信错人了！！'],
    plain:['太、太高了！放我下来！', '别往上了！', '我、我不怕高。我只是……放我下来！', '……这个高度不在我们的约定里。', '够了，够高了！', '太高了，我头晕。放我下来。']
  };
  const DOWN_AT_LAST = {
    pleaded:['……吓死我了。……我说话算话，这次不跟你计较。', '……呼。说好的，不计较。下不为例。', '……答应你的事我会做到。不计较。……但我记着。',
      '……好吧。不计较。脚、脚有点软。', '……我刚才说的话，你就当没听见……呕咳咳咳……'],
    plain:['……吓死我了。', '……总算放下来了。', '下次别举那么久。……我没怕。', '……地面。我亲爱的地面。', '呼……刚才那个不算害怕。', '……再来我就咬你。']
  };

  // Hauled up by the tail: it hurts, and he says so.
  const HELD_BY_TAIL = ['不要抓着那里！好痛！', '尾巴！尾巴要断了！', '放开尾巴！拎哪儿都行，别拎尾巴！', '好痛好痛好痛——！',
    '……这个真的很痛，你知道吗！', '求你换个地方抓！', '尾巴不是绳子！'];
  const HELD_BY_TAIL_SCARED = ['……好痛……放开……', '不、不要……尾巴……', '……我会乖的……先放开尾巴……', '……呜……真的好痛……'];
  // Dangling by the tail there's no dignity left to save: no telling himself it's
  // a sedan chair or a stroll. Every moment of it is just fear and pain.
  const TAIL_FEAR = {
    rising:['不、不要往上……！尾巴……！', '好高……尾巴好痛……放我下来……', '别、别再举高了……求你……', '……要掉下去了……尾巴要断了……'],
    lowering:['慢、慢点……别松手……', '……对……放下来……求你……', '……快到了吗……尾巴……'],
    high:['好高……！不要……！', '……我、我不敢往下看……', '求你……别松手……也别再举了……', '……尾巴撑不住的……！'],
    low:['……放、放开尾巴……', '好痛……就差一点了……放我下来……', '……求你了，先放开尾巴……'],
    plead:['……求你……放开尾巴……', '我什么都答应你……先放开……', '……呜……好痛……真的好痛……', '……我错了……放我下来……'],
    stroll:['别、别走了……尾巴好痛……', '……晃得好痛……停下……', '去哪儿都行……先放开尾巴……', '……每走一步都好痛……'],
    shake:['啊啊啊——尾巴！！', '别晃！！尾巴要断了！！', '好痛好痛——停下！！'],
    spin:['尾巴要扭断了——！！', '别转——好痛——！！', '呜啊啊——停下——！！'],
    scrape:['放、放我下来……求你……', '……好痛……别拖了……'],
    yoyo:['别、别……尾巴……！', '……求求你……别晃了……', '……呜……好痛……']
  };

  // Kept dangling not far off the ground: more mortifying than frightening.
  const HELD_LOW_MORTIFIED = [
    '放我下来！这样被人看见多丢人！', '……我的脚都快碰到地了，你到底想怎样。', '这个高度……连吓人都算不上，只是丢人。',
    '你这样拎着我，像拎一只猫。……我不是猫。', '要是被弗朗西斯看到，我这辈子都别想抬头了。', '……周围有没有人？没有吧？',
    '我是一个有尊严的国家！不是你的挂件！', '至少……至少换个体面点的姿势！', '……我脸都要丢光了。', '你再不放手，我就当没认识过你。',
    '……被这么拎着，我还不如去当晾衣架。', '别人看了会以为我是什么钥匙扣！', '我的形象……我几百年的形象……',
    '……地板就在那儿，你就不能把我放上去吗。', '这个姿势一点都不英国。', '放下！在我决定装作不认识你之前！',
    '……我宁愿你把我扔出去。不，收回。别扔。', '如果有人拍照，我就……我就移民。', '低一点也是悬空！悬空就是丢人！',
    '我的尾巴都没地方放了。'
  ];

  // Kept up in the air too long, first stage: cross, not scared yet.
  const HELD_ANGRY = [
    '够了没有！放我下来！', '你这个混蛋，听见没有！', '我数到三。一、二……我是认真的！', '你给我等着，我落地第一件事就是找你算账。',
    '我会诅咒你的。真的会。黑魔法，听说过吗？', '放手！你这个不知礼数的家伙！', '……bloody hell，你到底想怎样！', '我要让你今晚的茶全变成咖啡。',
    '你再不放，我就把你的论文批注全写成拉丁文。', '我当过海盗的！你知道海盗是怎么对付人质的吗！', '这是对一个国家的侮辱！', '我活了几百年，没受过这种气！',
    '你以为我不敢咬你吗！', '小心我叫妖精们半夜去掐你脚趾。', '放我下来，git！', '你有本事一直举着！看谁先累！',
    '我的耐心是有限的。……已经快没了。', '要是弗朗西斯在这儿，他会笑死的。所以快放我下来！',
    '你知道我是谁吗！我可是——放、放我下来再说！', '这笔账我会记一百年。我活得够久，记得住。', '我要给你的导师写信。',
    '你的手不酸吗？！我替你酸！', '……我在心里已经骂了你十七句了。', '放下！不然今年圣诞节你什么都收不到！',
    '我下来以后，你的司康就没有了。一块都没有。', '你这是绑架！我要叫苏格兰场！', '我数过了，这是你今天第……第……次这么对我。……大概！总之你过分了。',
    '再不放手，我就把你的拖鞋扔进泰晤士河。', '……你笑什么！我看到你在笑了！', '我的血压！我的血压在上升！',
    '好，很好。你就举着吧。我不说话了。……放我下来！', '你给我记住，大英帝国是有记性的！', '我的领带！你看你把我的领带弄歪了！',
    '我诅咒你今晚的 Wi-Fi 一直断。', '……一个绅士被这么对待，简直闻所未闻。', '你以为挂久了我就会求饶？做梦！',
    '我要在日记里写你坏话。写三页。', '我和弗朗西斯打架打得最厉害的时候也没这样！'
  ];

  // Things he says about what just happened on the desktop.
  function makeLines(speech) {
    return {
      // Picked up, thrown, put down: something different most times.
      pickedUp() {
        const now = Date.now();
        if (now - (this._pickedAt || 0) < 15000 || Math.random() > .75) return;
        this._pickedAt = now;
        speech.say(pick(['喂！你不能这么对待一名绅士！', '放我下来！', '我不是行李！', '……你的手往哪儿放呢。', '这很不体面，你知道吗。',
          '我活了几百年，从来没人敢这么拎我。', '小心我的尾巴！', '……好吧，就一会儿。', '我自己会走！', '别晃！我会晕的。',
          '你要带我去哪儿？', '要是被弗朗西斯看见，我就完了。', '这是绑架。', '放手，不然我……我诅咒你……你！……不对，你只是普通人而已，得换一个……', '轻点！我不是布娃娃！']), 3500);
      },
      // Down after that: dazed and crying on the floor, then gone for a long while.
      traumaLanding() {
        const t = this._trauma;
        if (!t || Date.now() - t.at > 8000) return false;
        this._trauma = null;
        const rt = this.runtime;
        noteCrime('thrown');
        rt.knock('splat');
        rt.lyingTearsUntil = performance.now() + 9000;
        const k = rt.knockout;
        const wait = k ? Math.max(0, k.holdUntil + k.getUpMs - performance.now()) : 5000;
        global.setTimeout(() => speech.say(pick(['……呜……', '……好痛……', '……呜……为什么……']), 3000, {force:true}), 900);
        global.setTimeout(() => {
          if (this.grudge) this.grudge.start({runOff:true, cause:'thrown', awayMs:(10 + Math.random() * 15) * 60 * 1000,
            line:pick(['……我走了。别找我。', '……我想一个人待一会儿。', '你明明知道我会害怕的。', '……我出去走走。不用等我。'])});
        }, wait + 900);
        return true;
      },
      thrown() {
        if (this.runtime && this.runtime.state === 'sleep') return;   // he didn't even notice
        if (this.traumaLanding()) return;
        noteCrime('thrown');
        if (this.grudge && this.grudge.provoked('thrown')) return;   // cross already, or only just made up
        if (Date.now() - (this._dropSaid || 0) < 2500) return;
        speech.say(pick(['……你是想谋杀我吗。', '你把我当什么了！！飞盘吗？！', '我的头发……！', '再来一次，你的论文就退回去重写。',
          '你这是对待国家的态度吗！', '我的茶都要洒了！……我没拿茶。但还是！', '哪有这样扔人的！', '下次我扔你试试！', '我要写信投诉。',
          '……我的骨头都要散架了。', '这不是板球比赛！', '要是阿尔弗雷德那小子敢这么对我，我现在就已经动手了……', '你、你给我等着！', '……我看见我的人生在眼前闪过了。']));
      },
      // How high she's lifted him (in his own heights), several times a second.
      // Low: he thinks it's a game. High: frightened. A few low goes and then a
      // sudden big one: he really jumps.
      lifted(level, seconds=0) {
        const now = Date.now();
        const d = this._drag || (this._drag = {said:{}, scared:false, airborneSince:null,
          angryAt:10 + Math.random() * 5, lastLevel:level, steadySince:seconds});
        if (d.worryAt == null) { d.worryAt = d.angryAt + 15 + Math.random() * 6; d.pleadAt = d.worryAt + 16 + Math.random() * 8; }
        this._plays = (this._plays || []).filter(t => now - t < 120000);
        // Held up in the air a long time: first angry (and talking the most),
        // then frightened (tail tucked), then pleading, then limp.
        if (level >= .6) { if (d.airborneSince == null) d.airborneSince = seconds; } else d.airborneSince = null;
        const aloft = d.airborneSince == null ? 0 : seconds - d.airborneSince;
        // Low down (the lower half of the screen) it's more embarrassing than
        // frightening: the cross, mortified stretch lasts a good deal longer
        // before fear sets in. Higher up, the usual pace.
        const tick = d.lastSec == null ? 0 : Math.max(0, seconds - d.lastSec);
        d.lastSec = seconds;
        d.low = level < 2.0;
        // By the tail it hurts: fear comes on fast, wherever he is.
        d.byTail = this.runtime.gripZone && this.runtime.gripZone() === 'tail';
        if (d.byTail && !d.tailTimed) { d.tailTimed = true; d.angryAt = Math.min(d.angryAt, 2 + Math.random() * 2); }
        if (d.airborneSince == null) d.fear = 0; else d.fear = (d.fear || 0) + tick * (d.byTail ? 2.6 : d.low ? .45 : 1);
        this.runtime.worried = d.fear > d.worryAt;
        this.runtime.pleading = d.fear > d.pleadAt;
        this.runtime.heldAngry = aloft > d.angryAt && !this.runtime.worried;
        if (d.fear > d.pleadAt && !d.said.plead) {
          d.said.plead = true; d.pleaded = true;
          this.runtime.resigned = true;            // stops struggling once he's begged
          // Now and then, giving in comes out as tears.
          if (Math.random() < (d.byTail ? .65 : .3) && this.runtime.cry) {
            d.cried = true;
            this.runtime.cry(60000);                // until he's put down
            speech.say(pick(CRYING.held), 4500);
            return;
          }
          speech.say(pick(d.byTail ? TAIL_FEAR.plead : ['你赶紧把我放下来好吗。', '如果现在放下，我不会跟你计较任何事情。真的。', '……好了，我认输。放我下来。', '我、我们好好谈谈。先放我下来。']), 4500);
          return;
        }
        if (d.cried && now - (d.criedSaidAt || 0) > 9000 && Math.random() < .08) {
          d.criedSaidAt = now;
          speech.say(pick(CRYING.still), 3000);
          return;
        }
        if (d.fear > d.worryAt && !d.said.worry) {
          d.said.worry = true;
          speech.say(pick(d.byTail ? HELD_BY_TAIL_SCARED : ['……你不要这样。', '你、你怎么了？', '……你想对我做什么？', '喂……你一直举着我做什么？']), 3500);
          return;
        }
        // The angry stretch: threats and swearing, one after another.
        if (this.runtime.heldAngry && now - (d.angrySaidAt || 0) > (d.low ? 6500 : 4500) + Math.random() * 2500) {
          d.angrySaidAt = now;
          // The shared picker avoids anything said recently, across drags too.
          const line = pick(d.byTail ? HELD_BY_TAIL : d.low && Math.random() < .55 ? HELD_LOW_MORTIFIED : HELD_ANGRY);
          speech.say(line, 3600);
          return;
        }
        // Up, down, up, down: being yo-yoed. What he makes of it depends on
        // how far gone he already is.
        if (d.yoDir == null) { d.yoDir = 0; d.yoMin = d.yoMax = level; d.yoHalves = 0; }
        if (d.yoDir === 0) {
          d.yoMin = Math.min(d.yoMin, level); d.yoMax = Math.max(d.yoMax, level);
          if (level > d.yoMin + .5) { d.yoDir = 1; d.yoExt = level; }
          else if (level < d.yoMax - .5) { d.yoDir = -1; d.yoExt = level; }
        } else if (d.yoDir > 0) {
          if (level > d.yoExt) d.yoExt = level;
          else if (level < d.yoExt - .5) { d.yoDir = -1; d.yoHalves++; d.yoExt = level; }
        } else {
          if (level < d.yoExt) d.yoExt = level;
          else if (level > d.yoExt + .5) { d.yoDir = 1; d.yoHalves++; d.yoExt = level; }
        }
        const yoyos = Math.floor(d.yoHalves / 2);
        if (yoyos >= 2 && yoyos !== d.yoSaid && (yoyos === 2 || yoyos % 3 === 2) && now - (d.yoSaidAt || 0) > 3000) {
          d.yoSaid = yoyos; d.yoSaidAt = now;
          const stage = this.runtime.pleading ? 'limp' : this.runtime.worried ? 'scared' : this.runtime.heldAngry ? 'angry' : 'early';
          const many = yoyos >= 5;
          const LINES = {
            early: many ? ['你、你玩够了没有！', '我说了别晃！……头好晕。', '我不是溜溜球！！'] : ['……你在干什么？', '上、上、下、下……你这是在拿我玩游戏吗？', '喂，别晃了！'],
            angry: many ? ['你这个混蛋！！我要吐在你手上了！', '我发誓，等我下来——呕——等我下来！', '够了！！！'] : ['你当我是溜溜球吗！', '再晃一下试试！', '我是一个国家！不是电梯！'],
            scared: many ? ['不、不要了……我真的要吐了……', '求、求你别晃了……', '……我、我错了还不行吗……'] : ['别、别……！我要掉下去了！', '哇、哇啊……停下……！', '你别吓我……！'],
            limp: many ? ['……………………', '……随便你吧……', '……世界在转……'] : ['……嗯……', '……呜。', '……晕……']
          };
          if (stage === 'scared' || (stage === 'early' && many)) this.runtime.squeezeUntil = performance.now() + 1200;
          speech.say(pick(d.byTail ? TAIL_FEAR.yoyo : LINES[stage]), 3000);
          d.lastLevel = level; d.lastT = seconds;
          return;
        }
        // Coming down: gently is good; fast at the floor is not.
        const dt = d.lastT == null ? 0 : seconds - d.lastT;
        const rate = dt > 0 ? (level - d.lastLevel) / dt : 0;      // his heights per second
        d.lastT = seconds;
        if (rate < -5 && level < 1.4 && d.lastLevel > 1.2 && now - (this._slamAt || 0) > 4000) {
          this._slamAt = now;
          this.runtime.squeezeUntil = performance.now() + 1300;
          speech.say(pick(['啊啊啊啊——！！', '哇啊——！！', '等等等等——啊！！', '要撞上了——！！', '——！！！']), 2200);
          d.lastLevel = level;
          return;
        }
        if (rate < -.12 && rate > -1.6 && d.lastLevel > .8) {
          d.lowerFor = (d.lowerFor || 0) + dt;
          if (d.lowerFor > .75 && !d.said.lowering) {
            d.said.lowering = true;
            speech.say(pick(d.byTail ? TAIL_FEAR.lowering : ['对、对了……就这样……慢慢的……', '对，就这样，慢一点……', '……嗯，这才像话。慢慢放。', '好、好……就这样……别松手……']), 3200);
            d.lastLevel = level;
            return;
          }
        } else if (rate > -.05) d.lowerFor = 0;
        // Going up: he can't tell yet what this is, so he says so.
        const rising = level - d.lastLevel > .12;
        if (Math.abs(level - d.lastLevel) > .12) d.steadySince = seconds;
        d.lastLevel = level;
        if (rising && level > .9 && !d.said.rising) {
          d.said.rising = true;
          speech.say(pick(d.byTail ? TAIL_FEAR.rising : RISING), 3000);
          return;
        }
        // Only once the height has settled (about a second) does he make up his mind.
        const steady = seconds - d.steadySince >= 1.0;
        if (!steady) return;
        if (level >= 2.4 && !d.said.high) {
          d.said.high = true;
          d.scared = true;
          this.runtime.scaredHigh = true;
          if (this._plays.length >= 2) {
            if (typeof this.runtime.startleFromPoke === 'function') this.runtime.startleFromPoke({duration:1400});
            speech.say(pick(d.byTail ? TAIL_FEAR.high : TOO_HIGH.tricked), 3000);
          } else {
            speech.say(pick(d.byTail ? TAIL_FEAR.high : TOO_HIGH.plain), 3000);
          }
        } else if (level < .6 && !d.said.low && !d.scared && now - (this._lowSaidAt || 0) > 25000 && Math.random() < .5) {
          this._lowSaidAt = now;
          d.said.low = true;
          speech.say(pick(d.byTail ? TAIL_FEAR.low : this._plays.length >= 2 ? LOW_LIFT.again : LOW_LIFT.first), 2500);
        }
      },
      dropped(maxLevel, hard, seconds=0) {
        const now = Date.now();
        const d = this._drag || {said:{}};
        this._drag = null;
        this.runtime.strollUntil = 0; this.runtime.scrapeUntil = 0;
        // Spun round or shaken about: the room keeps going once he's down.
        if (((d.spins || 0) >= 1 || (d.shakes || 0) >= 2) && this.runtime.knock && !hard) {
          this.runtime.knock('dizzy');
          this._dropSaid = now + 1500;
          global.setTimeout(() => speech.say(pick(d.spins ? ['……世界……在转……', '转、转晕了……谁把地板弄歪了……', '……我要吐了。别、别过来。']
            : ['……脑子都被你晃匀了。', '……眼前全是星星。', '晃什么晃……我是调酒壶吗。'])), 1600);
        }
        // Up and straight back down in a blink: barely worth a word.
        if (seconds > 0 && seconds < .7 && maxLevel < 1 && !hard && !d.said.worry) {
          if (Math.random() < .3) speech.say(pick(['……？', '……嗯？', '刚才那是什么。']), 1800);
          this._dropSaid = now;
          return;
        }
        // Yo-yoed a lot: the room keeps spinning once he's down.
        if (Math.floor((d.yoHalves || 0) / 2) >= 4 && this.runtime.knock) {
          this.runtime.knock('dizzy');
          this._dropSaid = now + 1500;
          global.setTimeout(() => speech.say(pick(['……地面在晃。不是我在晃。', '我……先坐一会儿。', '呕……我没事。……别过来。', '……你今晚别想睡安稳觉。'])), 1800);
        }
        this.runtime.worried = false;
        this.runtime.resigned = false;
        this.runtime.scaredHigh = false;
        this.runtime.heldAngry = false;
        this.runtime.pleading = false;
        if (hard && d.said && d.said.worry) {
          // Held up there till he was frightened, then flung: the landing will hurt more than his head.
          this._trauma = {at:now, cried:!!d.cried};
          if (this.runtime.cryUntil) this.runtime.cryUntil = 0;
          return;
        }
        if (d.cried) {
          // Put down still in tears: he keeps his face hidden a little longer.
          this.runtime.cryUntil = performance.now() + 3500 + Math.random() * 2000;
          this._dropSaid = now + 1500;
          global.setTimeout(() => speech.say(pick(CRYING.down), 4500), 700);
          return;
        }
        if (d.said && d.said.worry) {
          // Back on solid ground after being held up there too long.
          this._dropSaid = now + 1200;
          global.setTimeout(() => speech.say(d.pleaded
            ? pick(DOWN_AT_LAST.pleaded)
            : pick(DOWN_AT_LAST.plain), 4500), 600);
          return;
        }
        if (d.angrySaidAt) {
          // Put down while still angry: not frightened, just furious.
          this._dropSaid = now + 1200;
          global.setTimeout(() => speech.say(pick(['哼。算你识相。', '……这笔账我记下了。', '早该放了。下次再这样，我真的会诅咒你。', '哼！'])), 600);
          return;
        }
        this._plays = (this._plays || []).filter(t => now - t < 120000);
        if (maxLevel < .6) {
          this._plays.push(now);
          if (now - (this._lowSaidAt || 0) > 25000 && Math.random() < .45) {
            this._lowSaidAt = now;
            speech.say(pick(this._plays.length >= 3 ? LOW_DOWN.again : LOW_DOWN.first), 3000);
          }
          this._dropSaid = now;
        } else if (maxLevel >= 2.4 && this._plays.length >= 2) {
          this._plays = [];
          global.setTimeout(() => speech.say(pick(['你、你骗我！我还以为你在跟我玩！', '……心脏都要跳出来了。你给我等着。', '你这是谋杀！我以为我们在玩！']), 4500), 900);
          this._dropSaid = now + 900;
        }
      },
      setDown(kind) {
        if (Date.now() - (this._dropSaid || 0) < 2500) return;
        const special = SET_DOWN[kind];
        if (special && Math.random() < .5) { speech.say(pick(special), 3500); return; }
        if (Math.random() > .3) return;
        speech.say(pick(['……谢谢你没扔我。', '下次轻点。', '嗯。还算有礼貌。', '终于脚踏实地了。', '……这儿？行吧。']), 3500);
      },
      // How she's moving him about while she holds him.
      dragMotion(kind) {
        const rt = this.runtime, d = this._drag || (this._drag = {said:{}, scared:false, airborneSince:null, angryAt:10 + Math.random() * 5, lastLevel:0, steadySince:0});
        const now = Date.now();
        if (kind === 'stroll') { rt.strollUntil = performance.now() + 1600; }
        if (kind === 'scrape') { rt.scrapeUntil = performance.now() + 1200; }
        if (kind === 'shake') d.shakes = (d.shakes || 0) + 1;
        if (kind === 'spin') d.spins = (d.spins || 0) + 1;
        if (now - (d.motionSaidAt || 0) < 4500 || (rt.worried && kind === 'stroll')) return;
        d.motionSaidAt = now;
        const byTail = rt.gripZone && rt.gripZone() === 'tail';
        const pool = byTail ? TAIL_FEAR[kind] : DRAG_MOTION[kind];
        if (pool) speech.say(pick(pool), 2800);
      },
      knocked(runtime, level, quiet) {
        if (runtime.state !== 'sleep' && this.traumaLanding()) return;
        // Asleep: no bump on the head, no grudge; he barely wakes.
        if (runtime.state === 'sleep') {
          runtime.stir && runtime.stir(3000);
          if (!quiet) speech.say(pick(SLEEP_STIR), 2600, {asleep:true});
          return;
        }
        runtime.knock(level);
        if (quiet) return;
        // Already cross with her (or only just made up): being knocked about again counts.
        if (this.grudge && (this.grudge.active() || this.grudge.wary('thrown'))) {
          const k = runtime.knockout;
          const wait = level === 'splat' && k ? Math.max(0, k.holdUntil + k.getUpMs - (global.performance ? performance.now() : Date.now())) : 1500;
          global.setTimeout(() => this.grudge && this.grudge.provoked('thrown'), wait + 200);
          return;
        }
        const sulks = this.grudge ? this.grudge.hit(level) : false;
        if (level === 'splat') {
          const k = runtime.knockout;
          const wait = k ? Math.max(0, k.holdUntil + k.getUpMs - (global.performance ? performance.now() : Date.now())) : 5000;
          global.setTimeout(() => {
            if (sulks && this.grudge) this.grudge.start({cause:'thrown'});
            else speech.say(pick(['……我没事。真的。', '谁……谁把我扔出去的。', '我看见了好多星星。还有薄荷兔。', '绅士……是不会……趴在地上的……']));
          }, wait + 200);
        } else if (sulks && this.grudge) {
          global.setTimeout(() => this.grudge.start({cause:'thrown'}), 1500);
        } else {
          speech.say(pick(['……天旋地转。', '哎哟。墙是硬的！你不知道吗？！', '眼前有星星……']), 4000);
        }
      },
      returned() {
        if (this.grudge && this.grudge.cameBack()) return;
        speech.say(pick(['我回来了。别以为我是想你了。', '时间到了。……你没趁我不在偷懒吧？', '嗯。我回来了。', '走开一会儿也好，茶都凉了。']));
      }
    };
  }

  // Touching his body: at first he's not having it (snaps, hurries off); after
  // enough times he stops running; in the end he rather likes it. The count is
  // kept by the native app, so he remembers across restarts.
  // Counted per day: every morning he's back to not having it, and only gives
  // in after enough of them that day. Stored as day*1000+count so the app's
  // integer slot keeps it across restarts.
  const TOUCH_SHY = 6, TOUCH_FOND = 14;
  const localDay = () => Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);
  let touchCount = 0, touchDay = 0, lastTouchAt = 0, touchHost = null, touchSpeech = null;
  // Head pats: he gets used to them too (count kept by the app), and the hour,
  // and how many he's had today, colour what he says.
  const PAT_LINES = {
    shy:['……你在干什么。', '别摸我的头！我不是小孩子！', '我的发型！', '这、这算什么……', '你把我当成猫了吗？', '放手。……我说放手。',
      '哪有人随便摸国家的头的。', '……哼。', '我活了几百年，可没被人这么摸过。', '别、别得寸进尺。'],
    used:['……就一会儿。', '你还真是摸不腻。', '头发要被你弄乱了。', '……我不该喜欢这个的。不该。', '随你吧。',
      '怎……怎么了？我是不会说喜欢的，所以你赶紧松手。', '不要像摸猫一样摸我的头，松手。', '下不为例。', '……你是不是把这当成每日任务了。', '好吧，好吧。'],
    fond:['……嗯。', '再一下。……就一下。', '被你摸习惯了。真是的。', '……我当然不喜欢！当然！', '你今天也辛苦了。',
      '要是被弗朗西斯看到，我就说是你强迫我的。', '……谢谢。', '你……到底把我当作什么了，真是的。', '……别跟别人说。', '你的手放这儿，刚刚好。'],
    morning:['大早上的……好吧，早安。', '一早就来摸我头？……行吧。'],
    night:['这么晚了还来摸我。……快去睡。', '……你也困了吧。摸完就去睡。'],
    many:['今天第几次了？……我没数。好吧，我数了。', '你今天是不是摸太多了？', '再摸下去，头发都要被你摸秃了。']
  };
  const PAT_SHY = 8, PAT_FOND = 25;
  let patCount = 0, patHost = null, patSpeech = null, patsToday = {day:'', n:0};
  function headPatted(runtime) {
    if (!patSpeech || (runtime.grudge && runtime.grudge.active())) return;
    patCount += 1;
    if (patHost) patHost.post({type:'pat-count', n:patCount});
    const day = new Date().toDateString();
    if (patsToday.day !== day) patsToday = {day, n:0};
    patsToday.n += 1;
    if (Math.random() > .65) return;          // not every pat needs a remark
    const h = new Date().getHours();
    const stage = patCount < PAT_SHY ? 'shy' : patCount < PAT_FOND ? 'used' : 'fond';
    let pool = PAT_LINES[stage];
    if (stage !== 'shy') {
      if (patsToday.n >= 6 && Math.random() < .35) pool = PAT_LINES.many;
      else if ((h >= 23 || h < 5) && Math.random() < .35) pool = PAT_LINES.night;
      else if (h >= 6 && h < 10 && Math.random() < .3) pool = PAT_LINES.morning;
    }
    patSpeech.say(pick(pool), 4000);
  }

  // A single poke somewhere: now and then he has something to say about it.
  const POKE_LINES = {
    face:['别戳我的脸！', '我的脸不是面团！', '……你很闲吗？', '鼻子！别碰鼻子！', '喂！', '……嗯？干什么？', '戳脸是很失礼的行为。', '你再戳一下试试。', '我的眉毛也不许碰。', '……幼稚。'],
    hand:['嗯？手怎么了？', '别戳我的手。', '我的手很忙的。', '……要握手就好好握。', '怎么，手冷？', '……干嘛。', '一下就够了。', '你拍我的手是想要什么？', '……好吧，击个掌。', '手不是用来戳的。'],
    foot:['别碰我的脚！', '我的鞋！', '脚不许碰。', '……你蹲在那儿干什么？', '痒！', '别挠我脚！', '我站得好好的。', '这是对绅士的鞋子的不尊重。', '……你在找什么？', '我的鞋带没松。'],
    tail:['尾巴不许碰！！', '……那不是尾巴。我没有尾巴。', '喂！！', '别抓！', '炸毛了！你看你干的好事！', '你再碰我的尾巴，我就……我就……', '尾巴是很敏感的，你知道吗。', '……别、别摸。', '那是装饰！', '……哼！']
  };
  let lastPokeLineAt = 0;
  function pokeLine(zone, speech) {
    const kind = zone === 'hand-left' || zone === 'hand-right' ? 'hand' : zone === 'foot-left' || zone === 'foot-right' ? 'foot' : zone;
    if (!POKE_LINES[kind] || Date.now() - lastPokeLineAt < 6000 || Math.random() > (kind === 'tail' ? .35 : .3)) return;
    const rtTail = global.ArthurDesktopCompanion && global.ArthurDesktopCompanion.runtime;
    if (kind === 'tail' && rtTail) {
      if (Date.now() - (rtTail._tailSaidAt || 0) < 15000) return;   // shares the tail's quiet spell
      rtTail._tailSaidAt = Date.now();
    }
    lastPokeLineAt = Date.now();
    speech.say(pick(POKE_LINES[kind]), 3000);
  }

  // A click on his belly is a jab, and nobody likes that, however used to you he is.
  let lastJabAt = 0;
  function bellyJab(runtime) {
    const now = Date.now();
    if (!touchSpeech || runtime.state === 'sleep' || runtime.sleepSequence || now - lastJabAt < 1500) return;
    lastJabAt = now;
    noteCrime('jabs');
    if (typeof runtime.startleFromPoke === 'function') runtime.startleFromPoke({duration:900});
    touchSpeech.say(pick(['嗷！别戳我肚子！', '很痛的！', '你戳哪儿呢！', '……你是想打架吗。', '喂！肚子不是按钮！']), 3000);
  }

  function bodyTouch(runtime) {
    const now = Date.now();
    if (!touchSpeech || runtime.state === 'sleep' || runtime.sleepSequence) return false;
    if (now - lastTouchAt < 2500) return false;          // one stroke session counts once
    lastTouchAt = now;
    if (touchDay !== localDay()) { touchDay = localDay(); touchCount = 0; }
    touchCount += 1;
    if (touchHost) touchHost.post({type:'touch-count', n:touchDay * 1000 + touchCount});
    if (touchCount < TOUCH_SHY) {
      if (typeof runtime.startleFromPoke === 'function') runtime.startleFromPoke({duration:900});
      touchSpeech.say(pick(['喂！别乱摸！', '你干什么！', '……这、这不合适！', '手拿开！', '绅士的肚子是不能随便摸的！', '你……你这是骚扰！']), 3500);
      if (touchHost) global.setTimeout(() => touchHost.post({type:'flee', direction:Math.random() < .5 ? -1 : 1}), 450);
    } else if (touchCount < TOUCH_FOND) {
      if (Math.random() < .6) touchSpeech.say(pick(['……够了。', '你还摸上瘾了？', '……我没躲，是因为懒得躲。', '……哼。', '就、就这一次。', '你的手怎么这么凉。']), 3500);
    } else {
      runtime.localHoldUntil = Date.now() + 9000;
      if (typeof runtime.setLifeState === 'function') runtime.setLifeState('happy');
      if (Math.random() < .35 && typeof runtime.spawnFlowers === 'function') runtime.spawnFlowers();
      if (Math.random() < .55) touchSpeech.say(pick(['……还、还行吧。', '嗯。……继续也不是不行。', '……我什么都没说。', '哼，随便你。', '真拿你没办法。']), 4000);
    }
    return true;
  }

  // Small things to remember across restarts (kept by the app as JSON).
  const memo = {data:{}, host:null,
    load(json) { try { this.data = Object.assign({}, JSON.parse(json || '{}')); } catch (_e) { this.data = {}; } },
    save() { if (this.host) this.host.post({type:'kv', json:JSON.stringify(this.data)}); }};

  // His little book of grudges: what she did to him today. Read out late at night.
  const CRIME_WORDS = {thrown:'把我扔出去', fairies:'吓跑我的朋友', stolen:'偷我的东西', jabs:'戳我肚子', crotch:'戳我……那里', sulks:'惹我生气'};
  const CN = n => ['零','一','两','三','四','五','六','七','八','九','十'][n] || String(n);
  // Ordinals: 第二次, not 第两次.
  const ORD = n => n === 2 ? '二' : CN(n);
  function crimes() {
    const today = new Date().toDateString();
    if (!memo.data.crimes || memo.data.crimes.day !== today) memo.data.crimes = {day:today, read:false};
    return memo.data.crimes;
  }
  function noteCrime(kind) { const c = crimes(); c[kind] = (c[kind] || 0) + 1; memo.save(); }

  // What he says around his little antics, and which ones fit right now.
  // His fairy friends: the ones he's always had (mint bunny, the unicorn, the
  // little fairies) and the folk of Britain's own stories, each in character.
  const FAIRY_TALK = [
    '薄荷兔，你又胖了。', '薄荷兔说想吃司康。……不行，那是我的。', '薄荷兔，别在我头上睡觉。',
    '独角兽又挑食了？', '别用角戳我的书。', '独角兽说今天想去海德公园。……人太多了，不行。',
    '小仙子们，别在我头发上编辫子。', '……你们又把我的茶匙藏哪儿了？',
    '布朗尼，昨晚厨房是你收拾的吧。……我知道，不能谢你，也不能给你送衣服。不然你就走了。', '牛奶放在灶台边了，布朗尼，自己拿。',
    '博格特，我的眼镜是不是你藏的？', '博格特，牛奶又是你弄酸的吧。',
    '帕克，别再把路人往沼泽里领了。', '好人罗宾，你又在偷笑什么？',
    '康沃尔的小精灵们来了。……这次别把我领错路。', '斯普里根，你们守的宝藏我不打听。放心。',
    '敲矿精说矿洞那边又有动静了。……替我谢谢他们提醒矿工。',
    '泰尔维斯·泰格……威尔士的老朋友们，好久不见。', '布巴赫，威尔士的家还好吗？',
    '海豹人说北边海上起风了。', '凯尔派，别想骗人骑到你背上。我认得你。',
    '矮妖精又在数金币。……我不感兴趣。真的。', '鬼火，别乱晃，晃得我眼花。',
    '你说她今天学习了吗？……我也觉得没有。', '嘘，她在看。', '……真的？那可太不像话了。'
  ];
  const FAIRY_MOOD = {
    laugh:['哈。好笑。', '哈哈……别说了，{friend}。', '……噗。你真是。', '哈哈哈——咳。我没笑。', '{friend}，你再这样我要笑岔气了。'],
    fond:['你啊。', '……有你在挺好的。', '好啦好啦，我知道了，{friend}。', '……谢谢。', '{friend}，常来。'],
    huff:['别闹了，我在跟你说正事。', '……够了，{friend}！', '{friend}！别以为我看不见你。', '你再这样我就不理你了。']
  };
  function watchAntics(runtime, speech, statusTalk) {
    const library = global.ArthurIdleChatter;
    const fill = line => library ? library.fillNames(line) : line.replace(/\{someone\}/g, '弗朗西斯');
    let lastFairyLine = 0;
    runtime.anticAllowed = type => {
      if (runtime.chasingStolen && runtime.chasingStolen()) return false;   // busy getting his things back
      const status = statusTalk.current();
      const place = status && status.arthur ? status.arthur.place : 'unknown';
      // A book or a cup only where he could plausibly sit down with one.
      if (type === 'read' || type === 'tea' || type === 'embroider') return ['home','hotel','unknown'].includes(place);
      return true;
    };
    runtime.onAntic = (type, phase, reason) => {
      if (phase === 'beat') {
        // A quiet word to himself, now and then, at most once a minute.
        const BEAT_LINES = {prick:[.5, ['嘶——', '……扎到了。', '嘶……没事。']], hot:[.4, ['……烫。', '嘶，烫。']],
          wrong:[.35, ['……刚才那个音不算。', '……嗯？', '……再来。']], frown:[.2, ['……胡说八道。', '……这作者在想什么。']],
          smile:[.15, ['……呵。', '……写得不错。']], sip:[.15, ['……嗯。这才对。']], admire:[.2, ['……还行。', '嗯，这针脚不错。']]};
        const entry = BEAT_LINES[reason];
        if (entry && Math.random() < entry[0] && Date.now() - (runtime._beatSaidAt || 0) > 60000) {
          runtime._beatSaidAt = Date.now();
          speech.say(pick(entry[1]), 2200);
        }
        return;
      }
      if (type === 'embroider' && phase === 'end' && reason === 'poked') {
        speech.say(pick(['没、没什么！你什么都没看到！', '……我在缝扣子。对，缝扣子。', '别看！还没绣完！', '这、这是给……不关你的事！']), 3200);
      }
      if (type === 'embroider' && phase === 'end' && reason === 'done') {
        const day = new Date().toDateString();
        const g = global.ArthurDesktopCompanion.grudge;
        if (memo.data.embroideryGift !== day && Math.random() < .35 && g && g.peace && g.peace.give) {
          const gifts = [
            {icon:'🌹', note:['……绣完了。放那儿了。', '手帕。上面绣了朵玫瑰。'], take:['……不喜欢可以不用。', '我顺手绣的。没花多少时间。……三个晚上而已。']},
            {icon:'🧵', note:['书签。我绣的。', '……拿去夹书。'], take:['别弄皱了。', '嗯。……绣歪的那一针别管它。']},
            {icon:'🍀', note:['杯垫。……绣了片叶子。', '放茶杯用的。别放咖啡。'], take:['……做好了。拿去用吧。', '好好用。']}
          ];
          if (g.peace.give(pick(gifts))) { memo.data.embroideryGift = day; memo.save(); }
        }
      }
      if (type === 'sneeze' && phase === 'start' && Math.random() < .45) {
        global.setTimeout(() => speech.say(fill(pick(['……肯定是{someone}又在念叨我。', '阿嚏——……一定是{someone}在说我坏话。', '……谁在念我？{someone}吧。']))), 1700);
      }
      if (type === 'fairies' && phase === 'start') {
        // Who's come today (from wherever VPS Arthur is, if a visit came through).
        const friends = global.ArthurFairyFriends;
        const antic = runtime.antic;
        const visitors = friends && antic ? friends.pickVisitors(antic.region || 'home') : [];
        if (antic) antic.visitors = visitors;
        const colors = visitors.flatMap(v => v.colors);
        for (let i = 0; i < 5 && colors.length; i++) {
          const path = runtime.q(`fx-spark-${i}`) && runtime.q(`fx-spark-${i}`).querySelector('path');
          if (path) path.setAttribute('fill', colors[i % colors.length]);
        }
        lastFairyLine = Date.now();
        if (visitors.length) {
          const hello = pick(visitors[0].greet) + (visitors[1] ? ` ……${visitors[1].name}也来了？` : '');
          global.setTimeout(() => { if (runtime.antic && runtime.antic.type === 'fairies') speech.say(hello, 5500); }, 1200);
        }
      }
      if (type === 'fairies' && phase === 'mood') {
        // Not every turn of the conversation gets a bubble.
        const now = Date.now();
        if (now - lastFairyLine < 14000 || Math.random() > .5) return;
        const visitors = (runtime.antic && runtime.antic.visitors) || [];
        const who = visitors.length ? pick(visitors) : null;
        const pool = FAIRY_MOOD[reason] && Math.random() < .5 ? FAIRY_MOOD[reason] : (who ? who.lines : FAIRY_TALK);
        const line = fill(pick(pool)).replace(/\{friend\}/g, who ? who.name : '你们');
        if (speech.say(line, 5000)) lastFairyLine = now;
      }
      if (type === 'fairies' && phase === 'end' && (reason === 'poked' || reason === 'interrupted')) {
        noteCrime('fairies');
        // She scared his friends off.
        const g = runtime.grudge;
        const line = pick(['……你把它们吓跑了！', '喂！它们好不容易才来一次！', '……都飞走了。你满意了？']);
        if (g) global.setTimeout(() => g.start({mild:true, line}), 400);
        else speech.say(line, 5000);
      }
      if (type === 'doze' && phase === 'end' && reason === 'woken') speech.say(pick(['……我没睡着。我在闭目养神。', '嗯？我醒着。一直醒着。', '……什么事？我在思考。']), 4500);
      if (type === 'guitar' && phase === 'end' && reason === 'done' && Math.random() < .3) speech.say(pick(['……今天手感不错。', '弹完了。不许鼓掌。……好吧，可以鼓一下。']), 4000);
    };
  }

  // Thrown into walls: after a hard one (or several dizzy ones) he sulks for
  // a few minutes or walks off in a huff. Tea or a scone makes it up.
  const SULK_LINES = ['哼。', '我还在生气。', '别跟我说话。', '……头还疼。', '你以为扔完我还能当没事？', '现在别碰我。'];
  // Each sulk wants one particular thing; she has to guess (he drops hints).
  const MAKE_UP = [
    {kind:'gift', item:'tea', hint:['……喉咙好干。', '要是有人泡杯茶就好了。'], done:'……看在茶的份上，原谅你了。这次。'},
    {kind:'gift', item:'scone', hint:['……有点饿了。没什么。', '下午茶的点心呢？'], done:'……司康可以。原谅你了。别得寸进尺。'},
    {kind:'gift', item:'rose', hint:['花园里的玫瑰开得真好。……跟你没关系。', '想看点好看的东西。'], done:'……玫瑰？你真是……行吧。不生气了。'},
    {kind:'gift', item:'book', hint:['最近没什么好书看。', '……无聊。要是有本新书就好了。'], done:'……这本书我收下了。气也消了。'},
    {kind:'pat', hint:['……头还疼。没人管。', '撞到的地方还疼。……你看什么看。'], done:'……够了够了。头不疼了。……谢谢。'},
    {kind:'hand', hint:['……手也撞疼了。', '手背还疼。……没人管。'], done:'……行了，别捏了。不生气了。'},
    {kind:'holdhand', hint:['……手好冷。', '@reach'], done:'……握、握够了没有。……好吧。不生气了。'},
    {kind:'belly', hint:['@lookaway ……', '……肚子也撞到了。'], done:'……好、好吧。不生气了。别摸了。'},
    {kind:'file', hint:['……你最近在忙什么？给我看看也不行？', '你都不跟我分享你在做什么。'], done:'……哦？给我看这个。嗯，原谅你了。'},
    {kind:'outfit', item:'tweed', hint:['这身衣服穿得浑身不自在。想要件像样的外套。'], done:'……粗花呢。嗯，这才像话。不生气了。'},
    {kind:'outfit', item:'coat', hint:['有点冷。……我那件海军蓝的呢？'], done:'……这件暖和。好吧，原谅你。'},
    {kind:'outfit', item:'dress', hint:['要是有什么正式场合就好了。'], done:'……礼服。你还算有点眼光。原谅你了。'},
    {kind:'away', hint:['让我一个人待会儿。', '……别跟着我。我想静静。'], done:'……我冷静下来了。原谅你了。'}
  ];
  function makeGrudge(runtime, speech, host) {
    const stormLeave = () => {
      const st = runtime._stormOff;
      if (!st) return;
      st.timer = null;
      if (runtime.held || runtime.hostCarry) return;           // still in her hands: on letting go
      const away = st.away * (1 + 0.6 * st.grabs);
      host.post({type:'leave', until:Date.now() + away});
      st.sent = Date.now();
    };
    // Grabbed while storming off: he fights it, and it's worse now.
    runtime.stormGrabbed = () => {
      const st = runtime._stormOff;
      if (!st || Date.now() - st.since > 45000) { runtime._stormOff = null; return false; }
      st.grabs += 1;
      st.sent = null;                                   // the shell dropped the leave; send it again on letting go
      global.clearTimeout(st.timer); st.timer = null;
      speech.say(pick(st.grabs > 1
        ? ['……你还来？！放手！', '放开！！我真的生气了！', '……够了！你再拦我试试！', '你、你这是绑架！放我下来！']
        : ['放开我！我要走了！', '……你还敢拦我？！', '放手！……我说了我生气了！', '别碰我！我正在离家出走！']), 3200);
      return true;
    };
    // Let go of him again: off he goes (or, now and then after a second grab, he gives up
    // on leaving and just sulks right there).
    runtime.stormLetGo = () => {
      const st = runtime._stormOff;
      if (!st || st.timer || st.sent) return;   // (sent is cleared when she grabs him)
      if (st.grabs >= 2 && Math.random() < .25) {
        runtime._stormOff = null;
        grudge.start({mild:true, line:pick(['……行。我不走了。但我也不理你。', '……哼。走不掉是吧。那我就坐这儿生气。', '……你赢了。我还在生气。'])});
        return;
      }
      st.timer = global.setTimeout(() => stormLeave(), 1500);
    };
    let dizzyHits = [];
    let ranOff = false;
    let endTimer = null;
    let need = null;
    let progress = 0;
    let wrongSaid = {};
    const clock = () => (global.performance ? performance.now() : Date.now());
    const grudge = {
      active() { return !!(runtime.sulk && clock() < runtime.sulk.until); },
      hit(level) {
        const now = Date.now();
        if (level === 'dizzy') {
          dizzyHits = dizzyHits.filter(t => now - t < 3 * 60 * 1000).concat(now);
          return dizzyHits.length >= 3;
        }
        return true;   // a splat always does it
      },
      start(how={}) {
        dizzyHits = [];
        noteCrime('sulks');
        if (host && (how.runOff || (!how.mild && Math.random() < .5))) {
          ranOff = true;
          speech.say(how.runOff && how.line ? how.line : pick(['我不跟你玩了。', '哼。我走了。', '……你自己玩吧。']), 4000);
          const away = how.awayMs || (2 + Math.random() * 3) * 60 * 1000;
          // Storming off. Grab him on the way and he's angrier still: let go and he
          // goes all the same, for longer each time (see stormGrabbed / stormLetGo).
          runtime._stormOff = {away, grabs:0, since:Date.now(), timer:null};
          runtime._stormOff.timer = global.setTimeout(() => stormLeave(), 1200);
          return 'ran-off';
        }
        const ms = how.mild ? (1 + Math.random()) * 60 * 1000 : (3 + Math.random() * 2) * 60 * 1000;
        const worn = runtime.outfit;
        const options = MAKE_UP.filter(n => !(n.kind === 'outfit' && n.item === worn) && !(n.kind === 'away' && !host));
        need = Object.assign({}, how.need || pick(options));
        if (need.kind === 'pat') need.amount = 4000 + Math.random() * 5000;      // ms of head pats
        if (need.kind === 'hand') need.amount = 3 + Math.floor(Math.random() * 3); // taps on his hands
        progress = 0;
        wrongSaid = {};
        // Just made up over this very thing, and she does it again: straight to worse.
        const relapse = grudge.wary(how.cause);
        const total = relapse ? ms + (2 + Math.random()) * 60 * 1000 : ms;
        runtime.sulk = {until:clock() + total, cause:how.cause || null, same:relapse ? 1 : 0, others:0};
        runtime.localHoldUntil = Date.now() + total;
        if (relapse) { runtime._wary = null; if (need.amount) need.amount *= 1.5; if (runtime.act) runtime.act('glare'); }
        if (typeof runtime.setLifeState === 'function') runtime.setLifeState('annoyed');
        speech.say(relapse ? pick(['……刚和好你就来这个？', '我们才刚和好！', '……我就知道你不会长记性。', '刚说好的，你转头就忘了？'])
          : how.line || pick(['……我生气了。', '哼。不理你了。', '下次再这样，我就把你的论文退回去重写。']), 5000);
        global.clearTimeout(endTimer);
        endTimer = global.setTimeout(() => grudge.end('time'), total);
        return relapse ? 'relapse' : 'sulk';
      },
      end(reason) {
        if (!runtime.sulk) return false;
        // Made up (or it blew over): for half an hour he's still wary of the same thing.
        if (reason !== 'x' && runtime.sulk.cause) runtime._wary = {cause:runtime.sulk.cause, until:Date.now() + 30 * 60 * 1000};
        runtime.sulk = null;
        need = null;
        if (reason !== 'x' && grudge.peace) grudge.peace.schedule();
        const n = crimes().sulks || 0;
        if (reason !== 'x' && n >= 2 && Math.random() < .5) {
          global.setTimeout(() => speech.say(pick([`今天第${ORD(n)}次了。……我记着呢。`, `……这已经是今天第${ORD(n)}次了。`, `我在本子上记了一笔。今天第${ORD(n)}次。`]), 4000), 5500);
        }
        runtime.localHoldUntil = 0;
        global.clearTimeout(endTimer);
        if (typeof runtime.setLifeState === 'function') runtime.setLifeState('awake');
        if (reason === 'time') speech.say(pick(['……算了。不跟你计较。', '气消了。……一点点。']), 5000);
        return true;
      },
      // Back from storming off.
      cameBack() {
        if (ranOff && grudge.peace) grudge.peace.schedule();
        if (grudge.active()) {
          // She sent him off to cool down: right if that's what he wanted.
          if (grudge.offer('away') !== 'made-up') speech.say(pick(SULK_LINES), 4000);
          return true;
        }
        if (!ranOff) return false;
        ranOff = false;
        speech.say(pick(['……我原谅你了。这次。', '我回来了。下次再扔我试试。', '哼。……我只是回来拿东西的。']), 6000);
        return true;
      },
      wary(cause) { const w = runtime._wary; return !!(cause && w && w.cause === cause && Date.now() < w.until); },
      // Something that annoys him, but on its own isn't enough to sulk over. Cross
      // already: it's doing it again. Just made up over this: that's enough now.
      provoked(cause) {
        if (grudge.active()) return grudge.again(cause);
        if (grudge.wary(cause)) return grudge.start({mild:true, cause});
        return null;
      },
      // She does it again while he's still cross. The same thing again makes it worse
      // (longer, harder to make up), and a second time he's had enough and walks off.
      // Something else on top adds up: three in all and he goes too.
      again(cause) {
        if (!grudge.active()) return null;
        const sk = runtime.sulk;
        const same = !!sk.cause && sk.cause === cause;
        if (same) sk.same += 1; else sk.others += 1;
        if ((same && sk.same >= 2) || sk.same + sk.others >= 3) {
          grudge.end('x');
          grudge.start({runOff:true, cause, awayMs:(12 + Math.random() * 12) * 60 * 1000,
            line:pick(['……够了。我真的走了。', '我不想看见你。……一会儿也不想。', '……我去别的地方待着。别跟过来。', '你一点都没把我的话当回事。'])});
          return 'ran-off';
        }
        const extra = (same ? 2 + Math.random() : 1 + Math.random() * .5) * 60 * 1000;
        sk.until += extra;
        runtime.localHoldUntil = Math.max(runtime.localHoldUntil || 0, Date.now()) + extra;
        global.clearTimeout(endTimer);
        endTimer = global.setTimeout(() => grudge.end('time'), Math.max(1000, sk.until - clock()));
        if (same && need && need.amount) need.amount *= 1.5;     // harder to talk round now
        if (runtime.act) runtime.act('glare');
        const SAME = {
          thrown:['……你还扔？！我还在生气呢！', '又来？！……这笔账翻倍。', '你是故意的。你绝对是故意的。'],
          stolen:['又拿？！上一样还没还给我！', '……你是不是觉得我很好欺负？'],
          baited:['……又来这招。我不会再上当了。', '同一招用两次，你以为我是笨蛋吗？']
        };
        speech.say(pick(same ? (SAME[cause] || ['……你还来？！', '我还没消气呢，你又来？'])
          : ['……又换花样了是吧。', '还嫌我不够生气？', '……一件还没完，又来一件。', '好啊。都记上。']), 4000);
        return same ? 'worse' : 'more';
      },
      sulkLine() { return need && Math.random() < .35 ? pick(need.hint) : pick(SULK_LINES); },
      wants() { return need ? Object.assign({}, need) : null; },
      // She tried something. 'made-up', 'wrong' (with a line if he has one to say), or null if not sulking.
      offer(kind, value) {
        if (!grudge.active() || !need) return null;
        const right = need.kind === kind && (!need.item || need.item === value);
        if (right && (kind === 'pat' || kind === 'hand')) {
          progress = kind === 'pat' ? value : progress + 1;
          if (progress < need.amount) return 'progress';
        }
        if (right) {
          const line = need.done;
          grudge.end('made-up');
          if (typeof runtime.setLifeState === 'function' && kind !== 'gift') runtime.setLifeState('happy');
          speech.say(line, 6000);
          return 'made-up';
        }
        const pools = NOPE[kind];
        // Per kind of attempt (per gift/outfit), not per pat tick: once, then
        // flatter if she keeps at it, then he stops answering that one.
        const key = kind === 'gift' || kind === 'outfit' ? kind + value : kind;
        const w = wrongSaid[key] || (wrongSaid[key] = {n:0, at:0});
        const nowMs2 = Date.now();
        if (pools && w.n < 3 && nowMs2 - w.at > 8000) {
          w.n += 1; w.at = nowMs2;
          speech.say(pick(w.n === 1 ? pools.first : pools.again), 3500);
        }
        return 'wrong';
      },
    };
    return grudge;
  }

  // After a sulk blows over, a while later he leaves something out for her,
  // without a word: a peace offering. Taking it is the whole point; trying to
  // give it back just gets it pushed back to you.
  const PEACE_OFFERINGS = [
    {kind:'scone', icon:'🍪', take:['……做多了。吃吧。', '……好吃吗？', '烤多了，扔了可惜。就这样。']},
    {kind:'tea', icon:'☕', take:['……正好多泡了一杯。', '趁热喝。……我说的是茶。', '不加糖。你自己加。']},
    {kind:'rose', icon:'🌹', take:['花园里开得太多了。……就这样。', '……别夹在书里压坏了。', '随手剪的。随手。']},
    {kind:'mint', icon:'🍬', take:['……薄荷兔非要我分你一块。', '吃颗糖。别板着脸了。']},
    {kind:'book', icon:'📗', take:['……这本你会喜欢的。', '书。……看完了告诉我你觉得怎么样。']},
    {kind:'note', icon:'✉️', take:['……别、别念出来！', '……看完就扔了。不，别扔。'],
      note:['（字条上写着：我需要一点自己的空间，如果冒犯到你了，真是不好意思。）', '（字条：我仍然认为这件事是你的问题，但我今天宽宏大量地放你一马。）', '（字条：你知道的，我一般不会向你生气，干这种事情之前请先考虑我的感受。）', '（字条：下次扔我之前，先打个招呼。）']}
  ];
  function makePeaceOfferings(host, speech) {
    let pending = null, timer = null;
    return {
      schedule(delayMs) {
        // Not every time: he usually had a reason to be cross. About one in three.
        if (!host || (delayMs == null && Math.random() > .33)) return;
        global.clearTimeout(timer);
        timer = global.setTimeout(() => {
          pending = pick(PEACE_OFFERINGS);
          host.post({type:'gift-drop', icon:pending.icon});
        }, delayMs != null ? delayMs : (3 + Math.random() * 5) * 60 * 1000);
      },
      done(how) {
        const gift = pending;
        pending = null;
        if (!gift || how !== 'accepted') return;
        if (gift.note) {
          speech.say(pick(gift.note), 5500);
          global.setTimeout(() => speech.say(pick(gift.take), 3500), 5800);
        } else {
          speech.say(pick(gift.take), 4000);
        }
      },
      refused() { speech.say(pick(['……给你的。拿着。', '我不要。是给你的。', '……还给我做什么。拿走。']), 3500); },
      // Something he made (not a making-up present): leave it out for her.
      waiting(gift) { return pending === gift; },
      give(gift) {
        if (!host || pending) return false;
        pending = gift;
        host.post({type:'gift-drop', icon:gift.icon});
        return true;
      }
    };
  }

  // Every 10–20 minutes he says something, if he's awake and on the desktop.
  function makeChatter(runtime, speech, statusTalk, wardrobe, menuOpen, random=Math.random) {
    const library = global.ArthurIdleChatter;
    const recent = [];
    let present = true;
    let timer = null;
    const next = () => (10 + random() * 10) * 60 * 1000;
    const chatter = {
      context() {
        const status = statusTalk.current();
        const a = status && status.arthur ? status.arthur : {};
        const weather = a.weather || {};
        return {
          now:new Date(),
          asleep:runtime.state === 'sleep' || !!runtime.sleepSequence || a.availability === 'sleeping',
          place:a.place, sky:weather.sky, temp:weather.temp,
          doing:a.activity ? (a.activity.detail || a.activity.key) : null,
          letter:statusTalk.unreadLetter() ? 'waiting' : 'none',
          dressedByHer:wardrobe.current().mode !== 'auto'
        };
      },
      speakNow() {
        if (!library || !present || menuOpen()) return null;
        if (chatter.grudge && chatter.grudge.active()) return speech.say(chatter.grudge.sulkLine()) ? 'sulk' : null;
        const line = library.pickLine(chatter.context(), recent, random);
        if (!line || !speech.say(library.fillNames(line, random))) return null;
        recent.push(line);
        if (recent.length > 40) recent.shift();
        return line;
      },
      schedule() {
        global.clearTimeout(timer);
        timer = global.setTimeout(() => { chatter.speakNow(); chatter.schedule(); }, next());
      },
      setPresent(on) { present = !!on; }
    };
    chatter.schedule();
    return chatter;
  }

  // What he says when what she put on him comes off.
  const TAKE_OFF_LINES = {
    any:['终于。', '时间到了。我换回来了，别抗议。', '……总算能脱了。', '约好的时间到了，绅士说话算话。'],
    pirate:['船长下班了。'],
    maid:['……这件事，我们永远不要再提。', '……烧掉。立刻烧掉。', '我什么都不记得了。你也不许记得。', '……刚才那个不是我。是我的远房表弟。', '如果你告诉任何人，我就……我就……哼！'],
    jumper:['这件毛衣我会好好收起来的。'],
    pajamas:['好了，可以穿得像个正经人了。'],
    dress:['礼服得挂好，不然会皱。'],
    punk:['……这件的事，谁都不许提。']
  };
  function takeOffLine(mode, random=Math.random) {
    const own = TAKE_OFF_LINES[mode] || [];
    const pool = own.length && random() < .6 ? own : TAKE_OFF_LINES.any;
    return pool[Math.floor(random() * pool.length)];
  }

  // What she put on him and until when. The native app keeps the clock (it
  // survives restarts); in a plain browser a timer stands in for it.
  function makeWardrobe(runtime, host) {
    let timer = null;
    const wardrobe = {
      state:{mode:'auto', until:null},
      lastWorn:null,
      current() { return {...this.state}; },
      wear(mode, until) {
        // Out of the maid's dress (into anything else): the one thing he says about it.
        if (runtime.outfit === 'maid' && mode !== 'maid' && this.speech) {
          const sp = this.speech;
          global.setTimeout(() => sp.say(pick(TAKE_OFF_LINES.maid), 4500, {force:true}), 600);
          if (mode === 'auto') this.lastWorn = null;
        }
        if (mode !== 'auto') this.lastWorn = mode;
        this.state = {mode, until:until || null};
        runtime.setOutfitChoice(mode);
      },
      choose(mode, until) {
        this.wear(mode, until);
        if (host) { host.post({type:'outfit', mode, until:until || null}); return; }
        if (timer) global.clearTimeout(timer);
        timer = until ? global.setTimeout(() => { this.choose('auto', null); this.expired(); }, Math.max(0, until - Date.now())) : null;
      },
      // Time's up (the native app or the timer above already put him back on auto).
      expired() {
        if (this.log) this.log(`outfit expired; last worn ${this.lastWorn}`);
        if (this.speech && this.lastWorn) this.speech.say(takeOffLine(this.lastWorn));
        this.lastWorn = null;
      }
    };
    return wardrobe;
  }

  // Tell the native window which pixels are Arthur (everything else lets the
  // mouse through to the windows underneath) and where his feet touch ground.
  const HIT_PART_IDS = ['motion-head-root','torso-root','lower-body-root','tail-root','sleep-tail-root','fx-note',
    'motion-hand-left','motion-hand-right','desktop-guitar'];
  function hostRects(runtime) {
    const rects = [];
    const add = el => {
      if (!el || !el.getBoundingClientRect) return;
      const b = el.getBoundingClientRect();
      if (b.width < 3 || b.height < 3) return;
      rects.push([Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]);
    };
    HIT_PART_IDS.forEach(id => add(runtime.q(id)));
    const doc = global.document;
    const menu = doc.querySelector('#arthurPokeMenu');
    if (menu && !menu.hidden) add(menu);
    const shadow = runtime.q('desktop-ground-shadow');
    let feet = null;
    if (shadow && shadow.getBoundingClientRect) {
      const b = shadow.getBoundingClientRect();
      if (b.width > 2) feet = [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)];
    }
    return {rects, feet};
  }

  function startHostBridge(runtime, host, wardrobe, lines, fileHands, statusTalk, chatter) {
    let last = '';
    const tick = () => {
      const payload = hostRects(runtime);
      const key = JSON.stringify(payload);
      if (key !== last) {
        last = key;
        host.post({type:'hit', rects:payload.rects, feet:payload.feet, canWander:runtime.canWander(), canSit:runtime.canSit(), seated:runtime.seatTarget > 0});
      }
    };
    global.setInterval(tick, 120);
    tick();
    global.ArthurHost = {
      topCut:px => { runtime.topCut = Math.max(0, Number(px) || 0); },
      walk:direction => runtime.hostWalk(direction),
      stop:() => runtime.hostStop(),
      fall:() => runtime.hostFall(),
      hop:direction => runtime.hostHop(direction),
      landed:() => {
        const asleep = runtime.state === 'sleep' && runtime.hostCarry && !runtime.bedAwake;
        runtime.hostLanded();
        if (runtime._stormOff && runtime.stormLetGo) runtime.stormLetGo();
        if (asleep) global.setTimeout(() => global.ArthurDesktopCompanion.speech.say(pick(SLEEP_STIR), 2600, {asleep:true}), 300);
      },
      pointer:(x, y) => runtime.hostPointer(x, y),
      leave:() => runtime.hostPointerLeave(),
      canWander:() => runtime.canWander(),
      sit:on => runtime.hostSit(on),
      glasses:mode => runtime.setGlasses(mode),
      outfit:(mode, until) => wardrobe.wear(mode, until),
      outfitExpired:() => { wardrobe.wear('auto', null); wardrobe.expired(); },
      thrown:() => lines.thrown(),
      walkRate:rate => runtime.setWalkRate(rate),
      kv:json => { memo.load(json); },
      idleFor:seconds => global.ArthurDesktopCompanion.night(Number(seconds) || 0),
      visitCursor:(x, y) => global.ArthurDesktopCompanion.visitCursor(Number(x), Number(y)),
      edgeFear:on => { runtime.edgeFear = !!on; },
      dragMotion:kind => lines.dragMotion(String(kind)),
      occluded:on => { runtime.hostOccluded = !!on; if (!on && runtime.wakeFrames) runtime.wakeFrames(); },
      // The window went from under him: umbrella up, drifting down.
      floatDown:on => {
        const sp = global.ArthurDesktopCompanion.speech;
        runtime.floating = !!on;
        const awake = runtime.state !== 'sleep';
        const umb = runtime.q('prop-umbrella-open'), closed = runtime.q('prop-umbrella');
        if (umb) umb.setAttribute('display', on && awake ? 'inline' : (runtime.brollyOut ? 'inline' : 'none'));
        if (closed && on && awake) closed.setAttribute('display', 'none');
        const now = Date.now();
        if (on && awake && now - (runtime._floatSaidAt || 0) > 90000 && Math.random() < .6) {
          runtime._floatSaidAt = now;
          sp.say(pick(['……又来了。', '哎——', '我早有准备。', '绅士出门总要带伞的。', '……慢慢来。慢慢来。']), 2400);
        } else if (!on && awake && now - (runtime._floatSaidAt || 0) < 15000 && Math.random() < .5) {
          global.setTimeout(() => sp.say(pick(['……着陆。', '完美。', '……没摔着。哼。']), 2000), 300);
        }
      },
      // She pressed a screenshot shortcut: quick, the hair, stand up straight.
      screenshot:kind => {
        const sp = global.ArthurDesktopCompanion.speech;
        const asleep = runtime.state === 'sleep' || runtime.sleepSequence;
        if (asleep) return;
        if (kind === 'full') {
          if (!runtime.antic && runtime.startAntic) runtime.startAntic('hair');
          global.setTimeout(() => sp.say(pick(['……你刚才是不是拍我了？', '等等，我头发还没——！', '拍之前要说一声！', '……那张删掉。我没准备好。'])), 1600);
        } else {
          sp.say(pick(['要拍照？等一下。', '……别急，我整理一下。', '哦？要拍我？']), 1800);
          if (!runtime.antic && runtime.startAntic) global.setTimeout(() => runtime.startAntic('hair'), 300);
          global.setTimeout(() => sp.say(pick(['……拍好了？给我看看。', '拍得好看吗？给我看看。', '这张可以留着。', '……你刚才是不是拍我了？']), 3000), 5500);
        }
      },
      ride:level => {
        const sp = global.ArthurDesktopCompanion.speech, was = runtime.ride || 0;
        runtime.ride = Number(level) || 0;
        if (runtime.ride && runtime.putBlanketAway) runtime.putBlanketAway();
        const now = Date.now();
        if (runtime.ride === 1 && was === 0 && now - (runtime._rideSaidAt || 0) > 20000) {
          runtime._rideSaidAt = now;
          sp.say(pick(['……这是什么交通工具。', '哦？……我们要去哪儿？', '喂，地板在动。……不对，是窗口在动。', '……还挺平稳的。']), 3000);
        } else if (runtime.ride === 2 && now - (runtime._rideFastAt || 0) > 6000) {
          runtime._rideFastAt = now;
          sp.say(pick(['慢点！！', '你、你开慢点！！', '我要掉下去了！！', '这不是游乐场！！']), 2500);
          runtime._rideWasFast = true;
        } else if (runtime.ride === 0 && was > 0 && runtime._rideWasFast) {
          runtime._rideWasFast = false;
          global.setTimeout(() => sp.say(pick(['……停了？……呼。', '我的头发……全乱了。', '下次坐车之前，先说一声。', '……我没抓那么紧。'])), 400);
        }
      },
      inCorner:() => { if (runtime._inCorner) runtime._inCorner(); },
      stranded:(on, rescued) => {
        const sp = global.ArthurDesktopCompanion.speech;
        global.clearInterval(runtime._strandedTimer);
        runtime.worried = !!on;
        if (!on) runtime.edgeFear = false;
        if (on) {
          sp.say(pick(['……等等。这儿怎么这么高。', '下、下不去了……', '我刚才是怎么上来的……']), 4000);
          runtime._strandedTimer = global.setInterval(() => sp.say(pick(['……你能不能把我抱下来。', '我没有怕。我只是……在考虑最佳路线。', '……喂。帮个忙。', '下面的地板看起来好远。']), 4000), 22000);
        } else if (rescued) {
          sp.say(pick(['……谢、谢谢。……我自己也下得来的。', '……我刚才只是在欣赏风景。', '哼。这次算你帮了我。']), 4500);
        }
      },
      tired:on => {
        runtime.setTired(on);
        if (on) global.ArthurDesktopCompanion.speech.say(pick(['呼……呼……等、等一下……', '跑、跑不动了……', '……你给我站住……呼……', '我、我只是……喘口气……', '……绅士是不跑步的。呼……']), 3500);
      },
      pickedUp:() => {
        if (runtime._stormOff) return;                 // storming off: the grab already got its line
        runtime.putBlanketAway && runtime.putBlanketAway();
        if (runtime._blanketPending) { runtime._blanketPending = false; runtime.blanketPutAwayAt = Date.now(); }   // the corner can wait
        const grab = runtime._lastGrab;
        const gripLines = GRIP_LINES[grab && Date.now() - grab.at < 5000 ? grab.zone : ''];
        if (gripLines && Math.random() < .55) {
          global.ArthurDesktopCompanion.speech.say(pick(gripLines), 3000);
          lines._pickedAt = Date.now();
          return;
        }
        if (grab && grab.zone === 'tail' && Date.now() - grab.at < 5000) {
          // Picked up by the tail.
          runtime.tailPuffUntil = performance.now() + 2500;
          global.ArthurDesktopCompanion.speech.say(pick(['放、放开我的尾巴！', '不要揪我的尾巴！！！它是真的！！', '……你拎哪儿呢！', '疼疼疼——尾巴！']), 3000);
          return;
        }
        if (runtime._blanketPending) { runtime._blanketPending = false; runtime.blanketPutAwayAt = Date.now(); }   // the corner can wait
        lines.pickedUp();
      },
      lifted:(level, seconds) => lines.lifted(Number(level) || 0, Number(seconds) || 0),
      dropped:(maxLevel, hard, seconds) => lines.dropped(Number(maxLevel) || 0, !!hard, Number(seconds) || 0),
      setDown:kind => lines.setDown(kind),
      knock:(level, quiet) => lines.knocked(runtime, level, quiet),
      // Came down from far too high: in a heap on the floor, face hidden.
      hardLanding:() => {
        if (lines.traumaLanding && lines.traumaLanding()) return true;
        // How long he sits there is anyone's guess: mostly a few seconds, sometimes a
        // good while. Now and then it hurt enough that he cries (always behind his hands).
        const r = Math.random();
        const cry = Math.random() < .2;
        let ms = r < .6 ? 4000 + Math.random() * 4000 : r < .9 ? 10000 + Math.random() * 15000 : 30000 + Math.random() * 60000;
        if (cry) ms = Math.max(ms, 12000 + Math.random() * 28000);
        if (!runtime.hardLanding || !runtime.hardLanding(ms, {cry})) return false;
        const sp = () => global.ArthurDesktopCompanion && global.ArthurDesktopCompanion.speech;
        const still = () => runtime._slumped && runtime._slumped();
        setTimeout(() => { const s1 = sp(); if (s1) s1.say(pick(cry ? HARD_LANDING_CRY : HARD_LANDING_LINES)); }, 650);
        // A long sit: another word or two from behind his hands.
        if (ms > 14000) setTimeout(() => { const s1 = sp(); if (s1 && still()) s1.say(pick(cry ? HARD_LANDING_CRY_LATER : HARD_LANDING_LATER), 3500); }, ms * (.45 + Math.random() * .2));
        if (cry) setTimeout(() => { const s1 = sp(); if (s1 && !still()) s1.say(pick(['……好了。刚才的事你什么都没看见。', '@rubeyes 灰尘真多。', '哼。我只是坐累了。', '……谁也不许说出去。']), 3500); }, ms + 900);
        return true;
      },
      fileHover:on => fileHands.hover(on),
      greet:() => global.ArthurDesktopCompanion.speech.say(greeting(), 7000),
      letterRead:id => { if (id) statusTalk.markRead(id); },
      touchCount:n => {
        const v = Number(n) || 0;
        if (Math.floor(v / 1000) === localDay()) { touchDay = localDay(); touchCount = Math.max(touchCount, v % 1000); }
      },
      patCount:n => { patCount = Math.max(patCount, Number(n) || 0); },
      pockets:json => { const p = global.ArthurDesktopCompanion.pockets; if (p) { p.load(json || '[]'); p.churn(); } },
      itemBack:how => global.ArthurDesktopCompanion.itemBack(how),
      giftDone:how => { const g = global.ArthurDesktopCompanion.grudge; if (g && g.peace) g.peace.done(how); },
      giftRefused:() => { const g = global.ArthurDesktopCompanion.grudge; if (g && g.peace) g.peace.refused(); },
      itemDropped:() => global.ArthurDesktopCompanion.itemDropped(),
      itemUnreachable:() => global.ArthurDesktopCompanion.itemUnreachable(),
      baited:(n, way) => global.ArthurDesktopCompanion.baited(Number(n) || 1, way === 'down' ? 'down' : 'up'),
      present:on => chatter.setPresent(on),
      fileGiven:(name, isFolder, count) => fileHands.given(name, isFolder, count),
      returned:() => { runtime._stormOff = null; return lines.returned(); },
      canSit:() => runtime.canSit()
    };
    // Anything the app tells him wakes the frame loop at full rate for a moment
    // (it rests between frames when nothing's happening, to save power).
    // Pointer position updates only count when he's actually being touched.
    Object.keys(global.ArthurHost).forEach(name => {
      const fn = global.ArthurHost[name];
      if (typeof fn !== 'function' || ['idleFor','canWander','canSit','kv','occluded','topCut'].includes(name)) return;
      global.ArthurHost[name] = function (...args) {
        if (runtime.noteActivity) runtime.noteActivity();
        return fn.apply(this, args);
      };
    });
  }

  ArthurLiveStatusClient.validatePreview = validatePreview;
  ArthurLiveStatusClient.applyPreview = applyPreview;
  ArthurLiveStatusClient.labelFor = labelFor;
  global.ArthurLiveStatusClient = ArthurLiveStatusClient;

  if (global.document && global.addEventListener) {
    global.addEventListener('DOMContentLoaded', () => bootstrap().catch(() => {
      const label = global.document.querySelector('#hostLabel');
      if (label) label.textContent = '桌宠界面没有加载完成';
    }));
  }
})(typeof window !== 'undefined' ? window : globalThis);
