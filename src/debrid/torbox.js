// TorBox API client. Docs: https://api-docs.torbox.app/
const { sleep } = require('../util');
const { fileKey } = require('./realdebrid');

const BASE = 'https://api.torbox.app/v1/api';
const SUBMIT_TIMEOUT = 90000; // TorBox fetches the link's details while it answers: this one can be slow
const POLL_TIMEOUT = 30000;

// A dropped connection, a timeout or a busy server: worth trying again.
const transient = (message, cause) => Object.assign(new Error(message), { transient: true, cause });

class TorBox {
  constructor(key) {
    this.key = key;
    this.name = 'TorBox';
    this.pollMs = 3000;
    this.retryMs = 3000;
    this.maxPollErrors = 10; // polls in a row that may fail before giving up
    this.maxMissing = 5; // polls in a row that may not find the download
    this.stallMs = 20 * 60000; // a web download with no progress for this long has failed
    this.emptyFilesMs = 2 * 60000; // how long a finished download may list no files
  }

  // -> the whole answer: { success, error, detail, data }
  async call(method, path, { form, urlencoded, query, signal, timeoutMs = POLL_TIMEOUT } = {}) {
    if (!this.key) throw new Error('TorBox API key is not set (Settings → Debrid)');
    let url = BASE + path;
    if (query) url += '?' + new URLSearchParams(query);
    let body;
    if (urlencoded) body = new URLSearchParams(urlencoded);
    else if (form) {
      body = new FormData();
      for (const [k, v] of Object.entries(form)) {
        if (Buffer.isBuffer(v)) body.append(k, new Blob([v], { type: 'application/x-bittorrent' }), 'file.torrent');
        else body.append(k, String(v));
      }
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    let res;
    let data;
    try {
      res = await fetch(url, { method, headers: { Authorization: `Bearer ${this.key}` }, body, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      data = await res.json().catch(() => null);
    } catch (e) {
      if (signal?.aborted) throw e;
      if (e.name === 'TimeoutError' || timeout.aborted) throw transient(`TorBox didn't answer within ${Math.round(timeoutMs / 1000)} seconds`, e);
      throw transient("Couldn't reach TorBox (network problem)", e);
    }
    if (!res.ok || data?.success === false || !data) {
      const code = data?.error ? `${data.error}, HTTP ${res.status}` : `HTTP ${res.status}`;
      const message = `TorBox: ${data?.detail || res.statusText || 'unreadable answer'} (${code})`;
      if (res.status === 429 || res.status >= 500 || !data) throw transient(message);
      throw new Error(message);
    }
    return data;
  }

  async req(method, path, opts) {
    return (await this.call(method, path, opts)).data;
  }

  // Tries again after network problems, a few times.
  async retrying(fn, signal, tries = 3) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (!e.transient || attempt >= tries) throw e;
        await sleep(this.retryMs * attempt, signal);
      }
    }
  }

  async user() {
    const u = await this.req('GET', '/user/me');
    return { username: u.email, premium: (u.plan ?? 0) > 0, expires: u.premium_expires_at };
  }

  // Map of infoHash -> cached? for the LinkGrabber "instant" badge.
  async checkCached(hashes) {
    if (!hashes.length) return {};
    const data = await this.req('GET', '/torrents/checkcached', {
      query: { hash: hashes.join(','), format: 'object', list_files: 'false' },
    });
    const out = {};
    for (const h of hashes) out[h] = !!(data && data[h]);
    return out;
  }

  // The id of what was just created. No id: TorBox queued it (plan limit) or didn't say why.
  createdId(answer, field) {
    const id = answer.data?.[field] ?? answer.data?.id;
    if (id != null) return id;
    if (answer.data?.queued_id != null) throw new Error(`TorBox put this in its queue instead of starting it: ${answer.detail || 'your plan limit is reached'}`);
    throw new Error(`TorBox didn't start this download: ${answer.detail || answer.error || 'no id in its answer'}`);
  }

  async resolveTorrent(job, { onProgress, onRemoteId, signal }) {
    let id = job.remoteId;
    if (!id) {
      const created = await this.retrying(
        () => this.call('POST', '/torrents/createtorrent', { form: job.buffer ? { file: job.buffer } : { magnet: job.magnet }, signal, timeoutMs: SUBMIT_TIMEOUT }),
        signal
      );
      id = this.createdId(created, 'torrent_id');
      onRemoteId?.(id);
    }
    return this.pollUntilReady('torrents', 'torrent_id', id, { onProgress, signal, wanted: job.wanted });
  }

  // Hoster link -> TorBox web download -> direct link(s).
  async resolveLink(link, { onProgress, onRemoteId, signal, remoteId } = {}) {
    let id = remoteId;
    if (!id) {
      const created = await this.retrying(() => this.call('POST', '/webdl/createwebdownload', { urlencoded: { link }, signal, timeoutMs: SUBMIT_TIMEOUT }), signal, 2);
      id = this.createdId(created, 'webdownload_id');
      onRemoteId?.(id);
    }
    return this.pollUntilReady('webdl', 'web_id', id, { onProgress, signal, stallMs: this.stallMs });
  }

  async pollUntilReady(kind, idParam, id, { onProgress, signal, wanted, stallMs = 0 }) {
    let errors = 0;
    let missing = 0;
    let seen = null;
    let movedAt = Date.now();
    let emptySince = null;
    let emptyPolls = 0;
    for (;;) {
      let item;
      try {
        item = await this.req('GET', `/${kind}/mylist`, { query: { id, bypass_cache: 'true' }, signal });
        errors = 0;
      } catch (e) {
        // One dropped connection mustn't end a download TorBox is still working on.
        if (!e.transient || ++errors >= this.maxPollErrors) throw e;
        await sleep(this.pollMs, signal);
        continue;
      }
      if (!item) {
        if (++missing >= this.maxMissing) throw new Error('TorBox no longer lists this download (it was rejected or removed there)');
        await sleep(this.pollMs, signal);
        continue;
      }
      missing = 0;
      const state = String(item.download_state || '');
      if (item.download_finished || item.download_present) {
        const out = [];
        let files = item.files || [];
        // Finished but no files yet: TorBox can list them a little later, so give it a moment.
        if (!files.length) {
          emptySince = emptySince ?? Date.now();
          if (Date.now() - emptySince >= this.emptyFilesMs) throw new Error("TorBox finished but listed no files; this host's folder links may not be supported");
          emptyPolls++;
          await sleep(this.pollMs * Math.min(emptyPolls, 5), signal);
          continue;
        }
        if (wanted) {
          const picked = files.filter(f => wanted.has(fileKey(f.short_name || f.name, f.size)));
          if (picked.length) files = picked;
        }
        for (const f of files) {
          const url = await this.retrying(
            () => this.req('GET', `/${kind}/requestdl`, { query: { token: this.key, [idParam]: id, file_id: f.id, zip_link: 'false' }, signal }),
            signal
          );
          out.push({ url, filename: f.short_name || f.name?.split('/').pop(), size: f.size });
        }
        if (!out.length) throw new Error('TorBox: finished but returned no files');
        return out;
      }
      if (/error|failed/i.test(state)) throw new Error(`TorBox: ${state}${item.error ? ` (${item.error})` : ''}`);
      const now = `${state}|${item.progress}`;
      if (now !== seen) {
        seen = now;
        movedAt = Date.now();
      } else if (stallMs && Date.now() - movedAt > stallMs) {
        throw new Error(`TorBox: no progress for ${Math.round(stallMs / 60000)} minutes (${state || 'queued'})`);
      }
      onProgress?.({
        progress: Number(item.progress || 0),
        state: state || 'queued',
        speed: item.download_speed || 0,
        seeders: item.seeds,
        name: item.name,
      });
      await sleep(this.pollMs, signal);
    }
  }
}

module.exports = { TorBox };
