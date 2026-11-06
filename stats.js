// ตัวอ่านค่าสถานะของ Aetheria Online: ใส่ใหม่ทุกครั้งที่ตัวจัดการเชื่อมต่อ (ไม่ต้องกด F5 เวลาอัปเดต)
window.__gameRestStats = (() => {
  let isTop = false;
  try { isTop = window.top === window; } catch {}

  // จดเวลาที่ Edge แช่แข็ง/ปลุกแท็บ (Sleeping tabs / Efficiency mode) ไว้ให้ตัวจัดการอ่าน
  if (!window.__grLife) {
    window.__grLife = { frozenAt: 0, resumedAt: 0 };
    document.addEventListener('freeze', () => { window.__grLife.frozenAt = Date.now(); });
    document.addEventListener('resume', () => { window.__grLife.resumedAt = Date.now(); });
  }

  // วัดความหน่วงตอนเปิดจอกลับมา: รวมงานที่บล็อกหน้าเกมเกิน 50 ms ในช่วง 30 วิแรก
  if (!window.__grRestore) {
    const restore = window.__grRestore = { hiddenAt: document.hidden ? Date.now() : 0, last: null };
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        restore.hiddenAt = Date.now();
        return;
      }
      const hiddenMs = restore.hiddenAt ? Date.now() - restore.hiddenAt : 0;
      let total = 0;
      let max = 0;
      let count = 0;
      const observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          total += e.duration;
          max = Math.max(max, e.duration);
          count++;
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
      setTimeout(() => {
        observer.disconnect();
        restore.last = { at: Date.now(), hiddenMs, total: Math.round(total), max: Math.round(max), count };
      }, 30000);
    });
  }

  // อ่านข้อมูลกระเป๋า/ตัวละครที่ HUD ของเกมถืออยู่ (ผ่าน React fiber) => น้ำหนัก/Zeny แบบเรียลไทม์
  function hudData(hud) {
    const key = Object.keys(hud).find((k) => k.startsWith('__reactFiber$'));
    const out = {};
    let f = key && hud[key];
    for (let i = 0; f && i < 20 && !(out.inv && out.char); i++, f = f.return) {
      if (typeof f.type !== 'function') continue;
      for (let h = f.memoizedState, j = 0; h && j < 60; h = h.next, j++) {
        const v = h.memoizedState;
        if (!v || typeof v !== 'object') continue;
        if (!out.inv && 'weightLimit' in v && 'weight' in v) out.inv = v;
        if (!out.char && 'zeny' in v && 'baseLevel' in v) out.char = v;
      }
    }
    return out;
  }

  // อ่านค่าสถานะจาก HUD ของ Aetheria Online (ถ้าอ่านจาก React ไม่ได้ จะใช้ค่าจากหน้าต่างกระเป๋าล่าสุดแทน)
  const lastSeen = {};
  const itemNames = new Map();
  function readStats() {
    if (!isTop || !/(^|\.)aetheria-online\.in\.th$/.test(location.hostname)) return null;
    const hud = document.querySelector('.hud-status');
    // ไม่มี HUD = ไม่ได้อยู่ในแผนที่ (หน้าล็อกอิน / หลุด / กำลังโหลด)
    if (!hud) return { inGame: false };
    const txt = (sel, root = document) => root.querySelector(sel)?.textContent.trim() || '';
    const bar = (root) => root && {
      text: txt('.bar-num', root),
      pct: parseFloat(root.querySelector('.bar-fill')?.style.width) || 0
    };
    const bars = {};
    for (const b of hud.querySelectorAll('.bar')) bars[b.firstElementChild?.textContent.trim()] = bar(b);
    const lv = [...hud.querySelectorAll('.hud-levels span')].map((s) => s.textContent.replace(/\D+/g, ''));
    const zeny = txt('.inv-zeny b');
    if (zeny) lastSeen.zeny = zeny;
    const weight = document.querySelector('.inv-weight');
    if (weight) lastSeen.weight = bar(weight);
    try {
      const { inv, char } = hudData(hud);
      if (char && typeof char.zeny === 'number') lastSeen.zeny = char.zeny.toLocaleString('en-US');
      if (inv && inv.weightLimit > 0) {
        const n = (x) => Math.round(x).toLocaleString('en-US');
        lastSeen.weight = { text: n(inv.weight) + '/' + n(inv.weightLimit), pct: inv.weight / inv.weightLimit * 100 };
      }
      if (char && Array.isArray(char.buffs)) {
        // VIP ของเกมนี้คือบัพ Premium (ui:token) ไม่มีบัพนี้ = ไม่มี Premium
        lastSeen.premiumEndsAt = char.buffs.find((b) => b.skillId === 'ui:token')?.endsAt || 0;
      }
      if (char && inv) {
        // ของในแถบไอเทม + ของที่ลากไว้ในคีย์ลัด 1-9 (ชื่อจำไว้ เผื่อของหมดจนไม่อยู่ในกระเป๋า)
        const ids = [...(char.itemBar || []), ...(char.hotbar || []).map((h) => (h?.type === 'item' ? h.itemId : null))];
        // ของที่หมดไม่มีชื่อในข้อมูลกระเป๋า: เดาจากชื่อไฟล์ไอคอนในแถบไอเทม เช่น berserk-potion => Berserk Potion
        const slots = document.querySelectorAll('.itembar .hot-slot');
        (char.itemBar || []).forEach((id, i) => {
          const slug = slots[i]?.querySelector('img')?.src.match(/\/([\w-]+)\.webp/)?.[1];
          if (id != null && slug && !itemNames.has(id)) {
            itemNames.set(id, slug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '));
          }
        });
        lastSeen.items = [...new Set(ids.filter((id) => id != null))].map((id) => {
          const stacks = (inv.items || []).filter((it) => it.itemId === id);
          if (stacks[0]?.name) itemNames.set(id, stacks[0].name);
          return { name: itemNames.get(id) || '#' + id, qty: stacks.reduce((sum, it) => sum + it.qty, 0) };
        });
      }
    } catch {}
    const auto = document.querySelector('.auto-toggle');
    return {
      inGame: true,
      name: txt('.hud-name', hud),
      cls: txt('.hud-class', hud),
      baseLv: lv[0] || '',
      jobLv: lv[1] || '',
      hp: bars.HP || null,
      sp: bars.SP || null,
      base: bars.Base || null,
      job: bars.Job || null,
      heavy: txt('.hud-heavy', hud),
      zeny: lastSeen.zeny || null,
      weight: lastSeen.weight || null,
      // หน้าเช็คผู้เล่นของเกม: แค่อ่านไปเตือน ผู้เล่นต้องตอบเอง
      humanCheck: document.querySelector('.human-check')
        ? { prompt: txt('.human-check-prompt'), meta: txt('.human-check-meta') }
        : null,
      premiumEndsAt: lastSeen.premiumEndsAt,
      items: lastSeen.items || null,
      map: document.title.split('·')[0].trim(),
      ch: txt('.minimap-ch').replace('▾', '').trim(),
      auto: auto ? auto.getAttribute('aria-checked') === 'true' : null
    };
  }

  return readStats;
})();
