// Segmented, resumable HTTP downloader (the "JDownloader half").
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { sleep, abortError, sanitize, uniqueName } = require('../util');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Hakobu/0.1';
const MIN_SEGMENT = 2 * 1024 * 1024;

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

async function probe(url, headers, signal) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers, Range: 'bytes=0-0' }, signal });
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
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  try {
    await res.body?.cancel();
  } catch {}
  return { size, resumable, filename: filenameFromResponse(res, res.url || url) };
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
  constructor(item, { limiter, itemLimiter = null, connections = 8, taken, resolve = null }) {
    this.item = item;
    this.resolve = resolve;
    this.itemLimiter = itemLimiter;
    this.taken = taken;
    this.limiter = limiter;
    this.connections = connections;
    this.ac = new AbortController();
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
      const p = await probe(this.url, headers, signal);
      it.size = p.size;
      it.resumable = p.resumable;
      it.filename = it.filename || uniqueName(it.dir, sanitize(it.suggestedName || p.filename), this.taken);
      it.name = it.filename;
      it.segments = makeSegments(p.size, p.resumable, this.connections);
      it.probed = true;
    }
    if (!it.resumable) it.segments.forEach(s => (s.done = 0));
    it.downloaded = it.segments.reduce((a, s) => a + s.done, 0);

    await fsp.mkdir(it.dir, { recursive: true });
    const partPath = path.join(it.dir, it.filename + '.part');
    const fh = await fsp.open(partPath, fs.existsSync(partPath) ? 'r+' : 'w');
    try {
      await Promise.all(it.segments.map(seg => this.runSegment(seg, fh, headers, signal)));
    } finally {
      await fh.close();
    }
    if (signal.aborted) throw abortError();
    if (it.size == null) it.size = it.downloaded;
    await fsp.rename(partPath, path.join(it.dir, it.filename));
  }

  async refreshLink(signal) {
    // Several segments may hit an expired link at once; share one refresh.
    if (!this.refreshing) {
      this.refreshing = this.resolve(signal).then(r => {
        this.url = r.url;
        this.headers = { ...(this.item.headers || {}), ...(r.headers || {}) };
        this.item.directHost = new URL(r.url).hostname;
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
        const res = await fetch(this.url, { headers: h, signal });
        if ([401, 403, 410].includes(res.status) && this.resolve) {
          await this.refreshLink(signal); // host links expire: get a fresh one and retry
          throw new Error(`HTTP ${res.status} (link refreshed)`);
        }
        if (it.resumable ? res.status !== 206 : !res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        for await (const chunk of res.body) {
          await this.limiter.take(chunk.length, signal);
          if (this.itemLimiter) await this.itemLimiter.take(chunk.length, signal);
          let buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          if (seg.end !== null) {
            const remaining = seg.end - (seg.start + seg.done) + 1;
            if (buf.length > remaining) buf = buf.subarray(0, remaining);
          }
          await fh.write(buf, 0, buf.length, seg.start + seg.done);
          seg.done += buf.length;
          it.downloaded += buf.length;
          if (seg.end !== null && seg.start + seg.done > seg.end) break;
        }
        if (seg.end !== null && seg.start + seg.done <= seg.end) throw new Error('Connection closed early');
        return;
      } catch (e) {
        if (signal.aborted) throw abortError();
        // Servers drop connections all the time: keep retrying while data still arrives, give up after 8 dead attempts in a row.
        failures = seg.done > before ? 1 : failures + 1;
        if (failures > 8) throw e;
        if (!it.resumable) {
          it.downloaded -= seg.done;
          seg.done = 0;
        }
        await sleep(Math.min(15000, 750 * 2 ** (failures - 1)), signal);
      }
    }
  }
}

module.exports = { HttpTask, RateLimiter, probe, PageError };
