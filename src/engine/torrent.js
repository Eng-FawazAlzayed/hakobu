// BitTorrent engine (the "qBittorrent half"), wrapping WebTorrent.
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Azureus-style peer ID: "-HB0010-" + 12 random chars. Peers see this as "Hakobu 0.0.1".
function makePeerId() {
  return Buffer.from('-HB0010-' + crypto.randomBytes(6).toString('hex'));
}

function countBits(bitfield, n) {
  let c = 0;
  for (let i = 0; i < n; i++) if (bitfield.get(i)) c++;
  return c;
}

// "-qB4650-" -> "qBittorrent 4.6.5"
const CLIENTS = {
  qB: 'qBittorrent', TR: 'Transmission', UT: 'µTorrent', UM: 'µTorrent Mac', LT: 'libtorrent', lt: 'rTorrent', DE: 'Deluge',
  WW: 'WebTorrent', WD: 'WebTorrent Desktop', BI: 'BiglyBT', AZ: 'Vuze', BT: 'BitTorrent', TX: 'Tixati', FD: 'Free Download Manager',
  KT: 'KTorrent', HB: 'Hakobu', PI: 'PicoTorrent', BC: 'BitComet', XL: 'Xunlei', SD: 'Thunder', FW: 'FrostWire', AG: 'Ares', LW: 'LimeWire', TL: 'Tribler', BN: 'Baidu Netdisk',
};
function describeClient(peerIdHex) {
  if (!peerIdHex) return 'Unknown';
  const id = Buffer.from(peerIdHex, 'hex').toString('latin1');
  const m = /^-([A-Za-z]{2})([0-9A-Za-z]{4})-/.exec(id);
  if (!m) return id.slice(0, 8).replace(/[^ -~]/g, '·');
  const v = m[2].replace(/[^0-9A-Za-z]/g, '');
  const version = /^\d+$/.test(v) ? v.split('').map(Number).join('.').replace(/(\.0)+$/, '') : v;
  return `${CLIENTS[m[1]] || m[1]} ${version}`;
}

// A second peer's file list can finish hashing after the torrent was removed; WebTorrent then crashes
// on its destroyed client. Drop those pending listeners first.
function detachMetadata(t) {
  for (const w of t.wires || []) w.ut_metadata?.removeAllListeners('metadata');
}

class TorrentEngine {
  constructor() {
    this.client = null;
    this.active = new Map(); // item.id -> WebTorrent torrent
    this.itemsById = new Map(); // item.id -> item (for fast-resume data)
  }

  async init(settings, extra = {}) {
    const { default: WebTorrent } = await import('webtorrent');
    this.client = new WebTorrent({
      peerId: makePeerId(),
      maxConns: settings.torrentMaxConns || 55,
      torrentPort: settings.torrentPort || 0,
      utp: false, // utp-native needs a native build; TCP + WebRTC peers are enough
      ...extra,
    });
    this.client.on('error', err => console.error('[torrent]', err.message));
    this.applyLimits(settings);
  }

  applyLimits(settings) {
    if (!this.client) return;
    this.client.throttleDownload(settings.dlLimitKB > 0 ? settings.dlLimitKB * 1024 : -1);
    this.client.throttleUpload(settings.ulLimitKB > 0 ? settings.ulLimitKB * 1024 : -1);
  }

  get port() {
    return this.client?.torrentPort;
  }

  // Starts (or resumes) a torrent. Existing data in item.dir is verified, so resume is just "add again".
  // item.selectedFiles (array of file indexes) limits the download to those files, like qBittorrent's file picker.
  start(item, { onMetadata, onDone, onError }) {
    const id = item.torrentB64 ? Buffer.from(item.torrentB64, 'base64') : item.source;
    const sel = Array.isArray(item.selectedFiles) ? new Set(item.selectedFiles) : null;
    const bitfield = this.resumeBitfield(item);
    item.fastResumed = !!bitfield;
    this.itemsById.set(item.id, item);
    const t = this.client.add(id, {
      bitfield: bitfield || undefined,
      path: item.dir,
      destroyStoreOnDestroy: false,
      deselect: !!sel,
      strategy: item.sequential ? 'sequential' : 'rarest',
      announce: item.extraTrackers?.length ? item.extraTrackers : undefined,
    });
    this.active.set(item.id, t);
    let finished = false;
    t._hakobuCheck = () => {
      if (finished || !t.files.length) return;
      if (t.files.every((f, i) => (sel && !sel.has(i)) || f.done)) {
        finished = true;
        onDone?.(t);
      }
    };

    const metadata = () => {
      // one file picked out of a big collection: name the download after that file
      item.name = sel?.size === 1 && t.files[[...sel][0]] ? t.files[[...sel][0]].name : t.name;
      item.size = t.length;
      item.infoHash = t.infoHash;
      item.torrentB64 = Buffer.from(t.torrentFile).toString('base64');
      item.files = t.files.map((f, i) => ({ path: f.path, size: f.length, selected: !sel || sel.has(i) }));
      item.size = item.files.reduce((a, f) => a + (f.selected ? f.size : 0), 0);
      onMetadata?.(t);
    };
    t.once('ready', () => {
      // Deselect first: deselecting a file drops every piece it touches, including pieces it shares with a wanted file.
      if (sel) {
        t.files.forEach((f, i) => !sel.has(i) && f.deselect());
        t.files.forEach((f, i) => sel.has(i) && f.select());
      }
      t._hakobuCheck();
    });
    if (t.metadata) metadata();
    else t.once('metadata', metadata);
    t.on('done', t._hakobuCheck);
    t.once('error', err => onError?.(err));
    return t;
  }

  stats(item) {
    const t = this.active.get(item.id);
    if (!t) return;
    t._hakobuCheck();
    const sel = Array.isArray(item.selectedFiles) ? new Set(item.selectedFiles) : null;
    if (sel && t.files.length) {
      const files = t.files.filter((_, i) => sel.has(i));
      const total = files.reduce((a, f) => a + f.length, 0);
      item.downloaded = files.reduce((a, f) => a + f.downloaded, 0);
      item.progress = total ? item.downloaded / total : 1;
    } else {
      item.downloaded = t.downloaded;
      item.progress = t.progress;
    }
    item.fileProgress = t.files.length <= 2000 ? t.files.map(f => (f.length ? Math.round((f.downloaded / f.length) * 1000) / 1000 : 1)) : null;
    // counting every peer's pieces is the costly part: do it every 5 s, and trust the wire's own seeder flag when it has one
    if (!t._seedsAt || Date.now() - t._seedsAt > 5000) {
      t._seedsAt = Date.now();
      item.seeds = t.wires.filter(w => (w.isSeeder !== undefined ? w.isSeeder : w.peerPieces && t.pieces.length && countBits(w.peerPieces, t.pieces.length) === t.pieces.length)).length;
    }
    item.uploaded = (item.uploadedBase || 0) + t.uploaded;
    item.speed = t.downloadSpeed;
    item.upSpeed = t.uploadSpeed;
    item.peers = t.numPeers;
    item.ratio = item.size ? item.uploaded / item.size : 0;
  }

  // Fetch a torrent's file list without downloading anything (for the add-torrent dialog).
  fetchMetadata({ source, torrentB64 }, timeoutMs = 90000) {
    const id = torrentB64 ? Buffer.from(torrentB64, 'base64') : source;
    const tmp = path.join(os.tmpdir(), 'hakobu-meta', crypto.randomUUID());
    return new Promise((resolve, reject) => {
      let t;
      try {
        t = this.client.add(id, { path: tmp, deselect: true, skipVerify: true });
      } catch (e) {
        return reject(e);
      }
      const finish = (err, info) => {
        clearTimeout(timer);
        detachMetadata(t);
        this.client.remove(t, { destroyStore: true }, () => {});
        err ? reject(err) : resolve(info);
      };
      const timer = setTimeout(() => finish(new Error('No peers sent the file list in time. Try again, or add it to a debrid service.')), timeoutMs);
      const done = () =>
        finish(null, {
          name: t.name,
          infoHash: t.infoHash,
          size: t.length,
          torrentB64: Buffer.from(t.torrentFile).toString('base64'),
          files: t.files.map(f => ({ path: f.path, size: f.length })),
        });
      if (t.metadata) done();
      else t.once('metadata', done);
      t.once('error', e => finish(e));
    });
  }

  // Live peer list for the Peers tab.
  peers(id) {
    const t = this.active.get(id);
    if (!t) return [];
    return t.wires.map(w => ({
      addr: `${w.remoteAddress || '?'}:${w.remotePort || ''}`,
      client: describeClient(w.peerId),
      type: w.type || 'tcp',
      progress: w.peerPieces && t.pieces.length ? countBits(w.peerPieces, t.pieces.length) / t.pieces.length : 0,
      down: w.downloadSpeed(),
      up: w.uploadSpeed(),
      downloaded: w.downloaded,
      uploaded: w.uploaded,
      choked: w.peerChoking,
    }));
  }

  // Trackers plus the trackerless sources, for the Trackers tab.
  trackers(id, item) {
    const t = this.active.get(id);
    const urls = t?.announce?.length ? t.announce : item.extraTrackers || [];
    const peers = t ? t.numPeers : 0;
    return [
      { url: '** [DHT] **', status: this.client?.dht ? 'Working' : 'Disabled', peers },
      { url: '** [PeX] **', status: 'Working', peers },
      { url: '** [LSD] **', status: this.client?.lsd ? 'Working' : 'Disabled', peers },
      ...urls.map(url => ({ url, status: t ? (t.ready ? 'Announcing' : 'Not contacted yet') : 'Stopped' })),
    ];
  }

  // ---- fast-resume (like qBittorrent): remember which pieces are verified, plus each file's modified time ----
  fileTimes(item) {
    return (item.files || []).map(f => {
      try {
        return fs.statSync(path.join(item.dir, f.path)).mtimeMs;
      } catch {
        return null;
      }
    });
  }

  // The saved bitfield is trusted only if every file still has the exact modified time it had when saved.
  resumeBitfield(item) {
    const r = item.resume;
    if (!r?.bitfield || !item.files?.length || r.mtimes?.length !== item.files.length) return null;
    const now = this.fileTimes(item);
    if (!now.every((m, i) => m === r.mtimes[i])) return null;
    return Buffer.from(r.bitfield, 'base64');
  }

  captureResume(id) {
    const t = this.active.get(id);
    const item = this.itemsById.get(id);
    if (!t || !item || !t.ready || !t.bitfield?.buffer || !t.files.length) return;
    item.resume = { bitfield: Buffer.from(t.bitfield.buffer).toString('base64'), mtimes: this.fileTimes(item), at: Date.now() };
  }

  async stop(id) {
    const t = this.active.get(id);
    if (!t) return;
    this.captureResume(id);
    this.active.delete(id);
    detachMetadata(t);
    await new Promise(resolve => this.client.remove(t, { destroyStore: false }, () => resolve()));
  }

  addPeer(id, addr) {
    const t = this.active.get(id);
    if (!t) return;
    if (t.infoHash) t.addPeer(addr);
    else t.once('infoHash', () => t.addPeer(addr));
  }

  async destroy() {
    if (this.client) await new Promise(r => this.client.destroy(() => r()));
  }
}

module.exports = { TorrentEngine, makePeerId, describeClient };
