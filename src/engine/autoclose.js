'use strict';

// ============================================================
// ปิดอัตโนมัติเพื่อเซฟกำไร (ตัดสินจากราคาสดทุกทิค ไม่รอรอบวิเคราะห์)
//   1) ปิดรวบ: กำไรลอยตัวรวมทุกไม้ ≥ เป้า (สกุลเงินบัญชี) → ปิดทุกไม้
//   1b) ตัดขาดทุนรวบ: ขาดทุนลอยตัวรวม ≥ เป้า (สกุลเงินบัญชี) → ปิดทุกไม้ (ตรวจก่อนเป้ากำไร)
//   2) ปิดรวบตามเงิน: กำไรลอยตัวรวม ≥ N บาท → ปิดทุกไม้ (พร้อมกันกับเงินเป้าหลัก — สองสวิตช์คู่ขนาน)
//   3) ปิดรายไม้: ไม้ใดกำไรรายไม้ ≥ N บาท (สกุลบัญชีเดียวกัน) → ปิดไม้นั้น
// ฟังก์ชันนี้คำนวณอย่างเดียว ไม่ส่งคำสั่งเอง — main process เป็นคนส่ง
// ============================================================

// กำไรสดของไม้เดียว ณ ราคาปิดปัจจุบัน (ซื้อปิดที่ BID / ขายปิดที่ ASK)
function livePosition(p, bid, ask, spec, digits) {
  const buy = p.type === 'buy';
  const open = Number(p.open);
  const dist = buy ? bid - open : open - ask;
  const point = Math.pow(10, -(Number(digits) || 2));
  const pts = dist / point;
  // สกุลเงินบัญชี: ระยะ ÷ tickSize × tickValue × ล็อต (สเปกจริงจาก EA) — ไม่มีสเปก = ใช้กำไรจาก bridge
  const profit = spec && spec.tickSize > 0 && spec.tickValue > 0
    ? (dist / spec.tickSize) * spec.tickValue * Number(p.volume)
    : Number(p.profit) || 0;
  return { ticket: Number(p.ticket), pts, profit };
}

function plan({ positions = [], bid, ask, spec, digits, settings = {}, skip = new Set() }) {
  const out = { total: 0, totalPts: 0, trigger: null, closeAll: [], singles: [], live: [] };
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || !positions.length) return out;
  out.live = positions
    .filter((p) => Number.isSafeInteger(Number(p.ticket)) && Number(p.ticket) > 0)
    .map((p) => livePosition(p, bid, ask, spec, digits));
  out.total = out.live.reduce((s, x) => s + x.profit, 0);
  out.totalPts = out.live.reduce((s, x) => s + x.pts, 0);
  const target = Number(settings.autoCloseAllProfit);
  const targetPts = Number(settings.autoCloseAllPtsValue);
  const maxLoss = Number(settings.autoCloseLossValue);
  const losingTarget = Number(settings.autoCloseLosingOnlyValue);
  if (settings.autoCloseLoss === true && maxLoss > 0 && out.total <= -maxLoss) out.trigger = 'loss';
  else if (settings.autoCloseLosingOnly === true && losingTarget > 0 && out.total <= -losingTarget) out.trigger = 'lossonly';
  else if (settings.autoCloseAll === true && target > 0 && out.total >= target) out.trigger = 'money';
  else if (settings.autoCloseAllPts === true && targetPts > 0 && out.total >= targetPts) out.trigger = 'points';
  if (out.trigger) {
    // 'lossonly' = ปิดเฉพาะไม้แดง (ติดลบ) เก็บไม้ที่บวกไว้ — ที่เหลือปิดรวบ
    if (out.trigger === 'lossonly') {
      out.singles = out.live.filter((x) => x.profit < 0 && !skip.has(x.ticket));
      return out;
    }
    out.closeAll = out.live.map((x) => x.ticket).filter((t) => !skip.has(t));
    return out; // ปิดรวบครอบทุกไม้แล้ว ไม่ต้องดูรายไม้
  }
  const needMoney = Number(settings.autoClosePointsValue);   // เป้ารายไม้ (บาท)
  if (settings.autoCloseAllPts === true && targetPts > 0 && out.total >= targetPts) out.trigger = 'points';
  if (settings.autoClosePoints === true && needMoney > 0) {
    out.singles = out.live.filter((x) => x.profit >= needMoney && !skip.has(x.ticket));
  }
  return out;
}

module.exports = { plan, livePosition };
