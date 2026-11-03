// อัปเดตอัตโนมัติจาก GitHub: เช็ก version.json แล้วโหลดเฉพาะไฟล์ที่เปลี่ยน ตรวจ sha256 ก่อนเขียนทับ
// ข้อมูลของผู้ใช้ (data.json, profiles, events.log) ไม่อยู่ในรายการไฟล์ จึงไม่ถูกแตะ
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const UPDATE_BASE = process.env.UPDATE_BASE || 'https://raw.githubusercontent.com/nekotenshi11/game-rest-manager/main/';
const VERSION_FILE = path.join(ROOT, 'version.json');
// อนุญาตเฉพาะชื่อไฟล์ธรรมดาในโฟลเดอร์โปรแกรม (กันเขียนไฟล์ออกนอกโฟลเดอร์)
const SAFE_NAME = /^[a-z0-9][a-z0-9_-]*\.(js|html|json)$/i;
// start.bat กำลังรันอยู่ระหว่างอัปเดต แก้ทับไม่ได้ / data.json คือข้อมูลผู้ใช้
const NEVER_UPDATE = new Set(['start.bat', 'data.json', 'version.json']);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function localVersion() {
  try { return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')); } catch { return { version: 0, files: {} }; }
}

async function fetchBuf(name) {
  const r = await fetch(UPDATE_BASE + name + '?t=' + Date.now(), { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`โหลด ${name} ไม่ได้ (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

// คืนค่า: null = ไม่มีอัปเดต / { version, changed } = อัปเดตเสร็จ ต้องรีสตาร์ต
async function checkAndApply(log) {
  // โฟลเดอร์ที่มี .git = เครื่องเจ้าของ (ที่แก้โค้ด) ไม่อัปเดตทับ
  if (fs.existsSync(path.join(ROOT, '.git'))) return null;
  const local = localVersion();
  const remote = JSON.parse((await fetchBuf('version.json')).toString('utf8'));
  if (!(Number(remote.version) > Number(local.version))) return null;

  const changed = Object.entries(remote.files || {}).filter(([name, hash]) =>
    SAFE_NAME.test(name) && !NEVER_UPDATE.has(name) && local.files?.[name] !== hash);

  // โหลดทุกไฟล์มาตรวจก่อน ถ้าไฟล์ไหนไม่ตรง sha256 (เช่น GitHub ยังแคชของเก่า) ยกเลิกทั้งหมด รอบหน้าค่อยลองใหม่
  const staged = [];
  for (const [name, hash] of changed) {
    const buf = await fetchBuf(name);
    if (sha256(buf) !== hash) throw new Error(`ไฟล์ ${name} ไม่ตรงกับที่ประกาศไว้ — ยกเลิกอัปเดตรอบนี้`);
    staged.push([name, buf]);
  }
  for (const [name, buf] of staged) {
    const target = path.join(ROOT, name);
    fs.writeFileSync(target + '.new', buf);
    fs.renameSync(target + '.new', target);
  }
  fs.writeFileSync(VERSION_FILE, JSON.stringify(remote, null, 2));
  log?.(`อัปเดตเป็นเวอร์ชัน ${remote.version} (${staged.length} ไฟล์: ${staged.map((s) => s[0]).join(', ') || '-'})`);
  return { version: remote.version, changed: staged.map((s) => s[0]) };
}

module.exports = { checkAndApply, localVersion };
