// NSIS can't handle paths over 260 chars, so build from a short temp copy and bring the EXEs back.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const work = path.join(os.tmpdir(), 'hakobu-build');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
for (const p of ['package.json', 'package-lock.json', 'src', 'build', 'node_modules', 'extension']) {
  fs.cpSync(path.join(root, p), path.join(work, p), { recursive: true });
}
execSync('npx electron-builder --win', { cwd: work, stdio: 'inherit' });
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
for (const f of fs.readdirSync(path.join(work, 'dist')).filter(f => f.endsWith('.exe'))) {
  fs.copyFileSync(path.join(work, 'dist', f), path.join(root, 'dist', f));
  console.log('built dist/' + f);
}
