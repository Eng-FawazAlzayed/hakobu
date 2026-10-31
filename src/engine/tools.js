// External tools for media downloads: yt-dlp (engine), Deno (JS runtime YouTube now requires), ffmpeg + ffprobe (convert/merge).
// Always fetched from the official sources, newest version, SHA-256 verified before use. Lives in <userData>/tools.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { path7za } = require('./extract');

const UA = 'Hakobu (tool updater)';

const TOOLS = {
  'yt-dlp': {
    label: 'yt-dlp',
    files: ['yt-dlp.exe'],
    latest: async () => tagFromRedirect('https://github.com/yt-dlp/yt-dlp/releases/latest'),
    // official standalone build; it bundles yt-dlp-ejs (the YouTube JS challenge solver)
    async install(dir, onProgress) {
      const base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
      const sums = await text(base + 'SHA2-256SUMS');
      const hash = /^([0-9a-f]{64})\s+yt-dlp\.exe$/im.exec(sums)?.[1];
      if (!hash) throw new Error('yt-dlp: checksum list has no yt-dlp.exe entry');
      await download(base + 'yt-dlp.exe', path.join(dir, 'yt-dlp.exe'), hash, onProgress);
    },
    version: async dir => (await run(path.join(dir, 'yt-dlp.exe'), ['--version'])).trim(),
  },
  deno: {
    label: 'Deno',
    files: ['deno.exe'],
    latest: async () => (await tagFromRedirect('https://github.com/denoland/deno/releases/latest')).replace(/^v/, ''),
    async install(dir, onProgress) {
      const base = 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip';
      // the .sha256sum file is PowerShell Get-FileHash output: pull out the 64 hex characters
      const hash = /\b([0-9a-f]{64})\b/i.exec(await text(base + '.sha256sum'))?.[1];
      if (!hash) throw new Error('Deno: no checksum found');
      const zip = path.join(dir, 'deno.zip');
      await download(base, zip, hash, onProgress);
      await unzip(zip, dir, ['deno.exe']);
      await fsp.rm(zip, { force: true });
    },
    version: async dir => /deno (\S+)/.exec(await run(path.join(dir, 'deno.exe'), ['--version']))?.[1] || '?',
  },
  ffmpeg: {
    label: 'ffmpeg',
    files: ['ffmpeg.exe', 'ffprobe.exe'],
    latest: async () => (await text('https://www.gyan.dev/ffmpeg/builds/release-version')).trim(),
    async install(dir, onProgress) {
      const base = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
      const hash = /\b([0-9a-f]{64})\b/i.exec(await text(base + '.sha256'))?.[1];
      if (!hash) throw new Error('ffmpeg: no checksum found');
      const zip = path.join(dir, 'ffmpeg.zip');
      await download(base, zip, hash, onProgress);
      await unzip(zip, dir, ['ffmpeg.exe', 'ffprobe.exe']);
      await fsp.rm(zip, { force: true });
    },
    version: async dir => /ffmpeg version (\S+)/.exec(await run(path.join(dir, 'ffmpeg.exe'), ['-version']))?.[1]?.replace(/-essentials.*$/, '') || '?',
  },
};

async function tagFromRedirect(url) {
  const res = await fetch(url, { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  const tag = /\/tag\/([^/?#]+)/.exec(res.headers.get('location') || '')?.[1];
  if (!tag) throw new Error(`Couldn't read the latest version from ${url}`);
  return decodeURIComponent(tag);
}

async function text(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

// Download to <dest>.part (resuming after dropped connections), then only a matching SHA-256 gets renamed into place.
async function download(url, dest, sha256, onProgress) {
  const part = dest + '.part';
  await fsp.rm(part, { force: true });
  let got = 0;
  let total = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      const headers = { 'User-Agent': UA, ...(got ? { Range: `bytes=${got}-` } : {}) };
      const res = await fetch(url, { headers });
      if (got && res.status !== 206) got = 0; // server ignored the range: start over
      else if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
      if (!total) total = Number(res.headers.get('content-length')) || 0;
      const out = fs.createWriteStream(part, { flags: got ? 'a' : 'w' });
      try {
        for await (const chunk of res.body) {
          got += chunk.length;
          if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
          onProgress?.(total ? got / total : 0, got, total);
        }
      } finally {
        await new Promise(r => out.end(r));
      }
      if (total && got < total) throw new Error('connection closed early');
      break;
    } catch (e) {
      if (attempt >= 6 || /HTTP 4\d\d/.test(e.message)) {
        await fsp.rm(part, { force: true });
        throw new Error(`${path.basename(dest)}: ${e.message}${e.cause?.code ? ' (' + e.cause.code + ')' : ''}`);
      }
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  const actual = await new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(part).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
  if (actual.toLowerCase() !== sha256.toLowerCase()) {
    await fsp.rm(part, { force: true });
    throw new Error(`Checksum mismatch for ${path.basename(dest)}: download rejected`);
  }
  await fsp.rename(part, dest);
}

function unzip(zip, dir, names) {
  return new Promise((resolve, reject) => {
    // "e" flattens folders, "-r" finds the names anywhere inside the archive
    execFile(path7za(), ['e', '-y', `-o${dir}`, zip, ...names, '-r'], { windowsHide: true }, (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
  });
}

function run(exe, args) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { windowsHide: true, timeout: 20000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

const cmpVersion = (a, b) => {
  const pa = String(a).split(/[.\-]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.\-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

class ToolManager {
  constructor(dir) {
    this.dir = dir;
    this.busy = null;
  }

  path(file) {
    return path.join(this.dir, file);
  }

  installed(name) {
    return TOOLS[name].files.every(f => fs.existsSync(this.path(f)));
  }

  ready() {
    return Object.keys(TOOLS).every(n => this.installed(n));
  }

  // { name: { label, installed, version, latest?, updateAvailable? } }
  async status({ checkLatest = false } = {}) {
    const out = {};
    await Promise.all(
      Object.entries(TOOLS).map(async ([name, t]) => {
        const s = { label: t.label, installed: this.installed(name), version: null };
        if (s.installed) s.version = await t.version(this.dir).catch(() => null);
        if (checkLatest) {
          s.latest = await t.latest().catch(() => null);
          s.updateAvailable = !!(s.latest && (!s.installed || !s.version || cmpVersion(s.latest, s.version) > 0));
        }
        out[name] = s;
      })
    );
    return out;
  }

  // Install (or update) the given tools; onProgress({ tool, label, fraction, step }).
  async install(names = Object.keys(TOOLS), onProgress) {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      await fsp.mkdir(this.dir, { recursive: true });
      const results = {};
      for (const name of names) {
        const t = TOOLS[name];
        onProgress?.({ tool: name, label: t.label, fraction: 0, step: 'downloading' });
        try {
          // install into a staging folder, then swap files, so a failed update never breaks a working tool
          const stage = path.join(this.dir, '.stage-' + name);
          await fsp.rm(stage, { recursive: true, force: true });
          await fsp.mkdir(stage, { recursive: true });
          await t.install(stage, f => onProgress?.({ tool: name, label: t.label, fraction: f, step: 'downloading' }));
          onProgress?.({ tool: name, label: t.label, fraction: 1, step: 'verifying' });
          const version = await t.version(stage); // proves the new binary actually runs
          for (const f of t.files) await fsp.copyFile(path.join(stage, f), this.path(f));
          await fsp.rm(stage, { recursive: true, force: true });
          results[name] = { ok: true, version };
          onProgress?.({ tool: name, label: t.label, fraction: 1, step: 'done', version });
        } catch (e) {
          results[name] = { ok: false, error: e.message };
          onProgress?.({ tool: name, label: t.label, fraction: 1, step: 'error', error: e.message });
        }
      }
      return results;
    })().finally(() => (this.busy = null));
    return this.busy;
  }

  // Update only what's outdated (or missing).
  async update(onProgress) {
    const st = await this.status({ checkLatest: true });
    const names = Object.keys(st).filter(n => st[n].updateAvailable);
    if (!names.length) return { updated: [], status: st };
    const results = await this.install(names, onProgress);
    return { updated: names.filter(n => results[n].ok), results, status: await this.status() };
  }
}

module.exports = { ToolManager, TOOLS, cmpVersion, download };
