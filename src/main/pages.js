'use strict';

// ============================================================
// ลิงก์ถาวรผ่าน GitHub Pages (https://<owner>.github.io/<repo>/)
//   - หน้า index.html (ธีมเดียวกับแผง) อ่าน gs-link.json แล้วพาไปที่อยู่ tunnel ล่าสุด
//   - แอปอัปเดต gs-link.json ทุกครั้งที่ tunnel ได้ URL ใหม่ (ผ่าน GitHub CLI `gh` ที่ล็อกอินไว้ในเครื่อง
//     — แอปไม่เก็บ token เอง)
//   - repo ต้องเป็น public (GitHub Pages ฟรี) → ไฟล์มีแค่ที่อยู่แผง ไม่มีรหัส/ข้อมูลบัญชี
// ============================================================

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const GH = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'];
const ghBin = () => GH.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

function gh(args, input) {
  return new Promise((resolve) => {
    const bin = ghBin();
    if (!bin) return resolve({ code: 127, out: '', err: 'ไม่พบ GitHub CLI (brew install gh แล้ว gh auth login)' });
    const p = execFile(bin, args, { timeout: 30_000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout || ''), err: String(stderr || '') }));
    if (input != null) { p.stdin.write(input); p.stdin.end(); }
  });
}

async function putFile(repo, file, content, message) {
  const cur = await gh(['api', `repos/${repo}/contents/${file}`, '--jq', '.sha']);
  const body = { message, content: Buffer.from(content, 'utf8').toString('base64') };
  if (cur.code === 0 && cur.out.trim()) body.sha = cur.out.trim();
  const r = await gh(['api', '-X', 'PUT', `repos/${repo}/contents/${file}`, '--input', '-'], JSON.stringify(body));
  if (r.code !== 0) throw new Error(`อัปโหลด ${file} ไม่ได้: ${(r.err || r.out).trim().slice(0, 200)}`);
}

const pagesUrl = (repo) => { const [owner, name] = repo.split('/'); return `https://${owner.toLowerCase()}.github.io/${name}/`; };

// ตั้งครั้งแรก: สร้าง repo public (ถ้ายังไม่มี) + หน้า index + เปิด GitHub Pages
async function setup(repo, currentUrl, provider) {
  if (!REPO_RE.test(repo || '')) throw new Error('ชื่อ repo ต้องเป็นแบบ owner/name เช่น ProgramZa2560/goldsignal');
  const view = await gh(['repo', 'view', repo, '--json', 'name']);
  if (view.code !== 0) {
    const c = await gh(['repo', 'create', repo, '--public', '--description', 'GoldSignal — ลิงก์ถาวรไปแผงควบคุม (มีแค่ที่อยู่แผง ไม่มีข้อมูลบัญชี)']);
    if (c.code !== 0) throw new Error(`สร้าง repo ไม่ได้: ${(c.err || c.out).trim().slice(0, 200)}`);
  }
  await putFile(repo, 'index.html', fs.readFileSync(path.join(__dirname, 'pages-index.html'), 'utf8'), 'GoldSignal: หน้าลิงก์ถาวร');
  await putFile(repo, 'gs-link.json', linkJson(currentUrl, provider), 'GoldSignal: ที่อยู่แผงล่าสุด');
  const en = await gh(['api', '-X', 'POST', `repos/${repo}/pages`, '-f', 'source[branch]=main', '-f', 'source[path]=/']);
  if (en.code !== 0 && !/already|409|exists/i.test(en.err + en.out)) throw new Error(`เปิด GitHub Pages ไม่ได้: ${(en.err || en.out).trim().slice(0, 200)}`);
  return pagesUrl(repo);
}

const linkJson = (url, provider) => JSON.stringify({ url: url || null, provider: provider || null, updatedAt: new Date().toISOString() }, null, 2) + '\n';

async function publishLink(repo, url, provider) {
  if (!REPO_RE.test(repo || '')) return;
  await putFile(repo, 'gs-link.json', linkJson(url, provider), url ? 'GoldSignal: ที่อยู่แผงใหม่' : 'GoldSignal: แผงปิด');
}

module.exports = { setup, publishLink, pagesUrl, ghBin, REPO_RE };
