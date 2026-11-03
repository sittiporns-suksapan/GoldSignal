'use strict';

// ============================================================
// Session Advisor — แนะนำช่วงเวลาเทรดทอง (แสดงเป็นเวลาไทย UTC+7)
// หลักการเชิงโครงสร้าง: สภาพคล่องทองอยู่ที่ลอนดอน/นิวยอร์ก
// best  = ลอนดอน+นิวยอร์กทับกัน (วิ่งแรงสุด, สเปรดแคบสุด)
// good  = ลอนดอน
// ok    = นิวยอร์กบ่าย
// avoid = เอเชียกลาง / ท้ายศุกร์ (gap เสาร์อาทิตย์) / ตลาดปิด
// ============================================================

const TH_OFFSET_HOURS = 7;

// ช่วงเวลา (ระบุด้วยชั่วโมง UTC เริ่ม-สิ้น; ช่วงที่คร่อมเที่ยงคืนใช้ start>end)
const WINDOWS = [
  { id: 'asia', th: 'เอเชีย', quality: 'avoid', utcStart: 23, utcEnd: 7, thStart: 6, thEnd: 14, advice: 'ตลาดนิ่ง สเปรดกว้าง — เลี่ยง หรือเล่นกรอบเบา ๆ', riskNote: 'ราคาขยับเอาแพร่ เจอสวิงหลอนง่าย' },
  { id: 'asia-evening', th: 'เอเชียกลางคืน', quality: 'avoid', utcStart: 21, utcEnd: 23, thStart: 4, thEnd: 6, advice: 'ช่วงเวลาตาย — รอลอนดอนเปิด', riskNote: 'เกือบไม่มี volume' },
  { id: 'london', th: 'ลอนดอน', quality: 'good', utcStart: 7, utcEnd: 12, thStart: 14, thEnd: 19, advice: 'ดี — เทรนด์ช่วงเช้าลอนดอนแรงชัด ใช้ตามระบบได้', riskNote: 'แรงพอควร อย่าไล่แท่งแรกหลังเปิด' },
  { id: 'overlap', th: 'ลอนดอน+นิวยอร์ก', quality: 'best', utcStart: 12, utcEnd: 17, thStart: 19, thEnd: 24, advice: 'ดีที่สุดของวัน — วิ่งแรงสุด สเปรดแคบสุด ใช้สัญญาณระบบเต็มสูตร', riskNote: 'แรงสุด → ล็อตยึดเพดานเข้มงวด อย่าเพิ่มเอง' },
  { id: 'ny-afternoon', th: 'นิวยอร์กบ่าย', quality: 'ok', utcStart: 17, utcEnd: 21, thStart: 0, thEnd: 4, advice: 'พอใช้ — แรงลดลงหลังถอนตัวลอนดอน จังหวะดี ๆ แบบทันควัน', riskNote: 'กลางเปลี่ยนอารมณ์ตลาด ตามข่าวตอนบ่าย NY' },
];

function windowFor(h /* ชั่วโมง UTC 0-23 */) {
  for (const w of WINDOWS) {
    if (w.utcStart > w.utcEnd) { if (h >= w.utcStart || h < w.utcEnd) return w; }
    else if (h >= w.utcStart && h < w.utcEnd) return w;
  }
  return null;
}

// ประเมินสถานะช่วงเวลา ณ เวลานี้ (ms epoch)
function evaluate(nowMs) {
  const d = new Date(nowMs);
  const h = d.getUTCHours(), day = d.getUTCDay(), mins = d.getUTCMinutes();
  let w = windowFor(h);
  let quality = w ? w.quality : 'ok';
  let riskNote = w ? w.riskNote : '';
  // เสาร์ / อาทิตย์ก่อนราคาเปิด (~21:00 UTC) = ตลาดปิด
  let closed = false;
  if (day === 6 || (day === 0 && h < 21)) { closed = true; quality = 'closed'; riskNote = 'ตลาดปิดสุดสัปดาห์'; w = null; }
  // ศุกร์หลัง 20:00 UTC (03:00 ไทย เสาร์) = ใกล้ปิด — gap เสี่ยง
  if (day === 5 && h >= 20) { quality = 'avoid'; riskNote = 'ใกล้ปิดตลาดอาทิตย์ — ระวัง gap สุดสัปดาห์'; }
  return {
    id: closed ? 'closed' : (w ? w.id : 'unknown'),
    label: closed ? 'ตลาดปิด (เสาร์-อาทิตย์)' : (w ? w.th : 'ผิดปกติ'),
    quality,
    advice: closed ? 'รอราคาเปิดจันทร์ สเปรดตอนแรกเปิดกว้าง ให้พ้น 30-60 นาทีแรก' : (w ? w.advice : ''),
    riskNote,
    thaiTime: { h: (h + TH_OFFSET_HOURS) % 24, m: mins },
    closed,
  };
}

// นาทีถอยหลังถึงช่วง best (เริ่ม 12:00 UTC = 19:00 ไทย)
function minutesToNextBest(nowMs) {
  const d = new Date(nowMs);
  const nowTotal = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const TARGET = 12 * 60; // 12:00 UTC
  let diff = TARGET - nowTotal;
  if (diff < 0) diff += 24 * 60;
  return Math.round(diff);
}

module.exports = { evaluate, minutesToNextBest, WINDOWS, TH_OFFSET_HOURS };