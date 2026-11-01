// Segmented, resumable HTTP downloader (the "JDownloader half").
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { sleep, abortError, sanitize, uniqueName } = require('../util');
const { netFetch } = require('./net');
const { HostError, errorForStatus } = require('./errors');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Hakobu/0.1';
const MIN_SEGMENT = 2 * 1024 * 1024;
const SPLIT_MIN = 4 * 1024 * 1024; // only split a running segment when at least this much is left in it
const SPACE_MARGIN = 64 * 1024 * 1024;

// Shared token bucket for the global download speed limit.
class RateLimiter {
  constructor(bytesPerSec = 0) {
    this.rate = bytesPerSec;
    this.tokens = 0;
    this.last = Date.now();
  }
  setRate(bytesPerSec) {
    this.rate = bytesPerSec;
    this.tokens = 0;
  }
  async take(n, signal) {
    while (this.rate > 0) {
      const now = Date.now();
      this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
      this.last = now;
      if (this.tokens > 0) {
        this.tokens -= n; // may go negative; the debt is paid back before the next chunk
        return;
      }
      await sleep(Math.min(250, (-this.tokens / this.rate) * 1000 + 10), signal);
    }
  }
}

function filenameFromResponse(res, url) {
  const cd = res.headers.get('content-disposition') || '';
  let m = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(cd);
  if (m) {
    try {
      return sanitize(decodeURIComponent(m[1].trim().replace(/^"|"$/g, '')));
    } catch {}
  }
  m = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  if (m) return sanitize(m[1]);
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (last) return sanitize(decodeURIComponent(last));
  } catch {}
  return 'download';
}

// Thrown when a "download" link is really a web page (a file host's landing page, a login page, ...).
class PageError extends Error {}

async function probe(url, headers, signal, route = 0) {
  let res = await netFetch(url, { headers: { 'User-Agent': UA, ...headers, Range: 'bytes=0-0' }, signal, route });
  if (res.status === 416) {
    // An empty file has no byte 0: ask again without a range.
    try {
      await res.body?.cancel();
    } catch {}
    res = await netFetch(url, { headers: { 'User-Agent': UA, ...headers }, signal, route });
  }
  if (res.headers.get('cf-mitigated')) {
    try {
      await res.body?.cancel();
    } catch {}
    throw new PageError(`${new URL(url).hostname} shows a bot check`);
  }
  const type = res.headers.get('content-type') || '';
  if (res.ok && /text\/html|application\/xhtml/i.test(type) && !/\.x?html?$/i.test(new URL(res.url || url).pathname)) {
    try {
      await res.body?.cancel();
    } catch {}
    throw new PageError(`${new URL(url).hostname} sent a web page, not a file`);
  }
  let size = null;
  let resumable = false;
  if (res.status === 206) {
    const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
    if (m) {
      size = Number(m[1]);
      resumable = true;
    }
  } else if (res.ok) {
    const cl = res.headers.get('content-length');
    if (cl) size = Number(cl);
  } else {
    try {
      await res.body?.cancel();
    } catch {}
    throw errorForStatus(res, hostName(url)) || new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  try {
    await res.body?.cancel();
  } catch {}
  return { size, resumable, filename: filenameFromResponse(res, res.url || url) };
}

const hostName = url => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

// Free space on the drive that holds dir (null when the OS won't say).
async function freeSpace(dir) {
  try {
    let d = dir;
    while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
    const s = await fsp.statfs(d);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function makeSegments(size, resumable, connections) {
  if (!resumable || !size) return [{ start: 0, end: size ? size - 1 : null, done: 0 }];
  const n = Math.max(1, Math.min(connections, Math.ceil(size / MIN_SEGMENT)));
  const step = Math.ceil(size / n);
  const segs = [];
  for (let start = 0; start < size; start += step) segs.push({ start, end: Math.min(size, start + step) - 1, done: 0 });
  return segs;
}

class HttpTask {
  // resolve(signal) -> { url, headers } turns a host page into a fresh direct link (run before every start).
  // exists: what to do when the file is already on disk: 'rename' (name (1).ext), 'skip' (same size: done) or 'overwrite'.
  // route: which proxy route to use (see net.js).
  constructor(item, { limiter, itemLimiter = null, connections = 8, taken, resolve = null, exists = 'rename', route = 0, split = true, freeSpace: fsFn = freeSpace }) {
    this.item = item;
    this.exists = exists;
    this.route = route;
    this.split = split;
    this.freeSpace = fsFn;
    this.decrypt = null;
    this.resolve = resolve;
    this.itemLimiter = itemLimiter;
    this.taken = taken;
    this.limiter = limiter;
    this.connections = connections;
    this.ac = new AbortController();
    this.retryBaseMs = 750; // first retry delay, doubled after each dead attempt (tests shorten it)
  }

  setItemLimiter(l) {
    this.itemLimiter = l;
  }

  abort() {
    this.ac.abort();
  }

  async run() {
    const it = this.item;
    const signal = this.ac.signal;
    this.url = it.source;
    this.headers = it.headers || {};
    if (this.resolve) await this.refreshLink(signal);
    const headers = this.headers;

    if (!it.probed) {
      const p = await probe(this.url, headers, signal, this.route);
      it.size = this.knownSize || p.size;
      it.resumable = p.resumable && !this.noResume;
      if (!it.filename) {
        const want = sanitize(it.suggestedName || this.knownName || p.filename);
        const onDisk = path.join(it.dir, want);
        if (this.exists === 'skip' && fs.existsSync(onDisk) && (!it.size || fs.statSync(onDisk).size === it.size)) {
          // Already downloaded earlier: nothing to fetch.
          it.filename = want;
          it.name = want;
          it.size = fs.statSync(onDisk).size;
          it.downloaded = it.size;
          it.skipped = true;
          it.probed = true;
          return;
        }
        it.filename = uniqueName(it.dir, want, this.taken, { ignoreDisk: this.exists === 'overwrite' });
      }
      it.name = it.filename;
      it.segments = makeSegments(it.size, p.resumable, this.connections);
      it.probed = true;
    }
    if (!it.resumable) it.segments.forEach(s => (s.done = 0));
    it.downloaded = it.segments.reduce((a, s) => a + s.done, 0);

    await fsp.mkdir(it.dir, { recursive: true });
    // Like JDownloader: don't start what won't fit. The queue tries again in a few minutes.
    if (it.size) {
      const free = await this.freeSpace(it.dir);
      const need = it.size - it.downloaded;
      if (free != null && free < need + SPACE_MARGIN) {
        throw new HostError(`Not enough disk space: needs ${gb(need)}, ${gb(free)} free`, { wait: 3 * 60000, diskFull: true });
      }
    }
    const partPath = path.join(it.dir, it.filename + '.part');
    if (this.exists === 'overwrite' && !it.downloaded) {
      try {
        await fsp.rm(path.join(it.dir, it.filename), { force: true });
      } catch {}
    }
    const fh = await fsp.open(partPath, fs.existsSync(partPath) ? 'r+' : 'w');
    // When one connection gives up, stop the others too, and wait for all of them before the file closes.
    // (Promise.all would close the file while the rest kept reconnecting in the background.)
    const segAc = new AbortController();
    const onAbort = () => segAc.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    let failure = null;
    const running = new Set();
    const start = seg => {
      const p = this.runSegment(seg, fh, headers, segAc.signal)
        .then(() => {
          // A connection is free: split the biggest unfinished segment so the last part doesn't crawl on one connection.
          if (!failure && !segAc.signal.aborted) {
            const extra = this.splitSegment(running.size - 1);
            if (extra) start(extra);
          }
        })
        .catch(e => {
          if (!failure && !signal.aborted) {
            failure = e;
            segAc.abort();
          }
        })
        .finally(() => running.delete(p));
      running.add(p);
    };
    try {
      it.segments.filter(s => s.end === null || s.start + s.done <= s.end).forEach(start);
      while (running.size) await Promise.allSettled([...running]);
    } finally {
      signal.removeEventListener('abort', onAbort);
      await fh.close();
    }
    if (signal.aborted) throw abortError();
    if (failure) throw failure;
    if (it.size == null) it.size = it.downloaded;
    await fsp.rename(partPath, path.join(it.dir, it.filename));
  }

  // A new segment taken from the far half of the segment with the most bytes left (or null).
  splitSegment(othersRunning) {
    const it = this.item;
    if (!this.split || !it.resumable || !it.size || othersRunning >= this.connections) return null;
    let best = null;
    for (const s of it.segments) {
      if (s.end === null) continue;
      const left = s.end - (s.start + s.done) + 1;
      if (left > SPLIT_MIN && (!best || left > best.left)) best = { s, left };
    }
    if (!best) return null;
    const cur = best.s.start + best.s.done;
    const mid = cur + Math.ceil(best.left / 2);
    const seg = { start: mid, end: best.s.end, done: 0 };
    best.s.end = mid - 1;
    it.segments.push(seg);
    return seg;
  }

  async refreshLink(signal) {
    // Several segments may hit an expired link at once; share one refresh.
    if (!this.refreshing) {
      this.refreshing = this.resolve(signal).then(r => {
        this.url = r.url;
        this.headers = { ...(this.item.headers || {}), ...(r.headers || {}) };
        this.item.directHost = new URL(r.url).hostname;
        if (r.decrypt) this.decrypt = r.decrypt;
        if (r.maxConnections) this.connections = Math.max(1, Math.min(this.connections, r.maxConnections));
        if (r.filename) this.knownName = r.filename;
        if (r.size) this.knownSize = r.size;
        if (r.hash) this.item.expectedHash = r.hash;
        if (r.resumable === false) this.noResume = true; // e.g. free 1fichier: one connection, no resume
      }).finally(() => setTimeout(() => (this.refreshing = null), 5000));
    }
    return this.refreshing;
  }

  async runSegment(seg, fh, _headers, signal) {
    const it = this.item;
    let failures = 0;
    for (;;) {
      const from = seg.start + seg.done;
      if (seg.end !== null && from > seg.end) return;
      const before = seg.done;
      try {
        const h = { 'User-Agent': UA, ...this.headers };
        if (it.resumable) h.Range = `bytes=${from}-${seg.end ?? ''}`;
        const res = await netFetch(this.url, { headers: h, signal, route: this.route });
        if (!(it.resumable ? res.status === 206 : res.ok)) {
          try {
            await res.body?.cancel(); // free the connection before retrying
          } catch {}
        }
        if ([401, 403, 410].includes(res.status) && this.resolve) {
          await this.refreshLink(signal); // host links expire: get a fresh one and retry
          throw new Error(`HTTP ${res.status} (link refreshed)`);
        }
        if (it.resumable ? res.status !== 206 : !res.ok) {
          const he = errorForStatus(res, hostName(this.url));
          if (he && (he.wait || !this.resolve)) throw he;
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        for await (const chunk of res.body) {
          await this.limiter.take(chunk.length, signal);
          if (this.itemLimiter) await this.itemLimiter.take(chunk.length, signal);
          let buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          // seg.end can shrink while this chunk waited (another connection took over the rest): re-read it here.
          if (seg.end !== null) {
            const remaining = seg.end - (seg.start + seg.done) + 1;
            if (remaining <= 0) break;
            if (buf.length > remaining) buf = buf.subarray(0, remaining);
          }
          const at = seg.start + seg.done;
          if (this.decrypt) buf = this.decrypt(at, buf);
          await fh.write(buf, 0, buf.length, at);
          seg.done += buf.length;
          it.downloaded += buf.length;
          if (seg.end !== null && seg.start + seg.done > seg.end) break;
        }
        if (seg.end !== null && seg.start + seg.done <= seg.end) throw new Error('Connection closed early');
        return;
      } catch (e) {
        if (signal.aborted) throw abortError();
        if (e instanceof HostError) throw e; // waits, "file gone": the queue decides, not this loop
        // Servers drop connections all the time: keep retrying while data still arrives, give up after 8 dead attempts in a row.
        failures = seg.done > before ? 1 : failures + 1;
        if (failures > 8) throw e;
        if (!it.resumable) {
          it.downloaded -= seg.done;
          seg.done = 0;
        }
        await sleep(Math.min(15000, this.retryBaseMs * 2 ** (failures - 1)), signal);
      }
    }
  }
}

const gb = n => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : `${Math.round(n / (1 << 20))} MB`);

module.exports = { HttpTask, RateLimiter, probe, PageError, freeSpace, filenameFromResponse, UA };
