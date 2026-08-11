const fs = require('fs');
const path = require('path');

const env = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
    .split(/\r?\n/)
    .filter(line => line.includes('='))
    .map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1).trim()]; }),
);

(async () => {
  for (const table of ['documents', 'document_chunks']) {
    const filter = table === 'document_chunks' ? '&embedding=not.is.null' : '';
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?select=id&limit=1${filter}`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'count=exact',
      },
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`${table}: ${response.status} ${body}`);
    const range = response.headers.get('content-range') || '';
    console.log(JSON.stringify({ table, status: response.status, count: range.split('/')[1] || 'unknown', sampleRows: body ? JSON.parse(body).length : 0 }));
  }
  const missing = await fetch(`${env.SUPABASE_URL}/rest/v1/document_chunks?select=id&embedding=is.null&limit=1`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, Prefer: 'count=exact' } });
  await missing.text();
  console.log(JSON.stringify({ table: 'document_chunks', missingEmbeddings: (missing.headers.get('content-range') || '').split('/')[1] || 'unknown' }));
  const storage = await fetch(`${env.SUPABASE_URL}/storage/v1/object/list/reference-documents`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: 'documents', limit: 1000, offset: 0 }),
  });
  const storageBody = await storage.text();
  if (!storage.ok) throw new Error(`storage: ${storage.status} ${storageBody}`);
  console.log(JSON.stringify({ table: 'storage.reference-documents', status: storage.status, files: storageBody ? JSON.parse(storageBody).length : 0 }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
