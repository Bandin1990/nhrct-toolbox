const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { db, root } = require('../db');

function loadEnv() {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnv();
const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const python = process.env.PYTHON_BIN || 'C:\\Users\\tongd\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe';
if (!baseUrl || !serviceKey) throw new Error('ต้องตั้งค่า Supabase ใน .env');

async function api(resource, options = {}) {
  const response = await fetch(`${baseUrl}/rest/v1/${resource}`, {
    ...options,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '.git', '.codex', '.agents', 'data'].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
function extract(file) {
  const code = "from pypdf import PdfReader; import sys; r=PdfReader(sys.argv[1]); sys.stdout.buffer.write('\\n\\n'.join((p.extract_text() or '') for p in r.pages).encode('utf8'))";
  try { return execFileSync(python, ['-c', code, file], { timeout: 180000, maxBuffer: 30 * 1024 * 1024 }).toString('utf8').normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD\uE000-\uF8FF]/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(); } catch { return ''; }
}
function chunks(text, size = 2800) { const result = []; for (let i = 0; i < text.length; i += size) result.push(text.slice(i, i + size)); return result; }

async function run() {
  const remote = await api('documents?select=id,external_key,content_text&limit=1000');
  const remoteByPath = new Map(remote.map(row => [row.external_key, row]));
  const pdfs = walk(root).filter(file => /\.pdf$/i.test(file));
  let updated = 0;
  for (const file of pdfs) {
    const externalKey = path.relative(root, file).replace(/\\/g, '/');
    const row = remoteByPath.get(externalKey);
    if (!row) continue;
    const text = extract(file);
    if (text.length < 80) continue;
    if (String(row.content_text || '').length >= text.length) continue;
    await api(`documents?id=eq.${row.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ content_text: text }) });
    await api(`document_chunks?document_id=eq.${row.id}`, { method: 'DELETE' });
    const parts = chunks(text);
    await api('document_chunks', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(parts.map((content, chunk_index) => ({ document_id: row.id, chunk_index, content }))) });
    db.prepare('UPDATE documents SET content_text=?, searchable=1, updated_at=CURRENT_TIMESTAMP WHERE relative_path=?').run(text, externalKey);
    updated += 1;
    console.log(`${updated}: ${externalKey} (${text.length} ตัวอักษร, ${parts.length} chunks)`);
  }
  console.log(JSON.stringify({ scanned: pdfs.length, updated }, null, 2));
  if (updated) require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'embed-supabase-gemini.js')], { stdio: 'inherit', timeout: 600000 });
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
