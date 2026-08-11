const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = __dirname.replace(/\\scripts$/, '');
const python = process.env.PYTHON_BIN || 'C:\\Users\\tongd\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe';

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '.git', '.codex', '.agents', 'data'].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const code = "from pypdf import PdfReader; import sys; r=PdfReader(sys.argv[1]); pages=len(r.pages); lengths=[len((p.extract_text() or '').strip()) for p in r.pages[:10]]; print(f'{pages}|{sum(lengths)}|{sum(1 for x in lengths if x>30)}')";
const rows = walk(root).filter(file => /\.pdf$/i.test(file)).map(file => {
  try {
    const [pages, firstTextChars, pagesWithText] = execFileSync(python, ['-c', code, file], { timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('|').map(Number);
    return { file: path.relative(root, file).replace(/\\/g, '/'), pages, firstTextChars, pagesWithText, needsOcr: firstTextChars < 150 || pagesWithText === 0 };
  } catch (error) { return { file: path.relative(root, file).replace(/\\/g, '/'), error: error.message, needsOcr: true }; }
});
console.log(JSON.stringify({ checked: rows.length, needsOcr: rows.filter(row => row.needsOcr).length, rows }, null, 2));
