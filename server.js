'use strict';
// ตัวจัดการพักจอเกม: เปิด Edge แยกโปรไฟล์ แล้วคุมทุกจอผ่าน DevTools Protocol
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { CDP } = require('./cdp');
const { encrypt, decrypt } = require('./secret');
const updater = require('./updater');

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');
const PORT = Number(process.env.PORT) || 50360;
const BASE_DEBUG_PORT = 9320;
const SHIM = fs.readFileSync(path.join(ROOT, 'shim.js'), 'utf8');
const STATS = fs.readFileSync(path.join(ROOT, 'stats.js'), 'utf8');
const AUTOLOGIN = fs.readFileSync(path.join(ROOT, 'autologin.js'), 'utf8');
const POLL_EXPR =
  'window.__gameRest&&Object.assign(window.__gameRest.info(),' +
  '{hidden:document.hidden,life:window.__grLife||null,restore:window.__grRestore?window.__grRestore.last:null,' +
  'screen:([[".hud-status","ในเกม"],[".reconnecting","กำลังเชื่อมต่อใหม่"],[".two-step","ยืนยัน 2 ขั้น"],' +
  '[".char-select","เลือกตัวละคร"],["form.login-card","หน้าล็อกอิน"]].find(x=>document.querySelector(x[0]))||[0,"อื่นๆ"])[1],' +
  'stats:typeof window.__gameRestStats==="function"?window.__gameRestStats():null})';

// ---------- บันทึกเหตุการณ์ (events.log) ไว้หาสาเหตุเวลาเกมหลุด ----------
const LOG_FILE = path.join(ROOT, 'events.log');
function logEvent(name, msg) {
  const t = new Date().toLocaleString('th-TH', { hour12: false });
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1048576) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    }
    fs.appendFileSync(LOG_FILE, `${t} [${name}] ${msg}\n`);
  } catch {}
}
const CORES = os.cpus().length;
const DISCONNECT_MS = 10000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- ข้อมูลที่บันทึกไว้ ----------
const DEFAULT_DATA = {
  settings: { idleSec: 30, fps: 1, mute: true, stallMin: 5, trimBelowGB: 2, trimEveryMin: 0, edgePath: '' },
  profiles: {},   // ชื่อโปรไฟล์ -> { dir, port }
  accounts: []    // { id, name, profile, url, auto, targetId }
};

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { ...DEFAULT_DATA, ...d, settings: { ...DEFAULT_DATA.settings, ...d.settings } };
  } catch {
    return structuredClone(DEFAULT_DATA);
  }
}
const data = load();
delete data.settings.trimMin; // ค่าเก่า: เปลี่ยนจากคืนตามเวลาเป็นคืนตาม RAM ว่าง (trimBelowGB)

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)), 200);
}

function getProfile(name) {
  if (!data.profiles[name]) {
    const used = Object.values(data.profiles);
    const n = used.length + 1;
    data.profiles[name] = { dir: 'p' + n, port: BASE_DEBUG_PORT + n };
    save();
  }
  return data.profiles[name];
}

function findEdge() {
  const sub = 'Microsoft/Edge/Application/msedge.exe';
  const candidates = [
    data.settings.edgePath,
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], sub),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, sub),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, sub)
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

// ---------- สถานะระหว่างทำงาน (ไม่บันทึก) ----------
const runtime = new Map();
function rtOf(acc) {
  if (!runtime.has(acc.id)) {
    runtime.set(acc.id, { status: 'closed', resting: false, cpu: 0, heapMB: 0, idleSec: 0, focused: false, error: '', prev: null });
  }
  return runtime.get(acc.id);
}

// ---------- หน้าเกม 1 บัญชี ----------
class GamePage {
  constructor(browser, acc) {
    this.b = browser;
    this.acc = acc;
    this.targetId = acc.targetId;
    this.top = null;
    this.sessions = new Set();
    this.contexts = new Map(); // "session:contextId" -> { sid, id }
    this.resting = null;       // null = ยังไม่รู้ (เพิ่งเชื่อมต่อ)
  }

  send(method, params, sid) {
    return this.b.cdp.send(method, params, sid);
  }

  async attachTop() {
    const { sessionId } = await this.b.cdp.send('Target.attachToTarget', { targetId: this.targetId, flatten: true });
    this.top = sessionId;
    await this.setup(sessionId);
    await this.send('Performance.enable', {}, sessionId).catch(() => {});
  }

  async setup(sid) {
    this.sessions.add(sid);
    this.b.sessionOwner.set(sid, this);
    await Promise.all([
      this.send('Page.addScriptToEvaluateOnNewDocument', { source: SHIM }, sid).catch(() => {}),
      // iframe ข้ามโดเมน (เช่นเกมที่ฝังใน iframe) ต้องเชื่อมแยก
      this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid).catch(() => {})
    ]);
    // Runtime.enable จะส่ง executionContextCreated ของทุกเฟรมที่มีอยู่แล้วกลับมาด้วย
    await this.send('Runtime.enable', {}, sid).catch(() => {});
    await this.send('Inspector.enable', {}, sid).catch(() => {});
  }

  onEvent(m) {
    const sid = m.sessionId;
    const p = m.params;
    switch (m.method) {
      case 'Runtime.executionContextCreated':
        if (p.context.auxData?.isDefault) {
          this.contexts.set(sid + ':' + p.context.id, { sid, id: p.context.id });
          this.initContext(sid, p.context.id);
        }
        break;
      case 'Runtime.executionContextDestroyed':
        this.contexts.delete(sid + ':' + p.executionContextId);
        break;
      case 'Runtime.executionContextsCleared':
        for (const [k, c] of this.contexts) if (c.sid === sid) this.contexts.delete(k);
        break;
      case 'Target.attachedToTarget':
        if (p.targetInfo.type === 'iframe') this.setup(p.sessionId).catch(() => {});
        else this.send('Target.detachFromTarget', { sessionId: p.sessionId }, sid).catch(() => {});
        break;
      case 'Target.detachedFromTarget':
        this.dropSession(p.sessionId);
        break;
      case 'Inspector.targetCrashed':
        logEvent(this.acc.name, '💥 แท็บเกม crash (Aw, Snap)');
        break;
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails;
        this.logLimited('JS error: ' + String(d.exception?.description || d.text || '').split('\n')[0]);
        break;
      }
      case 'Runtime.consoleAPICalled':
        if (p.type === 'error' || p.type === 'warning') {
          const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
          this.logLimited(`console.${p.type}: ${text}`);
        }
        break;
    }
  }

  // กัน log ท่วม: ไม่เกิน 20 บรรทัดต่อนาทีต่อจอ
  logLimited(msg) {
    const now = Date.now();
    if (!this.logWin || now - this.logWin > 60000) { this.logWin = now; this.logCount = 0; }
    if (++this.logCount > 20) return;
    logEvent(this.acc.name, msg.replace(/\s+/g, ' ').slice(0, 300));
  }

  dropSession(sid) {
    this.sessions.delete(sid);
    this.b.sessionOwner.delete(sid);
    for (const [k, c] of this.contexts) if (c.sid === sid) this.contexts.delete(k);
  }

  gone() {
    for (const sid of [...this.sessions]) this.dropSession(sid);
    this.b.pages.delete(this.targetId);
  }

  async evaluate(sid, contextId, expression) {
    // แท็บที่ถูกแช่แข็งจะไม่ตอบ: ตัดที่ 3 วิ ไม่ให้ลูปหลักค้างรอจอเดียว
    const r = await Promise.race([
      this.send('Runtime.evaluate', { expression, contextId, returnByValue: true }, sid),
      sleep(3000).then(() => { throw new Error('timeout'); })
    ]);
    return r?.result?.value;
  }

  // สั่งให้แท็บกลับมาทำงาน ถ้า Edge แช่แข็งไว้ (ไม่มีผลถ้าแท็บทำงานอยู่แล้ว)
  keepAwake() {
    return this.send('Page.setWebLifecycleState', { state: 'active' }, this.top).catch(() => {});
  }

  setExpr(on) {
    const s = data.settings;
    return `window.__gameRest&&window.__gameRest.set(${!!on},${Number(s.fps) || 1},${!!s.mute})`;
  }

  async initContext(sid, id) {
    // STATS ใส่ทับทุกครั้ง => หน้าเกมที่เปิดค้างไว้ได้ตัวอ่านค่าล่าสุดเสมอ
    let expr = SHIM + ';' + STATS + ';' + AUTOLOGIN;
    if (this.resting !== null) expr += ';' + this.setExpr(this.resting);
    await this.evaluate(sid, id, expr).catch(() => {});
  }

  async setRest(on) {
    this.resting = on;
    const expr = this.setExpr(on);
    await Promise.all([...this.contexts.values()].map((c) => this.evaluate(c.sid, c.id, expr).catch(() => {})));
  }

  async poll() {
    const ctxs = [...this.contexts.values()];
    const infos = await Promise.all(ctxs.map((c) =>
      this.evaluate(c.sid, c.id, POLL_EXPR).catch(() => null)));
    const out = { idleMs: Infinity, focused: false, wake: false, resting: null, stats: null };
    for (const [i, v] of infos.entries()) {
      if (!v) continue;
      out.idleMs = Math.min(out.idleMs, v.idleMs);
      out.focused ||= v.focused;
      out.wake ||= v.wake;
      if (v.top) {
        this.topCtx = ctxs[i];
        out.resting = v.resting;
        out.hidden = !!v.hidden;
        out.screen = v.screen;
        out.life = v.life;
        out.restore = v.restore;
        out.stats = v.stats;
      }
    }
    return out;
  }

  async evalTop(expression) {
    const c = this.topCtx;
    if (!c || !this.contexts.has(c.sid + ':' + c.id)) return null;
    return this.evaluate(c.sid, c.id, expression);
  }

  async metrics() {
    const r = await this.send('Performance.getMetrics', {}, this.top);
    const m = Object.fromEntries(r.metrics.map((x) => [x.name, x.value]));
    return { task: m.TaskDuration, heap: m.JSHeapUsedSize, ts: m.Timestamp };
  }
}

// ---------- Edge 1 โปรไฟล์ ----------
const browsers = new Map();
function getBrowser(name) {
  if (!browsers.has(name)) browsers.set(name, new Browser(name));
  return browsers.get(name);
}

class Browser {
  constructor(name) {
    this.name = name;
    this.prof = getProfile(name);
    this.cdp = null;
    this.pages = new Map();        // targetId -> GamePage
    this.sessionOwner = new Map(); // sessionId -> GamePage
    this.attaching = new Set();
    this.connecting = null;
    this.cpu = 0;
    this.ramMB = 0;
    this.pids = [];
    this.cpuPrev = null;
  }

  async version() {
    const r = await fetch(`http://127.0.0.1:${this.prof.port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.json();
  }

  // คืนค่า true ถ้าเพิ่งเปิด Edge ขึ้นมาใหม่
  async ensure(launch) {
    if (this.cdp) return false;
    if (this.connecting) {
      try { return await this.connecting; } catch (e) { if (!launch) throw e; }
      if (this.cdp) return false;
    }
    this.connecting = this.connect(launch);
    try { return await this.connecting; } finally { this.connecting = null; }
  }

  async connect(launch) {
    let v = await this.version().catch(() => null);
    let launched = false;
    if (!v) {
      if (!launch) throw new Error('Edge โปรไฟล์นี้ยังไม่เปิด');
      const exe = findEdge();
      if (!exe) throw new Error('หา msedge.exe ไม่เจอ (ตั้งค่า edgePath ใน data.json)');
      const dir = path.join(ROOT, 'profiles', this.prof.dir);
      spawn(exe, [
        `--user-data-dir=${dir}`,
        `--remote-debugging-port=${this.prof.port}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-crash-restore-bubble',
        // กันเกมหลุดตอนย่อหน้าต่าง: ไม่ให้ Edge หน่วงตัวจับเวลาของแท็บที่ไม่ได้ดู
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-features=IntensiveWakeUpThrottling',
        'about:blank'
      ], { detached: true, stdio: 'ignore' }).unref();
      launched = true;
      for (let i = 0; i < 40 && !v; i++) {
        await sleep(500);
        v = await this.version().catch(() => null);
      }
      if (!v) throw new Error('เปิด Edge ไม่สำเร็จ');
    }
    const cdp = await CDP.connect(v.webSocketDebuggerUrl);
    cdp.on((m) => this.onEvent(m));
    cdp.onclose = () => {
      logEvent('โปรไฟล์ ' + this.name, 'Edge ถูกปิด หรือการเชื่อมต่อกับ Edge หลุด');
      this.cdp = null;
      for (const p of [...this.pages.values()]) p.gone();
      this.cpu = 0;
      this.ramMB = 0;
      this.pids = [];
      this.cpuPrev = null;
    };
    this.cdp = cdp;
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    return launched;
  }

  onEvent(m) {
    if (m.sessionId) {
      this.sessionOwner.get(m.sessionId)?.onEvent(m);
      return;
    }
    if (m.method === 'Target.targetDestroyed') {
      const p = this.pages.get(m.params.targetId);
      if (p) logEvent(p.acc.name, 'แท็บเกมถูกปิด');
      p?.gone();
    } else if (m.method === 'Target.detachedFromTarget') {
      const p = this.sessionOwner.get(m.params.sessionId);
      if (p && p.top === m.params.sessionId) p.gone();
    }
  }

  async attach(acc) {
    if (this.pages.has(acc.targetId) || this.attaching.has(acc.targetId)) return;
    this.attaching.add(acc.targetId);
    const page = new GamePage(this, acc);
    try {
      this.pages.set(acc.targetId, page);
      await page.attachTop();
    } catch (e) {
      page.gone();
      throw e;
    } finally {
      this.attaching.delete(acc.targetId);
    }
  }
}

function pageOf(acc) {
  return acc.targetId ? browsers.get(acc.profile)?.pages.get(acc.targetId) : null;
}

// ---------- คำสั่ง ----------
async function openAccount(acc) {
  const rt = rtOf(acc);
  rt.status = 'starting';
  rt.error = '';
  try {
    const b = getBrowser(acc.profile);
    const launched = await b.ensure(true);
    const { targetInfos } = await b.cdp.send('Target.getTargets');
    const exists = acc.targetId && targetInfos.some((t) => t.targetId === acc.targetId && t.type === 'page');
    if (!exists) {
      const r = await b.cdp.send('Target.createTarget', { url: acc.url, newWindow: true });
      acc.targetId = r.targetId;
      save();
      if (launched) {
        // ปิดหน้า about:blank ที่ Edge เปิดมาตอนเริ่ม
        for (const t of targetInfos) {
          if (t.type === 'page' && t.url === 'about:blank') b.cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
        }
      }
    }
    await b.attach(acc);
    await pageOf(acc)?.setRest(false);
    await revealWindow(acc).catch(() => {});
    rt.status = 'open';
  } catch (e) {
    rt.status = pageOf(acc) ? 'open' : 'closed';
    rt.error = e.message;
  }
}

// ---------- ใส่รหัสในหน้าล็อกอินให้ (ผู้เล่นกดเข้าเกมเอง) ----------
const passCache = new Map(); // acc.id -> { enc, pass }
async function getPassword(acc) {
  const enc = acc.login?.passEnc;
  if (!enc) return null;
  const hit = passCache.get(acc.id);
  if (hit?.enc === enc) return hit.pass;
  const pass = await decrypt(enc);
  passCache.set(acc.id, { enc, pass });
  return pass;
}

const LOGIN_MESSAGES = {
  reconnecting: 'เกมกำลังเชื่อมต่อใหม่เอง… รอก่อน',
  twostep: '⚠ ต้องใส่รหัสยืนยัน 2 ขั้นเองที่หน้าเกม',
  'register-mode': '⚠ หน้าเกมอยู่ที่หน้าสมัครบัญชี — กดกลับไปหน้าเข้าสู่ระบบ',
  filled: '🔑 ใส่รหัสให้แล้ว — กด "เข้าเกม" เองที่หน้าเกม',
  'char-select': 'เลือกตัวละครเองที่หน้าเกม',
  other: 'กำลังรอหน้าล็อกอิน…'
};

async function loginTick(acc, page, rt, stats) {
  const L = acc.login;
  if (!L?.auto || !L.user || !L.passEnc || !stats || stats.inGame) {
    rt.loginMsg = '';
    return;
  }
  const pass = await getPassword(acc);
  const cfg = { user: L.user, pass };
  const r = await page.evalTop(`window.__gameRestLogin&&window.__gameRestLogin(${JSON.stringify(cfg)})`).catch(() => null);
  if (r) rt.loginMsg = LOGIN_MESSAGES[r.state] || '';
}

// ปิด Edge ทั้งโปรไฟล์แล้วเปิดจอเดิมกลับมา เพื่อคืนหน่วยความจำที่สะสมตามเวลา
async function restartProfile(name) {
  const b = browsers.get(name);
  if (!b?.cdp || b.restarting) return;
  b.restarting = true;
  try {
    const accounts = data.accounts.filter((a) => a.profile === name && pageOf(a)?.top);
    logEvent('โปรไฟล์ ' + name, `เปิด Edge ใหม่ (${accounts.length} จอ, ส่วนการ์ดจอจอง ${Math.round(b.gpuMB || 0)} MB)`);
    await b.cdp.send('Browser.close').catch(() => {});
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      if (!b.cdp && !(await b.version().catch(() => null))) break;
    }
    b.gpuMB = 0;
    for (const acc of accounts) {
      await openAccount(acc);
      await sleep(2000);
    }
  } finally {
    b.restarting = false;
  }
}

// เอาหน้าต่างของบัญชีนี้ขึ้นมาให้เห็น (ถ้าถูกย่อไว้จะคืนขนาดก่อน)
async function revealWindow(acc) {
  const b = browsers.get(acc.profile);
  if (!b?.cdp || !acc.targetId) return;
  const { windowId, bounds } = await b.cdp.send('Browser.getWindowForTarget', { targetId: acc.targetId });
  const setState = (windowState) => b.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState } });
  if (bounds?.windowState === 'minimized') await setState('normal');
  await b.cdp.send('Target.activateTarget', { targetId: acc.targetId });
  await sleep(300);
  // Windows มักไม่ยอมให้โปรแกรมดึงหน้าต่างขึ้นหน้าสุดตรงๆ: ถ้ายังไม่ได้โฟกัส ให้พับแล้วคืนเพื่อดันขึ้นมา
  const focused = await pageOf(acc)?.evalTop('document.hasFocus()').catch(() => false);
  if (!focused) {
    const restoreTo = bounds?.windowState === 'maximized' ? 'maximized' : 'normal';
    await setState('minimized');
    await sleep(150);
    await setState(restoreTo);
    await b.cdp.send('Target.activateTarget', { targetId: acc.targetId });
  }
}

async function closeAccount(acc) {
  const b = browsers.get(acc.profile);
  if (b?.cdp && acc.targetId) await b.cdp.send('Target.closeTarget', { targetId: acc.targetId }).catch(() => {});
  pageOf(acc)?.gone();
  rtOf(acc).status = 'closed';
}

function trimProcesses(pids) {
  if (!pids.length) return Promise.resolve();
  const ps =
    `$s='[DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr h);';` +
    `Add-Type -MemberDefinition $s -Name W -Namespace GR;` +
    `foreach($i in @(${pids.join(',')})){try{[GR.W]::EmptyWorkingSet((Get-Process -Id $i -EA Stop).Handle)|Out-Null}catch{}}`;
  return new Promise((r) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }, () => r()));
}

async function trimProfile(name) {
  const b = browsers.get(name);
  if (!b?.cdp) return;
  await Promise.all([...b.pages.values()].map((p) => p.send('HeapProfiler.collectGarbage', {}, p.top).catch(() => {})));
  const before = Math.round(b.ramMB);
  await trimProcesses(b.pids);
  b.lastTrimAt = Date.now();
  logEvent('โปรไฟล์ ' + name, `คืน RAM (ก่อนคืน ${before} MB)`);
}

// คืน RAM อัตโนมัติ: เมื่อ RAM ว่างทั้งเครื่องต่ำกว่าที่ตั้งไว้ หรือครบรอบเวลาที่ตั้งไว้ และเฉพาะโปรไฟล์ที่ทุกจอพักอยู่หรือถูกย่อ
// (คืนตอนมีจอกำลังเล่นจะทำให้จอนั้นกระตุก) กรณี RAM ต่ำเริ่มจากโปรไฟล์ที่ใช้ RAM มากสุด แล้วหยุดทันทีที่ RAM ว่างพอ
const TRIM_IDLE_MS = 30000;
const TRIM_COOLDOWN_MS = 5 * 60000;
async function autoTrimTick() {
  const limitBytes = data.settings.trimBelowGB * 1024 ** 3;
  const everyMin = data.settings.trimEveryMin;
  const candidates = [];
  for (const [name, b] of browsers) {
    if (!b.cdp) continue;
    const open = data.accounts.filter((a) => a.profile === name && pageOf(a)?.top);
    if (!open.length) continue;
    const idle = open.every((a) => rtOf(a).resting || rtOf(a).hidden);
    if (!idle) {
      b.idleSince = null;
      continue;
    }
    b.idleSince ??= Date.now();
    if (Date.now() - b.idleSince < TRIM_IDLE_MS) continue;
    const sinceTrim = Date.now() - (b.lastTrimAt || 0);
    const timedDue = everyMin > 0 && sinceTrim >= everyMin * 60000;
    if (!timedDue && sinceTrim < TRIM_COOLDOWN_MS) continue;
    candidates.push([name, b, timedDue]);
  }
  candidates.sort((x, y) => y[1].ramMB - x[1].ramMB);
  for (const [name, , timedDue] of candidates) {
    const lowRam = limitBytes > 0 && os.freemem() < limitBytes;
    if (!timedDue && !lowRam) continue;
    logEvent('โปรไฟล์ ' + name, lowRam
      ? `RAM ว่างเหลือ ${Math.round(os.freemem() / 1048576)} MB ต่ำกว่าที่ตั้งไว้`
      : `ครบรอบคืน RAM ทุก ${everyMin} นาที (RAM ว่าง ${Math.round(os.freemem() / 1048576)} MB)`);
    await trimProfile(name);
  }
}

// นับรายได้จากการฟาม: Zeny + มูลค่าขยะ ขายขยะให้ร้านจึงไม่ทำให้ยอดเปลี่ยน นับเวลาเฉพาะตอนอยู่ในเกมและเปิด AUTO
function updateFarm(rt, st) {
  if (st.zenyN == null || !st.junk) return;
  const now = Date.now();
  const total = st.zenyN + st.junk.value;
  if (!rt.farm || rt.farm.who !== st.name) rt.farm = { who: st.name, startTotal: total, activeMs: 0, lastAt: now };
  const f = rt.farm;
  const dt = now - f.lastAt;
  f.lastAt = now;
  if (st.auto && dt < 10000) f.activeMs += dt;
  f.gain = total - f.startTotal;
}

// ---------- ลูปทำงานเบื้องหลัง ----------
// เชื่อมกับ Edge/แท็บที่เปิดค้างไว้ (เช่นตอนรีสตาร์ทโปรแกรมนี้)
async function reconcile() {
  const names = new Set(data.accounts.map((a) => a.profile));
  for (const name of names) {
    const b = getBrowser(name);
    if (b.restarting) continue;
    try { await b.ensure(false); } catch { continue; }
    let infos;
    try { ({ targetInfos: infos } = await b.cdp.send('Target.getTargets')); } catch { continue; }
    for (const acc of data.accounts) {
      if (acc.profile !== name || !acc.targetId) continue;
      const exists = infos.some((t) => t.targetId === acc.targetId && t.type === 'page');
      const page = b.pages.get(acc.targetId);
      if (exists && !page) b.attach(acc).catch(() => {});
      else if (!exists && page) page.gone();
    }
  }
}

async function tick() {
  const s = data.settings;
  await Promise.all(data.accounts.map(async (acc) => {
    const rt = rtOf(acc);
    const page = pageOf(acc);
    if (!page || !page.top) {
      if (rt.status !== 'starting') rt.status = 'closed';
      rt.resting = false;
      rt.disconnected = false;
      rt.offSince = null;
      rt.stalled = false;
      rt.sig = null;
      rt.humanCheck = null;
      return;
    }
    rt.status = 'open';
    const info = await page.poll().catch(() => null);
    if (!info) return;
    // หลุด/อยู่หน้าล็อกอินเกิน 10 วิ (เผื่อเวลาโหลดแผนที่) => ปลุกจอให้เห็น และไม่พักอัตโนมัติ
    if (info.stats?.inGame === false) {
      rt.offSince ??= Date.now();
      rt.disconnected = Date.now() - rt.offSince > DISCONNECT_MS;
    } else if (info.stats) {
      rt.offSince = null;
      rt.disconnected = false;
      rt.stats = info.stats;
      updateFarm(rt, info.stats);
      // เปิด AUTO อยู่แต่ทุกค่าไม่ขยับเลยนานเกินกำหนด => น่าจะค้าง
      const st = info.stats;
      const sig = JSON.stringify([st.hp?.text, st.sp?.text, st.base?.text, st.job?.text, st.zeny, st.weight?.text, st.map]);
      if (sig !== rt.sig || !st.auto) {
        rt.sig = sig;
        rt.sigSince = Date.now();
      }
      rt.stalled = s.stallMin > 0 && Date.now() - rt.sigSince > s.stallMin * 60000;
    }
    // เกมขึ้นเช็คผู้เล่น: ปลุกจอและเปิดหน้าต่างให้เห็น 1 ครั้งต่อคำถาม ไม่ตอบแทน
    const humanCheck = info.stats?.humanCheck || null;
    if (humanCheck && !rt.humanCheck) {
      logEvent(acc.name, '⚠ เกมขึ้นเช็คผู้เล่น: ' + humanCheck.meta);
      revealWindow(acc).catch(() => {});
    }
    rt.humanCheck = humanCheck;
    const problem = rt.disconnected || rt.stalled || humanCheck;
    if (info.wake || (problem && page.resting)) {
      await page.setRest(false);
    } else if (page.resting === null && info.resting !== null) {
      page.resting = info.resting;
    } else if (s.idleSec > 0 && acc.auto && !problem && !page.resting && !info.focused && info.idleMs > s.idleSec * 1000) {
      await page.setRest(true);
    }
    rt.resting = !!page.resting;
    rt.hidden = !!info.hidden;
    rt.focused = info.focused;
    const resumedAt = info.life?.resumedAt || 0;
    if (resumedAt && resumedAt !== rt.lastResumedAt) {
      if (rt.lastResumedAt !== undefined) {
        const secs = Math.round((resumedAt - (info.life.frozenAt || resumedAt)) / 1000);
        logEvent(acc.name, `⚠ Edge แช่แข็งแท็บเกม (Sleeping tabs/Efficiency mode) ไป ${secs} วินาที แล้วปลุกกลับ`);
      }
      rt.lastResumedAt = resumedAt;
    } else if (rt.lastResumedAt === undefined) {
      rt.lastResumedAt = resumedAt;
    }
    if (info.restore && info.restore.at !== rt.lastRestoreAt) {
      rt.lastRestoreAt = info.restore.at;
      const r = info.restore;
      const trimAt = browsers.get(acc.profile)?.lastTrimAt;
      logEvent(acc.name, `เปิดจอกลับหลังซ่อน ${Math.round(r.hiddenMs / 60000)} นาที: เกมหน่วงรวม ${r.total} ms ` +
        `(${r.count} ครั้ง ยาวสุด ${r.max} ms) · ` +
        (s.trimBelowGB > 0 ? `คืน RAM เมื่อว่างต่ำกว่า ${s.trimBelowGB} GB` : 'คืนตาม RAM ว่างปิดอยู่') +
        (s.trimEveryMin > 0 ? ` · คืนตามรอบทุก ${s.trimEveryMin} นาที` : '') +
        (trimAt ? ` · คืน RAM ล่าสุด ${Math.round((Date.now() - trimAt) / 60000)} นาทีก่อน` : ''));
    }
    const snap = [info.screen, info.hidden, page.resting, rt.disconnected, rt.stalled].join('|');
    if (snap !== rt.lastSnap) {
      rt.lastSnap = snap;
      logEvent(acc.name, `จอ: ${info.screen} · หน้าต่าง${info.hidden ? 'ถูกย่อ/มองไม่เห็น' : 'เปิดอยู่'} · ${page.resting ? 'พักจอ' : 'ไม่พัก'}` +
        (rt.disconnected ? ' · ⚠ นับว่าหลุด' : '') + (rt.stalled ? ' · ⚠ ค่าไม่ขยับ' : ''));
    }
    await loginTick(acc, page, rt, info.stats).catch(() => {});
    rt.idleSec = Number.isFinite(info.idleMs) ? Math.round(info.idleMs / 1000) : 0;
  }));
}

// จอที่ถูกย่อ/มองไม่เห็น: Edge อาจแช่แข็งแท็บ (Sleeping tabs / Efficiency mode) จนเซิร์ฟเวอร์ตัดการเชื่อมต่อ
// => สั่งปลุกทุก 5 วิ ให้แท็บถูกแช่ได้ไม่นานพอจะหลุด
async function keepAwakeTick() {
  await Promise.all(data.accounts.map((acc) => {
    const page = pageOf(acc);
    if (!page?.top || !rtOf(acc).hidden) return null;
    return page.keepAwake();
  }));
}

async function metricsTick() {
  await Promise.all(data.accounts.map(async (acc) => {
    const page = pageOf(acc);
    const rt = rtOf(acc);
    if (!page?.top) { rt.cpu = 0; rt.heapMB = 0; rt.prev = null; return; }
    const m = await page.metrics().catch(() => null);
    if (!m) return;
    if (rt.prev && m.ts > rt.prev.ts) rt.cpu = Math.max(0, (m.task - rt.prev.task) / (m.ts - rt.prev.ts) / CORES * 100);
    rt.prev = m;
    rt.heapMB = m.heap / 1048576;
  }));
}

function memByPid() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq msedge.exe', '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, out) => {
      const mem = new Map();
      if (!err) {
        for (const line of out.split(/\r?\n/)) {
          const cols = line.match(/"([^"]*)"/g);
          if (!cols || cols.length < 5) continue;
          mem.set(Number(cols[1].replace(/\D/g, '')), Number(cols[4].replace(/\D/g, '')));
        }
      }
      resolve(mem);
    });
  });
}

async function processTick() {
  const active = [...browsers.values()].filter((b) => b.cdp);
  if (!active.length) return;
  const mem = await memByPid();
  for (const b of active) {
    try {
      const { processInfo } = await b.cdp.send('SystemInfo.getProcessInfo');
      const now = Date.now();
      const total = processInfo.reduce((sum, p) => sum + p.cpuTime, 0);
      if (b.cpuPrev) b.cpu = Math.max(0, (total - b.cpuPrev.t) / ((now - b.cpuPrev.w) / 1000) / CORES * 100);
      b.cpuPrev = { t: total, w: now };
      b.pids = processInfo.map((p) => p.id);
      b.gpuPids = processInfo.filter((p) => /gpu/i.test(p.type)).map((p) => p.id);
      b.ramMB = b.pids.reduce((sum, id) => sum + (mem.get(id) || 0), 0) / 1024;
    } catch {}
  }
}

// เช็กอัปเดต: เจอเวอร์ชันใหม่ => ลงไฟล์แล้วออกด้วยรหัส 3 ให้ start.bat เปิดโปรแกรมใหม่ (เกมที่เปิดอยู่ไม่ปิดตาม)
const RESTART_CODE = 3;
async function updateTick() {
  try {
    const r = await updater.checkAndApply((msg) => logEvent('อัปเดต', msg));
    if (!r) return;
    console.log(`อัปเดตเป็นเวอร์ชัน ${r.version} แล้ว กำลังเริ่มโปรแกรมใหม่…`);
    setTimeout(() => process.exit(RESTART_CODE), 500);
  } catch (e) {
    logEvent('อัปเดต', 'เช็กอัปเดตไม่สำเร็จ: ' + e.message);
  }
}

// จดหน่วยความจำที่ส่วนการ์ดจอของแต่ละโปรไฟล์จองไว้ ดูว่าโตเร็วแค่ไหน
function gpuTick() {
  const active = [...browsers.entries()].filter(([, b]) => b.cdp && b.gpuPids?.length);
  if (!active.length) return Promise.resolve();
  const ids = active.flatMap(([, b]) => b.gpuPids).join(',');
  const ps = `Get-Process -Id ${ids} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.PagedMemorySize64)" }`;
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }, (err, out) => {
      const bytes = new Map(String(out).trim().split(/\r?\n/).map((l) => l.split(' ').map(Number)));
      for (const [name, b] of active) {
        const mb = b.gpuPids.reduce((sum, id) => sum + (bytes.get(id) || 0), 0) / 1048576;
        if (mb > 0) {
          b.gpuMB = mb;
          logEvent('โปรไฟล์ ' + name, `ส่วนการ์ดจอจอง ${Math.round(mb)} MB`);
        }
      }
      resolve();
    });
  });
}

function loop(fn, ms) {
  const run = async () => {
    try { await fn(); } catch (e) { console.error(e.message); }
    setTimeout(run, ms);
  };
  run();
}

// ---------- HTTP / หน้าควบคุม ----------
function state() {
  const accounts = data.accounts.map((a) => {
    const rt = rtOf(a);
    return {
      id: a.id, name: a.name, profile: a.profile, url: a.url, auto: a.auto,
      status: rt.status, resting: rt.resting, focused: rt.focused, idleSec: rt.idleSec,
      cpu: rt.cpu, heapMB: rt.heapMB, error: rt.error, stats: rt.stats || null,
      farm: rt.farm ? { gain: rt.farm.gain || 0, activeMs: rt.farm.activeMs } : null,
      disconnected: !!rt.disconnected,
      stalled: !!rt.stalled && !rt.disconnected,
      humanCheck: rt.humanCheck || null,
      // ไม่ส่งรหัสผ่านออกไปหน้าควบคุมเด็ดขาด
      login: a.login ? { user: a.login.user, auto: !!a.login.auto, hasPass: !!a.login.passEnc } : null,
      loginMsg: rt.loginMsg || ''
    };
  });
  const names = [...new Set(data.accounts.map((a) => a.profile))];
  const profiles = names.map((name) => {
    const b = browsers.get(name);
    return { name, running: !!b?.cdp, cpu: b?.cpu || 0, ramMB: b?.ramMB || 0, gpuMB: b?.gpuMB || 0, restarting: !!b?.restarting, lastTrimAt: b?.lastTrimAt || 0 };
  });
  return {
    settings: data.settings,
    version: updater.localVersion().version || 0,
    accounts,
    profiles,
    totals: {
      open: accounts.filter((a) => a.status === 'open').length,
      disconnected: accounts.filter((a) => a.disconnected).length,
      stalled: accounts.filter((a) => a.stalled).length,
      resting: accounts.filter((a) => a.resting).length,
      cpu: profiles.reduce((s, p) => s + p.cpu, 0),
      ramMB: profiles.reduce((s, p) => s + p.ramMB, 0),
      freeMB: os.freemem() / 1048576
    }
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    // รวมเป็น Buffer ก่อนแปลง กันภาษาไทยเพี้ยนตอนตัวอักษรถูกตัดข้ามชิ้นข้อมูล
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); }
    });
  });
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function handleApi(req, res, parts) {
  const body = req.method === 'POST' ? await readBody(req) : {};
  const [, , kind, id, action] = parts; // /api/<kind>/<id>/<action>

  if (req.method === 'GET' && kind === 'state') return sendJSON(res, 200, state());

  if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method' });

  if (kind === 'settings') {
    const s = data.settings;
    if (body.idleSec != null) s.idleSec = Math.max(0, Number(body.idleSec) || 0);
    if (body.fps != null) s.fps = Math.min(30, Math.max(0.2, Number(body.fps) || 1));
    if (body.mute != null) s.mute = !!body.mute;
    if (body.stallMin != null) s.stallMin = Math.max(0, Number(body.stallMin) || 0);
    if (body.trimBelowGB != null) s.trimBelowGB = Math.max(0, Number(body.trimBelowGB) || 0);
    if (body.trimEveryMin != null) s.trimEveryMin = Math.max(0, Number(body.trimEveryMin) || 0);
    save();
    // ใช้ fps ใหม่กับจอที่พักอยู่
    for (const acc of data.accounts) {
      const p = pageOf(acc);
      if (p?.resting) p.setRest(true);
    }
    return sendJSON(res, 200, state());
  }

  if (kind === 'all') {
    const on = id === 'rest';
    await Promise.all(data.accounts.map((a) => pageOf(a)?.setRest(on)));
    return sendJSON(res, 200, state());
  }

  if (kind === 'profiles' && action === 'restart') {
    restartProfile(decodeURIComponent(id)).catch((e) => logEvent('โปรไฟล์', 'เปิด Edge ใหม่ไม่สำเร็จ: ' + e.message));
    return sendJSON(res, 200, state());
  }

  if (kind === 'profiles' && action === 'trim') {
    await trimProfile(decodeURIComponent(id));
    return sendJSON(res, 200, state());
  }

  if (kind === 'reorder') {
    const rank = new Map((Array.isArray(body.ids) ? body.ids : []).map((x, i) => [x, i]));
    // รับเฉพาะรายการที่ครบทุกบัญชี กันลำดับเก่าจากหน้าที่เปิดค้างทำบัญชีหาย/สลับผิด
    if (rank.size !== data.accounts.length || !data.accounts.every((a) => rank.has(a.id))) {
      return sendJSON(res, 400, { error: 'รายการบัญชีเปลี่ยนไปแล้ว ลองกด F5 แล้วทำใหม่' });
    }
    data.accounts.sort((x, y) => rank.get(x.id) - rank.get(y.id));
    save();
    return sendJSON(res, 200, state());
  }

  if (kind === 'accounts' && !id) {
    const name = String(body.name || '').trim();
    const url = String(body.url || '').trim();
    const profile = String(body.profile || '').trim() || 'โปรไฟล์ 1';
    if (!name || !/^https?:\/\//i.test(url)) return sendJSON(res, 400, { error: 'ใส่ชื่อและลิงก์เกม (http/https) ให้ครบ' });
    data.accounts.push({ id: Date.now().toString(36), name, profile, url, auto: true, targetId: null });
    getProfile(profile);
    save();
    return sendJSON(res, 200, state());
  }

  const acc = data.accounts.find((a) => a.id === id);
  if (kind !== 'accounts' || !acc) return sendJSON(res, 404, { error: 'ไม่พบบัญชี' });

  switch (action) {
    case 'open': await openAccount(acc); break;
    case 'rest': await pageOf(acc)?.setRest(true); break;
    case 'wake': await pageOf(acc)?.setRest(false); break;
    case 'close': await closeAccount(acc); break;
    case 'trim': await trimProfile(acc.profile); break;
    case 'auto': acc.auto = !!body.on; save(); break;
    case 'login': {
      if (body.clear) {
        delete acc.login;
        passCache.delete(acc.id);
        save();
        break;
      }
      const user = String(body.user || '').trim();
      if (!user) return sendJSON(res, 400, { error: 'ใส่ชื่อผู้ใช้' });
      const prev = acc.login || {};
      const passEnc = body.pass ? await encrypt(String(body.pass)) : prev.passEnc;
      if (!passEnc) return sendJSON(res, 400, { error: 'ใส่รหัสผ่าน' });
      acc.login = { user, passEnc, auto: body.auto !== false };
      save();
      break;
    }
    case 'farmreset':
      rtOf(acc).farm = null;
      break;
    case 'rename':
      if (String(body.name || '').trim()) { acc.name = String(body.name).trim(); save(); }
      break;
    case 'delete':
      data.accounts.splice(data.accounts.indexOf(acc), 1);
      pageOf(acc)?.gone();
      runtime.delete(acc.id);
      save();
      break;
    default: return sendJSON(res, 404, { error: 'ไม่รู้จักคำสั่ง' });
  }
  sendJSON(res, 200, state());
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/');
  try {
    if (parts[1] === 'api') return await handleApi(req, res, parts);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(ROOT, 'index.html')));
    }
    res.writeHead(404);
    res.end();
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  logEvent('โปรแกรม', 'เริ่มทำงาน');
  console.log('ตัวจัดการพักจอเกม พร้อมแล้ว: ' + url);
  console.log('ปิดหน้าต่างนี้ = ปิดโปรแกรม (เกมที่เปิดอยู่จะไม่ปิดตาม)');
  if (!process.env.NO_OPEN) {
    // เปิดหน้าควบคุมใน Edge (โปรไฟล์ปกติของผู้ใช้) ถ้าไม่เจอ Edge ค่อยใช้เบราว์เซอร์หลักของเครื่อง
    const edge = findEdge();
    if (edge) spawn(edge, [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
  loop(reconcile, 3000);
  loop(tick, 1000);
  loop(metricsTick, 2000);
  loop(processTick, 3000);
  loop(autoTrimTick, 10000);
  loop(keepAwakeTick, 5000);
  setTimeout(() => loop(gpuTick, 5 * 60000), 10000);
  setTimeout(() => loop(updateTick, 30 * 60000), 5000);
});
