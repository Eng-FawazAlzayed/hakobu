// Stability regressions: failed segments stop together, saves never throw or overlap,
// damaged state files are kept, and removing a vanished torrent never hangs.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HttpTask, RateLimiter } = require('../src/engine/http.js');
const { Manager, loadItems, readJsonSafe } = require('../src/engine/manager.js');
const { TorrentEngine } = require('../src/engine/torrent.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakobu-stability-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const ok = msg => console.log('  ✓', msg);

// ---- 1. one dead connection stops the whole download, no requests after it failed ----
{
  const SIZE = 8 * 1024 * 1024;
  let requests = 0;
  const srv = http.createServer((req, res) => {
    requests++;
    const [, s, e] = /bytes=(\d+)-(\d*)/.exec(req.headers.range || 'bytes=0-');
    const start = +s, end = e ? +e : SIZE - 1;
    if (start >= SIZE / 2) {
      res.writeHead(500);
      return res.end();
    }
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${SIZE}`, 'content-length': end - start + 1 });
    let sent = start;
    const iv = setInterval(() => {
      if (sent > end) return clearInterval(iv), res.end();
      const n = Math.min(1024, end - sent + 1);
      res.write(Buffer.alloc(n));
      sent += n;
    }, 20); // slow, so this segment is still running when the other gives up
    res.on('close', () => clearInterval(iv));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const it = { source: `http://127.0.0.1:${srv.address().port}/f.bin`, dir: path.join(tmp, 'seg'), suggestedName: 'f.bin' };
  const task = new HttpTask(it, { limiter: new RateLimiter(), connections: 2, taken: new Set() });
  task.retryBaseMs = 5;
  await assert.rejects(task.run(), /HTTP 500/);
  const atFailure = requests;
  const downloaded = it.downloaded;
  await wait(1500);
  assert.equal(requests, atFailure, 'no reconnects after the download failed');
  assert.equal(it.downloaded, downloaded, 'nothing written after the download failed');
  srv.close();
  srv.closeAllConnections?.();
  ok('a failed segment stops the other connections before the download reports the error');
}

// ---- 2. saves never throw, never overlap, and stay dirty after a failure ----
{
  const dir = path.join(tmp, 'save');
  fs.mkdirSync(dir);
  const statePath = path.join(dir, 'downloads.json');
  const m = new Manager({ statePath, items: [{ id: 'a', status: 'completed', createdAt: 1 }], torrentOptions: {} });
  m.dirty = true;
  await Promise.all([m.save(true), m.save(true), m.save(true)]); // overlapping saves share one temp file
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).items[0].id, 'a');
  m.statePath = path.join(dir, 'missing-dir-is-a-file', 'downloads.json');
  fs.writeFileSync(path.join(dir, 'missing-dir-is-a-file'), 'x'); // mkdir will fail: ENOTDIR / EEXIST
  m.dirty = true;
  await m.save(); // must not throw
  assert.equal(m.dirty, true, 'still dirty after a failed save');
  ok('saves run one at a time, never throw, and retry after a failed write');
}

// ---- 3. a damaged state file is kept aside, not silently overwritten ----
{
  const dir = path.join(tmp, 'corrupt');
  fs.mkdirSync(dir);
  const f = path.join(dir, 'downloads.json');
  fs.writeFileSync(f, '{"items":[{"id":"x"'); // cut off mid-write
  const backups = [];
  assert.deepEqual(loadItems(f, b => backups.push(b)), []);
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(backups[0], 'utf8'), '{"items":[{"id":"x"');
  fs.writeFileSync(f + '.tmp', JSON.stringify({ items: [{ id: 'from-tmp' }] }));
  assert.equal(loadItems(f)[0].id, 'from-tmp', 'falls back to the last complete temp copy');
  fs.rmSync(f);
  assert.equal(readJsonSafe(f).items[0].id, 'from-tmp', 'crash between write and rename recovers the temp copy');
  ok('damaged downloads.json is backed up and the last good copy is used');
}

// ---- 4. stopping a torrent WebTorrent already dropped returns instead of hanging ----
{
  const eng = new TorrentEngine();
  const gone = { wires: [] };
  eng.client = {
    torrents: [],
    remove: async () => {
      throw new Error('No torrent with id');
    },
  };
  eng.active.set('t1', gone);
  const res = await Promise.race([eng.stop('t1').then(() => 'done'), wait(3000).then(() => 'hung')]);
  assert.equal(res, 'done');
  const listed = { wires: [] };
  eng.client = { torrents: [listed], remove: async () => { throw new Error('boom'); } };
  eng.active.set('t2', listed);
  assert.equal(await Promise.race([eng.stop('t2').then(() => 'done'), wait(3000).then(() => 'hung')]), 'done');
  ok('stopping an errored or vanished torrent finishes instead of waiting forever');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nAll stability tests passed.');
process.exit(0);
