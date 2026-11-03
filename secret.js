// เข้ารหัส/ถอดรหัสรหัสผ่านด้วย Windows DPAPI (ถอดได้เฉพาะ Windows user นี้บนเครื่องนี้)
const { execFile } = require('child_process');

function dpapi(mode, base64In) {
  const op = mode === 'protect' ? 'Protect' : 'Unprotect';
  const ps =
    'Add-Type -AssemblyName System.Security;' +
    '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());' +
    `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${op}($b,$null,'CurrentUser'))`;
  return new Promise((resolve, reject) => {
    const child = execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }, (err, out) => {
      if (err) return reject(new Error('เข้ารหัส/ถอดรหัสไม่สำเร็จ'));
      resolve(out.trim());
    });
    // ส่งผ่าน stdin เป็น base64 => ไม่โผล่ใน command line และภาษาไทยไม่เพี้ยน
    child.stdin.end(base64In);
  });
}

async function encrypt(text) {
  return dpapi('protect', Buffer.from(text, 'utf8').toString('base64'));
}

async function decrypt(enc) {
  return Buffer.from(await dpapi('unprotect', enc), 'base64').toString('utf8');
}

module.exports = { encrypt, decrypt };
