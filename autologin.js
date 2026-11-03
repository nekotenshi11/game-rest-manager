// ล็อกอิน Aetheria Online ทีละขั้น (ถึงหน้าเลือกตัวละครแล้วหยุด): ตัวจัดการเรียกทุก 1 วิ แต่ละครั้งทำแค่ 1 ขั้นแล้วบอกสถานะกลับ
// ใส่ใหม่ทุกครั้งที่ตัวจัดการเชื่อมต่อ (เหมือน stats.js)
window.__gameRestLogin = (() => {
  const setValue = (input, value) => {
    // React ฟังค่าผ่าน setter ของ prototype + event input
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const text = (el) => el?.textContent.trim() || '';

  return function step(cfg) {
    if (document.querySelector('.hud-status')) return { state: 'ingame' };
    if (document.querySelector('.reconnecting')) return { state: 'reconnecting' };
    if (document.querySelector('.two-step')) return { state: 'twostep' };

    // ถึงหน้าเลือกตัวละครแล้ว = ล็อกอินสำเร็จ ให้ผู้ใช้เลือกตัวละครเอง
    if (document.querySelector('.char-select')) return { state: 'char-select' };

    const form = document.querySelector('form.login-card');
    if (form) {
      const user = form.querySelector('input[autocomplete="username"]');
      const pass = form.querySelector('input[autocomplete="current-password"]');
      const go = form.querySelector('.login-go');
      // ไม่มีช่อง current-password = อยู่หน้าสมัครบัญชี ไม่ทำอะไร
      if (!user || !pass || !go) return { state: 'register-mode' };
      if (go.disabled) return { state: 'logging-in' };
      const err = text(form.querySelector('.error'));
      if (cfg.submitted && err) return { state: 'login-error', msg: err };
      if (user.value !== cfg.user || pass.value !== cfg.pass) {
        setValue(user, cfg.user);
        setValue(pass, cfg.pass);
        return { state: 'filled' };
      }
      // เพิ่งกดไป รอผลก่อน ไม่กดซ้ำรัวๆ
      if (cfg.holdLogin) return { state: 'logging-in' };
      go.click();
      return { state: 'submitted' };
    }

    return { state: 'other' };
  };
})();
