'use strict';

// หน้าต่างประวัติรอบทั้งหมด: อ่านไฟล์ round-history.jsonl ผ่าน main • กรอง/ค้นหา • รีเฟรชเองทุก 15 วิ
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const hm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const TH_DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

function kindOf(a) {
  if (a.startsWith('ปิดไม้เสมือน')) return 'close';
  if (a.startsWith('ลงไม้เสมือน')) return 'open';
  if (a.startsWith('สัญญาณ')) return 'signal';
  return 'wait';
}

let rows = [];
function render() {
  const q = $('h-q').value.trim().toLowerCase();
  const kind = $('h-kind').value;
  const list = rows.filter((r) => {
    const k = kindOf(r.action);
    if (kind === 'trade' && k === 'wait') return false;
    if (kind === 'wait' && k !== 'wait') return false;
    return !q || (r.action + ' ' + r.detail).toLowerCase().includes(q);
  });
  $('h-count').textContent = `แสดง ${list.length.toLocaleString()} จาก ${rows.length.toLocaleString()} รายการ (ใหม่สุดอยู่บน)`;
  if (!list.length) { $('h-list').innerHTML = '<div class="empty">ยังไม่มีประวัติ — ระบบจดทุกครั้งที่สถานะรอบเปลี่ยน</div>'; return; }
  const today = dayKey(Date.now());
  let lastDay = null;
  const html = [];
  for (const r of list.slice(0, 5000)) {
    const dk = dayKey(r.ts);
    if (dk !== lastDay) {
      const d = new Date(r.ts);
      html.push(`<div class="hday">${dk === today ? 'วันนี้ • ' : ''}วัน${TH_DAYS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}</div>`);
      lastDay = dk;
    }
    const k = kindOf(r.action);
    const res = k === 'close' ? (/\+\$/.test(r.action) ? ' win' : ' loss') : '';
    html.push(`<div class="hrow k-${k}${res}"><span class="t">${hm(r.ts)}</span><span class="a">${esc(r.action)}</span><span class="d">${esc(r.detail)}</span></div>`);
  }
  if (list.length > 5000) html.push('<div class="empty">แสดง 5,000 รายการแรก — ใช้ช่องค้นหาเพื่อหาเก่ากว่านี้</div>');
  $('h-list').innerHTML = html.join('');
}

async function load() {
  try { rows = await window.api.getRoundHistory(); } catch (e) { $('h-count').textContent = 'โหลดไม่สำเร็จ: ' + e.message; return; }
  render();
}

$('h-q').addEventListener('input', render);
$('h-kind').addEventListener('change', render);
$('h-refresh').addEventListener('click', load);
setInterval(load, 15_000);
load();
