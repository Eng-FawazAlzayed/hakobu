const fs = require('fs');
const path = require('path');

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(abortError());
    }, { once: true });
  });

function abortError() {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

// Windows-safe file name.
function sanitize(name) {
  const clean = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 200);
  return clean || 'download';
}

// Pick "name (1).ext" if "name.ext" (or its .part) already exists.
function uniqueName(dir, name, taken = new Set()) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 1; ; i++) {
    const full = path.join(dir, candidate);
    if (!taken.has(full.toLowerCase()) && !fs.existsSync(full) && !fs.existsSync(full + '.part')) return candidate;
    candidate = `${base} (${i})${ext}`;
  }
}

// Join that refuses to escape the base directory (names can come from torrents / servers).
function safeJoin(base, name) {
  const root = path.resolve(base);
  const full = path.resolve(root, name);
  if (full !== root && full.startsWith(root + path.sep)) return full;
  throw new Error(`Refusing path outside download folder: ${name}`);
}

module.exports = { sleep, abortError, sanitize, uniqueName, safeJoin };
