const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('../db');

function loadEnvFile() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) throw new Error('ไม่พบไฟล์ .env ที่โฟลเดอร์โปรเจกต์');
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

loadEnvFile();
const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!baseUrl || !serviceKey) throw new Error('ต้องตั้ง SUPABASE_URL และ SUPABASE_SERVICE_ROLE_KEY ใน .env');

async function api(resource, options = {}) {
  const response = await fetch(`${baseUrl}/rest/v1/${resource}`, {
    ...options,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${resource} → ${response.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

function storageObjectPath(relativePath) {
  return `documents/${crypto.createHash('sha256').update(relativePath).digest('hex')}${path.extname(relativePath).toLowerCase()}`;
}

async function uploadFile(relativePath) {
  const file = path.join(store.root, relativePath);
  if (!fs.existsSync(file)) return false;
  const storagePath = storageObjectPath(relativePath);
  const response = await fetch(`${baseUrl}/storage/v1/object/reference-documents/${storagePath}`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: fs.readFileSync(file),
  });
  if (!response.ok) throw new Error(`อัปโหลด ${relativePath} → ${response.status}: ${await response.text()}`);
  return true;
}

function documentType(type) {
  if (type === 'คู่มือปฏิบัติงาน') return type;
  if (type === 'บทเรียนการทำงาน') return type;
  if (type === 'กฎหมาย / ระเบียบ') return 'กฎหมาย ระเบียบ แนวปฏิบัติ';
  return 'อื่น ๆ';
}

function chunks(text, size = 2800) {
  const value = String(text || '').trim();
  const result = [];
  for (let i = 0; i < value.length; i += size) result.push(value.slice(i, i + size));
  return result;
}

async function run() {
  const selectedPaths = new Set(process.argv.slice(2).map(value => value.replace(/\\/g, '/')));
  const documents = store.listDocuments().filter(doc => !selectedPaths.size || selectedPaths.has(doc.relative_path.replace(/\\/g, '/')));
  if (selectedPaths.size && !documents.length) throw new Error('ไม่พบเอกสารที่ระบุสำหรับนำเข้า');
  let imported = 0;
  let chunkCount = 0;
  let uploaded = 0;
  for (const doc of documents) {
    const externalKey = doc.relative_path.replace(/\\/g, '/');
    const record = {
      external_key: externalKey,
      title: doc.title || doc.source_file || externalKey,
      document_type: documentType(doc.type),
      legal_category: doc.subcategory || null,
      work_category: doc.tags?.[0] || null,
      record_type: doc.record_type || 'รายฉบับ',
      version_status: doc.version_status || 'รอตรวจสอบสถานะ',
      is_published: true,
      source_path: externalKey,
      source_file: doc.source_file || path.basename(externalKey),
      storage_path: storageObjectPath(externalKey),
      mime_type: doc.extension === '.pdf' ? 'application/pdf' : doc.extension === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/plain',
      file_size: doc.file_size || null,
      modified_at: new Date(Number(doc.modified_at)).toISOString(),
      content_hash: null,
      content_text: doc.content_text || '',
      metadata: { local_id: doc.id, tags: doc.tags || [], year: doc.year || null },
    };
    const saved = await api('documents?on_conflict=external_key', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(record),
    });
    const documentId = saved?.[0]?.id;
    if (!documentId) throw new Error(`ไม่สามารถอ่าน id ของเอกสาร ${externalKey}`);
    const parts = chunks(doc.content_text);
    if (parts.length) {
      await api('document_chunks?on_conflict=document_id,chunk_index', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(parts.map((content, chunkIndex) => ({ document_id: documentId, chunk_index: chunkIndex, content }))),
      });
      chunkCount += parts.length;
    }
    if (await uploadFile(externalKey)) uploaded += 1;
    imported += 1;
    if (imported % 10 === 0 || imported === documents.length) console.log(`นำเข้าแล้ว ${imported}/${documents.length} เอกสาร`);
  }
  console.log(JSON.stringify({ imported, chunks: chunkCount, uploaded }, null, 2));
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
