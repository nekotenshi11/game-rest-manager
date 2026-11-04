// ใส่ชื่อผู้ใช้/รหัสผ่านในหน้าล็อกอินของ Aetheria Online ให้เท่านั้น ไม่กดปุ่มใดๆ: ผู้เล่นกดเข้าเกมเอง
// ตัวจัดการเรียกทุก 1 วิ / ใส่ใหม่ทุกครั้งที่ตัวจัดการเชื่อมต่อ (เหมือน stats.js)
window.__gameRestLogin = (() => {
  const setValue = (input, value) => {
    // React ฟังค่าผ่าน setter ของ prototype + event input
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  return function step(cfg) {
    if (document.querySelector('.hud-status')) return { state: 'ingame' };
    if (document.querySelector('.reconnecting')) return { state: 'reconnecting' };
    if (document.querySelector('.two-step')) return { state: 'twostep' };
    if (document.querySelector('.char-select')) return { state: 'char-select' };

    const form = document.querySelector('form.login-card');
    if (!form) return { state: 'other' };
    const user = form.querySelector('input[autocomplete="username"]');
    const pass = form.querySelector('input[autocomplete="current-password"]');
    // ไม่มีช่อง current-password = อยู่หน้าสมัครบัญชี ไม่ทำอะไร
    if (!user || !pass) return { state: 'register-mode' };
    // ใส่ครั้งเดียวต่อฟอร์ม ถ้าผู้เล่นแก้เองจะไม่เขียนทับ
    if (!form.dataset.grFilled) {
      form.dataset.grFilled = '1';
      setValue(user, cfg.user);
      setValue(pass, cfg.pass);
    }
    return { state: 'filled' };
  };
})();
