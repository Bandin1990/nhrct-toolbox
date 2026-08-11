const fs = require('fs');
const path = require('path');
const { db } = require('../db');

function loadEnvFile() {
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnvFile();
const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const geminiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_GENERATION_MODEL || 'gemini-3.6-flash';
if (!baseUrl || !serviceKey || !geminiKey) throw new Error('ต้องตั้ง Supabase service key และ Gemini key ใน .env');

function generic(title) { return !title || /^KM\s*\d/i.test(title) || /^Microsoft Word/i.test(title) || /^file[-_\s]*\d{5,}$/i.test(title) || /^เอกสาร[-_\s]*\d{5,}$/i.test(title) || /^[\d\s._-]+(?:\.pdf)?$/i.test(title) || /^[-_\d]+\.pdf$/i.test(title); }
async function api(resource, options = {}) { const response = await fetch(`${baseUrl}/rest/v1/${resource}`, { ...options, headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', ...(options.headers || {}) } }); const body = await response.text(); if (!response.ok) throw new Error(`${response.status}: ${body}`); return body ? JSON.parse(body) : null; }
async function titleFromGemini(title, content, sourceFile) {
  const prompt = `เลือกชื่อเอกสารจริงจากข้อความเอกสารด้านล่าง ห้ามแต่งชื่อใหม่ ห้ามใส่คำอธิบาย ส่งเฉพาะชื่อเอกสารภาษาไทย 1 บรรทัด ไม่เกิน 180 ตัวอักษร หากข้อมูลไม่พอให้ตอบว่าไม่พบชื่อเอกสาร\nชื่อไฟล์เดิม: ${sourceFile}\nชื่อที่ระบบอ่านได้: ${title}\nข้อความเอกสาร:\n${String(content || '').slice(0, 7000)}`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': geminiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }) });
  const body = await response.text(); if (!response.ok) throw new Error(`Gemini ${response.status}: ${body}`);
  return String(JSON.parse(body).candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '').replace(/[\r\n*#`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
}
async function run() {
  const rows = await api('documents?select=id,external_key,title,source_file,content_text&limit=1000');
  const targets = rows.filter(row => generic(row.title) && String(row.content_text || '').trim().length > 80);
  console.log(`พบเอกสารชื่อไม่สมบูรณ์ ${targets.length} รายการที่มีข้อความให้ตรวจชื่อ`);
  let changed = 0;
  for (const row of targets) {
    const title = await titleFromGemini(row.title, row.content_text, row.source_file);
    if (!title || title === 'ไม่พบชื่อเอกสาร') continue;
    await api(`documents?id=eq.${row.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ title }) });
    db.prepare('UPDATE documents SET title=?, updated_at=CURRENT_TIMESTAMP WHERE relative_path=?').run(title, row.external_key);
    changed += 1; console.log(`${changed}/${targets.length} ${row.source_file} → ${title}`);
  }
  console.log(JSON.stringify({ checked: targets.length, changed }, null, 2));
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
