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
    const { council, analysis, price, ind, settings, candles } = ctx;
    if (!council || council.side === 'none' || !price) return null;
    const minConf = settings.councilMin || 75;
    if (council.confidence < minConf) return null;

    const m15 = analysis.tf && analysis.tf.M15;
    const atr = m15 && Number.isFinite(m15.atr) ? m15.atr : price * 0.0008;
    if (atr <= 0) return null;
    const buy = council.side === 'buy';

    // พื้นที่ SL: หลังโครงสร้าง ไม่ต่ำกว่า 0.8×ATR
    let sl;
    if (buy) {
      const sup = analysis.levels.supports[0];
      const byLevel = sup && Math.abs(price - sup) < atr * 1.2 ? sup - atr * 0.35 : null;
      sl = byLevel != null ? Math.min(byLevel, price - atr * 1.1) : price - atr * 1.8;
    } else {
      const res = analysis.levels.resistances[0];
      const byLevel = res && Math.abs(res - price) < atr * 1.2 ? res + atr * 0.35 : null;
      sl = byLevel != null ? Math.max(byLevel, price + atr * 1.1) : price + atr * 1.8;
    }
    if (Math.abs(price - sl) < atr * 0.8) return null; // SL แคบเว่อร์ — ไม่เข้า

    const rr = 2.2; // ทีมมั่นใจแน่นจึงเฟอร์เรียวขึ้น
    const tp = buy ? price + rr * (price - sl) : price - rr * (sl - price);

    // สรุปเหตุผลจากเอเจนต์ที่โหวตด้วย (เรียกเฉพาะฝั่งมติ)
    const voters = (council.votes || []).filter((v) => v.side === council.side);
    const top = voters.sort((a, b) => b.conf - a.conf).slice(0, 3);
    const why = top.map((v) => `${v.name}: ${v.reason}`).join(' • ');
    const reason = `ทีมเอเจนต์ ${voters.length}/${(council.votes || []).length} โหวต${buy ? 'ซื้อ' : 'ขาย'} รวมมั่นใจ ${council.confidence}%${council.caps && council.caps.length ? ' (มีหมายเหตุยับ: ' + council.caps[0] + ')' : ''} — ${why}`;

    if (!candles.M5 || candles.M5.length < 70) return null;
    return {
      side: council.side,
      entry: price,
      sl,
      tp,
      confidence: council.confidence,
      reason,
    };
  },
};