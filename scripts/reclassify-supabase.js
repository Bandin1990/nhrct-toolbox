const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const root = path.join(__dirname, '..');
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); }
const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const legal = ['รัฐธรรมนูญ', 'พระราชบัญญัติประกอบรัฐธรรมนูญ', 'พระราชบัญญัติ', 'ระเบียบ ประกาศ แนวปฏิบัติ และคำสั่ง กสม.', 'ระเบียบ ประกาศ แนวปฏิบัติและข้อบังคับของสำนักงาน กสม.'];
const work = ['งานดิจิทัล', 'งานงบประมาณ งานคลัง', 'งานพัสดุ-จัดซื้อจัดจ้าง งานบุคคล', 'งานสารบรรณ งานบริหารทั่วไป', 'งานคุ้มครอง', 'งานส่งเสริม', 'งานเฝ้าระวัง', 'งานระหว่างประเทศ', 'งานวิจัยและวิชาการ'];
async function api(resource, options = {}) { const response = await fetch(`${base}/rest/v1/${resource}`, { ...options, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(options.headers || {}) } }); const body = await response.text(); if (!response.ok) throw new Error(body); return body ? JSON.parse(body) : null; }
function classify(row) {
  const label = `${row.title} ${row.external_key}`.toLowerCase();
  const text = `${label} ${(row.content_text || '').slice(0, 1600)}`.toLowerCase();
  let category = null;
  if (row.document_type === 'กฎหมาย ระเบียบ แนวปฏิบัติ') {
    if (label.includes('รัฐธรรมนูญ') && !label.includes('ประกอบรัฐธรรมนูญ')) category = legal[0];
    else if (label.includes('พระราชบัญญัติประกอบรัฐธรรมนูญ')) category = legal[1];
    else if (label.includes('พระราชบัญญัติ') || label.includes('พ.ร.บ.')) category = legal[2];
    else if (label.includes('สำนักงาน') || label.includes('สนง.') || label.includes('สวัสดิการ')) category = legal[4];
    else category = legal[3];
  }
  const tags = [];
  const add = (tag, words) => { if (words.some(word => text.includes(word))) tags.push(tag); };
  add(work[0], ['ดิจิทัล', 'สารสนเทศ', 'เทคโนโลยี', 'เว็บไซต์', 'ระบบ erp', ' ai ', 'qr code']);
  add(work[1], ['งบประมาณ', 'การเงิน', 'การคลัง', 'เบิกจ่าย', 'ค่าใช้จ่าย']);
  add(work[2], ['พัสดุ', 'จัดซื้อ', 'จัดจ้าง', 'บุคคล', 'บุคลากร', 'แต่งตั้ง']);
  add(work[3], ['สารบรรณ', 'บริหารทั่วไป', 'รถยนต์ส่วนกลาง', 'ประชุม']);
  add(work[4], ['คุ้มครอง', 'ร้องเรียน', 'ละเมิดสิทธิ', 'ตรวจสอบสิทธิ']);
  add(work[5], ['ส่งเสริม']);
  add(work[6], ['เฝ้าระวัง', 'ชุมนุม']);
  add(work[7], ['ระหว่างประเทศ', 'international']);
  add(work[8], ['วิจัย', 'วิชาการ', 'km', 'องค์ความรู้']);
  if (!tags.length) tags.push(work[3]);
  return { category, tags: [...new Set(tags)] };
}
async function run() { const rows = await api('documents?select=id,external_key,title,content_text,document_type,metadata&limit=1000'); const counts = {}; for (const row of rows) { const result = classify(row); const metadata = { ...(row.metadata || {}), tags: result.tags, classification_source: 'rule-v1' }; await api(`documents?id=eq.${row.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ legal_category: result.category, work_category: result.tags[0], metadata }) }); db.prepare('UPDATE documents SET subcategory=? WHERE relative_path=?').run(result.category, row.external_key); counts[result.category || 'ไม่มีหมวดกฎหมาย'] = (counts[result.category || 'ไม่มีหมวดกฎหมาย'] || 0) + 1; } console.log(JSON.stringify({ documents: rows.length, categories: counts }, null, 2)); }
run().catch(error => { console.error(error.message); process.exitCode = 1; });
