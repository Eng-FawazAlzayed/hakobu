// File-host handling: live debrid host lists, routing, web-page detection, BuzzHeavier-style resolving, expired links.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HosterRegistry } = require('../src/engine/hosters.js');
const { resolverFor, RESOLVERS } = require('../src/engine/resolvers.js');
const { HttpTask, RateLimiter, PageError } = require('../src/engine/http.js');
const { Manager } = require('../src/engine/manager.js');
const { checkLink } = require('../src/engine/linkcheck.js');
const ok = msg => console.log('  ✓', msg);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakobu-hosts-'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

// ---- live host lists (public endpoints) ----
const registry = new HosterRegistry(path.join(tmp, 'hosters.json'));
await registry.refresh(true);
{
  const d = registry.list();
  assert.ok(d.torbox.length > 50 && d.realdebrid.length > 50, 'both lists loaded');
  const p = u => registry.providersFor(u).map(x => x.provider);
  assert.deepEqual(p('https://vikingfile.com/f/abc123'), ['torbox']);
  assert.deepEqual(p('https://buzzheavier.com/xyz'), ['torbox']);
  assert.deepEqual(p('https://datavaults.co/file/1'), ['torbox']);
  assert.ok(p('https://1fichier.com/?abc').includes('realdebrid'));
  assert.ok(fs.existsSync(path.join(tmp, 'hosters.json')), 'cached to disk');
  ok(`live lists: TorBox ${d.torbox.length} hosts, Real-Debrid ${d.realdebrid.length}; VikingFile/BuzzHeavier/DataVaults → TorBox`);
}

// ---- routing ----
{
  const route = (settings, url) => new Manager({ statePath: null, settings, hosters: registry }).defaultRoute({ kind: 'http', source: url });
  assert.equal(route({ torboxKey: 'k' }, 'https://datavaults.co/file/1'), 'torbox');
  assert.equal(route({ realdebridToken: 'k', preferredDebrid: 'realdebrid' }, 'https://datavaults.co/file/1'), 'direct', 'RD cannot do DataVaults');
  assert.equal(route({ torboxKey: 'a', realdebridToken: 'b', preferredDebrid: 'realdebrid' }, 'https://datavaults.co/file/1'), 'torbox', 'falls back to the service that supports it');
  assert.equal(route({ torboxKey: 'a', realdebridToken: 'b', preferredDebrid: 'realdebrid' }, 'https://rapidgator.net/file/x'), 'realdebrid');
  assert.equal(route({}, 'https://buzzheavier.com/xyz'), 'direct', 'BuzzHeavier works without debrid (built-in resolver)');
  assert.equal(route({}, 'https://example.org/file.zip'), 'direct');
  const m = new Manager({ statePath: null, settings: {}, hosters: registry });
  assert.match(m.hosterAdvice('https://vikingfile.com/f/abc'), /TorBox/);
  assert.match(m.hosterAdvice('https://no-debrid-host.invalid/x'), /None of your debrid services/);
  assert.equal(resolverFor('https://buzzheavier.com/abc')?.name, 'BuzzHeavier');
  assert.equal(resolverFor('https://datavaults.co/file/1'), null);
  ok('routing: each host goes to a configured service that supports it, BuzzHeavier resolves without debrid');
}

// ---- local server: html page, fake BuzzHeavier, expiring links ----
const payload = crypto.randomBytes(5 * 1024 * 1024);
let flakyHits = 0;
let dropOnce = true;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/landing') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<html><body>Click to download (wait 30s)</body></html>');
  }
  if (u.pathname === '/abc123/download') {
    assert.equal(req.headers['hx-request'], 'true');
    res.writeHead(204, { 'hx-redirect': '/files/real.bin?sig=1' });
    return res.end();
  }
  if (u.pathname === '/gone/download') return res.writeHead(404).end();
  const serve = () => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = m ? +m[1] : 0;
    const end = m && m[2] ? +m[2] : payload.length - 1;
    res.writeHead(m ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1, ...(m ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) });
    // the first big segment request is cut off half way to exercise retries
    if (dropOnce && start > 0 && end - start > 100000) {
      dropOnce = false;
      res.write(payload.subarray(start, start + 50000));
      return setTimeout(() => res.destroy(), 20);
    }
    res.end(payload.subarray(start, end + 1));
  };
  if (u.pathname === '/files/real.bin') return serve();
  if (u.pathname === '/expiring') return ++flakyHits === 1 ? serve() : res.writeHead(403).end('expired');
  if (u.pathname === '/fresh') return serve();
  res.writeHead(404).end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const limiter = new RateLimiter();

try {
  // web page instead of a file
  {
    const it = { id: 'p', source: `${base}/landing`, dir: path.join(tmp, 'dl') };
    await assert.rejects(new HttpTask(it, { limiter }).run(), e => e instanceof PageError);
    assert.ok(!fs.existsSync(path.join(tmp, 'dl', 'landing')), 'no HTML saved as a file');
    const c = await checkLink(`${base}/landing`);
    assert.equal(c.status, 'page');
    const c404 = await checkLink(`${base}/nope`);
    assert.equal(c404.status, 'offline');
    ok('a host page is refused (no HTML saved), the checker reports "web page", 404 = offline');
  }

  // BuzzHeavier-style resolve → download
  {
    const bz = RESOLVERS.find(r => r.name === 'BuzzHeavier');
    const r = await bz.resolve(`${base}/abc123`);
    assert.equal(r.url, `${base}/files/real.bin?sig=1`);
    await assert.rejects(bz.resolve(`${base}/gone`), /file not found/);
    const it = { id: 'b', source: `${base}/abc123`, dir: path.join(tmp, 'dl') };
    await new HttpTask(it, { limiter, connections: 4, resolve: s => bz.resolve(it.source, s) }).run();
    assert.equal(it.filename, 'real.bin');
    assert.equal(sha(fs.readFileSync(path.join(tmp, 'dl', 'real.bin'))), sha(payload));
    ok('BuzzHeavier flow: page → hx-redirect → 4-connection download, survived a dropped connection, hash matches');
  }

  // expired link gets refreshed mid-download
  {
    let calls = 0;
    const resolve = async () => ({ url: ++calls === 1 ? `${base}/expiring` : `${base}/fresh`, headers: {} });
    const it = { id: 'e', source: 'https://host.example/page', suggestedName: 'expiring.bin', dir: path.join(tmp, 'dl') };
    await new HttpTask(it, { limiter, connections: 3, resolve }).run();
    assert.equal(calls, 2, 'link was refreshed once');
    assert.equal(sha(fs.readFileSync(path.join(tmp, 'dl', 'expiring.bin'))), sha(payload));
    ok('expired link (403) → fresh link fetched once, download finished intact');
  }
  // debrid failure → retry without debrid
  {
    const m = new Manager({ statePath: null, settings: { downloadDir: path.join(tmp, 'fb'), torboxKey: 'k' }, hosters: registry });
    m.torrents.init = async () => {};
    m.torrents.applyLimits = () => {};
    await m.init();
    const fallbacks = [];
    m.on('fallback', it => fallbacks.push(it.name));
    const until = async (fn, what) => {
      for (let i = 0; i < 200 && !fn(); i++) await new Promise(r => setTimeout(r, 100));
      assert.ok(fn(), 'timed out: ' + what);
    };

    // 1) TorBox is down for a host link → downloaded directly instead
    m.provider = () => ({ name: 'TorBox', resolveLink: async () => { throw new Error('TorBox: 502 Bad Gateway'); } });
    const [a] = m.add([{ kind: 'http', source: `${base}/files/real.bin`, via: 'torbox', name: 'a' }]);
    await until(() => a.status === 'completed' || a.status === 'error', 'fallback a');
    assert.equal(a.status, 'completed', a.error);
    assert.equal(a.via, 'direct');
    assert.equal(a.fallbackFrom, 'torbox');
    assert.match(a.fallbackReason, /502/);

    // 2) TorBox fails for a torrent → switched to P2P
    const started = [];
    m.startTorrent = it => started.push(it.id);
    const [t] = m.add([{ kind: 'torrent', source: 'magnet:?xt=urn:btih:' + 'ef'.repeat(20) + '&dn=Some+Linux', via: 'torbox' }]);
    m.provider = () => ({ name: 'TorBox', resolveTorrent: async () => { throw new Error('TorBox: service unavailable'); } });
    await until(() => started.includes(t.id), 'torrent fallback');
    assert.equal(t.via, 'p2p');

    // 3) TorBox hands out a link that's dead → original link fetched without debrid
    m.provider = () => ({ name: 'TorBox', resolveLink: async () => [{ url: `${base}/dead-cdn-link`, filename: 'c.bin', size: payload.length }] });
    const [c] = m.add([{ kind: 'http', source: `${base}/files/real.bin?orig=1`, via: 'torbox', name: 'c' }]);
    await until(() => c.status === 'completed' || c.status === 'error', 'child fallback');
    assert.equal(c.status, 'completed', c.error);
    assert.equal(c.fallbackFrom, 'torbox');
    assert.ok(![...m.items.values()].some(i => i.parentId === c.id), 'dead child removed');

    // 4) TorBox fails and the host page can't be downloaded either → one clear error with both reasons
    m.provider = () => ({ name: 'TorBox', resolveLink: async () => { throw new Error('TorBox: hoster down'); } });
    const [d] = m.add([{ kind: 'http', source: `${base}/landing`, via: 'torbox', name: 'd' }]);
    await until(() => d.status === 'error', 'final error');
    assert.match(d.error, /web page, not a file/);
    assert.match(d.error, /TorBox failed first: TorBox: hoster down/);

    // switch off → no fallback
    m.settings.debridFallback = false;
    const [e] = m.add([{ kind: 'http', source: `${base}/files/real.bin?off=1`, via: 'torbox', name: 'e' }]);
    await until(() => e.status === 'error', 'no fallback');
    assert.equal(e.via, 'torbox');
    assert.equal(fallbacks.length, 4);
    await m.shutdown();
    ok('debrid fallback: link → direct, torrent → P2P, dead debrid link → original, combined error, can be switched off');
  }
  // host page with a wait/captcha → "Needs browser" → opened → the browser's download finishes the same item
  {
    const m = new Manager({ statePath: null, settings: { downloadDir: path.join(tmp, 'br') }, hosters: registry });
    m.torrents.init = async () => {};
    m.torrents.applyLimits = () => {};
    await m.init();
    const until = async (fn, what) => {
      for (let i = 0; i < 200 && !fn(); i++) await new Promise(r => setTimeout(r, 100));
      assert.ok(fn(), 'timed out: ' + what);
    };
    const asked = [];
    m.on('needsBrowser', it => asked.push(it.id));
    const [p] = m.add([{ kind: 'http', source: `${base}/landing?file=42`, via: 'direct', name: 'game.rar', package: 'Game' }]);
    await until(() => p.status === 'error', 'page error');
    assert.ok(p.needsBrowser, 'flagged as needing the browser');
    assert.deepEqual(asked, [p.id]);
    assert.equal(m.matchBrowserWait(`${base}/landing?file=42`), null, 'nothing is waiting until the page is opened');
    assert.equal(m.browserOpened(p.id), `${base}/landing?file=42`);
    assert.equal(p.status, 'browser');
    assert.equal(m.matchBrowserWait('https://other.example/x'), null, 'other hosts are not matched');
    assert.equal(m.matchBrowserWait(`${base}/landing?file=42`).id, p.id);
    m.browserHandoff(p.id, { kind: 'http', source: `${base}/files/real.bin?from=browser`, headers: { Cookie: 'a=1' }, suggestedName: 'game.rar' });
    await until(() => p.status === 'completed' || p.status === 'error', 'handoff download');
    assert.equal(p.status, 'completed', p.error);
    assert.equal(p.package, 'Game', 'same package');
    assert.ok(!p.needsBrowser);
    assert.equal(sha(fs.readFileSync(path.join(tmp, 'br', 'game.rar'))), sha(payload));
    await m.shutdown();
    ok('host page → "Needs browser" → opened → the browser download continues in the same item and folder');
  }
  console.log('\nAll file-host tests passed.');
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
