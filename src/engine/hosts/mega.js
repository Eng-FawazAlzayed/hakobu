// MEGA without an account: file and folder links. MEGA encrypts every file with AES-128-CTR; the key is the part of the
// link after "#". Hakobu decrypts while it downloads, so any connection can start anywhere (CTR allows random access).
// Free downloads have a transfer quota per IP; when it runs out MEGA answers 509 and the queue waits (or uses another proxy route).
const crypto = require('crypto');
const { fetcher, hostIn, HostError } = require('./common');

const API = 'https://g.api.mega.co.nz/cs';

const b64url = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/,/g, ''), 'base64');
const words = buf => Array.from({ length: buf.length / 4 }, (_, i) => buf.readUInt32BE(i * 4));
const fromWords = ws => {
  const b = Buffer.alloc(ws.length * 4);
  ws.forEach((w, i) => b.writeUInt32BE(w >>> 0, i * 4));
  return b;
};

// A 32-byte file key -> AES key (16 bytes) + CTR nonce (8 bytes).
function fileKey(raw) {
  if (raw.length === 16) return { key: raw, nonce: Buffer.alloc(8) }; // folders
  if (raw.length !== 32) throw new HostError('MEGA: the key in this link is incomplete', { permanent: true });
  const k = words(raw);
  return { key: fromWords([k[0] ^ k[4], k[1] ^ k[5], k[2] ^ k[6], k[3] ^ k[7]]), nonce: fromWords([k[4], k[5]]) };
}

function aesEcbDecrypt(key, data) {
  const d = crypto.createDecipheriv('aes-128-ecb', key, null);
  d.setAutoPadding(false);
  return Buffer.concat([d.update(data), d.final()]);
}

// Attributes: AES-128-CBC, zero IV, "MEGA{json}" padded with zeros.
function decryptAttrs(at, key) {
  const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16));
  d.setAutoPadding(false);
  const buf = b64url(at);
  const plain = Buffer.concat([d.update(buf.subarray(0, buf.length - (buf.length % 16))), d.final()]).toString('utf8').replace(/\0+$/, '');
  if (!plain.startsWith('MEGA{')) throw new HostError('MEGA: wrong decryption key in this link', { permanent: true });
  return JSON.parse(plain.slice(4));
}

// Decrypts bytes that start at file offset `offset` (any offset, not just block-aligned).
function decryptAt(key, nonce, offset, buf) {
  const block = Math.floor(offset / 16);
  const iv = Buffer.alloc(16);
  nonce.copy(iv, 0);
  iv.writeBigUInt64BE(BigInt(block), 8);
  const d = crypto.createDecipheriv('aes-128-ctr', key, iv);
  const skip = offset % 16;
  if (skip) d.update(Buffer.alloc(skip));
  return d.update(buf);
}

function encryptForTest(key, nonce, data) {
  return decryptAt(key, nonce, 0, data); // CTR is symmetric
}

// Link forms: /file/ID#KEY, /#!ID!KEY, /folder/ID#KEY, /folder/ID#KEY/file/NODE, /#F!ID!KEY
function parseLink(url) {
  const u = String(url);
  let m = /\/(?:file|embed)\/([\w-]{8})#([\w-]{43})/.exec(u) || /#!([\w-]{8})!([\w-]{43})/.exec(u);
  if (m) return { type: 'file', id: m[1], key: m[2] };
  m = /\/folder\/([\w-]{8})#([\w-]{22})(?:\/(file|folder)\/([\w-]{8}))?/.exec(u);
  if (m) {
    if (m[3] === 'file') return { type: 'node', id: m[1], key: m[2], node: m[4] };
    return { type: 'folder', id: m[1], key: m[2], sub: m[4] || null };
  }
  m = /#F!([\w-]{8})!([\w-]{22})(?:!([\w-]{8}))?/.exec(u); // old form; a trailing node is a sub-folder (or a file)
  if (m) return { type: 'folder', id: m[1], key: m[2], sub: m[3] || null };
  return null;
}

let seq = Math.floor(Math.random() * 1e9);
async function api(ctx, cmds, folderId) {
  const url = `${API}?id=${seq++}${folderId ? `&n=${folderId}` : ''}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetcher(ctx)(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
    if (res.status === 509) throw quotaError();
    let data = await res.json().catch(() => null);
    if (typeof data === 'number') data = [data];
    const r = Array.isArray(data) ? data[0] : null;
    if (r === -3 && attempt < 4) {
      await new Promise(ok => setTimeout(ok, 800 * (attempt + 1))); // EAGAIN
      continue;
    }
    if (typeof r === 'number' && r < 0) throw apiError(r);
    if (!r) throw new Error(`MEGA API error (HTTP ${res.status})`);
    if (typeof r.e === 'number' && r.e < 0) throw apiError(r.e);
    return r;
  }
}

const quotaError = () => new HostError('MEGA transfer quota used up for your IP', { wait: 30 * 60000, ipLimit: true, hostWide: true });
function apiError(code) {
  if (code === -9 || code === -2) return new HostError('MEGA: file not found (deleted or wrong link)', { permanent: true });
  if (code === -16) return new HostError('MEGA: this file was taken down', { permanent: true });
  if (code === -11) return new HostError('MEGA: access denied to this link', { permanent: true });
  if (code === -17) return quotaError();
  if (code === -18) return new HostError('MEGA is temporarily unavailable', { wait: 5 * 60000 });
  return new Error(`MEGA API error ${code}`);
}

// Folder listings are fetched once per few minutes and shared by all files of that folder.
const folderCache = new Map();
async function listFolder(ctx, id, keyB64) {
  const hit = folderCache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60000) return hit.nodes;
  const master = b64url(keyB64);
  const r = await api(ctx, [{ a: 'f', c: 1, r: 1, ca: 1 }], id);
  const nodes = [];
  for (const n of r.f || []) {
    try {
      const enc = String(n.k || '').split('/').map(p => p.split(':')[1]).find(Boolean);
      if (!enc) continue;
      const raw = aesEcbDecrypt(master, b64url(enc));
      const { key } = fileKey(raw);
      const attrs = decryptAttrs(n.a, key);
      nodes.push({ h: n.h, p: n.p, t: n.t, s: n.s || 0, name: attrs.n || n.h, raw });
    } catch {}
  }
  folderCache.set(id, { at: Date.now(), nodes });
  return nodes;
}

// Folder -> one link per file, keeping the sub-folder path in the package name.
async function crawl(url, ctx) {
  const l = parseLink(url);
  if (!l || l.type !== 'folder') return null;
  const nodes = await listFolder(ctx, l.id, l.key);
  const byId = new Map(nodes.map(n => [n.h, n]));
  if (l.sub && byId.get(l.sub)?.t === 0) {
    const n = byId.get(l.sub);
    return { package: n.name, links: [{ source: `https://mega.nz/folder/${l.id}#${l.key}/file/${n.h}`, name: n.name, size: n.s }] };
  }
  const root = l.sub ? byId.get(l.sub) : nodes.find(n => n.t === 1 && !byId.has(n.p));
  const pathOf = n => {
    const parts = [];
    for (let p = byId.get(n.p); p && p !== root && parts.length < 20; p = byId.get(p.p)) parts.unshift(p.name);
    return parts;
  };
  const under = n => {
    for (let p = n; p; p = byId.get(p.p)) if (p === root) return true;
    return false;
  };
  const files = nodes.filter(n => n.t === 0 && (!root || under(n)));
  return {
    package: root?.name || 'MEGA folder',
    links: files.map(n => ({
      source: `https://mega.nz/folder/${l.id}#${l.key}/file/${n.h}`,
      name: n.name,
      size: n.s,
      subfolder: pathOf(n).join('/'),
    })),
  };
}

async function resolve(url, ctx) {
  const l = parseLink(url);
  if (!l) throw new HostError('MEGA: this link has no decryption key (the part after #)', { permanent: true });
  let r, raw, name;
  if (l.type === 'file') {
    raw = b64url(l.key);
    r = await api(ctx, [{ a: 'g', g: 1, p: l.id, ssl: 1 }]);
    name = decryptAttrs(r.at, fileKey(raw).key).n;
  } else if (l.type === 'node') {
    const node = (await listFolder(ctx, l.id, l.key)).find(n => n.h === l.node);
    if (!node) throw new HostError('MEGA: file not found in that folder', { permanent: true });
    raw = node.raw;
    name = node.name;
    r = await api(ctx, [{ a: 'g', g: 1, n: l.node, ssl: 1 }], l.id);
  } else throw new HostError('MEGA: this is a folder link; add it to LinkGrabber to list its files', { permanent: true });
  if (!r.g) {
    if (r.tl) throw new HostError('MEGA transfer quota used up for your IP', { wait: Math.max(60000, r.tl * 1000), ipLimit: true, hostWide: true });
    throw new HostError('MEGA did not hand out a download link', { wait: 5 * 60000 });
  }
  const { key, nonce } = fileKey(raw);
  return {
    url: r.g,
    headers: {},
    filename: name,
    size: r.s,
    maxConnections: 4,
    decrypt: (offset, buf) => decryptAt(key, nonce, offset, buf),
  };
}

async function check(url, ctx) {
  const l = parseLink(url);
  if (!l) return { status: 'offline', error: 'No decryption key in this MEGA link' };
  if (l.type === 'file') {
    const r = await api(ctx, [{ a: 'g', p: l.id }]);
    return { status: 'online', filename: decryptAttrs(r.at, fileKey(b64url(l.key)).key).n, size: r.s };
  }
  if (l.type === 'node') {
    const node = (await listFolder(ctx, l.id, l.key)).find(n => n.h === l.node);
    return node ? { status: 'online', filename: node.name, size: node.s } : { status: 'offline', error: 'Not in that folder' };
  }
  return null;
}

module.exports = {
  id: 'mega',
  name: 'MEGA',
  test: hostIn('mega.nz', 'mega.co.nz', 'mega.io'),
  free: true,
  maxDownloads: 2,
  isFolder: url => parseLink(url)?.type === 'folder',
  resolve,
  check,
  crawl,
  _test: { fileKey, decryptAt, decryptAttrs, parseLink, aesEcbDecrypt, encryptForTest, b64url },
};
