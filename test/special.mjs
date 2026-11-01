// Host special cases: waits, retries, mirrors, hash checks, per-host limits, chunk splitting, disk space,
// "file exists", MEGA-style decryption, proxies, and the link crawler (DLC, folder listings, protectors). All offline.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HttpTask, RateLimiter } = require('../src/engine/http.js');
const { Manager } = require('../src/engine/manager.js');
const { HostError, retryAfterMs } = require('../src/engine/errors.js');
const netLayer = require('../src/engine/net.js');
const { parseHashFile, hashFile } = require('../src/engine/verify.js');
const crawler = require('../src/engine/crawler.js');
const { checkLink } = require('../src/engine/linkcheck.js');
const mega = require('../src/engine/hosts/mega.js');
const gdrive = require('../src/engine/hosts/gdrive.js');
const mediafire = require('../src/engine/hosts/mediafire.js');
const onefichier = require('../src/engine/hosts/onefichier.js');
const { resolverFor, setAccounts, isFolderLink } = require('../src/engine/resolvers.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakobu-special-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const ok = msg => console.log('  ✓', msg);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const md5 = b => crypto.createHash('md5').update(b).digest('hex');
const until = async (fn, ms = 10000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await wait(20);
  }
};

// A test server: GET /<name> serves files[name] with ranges; per-path behaviour can be overridden.
const payload = crypto.randomBytes(12 * 1024 * 1024 + 12345);
const files = { 'a.bin': payload, 'b.bin': crypto.randomBytes(300000), 'c.bin': crypto.randomBytes(200000) };
const handlers = {};
let hits = {};
const srv = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0].slice(1));
  hits[p] = (hits[p] || 0) + 1;
  if (handlers[p]) return handlers[p](req, res);
  const body = files[p];
  if (!body) {
    res.writeHead(404);
    return res.end();
  }
  serveRange(req, res, body);
});
function serveRange(req, res, body, { delay = 0 } = {}) {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (!m) {
    res.writeHead(200, { 'content-length': body.length, 'content-type': 'application/octet-stream' });
    return res.end(body);
  }
  const start = +m[1];
  const end = m[2] ? Math.min(+m[2], body.length - 1) : body.length - 1;
  res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': end - start + 1, 'content-type': 'application/octet-stream' });
  if (!delay) return res.end(body.subarray(start, end + 1));
  let at = start;
  const iv = setInterval(() => {
    if (at > end) return clearInterval(iv), res.end();
    const n = Math.min(64 * 1024, end - at + 1);
    res.write(body.subarray(at, at + n));
    at += n;
  }, delay);
  res.on('close', () => clearInterval(iv));
}
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const limiter = new RateLimiter();
const newManager = (settings = {}) => {
  const m = new Manager({ statePath: null, settings: { downloadDir: path.join(tmp, 'mgr'), autoRetries: 0, ...settings } });
  m.applySettings({});
  return m;
};

// ---- 1. Retry-After: the task stops at once, the queue waits, and the whole host waits ----
{
  assert.equal(retryAfterMs('120'), 120000);
  assert.ok(Math.abs(retryAfterMs(new Date(Date.now() + 60000).toUTCString()) - 60000) < 2000);
  handlers['busy.bin'] = (req, res) => {
    res.writeHead(429, { 'retry-after': '90' });
    res.end();
  };
  const it = { source: `${base}/busy.bin`, dir: path.join(tmp, 'r1') };
  const t0 = Date.now();
  await assert.rejects(new HttpTask(it, { limiter, taken: new Set() }).run(), e => e instanceof HostError && e.wait === 90000 && e.hostWide);
  assert.ok(Date.now() - t0 < 2000, 'no retry loop against a host that said wait');
  const m = newManager();
  const [a] = m.add([{ kind: 'http', source: `${base}/busy.bin`, via: 'direct' }]);
  await until(() => a.status === 'waiting');
  assert.ok(a.waitUntil - Date.now() > 80000 && /too many requests/.test(a.error));
  // b is from the same host: it waits too instead of hitting the host.
  hits = {};
  const [b] = m.add([{ kind: 'http', source: `${base}/b.bin`, via: 'direct' }]);
  await until(() => b.status === 'waiting');
  assert.ok(!hits['b.bin'], 'the host was not contacted');
  assert.match(b.error, /Waiting for 127\.0\.0\.1/);
  // Pressing play starts it now; the host wait is lifted.
  delete handlers['busy.bin'];
  files['busy.bin'] = files['c.bin'];
  m.resume(a.id);
  await until(() => a.status === 'completed');
  m.resume(b.id);
  await until(() => b.status === 'completed');
  ok('HTTP 429 + Retry-After → no hammering, "waiting" with the host\'s time, the host waits as a whole, play = try now');
}

// ---- 2. connection problems retry later (autoRetries), a waiting item wakes up on its own ----
{
  let fails = 2;
  handlers['flaky.bin'] = (req, res) => {
    if (fails-- > 0) {
      res.writeHead(500);
      return res.end();
    }
    serveRange(req, res, files['c.bin']);
  };
  const m = newManager({ autoRetries: 3 });
  const [it] = m.add([{ kind: 'http', source: `${base}/flaky.bin`, via: 'direct' }]);
  await until(() => it.status === 'waiting', 30000);
  assert.equal(it.retries, 1);
  assert.match(it.error, /Try 2 of 4 in 1 min/);
  const t0 = Date.now();
  while (it.status !== 'completed') {
    if (it.status === 'waiting') {
      it.waitUntil = Date.now() - 1; // fast-forward the wait
      m.tick();
    }
    assert.notEqual(it.status, 'error', it.error);
    assert.ok(Date.now() - t0 < 30000, 'finished');
    await wait(20);
  }
  assert.equal(it.retries, 0, 'reset after success');
  assert.equal(sha(fs.readFileSync(path.join(it.dir, it.filename))), sha(files['c.bin']));
  ok('server errors → retried after a wait (1, 5, 15 min), wakes up by itself, finishes intact');
}

// ---- 3. a free connection splits the slowest segment ----
{
  handlers['slow.bin'] = (req, res) => {
    const start = +(/bytes=(\d+)/.exec(req.headers.range || 'bytes=0')[1]);
    // The first half arrives at once, the rest crawls. (A 1 ms timer ticks every ~15 ms on Windows, which made the
    // "fast" half slow enough that the other one dropped below the split threshold.)
    serveRange(req, res, payload, { delay: start === 0 ? 0 : 25 });
  };
  const it = { source: `${base}/slow.bin`, dir: path.join(tmp, 'split') };
  await new HttpTask(it, { limiter, connections: 2, taken: new Set() }).run();
  assert.ok(it.segments.length > 2, `segments were split (${it.segments.length})`);
  assert.equal(sha(fs.readFileSync(path.join(it.dir, it.filename))), sha(payload));
  assert.equal(it.downloaded, payload.length, 'no byte counted twice');
  ok(`dynamic chunk splitting: 2 connections became ${it.segments.length} segments, file intact`);
}

// ---- 4. MEGA-style decryption while downloading (AES-CTR from any offset) ----
{
  const raw = crypto.randomBytes(32);
  const { key, nonce } = mega._test.fileKey(raw);
  const plain = crypto.randomBytes(5 * 1024 * 1024 + 77);
  files['enc.bin'] = mega._test.encryptForTest(key, nonce, plain);
  const it = { source: 'https://mega.example/file/x', dir: path.join(tmp, 'mega'), suggestedName: 'plain.bin' };
  const resolve = async () => ({ url: `${base}/enc.bin`, headers: {}, decrypt: (o, b) => mega._test.decryptAt(key, nonce, o, b) });
  await new HttpTask(it, { limiter, connections: 4, resolve, taken: new Set() }).run();
  assert.equal(sha(fs.readFileSync(path.join(it.dir, 'plain.bin'))), sha(plain));
  ok('encrypted download over 4 connections decrypts to the original file');
}

// ---- 5. disk space and "file already exists" ----
{
  const it = { source: `${base}/b.bin`, dir: path.join(tmp, 'disk') };
  await assert.rejects(new HttpTask(it, { limiter, taken: new Set(), freeSpace: async () => 1000 }).run(), e => e.diskFull && e.wait > 0);
  const dir = path.join(tmp, 'exists');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'b.bin'), files['b.bin']);
  const skip = { source: `${base}/b.bin`, dir };
  hits = {};
  await new HttpTask(skip, { limiter, taken: new Set(), exists: 'skip' }).run();
  assert.ok(skip.skipped && skip.filename === 'b.bin' && (hits['b.bin'] || 0) <= 1, 'same size: skipped, nothing downloaded');
  fs.writeFileSync(path.join(dir, 'c.bin'), 'old');
  const over = { source: `${base}/c.bin`, dir };
  await new HttpTask(over, { limiter, taken: new Set(), exists: 'overwrite' }).run();
  assert.equal(over.filename, 'c.bin');
  assert.equal(sha(fs.readFileSync(path.join(dir, 'c.bin'))), sha(files['c.bin']));
  const ren = { source: `${base}/c.bin`, dir };
  await new HttpTask(ren, { limiter, taken: new Set(), exists: 'rename' }).run();
  assert.equal(ren.filename, 'c (1).bin');
  // An empty file can't send byte 0 (Google Drive answers 416 to the range probe): it still downloads.
  handlers['empty.txt'] = (req, res) => {
    if (req.headers.range) {
      res.writeHead(416, { 'content-type': 'text/html', 'content-range': 'bytes */0' });
      return res.end('<html>416</html>');
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 0 });
    res.end();
  };
  const empty = { source: `${base}/empty.txt`, dir: path.join(tmp, 'empty') };
  await new HttpTask(empty, { limiter, taken: new Set() }).run();
  assert.equal(fs.statSync(path.join(empty.dir, empty.filename)).size, 0);
  ok('not enough disk space → wait and retry; file exists → skip (same size) / overwrite / keep both; empty files download');
}

// ---- 6. hash checks: .md5 in the package, a damaged file is downloaded again once ----
{
  assert.deepEqual([...parseHashFile('; comment\nAbC.part1.rar 1A2B3C4D\n', 'crc32')], [['abc.part1.rar', '1a2b3c4d']]);
  assert.deepEqual([...parseHashFile(`${'f'.repeat(32)} *Sub\\Game.bin\n${'e'.repeat(32)}  x.bin`, 'md5')], [['game.bin', 'f'.repeat(32)], ['x.bin', 'e'.repeat(32)]]);
  const crcFile = path.join(tmp, 'crc.bin');
  fs.writeFileSync(crcFile, 'The quick brown fox jumps over the lazy dog');
  assert.equal(await hashFile(crcFile, 'crc32'), '414fa339');
  let corrupt = 1;
  const junk = crypto.randomBytes(files['b.bin'].length);
  handlers['pkg/game.bin'] = (req, res) => {
    const probe = req.headers.range === 'bytes=0-0';
    serveRange(req, res, corrupt > 0 ? junk : files['b.bin']);
    if (!probe && corrupt > 0) res.on('finish', () => corrupt--); // the first full download is damaged
  };
  files['pkg/game.md5'] = Buffer.from(`${md5(files['b.bin'])} *game.bin\n`);
  const m = newManager({ verifyHashes: true, redownloadBad: true });
  const dir = path.join(tmp, 'hash');
  const bad = [];
  m.on('hashBad', (_it, why) => bad.push(why));
  const [g] = m.add([
    { kind: 'http', source: `${base}/pkg/game.bin`, via: 'direct', package: 'Game', dir },
    { kind: 'http', source: `${base}/pkg/game.md5`, via: 'direct', package: 'Game', dir },
  ]);
  await until(() => g.hash?.state === 'ok', 20000);
  assert.equal(bad.length, 1, 'one mismatch reported');
  assert.equal(sha(fs.readFileSync(path.join(dir, 'game.bin'))), sha(files['b.bin']));
  // a host-reported hash that never matches → error after one retry
  const m2 = newManager({ verifyHashes: true, redownloadBad: true });
  const [h] = m2.add([{ kind: 'http', source: `${base}/c.bin`, via: 'direct', dir: path.join(tmp, 'hash2'), hash: { algo: 'sha256', value: 'a'.repeat(64) } }]);
  await until(() => h.status === 'error', 20000);
  assert.match(h.error, /Damaged download: SHA256/);
  ok('.md5 in the package catches a damaged file → downloaded again → MD5 ok; a host hash that never matches → "damaged"');
}

// ---- 7. mirrors: the first host fails, the next one takes over ----
{
  const m = newManager();
  const switched = [];
  m.on('mirror', (_it, x) => switched.push(x));
  const [it] = m.add([{ kind: 'http', source: `${base}/gone.bin`, via: 'direct', mirrors: [`http://localhost:${srv.address().port}/b.bin`], dir: path.join(tmp, 'mirror') }]);
  await until(() => it.status === 'completed' || it.status === 'error', 20000);
  assert.equal(it.status, 'completed', it.error);
  assert.equal(switched.length, 1);
  assert.deepEqual(it.triedMirrors, [`${base}/gone.bin`]);
  assert.equal(sha(fs.readFileSync(path.join(it.dir, it.filename))), sha(files['b.bin']));
  ok('404 on the first host → switched to the mirror → finished');
}

// ---- 8. per-host limits ----
{
  for (const n of ['l1', 'l2', 'l3']) handlers[n + '.bin'] = (req, res) => serveRange(req, res, files['b.bin'], { delay: 30 });
  const m = newManager({ maxConcurrent: 5, hostLimits: { '127.0.0.1': { downloads: 1, connections: 1 } } });
  const list = m.add(['l1', 'l2', 'l3'].map(n => ({ kind: 'http', source: `${base}/${n}.bin`, via: 'direct', dir: path.join(tmp, 'limit') })));
  let maxActive = 0;
  while (!list.every(i => i.status === 'completed')) {
    maxActive = Math.max(maxActive, list.filter(i => i.status === 'active').length);
    for (const i of list) if (i.segments) assert.ok(i.segments.length <= 1, 'one connection');
    await wait(15);
  }
  assert.equal(maxActive, 1);
  ok('host limit: 1 download and 1 connection at a time for that host');
}

// ---- 9. proxies: "always" proxies carry traffic, "rotate" ones are extra routes ----
{
  let proxied = 0;
  const proxy = http.createServer((req, res) => {
    proxied++;
    const u = new URL(req.url);
    const up = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers }, r => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    req.pipe(up);
  });
  proxy.on('connect', (req, sock, head) => {
    proxied++;
    const [h, p] = req.url.split(':');
    const up = net.connect(+p, h, () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const purl = `http://127.0.0.1:${proxy.address().port}`;
  netLayer.configure([{ url: purl, hosts: '', mode: 'rotate' }]);
  assert.equal(netLayer.routeCount(`${base}/x`), 2, 'direct + 1 rotate proxy');
  assert.equal(netLayer.routeLabel(`${base}/x`, 1), new URL(purl).host);
  netLayer.configure([{ url: purl, hosts: '127.0.0.1', mode: 'always' }, { url: purl, hosts: 'other.example', mode: 'always' }]);
  assert.equal(netLayer.routeCount(`${base}/x`), 1);
  const it = { source: `${base}/c.bin`, dir: path.join(tmp, 'proxy') };
  await new HttpTask(it, { limiter, taken: new Set() }).run();
  assert.ok(proxied >= 1, 'requests went through the proxy');
  assert.equal(sha(fs.readFileSync(path.join(it.dir, it.filename))), sha(files['c.bin']));
  // an IP limit moves the download to the next route instead of waiting
  netLayer.configure([]);
  const m = newManager({ proxies: [{ url: purl, hosts: '', mode: 'rotate' }] });
  let n = 0;
  handlers['iplimit.bin'] = (req, res) => {
    if (n++ === 0) {
      res.writeHead(509);
      return res.end();
    }
    serveRange(req, res, files['c.bin']);
  };
  proxied = 0;
  const [r] = m.add([{ kind: 'http', source: `${base}/iplimit.bin`, via: 'direct', dir: path.join(tmp, 'proxy2') }]);
  await until(() => r.status === 'completed' || r.status === 'waiting', 20000);
  assert.equal(r.status, 'completed', r.error);
  assert.equal(r.route, 1);
  assert.ok(proxied > 0, 'second try used the proxy');
  // SOCKS5 (no auth): a minimal server that tunnels to the target
  let socksed = 0;
  const socks = net.createServer(sock => {
    sock.once('data', () => {
      sock.write(Buffer.from([5, 0]));
      sock.once('data', req => {
        socksed++;
        let host, at;
        if (req[3] === 1) (host = [...req.subarray(4, 8)].join('.')), (at = 8);
        else (host = req.subarray(5, 5 + req[4]).toString()), (at = 5 + req[4]);
        const port = req.readUInt16BE(at);
        const up = net.connect(port, host, () => {
          sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          up.pipe(sock);
          sock.pipe(up);
        });
        up.on('error', () => sock.destroy());
        sock.on('error', () => up.destroy());
      });
    });
  });
  await new Promise(r => socks.listen(0, '127.0.0.1', r));
  netLayer.configure([{ url: `socks5://127.0.0.1:${socks.address().port}`, mode: 'always' }]);
  const sx = { source: `${base}/b.bin`, dir: path.join(tmp, 'socks') };
  await new HttpTask(sx, { limiter, taken: new Set() }).run();
  assert.ok(socksed >= 1, 'went through SOCKS5');
  assert.equal(sha(fs.readFileSync(path.join(sx.dir, sx.filename))), sha(files['b.bin']));
  socks.close();
  netLayer.configure([]);
  proxy.close();
  ok('HTTP and SOCKS5 proxies carry the traffic; a 509 "bandwidth limit" moves the download to a proxy route instead of waiting');
}

// ---- 10. link crawler: DLC, web folder listings, protectors, folder-link detection ----
{
  const b = s => Buffer.from(s).toString('base64');
  const xml = `<dlc><content><package name="${b('Game Pack')}"><file><url>${b('https://rapidgator.net/file/abc/g.part1.rar.html')}</url><filename>${b('g.part1.rar')}</filename></file><file><url>${b(`${base}/b.bin`)}</url></file></package></content></dlc>`;
  const key = crypto.randomBytes(16);
  const rc = crawler._test.rcForKey(key);
  const dlcKey = 'Q'.repeat(88);
  const dlc = crawler._test.encryptDlcForTest(xml, rc, dlcKey);
  const out = await crawler.decryptDlc(dlc, { keyFetcher: async k => (assert.equal(k, dlcKey), rc) });
  assert.equal(out.package, 'Game Pack');
  assert.deepEqual(out.links.map(l => l.source), ['https://rapidgator.net/file/abc/g.part1.rar.html', `${base}/b.bin`]);

  handlers['pub/'] = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>Index of /pub</title></head><body><a href="../">Parent</a><a href="sub/">sub/</a><a href="b.bin">b.bin</a><a href="c%20d.iso">c d.iso</a><a href="?C=M">sort</a></body></html>');
  };
  const c = await checkLink(`${base}/pub/`);
  assert.equal(c.status, 'folder');
  assert.equal(c.package, 'pub');
  assert.deepEqual(c.links.map(l => l.name), ['b.bin', 'c d.iso']);
  const p = await checkLink('https://filecrypt.cc/Container/ABCDEF.html');
  assert.equal(p.status, 'protected');
  assert.ok(isFolderLink('https://mega.nz/folder/AbCdEfGh#' + 'C'.repeat(22)));
  assert.ok(isFolderLink('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp'));
  assert.ok(isFolderLink('https://gofile.io/d/AbC123'));
  // Gofile: no token -> the browser, without contacting Gofile; a saved token reaches the folder crawl.
  assert.equal(resolverFor('https://gofile.io/d/AbC123'), null);
  const noToken = await checkLink('https://gofile.io/d/AbC123');
  assert.equal(noToken.status, 'browser');
  assert.match(noToken.error, /premium token/);
  {
    const realFetch = globalThis.fetch;
    let auth = null;
    globalThis.fetch = async (u, o) => {
      auth = o.headers.Authorization;
      return new Response(JSON.stringify({ status: 'ok', data: { type: 'folder', name: 'F', children: {} } }));
    };
    setAccounts({ gofile: { token: 'tok123' } });
    const listed = await crawler.crawl('https://gofile.io/d/AbC123');
    setAccounts({});
    globalThis.fetch = realFetch;
    assert.equal(auth, 'Bearer tok123');
    assert.equal(listed.package, 'F');
  }
  assert.ok(isFolderLink('https://pixeldrain.com/l/AbC123'));
  assert.ok(isFolderLink('https://www.mediafire.com/folder/abc123def/Stuff'));
  assert.ok(!isFolderLink('https://mega.nz/file/AbCdEfGh#' + 'A'.repeat(43)));
  // A paste page (rentry's layout): only the entry's links, with hrefs kept, not the site menu or scripts.
  const pasteHtml = '<nav><a href="https://twitter.com/site">x</a></nav><div class="entry-text"><article><p>Part 1: <a href="https://example.com/a.rar">mirror</a></p><script>var u="https://evil.example/x"</script></article></div>';
  const pt = crawler._test.pasteText(pasteHtml);
  assert.match(pt, /https:\/\/example\.com\/a\.rar/);
  assert.doesNotMatch(pt, /twitter|evil/);
  ok('DLC container decrypts to its links + package; "Index of" pages list their files; filecrypt = protected; folder links recognised; paste pages read from their content');
}

// ---- 11. host page parsers (what the live sites send) ----
{
  const warn = '<form id="download-form" action="https://drive.usercontent.google.com/download" method="get"><input type="submit" value="Download anyway"/><input type="hidden" name="id" value="1AbC"><input type="hidden" name="export" value="download"><input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-1"></form>';
  assert.equal(gdrive._test.confirmUrl(warn), 'https://drive.usercontent.google.com/download?id=1AbC&export=download&confirm=t&uuid=u-1');
  assert.ok(gdrive._test.pageError('<p>Too many users have viewed or downloaded this file recently.</p>').wait > 0);
  const folder = '<title>My Folder - Google Drive</title><div class="flip-entry" id="entry-1FileAAAAAAAA" tabindex="0"><div class="flip-entry-info"><a href="https://drive.google.com/file/d/1FileAAAAAAAA/view?usp=drive_web" target="_blank"><div class="flip-entry-title">a.rar</div></a></div></div><div class="flip-entry" id="entry-1DirBBBBBBBBB"><a href="https://drive.google.com/drive/folders/1DirBBBBBBBBB"><div class="flip-entry-title">Sub</div></a></div>';
  const f = gdrive._test.parseFolder(folder);
  assert.equal(f.title, 'My Folder');
  assert.deepEqual(f.files, [{ id: '1FileAAAAAAAA', name: 'a.rar', doc: null }]);
  assert.deepEqual(f.folders, [{ id: '1DirBBBBBBBBB', name: 'Sub', doc: null }]);
  // Google Docs in a folder (as the live folder view lists them) are exported as Office files.
  const docs = gdrive._test.parseFolder('<div class="flip-entry" id="entry-1DocCCCCCCCCC" tabindex="0" role="link"><div class="flip-entry-info"><a href="https://docs.google.com/document/d/1DocCCCCCCCCC/edit?usp=drive_web" target="_blank"><div class="flip-entry-title">notes</div></a></div></div>');
  assert.deepEqual(docs.files[0].doc, { kind: 'document', id: '1DocCCCCCCCCC', format: 'docx' });
  assert.equal(gdrive._test.docOf('https://docs.google.com/spreadsheets/d/1SheetDDDDDDD/edit#gid=0').format, 'xlsx');
  assert.ok(isFolderLink('https://drive.google.com/drive/folders/1DirBBBBBBBBB') && !isFolderLink('https://docs.google.com/document/d/1DocCCCCCCCCC/edit'));
  assert.equal(gdrive._test.fileId('https://drive.google.com/file/d/1AbCdEfGhIjK/view?usp=sharing'), '1AbCdEfGhIjK');
  assert.equal(mediafire._test.linkFromPage('<a class="input popsok" aria-label="Download file" href="https://download2391.mediafire.com/abc/x.zip" id="downloadButton">'), 'https://download2391.mediafire.com/abc/x.zip');
  assert.equal(mediafire._test.linkFromPage(`<a id="downloadButton" data-scrambled-url="${Buffer.from('https://download1.mediafire.com/q/y.7z').toString('base64')}">`), 'https://download1.mediafire.com/q/y.7z');
  assert.equal(mediafire._test.keyOf('https://www.mediafire.com/file/abc123xyz/game.zip/file'), 'abc123xyz');
  const w = onefichier._test.freeWait('<div class="ct_warn">You must wait 17 minutes to download another file</div>');
  assert.ok(w.wait === 18 * 60000 && w.ipLimit && w.hostWide);
  assert.equal(onefichier._test.canonical('https://1fichier.com/?abcde12345&af=1'), 'https://1fichier.com/?abcde12345');
  assert.equal(onefichier._test.directLink('<a href="https://a-7.1fichier.com/p123" style="float:none;" class="ok btn-general btn-orange">Click here</a>'), 'https://a-7.1fichier.com/p123');
  ok('Google Drive warning page + folder view, MediaFire button (plain + scrambled), 1fichier wait + link parsed');
}

// ---- 12. accounts: premium-only hosts resolve only with an account; premium beats debrid ----
{
  setAccounts({});
  assert.equal(resolverFor('https://rapidgator.net/file/abc/x.html'), null);
  assert.equal(resolverFor('https://1fichier.com/?abcde').premium, false);
  setAccounts({ rapidgator: { login: 'a', password: 'b' }, '1fichier': { apiKey: 'k', enabled: false } });
  assert.equal(resolverFor('https://rapidgator.net/file/abc/x.html').premium, true);
  assert.equal(resolverFor('https://1fichier.com/?abcde').premium, false, 'a switched-off account is not used');
  const m = newManager({ torboxKey: 'x', hostAccounts: { rapidgator: { login: 'a', password: 'b' } } });
  assert.equal(m.defaultRoute({ kind: 'http', source: 'https://rapidgator.net/file/abc/x.html' }), 'direct');
  setAccounts({});
  ok('premium-only hosts need an account; your own account is used before debrid; switched-off accounts are ignored');
}

srv.close();
srv.closeAllConnections?.();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nAll host special-case tests passed.');
process.exit(0);
