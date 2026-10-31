// Archive extraction tests: archives are created with the bundled 7-Zip, then extracted by the engine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractAll, isFirstVolume, volumesOf, path7za } = require('../src/engine/extract.js');
const { packageName } = require('../src/engine/linkcheck.js');
const ok = msg => console.log('  ✓', msg);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakobu-extract-'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const z = (...args) => execFileSync(path7za(), args, { stdio: 'pipe' });

try {
  // naming helpers
  assert.ok(isFirstVolume('a.part1.rar') && isFirstVolume('a.part01.rar') && !isFirstVolume('a.part2.rar'));
  assert.ok(isFirstVolume('a.rar') && !isFirstVolume('a.r00') && isFirstVolume('b.7z.001') && !isFirstVolume('b.7z.002'));
  assert.ok(isFirstVolume('c.zip') && !isFirstVolume('movie.mkv'));
  assert.deepEqual(volumesOf('/d/Show.part1.rar', ['Show.part1.rar', 'Show.part2.rar', 'Other.part1.rar']).map(p => path.basename(p)), ['Show.part1.rar', 'Show.part2.rar']);
  assert.deepEqual(volumesOf('/d/x.rar', ['x.rar', 'x.r00', 'x.r01', 'xy.rar']).map(p => path.basename(p)), ['x.rar', 'x.r00', 'x.r01']);
  assert.equal(packageName('My.Show.S01.part03.rar'), 'My.Show.S01');
  assert.equal(packageName('backup.7z.001'), 'backup');
  assert.equal(packageName('Movie CD2.avi'), 'Movie');
  assert.equal(packageName('Movie.2010.1080p.mkv'), 'Movie.2010.1080p');
  ok('archive volume detection + automatic package names');

  // source files
  const src = path.join(tmp, 'src');
  fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
  const big = crypto.randomBytes(3 * 1024 * 1024);
  fs.writeFileSync(path.join(src, 'big.bin'), big);
  fs.writeFileSync(path.join(src, 'sub', 'notes.txt'), 'hello hakobu');
  const dl = path.join(tmp, 'dl');
  fs.mkdirSync(dl);
  z('a', '-tzip', path.join(dl, 'plain.zip'), path.join(src, '*'));
  z('a', '-t7z', '-psecret', '-mhe=on', path.join(dl, 'locked.7z'), path.join(src, '*'));
  z('a', '-t7z', '-v1m', path.join(dl, 'split.7z'), path.join(src, 'big.bin'));
  z('a', '-t7z', '-pnope', path.join(dl, 'unknown.7z'), path.join(src, 'sub', 'notes.txt'));
  const names = fs.readdirSync(dl);
  assert.ok(names.includes('split.7z.001') && names.includes('split.7z.003'));

  const states = {};
  const res = await extractAll(dl, names, { subfolder: true, deleteAfter: true, passwords: ['wrong', 'secret'], onState: (n, s) => (states[n] = s) });
  const byName = Object.fromEntries(res.map(r => [r.name, r]));

  assert.ok(byName['plain.zip'].ok);
  assert.equal(sha(fs.readFileSync(path.join(dl, 'plain', 'big.bin'))), sha(big));
  assert.equal(fs.readFileSync(path.join(dl, 'plain', 'sub', 'notes.txt'), 'utf8'), 'hello hakobu');
  ok('ZIP extracted into its own subfolder, contents match');

  assert.ok(byName['locked.7z'].ok);
  assert.equal(states['locked.7z'].password, 'secret');
  assert.equal(sha(fs.readFileSync(path.join(dl, 'locked', 'big.bin'))), sha(big));
  ok('encrypted 7z (encrypted headers too): password list tried, "secret" worked');

  assert.ok(byName['split.7z.001'].ok);
  assert.equal(sha(fs.readFileSync(path.join(dl, 'split', 'big.bin'))), sha(big));
  assert.ok(!fs.existsSync(path.join(dl, 'split.7z.002')), 'all volumes deleted after extraction');
  ok('split 7z (.001/.002/.003) extracted and all volumes cleaned up');

  assert.equal(byName['unknown.7z'].ok, false);
  assert.equal(states['unknown.7z'].state, 'password');
  assert.ok(fs.existsSync(path.join(dl, 'unknown.7z')), 'failed archive is kept');
  ok('unknown password reported (state "password"), archive kept');
  // RAR: no RAR creator exists offline, so build a RAR 4 archive with one stored (uncompressed) file by hand.
  {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
    const crc32 = buf => {
      let c = 0xffffffff;
      for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    const block = body => {
      const head = Buffer.alloc(2);
      head.writeUInt16LE(crc32(body) & 0xffff);
      return Buffer.concat([head, body]);
    };
    const data = Buffer.from('stored inside a hand-made RAR\n'.repeat(500));
    const name = Buffer.from('inside.txt');
    const main = Buffer.alloc(11);
    main.writeUInt8(0x73, 0);
    main.writeUInt16LE(13, 3);
    const fh = Buffer.alloc(30 + name.length);
    fh.writeUInt8(0x74, 0);
    fh.writeUInt16LE(0x8000, 1);
    fh.writeUInt16LE(32 + name.length, 3);
    fh.writeUInt32LE(data.length, 5); // packed
    fh.writeUInt32LE(data.length, 9); // unpacked
    fh.writeUInt8(2, 13); // host OS: Windows
    fh.writeUInt32LE(crc32(data), 14);
    fh.writeUInt32LE(0x5a210000, 18); // DOS time
    fh.writeUInt8(20, 22); // version needed
    fh.writeUInt8(0x30, 23); // method: store
    fh.writeUInt16LE(name.length, 24);
    fh.writeUInt32LE(0x20, 26);
    name.copy(fh, 30);
    const end = Buffer.from([0x7b, 0x00, 0x40, 0x07, 0x00]);
    const rar = Buffer.concat([Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]), block(main), block(fh), data, block(end)]);
    const rdir = path.join(tmp, 'rar');
    fs.mkdirSync(rdir);
    fs.writeFileSync(path.join(rdir, 'Handmade.rar'), rar);
    const [r] = await extractAll(rdir, ['Handmade.rar'], { subfolder: true });
    assert.ok(r.ok, r.error);
    assert.equal(fs.readFileSync(path.join(rdir, 'Handmade', 'inside.txt'), 'utf8'), data.toString());
    ok('RAR extracted through the unrar engine (hand-built RAR 4 archive)');
  }
  console.log('\nAll extraction tests passed.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
