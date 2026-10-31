// Tests for the qBittorrent-style extras: RSS parsing/rules, Torznab search, link resolving, scheduler, categories.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseFeed, matcher, ruleMatches, FeedService, search, loadSearchPlugins, resolveTorrentLink } = require('../src/engine/feeds.js');
const { parseLinks, selectOnlyFromMagnet } = require('../src/linkparse.js');
const { Manager } = require('../src/engine/manager.js');
const ok = msg => console.log('  ✓', msg);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakobu-feeds-'));

const HASH = 'ab'.repeat(20);
const rss = `<?xml version="1.0"?><rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Test Tracker</title>
<item><title>My Show S01E01 1080p WEB</title><guid>g1</guid><link>https://x.test/1.torrent</link><pubDate>Tue, 01 Oct 2024 10:00:00 GMT</pubDate>
  <enclosure url="https://x.test/1.torrent" length="1500000000" type="application/x-bittorrent"/>
  <torznab:attr name="seeders" value="120"/><torznab:attr name="peers" value="140"/><torznab:attr name="infohash" value="${HASH}"/></item>
<item><title><![CDATA[My Show S01E02 720p WEB]]></title><guid>g2</guid><link>magnet:?xt=urn:btih:${'cd'.repeat(20)}&amp;dn=ep2</link>
  <torznab:attr name="seeders" value="3"/></item>
<item><title>Other Thing 1080p</title><guid>g3</guid><enclosure url="https://x.test/3.torrent" length="10"/><torznab:attr name="seeders" value="40"/></item>
</channel></rss>`;
const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Feed</title>
<entry><title>Linux ISO weekly</title><id>tag:a,1</id><link href="https://a.test/linux.torrent"/><updated>2024-10-01T00:00:00Z</updated></entry></feed>`;

// ---- parsing ----
{
  const f = parseFeed(rss);
  assert.equal(f.title, 'Test Tracker');
  assert.equal(f.items.length, 3);
  assert.equal(f.items[0].seeders, 120);
  assert.equal(f.items[0].size, 1500000000);
  assert.equal(f.items[0].torrentUrl, 'https://x.test/1.torrent');
  assert.equal(f.items[0].infoHash, HASH);
  assert.equal(f.items[1].title, 'My Show S01E02 720p WEB');
  assert.ok(f.items[1].magnet.startsWith('magnet:?xt=urn:btih:cdcd') && f.items[1].magnet.includes('&dn=ep2'));
  const a = parseFeed(atom);
  assert.equal(a.title, 'Atom Feed');
  assert.equal(a.items[0].link, 'https://a.test/linux.torrent');
  ok('RSS 2.0 + Torznab attrs + CDATA + Atom parsing');
}

// ---- matching ----
{
  assert.ok(matcher('my show 1080p')('My.Show.S01E01.1080p'), 'each word is a case-insensitive substring');
  assert.ok(matcher('show 1080p')('My Show S01E01 1080p'));
  assert.ok(!matcher('show 1080p')('My Show S01E02 720p'));
  assert.ok(matcher('720p|1080p')('x 720p'));
  assert.ok(matcher('S01E*')('show S01E05'));
  assert.ok(matcher('S0[12]', true)('S02'));
  assert.ok(ruleMatches({ mustContain: 'show', mustNotContain: '720p' }, 'My Show 1080p'));
  assert.ok(!ruleMatches({ mustContain: 'show', mustNotContain: '720p' }, 'My Show 720p'));
  assert.ok(!ruleMatches({ mustContain: '' }, 'anything'), 'empty rule matches nothing');
  ok('qBittorrent-style matching: AND / OR / wildcards / regex / must-not');
}

// ---- local server: feed, torrent redirects, torznab ----
let lastApiKey = null;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/feed.xml') return res.end(rss);
  if (u.pathname === '/to-magnet') {
    res.writeHead(302, { Location: `magnet:?xt=urn:btih:${HASH}` });
    return res.end();
  }
  if (u.pathname === '/hop') {
    res.writeHead(301, { Location: '/file.torrent' });
    return res.end();
  }
  if (u.pathname === '/file.torrent') return res.end(Buffer.from('d4:infod4:name4:testee'));
  if (u.pathname === '/html') return res.end('<html>nope</html>');
  if (u.pathname.endsWith('/api')) {
    lastApiKey = u.searchParams.get('apikey');
    assert.equal(u.searchParams.get('t'), 'search');
    return res.end(rss);
  }
  res.writeHead(404).end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  // ---- link resolving ----
  {
    assert.deepEqual(await resolveTorrentLink(`${base}/to-magnet`), { source: `magnet:?xt=urn:btih:${HASH}` });
    const t = await resolveTorrentLink(`${base}/hop`);
    assert.equal(Buffer.from(t.torrentB64, 'base64').toString(), 'd4:infod4:name4:testee');
    await assert.rejects(resolveTorrentLink(`${base}/html`), /did not return a \.torrent/);
    ok('Jackett-style links: redirect → magnet, redirect → .torrent, HTML rejected');
  }

  // ---- RSS service + auto-download rule ----
  {
    const grabbed = [];
    const svc = new FeedService({ file: path.join(tmp, 'rss.json'), onDownload: (a, r) => grabbed.push([a.title, r.name]) });
    const feed = await svc.addFeed(`${base}/feed.xml`);
    assert.equal(feed.name, 'Test Tracker');
    assert.equal(feed.articles.length, 3);
    const rule = svc.saveRule({ name: 'Show HD', mustContain: 'show 1080p', mustNotContain: '720p' });
    assert.deepEqual(grabbed, [['My Show S01E01 1080p WEB', 'Show HD']]);
    assert.deepEqual(svc.preview(rule), ['My Show S01E01 1080p WEB']);
    await svc.refresh(feed.id); // same articles again → nothing new
    svc.applyRules();
    assert.equal(grabbed.length, 1, 'already-downloaded articles are not grabbed twice');
    svc.saveRule({ name: 'Off', enabled: false, mustContain: '*' });
    assert.equal(grabbed.length, 1, 'disabled rules do nothing');
    svc.stop();
    const reloaded = new FeedService({ file: path.join(tmp, 'rss.json'), onDownload: (a) => grabbed.push([a.title]) });
    reloaded.applyRules();
    reloaded.stop();
    assert.equal(grabbed.length, 1, 'seen list survives restart');
    assert.equal(reloaded.rules.length, 2);
    ok('RSS feed + rule auto-downloads only new matches, persists across restart');
  }

  // ---- Torznab search ----
  {
    const r = await search([{ name: 'Local Jackett', url: `${base}/api/v2.0/indexers/all/results/torznab`, apikey: 'k123' }, { name: 'Dead', url: 'http://127.0.0.1:1/api' }], 'my show');
    assert.equal(lastApiKey, 'k123');
    assert.deepEqual(r.items.map(i => i.seeders), [120, 40, 3]);
    assert.equal(r.items[0].provider, 'Local Jackett');
    assert.equal(r.errors.length, 1);
    await assert.rejects(search([], 'x'), /Add a Jackett or Prowlarr/);
    ok('Torznab search: merges providers, sorts by seeders, reports failing providers');
  }

  // ---- local search plugins + magnet so= ----
  {
    const dir = path.join(tmp, 'plugins');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'demo.js'), `module.exports = { name: 'Demo', search: async q => [{ title: q + '.zip', magnet: 'magnet:?xt=urn:btih:' + 'cd'.repeat(20) + '&so=7', selectedFiles: [7] }] };`);
    fs.writeFileSync(path.join(dir, 'broken.js'), 'this is not javascript (');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    const plugins = loadSearchPlugins(dir);
    assert.deepEqual(plugins.map(p => p.name), ['Demo'], 'broken plugin skipped, non-.js ignored');
    assert.deepEqual(loadSearchPlugins(path.join(tmp, 'missing')), []);
    const r = await search([], 'sonic', plugins);
    assert.equal(r.items[0].title, 'sonic.zip');
    assert.equal(r.items[0].provider, 'Demo');
    assert.deepEqual(selectOnlyFromMagnet('magnet:?xt=urn:btih:x&so=0,2,4-6'), [0, 2, 4, 5, 6]);
    assert.equal(selectOnlyFromMagnet('magnet:?xt=urn:btih:x'), null);
    assert.deepEqual(parseLinks(r.items[0].magnet)[0].selectedFiles, [7]);
    ok('search plugins from the profile folder (broken ones skipped), magnet so= picks files');
  }

  // ---- scheduler + categories + per-item options (no network) ----
  {
    const m = new Manager({ statePath: null, settings: { downloadDir: path.join(tmp, 'dl'), categories: { Movies: path.join(tmp, 'movies') } } });
    m.settings.schedule = { enabled: true, from: '22:00', to: '06:00', days: [0, 1, 2, 3, 4, 5, 6] };
    const at = (h, mi = 0) => new Date(2024, 9, 1, h, mi);
    assert.equal(m.altLimitsOn(at(23)), true);
    assert.equal(m.altLimitsOn(at(3)), true);
    assert.equal(m.altLimitsOn(at(12)), false);
    m.settings.schedule = { enabled: true, from: '09:00', to: '17:30', days: [1] }; // Monday only
    assert.equal(m.altLimitsOn(new Date(2024, 9, 7, 10)), true); // Mon
    assert.equal(m.altLimitsOn(new Date(2024, 9, 8, 10)), false); // Tue
    m.settings.schedule.enabled = false;
    m.settings.altActive = true;
    assert.equal(m.altLimitsOn(at(12)), true);

    m.schedule = () => {}; // don't start anything
    const [it] = m.add([{ kind: 'http', source: 'http://x.test/a.bin', category: 'Movies', tags: ['hd'] }]);
    assert.equal(it.dir, path.join(tmp, 'movies'));
    assert.deepEqual(it.tags, ['hd']);
    await m.update(it.id, { category: '', tags: ['a', 'b'], limitKB: 300, bogus: 1 });
    assert.equal(it.category, '');
    assert.equal(it.limitKB, 300);
    assert.equal(it.bogus, undefined);
    m.setCategories({});
    clearTimeout(m.pendingEmit);
    ok('speed schedule (incl. past midnight, weekdays, manual turtle), categories → folder, item options');
  }
  console.log('\nAll feed/search/scheduler tests passed.');
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
