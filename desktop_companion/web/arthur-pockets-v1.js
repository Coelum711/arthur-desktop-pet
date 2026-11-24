(function (global) {
  'use strict';

  // What he has on him. Pet-only. A few of his own everyday things turn up and
  // get put away again over time; things she gave him (a book, a rose, files)
  // go in too. Never more than a handful: a gentleman doesn't bulge.
  const OWN = [
    {id:'watch', icon:'🕰️', name:'怀表', about:'怀表。……很旧了，但走得比谁都准。'},
    {id:'pen', icon:'🖋️', name:'钢笔', about:'钢笔。墨水是深蓝的，别问为什么不是黑的。'},
    {id:'mint', icon:'🍬', name:'薄荷糖', about:'薄荷糖。……不是给薄荷兔的。好吧，有时候是。'},
    {id:'spoon', icon:'🥄', name:'茶匙', about:'茶匙。出门在外，总得有个像样的茶匙。'},
    {id:'key', icon:'🔑', name:'家门钥匙', about:'家门钥匙。别想着复制一把。'},
    {id:'coin', icon:'🪙', name:'一英镑硬币', about:'一英镑。……现在连杯像样的茶都买不到了。'},
    {id:'notebook', icon:'📓', name:'口袋笔记本', about:'笔记本。里面写了什么，不告诉你。'},
    {id:'teabags', icon:'🫖', name:'几个茶包', about:'茶包。英国人出门都会带的。'},
    {id:'oyster', icon:'🎫', name:'牡蛎卡', about:'坐地铁用的牡蛎卡。……别笑这个名字。'},
    {id:'glasscloth', icon:'👓', name:'眼镜布', about:'擦眼镜的布。眼镜……我只是偶尔戴。'},
    {id:'letter', icon:'✉️', name:'一封旧信', about:'……一封很旧的信。别碰。'}
  ];
  const MAX_ITEMS = 6;
  const HOUR = 3600 * 1000;

  function makePockets(options={}) {
    const save = typeof options.save === 'function' ? options.save : () => {};
    const random = options.random || Math.random;
    let items = [];
    const pockets = {
      list() { return items.map(i => Object.assign({}, i)); },
      load(raw) {
        try {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (Array.isArray(parsed)) items = parsed.filter(i => i && i.id && i.icon && i.name).slice(0, MAX_ITEMS);
        } catch (_error) { /* keep what we have */ }
        if (!items.length) pockets.seed();
      },
      seed() {
        const pool = OWN.slice();
        items = [];
        for (let k = 0; k < 3 && pool.length; k++) items.push(Object.assign({addedAt:Date.now()}, pool.splice(Math.floor(random() * pool.length), 1)[0]));
        save(items);
      },
      add(item) {
        if (!item || items.some(i => i.id === item.id)) return false;
        items.push(Object.assign({addedAt:Date.now()}, item));
        while (items.length > MAX_ITEMS) items.shift();      // the oldest gets put away
        save(items);
        return true;
      },
      take(id) {
        const found = items.find(i => i.id === id);
        if (!found) return null;
        items = items.filter(i => i.id !== id);
        save(items);
        return found;
      },
      put(item) { return pockets.add(item); },
      gift(kind, label) {
        const gifts = {book:{icon:'📕', name:'你送的书', about:'你送的书。……还没看完，别催。'}, rose:{icon:'🌹', name:'你送的玫瑰', about:'玫瑰。我会把它夹进书里。'}};
        const g = gifts[kind];
        if (g) return pockets.add(Object.assign({id:'gift-' + kind + '-' + Date.now()}, g));
        if (kind === 'file') return pockets.add({id:'file-' + Date.now(), icon:'📄', name:label || '你给的文件', about:'你塞给我的文件。……我只看了名字。'});
        return false;
      },
      // Now and then he puts something away, or something of his turns up.
      churn(now=Date.now()) {
        const before = items.length;
        items = items.filter(i => {
          const age = now - (i.addedAt || now);
          const own = OWN.some(o => o.id === i.id);
          if (own && age > 3 * HOUR) return random() > .4;
          if (!own && age > 8 * HOUR) return random() > .5;
          return true;
        });
        if (items.length < 4 && random() < .45) {
          const fresh = OWN.filter(o => !items.some(i => i.id === o.id));
          if (fresh.length) items.push(Object.assign({addedAt:now}, fresh[Math.floor(random() * fresh.length)]));
        }
        if (items.length !== before || true) save(items);
      }
    };
    return pockets;
  }

  global.ArthurPockets = {OWN, MAX_ITEMS, makePockets};
})(typeof window !== 'undefined' ? window : globalThis);
