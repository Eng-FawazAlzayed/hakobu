// File verification after a download (JDownloader's CRC check): .sfv / .md5 / .sha1 / .sha256 files that come with a
// package, and hashes a file host reports for its files.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const ALGOS = { crc32: 8, md5: 32, sha1: 40, sha256: 64 };

// zlib.crc32 is in Node 22.2+ (Electron 32+); a table version keeps older runtimes working.
let crcTable = null;
function crc32Update(buf, crc) {
  if (zlib.crc32) return zlib.crc32(buf, crc);
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Streams the file once; onProgress(fraction) while it reads.
function hashFile(file, algo, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch (e) {
      return reject(e);
    }
    const h = algo === 'crc32' ? null : crypto.createHash(algo);
    let crc = 0;
    let read = 0;
    let last = 0;
    const s = fs.createReadStream(file, { highWaterMark: 1 << 20, signal });
    s.on('data', chunk => {
      if (h) h.update(chunk);
      else crc = crc32Update(chunk, crc);
      read += chunk.length;
      if (onProgress && Date.now() - last > 250) {
        last = Date.now();
        onProgress(size ? read / size : 0);
      }
    });
    s.on('error', reject);
    s.on('end', () => resolve(h ? h.digest('hex') : crc.toString(16).padStart(8, '0')));
  });
}

const HASH_FILE = /\.(sfv|md5|sha1|sha256)$/i;
const algoOfFile = name => ({ sfv: 'crc32', md5: 'md5', sha1: 'sha1', sha256: 'sha256' })[path.extname(name).slice(1).toLowerCase()] || null;

// SFV: "name CRC32" (";" comments). md5sum / sha*sum: "hash *name" or "hash  name". Some tools write "name hash".
function parseHashFile(text, algo) {
  const len = ALGOS[algo];
  const out = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const hex = `[0-9a-fA-F]{${len}}`;
    let m = new RegExp(`^(${hex})\\s+\\*?(.+)$`).exec(line);
    if (m) {
      out.set(baseName(m[2]), m[1].toLowerCase());
      continue;
    }
    m = new RegExp(`^(.+?)\\s+(${hex})$`).exec(line);
    if (m) out.set(baseName(m[1]), m[2].toLowerCase());
  }
  return out;
}

const baseName = p => String(p).trim().replace(/^\*/, '').split(/[\\/]/).pop().toLowerCase();

// Hashes a host reports look like { algo: 'sha256', value }. Returns null if it's not a known algorithm.
function normalizeHash(h) {
  if (!h || !h.value) return null;
  const algo = String(h.algo || '').toLowerCase().replace('-', '');
  if (!ALGOS[algo]) return null;
  const value = String(h.value).toLowerCase();
  return value.length === ALGOS[algo] ? { algo, value } : null;
}

// Expected hashes for the files of a package, read from the hash files among them (in dir).
function expectedFromHashFiles(dir, names) {
  const want = new Map();
  for (const n of names.filter(n => HASH_FILE.test(n))) {
    const algo = algoOfFile(n);
    try {
      const map = parseHashFile(fs.readFileSync(path.join(dir, n), 'utf8'), algo);
      for (const [file, value] of map) if (!want.has(file)) want.set(file, { algo, value, from: n });
    } catch {}
  }
  return want;
}

module.exports = { hashFile, parseHashFile, normalizeHash, expectedFromHashFiles, crc32Update, HASH_FILE };
