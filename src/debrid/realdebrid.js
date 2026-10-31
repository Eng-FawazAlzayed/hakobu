// Real-Debrid REST client. Docs: https://api.real-debrid.com/
const { sleep } = require('../util');

const BASE = 'https://api.real-debrid.com/rest/1.0';
const FAILED = new Set(['magnet_error', 'error', 'virus', 'dead']);

// Files are matched across providers by base name + size.
const fileKey = (p, size) => `${String(p).split(/[\\/]/).pop()}|${size}`;

class RealDebrid {
  constructor(token) {
    this.token = token;
    this.name = 'Real-Debrid';
  }

  async req(method, path, { form, body, signal } = {}) {
    if (!this.token) throw new Error('Real-Debrid API token is not set (Settings → Debrid)');
    const headers = { Authorization: `Bearer ${this.token}` };
    if (form) body = new URLSearchParams(form);
    const res = await fetch(BASE + path, { method, headers, body, signal });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) throw new Error(`Real-Debrid: ${data?.error || res.statusText} (${res.status})`);
    return data;
  }

  async user() {
    const u = await this.req('GET', '/user');
    return { username: u.username, premium: u.type === 'premium', expires: u.expiration };
  }

  async unrestrict(link, signal) {
    const d = await this.req('POST', '/unrestrict/link', { form: { link }, signal });
    return { url: d.download, filename: d.filename, size: d.filesize };
  }

  // Hoster link (Mega, Rapidgator, ...) -> direct link(s).
  async resolveLink(link, { signal } = {}) {
    return [await this.unrestrict(link, signal)];
  }

  // Torrent -> cloud download -> direct links. `job.remoteId` lets a paused job pick up where it left off.
  async resolveTorrent(job, { onProgress, onRemoteId, signal }) {
    let id = job.remoteId;
    if (!id) {
      const added = job.buffer
        ? await this.req('PUT', '/torrents/addTorrent', { body: job.buffer, signal })
        : await this.req('POST', '/torrents/addMagnet', { form: { magnet: job.magnet }, signal });
      id = added.id;
      onRemoteId?.(id);
    }
    for (;;) {
      const info = await this.req('GET', `/torrents/info/${id}`, { signal });
      if (info.status === 'waiting_files_selection') {
        let files = 'all';
        if (job.wanted) {
          const ids = (info.files || []).filter(f => job.wanted.has(fileKey(f.path, f.bytes))).map(f => f.id);
          if (ids.length) files = ids.join(',');
        }
        await this.req('POST', `/torrents/selectFiles/${id}`, { form: { files }, signal });
      } else if (info.status === 'downloaded') {
        const out = [];
        for (const link of info.links) out.push(await this.unrestrict(link, signal));
        return out;
      } else if (FAILED.has(info.status)) {
        throw new Error(`Real-Debrid: torrent ${info.status}`);
      }
      onProgress?.({
        progress: (info.progress || 0) / 100,
        state: info.status,
        speed: info.speed || 0,
        seeders: info.seeders,
        name: info.filename,
      });
      await sleep(3000, signal);
    }
  }
}

module.exports = { RealDebrid, fileKey };
