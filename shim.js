// ฉีดเข้าทุกเฟรมของหน้าเกม: ลดเฟรม requestAnimationFrame + จอดำ + ปิดเสียง ตอนพัก
// ไม่แตะ WebSocket / setTimeout / setInterval => เกมยังส่ง heartbeat ได้ ไม่หลุด
(() => {
  if (window.__gameRest) return;
  let isTop = false;
  try { isTop = window.top === window; } catch {}

  const nativeRAF = window.requestAnimationFrame.bind(window);
  const nativeCAF = window.cancelAnimationFrame.bind(window);
  const pending = new Map();
  const audioCtxs = new Set();
  let nextId = 1e9;
  let resting = false;
  let fps = 1;
  let timer = null;
  let lastInput = Date.now();
  let wakeRequested = false;
  let styleEl = null;
  let overlayEl = null;

  function runAll(ts) {
    const cbs = [...pending.values()];
    pending.clear();
    for (const cb of cbs) {
      try { cb(ts); } catch (e) { setTimeout(() => { throw e; }); }
    }
  }

  function flush() {
    timer = null;
    if (!resting) return;
    runAll(performance.now());
    if (pending.size) schedule();
  }

  function schedule() {
    if (!timer) timer = setTimeout(flush, 1000 / fps);
  }

  window.requestAnimationFrame = function requestAnimationFrame(cb) {
    if (!resting) return nativeRAF(cb);
    const id = nextId++;
    pending.set(id, cb);
    schedule();
    return id;
  };
  window.cancelAnimationFrame = function cancelAnimationFrame(id) {
    if (pending.delete(id)) return;
    nativeCAF(id);
  };
  if (window.webkitRequestAnimationFrame) {
    window.webkitRequestAnimationFrame = window.requestAnimationFrame;
    window.webkitCancelAnimationFrame = window.cancelAnimationFrame;
  }

  // จำ AudioContext ไว้เพื่อหยุดเสียงตอนพัก
  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const Native = window[name];
    if (typeof Native !== 'function') continue;
    const Wrapped = function (...args) {
      const ctx = new Native(...args);
      audioCtxs.add(ctx);
      return ctx;
    };
    Wrapped.prototype = Native.prototype;
    window[name] = Wrapped;
  }

  function setAudio(off) {
    for (const c of audioCtxs) {
      try {
        if (off && c.state === 'running') { c.__grS = 1; c.suspend().catch(() => {}); }
        else if (!off && c.__grS) {
          c.__grS = 0;
          // เกมอาจปิด AudioContext ไปแล้วระหว่างพัก
          if (c.state !== 'closed') c.resume().catch(() => {});
        }
      } catch {}
    }
    for (const m of document.querySelectorAll('audio,video')) {
      if (off && !m.muted) { m.muted = true; m.__grM = 1; }
      else if (!off && m.__grM) { m.muted = false; m.__grM = 0; }
    }
  }

  function showVisuals(on) {
    const root = document.documentElement;
    if (!root) return;
    if (!on) {
      styleEl?.remove();
      overlayEl?.remove();
      return;
    }
    if (!styleEl) {
      styleEl = document.createElement('style');
      // ซ่อน canvas/video ให้การ์ดจอไม่ต้องวาด
      styleEl.textContent = 'canvas,video{visibility:hidden!important}';
    }
    (document.head || root).appendChild(styleEl);
    if (!isTop) return;
    if (!overlayEl) {
      overlayEl = document.createElement('div');
      overlayEl.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;background:#000;color:#777;' +
        'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
        'font:16px "Segoe UI",Tahoma,sans-serif;cursor:pointer;user-select:none';
    }
    const t = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    overlayEl.innerHTML =
      '<div style="font-size:40px">💤</div>' +
      '<div style="margin-top:8px">พักจออยู่ (ตั้งแต่ ' + t + ') — เกมยังเชื่อมต่ออยู่</div>' +
      '<div style="margin-top:4px;font-size:13px">คลิกเพื่อกลับมาเล่น</div>';
    root.appendChild(overlayEl);
  }

  function set(on, newFps, mute) {
    if (newFps > 0) fps = newFps;
    if (on === resting) {
      if (on && timer) { clearTimeout(timer); timer = null; schedule(); }
      return;
    }
    resting = on;
    if (on) {
      if (mute) setAudio(true);
    } else {
      clearTimeout(timer);
      timer = null;
      if (pending.size) nativeRAF(runAll);
      setAudio(false);
      lastInput = Date.now();
      wakeRequested = false;
    }
    showVisuals(on);
  }

  function onInput() {
    lastInput = Date.now();
    if (!resting) return;
    if (isTop) set(false);
    // บอกตัวจัดการให้ปลุกเฟรมอื่นๆ ของหน้านี้ด้วย
    wakeRequested = true;
  }
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(ev, onInput, true);
  }

  function info() {
    const wake = wakeRequested;
    wakeRequested = false;
    return { top: isTop, resting, idleMs: Date.now() - lastInput, focused: document.hasFocus(), wake };
  }

  Object.defineProperty(window, '__gameRest', { value: { set, info } });
})();
