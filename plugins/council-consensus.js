'use strict';

// กลยุทธ์ 4: มติทีมเอเจนต์ (Council Consensus)
// ไม่ใช่ตัวชี้วัดเดี่ยว — ใช้มติรวมของสภาเอเจนต์ 7 คนที่ engine ประมวลให้พร้อม
// ยิงเฉพาะเมื่อสภามีมติทิศชัด + ความมั่นใจรวมเกินเกณฑ์ (ค่าตั้งต้น 75%)
// SL ยึดโครงสร้าง: ห่าง ATR(M15)×1.8 และถ้าแนวรับ/ต้านอยู่ใกล้กว่า ให้ยึดหลังระดับนั้น

module.exports = {
  id: 'council-consensus',
  name: 'มติทีมเอเจนต์ (Council Consensus)',
  description: 'รวมคะแนนโหวตของเอเจนต์ 7 ฝ่าย เข้าไม้เฉพาะเมื่อทีมเห็นพ้องชัดเจนเกินเกณฑ์ที่ตั้งไว้',

  strategy(ctx) {
    const { council, analysis, price, ind, settings, candles, digits } = ctx;
    if (!council || council.side === 'none' || !price) return null;
    const minConf = settings.councilMin || 75;
    if (council.confidence < minConf) return null;

    const m15 = analysis.tf && analysis.tf.M15;
    const atr = m15 && Number.isFinite(m15.atr) ? m15.atr : price * 0.0008;
    if (atr <= 0) return null;
    const buy = council.side === 'buy';
    const pt = Math.pow(10, -(Number(digits ?? (settings && settings.digits)) || 2));
    // ระยะที่ผู้ใช้ตั้งถาวร (จุด) = ชนะ ATR อัตโนมัติเสมอ (เจ้าของระบบเลือกเอง — กดยืนยันทุกไม้ตามเกตเดิม)
    const userSl = Number(settings && settings.slDistPts) > 0 ? Number(settings.slDistPts) * pt : null;
    const userTp = Number(settings && settings.tpDistPts) > 0 ? Number(settings.tpDistPts) * pt : null;

    // พื้นที่ SL: หลังโครงสร้าง ไม่ต่ำกว่า 0.8×ATR (ยกเว้นผู้ใช้ตั้งระยะเอง)
    let sl;
    if (userSl != null) {
      sl = buy ? price - userSl : price + userSl;
    } else if (buy) {
      const sup = analysis.levels.supports[0];
      const byLevel = sup && Math.abs(price - sup) < atr * 1.2 ? sup - atr * 0.35 : null;
      sl = byLevel != null ? Math.min(byLevel, price - atr * 1.1) : price - atr * 1.8;
    } else {
      const res = analysis.levels.resistances[0];
      const byLevel = res && Math.abs(res - price) < atr * 1.2 ? res + atr * 0.35 : null;
      sl = byLevel != null ? Math.max(byLevel, price + atr * 1.1) : price + atr * 1.8;
    }
    if (userSl == null && Math.abs(price - sl) < atr * 0.8) return null; // SL แคบเว่อร์ — ไม่เข้า (เมื่อไม่ได้ตั้งระยะเอง)

    // TP: ระยะที่ผู้ใช้ตั้งก่อน — ไม่มี = คิดจาก RR 2.2 ของระยะ SL จริง
    const tp = userTp != null
      ? (buy ? price + userTp : price - userTp)
      : (buy ? price + 2.2 * (price - sl) : price - 2.2 * (sl - price));

    // สรุปเหตุผลจากเอเจนต์ที่โหวตด้วย (เรียกเฉพาะฝั่งมติ)
    const voters = (council.votes || []).filter((v) => v.side === council.side);
    const top = voters.sort((a, b) => b.conf - a.conf).slice(0, 3);
    const why = top.map((v) => `${v.name}: ${v.reason}`).join(' • ');
    const reason = `ทีมเอเจนต์ ${voters.length}/${(council.votes || []).length} โหวต${buy ? 'ซื้อ' : 'ขาย'} รวมมั่นใจ ${council.confidence}%${council.caps && council.caps.length ? ' (มีหมายเหตุยับ: ' + council.caps[0] + ')' : ''} — ${why}`;

    if (!candles.M5 || candles.M5.length < 70) return null;
    return {
      side: council.side, distUser: userSl != null,
      entry: price,
      sl,
      tp,
      confidence: council.confidence,
      reason,
    };
  },
};