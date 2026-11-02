// Media (yt-dlp) + tool manager tests. No YouTube traffic: a test video is generated with ffmpeg and served locally.
// Needs installed tools; set HAKOBU_TOOLS to a folder with yt-dlp.exe, deno.exe, ffmpeg.exe, ffprobe.exe
// (defaults to %LOCALAPPDATA%\Temp\hakobu-tools-test). Tool-dependent parts are skipped if missing.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ToolManager, cmpVersion, download } = require('../src/engine/tools.js');
const { MediaTask, isMediaUrl, youtubeId, friendlyError, buildArgs } = require('../src/engine/media.js');
const { YoutubeCookies, sanitize, toNetscape } = require('../src/engine/ytcookies.js');
const { parseLinks } = require('../src/linkparse.js');
const { Manager } = require('../src/engine/manager.js');
const ok = msg => console.log('  ✓', msg);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakobu-media-'));
const toolsDir = process.env.HAKOBU_TOOLS || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'hakobu-tools-test');
const tools = new ToolManager(toolsDir);

// ---- link classification + helpers ----
{
  const e = parseLinks('https://www.youtube.com/watch?v=jNQXAC9IVRw https://youtu.be/dQw4w9WgXcQ https://www.youtube.com/playlist?list=PLx https://vimeo.com/123 https://example.com/f.mp4');
  assert.deepEqual(e.map(x => x.kind), ['media', 'media', 'media', 'media', 'http']);
  assert.equal(e[2].playlist, true);
  assert.equal(e[0].playlist, false);
  assert.equal(youtubeId('https://www.youtube.com/shorts/abcdefghijk'), 'abcdefghijk');
  assert.equal(youtubeId('https://youtu.be/jNQXAC9IVRw?t=3'), 'jNQXAC9IVRw');
  assert.ok(isMediaUrl('https://m.youtube.com/watch?v=x') && isMediaUrl('https://music.youtube.com/watch?v=x') && !isMediaUrl('https://example.org/'));
  assert.match(friendlyError("ERROR: [youtube] x: Sign in to confirm you're not a bot"), /not a bot/);
  assert.match(friendlyError('ERROR: unable to download video data: HTTP Error 429: Too Many Requests'), /rate-limiting/);
  assert.match(friendlyError('ERROR: [youtube] x: Private video. Sign in if you have been granted access'), /private/);
  assert.match(friendlyError('ERROR: [youtube] x: Video unavailable'), /unavailable/);
  assert.equal(friendlyError('WARNING: x\nERROR: something odd happened'), 'something odd happened');
  ok('YouTube/media links detected (videos, shorts, playlists), friendly error messages');
}

// ---- yt-dlp options match the handover ----
{
  const t = { dir: 'C:\\T', path: f => 'C:\\T\\' + f };
  const mp3 = buildArgs({ source: 'https://youtu.be/x', dir: 'C:\\D', mediaFormat: 'mp3', mediaQuality: '320' }, { tools: t, settings: {} });
  const s3 = mp3.join(' ');
  assert.ok(s3.includes('-f bestaudio/best -x --audio-format mp3 --audio-quality 320K'));
  assert.ok(s3.includes('--js-runtimes deno:C:\\T\\deno.exe') && s3.includes('--ffmpeg-location C:\\T'));
  assert.ok(s3.includes('--embed-thumbnail --convert-thumbnails jpg') && s3.includes('--embed-metadata') && s3.includes('--no-playlist'));
  assert.ok(s3.includes('%(playlist_title&{}/|)s%(title)s.%(ext)s'));
  assert.equal(mp3.at(-1), 'https://youtu.be/x');
  assert.equal(mp3.at(-2), '--', 'URL after -- so it is never read as an option');
  const mp4 = buildArgs({ source: 'u', dir: 'D', mediaFormat: 'mp4', mediaQuality: '720', playlist: true }, { tools: t, settings: { ytCookiesBrowser: 'firefox' } }).join(' ');
  assert.ok(mp4.includes('bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]/b') && mp4.includes('--merge-output-format mp4'));
  assert.ok(!mp4.includes('--no-playlist') && mp4.includes('--cookies-from-browser firefox'));
  ok('yt-dlp options: MP3 + cover art/tags, MP4 height cap with mp4+m4a remux, Deno, playlists, cookies');
}

// ---- YouTube sign-in shared by the extension ----
{
  const dir = path.join(tmp, 'signin');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'youtube-signin.dat');
  const crypt = { encrypt: s => Buffer.from(s).reverse(), decrypt: b => Buffer.from(b).reverse().toString() };
  const yc = new YoutubeCookies({ file, tempDir: path.join(dir, 'tmp'), ...crypt });
  const auth = { domain: '.youtube.com', path: '/', secure: true, expirationDate: 1900000000.5, name: 'SAPISID', value: 'abc' };
  assert.deepEqual(sanitize([auth, { ...auth, domain: '.google.com' }, { ...auth, domain: 'youtube.com.evil.test' }, { ...auth, name: 'x\ny' }]).length, 1, 'only well-formed youtube.com cookies');
  assert.equal(yc.set([{ ...auth, name: 'PREF' }], 'Brave').signedIn, false, 'a signed-out browser is not a sign-in');
  assert.equal(yc.set([auth, { domain: 'www.youtube.com', name: 'PREF', value: 'p' }], 'Brave').signedIn, true);
  assert.ok(!fs.readFileSync(file).toString().includes('SAPISID'), 'not plain text on disk');
  const again = new YoutubeCookies({ file, tempDir: path.join(dir, 'tmp'), ...crypt });
  assert.equal(again.status().browser, 'Brave', 'survives a restart');
  const t = again.tempFile();
  const text = fs.readFileSync(t.file, 'utf8');
  assert.ok(text.startsWith('# Netscape HTTP Cookie File\n'));
  assert.ok(text.includes('.youtube.com\tTRUE\t/\tTRUE\t1900000000\tSAPISID\tabc') && text.includes('www.youtube.com\tFALSE\t/\tFALSE\t0\tPREF\tp'));
  const leftover = t.file;
  new YoutubeCookies({ file, tempDir: path.join(dir, 'tmp'), ...crypt });
  assert.ok(!fs.existsSync(leftover), 'a cookies.txt left by a killed app is wiped at start');
  const t2 = yc.tempFile();
  t2.remove();
  assert.ok(!fs.existsSync(t2.file));
  yc.clear();
  assert.ok(!fs.existsSync(file) && yc.tempFile() === null);

  const tt = { dir: 'C:\\T', path: f => 'C:\\T\\' + f };
  const it = { source: 'https://youtu.be/x', dir: 'D' };
  const withFile = buildArgs(it, { tools: tt, settings: { ytCookiesBrowser: 'extension' }, cookieFile: 'C:\\c.txt' }).join(' ');
  assert.ok(withFile.includes('--cookies C:\\c.txt') && !withFile.includes('--cookies-from-browser'));
  assert.ok(!buildArgs(it, { tools: tt, settings: { ytCookiesBrowser: 'extension' } }).join(' ').includes('--cookies'), '"extension" is not a browser name for yt-dlp');
  assert.match(friendlyError('ERROR: [youtube] x: Sign in to confirm you\u2019re not a bot'), /Share my YouTube sign-in/);
  assert.match(friendlyError('ERROR: [youtube] x: Sign in to confirm you\u2019re not a bot', { usedSignIn: true }), /may have expired/);
  assert.match(friendlyError('ERROR: Could not copy Chrome cookie database. See https://x for more info'), /can't read this browser's cookies/);

  // yt-dlp reads the file and sends the cookies (a local cookie, so no YouTube traffic)
  if (tools.installed('yt-dlp')) {
    const seen = [];
    const srv = http.createServer((req, res) => {
      seen.push(req.headers.cookie || '');
      res.writeHead(404);
      res.end();
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const jar = path.join(dir, 'jar.txt');
    fs.writeFileSync(jar, toNetscape([{ domain: '127.0.0.1', path: '/', secure: false, expires: 0, name: 'SAPISID', value: 'abc' }]));
    await new Promise(r => execFile(tools.path('yt-dlp.exe'), ['--cookies', jar, '--simulate', '--no-warnings', `http://127.0.0.1:${srv.address().port}/v.mp4`], { windowsHide: true }, () => r()));
    srv.close();
    assert.ok(seen.some(c => c.includes('SAPISID=abc')), `yt-dlp sent the cookie (saw: ${seen.join(' | ')})`);
  }
  ok('YouTube sign-in: only youtube.com, encrypted at rest, temp cookies.txt removed, yt-dlp reads it, clear error messages');
}

// ---- tool downloads: checksum enforcement + resume ----
const payload = crypto.randomBytes(300000);
let drops = 1;
let lastRange = null;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/tool.bin') {
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    lastRange = m ? +m[1] : null;
    const start = m ? +m[1] : 0;
    res.writeHead(m ? 206 : 200, { 'Content-Length': payload.length - start, ...(m ? { 'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}` } : {}) });
    if (drops-- > 0) {
      res.write(payload.subarray(start, start + 100000));
      return setTimeout(() => res.destroy(), 20);
    }
    return res.end(payload.subarray(start));
  }
  if (u.pathname === '/clip.mp4') return fs.createReadStream(path.join(tmp, 'clip.mp4')).pipe(res);
  res.writeHead(404).end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  {
    const good = crypto.createHash('sha256').update(payload).digest('hex');
    await download(`${base}/tool.bin`, path.join(tmp, 'tool.bin'), good);
    assert.equal(lastRange, 100000, 'resumed from where the connection dropped');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(tmp, 'tool.bin'))).digest('hex'), good);
    await assert.rejects(download(`${base}/tool.bin`, path.join(tmp, 'evil.bin'), '0'.repeat(64)), /Checksum mismatch/);
    assert.ok(!fs.existsSync(path.join(tmp, 'evil.bin')) && !fs.existsSync(path.join(tmp, 'evil.bin.part')), 'rejected download removed');
    assert.ok(cmpVersion('2026.10.26', '2026.9.30') > 0 && cmpVersion('2.9.8', '2.10.0') < 0 && cmpVersion('9.0.2', '9.0.2') === 0);
    ok('tool downloads: resume after a dropped connection, SHA-256 enforced (bad file never kept), version compare');
  }

  if (!tools.ready()) {
    ok(`media pipeline skipped: tools not found in ${toolsDir}`);
  } else {
    const st = await tools.status();
    assert.ok(st['yt-dlp'].version && st.deno.version && st.ffmpeg.version);
    // a 4-second test clip, made locally
    execFileSync(tools.path('ffmpeg.exe'), ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(tmp, 'clip.mp4')]);

    const out = path.join(tmp, 'out');
    const it = { source: `${base}/clip.mp4`, dir: out, mediaFormat: 'mp3', mediaQuality: '192' };
    const stages = new Set();
    const timer = setInterval(() => it.stage && stages.add(it.stage), 20);
    await new MediaTask(it, { tools, settings: {} }).run();
    clearInterval(timer);
    assert.equal(it.files.length, 1);
    assert.ok(it.files[0].endsWith('clip.mp3') && fs.statSync(it.files[0]).size > 20000);
    const probe = execFileSync(tools.path('ffprobe.exe'), ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', it.files[0]]).toString();
    assert.match(probe, /mp3/);
    assert.ok(stages.has('Converting to MP3'), 'stage shown: ' + [...stages].join(', '));
    ok(`real pipeline (yt-dlp ${st['yt-dlp'].version}, Deno ${st.deno.version}, ffmpeg ${st.ffmpeg.version}): video → MP3, stages: ${[...stages].join(' → ')}`);

    // through the manager queue, MP4 this time
    const m = new Manager({ statePath: null, settings: { downloadDir: out }, tools });
    m.torrents.init = async () => {};
    m.torrents.applyLimits = () => {};
    await m.init();
    const [mi] = m.add([{ kind: 'media', source: `${base}/clip.mp4?x=1`, mediaFormat: 'mp4', mediaQuality: '480' }]);
    assert.equal(mi.via, 'ytdlp');
    for (let i = 0; i < 300 && !['completed', 'error'].includes(mi.status); i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(mi.status, 'completed', mi.error);
    assert.ok(mi.files[0].endsWith('.mp4') && fs.existsSync(mi.files[0]));
    assert.equal(m.location(mi.id), mi.filepath);
    await m.shutdown();
    ok('manager: media item queued, downloaded as MP4, "Show in folder" points at the real file');
  }
  console.log('\nAll media tests passed.');
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
