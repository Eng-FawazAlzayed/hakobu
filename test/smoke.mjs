// End-to-end smoke test of the engine (no Electron): link parsing, segmented HTTP with
// pause/resume, a local P2P torrent transfer, and the debrid hand-off using a fake provider.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import WebTorrent from 'webtorrent';

const require = createRequire(import.meta.url);
const { Manager } = require('../src/engine/manager.js');
const { parseLinks } = require('../src/linkparse.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakobu-test-'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 30000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const ok = msg => console.log('  ✓', msg);

// ---- 1. link parsing ----
{
  const e = parseLinks(`grab these:
    https://example.com/files/a%20b.zip, https://mega.nz/file/abc#key
    magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567&dn=Ubuntu+ISO&tr=udp://x
    http://site.org/x.torrent  fedcba9876543210fedcba9876543210fedcba98`);
  assert.equal(e.length, 5);
  assert.deepEqual(e.map(x => x.kind), ['torrent', 'http', 'http', 'torrent', 'torrent']);
  assert.equal(e[0].name, 'Ubuntu ISO');
  assert.equal(e[0].infoHash, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(e[1].name, 'a b.zip');
  assert.equal(e[2].hoster, true);
  ok('LinkGrabber parsing (magnets, hashes, hosters, .torrent URLs)');
}

// ---- local range-capable HTTP server (throttled so pause can land mid-download) ----
const payload = crypto.randomBytes(12 * 1024 * 1024);
let rangeRequests = 0;
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/noname')) {
    res.writeHead(200, { 'Content-Length': payload.length, 'Content-Disposition': 'attachment; filename="named by server.bin"' });
    return res.end(payload);
  }
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  let start = 0, end = payload.length - 1;
  if (m) {
    rangeRequests++;
    start = +m[1];
    if (m[2]) end = +m[2];
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${payload.length}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
  } else res.writeHead(200, { 'Content-Length': payload.length });
  let pos = start;
  const pump = () => {
    if (res.destroyed) return;
    if (pos > end) return res.end();
    const n = Math.min(64 * 1024, end - pos + 1);
    res.write(payload.subarray(pos, pos + n));
    pos += n;
    setTimeout(pump, 5);
  };
  pump();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const mgr = new Manager({
  statePath: path.join(tmp, 'state.json'),
  settings: { downloadDir: path.join(tmp, 'dl'), seedRatio: 0, connectionsPerDownload: 4 },
  torrentOptions: { dht: false, tracker: false, lsd: false, webSeeds: false, natUpnp: false, natPmp: false },
});
await mgr.init();

try {
  // ---- 2. segmented HTTP + pause/resume ----
  {
    const [it] = mgr.add([{ kind: 'http', source: `${base}/files/big.bin` }]);
    await until(() => it.downloaded > 2 * 1024 * 1024, 20000, 'first bytes');
    await mgr.pause(it.id);
    const at = it.downloaded;
    assert.equal(it.status, 'paused');
    assert.ok(it.segments.length === 4, 'uses 4 connections');
    await wait(300);
    mgr.resume(it.id);
    await until(() => it.status === 'completed', 30000, 'http completion');
    const file = fs.readFileSync(path.join(tmp, 'dl', 'big.bin'));
    assert.equal(sha(file), sha(payload));
    ok(`segmented HTTP download, paused at ${(at / 1048576).toFixed(1)} MB and resumed, hash matches`);

    const [it2] = mgr.add([{ kind: 'http', source: `${base}/noname?x=1` }]);
    await until(() => it2.status === 'completed' || it2.status === 'error', 30000, 'non-resumable');
    assert.equal(it2.status, 'completed', it2.error);
    assert.equal(it2.filename, 'named by server.bin');
    assert.equal(it2.resumable, false);
    ok('non-resumable server + Content-Disposition filename');
  }

  // ---- 3. P2P torrent from a local seeder ----
  {
    const seedDir = path.join(tmp, 'seed');
    fs.mkdirSync(seedDir);
    const content = crypto.randomBytes(3 * 1024 * 1024);
    fs.writeFileSync(path.join(seedDir, 'linux.iso'), content);
    const seeder = new WebTorrent({ dht: false, tracker: false, lsd: false, utp: false, natUpnp: false, natPmp: false });
    const seeded = await new Promise(r => seeder.seed(path.join(seedDir, 'linux.iso'), { announce: [] }, r));
    await until(() => seeder.torrentPort, 5000, 'seeder port');

    const [t] = mgr.add([{ kind: 'torrent', source: seeded.magnetURI, via: 'p2p' }]);
    await until(() => mgr.torrents.active.has(t.id), 5000, 'torrent start');
    mgr.torrents.addPeer(t.id, `127.0.0.1:${seeder.torrentPort}`);
    await until(() => t.status === 'completed', 30000, 'torrent completion');
    assert.equal(sha(fs.readFileSync(path.join(tmp, 'dl', 'linux.iso'))), sha(content));
    assert.equal(t.name, 'linux.iso');
    // fast-resume: a restart trusts the saved piece map, unless a file changed since it was saved
    assert.ok(t.resume?.bitfield, 'fast-resume data saved when the torrent stopped');
    mgr.seed(t.id);
    assert.equal(t.fastResumed, true, 'restart skipped the full re-check');
    await until(() => t.status === 'completed', 15000, 'seed stop');
    const isoPath = path.join(tmp, 'dl', 'linux.iso');
    fs.utimesSync(isoPath, new Date(), new Date(Date.now() + 5000));
    mgr.seed(t.id);
    assert.equal(t.fastResumed, false, 'a changed file forces a full re-check');
    await until(() => t.status === 'completed', 15000, 'seed stop 2');
    ok('fast-resume: restart skips the re-check; a modified file triggers a full check');
    const wire = seeded.wires[0];
    ok(`P2P torrent downloaded from local peer, hash matches${wire ? `; seeder saw peer ID ${Buffer.from(wire.peerId, 'hex').toString().slice(0, 8)}` : ''}`);

    // Selective download: a 2-file torrent where only the second file is picked.
    const packDir = path.join(seedDir, 'Season Pack');
    fs.mkdirSync(packDir);
    const ep1 = crypto.randomBytes(2 * 1024 * 1024 + 123);
    const ep2 = crypto.randomBytes(2 * 1024 * 1024 + 777);
    fs.writeFileSync(path.join(packDir, 'ep1.mkv'), ep1);
    fs.writeFileSync(path.join(packDir, 'ep2.mkv'), ep2);
    const pack = await new Promise(r => seeder.seed(packDir, { announce: [] }, r));
    const meta = await mgr.torrents.fetchMetadata({ torrentB64: Buffer.from(pack.torrentFile).toString('base64') });
    assert.equal(meta.files.length, 2);
    const pick = meta.files.findIndex(f => f.path.endsWith('ep2.mkv'));
    const [sp] = mgr.add([{ kind: 'torrent', via: 'p2p', source: pack.magnetURI, torrentB64: meta.torrentB64, files: meta.files, selectedFiles: [pick], dir: path.join(tmp, 'picked') }]);
    await until(() => mgr.torrents.active.has(sp.id), 5000, 'pack start');
    mgr.torrents.addPeer(sp.id, `127.0.0.1:${seeder.torrentPort}`);
    await until(() => sp.status === 'completed', 30000, 'selective completion');
    assert.equal(sha(fs.readFileSync(path.join(tmp, 'picked', 'Season Pack', 'ep2.mkv'))), sha(ep2));
    const ep1Path = path.join(tmp, 'picked', 'Season Pack', 'ep1.mkv');
    // Files may be pre-sized on disk, so compare content: only the boundary piece shared with ep2 may be real data.
    const onDisk = fs.existsSync(ep1Path) ? fs.readFileSync(ep1Path) : Buffer.alloc(0);
    let real = 0;
    for (let i = 0; i < Math.min(onDisk.length, ep1.length); i++) if (onDisk[i] === ep1[i] && ep1[i] !== 0) real++;
    assert.ok(real < ep1.length * 0.2, `unselected file was downloaded (${real} matching bytes)`);
    assert.equal(sp.size, ep2.length);
    ok(`file picker: fetched metadata, downloaded only ep2.mkv (ep1 has ${(real / 1024).toFixed(0)} KB of real data, i.e. just the shared boundary piece)`);
    // Tiny files sharing one piece (like big ROM collections): pick the middle one. Deselecting its neighbours
    // used to drop the shared piece, so nothing downloaded.
    const tinyDir = path.join(seedDir, 'Tiny');
    fs.mkdirSync(tinyDir);
    const tiny = ['a.bin', 'b.bin', 'c.bin'].map(n => [n, crypto.randomBytes(5000)]);
    for (const [n, b] of tiny) fs.writeFileSync(path.join(tinyDir, n), b);
    const tp = await new Promise(r => seeder.seed(tinyDir, { announce: [], pieceLength: 16384 }, r));
    const tmeta = await mgr.torrents.fetchMetadata({ torrentB64: Buffer.from(tp.torrentFile).toString('base64') });
    const mid = tmeta.files.findIndex(f => f.path.endsWith('b.bin'));
    const [tt] = mgr.add([{ kind: 'torrent', via: 'p2p', source: tp.magnetURI + '&so=' + mid, torrentB64: tmeta.torrentB64, files: tmeta.files, selectedFiles: [mid], dir: path.join(tmp, 'tiny') }]);
    await until(() => mgr.torrents.active.has(tt.id), 5000, 'tiny start');
    mgr.torrents.addPeer(tt.id, `127.0.0.1:${seeder.torrentPort}`);
    await until(() => tt.status === 'completed', 30000, 'shared-piece completion');
    assert.equal(sha(fs.readFileSync(path.join(tmp, 'tiny', 'Tiny', 'b.bin'))), sha(tiny[1][1]));
    assert.equal(tt.name, 'b.bin', 'single pick is named after the file');
    ok('file picker: a file sharing its piece with unselected neighbours still downloads, named after the file');
    await new Promise(r => seeder.destroy(r));
  }

  // ---- 4. debrid hand-off (fake provider standing in for TorBox / Real-Debrid) ----
  {
    let polls = 0;
    mgr.provider = () => ({
      name: 'FakeDebrid',
      async resolveTorrent(job, { onProgress, onRemoteId }) {
        onRemoteId('remote-1');
        for (; polls < 3; polls++) {
          onProgress({ progress: polls / 3, state: 'downloading', speed: 1e6 });
          await wait(100);
        }
        return [
          { url: `${base}/files/part1.bin`, filename: 'part1.bin', size: payload.length },
          { url: `${base}/files/part2.bin`, filename: 'part2.bin', size: payload.length },
        ];
      },
    });
    const [d] = mgr.add([{ kind: 'torrent', source: 'magnet:?xt=urn:btih:' + 'ab'.repeat(20) + '&dn=Pack', via: 'torbox' }]);
    await until(() => d.status === 'handed-off', 10000, 'debrid resolve');
    assert.equal(d.remoteId, 'remote-1');
    const kids = [...mgr.items.values()].filter(i => i.parentId === d.id);
    assert.equal(kids.length, 2);
    await until(() => kids.every(k => k.status === 'completed'), 30000, 'debrid children');
    assert.equal(sha(fs.readFileSync(path.join(tmp, 'dl', 'Pack', 'part2.bin'))), sha(payload));
    ok('debrid job: cloud progress → 2 direct downloads into package folder');
  }

  // ---- 5. persistence ----
  await mgr.save(true);
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'), 'utf8'));
  assert.ok(saved.items.length >= 5);
  ok(`state persisted (${saved.items.length} items)`);
  console.log(`\nAll smoke tests passed (${rangeRequests} range requests served).`);
} finally {
  await mgr.shutdown();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
