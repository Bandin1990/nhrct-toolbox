const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const localStoreUnavailable = () => { throw new Error('Supabase is not configured for this deployment'); };
const store = process.env.VERCEL
  ? { syncDocuments: () => ({ indexed: 0, removed: 0 }), listDocuments: localStoreUnavailable, stats: localStoreUnavailable, history: localStoreUnavailable, recordSearch: localStoreUnavailable }
  : require('./db');
const rag = require('./rag');

function loadEnvFile() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnvFile();

const root = __dirname;
if (!process.env.VERCEL) store.syncDocuments();
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabaseDataKey = process.env.SUPABASE_SERVICE_ROLE_KEY || supabaseKey;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
function readJson(req) { return new Promise((resolve, reject) => { let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 20 * 1024 * 1024) reject(new Error('Request body too large')); }); req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); } }); req.on('error', reject); }); }
async function supabaseRequest(resource, options = {}) {
  if (!supabaseUrl || !supabaseDataKey) throw new Error('Supabase is not configured');
  const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/${resource}`, {
    ...options,
    headers: { apikey: supabaseDataKey, Authorization: `Bearer ${supabaseDataKey}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}
function mapSupabaseDocument(row) {
  const type = row.document_type === 'กฎหมาย ระเบียบ แนวปฏิบัติ' ? 'กฎหมาย / ระเบียบ' : row.document_type;
  const tags = Array.isArray(row.metadata?.tags) ? row.metadata.tags : (row.work_category ? [row.work_category] : []);
  const toArabicDigits = value => String(value || '').replace(/[๐-๙]/g, digit => String('๐๑๒๓๔๕๖๗๘๙'.indexOf(digit)));
  const normalize = value => toArabicDigits(String(value || '').normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD\uE000-\uF8FF]/g, '').trim());
  const title = normalize(row.title);
  const sourceFile = normalize(row.source_file);
  const content = normalize(row.content_text).replace(/\s+/g, ' ');
  return { ...row, id: row.id, title, type, subcategory: row.legal_category || '', file: row.source_path, relative_path: row.source_path, source_file: sourceFile, tags, snippet: content ? `${content.slice(0, 280)}${content.length > 280 ? '…' : ''}` : `ไฟล์ ${sourceFile}`, available: true, record_type: row.record_type, version_status: row.version_status };
}
async function supabaseDocuments(query = {}) {
  const rows = await supabaseRequest('documents?select=*&is_published=eq.true&order=modified_at.desc.nullslast,title.asc&limit=1000');
  const docs = rows.map(mapSupabaseDocument);
  const q = String(query.q || '').trim().toLowerCase();
  return docs.filter(doc => (!query.type || query.type === 'ทั้งหมด' || doc.type === query.type) && (!query.subcategory || query.subcategory === 'ทั้งหมด' || doc.subcategory === query.subcategory) && (!query.tag || query.tag === 'ทั้งหมด' || doc.tags.includes(query.tag)) && (!q || `${doc.title} ${doc.source_file} ${doc.content_text || ''} ${doc.tags.join(' ')}`.toLowerCase().includes(q)));
}
async function supabaseStats() {
  const docs = await supabaseDocuments();
  const counts = {};
  docs.forEach(doc => { counts[doc.type] = (counts[doc.type] || 0) + 1; });
  return { documents: docs.length, searchable: docs.filter(doc => doc.content_text).length, searches: 0, byType: Object.entries(counts).map(([type, count]) => ({ type, count })) };
}
async function supabaseHistory(limit = 20) {
  const rows = await supabaseRequest(`questions?select=id,question_text,answer_status,created_at&order=created_at.desc&limit=${Math.min(limit, 100)}`);
  return rows.map(row => ({ id: row.id, query: row.question_text, result_count: row.answer_status === 'answered' ? 1 : 0, created_at: row.created_at }));
}
async function openSupabaseDocument(id, res) {
  const rows = await supabaseRequest(`documents?id=eq.${encodeURIComponent(id)}&select=storage_bucket,storage_path,source_path`);
  const doc = rows?.[0];
  if (!doc) return send(res, 404, { error: 'Document not found' });
  if (doc.storage_bucket && doc.storage_path) {
    const sign = await fetch(`${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/sign/${encodeURIComponent(doc.storage_bucket)}/${doc.storage_path.split('/').map(encodeURIComponent).join('/')}`, { method: 'POST', headers: { apikey: supabaseDataKey, Authorization: `Bearer ${supabaseDataKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 3600 }) });
    const payload = await sign.json();
    if (sign.ok && payload.signedURL) {
      const signedUrl = payload.signedURL.startsWith('http') ? payload.signedURL : `${supabaseUrl.replace(/\/$/, '')}/storage/v1${payload.signedURL}`;
      const source = await fetch(signedUrl);
      if (source.ok) {
        const bytes = Buffer.from(await source.arrayBuffer());
        const extension = path.extname(doc.source_path || '').toLowerCase();
        const contentType = extension === '.pdf' ? 'application/pdf' : extension === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/plain; charset=utf-8';
        const filename = path.basename(doc.source_path || 'document').replace(/[\r\n"]/g, '_');
        res.writeHead(200, { 'Content-Type': contentType, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`, 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=300' });
        return res.end(bytes);
      }
    }
  }
  const file = safeFile(doc.source_path);
  if (!file) return send(res, 404, { error: 'Source file not found' });
  return fs.readFile(file, (err, data) => err ? send(res, 404, { error: 'Source file not found' }) : send(res, 200, data, 'application/octet-stream'));
}
async function documentContent(id, res) {
  const rows = await supabaseRequest(`documents?id=eq.${encodeURIComponent(id)}&select=id,title,content_text,source_file,source_path,document_type,record_type,version_status,modified_at`);
  if (!rows?.[0]) return send(res, 404, { error: 'Document not found' });
  return send(res, 200, mapSupabaseDocument(rows[0]));
}
async function updateDocument(id, payload, res) {
  const rows = await supabaseRequest(`documents?id=eq.${encodeURIComponent(id)}&select=id,title,content_text`);
  if (!rows?.[0]) return send(res, 404, { error: 'Document not found' });
  const title = typeof payload.title === 'string' ? payload.title.trim() : rows[0].title;
  const content = typeof payload.content_text === 'string' ? payload.content_text : rows[0].content_text || '';
  if (!title) return send(res, 400, { error: 'Document title is required' });
  if (content !== (rows[0].content_text || '')) await rag.updateDocumentContent(id, content);
  if (title !== rows[0].title) await supabaseRequest(`documents?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ title }) });
  return send(res, 200, { ok: true, id, title, contentLength: content.length });
}
function answer(query) {
  const q = String(query || '').trim();
  if (!q) return { found: false, message: 'พิมพ์ปัญหา สถานการณ์ หรือหัวข้อที่ต้องการค้นจากเอกสาร กสม.' };
  const sources = store.listDocuments({ q }).filter(doc => doc.searchable).slice(0, 5);
  store.recordSearch(q, sources.length);
  if (!sources.length) return { found: false, message: 'ยังไม่พบข้อความที่ตรงกันในเอกสารที่นำเข้าระบบ จึงไม่สร้างคำตอบจากแหล่งภายนอก', searched: store.stats().documents };
  return { found: true, answer: `ผู้ช่วยพบหลักฐานที่เกี่ยวข้อง ${sources.length} รายการจากฐานอ้างอิงภายใน และจะเรียบเรียงคำตอบโดยยึดข้อความเหล่านี้เท่านั้น`, sources: sources.map(doc => ({ id: doc.id, title: doc.title, type: doc.type, year: doc.year, file: doc.relative_path, sourceFile: doc.source_file, recordType: doc.record_type, versionStatus: doc.version_status, evidence: doc.snippet, tags: doc.tags })) };
}
function safeFile(relative) { const target = path.resolve(root, relative); return target.startsWith(root) ? target : null; }
async function authenticatedUser(req) {
  if (!supabaseUrl || !supabaseKey) return { configMissing: true };
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/user`, { headers: { apikey: supabaseKey, Authorization: header } });
  if (!response.ok) return null;
  return response.json();
}
async function requireAuth(req, res) {
  const user = await authenticatedUser(req);
  if (user?.configMissing) { send(res, 503, { error: 'Supabase Auth is not configured. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.' }); return null; }
  if (!user) { send(res, 401, { error: 'Authentication required.' }); return null; }
  return user;
}
function isAdmin(user) {
  const roles = Array.isArray(user?.app_metadata?.roles) ? user.app_metadata.roles : [];
  const role = user?.app_metadata?.role;
  const allowList = String(process.env.ADMIN_EMAILS || '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
  return role === 'admin' || roles.includes('admin') || allowList.includes(String(user?.email || '').toLowerCase());
}
async function requireAdmin(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  if (!isAdmin(user)) { send(res, 403, { error: 'Admin access required.' }); return null; }
  return user;
}

const requestHandler = async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname === '/api/config') return send(res, 200, { supabaseUrl: supabaseUrl || '', supabaseKey: supabaseKey || '' });
  if (parsed.pathname === '/api/me') { const user = await requireAuth(req, res); if (!user) return; return send(res, 200, { id: user.id, email: user.email, isAdmin: isAdmin(user) }); }
  if (parsed.pathname === '/api/documents') { const documents = supabaseDataKey ? await supabaseDocuments(parsed.query) : store.listDocuments({ type: parsed.query.type, subcategory: parsed.query.subcategory, tag: parsed.query.tag, q: parsed.query.q }); return send(res, 200, { total: documents.length, documents }); }
  if (parsed.pathname === '/api/stats') return send(res, 200, supabaseDataKey ? await supabaseStats() : store.stats());
  if (parsed.pathname === '/api/history') return send(res, 200, { history: supabaseDataKey ? await supabaseHistory(Number(parsed.query.limit) || 20) : store.history(Number(parsed.query.limit) || 20) });
  if (parsed.pathname === '/api/ask' && req.method === 'GET') {
    if (rag.isConfigured()) {
      try { return send(res, 200, await rag.answer(parsed.query.q)); }
      catch (error) { return send(res, 502, { found: false, error: 'ระบบ AI ไม่สามารถอ่านฐานอ้างอิงได้', detail: error.message }); }
    }
    return send(res, 200, answer(parsed.query.q));
  }
  const documentFileMatch = parsed.pathname.match(/^\/api\/documents\/([^/]+)\/file$/);
  if (documentFileMatch) return openSupabaseDocument(decodeURIComponent(documentFileMatch[1]), res);
  const documentContentMatch = parsed.pathname.match(/^\/api\/documents\/([^/]+)\/content$/);
  if (documentContentMatch) return documentContent(decodeURIComponent(documentContentMatch[1]), res);
  const documentUpdateMatch = parsed.pathname.match(/^\/api\/documents\/([^/]+)$/);
  if (documentUpdateMatch && req.method === 'PATCH') { const user = await requireAdmin(req, res); if (!user) return; try { return updateDocument(decodeURIComponent(documentUpdateMatch[1]), await readJson(req), res); } catch (error) { return send(res, 400, { error: error.message }); } }
  if (parsed.pathname === '/api/sync' && req.method === 'POST') { const user = await requireAdmin(req, res); if (!user) return; return send(res, 200, store.syncDocuments()); }
  if (parsed.pathname.startsWith('/files/')) { const file = safeFile(decodeURIComponent(parsed.pathname.replace('/files/', ''))); if (!file) return send(res, 404, { error: 'Not found' }); return fs.readFile(file, (err, data) => err ? send(res, 404, { error: 'Not found' }) : send(res, 200, data, 'application/pdf')); }
  const requested = parsed.pathname === '/' ? 'index.html' : parsed.pathname.replace(/^\//, ''); const file = safeFile(requested);
  if (!file) return send(res, 404, { error: 'Not found' });
  fs.readFile(file, (err, data) => { if (err) return send(res, 404, { error: 'Not found' }); const ext = path.extname(file); const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }; send(res, 200, data, types[ext] || 'application/octet-stream'); });
};
const server = http.createServer((req, res) => {
  requestHandler(req, res).catch(error => {
    console.error('Request failed:', error);
    if (!res.headersSent) return send(res, 500, { error: 'Server configuration error', detail: error.message });
    res.end();
  });
});
if (require.main === module) {
  server.listen(process.env.PORT || 3000, () => console.log(`Sithiprom running at http://localhost:${process.env.PORT || 3000}`));
}

module.exports = server;
