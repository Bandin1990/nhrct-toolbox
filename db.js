const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const root = process.env.VERCEL ? path.join('/tmp', 'nhrc-toolbox') : __dirname;
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'sithiprom.sqlite'));

const legalSubcategories = ['รัฐธรรมนูญ', 'พระราชบัญญัติประกอบรัฐธรรมนูญ', 'พระราชบัญญัติ', 'ระเบียบ ประกาศ แนวปฏิบัติ และคำสั่ง กสม.', 'ระเบียบ ประกาศ แนวปฏิบัติและข้อบังคับของสำนักงาน กสม.'];
const workTags = ['งานดิจิทัล', 'งานงบประมาณ งานคลัง', 'งานพัสดุ-จัดซื้อจัดจ้าง งานบุคคล', 'งานสารบรรณ งานบริหารทั่วไป', 'งานคุ้มครอง', 'งานส่งเสริม', 'งานเฝ้าระวัง', 'งานระหว่างประเทศ', 'งานวิจัยและวิชาการ'];

function init() {
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL, subcategory TEXT,
      relative_path TEXT NOT NULL UNIQUE, source_file TEXT, extension TEXT NOT NULL,
      content_text TEXT NOT NULL DEFAULT '', file_size INTEGER NOT NULL DEFAULT 0,
      modified_at INTEGER NOT NULL, searchable INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS document_tags (document_id TEXT NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY(document_id, tag_id), FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE, FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS search_history (id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT NOT NULL, result_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type);
    CREATE INDEX IF NOT EXISTS idx_documents_modified ON documents(modified_at DESC);
    CREATE INDEX IF NOT EXISTS idx_history_created ON search_history(created_at DESC);
  `);
  const columns = db.prepare('PRAGMA table_info(documents)').all().map(row => row.name);
  if (!columns.includes('record_type')) db.exec("ALTER TABLE documents ADD COLUMN record_type TEXT NOT NULL DEFAULT 'รายฉบับ'");
  if (!columns.includes('collection_id')) db.exec('ALTER TABLE documents ADD COLUMN collection_id TEXT');
  if (!columns.includes('version_status')) db.exec("ALTER TABLE documents ADD COLUMN version_status TEXT NOT NULL DEFAULT 'รอการยืนยันสถานะ'");
  const addTag = db.prepare('INSERT OR IGNORE INTO tags(name) VALUES (?)');
  [...workTags, ...legalSubcategories].forEach(tag => addTag.run(tag));
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '.git', '.codex', '.agents', 'data'].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
function decodeText(buffer) { const text = buffer.toString('utf8'); return text.includes('\uFFFD') ? buffer.toString('latin1') : text; }
function xmlText(value) { return value.replace(/<w:tab\s*\/?>/g, '\t').replace(/<w:br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))); }
function readZipEntry(buffer, wanted) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); if (eocd < 0) return null;
  const centralSize = buffer.readUInt32LE(eocd + 12); const centralOffset = buffer.readUInt32LE(eocd + 16); let cursor = centralOffset; const end = centralOffset + centralSize;
  while (cursor < end && buffer.readUInt32LE(cursor) === 0x02014b50) {
    const method = buffer.readUInt16LE(cursor + 10); const compressedSize = buffer.readUInt32LE(cursor + 20); const nameLength = buffer.readUInt16LE(cursor + 28); const extraLength = buffer.readUInt16LE(cursor + 30); const commentLength = buffer.readUInt16LE(cursor + 32); const localOffset = buffer.readUInt32LE(cursor + 42); const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (name === wanted) { const localNameLength = buffer.readUInt16LE(localOffset + 26); const localExtraLength = buffer.readUInt16LE(localOffset + 28); const start = localOffset + 30 + localNameLength + localExtraLength; const data = buffer.subarray(start, start + compressedSize); return method === 8 ? zlib.inflateRawSync(data) : data; }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}
function docxText(file) { try { const xml = readZipEntry(fs.readFileSync(file), 'word/document.xml'); if (!xml) return ''; const source = xml.toString('utf8'); return [...source.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(match => xmlText(match[0]).trim()).filter(Boolean).join('\n'); } catch { return ''; } }
function cleanText(text) { return String(text || '').normalize('NFC').replace(/\r/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD\uE000-\uF8FF]/g, ' ').replace(/^---[\s\S]*?---\s*/m, '').replace(/[#*_`]/g, ' ').replace(/\s+/g, ' ').trim(); }
function pdfTitle(file) {
  try {
    const binary = fs.readFileSync(file).toString('latin1');
    const match = binary.match(/\/Title\s*\(([^)]*)\)/s);
    if (!match) return '';
    let value = match[1].replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))).replace(/\\([\\()])/g, '$1').trim();
    if (value.charCodeAt(0) === 0xfe && value.charCodeAt(1) === 0xff) {
      const bytes = Buffer.from(value, 'latin1').subarray(2); bytes.swap16(); value = bytes.toString('utf16le');
    }
    value = value.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    return value && !/^Microsoft Word/i.test(value) && value.length > 3 ? value : '';
  } catch { return ''; }
}
function pdfFirstPageTitle(file) {
  const python = process.env.PYTHON_BIN || 'C:\\Users\\tongd\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe';
  if (!fs.existsSync(python)) return '';
  try {
    const code = "from pypdf import PdfReader; import sys; t=(PdfReader(sys.argv[1]).pages[0].extract_text() or ''); sys.stdout.buffer.write(t.encode('utf8'))";
    const text = execFileSync(python, ['-c', code, file], { timeout: 12000, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
    const lines = text.split(/\r?\n/).map(line => line.replace(/\u0000/g, '').replace(/(?<=[ก-๙])\s+(?=[ก-๙])/g, '').replace(/\s+/g, ' ').trim()).filter(line => line.length > 12);
    const preferredIndex = lines.findIndex(line => /^(หัวข้อ|เรื่อง|รายงาน|คู่มือ|แนวทาง|ประกาศ|ระเบียบ|กฎหมาย|การ)/.test(line) && !/^KM\s*\d/i.test(line));
    if (preferredIndex >= 0 && /^หัวข้อ/.test(lines[preferredIndex])) {
      const titleLines = []; for (let i = preferredIndex; i < lines.length && titleLines.length < 4; i++) { if (/^(รายงาน|จัดทำโดย|เมื่อวันที่|KM\s*\d)/i.test(lines[i]) && titleLines.length) break; titleLines.push(lines[i]); }
      return titleLines.join(' ').slice(0, 260);
    }
    return (preferredIndex >= 0 ? lines[preferredIndex] : lines[0] || '').slice(0, 260);
  } catch { return ''; }
}
function titleFor(raw, file) { return raw.match(/^title:\s*(.+)$/m)?.[1]?.trim() || raw.match(/^#\s+(.+)$/m)?.[1]?.trim() || (/\.docx$/i.test(file) && raw.split(/\n/).find(Boolean)?.slice(0, 160)) || (/\.pdf$/i.test(file) && (pdfFirstPageTitle(file) || pdfTitle(file))) || path.basename(file, path.extname(file)).replace(/[_-]+/g, ' '); }
function classify(relative, title) {
  const name = `${relative} ${title}`;
  let subcategory = null;
  if (name.includes('รัฐธรรมนูญ') && !name.includes('ประกอบ')) subcategory = 'รัฐธรรมนูญ';
  else if (name.includes('ประกอบรัฐธรรมนูญ')) subcategory = 'พระราชบัญญัติประกอบรัฐธรรมนูญ';
  else if (name.includes('พระราชบัญญัติ') || name.includes('พ.ร.บ.') || name.includes('พ ร บ')) subcategory = 'พระราชบัญญัติ';
  else if (name.includes('กฎหมาย ระเบียบ')) subcategory = 'ระเบียบ ประกาศ แนวปฏิบัติและข้อบังคับของสำนักงาน กสม.';
  else if (name.includes('กฎหมายสิทธิมนุษยชนระหว่างประเทศ')) subcategory = 'ระเบียบ ประกาศ แนวปฏิบัติ และคำสั่ง กสม.';
  const tags = workTags.filter(tag => tag.split(' ').some(word => word.length > 2 && name.includes(word)));
  if (name.includes('KM')) tags.push('งานวิจัยและวิชาการ');
  if (name.includes('คู่มือของ กสม')) tags.push('งานบริหารทั่วไป');
  return { subcategory, tags: [...new Set(tags)] };
}
function typeFor(relative) {
  if (relative.includes('กฎหมาย ระเบียบ') || relative.includes('กฎหมายสิทธิมนุษยชนระหว่างประเทศ')) return 'กฎหมาย / ระเบียบ';
  if (relative.includes('คู่มือของ กสม')) return 'คู่มือปฏิบัติงาน';
  if (relative.includes('KM')) return 'บทเรียนการทำงาน';
  if (/ปี \d{4}/.test(relative)) return 'กรณีศึกษา / มติ กสม.';
  return 'เอกสารสำนักงาน';
}
function recordClassification(relative, title) {
  const combined = `${relative} ${title}`;
  const isCompilation = /หนังสือรวม|รวม กม|รวมกฎหมาย|รวมกฎหมายและระเบียบ/i.test(combined);
  return { recordType: isCompilation ? 'ฉบับรวม' : 'รายฉบับ', collectionId: isCompilation ? 'กฎหมาย-ระเบียบ-รวม' : null, versionStatus: isCompilation ? 'ใช้ตรวจสอบว่ามีฉบับใดใช้อยู่' : 'รอการยืนยันสถานะ' };
}
function syncDocuments() {
  const files = walk(root).filter(file => /\.(md|pdf|docx)$/i.test(file));
  const upsert = db.prepare(`INSERT INTO documents (id,title,type,subcategory,relative_path,source_file,extension,content_text,file_size,modified_at,searchable,record_type,collection_id,version_status,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(relative_path) DO UPDATE SET title=excluded.title,type=excluded.type,subcategory=excluded.subcategory,source_file=excluded.source_file,extension=excluded.extension,content_text=excluded.content_text,file_size=excluded.file_size,modified_at=excluded.modified_at,searchable=excluded.searchable,record_type=excluded.record_type,collection_id=excluded.collection_id,version_status=excluded.version_status,updated_at=CURRENT_TIMESTAMP`);
  const findTag = db.prepare('SELECT id FROM tags WHERE name=?');
  const addDocTag = db.prepare('INSERT OR IGNORE INTO document_tags(document_id,tag_id) VALUES (?,?)');
  const clearDocTags = db.prepare('DELETE FROM document_tags WHERE document_id=?');
  const existing = new Set(files.map(file => path.relative(root, file).replaceAll('\\', '/')));
  let removed = 0;
  db.exec('BEGIN');
  try {
    for (const file of files) {
      const relative = path.relative(root, file).replaceAll('\\', '/');
      const fileStat = fs.statSync(file); const existingDoc = db.prepare('SELECT modified_at,title FROM documents WHERE relative_path=?').get(relative);
      const genericTitle = existingDoc && (/^KM\s*\d/i.test(existingDoc.title) || /^Microsoft Word/i.test(existingDoc.title) || /^[\d\s_-]+$/.test(existingDoc.title));
      if (existingDoc && existingDoc.modified_at === Math.round(fileStat.mtimeMs) && !genericTitle) continue;
      const isMd = /\.md$/i.test(file); const isDocx = /\.docx$/i.test(file); const raw = isMd ? decodeText(fs.readFileSync(file)) : (isDocx ? docxText(file) : '');
      const content = isMd || isDocx ? cleanText(raw) : '';
      const title = titleFor(raw, file); const type = typeFor(relative); const classification = classify(relative, title);
      const record = recordClassification(relative, title);
      const modified = Math.round(fileStat.mtimeMs);
      const id = `doc-${Buffer.from(relative).toString('base64url')}`;
      upsert.run(id, title, type, classification.subcategory, relative, raw.match(/^source_file:\s*(.+)$/m)?.[1]?.trim() || relative, path.extname(file).toLowerCase(), content, fileStat.size, modified, content ? 1 : 0, record.recordType, record.collectionId, record.versionStatus);
      clearDocTags.run(id);
      const allTags = [...classification.tags, ...(classification.subcategory ? [classification.subcategory] : [])];
      for (const tag of allTags) { const row = findTag.get(tag); if (row) addDocTag.run(id, row.id); }
    }
    const old = db.prepare('SELECT relative_path FROM documents').all().map(row => row.relative_path).filter(relative => !existing.has(relative));
    const remove = db.prepare('DELETE FROM documents WHERE relative_path=?'); old.forEach(relative => remove.run(relative)); removed = old.length;
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { indexed: files.length, removed };
}

function listDocuments({ type = '', subcategory = '', tag = '', q = '' } = {}) {
  const params = []; const where = [];
  if (type && type !== 'ทั้งหมด') { where.push('d.type=?'); params.push(type); }
  if (subcategory && subcategory !== 'ทั้งหมด') { where.push('d.subcategory=?'); params.push(subcategory); }
  if (tag && tag !== 'ทั้งหมด') { where.push('EXISTS (SELECT 1 FROM document_tags dt JOIN tags t ON t.id=dt.tag_id WHERE dt.document_id=d.id AND t.name=?)'); params.push(tag); }
  if (q) { where.push('(LOWER(d.title) LIKE LOWER(?) OR LOWER(d.relative_path) LIKE LOWER(?) OR LOWER(d.content_text) LIKE LOWER(?))'); const like = `%${q}%`; params.push(like, like, like); }
  const sql = `SELECT d.*, COALESCE((SELECT json_group_array(t.name) FROM document_tags dt JOIN tags t ON t.id=dt.tag_id WHERE dt.document_id=d.id), '[]') tags_json FROM documents d ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.modified_at DESC, d.title ASC`;
  return db.prepare(sql).all(...params).map(row => ({ ...row, file: row.relative_path, year: row.relative_path.match(/ปี (\d{4})/)?.[1] || '—', tags: JSON.parse(row.tags_json || '[]'), snippet: row.content_text ? `${row.content_text.slice(0, 280)}${row.content_text.length > 280 ? '…' : ''}` : `ไฟล์ ${row.source_file || row.relative_path} อยู่ในฐานเอกสารภายในสำนักงาน`, available: fs.existsSync(path.join(root, row.relative_path)) }));
}
function recordSearch(query, resultCount) { db.prepare('INSERT INTO search_history(query,result_count) VALUES (?,?)').run(query, resultCount); }
function history(limit = 20) { return db.prepare('SELECT id,query,result_count,created_at FROM search_history ORDER BY created_at DESC,id DESC LIMIT ?').all(limit); }
function stats() { return { documents: db.prepare('SELECT COUNT(*) count FROM documents').get().count, searchable: db.prepare('SELECT COUNT(*) count FROM documents WHERE searchable=1').get().count, searches: db.prepare('SELECT COUNT(*) count FROM search_history').get().count, byType: db.prepare('SELECT type,COUNT(*) count FROM documents GROUP BY type ORDER BY count DESC').all() }; }

init();
module.exports = { db, root, init, syncDocuments, listDocuments, recordSearch, history, stats, workTags, legalSubcategories };
