const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { db, root } = require('../db');

function loadEnvFile() {
  const file = path.join(root, '.env');
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnvFile();

const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const geminiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_OCR_MODEL || 'gemini-3.6-flash';
const python = process.env.PYTHON_BIN || 'C:\\Users\\tongd\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe';
if (!supabaseUrl || !serviceKey || !geminiKey) throw new Error('ต้องตั้ง Supabase service key และ GEMINI_API_KEY ใน .env');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '.git', '.codex', '.agents', 'data'].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
function needsOcr(file) {
  const code = "from pypdf import PdfReader; import sys; r=PdfReader(sys.argv[1]); t=''.join((p.extract_text() or '') for p in r.pages[:10]); print(len(t))";
  try { return Number(execFileSync(python, ['-c', code, file], { timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }).toString()) < 150; } catch { return true; }
}
function clean(text) {
  return String(text || '').normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD\uE000-\uF8FF]/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
function chunks(text, size = 2800) {
  const result = []; for (let i = 0; i < text.length; i += size) result.push(text.slice(i, i + size)); return result;
}
async function supabase(resource, options = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${resource}`, { ...options, headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await response.text(); if (!response.ok) throw new Error(`Supabase ${response.status}: ${body}`); return body ? JSON.parse(body) : null;
}
async function ocr(file) {
  const base64 = fs.readFileSync(file).toString('base64');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'x-goog-api-key': geminiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'application/pdf', data: base64 } }, { text: 'อ่านข้อความภาษาไทยใน PDF นี้แบบถอดความตามต้นฉบับ ห้ามสรุป ห้ามเติมข้อมูล รักษาลำดับหัวข้อและย่อหน้า ถ้าอ่านไม่ชัดให้ใส่ [อ่านไม่ชัด] และส่งเฉพาะข้อความเอกสารที่อ่านได้' }] }] }),
  });
  const body = await response.text(); if (!response.ok) throw new Error(`Gemini ${response.status}: ${body}`);
  return clean(JSON.parse(body).candidates?.[0]?.content?.parts?.map(part => part.text || '').join('\n') || '');
}
async function save(relativePath, text) {
  const doc = db.prepare('SELECT id FROM documents WHERE relative_path=?').get(relativePath);
  if (doc) db.prepare('UPDATE documents SET content_text=?, searchable=1, updated_at=CURRENT_TIMESTAMP WHERE relative_path=?').run(text, relativePath);
  const rows = await supabase(`documents?external_key=eq.${encodeURIComponent(relativePath)}&select=id`);
  const remoteId = rows?.[0]?.id; if (!remoteId) throw new Error(`ไม่พบเอกสารใน Supabase: ${relativePath}`);
  await supabase(`documents?id=eq.${remoteId}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ content_text: text }) });
  await supabase(`document_chunks?document_id=eq.${remoteId}`, { method: 'DELETE' });
  const parts = chunks(text);
  if (parts.length) await supabase('document_chunks', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(parts.map((content, chunk_index) => ({ document_id: remoteId, chunk_index, content }))) });
  return { remoteId, chunks: parts.length };
}
async function run() {
  const candidates = walk(root).filter(file => /\.pdf$/i.test(file) && needsOcr(file));
  const limit = Number(process.argv[2] || candidates.length);
  const offset = Number(process.env.OCR_OFFSET || 0);
  const selected = candidates.slice(offset, offset + limit);
  console.log(`พบ PDF ที่ควร OCR ${candidates.length} ไฟล์; จะทำ ${selected.length} ไฟล์`);
  for (const file of selected) {
    const relativePath = path.relative(root, file).replace(/\\/g, '/');
    console.log(`กำลัง OCR: ${relativePath}`);
    const text = await ocr(file);
    if (text.length < 80) throw new Error(`Gemini อ่านข้อความได้น้อยเกินไป: ${relativePath}`);
    const result = await save(relativePath, text);
    console.log(JSON.stringify({ file: relativePath, characters: text.length, ...result }));
  }
  if (selected.length) execFileSync(process.execPath, [path.join(__dirname, 'embed-supabase-gemini.js')], { stdio: 'inherit', timeout: 600000 });
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
