// ตัวเชื่อม Chrome DevTools Protocol แบบเล็กๆ (ใช้ WebSocket ที่มากับ Node 22)
class CDP {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const c = new CDP();
      c.ws = new WebSocket(url);
      c.ws.onopen = () => resolve(c);
      c.ws.onerror = () => reject(new Error('เชื่อมต่อ DevTools ไม่ได้'));
      c.ws.onclose = () => {
        c.closed = true;
        for (const p of c.pending.values()) p.reject(new Error('การเชื่อมต่อปิดแล้ว'));
        c.pending.clear();
        c.onclose?.();
      };
      c.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id != null) {
          const p = c.pending.get(m.id);
          if (!p) return;
          c.pending.delete(m.id);
          if (m.error) p.reject(new Error(m.error.message));
          else p.resolve(m.result);
        } else {
          for (const h of c.handlers) h(m);
        }
      };
    });
  }

  constructor() {
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Set();
    this.closed = false;
    this.onclose = null;
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('การเชื่อมต่อปิดแล้ว'));
    const id = ++this.nextId;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('หมดเวลา ' + method));
      }, 15000);
    });
  }

  on(handler) {
    this.handlers.add(handler);
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

module.exports = { CDP };
