const fs = require('fs');
const path = require('path');

function envFile() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
envFile();

const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const geminiKey = process.env.GEMINI_API_KEY;
const embeddingModel = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2';
const generationModel = process.env.GEMINI_GENERATION_MODEL || 'gemini-3.6-flash';

function isConfigured() { return Boolean(supabaseUrl && serviceKey && geminiKey); }
function toArabicDigits(value) { return String(value || '').replace(/[๐-๙]/g, digit => String('๐๑๒๓๔๕๖๗๘๙'.indexOf(digit))); }

async function supabase(resource, options = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${resource}`, {
    ...options,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

async function embedQuery(query) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${embeddingModel}:embedContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': geminiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${embeddingModel}`,
      content: { parts: [{ text: query }] },
      embedContentConfig: { taskType: 'RETRIEVAL_QUERY', outputDimensionality: 1536 },
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Gemini embedding ${response.status}: ${body}`);
  return JSON.parse(body).embedding.values;
}

async function retrieve(query) {
  const embedding = await embedQuery(query);
  const rows = await supabase('rpc/match_document_chunks', {
    method: 'POST',
    body: JSON.stringify({ query_embedding: embedding, match_threshold: 0.55, match_count: 24 }),
  });
  const isCompilation = item => /หนังสือรวม|รวม\s*กม|รวมกฎหมาย|กฎหมายและระเบียบงาน|ฉบับรวม/i.test(`${item.title || ''} ${item.source_file || ''}`);
  const specific = rows.filter(item => !isCompilation(item));
  const preferred = specific.length ? specific : rows;
  const uniqueDocuments = [];
  const seenDocuments = new Set();
  for (const item of preferred) { const key = String(item.title || item.document_id).trim().toLowerCase(); if (seenDocuments.has(key)) continue; seenDocuments.add(key); uniqueDocuments.push(item); if (uniqueDocuments.length === 8) break; }
  return uniqueDocuments;
}

async function generate(query, evidence) {
  const evidenceText = evidence.map((item, index) => `[${index + 1}] ชื่อเอกสาร: ${item.title}\nประเภทเอกสาร: ${item.document_type}\nสถานะการจัดเก็บ: ${item.record_type || 'รายฉบับ'}\nเนื้อหา: ${item.content}`).join('\n\n');
  const prompt = `คุณคือผู้ช่วยงานสำนักงาน กสม. ตอบเป็นภาษาไทยโดยยึดหลักฐานด้านล่างเท่านั้น\n\nกติกา:\n- ห้ามใช้ความรู้ภายนอกหรือแต่งข้อมูลที่ไม่มีในหลักฐาน\n- หากหลักฐานไม่พอ ให้ตอบว่า "ยังไม่มีข้อมูลเพียงพอจากเอกสารในระบบ"\n- แยกข้อเท็จจริงจากข้อเสนอแนะ\n- ใส่เลขอ้างอิง [1], [2] ต่อท้ายข้อความที่อ้าง\n- อย่าวินิจฉัยว่ากฎหมายฉบับใดยังมีผลใช้บังคับ หากหลักฐานไม่ได้ระบุชัด\n\nคำถาม: ${query}\n\nหลักฐานจากฐานเอกสารภายใน:\n${evidenceText}`;
  const finalPrompt = `${prompt}\n\nรูปแบบคำตอบที่ต้องใช้:\n1. ใช้หัวข้อระดับ 2 Markdown (##) สำหรับทุกหัวข้อ เพื่อให้ระบบแสดงหัวข้อหนาและชัดเจน\n2. เริ่มด้วยหัวข้อ “คำตอบโดยสรุป”\n3. แยกหลักฐานและการอธิบายเป็น 3 ส่วนให้ชัดเจน: “ข้อกฎหมาย/ระเบียบ/ประกาศ/คำสั่ง” สำหรับเอกสารประเภทกฎหมาย, “แนวทางจากคู่มือปฏิบัติงาน” สำหรับคู่มือ, และ “ตัวอย่างแนวปฏิบัติ/บทเรียน” สำหรับบทเรียนหรือแนวทางการทำงาน\n4. ห้ามเรียกคู่มือหรือบทเรียนว่าเป็นข้อกฎหมาย และห้ามยกระดับตัวอย่างการทำงานให้เป็นข้อบังคับ\n5. หากส่วนใดไม่มีหลักฐาน ให้เขียนว่า “ไม่พบหลักฐานในเอกสารส่วนนี้” ห้ามเติมข้อมูล\n6. หากเป็นเรื่องขั้นตอน ให้เรียงเป็นข้อ 1, 2, 3 ตามหลักฐาน\n7. หากเปรียบเทียบเงื่อนไขหรือเอกสาร ให้ใช้ตาราง Markdown ที่อ่านง่าย\n8. แยกหัวข้อ “ข้อควรระวัง” เมื่อหลักฐานมีข้อจำกัด\n9. ปิดท้ายด้วย “เอกสารอ้างอิง” และใส่ [1], [2] ให้ตรงกับหลักฐานเท่านั้น โดยใช้ชื่อเอกสาร ไม่ใช้ชื่อไฟล์\n10. ใช้เลขอารบิก 0-9 ทุกกรณี และห้ามใช้เครื่องหมาย Markdown หนา เช่น ** หรือ __`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${generationModel}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': geminiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: finalPrompt }] }] }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Gemini generation ${response.status}: ${body}`);
  const result = JSON.parse(body);
  return result.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
}

async function recordQuestion(query, answerText, evidence) {
  const rows = await supabase('questions', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ question_text: query, answer_text: answerText, answer_status: answerText ? 'answered' : 'insufficient_evidence', model_name: generationModel }) });
  const questionId = rows?.[0]?.id;
  if (questionId && evidence.length) await supabase('answer_citations', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(evidence.map((item, index) => ({ question_id: questionId, document_id: item.document_id, chunk_id: item.chunk_id, citation_label: `[${index + 1}]`, quoted_text: item.content.slice(0, 1000), relevance_score: item.similarity }))) });
  return questionId;
}

async function updateDocumentContent(documentId, contentText) {
  const text = String(contentText || '').normalize('NFC').trim();
  const chunks = [];
  for (let index = 0; index < text.length; index += 2800) chunks.push(text.slice(index, index + 2800));
  const embeddings = [];
  for (let index = 0; index < chunks.length; index += 50) {
    const batch = chunks.slice(index, index + 50);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${embeddingModel}:batchEmbedContents`, { method: 'POST', headers: { 'x-goog-api-key': geminiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: batch.map(content => ({ model: `models/${embeddingModel}`, content: { parts: [{ text: content }] }, embedContentConfig: { taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 1536 } })) }) });
    const body = await response.text();
    if (!response.ok) throw new Error(`Gemini embedding ${response.status}: ${body}`);
    embeddings.push(...(JSON.parse(body).embeddings || []).map(item => item.values));
  }
  await supabase(`documents?id=eq.${encodeURIComponent(documentId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ content_text: text }) });
  await supabase(`document_chunks?document_id=eq.${encodeURIComponent(documentId)}`, { method: 'DELETE' });
  if (chunks.length) await supabase('document_chunks', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(chunks.map((content, chunk_index) => ({ document_id: documentId, chunk_index, content, embedding: embeddings[chunk_index] }))) });
  return { chunks: chunks.length };
}

async function answer(query) {
  const evidence = await retrieve(query);
  if (!evidence.length) return { found: false, message: 'ยังไม่พบหลักฐานที่ตรงกันในเอกสารภายในระบบ จึงไม่สร้างคำตอบจากแหล่งภายนอก', sources: [] };
  const answerText = toArabicDigits(await generate(query, evidence));
  const questionId = await recordQuestion(query, answerText, evidence);
  return {
    found: Boolean(answerText),
    answer: answerText || 'ยังไม่สามารถเรียบเรียงคำตอบจากหลักฐานในระบบได้',
    questionId,
    sources: evidence.map((item, index) => ({ id: item.document_id, chunkId: item.chunk_id, title: toArabicDigits(item.title), type: item.document_type === 'กฎหมาย ระเบียบ แนวปฏิบัติ' ? 'กฎหมาย / ระเบียบ' : item.document_type, sourceFile: toArabicDigits(item.source_file), file: item.source_path, evidence: toArabicDigits(item.content.slice(0, 500)), citation: `[${index + 1}]`, similarity: item.similarity })),
  };
}

module.exports = { isConfigured, answer, updateDocumentContent };
