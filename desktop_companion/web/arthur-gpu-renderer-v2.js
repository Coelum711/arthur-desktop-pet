// Arthur on the GPU.
//
// The SVG rig stays in the page as the *model*: the runtime keeps moving, swapping and
// measuring its parts exactly as before, and doesn't know anything changed. But the
// drawing itself is taken out of the document (an empty proxy <svg> of the same size
// stands in for it on the page, a hidden mirror copy answers style questions), so the
// browser no longer restyles, lays out or repaints a thousand vector parts every frame.
// Instead:
//
//   * every run of shapes is turned into a texture once (rasterised from the SVG itself,
//     a little larger than it appears, with mipmaps so it stays crisp when smaller),
//     keyed by exactly what it looks like, so the same mouth is never drawn twice;
//   * each frame, WebGL just places those textures with each group's transform;
//   * shapes whose geometry the runtime animates (tail morph, guitar strings, a sliding
//     shadow) are redrawn into a small texture when they change;
//   * the questions the runtime and page ask the drawing (getBoundingClientRect,
//     getScreenCTM, getBBox, which part the pointer is on) are answered from the model.
//
// Until every piece is ready the real SVG stays on the page; if WebGL is lost, it comes
// back for good.
(function (global) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text']);
  const GROUPS = new Set(['g', 'a']);
  const NOT_DRAWN = new Set(['defs', 'style', 'title', 'desc', 'metadata', 'clipPath', 'filter', 'pattern',
    'linearGradient', 'radialGradient', 'mask', 'symbol', 'marker']);
  const GEOMETRY = new Set(['d', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'points', 'x1', 'x2', 'y1', 'y2']);
  const PAINT = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
    'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
    'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor',
    'dominant-baseline', 'letter-spacing'];
  const NOT_PAINT_STYLE = /^(transform|transform-origin|transform-box|translate|rotate|scale|display|opacity|visibility|cursor|touch-action|user-select|-webkit-user-select|will-change|pointer-events)$/;
  const IGNORED_ATTRS = /^(id|role|tabindex|aria-.*|data-.*)$/;
  const MOVED = /(^|;)\s*(transform|translate|rotate|scale)\s*:/;
  const EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'contextmenu', 'wheel', 'click', 'dblclick'];
  // Textures are drawn at the size they appear (at most ~4% larger) and pasted with plain
  // linear filtering: shrinking a larger texture (with mipmaps) blurred thin lines into
  // thick ones (her verdict: the mouth went 'sausage'). Re-drawn when he grows or shrinks.
  const DENSITY_STEPS = 16;        // per doubling: ~4.4% apart
  const TOO_FINE = 1.2;            // a texture more than this much bigger than needed is redrawn
  const MAX_TEXTURES = 1200;

  const PROF = {cs: 0, parse: 0, quads: 0, tQuad: 0, tMut: 0, tLayout: 0, tWalk: 0, frames: 0, rects: 0, ctms: 0, tApi: 0, who: {}};
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const urlRef = v => { const m = /url\(\s*["']?[^"')#]*#([^"')\s]+)["']?\s*\)/.exec(v || ''); return m ? m[1] : null; };
  // 2D affine matrices as [a, b, c, d, e, f].
  const I = [1, 0, 0, 1, 0, 0];
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const inv = m => { const det = m[0] * m[3] - m[1] * m[2] || 1e-12; return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]; };
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const fromDOM = d => [d.a, d.b, d.c, d.d, d.e, d.f];
  const scaleOf = m => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  const boxThrough = (m, b) => {
    const p = [apply(m, b.x, b.y), apply(m, b.x + b.w, b.y), apply(m, b.x, b.y + b.h), apply(m, b.x + b.w, b.y + b.h)];
    const xs = p.map(q => q[0]), ys = p.map(q => q[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    return {x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0};
  };
  const union = (a, b) => {
    if (!a) return b; if (!b) return a;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return {x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y};
  };

  // CSS transform lists the runtime writes (translate/rotate/scale/matrix in px/deg),
  // parsed without the CSS engine; anything else goes to DOMMatrix.
  const FN = /([a-zA-Z0-9]+)\(([^)]*)\)/g;
  function parseTransform(str) {
    let m = I, any = false;
    FN.lastIndex = 0;
    let f;
    while ((f = FN.exec(str))) {
      any = true;
      const name = f[1], args = f[2].split(/[\s,]+/).filter(Boolean);
      const len = v => { if (/px$/.test(v) || /^-?[\d.]+(e-?\d+)?$/.test(v)) return num(v); throw 0; };
      const ang = v => { if (/deg$/.test(v)) return num(v) * Math.PI / 180; if (/rad$/.test(v)) return num(v); if (/turn$/.test(v)) return num(v) * Math.PI * 2; if (/^-?[\d.]+$/.test(v) && num(v) === 0) return 0; throw 0; };
      switch (name) {
        case 'translate': m = mul(m, [1, 0, 0, 1, len(args[0]), args[1] ? len(args[1]) : 0]); break;
        case 'translateX': m = mul(m, [1, 0, 0, 1, len(args[0]), 0]); break;
        case 'translateY': m = mul(m, [1, 0, 0, 1, 0, len(args[0])]); break;
        case 'rotate': case 'rotateZ': { const a = ang(args[0]); m = mul(m, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]); break; }
        case 'scale': { const x = num(args[0]), y = args[1] != null ? num(args[1]) : x; m = mul(m, [x, 0, 0, y, 0, 0]); break; }
        case 'scaleX': m = mul(m, [num(args[0]), 0, 0, 1, 0, 0]); break;
        case 'scaleY': m = mul(m, [1, 0, 0, num(args[0]), 0, 0]); break;
        case 'matrix': m = mul(m, args.map(num)); break;
        case 'translateZ': if (num(args[0]) !== 0) throw 0; break;
        default: throw 0;
      }
    }
    if (!any && str.trim() !== 'none') throw 0;
    return m;
  }
  function attrTransform(el) {
    const list = el.transform && el.transform.baseVal;
    if (!list || !list.numberOfItems) return null;
    let m = I;
    for (let i = 0; i < list.numberOfItems; i++) m = mul(m, fromDOM(list.getItem(i).matrix));
    return m;
  }
  // What the browser does: origin · translate · rotate · scale · (CSS transform | attribute) · -origin.
  function localMatrix(el) {
    const st = el.style;
    const tr = st.translate, ro = st.rotate, sc = st.scale, tf = st.transform;
    const css = (tr && tr !== 'none') || (ro && ro !== 'none') || (sc && sc !== 'none') || (tf && tf !== 'none');
    if (!css && !st.transformOrigin) return attrTransform(el);
    let m = I;
    if (tr && tr !== 'none') { const v = tr.trim().split(/\s+/); m = mul(m, [1, 0, 0, 1, num(v[0]), num(v[1])]); }
    if (ro && ro !== 'none') {
      const r = /(-?[\d.]+(?:e-?\d+)?)(deg|rad|turn|grad)?\s*$/.exec(ro.trim());
      if (r) {
        const n = num(r[1]), u = r[2] || 'deg';
        const a = (u === 'rad' ? n : u === 'turn' ? n * Math.PI * 2 : u === 'grad' ? n * Math.PI / 200 : n * Math.PI / 180);
        m = mul(m, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]);
      }
    }
    if (sc && sc !== 'none') { const v = sc.trim().split(/\s+/).map(x => /%$/.test(x) ? num(x) / 100 : num(x)); m = mul(m, [v[0], 0, 0, v.length > 1 ? v[1] : v[0], 0, 0]); }
    if (tf && tf !== 'none') {
      PROF.parse++;
      let fast = null;
      try { fast = parseTransform(tf); } catch (_) { fast = null; }
      if (fast) m = mul(m, fast);
      else try { m = mul(m, fromDOM(new DOMMatrix(tf))); } catch (_) {
        const ct = getComputedStyle(el).transform;
        try { if (ct && ct !== 'none') m = mul(m, fromDOM(new DOMMatrix(ct))); } catch (__) {}
      }
    } else {
      const own = attrTransform(el);
      if (own) m = mul(m, own);
    }
    if (!css && m === I) return null;
    const o = (st.transformOrigin || '').trim().split(/\s+/);
    const ox = num(o[0]), oy = num(o[1]);
    return ox || oy ? mul(mul([1, 0, 0, 1, ox, oy], m), [1, 0, 0, 1, -ox, -oy]) : m;
  }
  function moveSig(el) {
    const st = el.style;
    return st.translate + '|' + st.rotate + '|' + st.scale + '|' + st.transform + '|' + st.transformOrigin + '|' + (el.getAttribute('transform') || '');
  }
  // Inline style, held in plain JS while the model is off the page. The runtime writes
  // dozens of transforms a frame; through the browser each one is parsed, serialised
  // into the style attribute and reported to the MutationObserver, and read back
  // through the CSS engine. Here a write is a Map set and a direct note to the renderer.
  // Written back to the real style whenever the SVG goes on the page again.
  const MOVE_PROPS = new Set(['transform', 'translate', 'rotate', 'scale', 'transformOrigin', 'transformBox']);
  const camel = p => p.startsWith('--') ? p : p.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const kebab = p => p.startsWith('--') ? p : p.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
  const SHIM = new WeakMap();       // element -> Map(camelCase -> value)
  function makeStyle(el, owner, vals) {
    const set = (k, v) => {
      v = v == null ? '' : String(v).trim();
      if (v === (vals.get(k) || '')) return;
      if (v === '') vals.delete(k); else vals.set(k, v);
      owner._styleSet(el, k, v);
    };
    const api = {
      setProperty(p, v) { set(camel(String(p)), v); },
      getPropertyValue(p) { return vals.get(camel(String(p))) || ''; },
      getPropertyPriority() { return ''; },
      removeProperty(p) { const k = camel(String(p)), old = vals.get(k) || ''; set(k, ''); return old; },
      item(i) { let n = 0; for (const k of vals.keys()) if (n++ === i) return kebab(k); return ''; },
      get length() { return vals.size; },
      get cssText() { let t = ''; for (const [k, v] of vals) t += kebab(k) + ': ' + v + '; '; return t.trim(); },
      set cssText(text) {
        const next = new Map();
        for (const d of String(text || '').split(';')) { const i = d.indexOf(':'); if (i > 0) next.set(camel(d.slice(0, i).trim()), d.slice(i + 1).trim()); }
        for (const k of [...vals.keys()]) if (!next.has(k)) set(k, '');
        for (const [k, v] of next) set(k, v);
      }
    };
    return new Proxy(api, {
      get(t, p) { if (p in t) return t[p]; return typeof p === 'string' ? (vals.get(p) || '') : undefined; },
      set(t, p, v) { if (p === 'cssText') t.cssText = v; else if (typeof p === 'string') set(p, v); return true; }
    });
  }
  function styleSig(el) {
    const sv = SHIM.get(el);
    if (sv) { let out = ''; for (const [k, v] of sv) { const p = kebab(k); if (!NOT_PAINT_STYLE.test(p)) out += p + ':' + v + ';'; } return out; }
    const s = el.style; let out = '';
    for (let i = 0; i < s.length; i++) { const p = s.item(i); if (!NOT_PAINT_STYLE.test(p)) out += p + ':' + s.getPropertyValue(p) + ';'; }
    return out;
  }

  // ---------------------------------------------------------------- WebGL
  const VS = `#version 300 es
  in vec2 aPos; uniform vec4 uM; uniform vec2 uT; uniform vec2 uView; out vec2 vUV;
  void main(){ vec2 p = vec2(uM.x*aPos.x + uM.z*aPos.y + uT.x, uM.y*aPos.x + uM.w*aPos.y + uT.y);
    gl_Position = vec4(p.x/uView.x*2.0-1.0, 1.0-p.y/uView.y*2.0, 0.0, 1.0); vUV = aPos; }`;
  const FS = `#version 300 es
  precision mediump float; in vec2 vUV; uniform sampler2D uTex; uniform float uAlpha; uniform vec4 uTint; uniform int uMode; out vec4 o;
  void main(){ if (uMode == 2) { o = vec4(1.0); return; }
    vec4 t = texture(uTex, vUV);
    if (uMode == 1) { o = vec4(uTint.rgb, 1.0) * t.a * uTint.a * uAlpha; } else { o = t * uAlpha; } }`;

  function makeGL(canvas) {
    const gl = canvas.getContext('webgl2', {alpha: true, premultipliedAlpha: true, antialias: false, stencil: true, preserveDrawingBuffer: true});
    if (!gl) return null;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    gl.useProgram(p);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, 'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // We premultiply the pixels ourselves (see upload): engines differ in how they do it on
    // upload (WebKit's soft edges came out brighter), and filtering needs premultiplied.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const u = n => gl.getUniformLocation(p, n);
    return {gl, uM: u('uM'), uT: u('uT'), uView: u('uView'), uAlpha: u('uAlpha'), uTint: u('uTint'), uMode: u('uMode'), uTex: u('uTex')};
  }
  function premultiplied(canvas) {
    const w = canvas.width, h = canvas.height, d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; if (a === 255) continue; if (!a) { d[i] = d[i + 1] = d[i + 2] = 0; continue; } d[i] = (d[i] * a + 127) / 255; d[i + 1] = (d[i + 1] * a + 127) / 255; d[i + 2] = (d[i + 2] * a + 127) / 255; }
    return d;
  }
  function put(gl, canvas) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, canvas.width, canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, premultiplied(canvas)); }
  function upload(G, source) {
    const gl = G.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    put(gl, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function cssColor(v) {
    const m = /rgba?\(([^)]+)\)/.exec(v || ''); if (m) { const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(num); return [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1]; }
    const h = /^#([0-9a-f]{3,8})$/i.exec((v || '').trim());
    if (h) { let s = h[1]; if (s.length <= 4) s = s.split('').map(c => c + c).join(''); const n = parseInt(s.slice(0, 6), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255, s.length === 8 ? parseInt(s.slice(6), 16) / 255 : 1]; }
    return [0, 0, 0, 1];
  }

  // ---------------------------------------------------------------- renderer
  class GpuArthur {
    constructor(svg, mount, options = {}) {
      this.svg = svg; this.mount = mount;
      this.doc = svg.ownerDocument; this.win = this.doc.defaultView;
      this.log = options.log || (() => {});
      this.stats = {draws: 0, textures: 0, svgFrames: 0, reason: 'starting', drawMs: 0};
      this.nodes = new WeakMap();       // element -> node
      this.live = new WeakSet();        // shapes whose geometry is animated
      this.solo = new WeakSet();        // shapes moved on their own with CSS
      this.cache = new Map();           // key -> texture entry {tex, box, w, h} | 'empty' | 'pending'
      this.ver = 1;
      const vb = svg.viewBox && svg.viewBox.baseVal;
      this.vb = vb && vb.width ? {x: vb.x, y: vb.y, w: vb.width, h: vb.height} : {x: 0, y: 0, w: 100, h: 100};

      // The canvas: covers the whole page, inside the mount (so it breathes with it).
      this.canvas = this.doc.createElement('canvas');
      this.canvas.className = 'gpu-arthur';
      this.canvas.setAttribute('aria-hidden', 'true');
      Object.assign(this.canvas.style, {position: 'absolute', left: '0px', top: '0px', pointerEvents: 'none', display: 'block', visibility: 'hidden'});
      mount.appendChild(this.canvas);
      this.G = makeGL(this.canvas);
      if (!this.G) { this.canvas.remove(); throw new Error('no webgl2'); }
      this.canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.log('gpu: context lost, back to SVG'); this.stop(); });

      // A scratch 2D context for hit tests and live shapes.
      this.scratch = this.doc.createElement('canvas').getContext('2d');
      // A tiny laid-out SVG for measuring shapes (getBBox needs layout).
      this.measure = this.doc.createElementNS(NS, 'svg');
      this.measure.setAttribute('aria-hidden', 'true');
      Object.assign(this.measure.style, {position: 'absolute', left: '0px', top: '0px', width: '1px', height: '1px', overflow: 'hidden', visibility: 'hidden', pointerEvents: 'none'});
      this.doc.body.appendChild(this.measure);
      this.rules = {selfHidden: 'zero', insideHidden: 'zero', bboxHidden: 'geometry'};   // decided at the swap, from the rig itself

      // The model SVG will leave the document (so the browser stops restyling it every
      // frame). Two stand-ins: a *mirror* copy, hidden, kept in sync only when a style
      // question is asked (classes, colours, display), and an empty *proxy* <svg> of the
      // same size in the mount, for the page's own box, position and pointer events.
      this.runtime = options.runtime || null;
      this.mirrorBox = this.doc.createElement('div');
      this.mirrorBox.style.display = 'none';
      this.mirrorBox.setAttribute('aria-hidden', 'true');
      this.mirror = svg.cloneNode(true);
      this.mirrorBox.appendChild(this.mirror);
      mount.appendChild(this.mirrorBox);
      this.twin = new WeakMap();        // model element -> mirror element
      const pair = (a, b) => { this.twin.set(a, b); for (let i = 0; i < a.children.length; i++) pair(a.children[i], b.children[i]); };
      pair(svg, this.mirror);
      this.stale = new Set();           // model elements whose attributes changed since the mirror last saw them
      this.proxy = svg.cloneNode(false);
      this.proxy.removeAttribute('id');
      this.proxy.setAttribute('aria-hidden', 'true');
      this.ids = null;                  // id -> model element
      this.shown = true;                // the real SVG is still in the page (until every piece is ready)

      this._patchGeometry();
      this._hookEvents();
      this._patchLookups();
      this.structure = true;
      this.observer = new MutationObserver(r => this._mutated(r));
      this.observer.observe(svg, {attributes: true, childList: true, subtree: true, characterData: true});
      this.win.addEventListener('resize', () => { this.layoutDirty = true; this.request(); });
      this.request();
    }

    // ------------------------------------------------------------ model
    _build() {
      const old = this.root;
      this.root = {el: this.svg, g: true, kids: [], local: null, shown: true, alpha: 1, xDirty: false, vDirty: false, pe: true};
      this.groups = []; this.pieces = [];
      this.unsupported = null;
      this.ids = null;
      this._buildInto(this.svg, this.root, true);
      this.structure = false;
      if (!this.shown && !this.stopped) this._shimAll();
      this.ver++;
      if (old) for (const g of this.groups) { g.vDirty = true; g.xDirty = true; }
    }
    _buildInto(el, node, pe) {
      let run = null;
      for (const kid of el.children) {
        const tag = kid.localName;
        if (NOT_DRAWN.has(tag)) continue;
        const kpe = pe && kid.getAttribute('pointer-events') !== 'none' && kid.style.pointerEvents !== 'none';
        if (GROUPS.has(tag)) {
          const g = {el: kid, g: true, kids: [], parent: node, local: null, shown: true, alpha: 1, xDirty: true, vDirty: true, pe: kpe, sig: styleSig(kid), msig: null, vsig: null};
          node.kids.push(g); this.groups.push(g); this.nodes.set(kid, g);
          this._buildInto(kid, g, kpe);
          run = null;
        } else if (SHAPES.has(tag)) {
          const sv = SHIM.get(kid);
          const moved = sv ? !!(sv.get('transform') || sv.get('translate') || sv.get('rotate') || sv.get('scale')) : MOVED.test(kid.getAttribute('style') || '');
          const own = this.live.has(kid) ? 'live' : (this.solo.has(kid) || moved) ? 'solo' : null;
          if (own === 'solo') this.solo.add(kid);
          if (own) {
            const p = {els: [kid], parent: node, kind: own, dirty: true, xDirty: true, geom: true, pe: kpe, key: null, entry: null, sig: styleSig(kid)};
            node.kids.push(p); this.pieces.push(p); this.nodes.set(kid, p);
            run = null;
          } else {
            if (!run) { run = {els: [], parent: node, kind: 'run', dirty: true, pe: kpe, key: null, entry: null}; node.kids.push(run); this.pieces.push(run); }
            run.els.push(kid); this.nodes.set(kid, run);
            if (!kpe) run.pe = false;
          }
        } else {
          this.unsupported = '<' + tag + '>';
        }
      }
    }
    _dirtyBelow(node) { for (const k of node.kids) { if (k.g) { k.vDirty = true; this._dirtyBelow(k); } else k.dirty = true; } }

    _mutated(records) {
      const tm0 = performance.now();
      for (const m of records) {
        const t = m.target;
        if (m.type === 'childList' || m.type === 'characterData') {
          this._mirrorChildren(m);
          if (m.type === 'childList') { this.ids = null; this.qcache = null; }
          if (t.closest && t.closest('pattern, filter')) this.restyle = true;
          else if (!(t.closest && t.closest('clipPath'))) this.structure = true;
          continue;
        }
        const attr = m.attributeName;
        this.stale.add(t);
        if (attr === 'id') { this.ids = null; this.qcache = null; continue; }
        if (attr === 'class') this.qcache = null;
        if (IGNORED_ATTRS.test(attr)) continue;
        if (attr === 'pointer-events') { this.structure = true; continue; }
        if (t.closest && t.closest('clipPath')) continue;              // read fresh at each draw
        if (t.closest && t.closest('defs')) { this.restyle = true; continue; }
        if (t === this.svg) {
          if (attr === 'style') for (const p of ['cursor', 'touchAction', 'userSelect']) this.proxy.style[p] = t.style[p];
          if (attr === 'class') this.restyle = true;
          else if (attr === 'style') { const s = styleSig(t); if (s !== this._rootSig) { this._rootSig = s; this.restyle = true; } }
          continue;
        }
        const n = this.nodes.get(t);
        if (n && n.g) {
          if (attr === 'transform') { n.xDirty = true; continue; }
          if (attr === 'style') {
            n.xDirty = true; n.vDirty = true;
            const s = styleSig(t); if (s !== n.sig) { n.sig = s; this._dirtyBelow(n); }
            continue;
          }
          n.vDirty = true;
          if (attr !== 'display' && attr !== 'opacity' && attr !== 'filter' && attr !== 'clip-path') this._dirtyBelow(n);
          continue;
        }
        const shape = SHAPES.has(t.localName) ? t : (t.closest && t.closest('text'));
        const p = shape && this.nodes.get(shape);
        if (!p) { this.structure = true; continue; }
        if (shape !== t) { p.dirty = true; continue; }
        if (attr === 'style') {
          if (MOVED.test(shape.getAttribute('style') || '') && p.kind === 'run') { this.solo.add(shape); this.structure = true; continue; }
          p.xDirty = true; if (p.kind === 'live') p.geom = true;
          const s = styleSig(shape); if (s !== p.sig) { p.sig = s; p.dirty = true; }
          p.vDirty = true;
        } else if (attr === 'transform' && p.kind !== 'run') {
          p.xDirty = true; if (p.kind === 'live') p.geom = true;
        } else if (GEOMETRY.has(attr) && p.kind !== 'live' && shape.localName !== 'text') {
          this.live.add(shape); this.structure = true;
        } else {
          p.dirty = true; if (p.kind === 'live') p.geom = true;
          if (attr === 'display' || attr === 'opacity') p.vDirty = true;
        }
        if (GEOMETRY.has(attr) || attr === 'transform') this._bboxes && this._bboxes.delete(shape);
      }
      this.ver++;
      PROF.tMut += performance.now() - tm0;
      this.request();
    }

    // A childList change in the model: do the same in the mirror.
    _mirrorChildren(m) {
      const mp = this.twin.get(m.target);
      if (!mp) return;
      for (const n of m.removedNodes) { const tw = this.twin.get(n); if (tw && tw.parentNode) tw.remove(); }
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1 && n.nodeType !== 3) continue;
        if (this.twin.get(n) && this.twin.get(n).parentNode === mp) continue;
        const c = n.cloneNode(true);
        if (n.nodeType === 1) { const pair = (a, b) => { this.twin.set(a, b); for (let i = 0; i < a.children.length; i++) pair(a.children[i], b.children[i]); }; pair(n, c); }
        else this.twin.set(n, c);
        let next = n.nextSibling, before = null;
        while (next && !(before = this.twin.get(next))) next = next.nextSibling;
        mp.insertBefore(c, before && before.parentNode === mp ? before : null);
      }
      if (m.type === 'characterData') { const tw = this.twin.get(m.target); if (tw) tw.data = m.target.data; }
    }
    // With page zoom (the Mac app zooms the page to size him), computed lengths come back
    // scaled: a stroke-width of 8 reads as 13.3. Measure the factor with a 1-unit probe.
    _zoom() {
      if (this._zoomAt === this._layoutSig && this._zoomV) return this._zoomV;
      const p = this.doc.createElementNS(NS, 'path');
      p.setAttribute('stroke-width', '100');
      this.mirror.appendChild(p);
      const v = num(this.win.getComputedStyle(p).strokeWidth) / 100;
      p.remove();
      this._zoomV = v > 0 ? v : 1; this._zoomAt = this._layoutSig;
      return this._zoomV;
    }
    _len(v) { const z = this._zoom(); return z === 1 ? v : String(v).replace(/(-?[\d.]+(?:e-?\d+)?)px/g, (_, n) => (num(n) / z) + 'px'); }
    // Computed style of a model element, asked of its mirror (brought up to date first,
    // with its ancestors, since colours and fonts inherit).
    _cs(el) {
      const chain = [];
      for (let k = el; k; k = k.parentNode) { chain.push(k); if (k === this.svg) break; }
      for (const k of chain) {
        if (!this.stale.has(k)) continue;
        this.stale.delete(k);
        const tw = this.twin.get(k);
        if (!tw || k.nodeType !== 1) continue;
        this._syncTwin(k, tw);
      }
      const tw = this.twin.get(el);
      return this.win.getComputedStyle(tw || el);
    }
    _syncTwin(k, tw) {
      const shimmed = SHIM.has(k);
      for (const a of [...tw.attributes]) if (!(shimmed && a.name === 'style') && !k.hasAttribute(a.name)) tw.removeAttribute(a.name);
      for (const a of k.attributes) if (!(shimmed && a.name === 'style') && tw.getAttribute(a.name) !== a.value) tw.setAttribute(a.name, a.value);
    }
    // Style shims on every drawn element (see makeStyle). The twin gets the current
    // values first, then only what isn't movement (movement doesn't change the paint).
    _shimAll() {
      const els = [];
      for (const g of this.groups) els.push(g.el);
      for (const p of this.pieces) for (const e of p.els) els.push(e);
      for (const el of els) {
        if (SHIM.has(el)) continue;
        const tw = this.twin.get(el);
        if (tw && el.nodeType === 1) { this.stale.delete(el); this._syncTwin(el, tw); }
        const vals = new Map(), st = el.style;
        // By shorthand: WebKit lists transform-origin as its -x/-y/-z longhands.
        for (let i = 0; i < st.length; i++) {
          const p = st.item(i).replace(/^(transform-origin|perspective-origin)-[xyz]$/, '$1');
          const v = st.getPropertyValue(p);
          if (v) vals.set(camel(p), v);
        }
        SHIM.set(el, vals);
        const proxy = makeStyle(el, this, vals);
        Object.defineProperty(el, 'style', {configurable: true, get: () => proxy, set: v => { proxy.cssText = v; }});
      }
    }
    // Write the shims' values into the real inline styles (for a copy of the SVG, or
    // before it goes back on the page). Our own writes aren't news to the renderer.
    syncStyles(unshim) {
      const pending = this.observer.takeRecords();
      if (pending.length) this._mutated(pending);
      const real = Object.getOwnPropertyDescriptor(global.SVGElement.prototype, 'style').get;
      const els = [];
      for (const g of this.groups || []) els.push(g.el);
      for (const p of this.pieces || []) for (const e of p.els) els.push(e);
      for (const el of els) {
        const vals = SHIM.get(el);
        if (!vals) continue;
        let t = ''; for (const [k, v] of vals) t += kebab(k) + ': ' + v + '; ';
        const st = real.call(el);
        if (st.cssText !== t.trim()) st.cssText = t;
        if (unshim) { SHIM.delete(el); delete el.style; }
      }
      this.observer.takeRecords();
    }
    _unshimAll() { this.syncStyles(true); }
    // A shimmed style property changed: what the MutationObserver would have said.
    _styleSet(el, k, v) {
      if (this.stopped) return;
      const move = MOVE_PROPS.has(k);
      if (!move) {
        const tw = this.twin.get(el);
        if (tw) { if (v === '') tw.style.removeProperty(kebab(k)); else tw.style.setProperty(kebab(k), v); }
        if (k === 'pointerEvents') this.structure = true;
      }
      const n = this.nodes.get(el);
      if (n && n.g) {
        n.xDirty = true;
        if (!move) { n.vDirty = true; const sg = styleSig(el); if (sg !== n.sig) { n.sig = sg; this._dirtyBelow(n); } }
      } else if (n) {
        if (move && n.kind === 'run') { if (v) { this.solo.add(el); this.structure = true; } }
        else {
          n.xDirty = true; if (n.kind === 'live') n.geom = true;
          if (!move) { const sg = styleSig(el); if (sg !== n.sig) { n.sig = sg; n.dirty = true; } n.vDirty = true; }
        }
        if (move) this._bboxes && this._bboxes.delete(el);
      }
      this.ver++;
      this.request();
    }
    // id -> element, built once per structure change (missing ids are remembered too).
    _byId(id) {
      if (!this.ids) { this.ids = new Map(); for (const e of this.svg.querySelectorAll('[id]')) if (!this.ids.has(e.id)) this.ids.set(e.id, e); }
      const e = this.ids.get(id);
      return e === undefined ? null : e;
    }
    // querySelectorAll results, per selector, until the structure or any class changes.
    _all(sel) {
      if (!this.qcache) this.qcache = new Map();
      let r = this.qcache.get(sel);
      if (!r) { r = [...this.svg.querySelectorAll(sel)]; this.qcache.set(sel, r); }
      return r.slice();
    }
    _patchLookups() {
      const self = this, rt = this.runtime;
      // The runtime finds parts by id hundreds of times a frame; out of the document,
      // querySelector('#id') would walk the whole tree each time.
      if (rt && typeof rt.q === 'function') { const own = rt.q; rt.q = id => (self.stopped ? own(id) : self._byId(id)); }
      if (rt && typeof rt.qa === 'function') { const own = rt.qa; rt.qa = sel => (self.stopped ? own(sel) : self._all(sel)); }
      const dproto = global.Document.prototype, native = dproto.getElementById;
      dproto.getElementById = function (id) { const e = native.call(this, id); if (e || self.stopped || self.shown || this !== self.doc) return e; return self._byId(id) || null; };
      // Its parentNode is the mount (the calm-breath class goes there).
      Object.defineProperty(this.svg, 'parentNode', {configurable: true, get: () => (self.shown || self.stopped ? Object.getOwnPropertyDescriptor(Node.prototype, 'parentNode').get.call(self.svg) : self.mount)});
      // Pointer capture goes to the proxy, which receives the real events.
      for (const f of ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture']) {
        const own = this.svg[f];
        this.svg[f] = function (id) { return (self.shown || self.stopped ? own : self.proxy[f]).call(self.shown || self.stopped ? self.svg : self.proxy, id); };
      }
      this._unpatchLookups = () => { dproto.getElementById = native; };
    }

    request() {
      if (this._queued || this.stopped) return;
      this._queued = true;
      Promise.resolve().then(() => { this._queued = false; this.draw(); });
    }

    // Visibility and opacity of a node: only asks the browser when something that could
    // change them changed (classes, inline display/opacity, attributes, the root's class).
    // A part's own answer can depend on its ancestors (CSS such as 'everything inside a
    // hidden outfit is hidden too'), so the parent is settled first and its version is
    // part of the child's signature; when a group's answer changes, everything below it
    // is asked again. (Without this, an outfit coming on left its torso and legs hidden.)
    _vis(n) {
      // Ancestors first, top down (iteratively: the tree is deep).
      const chain = [];
      for (let k = n; k && k !== this.root; k = k.parent) chain.push(k);
      for (let i = chain.length - 1; i >= 0; i--) this._vis1(chain[i]);
    }
    // One node, its parent already settled (the draw walk goes top down).
    _vis1(n) {
      if (!n.vDirty && n.vsig !== undefined) return;
      const up = n.parent && n.parent !== this.root ? n.parent : null;
      n.vDirty = false;
      const el = n.g ? n.el : n.els[0];
      const sig = (up ? up.vver : 0) + '|' + (el.getAttribute('class') || '') + '|' + el.style.display + '|' + el.style.opacity + '|' + (el.getAttribute('display') || '') + '|' + (el.getAttribute('opacity') || '') + '|' + this._rootClass
        + '|' + (el.getAttribute('filter') || '') + '|' + el.style.filter + '|' + (el.getAttribute('clip-path') || '') + '|' + el.style.clipPath;
      if (sig === n.vsig) return;
      n.vsig = sig;
      n.vver = (n.vver || 0) + 1;
      if (n.g) this._visBelow(n);
      PROF.cs++;
      const cs = this._cs(el);
      n.shown = cs.display !== 'none';
      n.alpha = n.g ? (cs.opacity === '' ? 1 : num(cs.opacity)) : 1;   // a shape's own opacity is baked into its texture
      if (n.g) {
        n.edge = null; n.bad = null; n.clip = null;
        const f = el.getAttribute('filter') || (cs.filter && cs.filter !== 'none' ? cs.filter : null);
        if (f) {
          const fe = this._byId(urlRef(f) || '');
          // By localName: in an HTML page WebKit lowercases 'feMorphology' in selectors.
          const all = fe ? [...fe.getElementsByTagNameNS(NS, '*')] : [];
          const morph = all.find(e => e.localName === 'feMorphology'), flood = all.find(e => e.localName === 'feFlood');
          if (morph && flood && all.length <= 8) {
            const col = cssColor(flood.getAttribute('flood-color') || '#000');
            n.edge = {radius: num(morph.getAttribute('radius')), color: col, opacity: flood.hasAttribute('flood-opacity') ? num(flood.getAttribute('flood-opacity')) : 1};
          } else n.bad = 'filter';
        }
        const c = el.getAttribute('clip-path') || (cs.clipPath && cs.clipPath !== 'none' ? cs.clipPath : null);
        if (c) {
          const cp = this._byId(urlRef(c) || '');
          const kids = cp ? [...cp.children] : [];
          if (cp && cp.getAttribute('clipPathUnits') !== 'objectBoundingBox' && kids.length === 1 && kids[0].localName === 'rect') n.clip = kids[0];
          else n.bad = 'clip-path';
        }
      }
    }
    _visBelow(n) { for (const k of n.kids) { k.vDirty = true; if (k.g) this._visBelow(k); } }
    _local(n) {
      if (n.xDirty) {
        n.xDirty = false;
        const el = n.g ? n.el : n.els[0];
        const sig = moveSig(el);
        if (sig !== n.msig) { n.msig = sig; n.local = localMatrix(el); }
      }
      return n.local;
    }
    // The node's matrix up to the SVG's user space (the viewBox), memoised per version.
    _world(n) {
      if (!n || n === this.root) return I;
      if (n.wver === this.ver) return n.world;
      const p = this._world(n.parent), l = n.kind === 'run' ? null : this._local(n);
      n.world = l ? mul(p, l) : p; n.wver = this.ver;
      return n.world;
    }
    _visibleUp(n) {
      this._vis(n);
      for (let k = n; k && k !== this.root; k = k.parent) if (!k.shown) return false;
      return true;
    }

    // How this engine answers for parts that aren't displayed (WebKit and Chromium differ):
    // selfHidden: 'origin' (a hidden group is a 0x0 box at the origin of its nearest
    //   displayed ancestor; a hidden shape is 0,0,0,0 - WebKit) or 'zero' (all 0,0,0,0);
    // insideHidden (displayed itself, inside something hidden): 'geometry' or 'zero';
    // bboxHidden (getBBox of a hidden element): 'geometry' or 'zero'.
    // Decide those rules from the rig itself, while it's still on the page: for the parts
    // that aren't displayed, which answer does the browser actually give? (Majority.)
    _learnRules() {
      const votes = {originS: 0, zeroS: 0, geomI: 0, zeroI: 0, geomB: 0, zeroB: 0};
      for (const el of this.svg.querySelectorAll('[id]')) {
        if (!(el instanceof global.SVGGraphicsElement) || !this.nodes.has(el)) continue;
        const self = this._selfShown(el), rendered = self && this._rendered(el);
        if (rendered) continue;
        const r = this._nativeRectOf(el);
        let b = null; try { b = this._nativeBBox.call(el); } catch (_) {}
        if (!self) {
          if (r.width === 0 && r.height === 0 && this.nodes.get(el).g) { if (r.x !== 0 || r.y !== 0) votes.originS++; else votes.zeroS++; }
          if (b) { if (b.width > 0 || b.height > 0) votes.geomB++; else votes.zeroB++; }
        } else {
          if (r.width > 0 || r.height > 0) votes.geomI++; else votes.zeroI++;
        }
      }
      this.rules = {
        selfHidden: votes.originS > votes.zeroS ? 'origin' : 'zero',
        insideHidden: votes.geomI > votes.zeroI ? 'geometry' : 'zero',
        bboxHidden: votes.geomB >= votes.zeroB ? 'geometry' : 'zero'
      };
      this.ruleVotes = votes;
    }
    _nativeRectOf(el) { return (this._nativeRect || global.Element.prototype.getBoundingClientRect).call(el); }
    // Is the element itself displayed (its own display, not its ancestors')?
    _selfShown(el) { const n = this.nodes.get(el); if (!n) return true; if (n.g) { this._vis(n); return n.shown; } return this._shapeShown(el); }

    // ------------------------------------------------------------ measuring
    _bbox(shape) {
      if (!this._bboxes) this._bboxes = new Map();
      let b = this._bboxes.get(shape);
      if (b) return b;
      const c = shape.cloneNode(true);
      for (const a of ['id', 'class', 'style', 'transform', 'display', 'opacity', 'pointer-events']) c.removeAttribute(a);
      if (shape.localName === 'text') {
        const cs = this._cs(shape);
        c.setAttribute('style', `font-family:${cs.fontFamily};font-size:${this._len(cs.fontSize)};font-weight:${cs.fontWeight};font-style:${cs.fontStyle};text-anchor:${cs.textAnchor};dominant-baseline:${cs.dominantBaseline};letter-spacing:${cs.letterSpacing}`);
      }
      this.measure.appendChild(c);
      try { const r = c.getBBox(); b = {x: r.x, y: r.y, w: r.width, h: r.height}; } catch (_) { b = {x: 0, y: 0, w: 0, h: 0}; }
      c.remove();
      this._bboxes.set(shape, b);
      return b;
    }
    // Is this shape itself displayed (its own classes/inline/attribute; ancestors aside)?
    _shapeShown(shape) {
      if (!this._shapeVis) this._shapeVis = new WeakMap();
      const sig = (shape.getAttribute('class') || '') + '|' + shape.style.display + '|' + (shape.getAttribute('display') || '') + '|' + this._rootClass;
      const c = this._shapeVis.get(shape);
      if (c && c.sig === sig) return c.shown;
      const shown = this._cs(shape).display !== 'none';
      this._shapeVis.set(shape, {sig, shown});
      return shown;
    }
    // A node's box in its own coordinates, the way the browser does it: each child's box
    // through that child's transform, unioned (so a turned group's box is the loose one).
    _localBox(n, settled) {
      if (n.lver === this.ver) return n.lbox;
      if (!settled && n !== this.root) this._vis(n);
      let box = null;
      for (const k of n.kids) {
        if (k.g) {
          this._vis1(k); if (!k.shown) continue;
          const kb = this._localBox(k, true); if (!kb) continue;
          const l = this._local(k);
          box = union(box, l ? boxThrough(l, kb) : kb);
        } else {
          for (const sh of k.els) {
            if (!this._shapeShown(sh)) continue;
            const b = this._bbox(sh); if (!b.w && !b.h) continue;
            const m = k.kind === 'run' ? attrTransform(sh) : this._local(k);
            box = union(box, m ? boxThrough(m, b) : b);
          }
        }
      }
      n.lbox = box; n.lver = this.ver;
      return box;
    }
    // Shown all the way up (an element inside something display:none has no box).
    _rendered(el) {
      const n = this.nodes.get(el);
      if (!n) return false;
      if (!n.g && !this._shapeShown(el)) return false;
      const top = n.g ? n : n.parent;
      if (top && top !== this.root) this._vis(top);
      for (let k = top; k && k !== this.root; k = k.parent) if (!k.shown) return false;
      return true;
    }
    // Element's own box (its coordinates) and its matrix to the SVG's user space.
    _elementBox(el) {
      const n = this.nodes.get(el);
      if (n.g) return {box: this._localBox(n), m: this._world(n)};
      const b = this._bbox(el);
      let m = this._world(n.parent);
      const own = n.kind === 'run' ? attrTransform(el) : this._local(n);
      if (own) m = mul(m, own);
      return {box: b.w || b.h ? b : null, m};
    }
    _rootCTM() {
      if (this._rootVer !== this.ver || !this._rootM) { this._rootM = fromDOM(this._nativeCTM.call(this.shown ? this.svg : this.proxy)); this._rootVer = this.ver; }
      return this._rootM;
    }

    _patchGeometry() {
      const self = this;
      const proto = global.SVGGraphicsElement && global.SVGGraphicsElement.prototype;
      const eproto = global.Element.prototype;
      this._nativeCTM = proto.getScreenCTM;
      this._nativeRect = eproto.getBoundingClientRect;
      this._nativeBBox = proto.getBBox;
      const mine = el => el !== self.svg && self.nodes.has(el) && !self.stopped && !self.shown;
      const ensure = () => { self._rootClass = self.svg.getAttribute('class') || ''; if (self.structure) self._build(); };
      eproto.getBoundingClientRect = function () {
        if (this === self.svg && !self.shown && !self.stopped) return self._nativeRect.call(self.proxy);
        if (this instanceof global.SVGElement && !self.shown && !self.stopped && self.svg.contains(this)) {
          const ta = performance.now(); PROF.rects++; PROF.who[this.id || this.localName] = (PROF.who[this.id || this.localName] || 0) + 1;
          try { return self._modelRect(this); } finally { PROF.tApi += performance.now() - ta; }
        }
        return self._nativeRect.call(this);
      };
      self._modelRect = function (el) {
        ensure();
        if (!self.nodes.has(el)) return self._nativeRect.call(el);
        const rules = self.rules;
        // Not displayed (itself, or - with the page's pruning CSS, which hides everything
        // inside a hidden group too - because of an ancestor): as this engine answers.
        const own = self._selfShown(el);
        if (!own || (rules.insideHidden !== 'geometry' && !self._rendered(el))) {
          const n = self.nodes.get(el);
          if (rules.selfHidden !== 'origin' || !n.g) return new DOMRect(0, 0, 0, 0);
          let a = n.parent; while (a && a !== self.root && !self._visibleUp(a)) a = a.parent;
          const o = apply(mul(self._rootCTM(), self._world(a)), 0, 0); return new DOMRect(o[0], o[1], 0, 0);
        }
        const {box, m} = self._elementBox(el);
        if (!box) { const o = apply(mul(self._rootCTM(), m), 0, 0); return new DOMRect(o[0], o[1], 0, 0); }
        const r = boxThrough(mul(self._rootCTM(), m), box);
        return new DOMRect(r.x, r.y, r.w, r.h);
      };
      proto.getScreenCTM = function () {
        if (this === self.svg && !self.shown && !self.stopped) return self._nativeCTM.call(self.proxy);
        if (self.svg.contains(this) && this !== self.svg && !self.shown && !self.stopped) {
          PROF.ctms++;
          ensure();
          const n = self.nodes.get(this);
          if (n) { let m = mul(self._rootCTM(), self._world(n.g ? n : n.parent)); if (!n.g && n.kind === 'run') { const own = attrTransform(this); if (own) m = mul(m, own); } else if (!n.g) { const l = self._local(n); if (l) m = mul(m, l); } return new DOMMatrix(m); }
        }
        return self._nativeCTM.call(this);
      };
      proto.getBBox = function () {
        if (self.svg.contains(this) && this !== self.svg && !self.shown && !self.stopped) {
          ensure();
          if (self.nodes.has(this)) {
            // Like this browser: WebKit gives nothing for an element that isn't displayed
            // itself, Chromium gives its geometry anyway.
            if (self.rules.bboxHidden !== 'geometry' && !(self._selfShown(this) && (self.rules.insideHidden === 'geometry' || self._rendered(this)))) return new DOMRect(0, 0, 0, 0);
            const {box} = self._elementBox(this);
            return box ? new DOMRect(box.x, box.y, box.w, box.h) : new DOMRect(0, 0, 0, 0);
          }
        }
        return self._nativeBBox.call(this);
      };
      this._unpatch = () => { eproto.getBoundingClientRect = self._nativeRect; proto.getScreenCTM = self._nativeCTM; proto.getBBox = self._nativeBBox; };
    }

    // ------------------------------------------------------------ pointer: which part?
    _hookEvents() {
      const make = (e, type, bubbles) => {
        const base = {bubbles, cancelable: true, composed: true, clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
          button: e.button, buttons: e.buttons, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
          movementX: e.movementX, movementY: e.movementY, detail: e.detail};
        let s;
        if (type === 'wheel') s = new WheelEvent('wheel', Object.assign(base, {deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode}));
        else if (global.PointerEvent && e instanceof global.PointerEvent) s = new PointerEvent(type, Object.assign(base, {pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary,
          pressure: e.pressure, width: e.width, height: e.height, tiltX: e.tiltX, tiltY: e.tiltY}));
        else s = new MouseEvent(type, base);
        s.__gpu = true;
        return s;
      };
      // Real events arrive at the proxy; the runtime listens on the model. Each one is
      // handed on, to the part under the pointer (as the browser would have), or to the
      // SVG itself while it holds the pointer or nothing is under it.
      const handler = e => {
        if (e.__gpu || this.shown || this.stopped || e.target !== this.proxy) return;
        const captured = e.pointerId != null && this.proxy.hasPointerCapture && this.proxy.hasPointerCapture(e.pointerId);
        const to = (!captured && this.hitTest(e.clientX, e.clientY)) || this.svg;
        if (!to.dispatchEvent(make(e, e.type, true))) e.preventDefault();
      };
      for (const type of EVENTS) this.mount.addEventListener(type, handler, {capture: true, passive: false});
      for (const type of ['pointerleave', 'pointerenter']) this.proxy.addEventListener(type, e => { if (!this.shown && !this.stopped) this.svg.dispatchEvent(make(e, type, false)); });
    }
    // The frontmost visible, hittable shape under a client point (like pointer-events:
    // visiblePainted), or null.
    hitTest(cx, cy) {
      if (this.structure) this._build();
      const list = this._hitList || [];
      const ctx = this.scratch;
      for (let i = list.length - 1; i >= 0; i--) {
        const h = list[i];
        const [x, y] = apply(h.inv, cx, cy);
        const b = h.box, pad = h.pad;
        if (x < b.x - pad || y < b.y - pad || x > b.x + b.w + pad || y > b.y + b.h + pad) continue;
        if (!h.path) h.path = this._path2d(h.el);
        if (!h.path) { return h.el; }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (h.fill && ctx.isPointInPath(h.path, x, y, h.rule)) return h.el;
        if (h.stroke) { ctx.lineWidth = h.sw; ctx.lineCap = h.cap; ctx.lineJoin = h.join; if (ctx.isPointInStroke(h.path, x, y)) return h.el; }
      }
      return null;
    }
    _path2d(el) {
      const a = n => num(el.getAttribute(n));
      let p;
      switch (el.localName) {
        case 'path': p = new Path2D(el.getAttribute('d') || ''); break;
        case 'circle': p = new Path2D(); p.arc(a('cx'), a('cy'), Math.max(0, a('r')), 0, Math.PI * 2); break;
        case 'ellipse': p = new Path2D(); p.ellipse(a('cx'), a('cy'), Math.max(0, a('rx')), Math.max(0, a('ry')), 0, 0, Math.PI * 2); break;
        case 'rect': {
          p = new Path2D();
          const rx = el.hasAttribute('rx') ? a('rx') : el.hasAttribute('ry') ? a('ry') : 0, ry = el.hasAttribute('ry') ? a('ry') : rx;
          if ((rx || ry) && p.roundRect) p.roundRect(a('x'), a('y'), a('width'), a('height'), [{x: rx, y: ry}]); else p.rect(a('x'), a('y'), a('width'), a('height'));
          break;
        }
        case 'line': p = new Path2D(); p.moveTo(a('x1'), a('y1')); p.lineTo(a('x2'), a('y2')); break;
        case 'polyline': case 'polygon': {
          const pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(num); p = new Path2D();
          for (let i = 0; i + 1 < pts.length; i += 2) i ? p.lineTo(pts[i], pts[i + 1]) : p.moveTo(pts[i], pts[i + 1]);
          if (el.localName === 'polygon') p.closePath();
          break;
        }
        default: return null;   // text: its box is close enough
      }
      return p;
    }

    // ------------------------------------------------------------ textures
    _serialize(p, density) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, body = '';
      const refs = new Set();
      p.paint = [];
      for (const el of p.els) {
        const cs = this._cs(el);
        if (cs.display === 'none') continue;
        const b = this._bbox(el);
        if (!b.w && !b.h) continue;
        const stroke = cs.stroke && cs.stroke !== 'none' ? num(this._len(cs.strokeWidth)) : 0;
        const pad = stroke * (cs.strokeLinejoin === 'miter' ? 2.2 : 1) + 2;
        const t = p.kind === 'run' ? attrTransform(el) : null;
        const bb = boxThrough(t || I, {x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2});
        x0 = Math.min(x0, bb.x); y0 = Math.min(y0, bb.y); x1 = Math.max(x1, bb.x + bb.w); y1 = Math.max(y1, bb.y + bb.h);
        const clone = el.cloneNode(true);
        for (const a of ['id', 'class', 'style', 'pointer-events']) clone.removeAttribute(a);
        if (p.kind !== 'run') clone.removeAttribute('transform');
        let style = '';
        for (const prop of PAINT) {
          let v = cs.getPropertyValue(prop);
          if (!v) continue;
          if (prop === 'stroke-width' || prop === 'stroke-dasharray' || prop === 'stroke-dashoffset' || prop === 'font-size' || prop === 'letter-spacing') v = this._len(v);
          const ref = urlRef(v);
          if (ref) { refs.add(ref); v = `url(#${ref})`; }
          style += `${prop}:${v};`;
        }
        clone.setAttribute('style', style);
        body += new XMLSerializer().serializeToString(clone);
        p.paint.push({el, fill: cs.fill && cs.fill !== 'none', stroke: stroke > 0, sw: stroke, cap: cs.strokeLinecap || 'butt', join: cs.strokeLinejoin || 'miter', rule: cs.fillRule === 'evenodd' ? 'evenodd' : 'nonzero'});
      }
      if (!body) return null;
      let defs = '';
      const seen = new Set(), queue = [...refs];
      while (queue.length) {
        const id = queue.shift();
        if (seen.has(id)) continue;
        seen.add(id);
        const d = this._byId(id);
        if (!d) continue;
        const text = new XMLSerializer().serializeToString(d);
        defs += text;
        const href = d.getAttribute('href') || d.getAttribute('xlink:href');
        if (href && href[0] === '#') queue.push(href.slice(1));
        for (const m of text.matchAll(/url\(\s*["']?#([^"')\s]+)/g)) queue.push(m[1]);
      }
      const box = {x: Math.floor(x0), y: Math.floor(y0)};
      box.w = Math.ceil(x1) - box.x; box.h = Math.ceil(y1) - box.y;
      const content = defs + '\u0000' + body;
      return {key: density + '|' + content, content, box, body, defs, density};
    }
    _densityFor(scale) { return Math.pow(2, Math.ceil(Math.log2(scale) * DENSITY_STEPS - 1e-6) / DENSITY_STEPS); }
    _texture(p, m) {
      const eff = scaleOf(m);
      if (p.density && (p.density < eff * .999 || p.density > eff * TOO_FINE)) p.dirty = true;
      if (p.dirty) {
        p.dirty = false;
        const density = this._densityFor(eff);
        p.density = density;
        const s = this._serialize(p, density);
        if (!s) { p.key = null; p.content = null; p.entry = 'empty'; return 'empty'; }
        if (s.key !== p.key) {
          p.key = s.key; p.content = s.content;
          const hit = this.cache.get(s.key);
          if (hit && hit !== 'pending') p.entry = hit;
          else {
            // The same picture at another fineness: fine enough already? use it.
            const alts = this.byContent && this.byContent.get(s.content);
            // closest fineness at or above what's needed, else the finest there is
            const best = alts && (alts.filter(e => e.density >= eff * .999).sort((a, b) => a.density - b.density)[0] || alts.reduce((a, b) => (!a || b.density > a.density ? b : a), null));
            if (best && best.density >= eff * .999 && best.density <= eff * TOO_FINE) { p.entry = best; p.key = best.key; p.density = best.density; }
            // Meanwhile: the same picture less finely, or (for a frame or two) the old one.
            else { this._raster(s); p.entry = best || (p.entry && p.entry !== 'empty' ? p.entry : null); }
          }
        }
      }
      // Pick up the texture once it's ready (it may have been asked for earlier).
      if (p.key && (!p.entry || p.entry.key !== p.key)) {
        const hit = this.cache.get(p.key);
        if (hit && hit !== 'pending') p.entry = hit;
      }
      return p.entry;
    }
    _raster(s) {
      if (this.cache.get(s.key) === 'pending') return;
      this.cache.set(s.key, 'pending');
      const d = s.density, pw = Math.max(1, Math.ceil(s.box.w * d)), ph = Math.max(1, Math.ceil(s.box.h * d));
      // Content inside a translated group, with the viewBox at 0,0: patterns then line
      // up with the part's own coordinates in every engine (WebKit anchored them to the
      // image's corner otherwise).
      const text = `<svg xmlns="${NS}" viewBox="0 0 ${s.box.w} ${s.box.h}" width="${pw}" height="${ph}">`
        + (s.defs ? `<defs>${s.defs}</defs>` : '') + `<g transform="translate(${-s.box.x} ${-s.box.y})">` + s.body + '</g></svg>';
      const img = new this.win.Image();
      const done = ok => {
        if (this.stopped || this.lost) return;
        if (ok) {
          // Through a 2D canvas: one decode, and the same pixels in every engine.
          const c = this.doc.createElement('canvas'); c.width = pw; c.height = ph;
          c.getContext('2d').drawImage(img, 0, 0, pw, ph);
          if (this.cache.size >= MAX_TEXTURES) this._evict();
          const entry = {key: s.key, tex: upload(this.G, c), box: s.box, w: pw, h: ph, used: this.stats.draws, density: s.density, content: s.content};
          this.cache.set(s.key, entry);
          if (!this.byContent) this.byContent = new Map();
          if (!this.byContent.has(s.content)) this.byContent.set(s.content, []);
          this.byContent.get(s.content).push(entry);
          this.stats.textures++;
        } else {
          this.cache.set(s.key, 'empty');
          this.log('gpu: a piece failed to rasterise');
        }
        this.request();
      };
      img.onload = () => done(true);
      img.onerror = () => done(false);
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
    }
    _evict() {
      const inUse = new Set(this.pieces.map(p => p.entry));
      let n = 0;
      for (const [k, v] of this.cache) {
        if (v && v.tex && !inUse.has(v) && this.stats.draws - v.used > 300) {
          this.G.gl.deleteTexture(v.tex); this.cache.delete(k);
          const alts = this.byContent && this.byContent.get(v.content);
          if (alts) { const i = alts.indexOf(v); if (i >= 0) alts.splice(i, 1); if (!alts.length) this.byContent.delete(v.content); }
          if (++n > 100) break;
        }
      }
    }
    // A shape whose geometry keeps changing: drawn into its own small canvas when it changes.
    _liveTexture(p, m) {
      const el = p.els[0];
      if (p.dirty) {
        p.dirty = false; p.geom = true;
        const cs = this._cs(el);
        p.lp = {shown: cs.display !== 'none', fill: cs.fill, stroke: cs.stroke, fo: num(cs.fillOpacity || 1), so: num(cs.strokeOpacity || 1),
          op: cs.opacity === '' ? 1 : num(cs.opacity), sw: num(this._len(cs.strokeWidth || '1px')), cap: cs.strokeLinecap || 'butt', join: cs.strokeLinejoin || 'miter',
          miter: num(cs.strokeMiterlimit || 4), dash: cs.strokeDasharray && cs.strokeDasharray !== 'none' ? this._len(cs.strokeDasharray).split(/[\s,]+/).map(num) : null,
          dashOff: num(this._len(cs.strokeDashoffset)), rule: cs.fillRule === 'evenodd' ? 'evenodd' : 'nonzero'};
        if (urlRef(p.lp.fill) || urlRef(p.lp.stroke)) p.lp.bad = true;
        p.paint = [{el, fill: p.lp.fill && p.lp.fill !== 'none', stroke: p.lp.stroke && p.lp.stroke !== 'none', sw: p.lp.sw, cap: p.lp.cap, join: p.lp.join, rule: p.lp.rule}];
      }
      const lp = p.lp;
      if (!lp.shown) return 'empty';
      if (lp.bad) { this._bad = 'pattern on a moving shape'; return 'empty'; }
      const eff = scaleOf(m), density = this._densityFor(eff);
      if (!p.geom && p.entry && p.entry.density === density) return p.entry;
      p.geom = false;
      this._bboxes && this._bboxes.delete(el);
      const b = this._bbox(el);
      const pad = (lp.stroke && lp.stroke !== 'none' ? lp.sw * (lp.join === 'miter' ? 2.2 : 1) : 0) + 2;
      const box = {x: Math.floor(b.x - pad), y: Math.floor(b.y - pad)}; box.w = Math.ceil(b.x + b.w + pad) - box.x; box.h = Math.ceil(b.y + b.h + pad) - box.y;
      const pw = Math.max(1, Math.min(4096, Math.ceil(box.w * density))), ph = Math.max(1, Math.min(4096, Math.ceil(box.h * density)));
      if (!p.canvas) p.canvas = this.doc.createElement('canvas');
      const c = p.canvas; if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
      const x = c.getContext('2d');
      x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, pw, ph);
      x.setTransform(pw / box.w, 0, 0, ph / box.h, -box.x * pw / box.w, -box.y * ph / box.h);
      const path = this._path2d(el);
      x.globalAlpha = lp.op;
      if (path && lp.fill && lp.fill !== 'none') { x.globalAlpha = lp.op * lp.fo; x.fillStyle = lp.fill; x.fill(path, lp.rule); }
      if (path && lp.stroke && lp.stroke !== 'none' && lp.sw > 0) {
        x.globalAlpha = lp.op * lp.so; x.strokeStyle = lp.stroke; x.lineWidth = lp.sw; x.lineCap = lp.cap; x.lineJoin = lp.join; x.miterLimit = lp.miter;
        x.setLineDash(lp.dash || []); x.lineDashOffset = lp.dashOff; x.stroke(path);
      }
      const gl = this.G.gl;
      if (p.entry && p.entry.tex && p.entry.live) {
        gl.bindTexture(gl.TEXTURE_2D, p.entry.tex);
        put(gl, c);
        Object.assign(p.entry, {box, w: pw, h: ph, density});
      } else {
        p.entry = {tex: upload(this.G, c), box, w: pw, h: ph, density, live: true};
      }
      return p.entry;
    }

    // ------------------------------------------------------------ drawing
    _layout() {
      let x = 0, y = 0;
      for (let e = this.mount; e; e = e.offsetParent) { x += e.offsetLeft; y += e.offsetTop; }
      const W = this.win.innerWidth, H = this.win.innerHeight, dpr = this.win.devicePixelRatio || 1;
      const sig = [x, y, W, H, dpr].join(',');
      if (sig !== this._layoutSig) {
        this._layoutSig = sig;
        this.canvas.width = Math.max(1, Math.round(W * dpr));
        this.canvas.height = Math.max(1, Math.round(H * dpr));
        Object.assign(this.canvas.style, {left: -x + 'px', top: -y + 'px', width: W + 'px', height: H + 'px'});
        this.ver++;
      }
      this.dpr = dpr;
      // user space -> canvas pixels
      const cr = this._nativeRect.call(this.canvas);
      const k = this.canvas.width / Math.max(1, cr.width);
      this.base = mul([k, 0, 0, k, -cr.left * k, -cr.top * k], this._rootCTM());
    }
    _quad(entry, m, alpha, mode, tint, dx, dy) {
      const tq0 = performance.now(); PROF.quads++;
      const G = this.G, gl = G.gl, b = entry.box;
      const q = mul(m, [b.w, 0, 0, b.h, b.x, b.y]);
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      gl.uniform4f(G.uM, q[0], q[1], q[2], q[3]);
      gl.uniform2f(G.uT, q[4] + (dx || 0), q[5] + (dy || 0));
      gl.uniform1f(G.uAlpha, alpha);
      gl.uniform1i(G.uMode, mode || 0);
      if (tint) gl.uniform4f(G.uTint, tint[0], tint[1], tint[2], tint[3]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      entry.used = this.stats.draws;
      PROF.tQuad += performance.now() - tq0;
    }
    _walk(node, m, alpha, pass) {
      for (const k of node.kids) {
        if (k.g) {
          this._vis1(k);
          if (!k.shown || k.alpha <= 0) continue;
          if (k.bad) { this._bad = k.bad; continue; }
          const l = this._local(k), km = l ? mul(m, l) : m, ka = alpha * k.alpha;
          k.world = l ? mul(this._world(node), l) : this._world(node); k.wver = this.ver;
          if (k.edge && !pass) {
            const r = k.edge.radius * scaleOf(km);
            for (let i = 0; i < 12; i++) {
              const a = i / 12 * Math.PI * 2;
              this._walk(k, km, ka, {tint: [k.edge.color[0], k.edge.color[1], k.edge.color[2], k.edge.color[3] * k.edge.opacity], dx: Math.cos(a) * r, dy: Math.sin(a) * r});
            }
          }
          if (k.clip) this._clipped(k, km, () => this._walk(k, km, ka, pass));
          else this._walk(k, km, ka, pass);
        } else {
          let pm = m, entry;
          if (k.kind !== 'run') { const l = this._local(k); if (l) pm = mul(m, l); this._vis1(k); if (!k.shown) continue; }
          entry = k.kind === 'live' ? this._liveTexture(k, pm) : this._texture(k, pm);
          if (entry === 'empty') continue;
          if (!entry) { this._missing++; continue; }
          if (pass) this._quad(entry, pm, alpha, 1, pass.tint, pass.dx, pass.dy);
          else {
            this._quad(entry, pm, alpha, 0);
            if (this._drawn) for (const e of k.els) this._drawn.push(e);
            if (k.pe && node.pe !== false) this._collectHits(k, pm);
          }
        }
      }
    }
    _collectHits(p, deviceM) {
      // In client coordinates: user space through the root CTM.
      const userM = mul(inv(this.base), deviceM);
      const clientM = mul(this._rootCTM(), userM);
      for (const info of p.paint || []) {
        const el = info.el;
        if (el.style.display === 'none' || el.getAttribute('display') === 'none') continue;
        const own = p.kind === 'run' ? attrTransform(el) : null;
        const cm = own ? mul(clientM, own) : clientM;
        this._hits.push({el, inv: inv(cm), box: this._bbox(el), pad: info.stroke ? info.sw / 2 + 1 : 0, fill: info.fill, stroke: info.stroke, sw: info.sw, cap: info.cap, join: info.join, rule: info.rule, path: null});
      }
    }
    _clipped(g, m, draw) {
      const G = this.G, gl = G.gl, r = g.clip, a = n => num(r.getAttribute(n));
      const q = mul(m, [a('width'), 0, 0, a('height'), a('x'), a('y')]);
      gl.enable(gl.STENCIL_TEST);
      gl.clear(gl.STENCIL_BUFFER_BIT);
      gl.stencilFunc(gl.ALWAYS, 1, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
      gl.colorMask(false, false, false, false);
      gl.uniform4f(G.uM, q[0], q[1], q[2], q[3]); gl.uniform2f(G.uT, q[4], q[5]); gl.uniform1i(G.uMode, 2);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.colorMask(true, true, true, true);
      gl.stencilFunc(gl.EQUAL, 1, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      draw();
      gl.disable(gl.STENCIL_TEST);
    }

    draw() {
      try { this._draw(); this._failing = 0; }
      catch (error) {
        // A frame that fails again and again would leave him invisible: give the page
        // back to the real SVG for good (as when WebGL is lost).
        if ((this._failing = (this._failing || 0) + 1) >= 5 && !this.stopped) { this.log('gpu: frames keep failing, back to SVG'); try { this.stop(); } catch (_) {} return; }
        const msg = String(error && error.message || error);
        if (!this._errs) this._errs = new Set();
        if (!this._errs.has(msg)) { this._errs.add(msg); this.log('gpu error: ' + msg + ' @ ' + String(error && error.stack || '').split('\n').slice(0, 3).join(' | ')); }
      }
    }
    _draw() {
      if (this.stopped || this.lost) return;
      const t0 = performance.now();
      const waiting = this.observer.takeRecords();
      if (waiting.length) this._mutated(waiting);
      this._rootClass = this.svg.getAttribute('class') || '';
      if (this.structure) this._build();
      if (this.restyle) {
        this.restyle = false;
        for (const g of this.groups) { g.vDirty = true; g.vsig = undefined; }
        for (const p of this.pieces) { p.dirty = true; p.vDirty = true; p.vsig = undefined; }
      }
      const tl0 = performance.now();
      this._layout();
      PROF.tLayout += performance.now() - tl0;
      const tw0 = performance.now();
      const gl = this.G.gl;
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.uniform2f(this.G.uView, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      this._missing = 0; this._bad = this.unsupported; this._hits = [];
      this._walk(this.root, this.base, 1, null);
      PROF.tWalk += performance.now() - tw0; PROF.frames++;
      this._hitList = this._hits;
      this.stats.draws++;
      const why = this._bad || (this._missing ? `${this._missing} pieces still loading` : null);
      if (!why && this.shown) this._swapIn();
      this.stats.reason = why || 'gpu';
      if (why && !this.shown && why !== this._lastWhy) this.log('gpu: ' + why);
      this._lastWhy = why;
      this.stats.drawMs = this.stats.drawMs * .9 + (performance.now() - t0) * .1;
    }
    // Everything is drawable: the model leaves the document, the proxy takes its place.
    _swapIn() {
      if (!this.ruleVotes) { this._rootClass = this.svg.getAttribute('class') || ''; this._learnRules(); }
      this.shown = false;
      this.svg.parentNode.insertBefore(this.proxy, this.svg);
      this.svg.remove();
      this._shimAll();
      this.canvas.style.visibility = 'visible';
      this.ver++;
      this.request();
      if (!this._prewarmed) { this._prewarmed = true; this.log('gpu: drawing'); this.win.setTimeout(() => this._prewarm(), 1500); }
    }
    // In quiet moments, get the pieces that aren't on screen yet (other outfits,
    // expressions, props) ready, so changing into them never shows a gap.
    _prewarm() {
      if (this.stopped || this.lost) return;
      if (this.structure) this._build();
      const todo = this.pieces.filter(p => p.kind !== 'live' && !p.key && p.entry !== 'empty');
      let i = 0;
      const step = () => {
        if (this.stopped || this.lost) return;
        const t0 = performance.now();
        while (i < todo.length && performance.now() - t0 < 4) {
          const p = todo[i++];
          if (p.key || !this.pieces.includes(p)) continue;
          let m = mul(this.base, this._world(p.parent));
          if (p.kind === 'solo') { const l = this._local(p); if (l) m = mul(m, l); }
          try { this._texture(p, m); } catch (_) {}
        }
        if (i < todo.length) this.win.setTimeout(step, 60);
        else this.stats.prewarmed = todo.length;
      };
      step();
    }
    _fallback(why) { this.stats.reason = why; }
    // For comparisons: put the real SVG back on the page for a moment, and take it away.
    showReal() { if (this.shown) return; this._unshimAll(); this.proxy.parentNode.insertBefore(this.svg, this.proxy); this.proxy.remove(); this.shown = true; this.ver++; }
    hideReal() { if (!this.shown || this.stopped) return; this._swapIn(); }
    stop() {
      if (this.stopped) return;
      if (!this.shown) this._unshimAll();
      this.stopped = true;
      this.observer.disconnect();
      this._unpatch(); this._unpatchLookups();
      delete this.svg.parentNode;
      for (const f of ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture']) delete this.svg[f];
      if (!this.shown && this.proxy.parentNode) { this.proxy.parentNode.insertBefore(this.svg, this.proxy); this.proxy.remove(); }
      this.shown = true;
      this.canvas.remove(); this.measure.remove(); this.mirrorBox.remove();
    }
  }

  global.ArthurGPU = {
    profile(reset) { const f = Math.max(1, PROF.frames), out = {frames: PROF.frames, perFrame: {rects: +(PROF.rects / f).toFixed(1), ctms: +(PROF.ctms / f).toFixed(1), apiMs: +(PROF.tApi / f).toFixed(3), top: Object.entries(PROF.who).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => k + ':' + (v / f).toFixed(1)).join(' '), mutMs: +(PROF.tMut / f).toFixed(3), layoutMs: +(PROF.tLayout / f).toFixed(3), walkMs: +(PROF.tWalk / f).toFixed(3), quadMs: +(PROF.tQuad / f).toFixed(3), quads: +(PROF.quads / f).toFixed(1), computedStyle: +(PROF.cs / f).toFixed(2), parses: +(PROF.parse / f).toFixed(1)}}; if (reset) { for (const k in PROF) PROF[k] = 0; PROF.who = {}; } return out; },
    attach(svg, mount, options) {
      if (!svg || !mount || typeof global.DOMMatrix !== 'function' || typeof global.Path2D !== 'function') return null;
      try { return (global.ArthurGPU.instance = new GpuArthur(svg, mount, options)); }
      catch (error) { (options && options.log || (() => {}))('gpu off: ' + (error && error.message)); return null; }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
