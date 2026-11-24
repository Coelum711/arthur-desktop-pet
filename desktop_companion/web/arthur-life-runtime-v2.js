(function (global) {
  'use strict';

  const OUTFITS = ['pajamas','homewear','coat','raincoat','tweed','jumper','city','dress','trench','pirate','punk','gown','garden','angel','barbour','maid'];
  const LIFE_STATES = ['awake','happy','annoyed','bored','sleepy','sleep','waking','reading','tea','visitor','outdoors'];
  const MOODS = ['calm','happy','excited','annoyed','bored','sleepy','anxious'];
  const EXPRESSIONS = ['mood','neutral','happy','annoyed','bored','sleepy','surprised'];
  const ACTIONS = ['blink','look-left','look-right','speak','yawn','sip','page-turn','excited-tail','tail-thump','startle','click-reaction','drag-lift'];
  const VISEMES = ['idle','a','i','u','e','o','open','schwa','ae','uu','oo','w','f','th','m'];
  const ARPABET = {
    AA:'a',AE:'ae',AH:'schwa',ER:'schwa',AO:'oo',AW:'a',AY:'a',EH:'e',EY:'e',IH:'i',IY:'i',
    OW:'o',OY:'o',UH:'uu',UW:'u',B:'m',P:'m',M:'m',F:'f',V:'f',TH:'th',DH:'th',W:'w'
  };
  const AUTO_WEIGHTS = { awake:.24, reading:.19, tea:.15, bored:.12, happy:.11, annoyed:.07, sleepy:.12 };
  const ACTION_CHANNEL = {'look-left':'gaze','look-right':'gaze',speak:'mouth',yawn:'mouth',sip:'prop','page-turn':'prop','excited-tail':'tail','tail-thump':'tail',startle:'body','drag-lift':'body','click-reaction':'reaction'};
  const POSES = {
    awake:   {rootY:0, rootR:0, rootS:1, headY:0, headR:0, handLX:0,handLY:0,handRX:0,handRY:0, gazeX:0,gazeY:0, eye:1, tail0:0,tail1:0,tail2:0},
    happy:   {rootY:-7,rootR:0, rootS:1.01,headY:-2,headR:0, handLX:-5,handLY:-8,handRX:5,handRY:-8,gazeX:0,gazeY:-1,eye:1,tail0:-3,tail1:-5,tail2:-7},
    annoyed: {rootY:1, rootR:-1.2,rootS:1,headY:1,headR:2.3,handLX:6,handLY:5,handRX:-6,handRY:5,gazeX:-3,gazeY:1,eye:.72,tail0:6,tail1:8,tail2:11},
    bored:   {rootY:4, rootR:0,rootS:.995,headY:5,headR:-2,handLX:3,handLY:8,handRX:-3,handRY:8,gazeX:3,gazeY:5,eye:.58,tail0:1,tail1:2,tail2:3},
    sleepy:  {rootY:6, rootR:-1,rootS:.99,headY:8,headR:-4,handLX:2,handLY:7,handRX:-2,handRY:7,gazeX:0,gazeY:5,eye:.43,tail0:0,tail1:1,tail2:1},
    sleep:   {rootY:12,rootR:-2.5,rootS:.98,headY:15,headR:-7,handLX:5,handLY:11,handRX:-5,handRY:11,gazeX:0,gazeY:0,eye:.05,tail0:2,tail1:3,tail2:4},
    waking:  {rootY:7, rootR:1.4,rootS:1,headY:8,headR:4,handLX:-4,handLY:-4,handRX:4,handRY:-4,gazeX:0,gazeY:-3,eye:.76,tail0:-2,tail1:-3,tail2:-4},
    reading: {rootY:3, rootR:0,rootS:1,headY:6,headR:2.2,handLX:42,handLY:83,handRX:-42,handRY:83,gazeX:0,gazeY:8,eye:.74,tail0:0,tail1:2,tail2:3},
    tea:     {rootY:1, rootR:0,rootS:1,headY:1,headR:-1,handLX:8,handLY:7,handRX:-45,handRY:55,gazeX:5,gazeY:3,eye:.86,tail0:-1,tail1:-2,tail2:-3},
    visitor: {rootY:-3,rootR:0,rootS:1.01,headY:-2,headR:1.2,handLX:-4,handLY:-2,handRX:4,handRY:-2,gazeX:7,gazeY:0,eye:1,tail0:-2,tail1:-4,tail2:-6},
    outdoors:{rootY:-5,rootR:0,rootS:1.01,headY:-1,headR:-1,handLX:-9,handLY:-5,handRX:9,handRY:-5,gazeX:1,gazeY:0,eye:1,tail0:-4,tail1:-6,tail2:-8}
  };

  const EASE = {
    linear: t => t,
    'ease-out': t => 1 - Math.pow(1 - t, 3),
    'ease-in-out': t => t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2,
    spring: t => 1 - Math.exp(-7*t) * Math.cos(10*t)
  };
  const clone = obj => Object.fromEntries(Object.entries(obj).map(([k,v]) => [k, Number(v)]));
  const mix = (a,b,t) => Object.fromEntries(Object.keys(b).map(k => [k, a[k] + (b[k]-a[k])*t]));

  class ArthurLifeRuntime {
    constructor(svg, options={}) {
      if (!svg || String(svg.tagName).toLowerCase() !== 'svg') throw new Error('ArthurLifeRuntime expects an SVG element');
      this.svg = svg;
      this.q = id => svg.querySelector('#'+id);
      this.qa = sel => [...svg.querySelectorAll(sel)];
      this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
      this.state = LIFE_STATES.includes(options.state) ? options.state : 'awake';
      this.mood = MOODS.includes(options.mood) ? options.mood : 'calm';
      this.expression = EXPRESSIONS.includes(options.expression) ? options.expression : 'mood';
      this.viseme = 'idle';
      this.outfitMode = options.outfit || 'auto';
      this.outfit = 'pajamas';
      this.duration = Number(options.duration) || 720;
      this.easing = options.easing || 'ease-in-out';
      this.idleIntensity = options.idleIntensity == null ? 1 : Number(options.idleIntensity);
      this.idleRunning = options.idle !== false;
      this.currentPose = clone(POSES[this.state]);
      this.transition = null;
      this.actions = new Map();
      this.pendingState = null;
      this.autoLife = false;
      this.autoTimer = null;
      this.speechTimers = [];
      this._actionMouthActive = false;
      this._mouthResetTimer = null;
      this.blinkStart = 0;
      this.blinkDuration = 0;
      this.nextBlink = performance.now() + 1400 + Math.random()*1700;
      this.destroyed = false;
      this._last = performance.now();
      this._prepare();
      this._setStateVisibility(this.state);
      this._emit('ready', this.state);
      this._frame = this._frame.bind(this);
      this.raf = requestAnimationFrame(this._frame);
    }

    _prepare() {
      this.qa('.motion-node').forEach(node => {
        node.style.transformBox = 'view-box';
        const pivot = node.dataset.pivot;
        if (pivot) { const [x,y] = pivot.split(','); node.style.transformOrigin = `${x}px ${y}px`; }
      });
      this._hideAllMouths();
      this._display(this.q('g-mouth-neutral'), true);
      this._display(this.q('expression-closed-eyes'), false);
      this._display(this.q('overlay-book'), false);
      this._display(this.q('overlay-tea'), false);
      this._display(this.q('overlay-zzz'), false);
      this._display(this.q('overlay-bubble'), false);
    }

    _emit(type, value='') { this.onEvent({type,value,state:this.state,mood:this.mood,expression:this.expression}); }
    _display(el, on) { if (!el) return; el.style.display = on ? 'inline' : 'none'; el.style.opacity = on ? '1' : '0'; }
    _hideAllMouths() {
      ['g-mouth-neutral','g-mouth-smile','g-mouth-open-small','g-mouth-open-wide','g-mouth-pout', ...VISEMES.slice(1).map(v=>'g-viseme-'+v)]
        .forEach(id => this._display(this.q(id), false));
    }
    _resolvedOutfit(state=this.state) {
      if (this.outfitMode !== 'auto') return this.outfitMode;
      if (['visitor','outdoors'].includes(state)) return 'coat';
      // At home: proper clothes by day, pyjamas for sleeping and late at night.
      const hour = new Date().getHours();
      return state === 'sleep' || state === 'sleepy' || hour >= 22 || hour < 7 ? 'pajamas' : 'homewear';
    }
    _resolvedFace() {
      if (this.expression !== 'mood') return this.expression;
      return ({calm:'neutral',happy:'happy',excited:'happy',annoyed:'annoyed',bored:'bored',sleepy:'sleepy',anxious:'surprised'}[this.mood] || 'neutral');
    }
    _applyOutfit(state=this.state) {
      this.outfit = this._resolvedOutfit(state);
      // Each outfit may bring a hat (head) and a prop (hand) of the same name.
      OUTFITS.forEach(name => {
        this._display(this.q('outfit-'+name), this.outfit === name);
        this._display(this.q('hat-'+name), this.outfit === name);
      });
      this._display(this.q('prop-umbrella'), this.outfit === 'city');
    }
    _setStateVisibility(state) {
      this._applyOutfit(state);
      this._display(this.q('overlay-book'), state === 'reading');
      this._display(this.q('overlay-tea'), state === 'tea');
      this._display(this.q('overlay-zzz'), state === 'sleep');
      this._applyFace();
    }
    _applyFace(actionMouth=null) {
      this._hideAllMouths();
      const mouth = actionMouth || this.viseme;
      if (mouth && mouth !== 'idle') this._display(this.q('g-viseme-'+mouth), true);
      else if (this.state === 'sleep') this._display(this.q('g-mouth-open-small'), true);
      else {
        const face = this._resolvedFace();
        if (face === 'happy') this._display(this.q('g-mouth-smile'), true);
        else if (face === 'annoyed') this._display(this.q('g-mouth-pout'), true);
        else if (face === 'surprised') this._display(this.q('g-mouth-open-small'), true);
        else this._display(this.q('g-mouth-neutral'), true);
      }
    }

    _scheduleMouthReset(durationMs) {
      clearTimeout(this._mouthResetTimer);
      this._mouthResetTimer = setTimeout(() => {
        this._mouthResetTimer = null;
        if (this.destroyed) return;
        this._actionMouthActive = false;
        this._applyFace();
      }, Math.max(60, Number(durationMs) || 0) + 48);
    }

    setLifeState(next, options={}) {
      if (!LIFE_STATES.includes(next)) throw new Error('Unknown life state: '+next);
      if (this.state === 'sleep' && next !== 'sleep' && next !== 'waking' && !options.skipGuard) {
        this.pendingState = next;
        this._emit('guard', 'sleep → waking → '+next);
        return this.setLifeState('waking', {skipGuard:true});
      }
      if (next === this.state && !this.transition) return;
      const now = performance.now();
      this.transition = {from:clone(this.currentPose),to:clone(POSES[next]),start:now,duration:options.duration || this.duration,next};
      this._setStateVisibility(next);
      this._emit('transition-start', this.state+' → '+next);
    }
    setMood(next) {
      if (!MOODS.includes(next)) throw new Error('Unknown mood: '+next);
      this.mood = next;
      this._applyFace();
      this._emit('mood', next);
    }
    setExpression(next) {
      if (!EXPRESSIONS.includes(next)) throw new Error('Unknown expression: '+next);
      this.expression = next;
      this._applyFace();
      this._emit('expression', next);
    }
    setEmotion(next) { this.setExpression(next); }
    setViseme(next) {
      if (!VISEMES.includes(next)) throw new Error('Unknown viseme: '+next);
      this.viseme = next;
      this._applyFace();
      this._emit('viseme', next);
    }
    setOutfit(next) {
      if (next !== 'auto' && next !== 'nude' && !OUTFITS.includes(next)) throw new Error('Unknown outfit: '+next);
      this.outfitMode = next;
      this._applyOutfit();
      this._emit('outfit', this.outfit);
    }
    setEasing(name) { this.easing = EASE[name] ? name : 'ease-in-out'; this._emit('easing', this.easing); }
    setDuration(ms) { this.duration = Math.max(100, Number(ms)||720); }
    setIdleIntensity(value) { this.idleIntensity = Math.max(0, Number(value)||0); }
    setIdle(on) { this.idleRunning = !!on; this._emit('idle', on ? 'on':'off'); }

    blink() {
      const now = performance.now();
      this.blinkStart = now;
      this.blinkDuration = 245;
      this.nextBlink = now + 2200 + Math.random()*2600;
      this._emit('action', 'blink');
    }
    _blinkScale(now) {
      if (!this.blinkDuration) return 1;
      const t = (now-this.blinkStart)/this.blinkDuration;
      if (t >= 1) { this.blinkDuration = 0; return 1; }
      if (t < .25) return 1 - (t/.25)*.5;
      if (t < .45) return .5 - ((t-.25)/.2)*.42;
      if (t < .72) return .08 + ((t-.45)/.27)*.42;
      return .5 + ((t-.72)/.28)*.5;
    }
    playAction(name) {
      if (!ACTIONS.includes(name)) throw new Error('Unknown action: '+name);
      if (name === 'blink') return this.blink();
      const durations = { 'look-left':900,'look-right':900,speak:1400,yawn:1300,sip:1450,'page-turn':1200,'excited-tail':1550,'tail-thump':900,startle:850,'click-reaction':1500,'drag-lift':1300 };
      const channel=ACTION_CHANNEL[name]||'body';
      this.actions.set(channel,{name,channel,start:performance.now(),duration:durations[name]||1000});
      if (['speak','yawn','sip','startle','click-reaction'].includes(name)) this._scheduleMouthReset(durations[name]||1000);
      if (name === 'click-reaction') { const text=this.q('bubble-text'); if(text)text.textContent='Honestly!'; this._display(this.q('overlay-bubble'),true); }
      this._emit('action', name);
    }
    speakArpabet(sequence, step=150) {
      this.speechTimers.forEach(clearTimeout); this.speechTimers=[];
      const tokens = String(sequence).toUpperCase().split(/[\s,\/|]+/).map(v=>v.replace(/[012]$/,'')).filter(Boolean);
      const mapped = tokens.map(token => ARPABET[token] || 'idle');
      mapped.forEach((viseme,index) => this.speechTimers.push(setTimeout(()=>this.setViseme(viseme),index*step)));
      this.speechTimers.push(setTimeout(()=>this.setViseme('idle'),mapped.length*step+80));
      this._emit('speech', mapped.join(' · '));
      return mapped;
    }

    _actionOffsets(now) {
      const out={rootX:0,rootY:0,rootR:0,headX:0,headY:0,headR:0,handLX:0,handLY:0,handRX:0,handRY:0,wholeTail:0,tail0:0,tail1:0,tail2:0,gazeX:0,gazeY:0,bookR:0,cupX:0,cupY:0,cupR:0,actionMouth:null};
      if (!this.actions.size) {
        if (this._actionMouthActive) { this._actionMouthActive=false; this._applyFace(); }
        return out;
      }
      let faceNeedsReset=false;
      for(const [channel,a] of [...this.actions]){
        const t=Math.min(1,(now-a.start)/a.duration), wave=Math.sin(t*Math.PI), swing=Math.sin(t*Math.PI*2);
        if(t>=1){if(a.name==='click-reaction')this._display(this.q('overlay-bubble'),false);if(channel==='mouth'||['sip','startle','click-reaction'].includes(a.name))faceNeedsReset=true;this.actions.delete(channel);continue;}
        if(a.name==='look-left') out.gazeX+=-11*wave;
        if(a.name==='look-right') out.gazeX+=11*wave;
        if(a.name==='speak'){out.headR+=1.2*swing;out.actionMouth=t%0.28<.14?'a':'e';}
        if(a.name==='yawn'){out.headR+=-5*wave;out.headY+=4*wave;out.actionMouth='open';}
        if(a.name==='sip'){out.handRX+=-28*wave;out.handRY+=-82*wave;out.cupX+=-28*wave;out.cupY+=-82*wave;out.cupR+=-8*wave;out.headR+=3*wave;if(t>.45&&t<.78)out.actionMouth='u';}
        if(a.name==='page-turn'){out.bookR+=3*swing;out.handRX+=-22*wave;out.handRY+=-28*wave;}
        if(a.name==='excited-tail'){out.wholeTail+=13*Math.sin(t*Math.PI*6)*wave;out.tail0+=3*Math.sin(t*Math.PI*6-.25)*wave;out.tail1+=6*Math.sin(t*Math.PI*6-.55)*wave;out.tail2+=9*Math.sin(t*Math.PI*6-.9)*wave;}
        if(a.name==='tail-thump'){out.tail0+=12*swing;out.tail1+=20*swing;out.tail2+=28*swing;}
        if(a.name==='startle'){out.rootY+=-28*wave;out.rootR+=2*swing;out.headY+=-12*wave;out.handLX+=-18*wave;out.handRX+=18*wave;out.actionMouth='open';}
        if(a.name==='click-reaction'){out.headR+=3*swing;out.gazeX+=7*wave;out.handRY+=-18*wave;if(t>.22&&t<.7)out.actionMouth='a';}
        if(a.name==='drag-lift'){out.rootY+=-48*wave;out.rootR+=5*swing;out.tail0+=-8*wave;out.tail1+=-12*wave;out.tail2+=-16*wave;}
      }
      if(out.actionMouth)this._actionMouthActive=true;
      else if(this._actionMouthActive||faceNeedsReset){this._actionMouthActive=false;this._applyFace();}
      return out;
    }

    _idleOffsets(now) {
      const z={rootY:0,rootR:0,rootS:0,headY:0,headR:0,handY:0,wholeTail:0,tail0:0,tail1:0,tail2:0,hair:0,gazeX:0,gazeY:0,zzzY:0,steamY:0};
      if (!this.idleRunning || this.idleIntensity===0) return z;
      const s=now/1000, k=this.idleIntensity, breathe=Math.sin(s*1.65), slow=Math.sin(s*.82), lively=Math.sin(s*2.55);
      z.rootY=breathe*2.8*k;z.rootS=breathe*.006*k;z.headY=-breathe*1.5*k;z.headR=slow*.45*k;z.handY=breathe*1.8*k;z.hair=slow*.42*k;
      z.tail0=Math.sin(s*1.1)*1.4*k;z.tail1=Math.sin(s*1.1-.35)*2.3*k;z.tail2=Math.sin(s*1.1-.7)*3.3*k;
      if(this.state==='happy'||this.mood==='happy'||this.mood==='excited'){z.rootY+=Math.abs(lively)*-3*k;z.headR+=lively*.7*k;}
      if(this.mood==='happy'){z.wholeTail+=lively*5.5*k;z.tail1+=Math.sin(s*2.55-.35)*2.5*k;z.tail2+=Math.sin(s*2.55-.7)*5*k;}
      if(this.mood==='excited'){z.wholeTail+=Math.sin(s*4.2)*10*k;z.tail0+=Math.sin(s*4.2-.2)*2.5*k;z.tail1+=Math.sin(s*4.2-.5)*5*k;z.tail2+=Math.sin(s*4.2-.9)*8*k;}
      if(this.state==='annoyed'||this.mood==='annoyed'){z.rootR+=Math.sin(s*8)*.35*k;z.tail0+=Math.max(0,Math.sin(s*2.2))*2*k;z.tail1+=Math.max(0,Math.sin(s*2.2-.2))*3*k;z.tail2+=Math.max(0,Math.sin(s*2.2-.4))*6*k;}
      if(this.mood==='bored'){z.tail0*=.35;z.tail1*=.45;z.tail2=Math.sin(s*.65)*2.2*k;}
      if(this.mood==='sleepy'){z.tail0*=.2;z.tail1*=.2;z.tail2*=.25;}
      if(this.mood==='anxious'){z.tail0+=Math.sin(s*5.4)*1.5*k;z.tail1+=Math.sin(s*5.4-.3)*3*k;z.tail2+=Math.sin(s*5.4-.65)*7*k;}
      if(this.state==='bored'){z.headR+=slow*.8*k;z.gazeX=Math.sin(s*.35)*3*k;}
      if(this.state==='sleepy'){z.rootY=slow*3*k;z.headR+=slow*1.5*k;}
      if(this.state==='sleep'){z.rootY=breathe*4*k;z.headR=slow*.28*k;z.tail0*=.25;z.tail1*=.25;z.tail2*=.25;z.zzzY=-((s*18)%30);}
      if(this.state==='reading'){z.headR+=slow*.35*k;z.gazeY=1.5*k;}
      if(this.state==='tea'){z.steamY=-((s*15)%22);z.headR+=slow*.3*k;}
      if(this.state==='visitor'){z.gazeX=Math.sin(s*.7)*2*k;}
      if(this.state==='outdoors'){z.rootY+=Math.abs(Math.sin(s*3.6))*-5*k;z.handY+=lively*4*k;z.tail2+=lively*4*k;}
      return z;
    }

    _transform(el, x=0,y=0,r=0,sx=1,sy=1) { if(el)el.style.transform=`translate(${x}px,${y}px) rotate(${r}deg) scale(${sx},${sy})`; }
    _render(now) {
      const p=this.currentPose, idle=this._idleOffsets(now), a=this._actionOffsets(now);
      const rootS=p.rootS+idle.rootS;
      this._transform(this.q('character-motion-root'),a.rootX,p.rootY+idle.rootY+a.rootY,p.rootR+idle.rootR+a.rootR,rootS,rootS);
      this._transform(this.q('motion-head-root'),a.headX,p.headY+idle.headY+a.headY,p.headR+idle.headR+a.headR);
      this._transform(this.q('motion-hand-left'),p.handLX+a.handLX,p.handLY+idle.handY+a.handLY,0);
      this._transform(this.q('motion-hand-right'),p.handRX+a.handRX,p.handRY+idle.handY+a.handRY,0);
      this._transform(this.q('tail-root'),0,0,idle.wholeTail+a.wholeTail);
      this._transform(this.q('motion-tail-base'),0,0,p.tail0+idle.tail0+a.tail0);
      this._transform(this.q('motion-tail-mid'),0,0,p.tail1+idle.tail1+a.tail1);
      this._transform(this.q('motion-tail-tip'),0,0,p.tail2+idle.tail2+a.tail2);
      const face=this._resolvedFace();
      const faceEye={neutral:1,happy:.9,annoyed:.72,bored:.58,sleepy:.42,surprised:1.08}[face]||1;
      const blink=this.state==='sleep' ? .05 : this._blinkScale(now), eyeScale=Math.max(.05,p.eye*faceEye*blink);
      const gx=p.gazeX+idle.gazeX+a.gazeX, gy=p.gazeY+idle.gazeY+a.gazeY;
      this._transform(this.q('motion-eye-left'),gx,gy,0,1,eyeScale);this._transform(this.q('motion-eye-right'),gx,gy,0,1,eyeScale);
      const brow={neutral:[0,0,0],happy:[0,1,-2],annoyed:[0,3,7],bored:[0,5,1],sleepy:[0,6,2],surprised:[0,-8,-3]}[face]||[0,0,0];
      this._transform(this.q('motion-brow-left'),brow[0],brow[1],brow[2]);this._transform(this.q('motion-brow-right'),-brow[0],brow[1],-brow[2]);
      this._display(this.q('g-eye-left'),this.state!=='sleep');this._display(this.q('g-eye-right'),this.state!=='sleep');this._display(this.q('expression-closed-eyes'),this.state==='sleep');
      const hairAmp=idle.hair;this.qa('[id^="motion-hair-fringe-"]').forEach((el,i)=>this._transform(el,0,0,hairAmp*(i%2?1:-1)));
      this.qa('[id^="motion-hair-side-"]').forEach((el,i)=>this._transform(el,0,0,hairAmp*.7*(i%2?1:-1)));
      this._transform(this.q('motion-book'),0,0,a.bookR);this._transform(this.q('motion-teacup'),a.cupX,a.cupY,a.cupR);
      const zzz=this.q('overlay-zzz');if(zzz)zzz.style.transform=`translateY(${idle.zzzY}px)`;
      const steam=this.q('tea-steam');if(steam)steam.style.transform=`translateY(${idle.steamY}px)`;
      if(a.actionMouth)this._applyFace(a.actionMouth);
    }

    _frame(now) {
      if(this.destroyed)return;
      if(this.transition){
        const tr=this.transition,t=Math.min(1,(now-tr.start)/tr.duration), eased=(EASE[this.easing]||EASE['ease-in-out'])(t);
        this.currentPose=mix(tr.from,tr.to,eased);
        if(t>=1){
          const previous=this.state;this.state=tr.next;this.currentPose=clone(tr.to);this.transition=null;this._setStateVisibility(this.state);this._emit('transition-end',previous+' → '+this.state);
          if(this.state==='waking'&&this.pendingState){const target=this.pendingState;this.pendingState=null;setTimeout(()=>this.setLifeState(target,{skipGuard:true}),180);}
        }
      }
      if(this.idleRunning && this.state!=='sleep' && now>=this.nextBlink && !this.blinkDuration)this.blink();
      // Calm moments don't need every display refresh: a subclass may ask for a
      // longer gap (and wake the loop early when something happens). While calm
      // the drawing can be frozen altogether (the subclass breathes it on the GPU).
      const gap=typeof this._frameGap==='function'?this._frameGap(now):0;
      const freeze=gap>20&&typeof this._freezeCalm==='function'&&this._freezeCalm(true);
      if(!freeze){if(gap<=20&&typeof this._freezeCalm==='function')this._freezeCalm(false);this._render(now);}
      if(gap>20){this.raf=null;clearTimeout(this._frameTimer);this._frameTimer=setTimeout(()=>{this._frameTimer=null;if(!this.destroyed)this.raf=requestAnimationFrame(this._frame);},gap);}
      else this.raf=requestAnimationFrame(this._frame);
    }
    wakeFrames(){
      if(this.destroyed||!this._frameTimer)return;
      clearTimeout(this._frameTimer);this._frameTimer=null;
      this.raf=requestAnimationFrame(this._frame);
    }

    setAutoLife(on) {
      this.autoLife=!!on;clearTimeout(this.autoTimer);this.autoTimer=null;
      const choose=()=>{if(!this.autoLife)return;const entries=Object.entries(AUTO_WEIGHTS),r=Math.random(),total=entries.reduce((s,e)=>s+e[1],0);let acc=0,pick='awake';for(const [state,w] of entries){acc+=w/total;if(r<=acc){pick=state;break}}this.setLifeState(pick);const actions=pick==='reading'?['page-turn','look-left']:pick==='tea'?['sip','look-right']:pick==='happy'?['excited-tail','click-reaction']:['look-left','look-right','tail-thump'];setTimeout(()=>{if(this.autoLife)this.playAction(actions[Math.floor(Math.random()*actions.length)])},1100);this.autoTimer=setTimeout(choose,4200+Math.random()*4200)};
      if(on)choose();this._emit('auto-life',on?'on':'off');
    }
    getSnapshot() { return {version:2,state:this.state,mood:this.mood,expression:this.expression,viseme:this.viseme,outfitMode:this.outfitMode,outfit:this.outfit,duration:this.duration,easing:this.easing,idleIntensity:this.idleIntensity,idleRunning:this.idleRunning,autoLife:this.autoLife,savedAt:new Date().toISOString()}; }
    loadSnapshot(data) {
      if(!data||data.version!==2)throw new Error('Not an Arthur Life Lab v2 snapshot');
      this.setDuration(data.duration);this.setEasing(data.easing);this.setIdleIntensity(data.idleIntensity);this.setIdle(data.idleRunning);this.setOutfit(data.outfitMode||'auto');this.setMood(data.mood||'calm');this.setExpression(data.expression||data.emotion||'mood');this.setViseme(data.viseme||'idle');this.setLifeState(data.state||'awake',{skipGuard:true});this.setAutoLife(!!data.autoLife);this._emit('snapshot','loaded');
    }
    destroy() { this.destroyed=true;cancelAnimationFrame(this.raf);clearTimeout(this._frameTimer);clearTimeout(this.autoTimer);clearTimeout(this._mouthResetTimer);this.speechTimers.forEach(clearTimeout);this._emit('destroy',''); }
  }

  ArthurLifeRuntime.lifeStates=LIFE_STATES;
  ArthurLifeRuntime.moods=MOODS;
  ArthurLifeRuntime.expressions=EXPRESSIONS;
  ArthurLifeRuntime.emotions=EXPRESSIONS;
  ArthurLifeRuntime.actions=ACTIONS;
  ArthurLifeRuntime.visemes=VISEMES;
  ArthurLifeRuntime.arpabet=ARPABET;
  global.ArthurLifeRuntime=ArthurLifeRuntime;
})(typeof window!=='undefined'?window:globalThis);
