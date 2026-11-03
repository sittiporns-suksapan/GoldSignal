'use strict';

// วาดไอคอนแอป 1024×1024 เป็น PNG ล้วน ๆ ด้วย Node (ไม่มี dependency)
// ธีม: พื้นกรุงเทาน้ำเงินมุมมน + แท่งทองคำ + เส้นกราฟพาดขึ้น
// ใช้: node scripts/make-icon.js  →  build/icon.png

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 2048;            // วาดใหญ่ 2 เท่าแล้วย่อลง 1024 เพื่อ anti-alias
const OUT = path.join(__dirname, '..', 'build', 'icon.png');

// ---------- วาดลง buffer RGBA ----------
const W = SIZE, H = SIZE;
const px = new Uint8Array(W * H * 4);
const setPx = (x, y, [r, g, b, a]) => {
  const i = (y * W + x) * 4;
  const na = a / 255;
  const oa = px[i + 3] / 255;
  const outA = na + oa * (1 - na);
  if (outA <= 0) return;
  px[i] = Math.round((r * na + px[i] * oa * (1 - na)) / outA);
  px[i + 1] = Math.round((g * na + px[i + 1] * oa * (1 - na)) / outA);
  px[i + 2] = Math.round((b * na + px[i + 2] * oa * (1 - na)) / outA);
  px[i + 3] = Math.round(outA * 255);
};

// ผสมสีเชิงเส้น t: 0..1
const mix = (c1, c2, t) => c1.map((v, i) => Math.round(v + (c2[i] - v) * t));

// 1) พื้น rounded square มีเงาไล่จากบน
{
  const R = 460, pad = 120;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cx = Math.max(pad + R, Math.min(x, W - pad - R));
      const cy = Math.max(pad + R, Math.min(y, H - pad - R));
      const d = Math.hypot(x - cx, y - cy);
      if (d <= R) {
        const t = (y - pad) / H;
        setPx(x, y, mix([26, 34, 58], [13, 18, 32], t).concat([255]));
      }
    }
  }
}

// วงกลมเงาน้ำเงินอ่อนหลังกราฟ (บรรยากาศ)
{
  const cx = 1024, cy = 900, r = 620;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (d < r) setPx(x, y, [40, 54, 90, Math.round(70 * (1 - d / r))]);
  }
}

// 2) เส้นกราฟพาดขึ้น (เส้นหนาทอง) + หัวลูกศร
{
  const pts = [[300, 1350], [620, 1080], [900, 1230], [1240, 900], [1560, 1020], [1740, 560]];
  const lw = 56;
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) segs.push([pts[i], pts[i + 1]]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    for (const [[ax, ay], [bx, by]] of segs) {
      const vx = bx - ax, vy = by - ay;
      const len2 = vx * vx + vy * vy;
      let t = ((x - ax) * vx + (y - ay) * vy) / len2;
      if (t < 0 || t > 1) continue;
      const dx = x - (ax + vx * t), dy = y - (ay + vy * t);
      const d = Math.hypot(dx, dy);
      if (d <= lw / 2) {
        const shade = 1 - Math.min(1, d / (lw / 2)) * 0.15;
        setPx(x, y, [Math.round(240 * shade), Math.round(180 * shade), Math.round(41 * shade), 255]);
      }
    }
  }
  // หัวลูกศรที่ปลาย
  const [hx, hy] = pts[pts.length - 1], [pxs, pys] = pts[pts.length - 2];
  const ang = Math.atan2(hy - pys, hx - pxs);
  const tri = [[hx + 90, hy], [hx - 20 + 70 * Math.cos(ang - 2.4), hy + 70 * Math.sin(ang - 2.4)], [hx - 20 + 70 * Math.cos(ang + 2.4), hy + 70 * Math.sin(ang + 2.4)]];
  const inTri = (p, a, b, c) => {
    const s = (p2, a2, b2) => (p2[0] - b2[0]) * (a2[1] - b2[1]) - (a2[0] - b2[0]) * (p2[1] - b2[1]);
    const d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a);
    const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };
  for (let y = Math.max(0, hy - 150); y < Math.min(H, hy + 150); y++)
    for (let x = Math.max(0, hx - 150); x < Math.min(W, hx + 150); x++)
      if (inTri([x, y], tri[0], tri[1], tri[2])) setPx(x, y, [240, 180, 41, 255]);
}

// 3) แท่งทองคำ (มุมมองไอโซเมตริก 2 แท่ง)
function goldBar(cx, cy, w) {
  const hFront = w * 0.34, skew = w * 0.16, hTop = w * 0.30;
  // top face (parallelogram) — สว่างกว่า
  for (let y = cy - hTop - hFront; y < cy - hFront; y++)
    for (let x = cx - w / 2 - skew / 2 + (y - (cy - hTop - hFront)) / hTop * skew / 2 * 0 ; x < cx + w / 2 + skew / 2 - 0; x++) {
      // คำนวณขอบเฉียงจริง: ซ้ายบนไล่ไปขวา
      const tTop = (y - (cy - hTop - hFront)) / hTop;
      const xa = cx - w / 2 + skew * tTop;
      const xb = cx + w / 2 + skew * tTop;
      if (x >= xa && x < xb) {
        const t = (x - xa) / (xb - xa);
        setPx(x, y, mix([255, 214, 92], [233, 172, 44], t).concat([255]));
      }
    }
  // front face — เข้มกว่า มีร่อง
  for (let y = cy - hFront; y < cy; y++)
    for (let x = cx - w / 2; x < cx + w / 2; x++) {
      const t = (x - cx + w / 2) / w;
      const groove = (y > cy - hFront + 10 && y < cy - hFront + 22 && Math.abs(t - 0.5) < 0.06) ? 0.78 : 1;
      setPx(x, y, mix([214, 155, 33], [166, 112, 18], Math.abs(t - 0.5) * 2).map((v) => Math.round(v * groove)).concat([255]));
    }
}
goldBar(660, 1520, 420);
goldBar(1140, 1650, 520);

// 4) ย่อ 2048 → 1024 (เฉลี่ย 2×2)
{
  const S2 = SIZE / 2;
  const out = Buffer.alloc(S2 * S2 * 4);
  for (let y = 0; y < S2; y++) for (let x = 0; x < S2; x++) {
    for (let c = 0; c < 4; c++) {
      const i00 = ((y * 2) * W + x * 2) * 4 + c, i10 = ((y * 2) * W + x * 2 + 1) * 4 + c;
      const i01 = ((y * 2 + 1) * W + x * 2) * 4 + c, i11 = ((y * 2 + 1) * W + x * 2 + 1) * 4 + c;
      out[(y * S2 + x) * 4 + c] = Math.round((px[i00] + px[i10] + px[i01] + px[i11]) / 4);
    }
  }
  // 5) เขียนไฟล์ PNG (filter 0, สี RGBA 8-bit)
  const crcTable = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S2, 0); ihdr.writeUInt32BE(S2, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((S2 * 4 + 1) * S2);
  for (let y = 0; y < S2; y++) {
    raw[y * (S2 * 4 + 1)] = 0;
    out.copy(raw, y * (S2 * 4 + 1) + 1, y * S2 * 4, (y + 1) * S2 * 4);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, png);
  console.log(`เขียน ${OUT} (${(png.length / 1024).toFixed(0)} KB, ${S2}×${S2})`);
}