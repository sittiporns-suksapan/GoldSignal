'use strict';

// ============================================================
// ระบบ Plugin — กลยุทธ์แต่ละตัวเป็นไฟล์ .js ที่ export:
//   module.exports = {
//     id, name, description,
//     strategy({ analysis, candles, price, ind, settings, log }) → signal|null
//   }
// signal: { side:'buy'|'sell', entry?, sl (บังคับ), tp?, confidence, reason }
// ทุก plugin ถูกเรียกใน try/catch — ถ้าพัง จะไม่กระทบกับตัวอื่น
// โฟลเดอร์ผู้ใช้: ~/Library/Application Support/GoldSignal/plugins/
// ============================================================

const fs = require('fs');
const path = require('path');

const PLUGIN_TIMEOUT_MS = 5000;

function loadFromDir(dir, sourceLabel, logger) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.js') || e.name.startsWith('_')) continue;
    const full = path.join(dir, e.name);
    try {
      delete require.cache[full];
      const mod = require(full);
      if (!mod || typeof mod.strategy !== 'function') throw new Error('missing strategy()');
      if (!mod.id || !mod.name) throw new Error('missing id/name');
      const fn = mod.strategy;
      // เปิดหุ้มป้องกัน: sync หรือ async ก็ได้ — พังไม่ล้ม, ไม่โยนความผิดพลาดออกนอก
      mod.strategy = (ctx) => {
        let r;
        try { r = fn(ctx); } catch (err) {
          ctx.log(`plugin "${mod.id}" เกิดข้อผิดพลาด: ${err.message}`, 'warn');
          return Promise.resolve(null);
        }
        // รอผล async ได้ไม่เกิน 5 วิ แล้วค่อยแปลงเป็นรายการ (เดิม Promise ถูกห่อเป็น [Promise] → สัญญาณ async ถูกทิ้งทุกครั้ง)
        let timer;
        const timeout = new Promise((resolve) => { timer = setTimeout(() => { ctx.log(`plugin "${mod.id}" ช้าเกิน 5 วิ — ข้ามรอบนี้`, 'warn'); resolve(null); }, PLUGIN_TIMEOUT_MS); });
        return Promise.race([Promise.resolve(r), timeout])
          .then((v) => (v == null ? null : Array.isArray(v) ? v : [v]))
          .finally(() => clearTimeout(timer));
      };
      out.push({ id: mod.id, name: mod.name, description: String(mod.description || ''), source: sourceLabel, file: full, strategy: mod.strategy, enabled: true });
      logger('plugins', `โหลด plugin: ${mod.name} (${sourceLabel})`);
    } catch (err) {
      logger('plugins', `โหลดล้มเหลว: ${e.name} — ${err.message}`, 'warn');
    }
  }
  return out;
}

class PluginLoader {
  constructor({ builtInDir, userDir, logger = () => {}, defaultOff = [] } = {}) {
    this.builtInDir = builtInDir;
    this.userDir = userDir;
    this.logger = logger;
    this.plugins = [];
    this.enabled = {};      // id → bool (undefined = ยังไม่เคยตั้ง ใช้ค่าปริยายจาก defaultOff)
    this.defaultOff = defaultOff;
  }

  reload() {
    this.plugins = loadFromDir(this.builtInDir, 'ในตัว', this.logger);
    this.plugins.push(...loadFromDir(this.userDir, 'ผู้ใช้', this.logger));
    for (const p of this.plugins) {
      if (this.enabled[p.id] === undefined) this.enabled[p.id] = !this.defaultOff.includes(p.id);
    }
    const ids = this.plugins.map((p) => p.id);
    for (const id of Object.keys(this.enabled)) if (!ids.includes(id)) delete this.enabled[id];
    return this.plugins.length;
  }

  list() { return this.plugins.map(({ strategy, ...info }) => ({ ...info, enabledByDefault: this.enabled[info.id] !== false })); }
  setEnabled(id, on) { this.enabled[id] = !!on; }

  async runStrategies(ctx) {
    const enabled = this.plugins.filter((p) => this.enabled[p.id] !== false);
    const results = await Promise.allSettled(
      enabled.map((p) => p.strategy(ctx).catch((err) => {
        ctx.log(`plugin "${p.id}" ทำงานไม่สำเร็จ: ${err.message}`, 'warn');
        return null;
      }))
    );
    const signals = [];
    results.forEach((res, i) => {
      const p = enabled[i];
      const list = res.status === 'fulfilled' ? (res.value || []) : [];
      // ไม่แก้วัตถุของ plugin (อาจ frozen/เป็นค่าดิบ → strict mode โยน error ทำรอบวิเคราะห์ล้มทั้งรอบ)
      for (const s of list) if (s && typeof s === 'object') signals.push({ ...s, plugin: p.id, pluginName: p.name });
    });
    return signals;
  }
}

module.exports = { PluginLoader };