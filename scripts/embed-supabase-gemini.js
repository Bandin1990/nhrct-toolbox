const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) throw new Error('ไม่พบไฟล์ .env');
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

loadEnvFile();
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const geminiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2';
const dimensions = Number(process.env.GEMINI_EMBEDDING_DIMENSIONS || 1536);
if (!supabaseUrl || !serviceKey || !geminiKey || geminiKey.includes('วาง_Gemini')) throw new Error('ต้องตั้ง SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY และ GEMINI_API_KEY ใน .env');

async function supabase(resource, options = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${resource}`, {
    ...options,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

async function geminiEmbed(items) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`, {
    method: 'POST',
    headers: { 'x-goog-api-key': geminiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: items.map(item => ({
        model: `models/${model}`,
        content: { parts: [{ text: item.content }] },
        embedContentConfig: { taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: dimensions, title: item.title || '' },
      })),
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Gemini ${response.status}: ${body}`);
  const result = JSON.parse(body);
  return result.embeddings || [];
}

async function run() {
  const rows = await supabase('document_chunks?select=id,content,documents(title)&embedding=is.null&order=id.asc&limit=1000');
  let embedded = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const embeddings = await geminiEmbed(batch.map(row => ({ content: row.content, title: row.documents?.title })));
    if (embeddings.length !== batch.length) throw new Error(`จำนวน embedding ไม่ตรงกับ chunks: ${embeddings.length}/${batch.length}`);
    await Promise.all(batch.map((row, index) => supabase(`document_chunks?id=eq.${row.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ embedding: embeddings[index].values }),
    })));
    embedded += batch.length;
    console.log(`สร้าง Gemini embeddings แล้ว ${embedded}/${rows.length}`);
  }
  console.log(JSON.stringify({ model, dimensions, embedded }, null, 2));
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
