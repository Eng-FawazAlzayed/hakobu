// Tests for the JDownloader extras: extension API, Click'n'Load, scheduler, "when done", package extraction.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LocalApi, decryptCnl } = require('../src/engine/api.js');
const { Manager } = require('../src/engine/manager.js');
const { path7za } = require('../src/engine/extract.js');
const ok = msg => console.log('  ✓', msg);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakobu-api-'));

const got = [];
const localApi = new LocalApi({ onLinks: (entries, meta) => got.push({ entries, meta }), expecting: ref => ref === 'https://host.example/f/1', version: '9.9.9' });
const PORT = 46000 + Math.floor(Math.random() * 1000);
const status = await localApi.start({ apiPort: PORT, token: 'tok123', cnl: true });
const base = `http://127.0.0.1:${PORT}`;

try {
  // ---- extension API ----
  {
    assert.equal(status.api, 'on');
    assert.equal((await fetch(`${base}/api/ping`)).status, 401);
    assert.equal((await fetch(`${base}/api/ping`, { headers: { 'X-Hakobu-Token': 'nope' } })).status, 401);
    const ping = await (await fetch(`${base}/api/ping`, { headers: { 'X-Hakobu-Token': 'tok123' } })).json();
    assert.equal(ping.version, '9.9.9');
    const r = await fetch(`${base}/api/add`, {
      method: 'POST',
      headers: { 'X-Hakobu-Token': 'tok123', 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: ['https://files.example.com/a.zip', 'magnet:?xt=urn:btih:' + 'ab'.repeat(20)], cookie: 'sid=42', referrer: 'https://files.example.com/page', page: 'https://files.example.com/page' }),
    });
    assert.deepEqual(await r.json(), { added: 2 });
    const { entries, meta } = got.pop();
    assert.equal(meta.source, 'extension');
    const direct = entries.find(e => e.kind === 'http');
    const magnet = entries.find(e => e.kind === 'torrent');
    assert.deepEqual(direct.headers, { Cookie: 'sid=42', Referer: 'https://files.example.com/page' });
    assert.equal(magnet.headers, undefined, 'cookies never attach to magnets');
    ok('extension API: token required, ping, links + magnets, cookies/referrer passed for direct links only');

    // "Needs browser": the extension asks first, and a captured download carries capture + referrer to the app
    const H = { 'X-Hakobu-Token': 'tok123' };
    assert.deepEqual(await (await fetch(`${base}/api/expecting?referrer=${encodeURIComponent('https://host.example/f/1')}`, { headers: H })).json(), { expecting: true });
    assert.deepEqual(await (await fetch(`${base}/api/expecting?referrer=${encodeURIComponent('https://else.example/')}`, { headers: H })).json(), { expecting: false });
    assert.equal((await fetch(`${base}/api/expecting?referrer=x`)).status, 401, 'token required');
    await fetch(`${base}/api/add`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ links: ['https://cdn.host.example/file.rar'], referrer: 'https://host.example/f/1', capture: true }) });
    const cap = got.pop();
    assert.equal(cap.meta.capture, true);
    assert.equal(cap.meta.referrer, 'https://host.example/f/1');
    ok('browser hand-off API: "expecting" check needs the token, captured downloads carry capture + referrer');
  }

  // ---- Click'n'Load ----
  if (status.cnl === 'on') {
    const cnl = 'http://127.0.0.1:9666';
    assert.match(await (await fetch(`${cnl}/jdcheck.js`)).text(), /jdownloader=true/);
    let r = await fetch(`${cnl}/flash/add`, { method: 'POST', body: new URLSearchParams({ urls: 'https://a.example/1.rar\r\nhttps://a.example/2.rar', package: 'My Pack', passwords: 'pw1\npw2' }) });
    assert.equal(await r.text(), 'success\r\n');
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    let last = got.pop();
    assert.equal(last.entries.length, 2);
    assert.equal(last.entries[0].package, 'My Pack');
    assert.deepEqual(last.entries[0].archivePasswords, ['pw1', 'pw2']);

    // addcrypted2: encrypt like a link site would (AES-128-CBC, key = IV, zero padded)
    const keyHex = '31323334353637383930393837363534';
    const plain = Buffer.from('https://b.example/x.7z.001\nhttps://b.example/x.7z.002');
    const padded = Buffer.concat([plain, Buffer.alloc((16 - (plain.length % 16)) % 16)]);
    const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(keyHex, 'hex'), Buffer.from(keyHex, 'hex'));
    c.setAutoPadding(false);
    const crypted = Buffer.concat([c.update(padded), c.final()]).toString('base64');
    const jk = `function f(){ return '${keyHex}';}`;
    assert.equal(decryptCnl(crypted, jk), plain.toString());
    r = await fetch(`${cnl}/flash/addcrypted2`, { method: 'POST', body: new URLSearchParams({ crypted, jk, source: 'https://linksite.example' }) });
    assert.equal(await r.text(), 'success\r\n');
    last = got.pop();
    assert.deepEqual(last.entries.map(e => e.source), ['https://b.example/x.7z.001', 'https://b.example/x.7z.002']);
    assert.equal(last.meta.page, 'https://linksite.example');
    ok("Click'n'Load: jdcheck, plain links with package + passwords, encrypted links (addcrypted2)");
  } else {
    ok(`Click'n'Load skipped: ${status.cnl} (is JDownloader running?)`);
  }

  // ---- port conflict reported, not thrown ----
  {
    const other = new LocalApi({ onLinks: () => {} });
    const st = await other.start({ apiPort: PORT, token: 'x', cnl: false });
    assert.match(st.api, /in use/);
    await other.stop();
    ok('busy port is reported in settings instead of crashing');
  }

  // ---- scheduler + when-done ----
  {
    const m = new Manager({ statePath: null, settings: { downloadDir: tmp } });
    const calls = [];
    m.pause = id => calls.push(['pause', id]);
    m.resume = id => calls.push(['resume', id]);
    m.applySettings = p => calls.push(['settings', p]);
    m.items.set('a', { id: 'a', status: 'active' });
    m.items.set('b', { id: 'b', status: 'paused' });
    m.settings.downloadSchedule = [
      { time: '08:00', days: [1, 2, 3, 4, 5], action: 'pause' },
      { time: '01:00', days: [0, 1, 2, 3, 4, 5, 6], action: 'start' },
      { time: '01:00', days: [0], action: 'turtle-on' },
    ];
    m.runSchedule(new Date(2024, 9, 7, 8, 0)); // Monday 08:00
    assert.deepEqual(calls, [['pause', 'a']]);
    m.runSchedule(new Date(2024, 9, 7, 8, 0, 30)); // same minute: nothing again
    assert.equal(calls.length, 1);
    calls.length = 0;
    m.runSchedule(new Date(2024, 9, 6, 1, 0)); // Sunday 01:00
    assert.deepEqual(calls, [['resume', 'a'], ['resume', 'b'], ['settings', { altActive: true }]]);
    m.runSchedule(new Date(2024, 9, 12, 8, 0)); // Saturday: weekday-only job skipped
    assert.equal(calls.length, 3);

    const done = [];
    m.on('allDone', a => done.push(a));
    m.settings.whenDone = 'shutdown';
    m.checkAllDone(); // busy (item a active)
    m.items.get('a').status = 'completed';
    m.items.get('b').status = 'completed';
    m.checkAllDone();
    m.checkAllDone();
    assert.deepEqual(done, ['shutdown']);
    assert.equal(m.settings.whenDone, 'none', 'one-shot');
    ok('download scheduler (days, once per minute, turtle) + one-shot "when done" action');
  }

  // ---- package extraction waits for the whole package ----
  {
    const dir = path.join(tmp, 'pkg');
    fs.mkdirSync(dir);
    const payload = crypto.randomBytes(6000).toString('hex');
    fs.writeFileSync(path.join(tmp, 'payload.txt'), payload);
    execFileSync(path7za(), ['a', '-t7z', '-v2k', '-pzz', path.join(dir, 'set.7z'), path.join(tmp, 'payload.txt')], { stdio: 'pipe' });
    const parts = fs.readdirSync(dir).sort();
    assert.ok(parts.length >= 3, 'multi-part set');
    const m = new Manager({ statePath: null, settings: { downloadDir: tmp, archivePasswords: ['zz'] } });
    const items = parts.map((f, i) => ({ id: 'p' + i, kind: 'http', via: 'direct', package: 'Set', dir, filename: f, status: i === parts.length - 1 ? 'active' : 'completed' }));
    items.forEach(i => m.items.set(i.id, i));
    await m.maybeExtract(items[0]);
    assert.ok(!items[0].extract, 'not extracted while a part is still downloading');
    items.at(-1).status = 'completed';
    await m.maybeExtract(items.at(-1));
    clearTimeout(m.pendingEmit);
    assert.equal(fs.readFileSync(path.join(dir, 'set', 'payload.txt'), 'utf8'), payload);
    assert.equal(items[0].extract.state, 'done');
    ok(`package of ${parts.length} parts extracted only after the last part finished (password from list)`);
  }
  console.log('\nAll API/scheduler/package tests passed.');
} finally {
  await localApi.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
