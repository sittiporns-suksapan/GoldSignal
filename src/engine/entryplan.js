'use strict';

// ============================================================
// Entry Plan — จุดรอเข้าซื้อ/เข้าขาย แบบ "รอถึงจุดค่อยเข้า"
// โซน = แนวรับ/ต้านใกล้ตัว + ความกว้างตามแท้า ATR (จองพื้นที่สวิง)
// กติกา: 
//   - ซื้อ = รอราคา "ดีดลงเข้าโซน" ของแนวรับ (ไม่จับมีดตกใต้แนวรับ)
//   - ขาย = รอราคา "พุ่งเข้าโซน" ของแนวต้าน
//   - โซนถูกยกเลิก (blocked) ถ้าเทรนด์สวนทิศ หรือสภาพตลาดไม่แนะนำ
//   - state: waiting (ไกล) → armed (ราคาเข้าโซนแล้ว=พร้อม) 
// ============================================================

const ind = require('./indicators');

function buildEntryPlan({ analysis, price, sessionQuality }) {
  const plan = { buy: null, sell: null, note: null };
  if (!analysis || !Number.isFinite(price)) return plan;
  const tf15 = analysis.tf && analysis.tf.M15;
  const atr = tf15 && Number.isFinite(tf15.atr) ? tf15.atr : price * 0.0008;
  const half = atr * 0.4;
  const bias = analysis.bias;
  const bb = tf15 && tf15.bb;

  // ---- โซนซื้อ: แนวรับใกล้สุดใต้ราคา (ถ้าไม่มี → Bollinger ล่าง) ----
  const sup = (analysis.levels && analysis.levels.supports[0]) || (bb && Number.isFinite(bb.lower) ? bb.lower : null);
  if (sup && Number.isFinite(sup)) {
    const z = { center: ind.round(sup, 2), bottom: ind.round(sup - half, 2), top: ind.round(sup + half, 2) };
    z.levelType = (analysis.levels && analysis.levels.supports[0]) ? 'แนวรับ' : 'ขอบ Bollinger ล่าง';
    z.distance = price - z.top;          // >0 = ราคาอยู่เหนือโซน (กำลังตั้งรอ)
    z.inZone = price <= z.top && price >= z.bottom;
    z.knife = price < z.bottom;          // ราคาหลุดใต้โซน = จุดยืนอ่อน (ห้ามจับมีดตก)
    z.valid = bias !== 'bear';
    z.blocked = bias === 'bear' ? 'เทรนด์ขาลง (H1+M15) — ยกเลิกการซื้อตามโซน' : (sessionQuality === 'avoid' || sessionQuality === 'closed' ? `ช่วงเวลาไม่แนะนำ — รอช่วงดี` : null);
    if (z.knife) { z.status = 'danger'; z.statusTxt = 'ราคาหลุดใต้โซน — ห้ามจับมีดตก'; }
    else if (z.blocked) { z.status = 'blocked'; z.statusTxt = z.blocked; }
    else if (z.inZone) { z.status = 'armed'; z.statusTxt = '🎯 ราคาอยู่ในโซนซื้อแล้ว! ยืนยันเงื่อนไขจากสภาก่อนกด'; }
    else { z.status = 'waiting'; z.statusTxt = `รอราคาดีดลงเข้าโซน — อีก $${ind.round(z.distance, 2)}`; }
    plan.buy = z;
  }

  // ---- โซนขาย: แนวต้านใกล้สุดเหนือราคา (ถ้าไม่มี → Bollinger บน) ----
  const res = (analysis.levels && analysis.levels.resistances[0]) || (bb && Number.isFinite(bb.upper) ? bb.upper : null);
  if (res && Number.isFinite(res)) {
    const z = { center: ind.round(res, 2), bottom: ind.round(res - half, 2), top: ind.round(res + half, 2) };
    z.levelType = (analysis.levels && analysis.levels.resistances[0]) ? 'แนวต้าน' : 'ขอบ Bollinger บน';
    z.distance = z.bottom - price;       // >0 = ราคายังต่ำกว่าโซน (ตั้งรอ)
    z.inZone = price >= z.bottom && price <= z.top;
    z.knife = price > z.top;             // ทะลุหัวโซน = แรงซื้อแรงเกิน (ห้ามไล่ขาย)
    z.valid = bias !== 'bull';
    z.blocked = bias === 'bull' ? 'เทรนด์ขาขึ้น — ยกเลิกการขายตามโซน' : (sessionQuality === 'avoid' || sessionQuality === 'closed' ? 'ช่วงเวลาไม่แนะนำ — รอช่วงดี' : null);
    if (z.knife) { z.status = 'danger'; z.statusTxt = 'ราคาทะลุเหนือโซน — ห้ามไล่ขาย'; }
    else if (z.blocked) { z.status = 'blocked'; z.statusTxt = z.blocked; }
    else if (z.inZone) { z.status = 'armed'; z.statusTxt = '🎯 ราคาอยู่ในโซนขายแล้ว! ยืนยันเงื่อนไขจากสภาก่อนกด'; }
    else { z.status = 'waiting'; z.statusTxt = `รอราคาพุ่งเข้าโซน — อีก $${ind.round(z.distance, 2)}`; }
    plan.sell = z;
  }

  plan.atr = ind.round(atr, 2);
  return plan;
}

module.exports = { buildEntryPlan };