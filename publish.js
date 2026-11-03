// ส่งอัปเดตขึ้น GitHub: สร้าง version.json (เวอร์ชัน + sha256 ของทุกไฟล์) แล้ว commit + push
// เพื่อนที่เปิดโปรแกรมอยู่จะได้อัปเดตเองภายใน 30 นาที หรือทันทีที่เปิด start.bat ครั้งถัดไป
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const REPO = 'https://github.com/nekotenshi11/game-rest-manager.git';
const FILES = ['cdp.js', 'server.js', 'shim.js', 'stats.js', 'autologin.js', 'secret.js', 'updater.js', 'index.html', 'start.bat'];
const EXTRA = ['.gitignore', '.gitattributes', 'publish.js', 'publish.bat', 'version.json'];
const ZIP = path.join(ROOT, '..', 'game-rest-manager-share.zip');

const git = (...args) => execFileSync('git', args, { cwd: ROOT, stdio: 'inherit' });
const gitOut = (...args) => execFileSync('git', args, { cwd: ROOT }).toString().trim();

function main() {
  for (const f of FILES) if (!fs.existsSync(path.join(ROOT, f))) throw new Error('ไม่เจอไฟล์ ' + f);

  // เวอร์ชัน = วันเวลาตอนส่ง เช่น 202611041230
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const version = Number(`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`);
  const files = {};
  for (const f of FILES) files[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
  fs.writeFileSync(path.join(ROOT, 'version.json'), JSON.stringify({ version, files }, null, 2));
  console.log('เวอร์ชันใหม่: ' + version);

  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    git('init', '-b', 'main');
    git('remote', 'add', 'origin', REPO);
    // ใช้อีเมล noreply ของ GitHub ไม่ให้อีเมลจริงโผล่ในประวัติสาธารณะ
    git('config', 'user.name', 'nekotenshi11');
    git('config', 'user.email', 'nekotenshi11@users.noreply.github.com');
  }
  // ห้าม git แปลงบรรทัด ไม่งั้นไฟล์บน GitHub ไม่ตรง sha256 แล้วเครื่องเพื่อนจะไม่ยอมอัปเดต
  git('config', 'core.autocrlf', 'false');
  git('add', '--', ...FILES, ...EXTRA);
  if (!gitOut('status', '--porcelain', '--', ...FILES, ...EXTRA)) {
    console.log('ไม่มีอะไรเปลี่ยน ไม่ต้องส่ง');
    return;
  }
  git('commit', '-m', `อัปเดตเวอร์ชัน ${version}`);
  console.log('กำลังส่งขึ้น GitHub… (ครั้งแรกจะมีหน้าต่างให้ล็อกอิน GitHub)');
  git('push', '-u', 'origin', 'main');

  // ไฟล์ zip สำหรับเพื่อนที่ติดตั้งครั้งแรก
  const list = [...FILES, 'version.json'].map((f) => `'${path.join(ROOT, f)}'`).join(',');
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Force -Path ${list} -DestinationPath '${ZIP}'`], { stdio: 'inherit' });
  console.log('\nส่งอัปเดตเสร็จแล้ว ✓  เพื่อนจะได้เวอร์ชัน ' + version + ' อัตโนมัติ');
  console.log('ไฟล์สำหรับติดตั้งครั้งแรก: ' + ZIP);
}

try {
  main();
} catch (e) {
  console.error('\nส่งอัปเดตไม่สำเร็จ: ' + e.message);
  process.exitCode = 1;
}
