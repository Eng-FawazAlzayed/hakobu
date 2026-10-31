// TorBox API client. Docs: https://api-docs.torbox.app/
const { sleep } = require('../util');
const { fileKey } = require('./realdebrid');

const BASE = 'https://api.torbox.app/v1/api';

class TorBox {
  constructor(key) {
    this.key = key;
    this.name = 'TorBox';
  }

  async req(method, path, { form, query, signal } = {}) {
    if (!this.key) throw new Error('TorBox API key is not set (Settings → Debrid)');
    let url = BASE + path;
    if (query) url += '?' + new URLSearchParams(query);
    let body;
    if (form) {
      body = new FormData();
      for (const [k, v] of Object.entries(form)) {
        if (Buffer.isBuffer(v)) body.append(k, new Blob([v], { type: 'application/x-bittorrent' }), 'file.torrent');
        else body.append(k, String(v));
      }
    }
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${this.key}` }, body, signal });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.success === false) {
      throw new Error(`TorBox: ${data?.detail || data?.error || res.statusText} (${res.status})`);
    }
    return data?.data;
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

  async resolveTorrent(job, { onProgress, onRemoteId, signal }) {
    let id = job.remoteId;
    if (!id) {
      const created = await this.req('POST', '/torrents/createtorrent', {
        form: job.buffer ? { file: job.buffer } : { magnet: job.magnet },
        signal,
      });
      id = created.torrent_id;
      onRemoteId?.(id);
    }
    return this.pollUntilReady('torrents', 'torrent_id', id, { onProgress, signal, wanted: job.wanted });
  }

  // Hoster link -> TorBox web download -> direct link(s).
  async resolveLink(link, { onProgress, onRemoteId, signal, remoteId } = {}) {
    let id = remoteId;
    if (!id) {
      const created = await this.req('POST', '/webdl/createwebdownload', { form: { link }, signal });
      id = created.webdownload_id;
      onRemoteId?.(id);
    }
    return this.pollUntilReady('webdl', 'web_id', id, { onProgress, signal });
  }

  async pollUntilReady(kind, idParam, id, { onProgress, signal, wanted }) {
    for (;;) {
      const item = await this.req('GET', `/${kind}/mylist`, { query: { id, bypass_cache: 'true' }, signal });
      const state = String(item?.download_state || '');
      if (item?.download_finished || item?.download_present) {
        const out = [];
        let files = item.files || [];
        if (wanted) {
          const picked = files.filter(f => wanted.has(fileKey(f.short_name || f.name, f.size)));
          if (picked.length) files = picked;
        }
        for (const f of files) {
          const url = await this.req('GET', `/${kind}/requestdl`, {
            query: { token: this.key, [idParam]: id, file_id: f.id, zip_link: 'false' },
            signal,
          });
          out.push({ url, filename: f.short_name || f.name?.split('/').pop(), size: f.size });
        }
        if (!out.length) throw new Error('TorBox: finished but returned no files');
        return out;
      }
      if (/error|failed/i.test(state)) throw new Error(`TorBox: ${state}`);
      onProgress?.({
        progress: Number(item?.progress || 0),
        state: state || 'queued',
        speed: item?.download_speed || 0,
        seeders: item?.seeds,
        name: item?.name,
      });
      await sleep(3000, signal);
    }
  }
}

module.exports = { TorBox };
