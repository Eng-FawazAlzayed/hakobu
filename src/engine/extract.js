// Archive auto-extraction: ZIP/7z/TAR (and split .001 sets) via bundled 7-Zip, RAR (incl. multi-volume, RAR5) via unrar WASM.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn, fork } = require('child_process');

// 7za.exe must run from outside app.asar in a packaged build.
const path7za = () => require('7zip-bin').path7za.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);

// Is this file the first volume of an archive (the one to open)?
function isFirstVolume(name) {
  const n = name.toLowerCase();
  if (/\.part0*1\.rar$/.test(n)) return true;
  if (/\.part\d+\.rar$/.test(n)) return false;
  if (/\.rar$/.test(n)) return true;
  if (/\.(7z|zip)\.0*1$/.test(n)) return true;
  if (/\.(7z|zip)\.\d+$/.test(n)) return false;
  return /\.(zip|7z|tar|tgz|tar\.gz|tar\.xz)$/.test(n);
}

// All files on disk that belong to the archive set starting at `first`.
function volumesOf(first, siblings) {
  const base = path.basename(first);
  const lower = base.toLowerCase();
  let re;
  if (/\.part\d+\.rar$/i.test(lower)) re = new RegExp('^' + escape(base.replace(/\.part\d+\.rar$/i, '')) + '\\.part\\d+\\.rar$', 'i');
  else if (/\.rar$/i.test(lower)) re = new RegExp('^' + escape(base.replace(/\.rar$/i, '')) + '\\.(rar|r\\d{2})$', 'i');
  else if (/\.\d+$/.test(lower)) re = new RegExp('^' + escape(base.replace(/\.\d+$/, '')) + '\\.\\d+$', 'i');
  else return [first];
  return siblings.filter(f => re.test(f)).map(f => path.join(path.dirname(first), f));
}
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class PasswordError extends Error {}

function run7z(file, dest, password, onProgress) {
  return new Promise((resolve, reject) => {
    // -p always given so 7-Zip never waits for a typed password; -bsp1 streams percentages.
    const p = spawn(path7za(), ['x', '-y', '-bsp1', '-bso0', `-o${dest}`, `-p${password}`, file], { windowsHide: true });
    let err = '';
    p.stdout.on('data', d => {
      const m = /(\d+)%/.exec(String(d));
      if (m) onProgress?.(Number(m[1]) / 100);
    });
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) return resolve();
      if (/wrong password|can not open encrypted|data error in encrypted/i.test(err)) return reject(new PasswordError('Wrong password'));
      reject(new Error(err.trim().split(/\r?\n/).pop() || `7-Zip exited with ${code}`));
    });
  });
}

function runUnrar(file, dest, password, onProgress) {
  return new Promise((resolve, reject) => {
    // Electron's fork runs the script with its own Node (ELECTRON_RUN_AS_NODE) and can read it from app.asar.
    const child = fork(path.join(__dirname, 'unrar-worker.js'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let settled = false;
    let stderr = '';
    const finish = (err) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve();
    };
    child.stderr?.on('data', d => (stderr = (stderr + d).slice(-2000)));
    child.on('message', m => {
      if (m?.type === 'progress') onProgress?.(m.value);
      else if (m?.type === 'done') finish();
      else if (m?.type === 'error') finish(m.password ? new PasswordError(m.message) : new Error(m.message));
    });
    child.on('error', e => finish(e));
    child.on('exit', code => finish(code === 0 ? null : new Error(stderr.trim().split(/\r?\n/).pop() || `RAR extraction stopped (exit ${code})`)));
    child.send({ file, dest, password });
  });
}

// Extract one archive, trying each password. Returns the password that worked.
async function extractArchive(file, { dest, passwords = [], onProgress }) {
  await fsp.mkdir(dest, { recursive: true });
  const isRar = /\.rar$/i.test(file);
  const tries = ['', ...passwords.filter(Boolean)];
  let lastPwErr = null;
  for (const pw of [...new Set(tries)]) {
    try {
      if (isRar) await runUnrar(file, dest, pw, onProgress);
      else await run7z(file, dest, pw, onProgress);
      return pw;
    } catch (e) {
      if (!(e instanceof PasswordError)) throw e;
      lastPwErr = e;
    }
  }
  throw new PasswordError(lastPwErr?.message === 'Password required' || passwords.length ? 'No password in your list worked' : 'Archive is password protected');
}

// Extract every archive among `names` (files inside `dir`).
// opts: { subfolder, deleteAfter, passwords, onState(name, state) }
async function extractAll(dir, names, opts = {}) {
  const firsts = names.filter(isFirstVolume);
  const results = [];
  const siblings = fs.existsSync(dir) ? await fsp.readdir(dir) : [];
  for (const name of firsts) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const stem = path.basename(name).replace(/(\.part\d+)?\.(rar|zip|7z|tar|tgz|tar\.gz|tar\.xz)(\.\d+)?$/i, '').replace(/\.(7z|zip)\.\d+$/i, '');
    const dest = opts.subfolder ? path.join(dir, path.dirname(name), stem) : path.join(dir, path.dirname(name));
    opts.onState?.(name, { state: 'extracting', progress: 0 });
    try {
      const pw = await extractArchive(file, { dest, passwords: opts.passwords, onProgress: p => opts.onState?.(name, { state: 'extracting', progress: p }) });
      if (opts.deleteAfter) for (const v of volumesOf(file, siblings)) await fsp.rm(v, { force: true });
      opts.onState?.(name, { state: 'done', progress: 1, dest, password: pw || null });
      results.push({ name, ok: true, dest });
    } catch (e) {
      opts.onState?.(name, { state: e instanceof PasswordError ? 'password' : 'error', error: e.message });
      results.push({ name, ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = { extractAll, extractArchive, isFirstVolume, volumesOf, PasswordError, path7za };
