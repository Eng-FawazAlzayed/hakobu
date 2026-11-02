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
const { TorBox } = require('../src/debrid/torbox.js');
const simpleHosts = require('../src/engine/hosts/simple.js');
const xfsHosts = require('../src/engine/hosts/xfs.js');
const buzz = require('../src/engine/hosts/buzzheavier.js');
const tools = require('../src/engine/tools.js');

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

// ---- 11b. MEGA is never sent to the browser; link forms ----
{
  const p = mega._test.parseLink;
  const key = 'r0d0-WRnFwulR_shhuEDwrY1Vo103-am1MyUy8oV6Ps';
  for (const u of [`https://mega.nz/file/hYVmXKqL#${key}`, `https://mega.nz/#!hYVmXKqL!${key}`, `https://mega.co.nz/#!hYVmXKqL!${key}`, `https://mega.nz/file/hYVmXKqL%23${key}`]) assert.equal(p(u)?.id, 'hYVmXKqL', u);
  assert.equal(p('https://mega.nz/folder/AAAAAAAA#BBBBBBBBBBBBBBBBBBBBBB/file/CCCCCCCC').type, 'node');
  assert.equal(p('https://mega.nz/file/hYVmXKqL'), null);
  await assert.rejects(mega.resolve('https://mega.nz/file/hYVmXKqL', {}), e => e.permanent && /no decryption key/.test(e.message));
  await assert.rejects(mega.resolve('https://mega.nz/#P!AgAAAA', {}), e => e.permanent && /password/.test(e.message));
  const m = newManager();
  const [a] = m.add([{ kind: 'http', source: 'https://mega.nz/file/hYVmXKqL', via: 'direct' }]);
  await until(() => a.status === 'error');
  assert.ok(!a.needsBrowser, 'no browser hand-off for MEGA');
  assert.match(a.error, /no decryption key/);
  // With debrid as the route the link is still checked by the built-in module, not by a debrid service.
  const viaDebrid = await checkLink('https://mega.nz/file/hYVmXKqL', { registry: { providersFor: () => [{ provider: 'torbox' }, { provider: 'realdebrid' }] }, route: () => 'torbox' });
  assert.equal(viaDebrid.status, 'offline');
  assert.match(viaDebrid.error, /no decryption key/);
  // Browser hand-off for other hosts: the file on a sub-domain, or no referrer at all.
  const w = { id: 'w', needsBrowser: true, status: 'browser', pageUrl: 'https://megaup.net/abc/file', browserOpenedAt: 1 };
  m.items.set('w', w);
  assert.equal(m.matchBrowserWait('https://download.megaup.net/x', 'https://cdn.other.example/f.zip'), w);
  assert.equal(m.matchBrowserWait('', 'https://d3.megaup.net/f.zip'), w);
  assert.equal(m.matchBrowserWait('https://example.com/', 'https://example.com/f.zip'), null);
  m.items.delete('w');
  ok('MEGA link forms; a bad MEGA link is a clear error, never "Needs browser"; hand-off matches sub-domains and missing referrers');
}

// ---- 11c. TorBox: slow or dropped answers, queued and vanished downloads ----
{
  const real = globalThis.fetch;
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
  const tb = () => Object.assign(new TorBox('k'), { pollMs: 1, retryMs: 1 });
  const file = { id: 7, short_name: 'x.zip', size: 5 };
  let calls;
  const serve = fn => {
    calls = [];
    globalThis.fetch = async (u, o) => {
      calls.push({ u: String(u), o });
      return fn(String(u), calls.length, o);
    };
  };
  try {
    // The link goes as a form, polls survive dropped connections, the file link comes back.
    let polls = 0;
    serve(u => {
      if (u.includes('createwebdownload')) return json({ success: true, data: { webdownload_id: 3 } });
      if (u.includes('mylist')) {
        if (++polls <= 3) throw new TypeError('fetch failed');
        return json({ success: true, data: { download_finished: true, files: [file] } });
      }
      return json({ success: true, data: 'https://cdn.example/x.zip' });
    });
    const got = await tb().resolveLink('https://host.example/f');
    assert.equal(got[0].url, 'https://cdn.example/x.zip');
    assert.ok(calls[0].o.body instanceof URLSearchParams);
    assert.equal(calls[0].o.body.get('link'), 'https://host.example/f');
    // Network down while submitting: tried again, then a message that says so.
    serve(() => {
      throw new TypeError('fetch failed');
    });
    await assert.rejects(tb().resolveLink('https://host.example/f'), /Couldn't reach TorBox/);
    assert.equal(calls.length, 2);
    // A request that never answers ends at the time limit.
    globalThis.fetch = (u, o) => new Promise((_, no) => o.signal.addEventListener('abort', () => no(o.signal.reason)));
    await assert.rejects(tb().call('POST', '/webdl/createwebdownload', { urlencoded: { link: 'x' }, timeoutMs: 30 }), /didn't answer within/);
    // TorBox's own refusal is quoted and not retried.
    serve(() => json({ success: false, error: 'BAD_TOKEN', detail: 'Your token is invalid.' }, 401));
    await assert.rejects(tb().resolveLink('https://host.example/f'), /Your token is invalid\. \(BAD_TOKEN, HTTP 401\)/);
    assert.equal(calls.length, 1);
    // Queued because of a plan limit: no id to follow.
    serve(() => json({ success: true, detail: 'Active limit reached.', data: { queued_id: 9 } }));
    await assert.rejects(tb().resolveLink('https://host.example/f'), /queue.*Active limit reached/);
    // A download TorBox doesn't list used to be polled forever.
    serve(u => (u.includes('createwebdownload') ? json({ success: true, data: { webdownload_id: 3 } }) : json({ success: true, data: null })));
    await assert.rejects(tb().resolveLink('https://host.example/f'), /no longer lists/);
    // Stuck at the same state.
    serve(u => (u.includes('createwebdownload') ? json({ success: true, data: { webdownload_id: 3 } }) : json({ success: true, data: { download_state: 'downloading', progress: 0.1 } })));
    await assert.rejects(Object.assign(tb(), { stallMs: 20 }).resolveLink('https://host.example/f'), /no progress/);
    // Finished with no files: TorBox gets a moment to list them, then a clear message.
    let lists = 0;
    serve(u => {
      if (u.includes('createwebdownload')) return json({ success: true, data: { webdownload_id: 3 } });
      if (u.includes('mylist')) return json({ success: true, data: { download_finished: true, files: ++lists < 3 ? [] : [file] } });
      return json({ success: true, data: 'https://cdn.example/late.zip' });
    });
    assert.equal((await tb().resolveLink('https://host.example/f'))[0].url, 'https://cdn.example/late.zip');
    assert.equal(lists, 3);
    serve(u => (u.includes('createwebdownload') ? json({ success: true, data: { webdownload_id: 3 } }) : json({ success: true, data: { download_finished: true, files: [] } })));
    await assert.rejects(Object.assign(tb(), { emptyFilesMs: 20 }).resolveLink('https://gofile.io/d/abc'), /finished but listed no files; this host's folder links may not be supported/);
    // A MEGA link TorBox can't do falls back to the built-in module, not to the browser.
    serve(() => json({ success: false, error: 'BAD_TOKEN', detail: 'Your token is invalid.' }, 401));
    const m = newManager({ torboxKey: 'bad' });
    const [a] = m.add([{ kind: 'http', source: 'https://mega.nz/file/hYVmXKqL', via: 'torbox' }]);
    await until(() => a.status === 'error');
    assert.equal(a.fallbackFrom, 'torbox');
    assert.ok(!a.needsBrowser);
    assert.match(a.error, /no decryption key.*TorBox failed first: .*invalid/);
  } finally {
    globalThis.fetch = real;
  }
  ok('TorBox: survives dropped polls, submit limit, specific errors (refused, queued, vanished, stalled); MEGA falls back to the built-in module');
}

// ---- 11d. Send, DataNodes, KrakenFiles parsers; captchas go to the browser, never solved ----
{
  const t = simpleHosts._test;
  assert.equal(t.countdown('<script>var seconds = 2;</script>'), 2);
  assert.equal(t.countdown('<span id="countdown_str">Wait <span class="seconds">17</span></span>'), 17);
  const xfs = '<form method="POST"><input type="hidden" name="op" value="download2"><input type="hidden" name="id" value="abc123def"><input type="hidden" name="rand" value="r&amp;1"><input name="method_free" value=""></form>';
  assert.deepEqual(t.formFields(xfs), { op: 'download2', id: 'abc123def', rand: 'r&1', method_free: '' });
  assert.equal(t.formFields('<form><input name="q"></form>'), null);
  assert.equal(t.krakenHash('https://krakenfiles.com/view/abc123/file.html'), 'abc123');
  assert.equal(t.vikingId('https://vikingfile.com/f/AbCdEf1234'), 'AbCdEf1234');
  assert.equal(t.sizeOf('1.5 GB'), 1610612736);
  // A person is needed: Cloudflare's check or a captcha field. A comment that only mentions reCAPTCHA doesn't count.
  const res = h => ({ headers: new Headers(h) });
  assert.equal(t.needsPerson(res({ 'cf-mitigated': 'challenge' }), ''), 'a bot check');
  assert.equal(t.needsPerson(res({}), '<title>Just a moment...</title>'), 'a bot check');
  assert.equal(t.needsPerson(res({}), '<div class="g-recaptcha" data-sitekey="x"></div>'), 'a captcha');
  assert.equal(t.needsPerson(res({}), '<div class="cf-turnstile"></div>'), 'a captcha');
  assert.equal(t.needsPerson(res({}), '<!-- reCAPTCHA only exists to fill a token --><form></form>'), null);
  // Through the real module: the flow runs, and a captcha page ends in the browser without any further request.
  const real = globalThis.fetch;
  try {
    let posted = null;
    globalThis.fetch = async (u, o = {}) => {
      if (o.method === 'POST') {
        posted = o.body.get('op');
        return new Response(null, { status: 302, headers: { location: 'https://cdn.send.example/f/x.zip' } });
      }
      return new Response(xfs, { status: 200 });
    };
    const send = xfsHosts.find(h => h.id === 'send');
    const r = await send.resolve('https://send.cm/abcd1234ef', {});
    assert.equal(r.url, 'https://cdn.send.example/f/x.zip');
    assert.equal(posted, 'download2');
    let posts = 0;
    globalThis.fetch = async (u, o = {}) => {
      if (o.method === 'POST') posts++;
      return new Response('<form><input type="hidden" name="op" value="download2"><div class="h-captcha"></div></form>', { status: 200 });
    };
    await assert.rejects(send.resolve('https://send.now/abcd1234ef', {}), e => e.browser && /captcha/.test(e.message));
    assert.equal(posts, 0, 'nothing was posted past the captcha');
    globalThis.fetch = async () => new Response(JSON.stringify({ url: 'https%3A%2F%2Fcdn.dn.example%2Fx.zip' }), { status: 200 });
    const dn = await xfsHosts.find(h => h.id === 'datanodes').resolve('https://datanodes.to/abc123/x.zip', {});
    assert.equal(dn.url, 'https://cdn.dn.example/x.zip');
    globalThis.fetch = async () => new Response('<title>File Not Found</title>', { status: 404 });
    await assert.rejects(xfsHosts.find(h => h.id === 'datanodes').resolve('https://datanodes.to/abc123/x.zip', {}), e => e.permanent);
  } finally {
    globalThis.fetch = real;
  }
  // Direct first: the built-in module comes before a configured service.
  const m = newManager({ torboxKey: 'k' });
  m.hosters.data.torbox = [{ name: 'DataNodes', domains: ['datanodes.to'], up: true }];
  assert.equal(m.defaultRoute({ kind: 'http', source: 'https://datanodes.to/abc/x.zip' }), 'direct');
  assert.equal(newManager().defaultRoute({ kind: 'http', source: 'https://datanodes.to/abc/x.zip' }), 'direct');
  assert.ok(resolverFor('https://datanodes.to/abc/x.zip') && resolverFor('https://send.now/abc') && resolverFor('https://krakenfiles.com/view/a/file.html'));
  ok('Send, DataNodes, KrakenFiles parsers and flows; captchas go to the browser; direct first');
}

// ---- 11e. media tools: dropped connections while checking versions and checksums ----
{
  const real = globalThis.fetch;
  tools._test.setRetryMs(1);
  const drop = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
  try {
    let n = 0;
    globalThis.fetch = async () => {
      if (++n < 3) throw drop();
      return new Response(null, { status: 302, headers: { location: 'https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.1' } });
    };
    assert.equal(await tools.TOOLS['yt-dlp'].latest(), '2026.10.1');
    assert.equal(n, 3, 'tried again after two dropped connections');
    n = 0;
    globalThis.fetch = async () => {
      n++;
      throw drop();
    };
    await assert.rejects(tools.TOOLS['yt-dlp'].latest(), /Couldn't connect to github\.com: timed out \(UND_ERR_CONNECT_TIMEOUT\)/);
    assert.equal(n, 5);
    n = 0;
    globalThis.fetch = async () => {
      n++;
      return new Response('', { status: 404 });
    };
    await assert.rejects(tools.TOOLS.deno.install(path.join(tmp, 'nostage')), /HTTP 404/);
    assert.equal(n, 1, 'a 404 is not retried');
    // gyan.dev unreachable: ffmpeg comes from the builder's GitHub release, and its SHA-256 is still enforced.
    const seen = [];
    const digest = 'a'.repeat(64);
    globalThis.fetch = async (u, o = {}) => {
      u = String(u);
      seen.push(u);
      if (u.includes('gyan.dev')) throw drop();
      if (u.includes('/releases/latest') && u.includes('api.github.com')) return new Response(JSON.stringify({ assets: [{ name: 'ffmpeg-9-full_build.zip', digest: 'sha256:' + 'b'.repeat(64), browser_download_url: 'https://github.example/full.zip' }, { name: 'ffmpeg-9-essentials_build.zip', digest: 'sha256:' + digest, browser_download_url: 'https://github.example/essentials.zip' }] }));
      if (u.includes('/releases/latest')) return new Response(null, { status: 302, headers: { location: 'https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2' } });
      return new Response(Buffer.from('not the right bytes'));
    };
    assert.equal(await tools.TOOLS.ffmpeg.latest(), '9.0.2');
    const stage = path.join(tmp, 'ffstage');
    fs.mkdirSync(stage, { recursive: true });
    await assert.rejects(tools.TOOLS.ffmpeg.install(stage), /Checksum mismatch/);
    assert.ok(seen.includes('https://github.example/essentials.zip') && !seen.includes('https://github.example/full.zip'));
    assert.ok(!fs.existsSync(path.join(stage, 'ffmpeg.zip')), 'a file that fails its check is not kept');
  } finally {
    globalThis.fetch = real;
    tools._test.setRetryMs(1500);
  }
  ok('media tools: version and checksum checks survive dropped connections; errors name the host and reason');
}

// ---- 11f. direct first, debrid before asking the person, and links a person got ----
{
  const providers = [{ provider: 'torbox', name: 'x', up: true }];
  const m = newManager({ torboxKey: 'k' });
  m.hosters.providersFor = () => providers;
  assert.equal(m.defaultRoute({ kind: 'http', source: 'https://mega.nz/file/abc#k' }), 'direct', 'a built-in module comes before debrid');
  assert.equal(m.defaultRoute({ kind: 'http', source: 'https://megaup.net/abc/x' }), 'torbox', 'no module: debrid');
  // Auto route that needs a person: debrid first. A route the person picked is left alone.
  const it = { id: 'a', via: 'direct', autoRoute: true, source: 'https://datanodes.to/a/x.zip', status: 'error' };
  m.items.set('a', it);
  m.schedule = () => {};
  assert.equal(m.tryDebrid(it), true);
  assert.equal(it.via, 'torbox');
  assert.equal(m.tryDebrid({ via: 'direct', autoRoute: false, source: it.source }), false, 'picked by hand');
  assert.equal(m.tryDebrid({ via: 'direct', autoRoute: true, fallbackFrom: 'torbox', source: it.source }), false, 'debrid already failed');
  m.items.delete('a');
  // A link a person got skips the host module; closing the window goes back to waiting.
  const w = { id: 'w', needsBrowser: true, status: 'browser', pageUrl: 'https://x.example/f', source: 'https://x.example/f' };
  m.items.set('w', w);
  m.browserClosed('w');
  assert.equal(w.status, 'error');
  assert.match(w.error, /solve the captcha/);
  w.status = 'browser';
  m.browserHandoff('w', { source: 'https://a-1.1fichier.com/p1', headers: { Cookie: 'c=1' } });
  assert.ok(w.handedOff && !w.needsBrowser);
  assert.equal(w.headers.Cookie, 'c=1');
  m.items.delete('w');
  // A bot check on the file link is a page for a person, not a plain 403.
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('<title>Just a moment...</title>', { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } });
  const { probe, PageError } = require('../src/engine/http.js');
  await assert.rejects(probe('https://download.megaup.net/?url=x', {}, AbortSignal.timeout(2000)), e => e instanceof PageError);
  // A site with a solved session is fetched through it.
  netLayer.configure([]);
  let through = null;
  netLayer.registerSiteFetch('solved.example', async u => {
    through = u;
    return new Response('ok');
  });
  await netLayer.netFetch('https://d1.solved.example/f');
  assert.equal(through, 'https://d1.solved.example/f');
  assert.equal(netLayer.siteOf('https://a.b.example.co.uk/x'), 'example.co.uk');
  globalThis.fetch = real;
  // XFileSharing: two forms, then the file.
  let step = 0;
  globalThis.fetch = async (u, o = {}) => {
    if (!o.method) return new Response('<form><input type="hidden" name="op" value="download1"><input type="hidden" name="id" value="abc"></form>');
    step++;
    if (step === 1) return new Response('<form><input type="hidden" name="op" value="download2"><input type="hidden" name="rand" value="r"></form><script>var seconds = 0;</script>');
    return new Response(null, { status: 302, headers: { location: 'https://s1.hexload.com/d/x.zip' } });
  };
  const x = xfsHosts.find(h => h.id === 'hexload');
  assert.equal((await x.resolve('https://hexload.com/abc123', {})).url, 'https://s1.hexload.com/d/x.zip');
  globalThis.fetch = async () => new Response('<form><input type="hidden" name="op" value="download1"></form><div class="g-recaptcha"></div>');
  await assert.rejects(x.resolve('https://hexload.com/abc123', {}), e => e.browser);
  globalThis.fetch = real;
  ok('direct first, debrid before asking; person-got links skip modules; bot checks need a person; solved sessions reused; XFileSharing flow');
}

// ---- 11g. ported from JDownloader: XFS offline, waits, errors, forms, links; per-host flows ----
{
  const x = xfsHosts._test;
  const name = 'Host';
  // Offline and premium-only texts.
  assert.ok(x.isOffline(200, '<b>File Not Found</b>') && x.isOffline(200, 'No such file') && x.isOffline(404, '') && x.isOffline(200, '<div>The file expired</div>'));
  assert.ok(!x.isOffline(200, '<b>Free download</b>'));
  assert.match(x.premiumOnly('https://h.example/a', '<p>This file reached max downloads today</p>'), /max downloads/);
  assert.ok(x.premiumOnly('https://h.example/?op=login&redirect=x', ''));
  // Errors become waits, permanent errors or the window.
  assert.equal(x.preciseWait('You have to wait 1 hour, 3 minutes'), (3780 + 1) * 1000);
  assert.equal(x.preciseWait('You have to wait'), 3600000);
  const thrown = (html, status = 200) => {
    try {
      x.checkErrors(name, status, 'https://h.example/a', html);
    } catch (e) {
      return e;
    }
    return null;
  };
  let e = thrown('<p>You have to wait 2 minutes</p>');
  assert.ok(e.ipLimit && e.hostWide && e.wait === 121000);
  assert.equal(thrown('You&#39;re fine'), null);
  assert.equal(thrown("You're using all download slots for IP 1.2.3.4").wait, 300000);
  assert.equal(thrown('Error happened when generating Download Link').wait, 600000);
  assert.ok(thrown('<p>Only Premium user can download this file</p>').browser, 'debrid or the window');
  assert.ok(thrown('<b>Downloads disabled for this file</b>').permanent);
  assert.ok(thrown('', 404).permanent);
  assert.equal(thrown('', 429).wait, 60000);
  // Countdown forms and the file link.
  assert.equal(x.regexWaittime('<span id="countdown_str">Wait <span id="cx">12</span></span>'), 12);
  assert.equal(x.regexWaittime('<span class="seconds">7</span>'), 7);
  const dn = x.HOSTS.find(h => h.id === 'datanodes');
  const kat = x.HOSTS.find(h => h.id === 'katfile');
  assert.equal(x.regexWaittime('<x countdown="30">', dn), 30);
  assert.equal(x.regexWaittime('var estimated_time = 600', kat), 60);
  assert.equal(x.getDllink('<a href="https://s1.h.example/d/abc123/game.zip">x</a>'), 'https://s1.h.example/d/abc123/game.zip');
  assert.equal(x.getDllink('<a href="https://cdn.h.example/any/file.bin">Direct Download Link</a>'), 'https://cdn.h.example/any/file.bin');
  assert.equal(x.getDllink('{"url":"https%3A%2F%2Fcdn.dn.example%2Fx.zip"}', dn), 'https://cdn.dn.example/x.zip');
  const hex = x.HOSTS.find(h => h.id === 'hexload');
  assert.equal(x.getDllink(JSON.stringify({ link: Buffer.from('https://h.example/f').toString('base64') }), hex), 'https://h.example/f');
  const f1 = x.findFormDownload1('<form><input type="hidden" name="op" value="download1"><input name="method_premium" value="p"></form>');
  assert.deepEqual(f1, { op: 'download1', method_free: 'Free Download' });
  assert.equal(x.findFormDownload1('<script>var FILE_ID = "a1"; var FNAME = "f.zip";</script>', kat).id, 'a1');
  assert.equal(x.findFormDownload2('<form><input name="op" value="download2"><input name="adblock_detected" value=""></form>').adblock_detected, '0');
  const dnForm = x.findFormDownload2('<div file-actions link="https://datanodes.to/abcdefghijkl/x.zip" countdown="5" rand="r1" dl-token="t1">', dn);
  assert.deepEqual([dnForm.id, dnForm.rand, dnForm.dl_token], ['abcdefghijkl', 'r1', 't1']);
  assert.ok(!('g_captch__a' in dnForm), 'no field that claims a captcha was done');

  // Whole flows against a mocked site.
  const real = globalThis.fetch;
  const site = routes => {
    globalThis.fetch = async (u, o = {}) => routes(String(u), o);
  };
  const html = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });
  try {
    // A long countdown goes to the queue as a wait instead of holding a connection.
    site(() => html('<form><input name="op" value="download2"></form><span class="seconds">600</span>'));
    await assert.rejects(xfsHosts.find(h => h.id === 'clicknupload').resolve('https://clicknupload.click/abc', {}), err => err.wait > 0);
    // Link check.
    site(() => html('<form><input name="fname" value="game.zip"><input name="op" value="download1"></form>'));
    assert.deepEqual(await xfsHosts.find(h => h.id === 'usersdrive').check('https://usersdrive.com/abc', {}), { status: 'online', filename: 'game.zip' });
    site(() => html('<b>File Not Found</b>'));
    assert.equal((await xfsHosts.find(h => h.id === 'usersdrive').check('https://usersdrive.com/abc', {})).status, 'offline');
    site(() => html('<title>Download</title><p>Sign up</p>'));
    assert.equal((await xfsHosts.find(h => h.id === 'hexload').check('https://hexload.com/abc', {})).status, 'unknown', 'a page with nothing on the file is not "online"');
    site(() => html('<title>Just a moment...</title>', 403, { 'cf-mitigated': 'challenge' }));
    assert.equal((await buzz.check('https://buzzheavier.com/abc', {})).status, 'browser');
    await assert.rejects(buzz.resolve('https://buzzheavier.com/abc', {}), err => err.browser);
    // KrakenFiles and VikingFile: a check through their APIs, then the window. No token is ever sent.
    const k = simpleHosts.find(h => h.id === 'krakenfiles');
    let posts = 0;
    site((u, o) => {
      if (o.method === 'POST') posts++;
      return new Response(JSON.stringify({ hash: 'abc123', title: 'a.zip', size: '2 MB' }));
    });
    assert.deepEqual(await k.check('https://krakenfiles.com/view/abc123/file.html', {}), { status: 'online', filename: 'a.zip', size: 2097152 });
    await assert.rejects(k.resolve('https://krakenfiles.com/view/abc123/file.html', {}), err => err.browser);
    assert.equal(posts, 0);
    const v = simpleHosts.find(h => h.id === 'vikingfile');
    site(() => new Response(JSON.stringify([{ exist: true, name: 'b.zip', size: 5 }])));
    assert.deepEqual(await v.check('https://vikingfile.com/f/AbCdEf1234', {}), { status: 'online', filename: 'b.zip', size: 5 });
    site(() => new Response(JSON.stringify([{ exist: false }])));
    assert.equal((await v.check('https://vikingfile.com/f/AbCdEf1234', {})).status, 'offline');
    // FuckingFast: the link on the page; POST /go; the window for a captcha or a bot check.
    const ff = simpleHosts.find(h => h.id === 'fuckingfast');
    site(() => html('<meta name="title" content="c.rar"><p>Size - 1 MB | Downloads</p><script>window.open("https://cdn.ff.example/c.rar")</script>'));
    const opened = await ff.resolve('https://fuckingfast.co/abcdefghijkl', {});
    assert.deepEqual([opened.url, opened.filename, opened.size], ['https://cdn.ff.example/c.rar', 'c.rar', 1048576]);
    site((u, o) => (o.method === 'POST' ? new Response('OK', { headers: { 'hx-redirect': 'https://cdn.ff.example/d.rar' } }) : html('hx-post="/f/abcdefghijkl/go"')));
    assert.equal((await ff.resolve('https://fuckingfast.co/abcdefghijkl', {})).url, 'https://cdn.ff.example/d.rar');
    posts = 0;
    site((u, o) => {
      if (o.method === 'POST') posts++;
      return html('/f/abcdefghijkl/go <script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script> turnstileSuccess: false');
    });
    await assert.rejects(ff.resolve('https://fuckingfast.co/abcdefghijkl', {}), err => err.browser);
    assert.equal(posts, 0, 'nothing posted past the captcha');
    site(() => html('Just a moment', 403, { 'cf-mitigated': 'challenge' }));
    await assert.rejects(ff.resolve('https://fuckingfast.co/abcdefghijkl', {}), err => err.browser);
    // Uploadhaven: hotlink protection is explained.
    const uh = simpleHosts.find(h => h.id === 'uploadhaven');
    site(() => html('<h1>Hotlink protection active</h1>'));
    await assert.rejects(uh.resolve('https://uploadhaven.com/download/abc', {}), err => err.browser && /posted on/.test(err.message));
  } finally {
    globalThis.fetch = real;
  }
  // Page texts for the hosts with extra messages.
  assert.equal(onefichier._test.freeWait('<p>Your requests are too fast</p>').wait, 300000);
  assert.ok(onefichier._test.freeWait('<b>IP Locked</b>').hostWide);
  assert.ok(onefichier._test.freeWait('<b>This file is protected</b>').permanent);
  assert.equal(onefichier._test.freeWait('you must wait up to 12 minutes between each downloads').wait, 13 * 60000);
  assert.equal(onefichier._test.freeWait('<p>nothing</p>'), null);
  assert.equal(mediafire._test.linkFromPage('var kNO = "https://download9.mediafire.com/a/b.zip";'), 'https://download9.mediafire.com/a/b.zip');
  assert.ok(gdrive._test.pageError('but your computer or network may be sending automated queries').browser);
  assert.ok(gdrive._test.pageError('<p> Sorry, this file is infected with a virus</p>').permanent);
  assert.deepEqual(buzz._test.pageInfo('https://buzzheavier.com/a', 200, '<meta name="title" content="e.zip">Size - 2 MB | Views - 3 <strong>SHA-1:</strong> <code>' + 'a'.repeat(40) + '</code>'), { filename: 'e.zip', size: 2097152, sha1: 'a'.repeat(40) });
  assert.throws(() => buzz._test.pageInfo('https://buzzheavier.com/notfound', 200, ''), err => err.permanent);
  ok('ported from JDownloader: XFS offline, waits, errors, forms and links; KrakenFiles, VikingFile, FuckingFast, Uploadhaven flows; extra host messages');
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
