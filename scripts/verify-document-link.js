(async () => {
  const docs = await (await fetch('http://localhost:3033/api/documents')).json();
  const id = docs.documents[0].id;
  const response = await fetch(`http://localhost:3033/api/documents/${id}/file`, { redirect: 'manual' });
  console.log(JSON.stringify({ status: response.status, documentId: id, location: response.headers.get('location'), contentType: response.headers.get('content-type') }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
