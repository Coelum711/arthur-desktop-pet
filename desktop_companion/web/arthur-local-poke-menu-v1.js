(function (global) {
  'use strict';

  const MENU_BUILD = 'local-poke-menu-v1-r15-live-preview';
  const LOCAL_PREVIEW_SCHEMA = 'arthur.companion-local-preview/1';
  const OPTIONS = Object.freeze([
    Object.freeze({id:'status', label:'你现在怎么样？'}),
    Object.freeze({id:'activity', label:'你在做什么？'}),
    Object.freeze({id:'just-poke', label:'只是想戳你一下'}),
    Object.freeze({id:'wardrobe', label:'给你换件衣服'}),
    Object.freeze({id:'gift', label:'给你点东西'}),
    Object.freeze({id:'magic', label:'给我变个魔法'}),
    Object.freeze({id:'away', label:'你先走开一会儿'})
  ]);

  // Things she can hand him: what he does with it, for how long, what he says.
  const GIFTS = Object.freeze([
    Object.freeze({id:'tea', label:'一杯红茶', state:'tea', holdMs:90000,
      reply:['……泡得太淡了。不过，谢了。', '嗯，这杯还行。', '你泡茶有进步。……一点点。', '奶加多了。……我喝完了再说。'],
      again:['第二杯了。……你是想让我睡不着吗？谢了。', '又是茶？……我不会拒绝的。', '今天第几杯了？算了，不数了。', '……再喝我就要变成茶壶了。']}),
    Object.freeze({id:'scone', label:'一块司康', state:'happy', holdMs:60000,
      reply:['嗯，这个可以。……别告诉弗朗西斯我这么说过。', '司康！……咳。谢谢。', '奶油和果酱的顺序对了。不错。', '……刚出炉的？'],
      again:['又是司康？……你是想喂胖我吗。', '……我吃不下了。好吧，再吃一块。', '这是今天第几块了。']}),
    Object.freeze({id:'book', label:'一本书', state:'reading', holdMs:180000,
      reply:['这本我还没读过。……行，我看看。别吵。', '书？……你还挺懂我。', '嗯，这个作者我认识。他本人比书里啰嗦。'],
      again:['又一本？我床头已经堆不下了。', '……你是开书店的吗。', '先让我把上一本看完。']}),
    Object.freeze({id:'rose', label:'一朵玫瑰', state:'happy', holdMs:60000,
      reply:['……这是干什么。我又不是——算了。我去找个花瓶。', '玫瑰……我花园里的更好。不过，谢谢。', '……你、你送我玫瑰做什么。'],
      again:['……我的花瓶快放不下了。……不过，谢谢。', '又一朵？你是不是把花店搬空了。', '……再送我就要把它们晒干做成书签了。']})
  ]);
  const MINUTE = 60 * 1000;
  const AWAY = Object.freeze([
    Object.freeze({id:'10m', label:'十分钟', at:now => now + 10 * MINUTE}),
    Object.freeze({id:'30m', label:'半小时', at:now => now + 30 * MINUTE}),
    Object.freeze({id:'1h', label:'一小时', at:now => now + 60 * MINUTE}),
    Object.freeze({id:'call', label:'等我叫你', at:() => null})
  ]);

  // What she can put on him, and what he says about it.
  const WARDROBE = Object.freeze([
    Object.freeze({mode:'coat', label:'海军蓝风衣', grumble:'这件倒还行。'}),
    Object.freeze({mode:'raincoat', label:'米色雨衣', grumble:'屋里又不下雨。'}),
    Object.freeze({mode:'tweed', label:'粗花呢外套', grumble:'嗯，这件我认。'}),
    Object.freeze({mode:'jumper', label:'圣诞毛衣', grumble:'圣诞毛衣。你是认真的？'}),
    Object.freeze({mode:'city', label:'金融城绅士', grumble:'我又不去金融城上班。'}),
    Object.freeze({mode:'dress', label:'红色礼服', grumble:'这是正式场合穿的，你知道吧。'}),
    Object.freeze({mode:'trench', label:'旧军装风衣', grumble:'这件……有些年头了。'}),
    Object.freeze({mode:'pirate', label:'海盗船长', grumble:'……你从哪儿翻出来的。'}),
    Object.freeze({mode:'punk', label:'七十年代朋克', grumble:'这件我不打算解释。'}),
    Object.freeze({mode:'homewear', label:'居家便服', grumble:'……这身好。在家就该这么穿。'}),
    Object.freeze({mode:'pajamas', label:'条纹睡衣', grumble:'大白天的穿睡衣？'}),
    Object.freeze({mode:'gown', label:'学院袍', grumble:'……我只在毕业典礼和吵架的时候穿这个。'}),
    Object.freeze({mode:'garden', label:'园艺装', grumble:'嗯。玫瑰正好该修剪了。'}),
    Object.freeze({mode:'angel', label:'不列颠天使', grumble:'……！！你从哪儿翻出来的！！我、我不认识这件衣服！'}),
    Object.freeze({mode:'barbour', label:'乡村蜡夹克', grumble:'这件好。适合去乡下走走。'}),
    Object.freeze({mode:'maid', label:'女仆装', grumble:'（他一言不发，只是瞪着你。）', silent:true})
  ]);
  const HOUR = 3600 * 1000;
  const nextMidnight = now => { const d = new Date(now); d.setHours(24, 0, 0, 0); return d.getTime(); };
  const UNTIL = Object.freeze([
    Object.freeze({id:'10m', label:'十分钟就好', at:now => now + HOUR / 6, reply:'……十分钟。我掐着表。'}),
    Object.freeze({id:'1h', label:'一小时', at:now => now + HOUR, reply:'一小时。一分钟都不多给。'}),
    Object.freeze({id:'today', label:'今天穿着', at:nextMidnight, reply:'到今晚十二点。过了点我自己换回来，不用你批准。'}),
    Object.freeze({id:'always', label:'一直穿着', at:() => null, reply:'一直？……你真是个暴君。行吧，等你哪天良心发现。'})
  ]);

  const PLACE_LABELS = Object.freeze({
    home:'家里', hotel:'酒店', outdoors:'外面', transit:'路上', unknown:'不确定的地方'
  });
  // Several ways to say each thing, so asking twice doesn't get the same words.
  const pickLine = list => {
    if (!Array.isArray(list)) return list;
    return global.ArthurPickFresh ? global.ArthurPickFresh(list) : list[Math.floor(Math.random() * list.length)];
  };
  const ACTIVITY_LABELS = Object.freeze({
    reading:['在读东西。你这一戳正好把我打断了。', '在看书。……你也该看看。', '读书呢。这章刚到精彩的地方。'],
    tea:['在喝茶。杯子还没洒，多谢关心。', '喝茶。不加糖，加奶。', '泡了一壶。……你要是在这儿，分你一杯。'],
    guitar:['在弹吉他。刚才那一下可不在拍子上。', '弹琴呢。别跟着哼，你跑调。', '吉他。……这首歌你不认识。'],
    sleeping:['在睡觉。至少被你戳之前是。', '……睡着呢。zzz。', '（他睡得很熟，没理你。）'],
    outdoors:['在外面。', '出门了。别担心，我认得路。', '在外头。晚点再说。'],
    learned_activity:['在忙自己的事。', '在做点自己的事。不用你管。', '……忙着呢。'],
    unknown:['……我也说不清。', '可靠的活动记录暂时读不到。', '这会儿？说不好。']
  });
  // One step finer, when the VPS sent a category (never his words).
  const DETAIL_LABELS = Object.freeze({
    cooking:['在做饭。别过来，火候正关键。', '做饭呢。这次一定成功。', '在厨房。……别问是什么，做好了你就知道了。'],
    garden:['在花园里。手上全是土，别指望我现在跟你握手。', '在侍弄玫瑰。', '在花园。精灵们在帮忙，大概。'],
    writing:['在写东西。写什么就不劳你操心了。', '写字呢。墨水别洒了……', '在写。别催。'],
    music:['在弄音乐。你这一下差点让我弹错。', '在听唱片。', '音乐。……别吵。'],
    housework:['在收拾屋子。总得有人管管这地方。', '打扫呢。灰尘比我还老。', '收拾东西。……书又堆满了。'],
    occult:['在研究点……你不必知道的东西。', '在翻魔法书。别打扰。', '在画法阵。别进来，粉笔线还没干。'],
    watching:['在看点东西。不是在浪费时间，是在休息。', '看电视呢。节目很无聊。', '在看纪录片。错误百出。'],
    online:['在电脑前。别问我在看什么。', '上网呢。网上的人都很吵。', '查点资料。'],
    work:['在处理正事。给我五分钟。', '工作。……文件堆成山了。', '忙正事呢。你呢，作业写完了？'],
    resting:['在歇一会儿，安安静静的。被你戳醒了。', '歇着呢。', '什么都没干。……偶尔也要这样。'],
    drinking:['在家里小酌一杯。就一杯。', '喝一点。……别告诉别人。', '在喝酒。很少的那种。'],
    // 'hobby' covers the guitar, embroidery, models... the VPS doesn't say which, so neither does he.
    hobby:['在摆弄我自己的爱好。', '在做点自己喜欢的事。', '在弄我自己的东西。别凑过来看。'],
    exercise:['在活动筋骨。别笑。', '运动呢。……没喘。', '在锻炼。你也该动动。'],
    bathing:['在洗澡。……你戳得可真是时候。', '洗澡呢！别、别看！', '……浴室里。晚点再说。'],
    pub:['在酒馆。等我回来再说。', '酒馆。一品脱就够了。', '在酒馆，吵得很。'],
    museum:['在博物馆或画廊里逛。', '在博物馆。有几件展品……我认识。', '看展呢。'],
    park:['在公园里。', '公园。松鼠又胖了。', '在公园散步。'],
    market:['在逛市场。', '市场。苹果不错。', '在买东西。……别问买了什么。'],
    eating_out:['在外面吃饭。', '吃饭呢。外面的不如我做的……好吧，有时候比我做的好。', '在餐馆。'],
    walking:['在外面走走，四处看看。', '散步。腿要动一动。', '随便走走。'],
    fishing:['在钓鱼。安静点，鱼要被你吓跑了。', '钓鱼呢。一条都没有。', '在水边。很安静。']
  });
  // Meals today, who's with him, where exactly (from the VPS, when it says).
  const ROOM_LABELS = Object.freeze({sitting_room:'客厅', study:'书房', kitchen:'厨房', bedroom:'卧室', bathroom:'浴室',
    magic_room:'魔法室', hall:'门厅', spare_room:'客房', garden:'花园'});
  const MEAL_LABELS = Object.freeze({breakfast:'早饭', lunch:'午饭', dinner:'晚饭'});
  const ago = minutes => minutes < 60 ? `${Math.max(1, minutes)} 分钟` : `${Math.round(minutes / 60)} 个小时`;
  function mealLine(meals) {
    if (!meals) return '';
    if (meals.item && meals.last_minutes != null && meals.last_minutes < 120) return `刚吃了 ${meals.item}。`;
    const eaten = (meals.eaten || []).map(m => MEAL_LABELS[m]).filter(Boolean);
    if (eaten.length) return eaten.length === 1 ? `今天吃过${eaten[0]}了。` : `今天${eaten.join('、')}都吃了。`;
    if (meals.last_minutes != null) return `上一顿是${ago(meals.last_minutes)}前。`;
    return '';
  }
  function spotLine(spot) {
    if (!spot) return '';
    if (spot.kind === 'room') return `我在${spot.residence === 'hampshire_house' ? '汉普郡那边的' : ''}${ROOM_LABELS[spot.room] || '屋里'}。`;
    if (spot.kind === 'venue') return `我在 ${spot.label}。`;
    if (spot.kind === 'away') return spot.label ? `我在${spot.city}，${spot.label}。` : `我在${spot.city}。`;
    return '';
  }
  function companyLine(company) {
    if (!Array.isArray(company) || !company.length) return '';
    const names = list => list.map(p => p.name).join(' 和 ');
    const home = company.filter(p => p.with === 'home'), out = company.filter(p => p.with === 'outing');
    return [home.length ? `${names(home)} 在我这儿。` : '', out.length ? `跟 ${names(out)} 一起。` : ''].join('');
  }
  const ASKED_AGAIN = ['你刚才不是问过了吗。', '……还是一样。一分钟之内没那么多变化。', '你是记性不好，还是就想跟我说话？', '又问？……好吧。'];

  const LOCAL_STATE_LABELS = Object.freeze({
    awake:'醒着', happy:'心情不错', annoyed:'有点不高兴', bored:'有点无聊', sleepy:'犯困',
    sleep:'睡觉', waking:'刚醒', reading:'读东西', tea:'喝茶', visitor:'见客', outdoors:'在外面'
  });
  const LOCAL_MOTION_LABELS = Object.freeze({
    held:'被你拎着', 'head-pat':'被你摸头', jumping:'跳起来', landing:'刚落地', walking:'走路',
    guitar:'弹吉他', idle:'待着', 'hover-curious':'看你要做什么', 'hold-curious':'看你要做什么'
  });

  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const safeRemote = status => !!(status && status.applied === true && status.accepted === true &&
    status.can_drive_visual === true && status.stale === false && status.arthur &&
    (!Array.isArray(status.issues) || status.issues.length === 0));
  const safeLocalPreview = status => !!(status && status.schema_version === LOCAL_PREVIEW_SCHEMA &&
    status.host === 'mac' && status.mode === 'legacy-generation-zero' &&
    status.can_drive_visual === true && status.can_propose === false && status.arthur);

  function localSummary(snapshot) {
    const state = snapshot && LOCAL_STATE_LABELS[snapshot.state] ? LOCAL_STATE_LABELS[snapshot.state] : '运行着';
    const motionKey = snapshot && snapshot.desktop ? snapshot.desktop.motion : null;
    const motion = motionKey && LOCAL_MOTION_LABELS[motionKey] ? LOCAL_MOTION_LABELS[motionKey] : null;
    return motion && motion !== '待着' ? `${state}，正在${motion}` : state;
  }

  function answerFor(optionId, context={}) {
    const status = context.status || null;
    const snapshot = context.snapshot || null;
    const remoteIsSafe = safeRemote(status);
    const previewIsSafe = safeLocalPreview(status);
    const projectedIsSafe = remoteIsSafe || previewIsSafe;
    const petOnly = !!(global.document && global.document.body && global.document.body.classList.contains('pet-only'));
    const host = status && status.host === 'vps' ? 'VPS' : status && status.host === 'mac' ? 'Mac' : null;
    const safeSource = previewIsSafe ? 'Mac 本机只读预览' : `${host ? host + ' · ' : ''}已验证安全快照`;

    if (optionId === 'just-poke') {
      return {
        option_id:optionId,
        title:'……所以你就只是想戳我一下。',
        text:'很好，你已经戳到了。满意了吗？',
        source:'本地互动',
        remote:false
      };
    }

    if (optionId === 'status') {
      if (projectedIsSafe) {
        const arthur = status.arthur;
        const place = PLACE_LABELS[arthur.place] || PLACE_LABELS.unknown;
        const health = status.health || status.maintenance && status.maintenance.health || 'unknown';
        let text;
        if (arthur.availability === 'sleeping') text = pickLine([`我在${place}睡觉。直到你把我戳了一下。`, `……${place}，睡觉呢。`, `在${place}睡着呢。别吵。`]);
        else if (health === 'degraded' && !petOnly) text = `我在${place}，还在运行，不过维护状态有些不稳。`;
        else text = pickLine([`我在${place}，醒着，好好的。`, `在${place}。一切都好，别担心。`, `我在${place}。没什么事。……你呢？`, `${place}。挺好。`]);
        const weather = arthur.weather || {};
        const sky = {clear:'晴', cloud:'阴天', rain:'在下雨', fog:'起雾了', snow:'在下雪'}[weather.sky];
        const temp = {freezing:'冷得要命', cold:'挺冷', mild:'不冷不热', warm:'暖和', hot:'热'}[weather.temp];
        if (sky || temp) text += ` 我这边${[sky, temp].filter(Boolean).join('，')}。`;
        const meal = mealLine(arthur.meals);
        if (meal) text += ' ' + meal;
        if (arthur.letter === 'waiting') text += ' 另外，我给你发了消息。';
        return {option_id:optionId, title:'现在的状态', text, source:safeSource, remote:remoteIsSafe};
      }
      return {
        option_id:optionId,
        title:'现在的状态',
        text:petOnly ? `我现在是${localSummary(snapshot)}。` : `桌宠本地运行正常；我现在是${localSummary(snapshot)}。VPS 状态暂时没有可靠快照。`,
        source:'本地桌宠 · 远端未知',
        remote:false
      };
    }

    if (optionId === 'activity') {
      if (projectedIsSafe) {
        const key = status.arthur.activity && status.arthur.activity.key || 'unknown';
        const detail = status.arthur.activity && status.arthur.activity.detail;
        const where = [spotLine(status.arthur.spot), companyLine(status.arthur.company)].filter(Boolean).join(' ');
        return {
          option_id:optionId,
          title:'我在做什么',
          text:pickLine((detail && DETAIL_LABELS[detail]) || ACTIVITY_LABELS[key] || ACTIVITY_LABELS.unknown) + (where ? ' ' + where : ''),
          source:safeSource,
          remote:remoteIsSafe
        };
      }
      return {
        option_id:optionId,
        title:'我在做什么',
        text:petOnly ? `我现在是${localSummary(snapshot)}。` : `这个窗口里，我现在是${localSummary(snapshot)}。VPS 上的实际活动暂时读不到。`,
        source:'本地桌宠 · 远端未知',
        remote:false
      };
    }

    return {
      option_id:'unknown',
      title:'没听清。',
      text:'再选一次。',
      source:'本地互动',
      remote:false
    };
  }

  class ArthurLocalPokeMenu {
    constructor(options={}) {
      this.runtime = options.runtime || null;
      this.statusProvider = typeof options.statusProvider === 'function' ? options.statusProvider : () => null;
      this.snapshotProvider = typeof options.snapshotProvider === 'function'
        ? options.snapshotProvider
        : () => this.runtime && typeof this.runtime.getDesktopSnapshot === 'function' ? this.runtime.getDesktopSnapshot() : null;
      this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
      this.document = options.document || global.document || null;
      this.window = options.window || global;
      this.root = options.root || (this.document && this.document.querySelector('#arthurPokeMenu')) || null;
      this.panel = this.root && this.root.querySelector('[data-poke-panel]');
      this.question = this.root && this.root.querySelector('[data-poke-question]');
      this.response = this.root && this.root.querySelector('[data-poke-response]');
      this.responseTitle = this.root && this.root.querySelector('[data-poke-response-title]');
      this.responseText = this.root && this.root.querySelector('[data-poke-response-text]');
      this.responseSource = this.root && this.root.querySelector('[data-poke-response-source]');
      this.wardrobe = options.wardrobe || null;
      this.host = options.host || null;
      this.pendingOutfit = null;
      this.wardrobeScreen = this.root && this.root.querySelector('[data-poke-wardrobe]');
      this.wardrobeOptions = this.root && this.root.querySelector('[data-poke-wardrobe-options]');
      this.untilScreen = this.root && this.root.querySelector('[data-poke-until]');
      this.untilTitle = this.root && this.root.querySelector('[data-poke-until-title]');
      this.untilOptions = this.root && this.root.querySelector('[data-poke-until-options]');
      this.active = false;
      this.lastPayload = null;
      this.lastAnswer = null;
      this._boundKeydown = event => {
        if (event.key === 'Escape' && this.active) this.close('escape');
      };
      this._bind();
      if (this.root && this.root.dataset) this.root.dataset.pokeMenuBuild = MENU_BUILD;
    }

    _bind() {
      if (!this.root) return;
      this.root.querySelectorAll('[data-poke-option]').forEach(button => {
        button.addEventListener('click', () => this.select(button.dataset.pokeOption));
      });
      this.root.querySelectorAll('[data-poke-close]').forEach(button => {
        button.addEventListener('click', () => this.close('button'));
      });
      this.root.addEventListener('pointerdown', event => {
        if (event.target === this.root) this.close('backdrop');
      });
      if (this.document) this.document.addEventListener('keydown', this._boundKeydown);
    }

    _screen(name) {
      if (this.question) this.question.hidden = name !== 'question';
      if (this.response) this.response.hidden = name !== 'response';
      if (this.wardrobeScreen) this.wardrobeScreen.hidden = name !== 'wardrobe';
      if (this.untilScreen) this.untilScreen.hidden = name !== 'until';
      // Screens differ in height (the wardrobe is tall): keep the panel inside the window.
      if (this.active) {
        const anchor = this.lastPayload && this.lastPayload.anchor || null;
        // Again once the screen's buttons are filled in (they're added after this).
        if (this.window.setTimeout) this.window.setTimeout(() => this._position(anchor), 0);
        this._position(anchor);
      }
    }

    _showQuestion() {
      this._screen('question');
    }

    _button(label, onClick, extraClass='') {
      const button = this.document.createElement('button');
      button.type = 'button';
      button.className = `poke-option ${extraClass}`.trim();
      button.textContent = label;
      button.addEventListener('click', onClick);
      return button;
    }

    _showWardrobe() {
      this._screen('wardrobe');
      if (!this.wardrobeOptions || !this.document) return;
      this.wardrobeOptions.textContent = '';
      const current = this.wardrobe ? this.wardrobe.current() : {mode:'auto'};
      WARDROBE.forEach(item => {
        const button = this._button(item.label, () => this.chooseOutfit(item.mode));
        if (current.mode === item.mode) button.classList.add('current');
        this.wardrobeOptions.appendChild(button);
      });
      if (current.mode && current.mode !== 'auto') {
        this.wardrobeOptions.appendChild(this._button('让他换回自己的', () => this.chooseOutfit('auto'), 'wide'));
      }
    }

    chooseOutfit(mode) {
      if (!this.wardrobe) return false;
      const now = Date.now();
      if (mode === 'auto') {
        this.wardrobe.choose('auto', null);
        this.pendingOutfit = null;
        this._showAnswer({title:'谢天谢地。', text:'我自己会挑衣服，多谢。', source:'换衣服'});
        this.onEvent({type:'poke-menu-outfit', value:'auto'});
        return true;
      }
      const item = WARDROBE.find(entry => entry.mode === mode);
      if (!item) return false;
      // Sulking: the right outfit makes it up (and he keeps it on for an hour).
      if (this.grudge && this.grudge.active()) {
        this.wardrobe.choose(mode, now + HOUR);
        if (this.grudge.offer('outfit', mode) === 'made-up') { this.close('made-up'); return true; }
        this._showAnswer({title:item.label, text:'他换上了，脸还是臭的。', source:'他在生气'});
        return true;
      }
      // On straight away; if she walks off without answering, it comes off in an hour.
      this.wardrobe.choose(mode, now + HOUR);
      this.pendingOutfit = item;
      this._screen('until');
      if (this.untilTitle) this.untilTitle.textContent = item.silent ? item.grumble : `${item.grumble}什么时候能脱掉？`;
      if (item.silent && this.runtime && this.runtime.act) this.runtime.act('glare');   // not a word: he just glares
      if (this.untilOptions && this.document) {
        this.untilOptions.textContent = '';
        UNTIL.forEach(option => this.untilOptions.appendChild(this._button(option.label, () => this.chooseUntil(option.id))));
      }
      this.onEvent({type:'poke-menu-outfit', value:mode});
      return true;
    }

    _choices(title, options, onPick) {
      this._screen('until');
      if (this.untilTitle) this.untilTitle.textContent = title;
      if (this.untilOptions && this.document) {
        this.untilOptions.textContent = '';
        options.forEach(option => this.untilOptions.appendChild(this._button(option.label, () => onPick(option))));
      }
    }

    // What he has on him: tap to hear about it, press and hold to snatch it.
    _showPockets() {
      const items = this.pockets ? this.pockets.list() : [];
      if (!items.length) {
        this._showAnswer({title:'口袋里', text:'……空的。别翻了。', source:'他身上的东西'});
        return;
      }
      this._screen('until');
      if (this.untilTitle) {
        this.untilTitle.textContent = '……你想干什么？';
        if (this.document) {   // how to steal is a hint for her, not something he says
          const hint = this.document.createElement('small');
          hint.className = 'poke-hint'; hint.textContent = '长按可以偷走';
          this.untilTitle.appendChild(hint);
        }
      }
      if (!this.untilOptions || !this.document) return;
      this.untilOptions.textContent = '';
      items.forEach(item => {
        const button = this._button(`${item.icon} ${item.name}`, () => {
          if (button.dataset.stolen) return;
          this._showAnswer({title:`${item.icon} ${item.name}`, text:item.about || '……这是我的。', source:'他身上的东西'});
        });
        let pressTimer = null;
        const cancel = () => { global.clearTimeout(pressTimer); pressTimer = null; };
        button.addEventListener('pointerdown', event => {
          cancel();
          pressTimer = global.setTimeout(() => {
            button.dataset.stolen = '1';
            if (this.onSteal) this.onSteal(item, event);
            this.close('stolen');
          }, 380);
        });
        button.addEventListener('pointerup', cancel);
        button.addEventListener('pointerleave', () => { if (pressTimer) { cancel(); /* left the button while pressing: snatch now */ button.dataset.stolen = '1'; if (this.onSteal) this.onSteal(item); this.close('stolen'); } });
        this.untilOptions.appendChild(button);
      });
    }

    _showGifts() {
      this._choices('给我什么？', GIFTS, gift => this.give(gift.id));
    }

    give(id) {
      const gift = GIFTS.find(entry => entry.id === id);
      if (!gift) return false;
      if (this.grudge && this.grudge.active()) {
        const result = this.grudge.offer('gift', id);
        if (result === 'made-up') {
          if (this.runtime) {
            this.runtime.localHoldUntil = Date.now() + gift.holdMs;
            if (typeof this.runtime.setLifeState === 'function') this.runtime.setLifeState(gift.state);
          }
          this.close('made-up');
        } else {
          this._showAnswer({title:gift.label, text:'他收下了，但还是背过脸去。', source:'他在生气'});
        }
        this.onEvent({type:'poke-menu-gift', value:id});
        return true;
      }
      const runtime = this.runtime;
      const asleep = runtime && (runtime.state === 'sleep' || runtime.sleepSequence);
      if (asleep) {
        this._showAnswer({title:gift.label, text:'他睡着了。你把东西轻轻放在他旁边。', source:'给他东西'});
      } else {
        if (runtime) {
          runtime.localHoldUntil = Date.now() + gift.holdMs;
          if (typeof runtime.setLifeState === 'function') runtime.setLifeState(gift.state);
        }
        const today = new Date().toDateString();
        const given = this._giftsToday && this._giftsToday.day === today ? this._giftsToday : (this._giftsToday = {day:today});
        given[id] = (given[id] || 0) + 1;
        this._showAnswer({title:gift.label, text:pickLine(given[id] > 1 ? gift.again : gift.reply), source:'给他东西'});
      }
      if (this.onGift) this.onGift(id);
      this.onEvent({type:'poke-menu-gift', value:id});
      return true;
    }

    _showAway() {
      if (!this.host) {
        this._showAnswer({title:'……走开？', text:'这个只有在桌面上的我才做得到。', source:'本地互动'});
        return;
      }
      this._choices('……走就走。多久？', AWAY, option => this.sendAway(option.id));
    }

    sendAway(id) {
      const option = AWAY.find(entry => entry.id === id);
      if (!option || !this.host) return false;
      this.host.post({type:'leave', until:option.at(Date.now())});
      this.close('away');
      if (this.speech) this.speech.say(option.id === 'call' ? '……行。想我了再叫。不是说我会想你。' : '走就走。', 4500);
      this.onEvent({type:'poke-menu-away', value:id});
      return true;
    }

    chooseUntil(id) {
      const option = UNTIL.find(entry => entry.id === id);
      if (!option || !this.pendingOutfit || !this.wardrobe) return false;
      this.wardrobe.choose(this.pendingOutfit.mode, option.at(Date.now()));
      this._showAnswer({title:this.pendingOutfit.label, text:option.reply, source:'换衣服'});
      this.pendingOutfit = null;
      this.onEvent({type:'poke-menu-outfit-until', value:id});
      return true;
    }

    _showAnswer(answer) {
      this._screen('response');
      if (this.responseTitle) this.responseTitle.textContent = answer.title;
      if (this.responseText) this.responseText.textContent = answer.text;
      if (this.responseSource) this.responseSource.textContent = answer.source;
    }

    _position(anchor) {
      if (!this.panel) return;
      const viewWidth = Number(this.window.innerWidth) || 1024;
      const viewHeight = Number(this.window.innerHeight) || 768;
      const rect = this.panel.getBoundingClientRect ? this.panel.getBoundingClientRect() : {width:310,height:280};
      const width = rect.width || 310;
      const height = rect.height || 280;
      const rawX = anchor && Number.isFinite(Number(anchor.clientX)) ? Number(anchor.clientX) + 14 : (viewWidth-width)/2;
      const rawY = anchor && Number.isFinite(Number(anchor.clientY)) ? Number(anchor.clientY) + 12 : (viewHeight-height)/2;
      const x = Math.max(12, Math.min(rawX, viewWidth - width - 12));
      const belowFits = rawY + height <= viewHeight - 12;
      const aboveY = anchor && Number.isFinite(Number(anchor.clientY)) ? Number(anchor.clientY) - height - 12 : rawY;
      const y = Math.max(12, Math.min(belowFits ? rawY : aboveY, viewHeight - height - 12));
      this.panel.style.left = `${Math.round(x)}px`;
      this.panel.style.top = `${Math.round(y)}px`;
    }

    open(payload={}) {
      if (!this.root) return false;
      const readButton = this.root.querySelector('[data-poke-option="letter-read"]');
      if (readButton) readButton.hidden = !(this.letters && this.letters.unread());
      this.lastPayload = clone(payload) || {};
      this.lastAnswer = null;
      this._showQuestion();
      this.root.hidden = false;
      this.root.setAttribute('aria-hidden', 'false');
      this.active = true;
      this._position(payload.anchor || null);
      if (this.window.requestAnimationFrame) this.window.requestAnimationFrame(() => this.root.classList.add('open'));
      else this.root.classList.add('open');
      const first = this.root.querySelector('[data-poke-option]');
      if (first && first.focus) first.focus({preventScroll:true});
      this.onEvent({type:'poke-menu', value:'open'});
      return true;
    }

    select(optionId) {
      // Sulking: most things get a 'hmph'; something to eat or drink makes it up.
      if (this.grudge && this.grudge.active() && !['gift','away','letter-read','wardrobe'].includes(optionId)) {
        let sulk = this.grudge.sulkLine();
        const tag = /^@(\w+)\s*/.exec(sulk);   // a move, not words: he does it, the panel says little
        if (tag) { if (this.runtime && this.runtime.act) this.runtime.act(tag[1]); sulk = sulk.slice(tag[0].length) || '……'; }
        this._showAnswer({title:'哼。', text:sulk, source:'他在生气'});
        return null;
      }
      if (optionId === 'letter-read') {
        const id = this.letters && this.letters.unread();
        if (id) this.letters.markRead(id);
        this._showAnswer({title:'……看过就好。', text:'回不回随你。我又不是在等。', source:'信封'});
        return null;
      }
      if (optionId === 'gift') { this._showGifts(); return null; }
      if (optionId === 'pockets') { this._showPockets(); return null; }
      if (optionId === 'magic') { this.close('magic'); if (typeof this.onMagic === 'function') this.onMagic(); return null; }
      if (optionId === 'away') { this._showAway(); return null; }
      if (optionId === 'wardrobe' && this.wardrobe) {
        this._showWardrobe();
        this.onEvent({type:'poke-menu-choice', value:optionId, source:'换衣服'});
        return null;
      }
      const asked = this._askedAt || (this._askedAt = {});
      const again = (optionId === 'status' || optionId === 'activity') && Date.now() - (asked[optionId] || 0) < 60000;
      asked[optionId] = Date.now();
      const answer = answerFor(optionId, {
        status:this.statusProvider(),
        snapshot:this.snapshotProvider()
      });
      if (again) answer.text = `${pickLine(ASKED_AGAIN)} ${answer.text}`;
      this.lastAnswer = answer;
      this._showAnswer(answer);
      if (optionId === 'just-poke' && this.runtime && typeof this.runtime.acknowledgePoke === 'function') {
        this.runtime.acknowledgePoke();
      }
      this.onEvent({type:'poke-menu-choice', value:optionId, source:answer.source});
      const close = this.response && this.response.querySelector('[data-poke-close]');
      if (close && close.focus) close.focus({preventScroll:true});
      return clone(answer);
    }

    close(reason='close') {
      if (!this.root || !this.active) return false;
      this.active = false;
      this.root.classList.remove('open');
      this.root.setAttribute('aria-hidden', 'true');
      const finish = () => { if (!this.active) this.root.hidden = true; };
      if (this.window.setTimeout) this.window.setTimeout(finish, 150);
      else finish();
      this.onEvent({type:'poke-menu', value:`close:${reason}`});
      return true;
    }

    // Now and then the dimmed backdrop stayed up with no panel to be seen (she saw him
    // greyed out after leaving the outfit-length screen). Checked every 1.5 s: a shown
    // backdrop that isn't active is hidden; an active panel that's empty or out of the
    // window is put back in view, or the menu closed.
    heal() {
      if (!this.root || this.root.hidden) return null;
      if (!this.active) {
        this.root.classList.remove('open'); this.root.hidden = true;
        this.onEvent({type:'poke-menu', value:'heal:stale-backdrop'});
        return 'stale';
      }
      if (!this.panel || !this.panel.getBoundingClientRect) return null;
      const screens = [this.question, this.response, this.wardrobeScreen, this.untilScreen].filter(Boolean);
      if (screens.length && screens.every(s => s.hidden)) { this.close('heal-empty'); return 'empty'; }
      const r = this.panel.getBoundingClientRect();
      const w = Number(this.window.innerWidth) || 0, h = Number(this.window.innerHeight) || 0;
      if (w && h && (r.width < 40 || r.height < 40 || r.right < 30 || r.bottom < 30 || r.left > w - 30 || r.top > h - 30)) {
        this._position(null);
        this.onEvent({type:'poke-menu', value:'heal:off-screen'});
        return 'moved';
      }
      return null;
    }

    handleInteractionRequest(payload={}) {
      if (payload.type === 'menu') return this.open(payload);
      return false;
    }

    destroy() {
      if (this.document) this.document.removeEventListener('keydown', this._boundKeydown);
      this.close('destroy');
    }
  }

  ArthurLocalPokeMenu.menuBuild = MENU_BUILD;
  ArthurLocalPokeMenu.options = OPTIONS;
  ArthurLocalPokeMenu.answerFor = answerFor;
  ArthurLocalPokeMenu.wardrobe = WARDROBE;
  ArthurLocalPokeMenu.gifts = GIFTS;
  ArthurLocalPokeMenu.away = AWAY;
  ArthurLocalPokeMenu.until = UNTIL;
  ArthurLocalPokeMenu.isSafeRemoteStatus = safeRemote;
  ArthurLocalPokeMenu.isSafeLocalPreview = safeLocalPreview;
  global.ArthurLocalPokeMenu = ArthurLocalPokeMenu;
})(typeof window !== 'undefined' ? window : globalThis);
