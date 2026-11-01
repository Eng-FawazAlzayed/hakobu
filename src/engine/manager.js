// Queue + scheduler that ties the HTTP engine, torrent engine and debrid providers together.
// Electron-free so it can be driven from tests.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { HttpTask, RateLimiter, PageError } = require('./http');
const { TorrentEngine } = require('./torrent');
const { RealDebrid, fileKey } = require('../debrid/realdebrid');
const { TorBox } = require('../debrid/torbox');
const { infoHashFromMagnet, isHoster } = require('../linkparse');
const { sanitize, safeJoin } = require('../util');
const { extractAll, isFirstVolume } = require('./extract');
const { HosterRegistry, hostOf } = require('./hosters');
const { resolverFor, moduleFor, setAccounts } = require('./resolvers');
const { HostError } = require('./errors');
const net = require('./net');
const { hashFile, normalizeHash, expectedFromHashFiles } = require('./verify');
const { MediaTask } = require('./media');
const { ToolManager } = require('./tools');

const DEFAULT_SETTINGS = {
  downloadDir: '',
  maxConcurrent: 3,
  connectionsPerDownload: 8,
  maxActiveTorrents: 4,
  dlLimitKB: 0,
  ulLimitKB: 0,
  seedRatio: 1,
  torrentPort: 0,
  torrentRoute: 'p2p', // p2p | torbox | realdebrid
  httpRoute: 'auto', // auto | direct | torbox | realdebrid
  preferredDebrid: 'torbox',
  torboxKey: '',
  realdebridToken: '',
  clipboardMonitor: false,
  theme: 'system', // system | dark | oled | light | aero
  seedTimeMin: 0, // stop seeding after N minutes (0 = no limit)
  categories: {}, // name -> save path ('' = default folder)
  altDlKB: 500, // "turtle mode" alternative limits
  altUlKB: 100,
  altActive: false,
  schedule: { enabled: false, from: '01:00', to: '08:00', days: [0, 1, 2, 3, 4, 5, 6] }, // alt limits during this window
  searchProviders: [], // [{ name, url, apikey, enabled }] Torznab endpoints (Jackett / Prowlarr)
  autoExtract: true,
  extractSubfolder: true,
  packageSubfolder: true,
  deleteArchives: false,
  archivePasswords: [],
  apiPort: 6464,
  apiToken: '',
  cnlEnabled: true,
  whenDone: 'none', // none | quit | sleep | shutdown (one-shot, resets after firing)
  debridFallback: true, // if TorBox / Real-Debrid fails, retry without debrid (P2P for torrents, direct for links)
  ytFormat: 'mp4', // mp4 | mp3
  ytVideoQuality: '1080', // 2160 | 1440 | 1080 | 720 | 480 | best
  ytAudioQuality: '192', // 128 | 192 | 256 | 320
  ytCookiesBrowser: '', // '' | firefox | edge | chrome | brave (helps with "confirm you're not a bot")
  maxConcurrentMedia: 2, // YouTube rate-limits; keep this low
  autoUpdateTools: true,
  fallbackRetries: 2,
  downloadSchedule: [], // [{ id, time: 'HH:MM', days: [0-6], action: 'start' | 'pause' | 'turtle-on' | 'turtle-off' }]
  // ---- host special cases (JDownloader-style) ----
  autoRetries: 3, // connection problems: try again after 1, 5, 15 minutes before giving up
  fileExists: 'rename', // rename | skip | overwrite: when the file is already in the folder
  verifyHashes: true, // check CRC32/MD5/SHA from .sfv/.md5 files and host-reported hashes
  redownloadBad: true, // download a file again (once) when its hash doesn't match
  splitSegments: true, // when a connection finishes, help with the slowest remaining part
  hostLimits: {}, // 'host.com' -> { downloads, connections } (0 = no limit)
  proxies: [], // see net.js
  hostAccounts: {}, // host module id -> account fields (encrypted on disk)
};

const RETRY_WAITS = [60000, 5 * 60000, 15 * 60000];

// Fields of an item the user may change after it was added.
const EDITABLE = ['category', 'tags', 'limitKB', 'seedRatio', 'seedTimeMin', 'sequential', 'selectedFiles', 'extraTrackers', 'name'];

function magnetName(source) {
  if (!/^magnet:\?/i.test(source || '')) return null;
  try {
    return new URLSearchParams(source.slice(8)).get('dn');
  } catch {
    return null;
  }
}

const RUNNING = new Set(['active', 'resolving', 'seeding']);
const fmtWait = ms => (ms >= 3600000 ? `${Math.round(ms / 360000) / 10} h` : ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`);

class Manager extends EventEmitter {
  constructor({ statePath, settings = {}, items = [], torrentOptions = {}, hosters = null, tools = null }) {
    super();
    this.tools = tools || new ToolManager(path.join(path.dirname(statePath || '.'), 'tools'));
    this.hosters = hosters || new HosterRegistry(null);
    this.statePath = statePath;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.items = new Map(items.map(i => [i.id, i]));
    this.tasks = new Map(); // id -> HttpTask | AbortController (debrid)
    this.limiter = new RateLimiter();
    this.itemLimiters = new Map(); // id -> RateLimiter for per-download caps
    this.torrents = new TorrentEngine();
    this.torrentOptions = torrentOptions;
    this.dirty = false;
    this.hostWaits = new Map(); // host -> { until, reason } (a host told us to wait for every download)
  }

  async init() {
    await this.torrents.init(this.settings, this.torrentOptions);
    this.applySettings();
    for (const it of this.items.values()) {
      if (RUNNING.has(it.status)) it.status = it.status === 'seeding' ? 'seeding-queued' : 'queued';
      if (it.hash?.state === 'checking') it.hash = null; // a check cut short by quitting runs again below
      it.speed = it.upSpeed = it.peers = 0;
    }
    // Resume seeding for finished torrents that hadn't hit their ratio.
    for (const it of this.items.values()) if (it.status === 'seeding-queued') this.startTorrent(it, true);
    for (const it of this.items.values()) if (it.kind === 'http' && it.status === 'completed' && it.expectedHash && !it.hash) this.afterHttp(it).catch(() => {});
    this.timer = setInterval(() => this.tick(), 1000);
    this.saveTimer = setInterval(() => this.save(), 3000);
    this.schedule();
  }

  async shutdown() {
    clearInterval(this.timer);
    clearInterval(this.saveTimer);
    for (const [id, t] of this.tasks) {
      t.abort();
      const it = this.items.get(id);
      if (it) it.status = 'queued';
    }
    for (const it of this.items.values()) {
      if (this.torrents.active.has(it.id)) {
        this.torrents.stats(it);
        it.uploadedBase = it.uploaded;
        await this.torrents.stop(it.id);
      }
    }
    await this.save(true);
    await this.torrents.destroy();
  }

  // ---------- settings / providers ----------

  applySettings(patch = {}) {
    Object.assign(this.settings, patch);
    net.configure(this.settings.proxies);
    setAccounts(this.settings.hostAccounts);
    this.applyLimits();
    this.dirty = true;
    this.schedule();
  }

  // Alternative ("turtle") limits are on when toggled manually or inside the scheduled window.
  altLimitsOn(now = new Date()) {
    const s = this.settings;
    if (s.altActive) return true;
    const sch = s.schedule || {};
    if (!sch.enabled || !sch.days?.includes(now.getDay())) return false;
    const mins = t => {
      const [h, m] = String(t || '0:0').split(':').map(Number);
      return h * 60 + (m || 0);
    };
    const cur = now.getHours() * 60 + now.getMinutes();
    const from = mins(sch.from), to = mins(sch.to);
    return from <= to ? cur >= from && cur < to : cur >= from || cur < to; // window may wrap past midnight
  }

  applyLimits() {
    const alt = this.altLimitsOn();
    const dl = alt ? this.settings.altDlKB : this.settings.dlLimitKB;
    const ul = alt ? this.settings.altUlKB : this.settings.ulLimitKB;
    this.limitsAlt = alt;
    this.limiter.setRate(dl > 0 ? dl * 1024 : 0);
    this.torrents.applyLimits({ dlLimitKB: dl, ulLimitKB: ul });
  }

  provider(name) {
    if (name === 'torbox') return new TorBox(this.settings.torboxKey);
    if (name === 'realdebrid') return new RealDebrid(this.settings.realdebridToken);
    throw new Error(`Unknown debrid provider: ${name}`);
  }

  configuredDebrid() {
    const has = { torbox: !!this.settings.torboxKey, realdebrid: !!this.settings.realdebridToken };
    if (has[this.settings.preferredDebrid]) return this.settings.preferredDebrid;
    return Object.keys(has).find(k => has[k]) || null;
  }

  // Decide how a grabbed link is downloaded when the user didn't pick explicitly.
  // Hoster links go to a configured service that supports that host (preferred one first); otherwise a built-in resolver, otherwise direct.
  defaultRoute(entry) {
    if (entry.kind === 'media') return 'ytdlp';
    if (entry.kind === 'torrent') return this.settings.torrentRoute;
    if (this.settings.httpRoute !== 'auto') return this.settings.httpRoute;
    if (resolverFor(entry.source)?.premium) return 'direct'; // your own premium account for this host comes first
    const configured = { torbox: !!this.settings.torboxKey, realdebrid: !!this.settings.realdebridToken };
    const supported = this.hosters.providersFor(entry.source).filter(p => configured[p.provider]);
    if (supported.length) {
      const pref = supported.find(p => p.provider === this.settings.preferredDebrid && p.up);
      return (pref || supported.find(p => p.up) || supported[0]).provider;
    }
    if (resolverFor(entry.source)) return 'direct';
    return (entry.hoster || isHoster(entry.source)) && !this.hosters.list().updated ? this.configuredDebrid() || 'direct' : 'direct';
  }

  // Explains why a hoster link can't be downloaded with the current setup (or null).
  hosterAdvice(url) {
    const providers = this.hosters.providersFor(url);
    if (!providers.length) return resolverFor(url) ? null : 'None of your debrid services support this host.';
    const names = providers.map(p => (p.provider === 'torbox' ? 'TorBox' : 'Real-Debrid'));
    const has = { torbox: this.settings.torboxKey, realdebrid: this.settings.realdebridToken };
    if (providers.some(p => has[p.provider])) return `This host works through ${names.join(' or ')}. Pick it under "Download via".`;
    return `This host works through ${names.join(' or ')}. Add the API key in Settings → Debrid, or pick it under "Download via".`;
  }

  // ---------- adding ----------

  add(entries) {
    const added = [];
    for (const e of entries) {
      const via = e.via || this.defaultRoute(e);
      const infoHash = e.kind === 'torrent' ? e.infoHash || infoHashFromMagnet(e.source || '') : null;
      if (infoHash && [...this.items.values()].some(i => i.infoHash === infoHash && i.via === 'p2p' && via === 'p2p')) {
        continue; // duplicate torrent
      }
      const item = {
        id: crypto.randomUUID(),
        kind: e.kind, // http | torrent
        via, // direct | p2p | torbox | realdebrid
        source: e.source,
        torrentB64: e.torrentB64 || null,
        selectedFiles: Array.isArray(e.selectedFiles) ? e.selectedFiles : null,
        files: e.files || null,
        infoHash,
        name: e.name || magnetName(e.source) || infoHash || e.source,
        suggestedName: e.suggestedName || null,
        package: e.package || null,
        dir: e.dir || (e.category && this.settings.categories?.[e.category]) || this.settings.downloadDir,
        category: e.category || '',
        tags: Array.isArray(e.tags) ? e.tags : [],
        sequential: !!e.sequential,
        seedRatio: e.seedRatio ?? null,
        seedTimeMin: e.seedTimeMin ?? null,
        limitKB: e.limitKB || 0,
        extraTrackers: e.extraTrackers || [],
        rssRule: e.rssRule || null,
        mediaFormat: e.kind === 'media' ? e.mediaFormat || this.settings.ytFormat : undefined,
        mediaQuality: e.kind === 'media' ? e.mediaQuality || (e.mediaFormat === 'mp3' ? this.settings.ytAudioQuality : this.settings.ytVideoQuality) : undefined,
        playlist: e.kind === 'media' ? !!e.playlist : undefined,
        thumbnail: e.thumbnail || null,
        uploader: e.uploader || null,
        headers: e.headers || null,
        mirrors: Array.isArray(e.mirrors) ? e.mirrors.filter(m => typeof m === 'string' && /^https?:/i.test(m) && m !== e.source) : [],
        expectedHash: normalizeHash(e.hash),
        archivePasswords: Array.isArray(e.archivePasswords) ? e.archivePasswords : [],
        size: e.size || null,
        downloaded: 0,
        uploaded: 0,
        progress: 0,
        status: e.paused ? 'paused' : 'queued',
        error: null,
        parentId: e.parentId || null,
        createdAt: Date.now(),
      };
      this.items.set(item.id, item);
      added.push(item);
    }
    this.dirty = true;
    this.schedule();
    this.emitUpdate();
    return added;
  }

  // ---------- scheduling ----------

  isDebrid(it) {
    return it.via === 'torbox' || it.via === 'realdebrid';
  }

  // Host of the page a download came from (its own host for plain links).
  hostKey(it) {
    return hostOf(it.pageUrl || it.source) || '';
  }

  // { downloads, connections } for a host: your setting, else the host's free-mode limit (0 = none).
  hostLimit(host, resolver) {
    const lim = this.settings.hostLimits || {};
    const key = Object.keys(lim).find(d => host === d.toLowerCase() || host.endsWith('.' + d.toLowerCase()));
    const mine = key ? lim[key] || {} : {};
    return {
      downloads: Number(mine.downloads) || resolver?.maxDownloads || 0,
      connections: Number(mine.connections) || resolver?.maxConnections || 0,
    };
  }

  // A host said "wait" for every download from it (IP limit, too many requests).
  hostWaiting(host, now = Date.now()) {
    const w = this.hostWaits.get(host);
    if (w && w.until > now) return w;
    if (w) this.hostWaits.delete(host);
    return null;
  }

  schedule() {
    const all = [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
    const perHost = new Map();
    for (const i of all) if (i.status === 'active' && i.kind === 'http' && !this.isDebrid(i)) perHost.set(this.hostKey(i), (perHost.get(this.hostKey(i)) || 0) + 1);
    let http = all.filter(i => i.status === 'active' && i.kind === 'http' && !this.isDebrid(i)).length;
    let tor = all.filter(i => i.status === 'active' && i.via === 'p2p').length;
    let media = all.filter(i => i.status === 'active' && i.kind === 'media').length;
    for (const it of all) {
      if (it.status !== 'queued') continue;
      if (it.kind === 'media') {
        if (media < (this.settings.maxConcurrentMedia || 2)) {
          media++;
          this.startMedia(it);
        }
      } else if (this.isDebrid(it)) this.startDebrid(it);
      else if (it.kind === 'http' && http < this.settings.maxConcurrent) {
        const host = this.hostKey(it);
        const waiting = this.hostWaiting(host);
        if (waiting) {
          this.setWaiting(it, waiting.until - Date.now(), `Waiting for ${host}: ${waiting.reason}`);
          continue;
        }
        const max = this.hostLimit(host, resolverFor(it.source)).downloads;
        if (max && (perHost.get(host) || 0) >= max) continue; // stays queued until a slot on that host frees up
        perHost.set(host, (perHost.get(host) || 0) + 1);
        http++;
        this.startHttp(it);
      } else if (it.via === 'p2p' && tor < this.settings.maxActiveTorrents) {
        tor++;
        this.startTorrent(it);
      }
    }
  }

  takenPaths(except) {
    const s = new Set();
    for (const i of this.items.values()) {
      if (i !== except && i.kind === 'http' && i.filename) s.add(path.join(i.dir, i.filename).toLowerCase());
    }
    return s;
  }

  startHttp(it) {
    it.status = 'active';
    it.error = null;
    let itemLimiter = null;
    if (it.limitKB > 0) {
      itemLimiter = new RateLimiter(it.limitKB * 1024);
      this.itemLimiters.set(it.id, itemLimiter);
    }
    const resolver = resolverFor(it.source);
    const lim = this.hostLimit(this.hostKey(it), resolver);
    const connections = lim.connections ? Math.min(lim.connections, this.settings.connectionsPerDownload) : this.settings.connectionsPerDownload;
    const route = it.route || 0;
    it.host = resolver ? resolver.name + (resolver.premium ? ' premium' : '') : null;
    const task = new HttpTask(it, {
      resolve: resolver ? signal => resolver.resolve(it.source, signal, route) : null,
      limiter: this.limiter,
      itemLimiter,
      connections,
      route,
      split: this.settings.splitSegments !== false,
      exists: this.settings.fileExists || 'rename',
      taken: this.takenPaths(it),
    });
    this.tasks.set(it.id, task);
    task
      .run()
      .then(() => {
        it.status = 'completed';
        it.progress = 1;
        it.completedAt = Date.now();
        it.retries = 0;
        it.waitUntil = null;
        if (it.skipped) it.note = 'Already in the folder, skipped';
        this.emit('completed', it);
        this.afterHttp(it).catch(e => console.error('[after]', e.message));
      })
      .catch(e => {
        if (e.name === 'AbortError') return;
        if (this.handleHostError(it, e)) return;
        if (e instanceof PageError) {
          const advice = this.hosterAdvice(it.source);
          e.message = `This link is a web page, not a file.${advice ? ' ' + advice : ''}`;
        }
        // The direct link a debrid service gave us died (its servers can go offline): fetch the original without debrid.
        const parent = it.parentId && this.items.get(it.parentId);
        if (parent && parent.kind === 'http' && this.isDebridVia(parent.fallbackFrom || parent.via) && !parent.fallbackFrom && this.settings.debridFallback !== false) {
          this.items.delete(it.id);
          return this.fallBack(parent, e);
        }
        // Retrying without debrid: try again a couple of times before giving up (pages can't be retried into files).
        if (it.fallbackFrom && !(e instanceof PageError) && (it.fallbackAttempts || 0) < (this.settings.fallbackRetries ?? 2)) {
          it.fallbackAttempts = (it.fallbackAttempts || 0) + 1;
          it.status = 'retrying';
          it.error = `${e.message}, retry ${it.fallbackAttempts} of ${this.settings.fallbackRetries ?? 2}`;
          setTimeout(() => {
            if (it.status !== 'retrying') return;
            it.status = 'queued';
            this.schedule();
          }, 5000);
          return;
        }
        if (this.tryMirror(it, e)) return;
        if (!(e instanceof PageError) && !(e instanceof HostError && (e.permanent || e.browser)) && this.autoRetry(it, e)) return;
        if (it.fallbackFrom) e.message = `${e.message} (${this.providerName(it.fallbackFrom)} failed first: ${it.fallbackReason})`;
        this.fail(it, e);
        // A file host's page (wait timer, captcha, "click to download"): a person has to do that part in the browser.
        if ((e instanceof PageError || (e instanceof HostError && e.browser)) && /^https?:/i.test(it.source) && !moduleFor(it.source)?.noBrowser) {
          it.needsBrowser = true;
          it.pageUrl = it.pageUrl || it.source;
          this.emit('needsBrowser', it);
        }
      })
      .finally(() => {
        if (this.tasks.get(it.id) === task) this.tasks.delete(it.id);
        this.itemLimiters.delete(it.id);
        it.speed = 0;
        this.dirty = true;
        this.schedule();
        this.emitUpdate();
      });
  }

  // YouTube & other media sites through yt-dlp. Pausing stops yt-dlp; resuming reruns it and it continues its .part files.
  startMedia(it) {
    it.status = 'active';
    it.error = null;
    it.stage = 'Starting';
    const task = new MediaTask(it, { tools: this.tools, settings: this.settings });
    this.tasks.set(it.id, task);
    task
      .run()
      .then(() => {
        it.status = 'completed';
        it.progress = 1;
        it.stage = null;
        it.completedAt = Date.now();
        if (it.playlistTitle && it.playlistCount) it.name = `${it.playlistTitle} (${it.files.length} files)`;
        this.emit('completed', it);
      })
      .catch(e => {
        if (e.name !== 'AbortError') this.fail(it, e);
      })
      .finally(() => {
        if (this.tasks.get(it.id) === task) this.tasks.delete(it.id);
        it.speed = 0;
        this.dirty = true;
        this.schedule();
        this.emitUpdate();
      });
  }

  startTorrent(it, seedingOnly = false) {
    it.status = seedingOnly ? 'seeding' : 'active';
    it.error = null;
    try {
      this.torrents.start(it, {
        onMetadata: () => {
          this.dirty = true;
          this.emitUpdate();
        },
        onDone: () => {
          it.progress = 1;
          if (!it.completedAt) {
            it.completedAt = Date.now();
            this.emit('completed', it);
            this.maybeExtract(it).catch(e => console.error('[extract]', e.message));
          }
          it.status = 'seeding';
          this.checkSeedLimit(it);
          this.dirty = true;
          this.schedule();
        },
        onError: e => {
          this.torrents.stop(it.id).catch(() => {});
          this.fail(it, e);
          this.schedule();
        },
      });
    } catch (e) {
      this.fail(it, e);
    }
  }

  async checkSeedLimit(it) {
    if (it.status !== 'seeding') return;
    it.seedingSince = it.seedingSince || Date.now();
    const limit = Number(it.seedRatio ?? this.settings.seedRatio);
    const minutes = Number(it.seedTimeMin ?? this.settings.seedTimeMin) || 0;
    const ratioHit = limit >= 0 && (limit === 0 || (it.ratio || 0) >= limit); // negative ratio = no ratio limit
    const timeHit = minutes > 0 && Date.now() - it.seedingSince >= minutes * 60000;
    if (ratioHit || timeHit) {
      this.torrents.stats(it);
      it.uploadedBase = it.uploaded;
      await this.torrents.stop(it.id);
      it.status = 'completed';
      it.speed = it.upSpeed = it.peers = 0;
      this.dirty = true;
      this.emitUpdate();
    }
  }

  async startDebrid(it) {
    it.status = 'resolving';
    it.error = null;
    const ac = new AbortController();
    this.tasks.set(it.id, ac);
    const signal = ac.signal;
    try {
      const provider = this.provider(it.via);
      const hooks = {
        signal,
        remoteId: it.remoteId,
        onRemoteId: id => {
          it.remoteId = id;
          this.dirty = true;
        },
        onProgress: p => {
          it.remote = { ...p, provider: provider.name };
          it.progress = p.progress;
          it.speed = p.speed;
          if (p.name && (it.name === it.source || it.name === it.infoHash)) it.name = p.name;
          this.emitUpdate();
        },
      };
      let files;
      if (it.kind === 'torrent') {
        const job = { remoteId: it.remoteId };
        if (it.selectedFiles && it.files) {
          job.wanted = new Set(it.selectedFiles.map(i => it.files[i]).filter(Boolean).map(f => fileKey(f.path, f.size)));
        }
        if (it.torrentB64) job.buffer = Buffer.from(it.torrentB64, 'base64');
        else if (/^https?:/i.test(it.source)) job.buffer = Buffer.from(await (await fetch(it.source, { signal })).arrayBuffer());
        else job.magnet = it.source;
        files = await provider.resolveTorrent(job, hooks);
      } else {
        files = await provider.resolveLink(it.source, hooks);
      }
      const pkg = sanitize(it.package || it.name);
      const dir = files.length > 1 ? safeJoin(it.dir, pkg) : it.dir;
      const children = this.add(
        files.map(f => ({
          kind: 'http',
          via: 'direct',
          source: f.url,
          name: f.filename,
          suggestedName: f.filename,
          size: f.size,
          package: pkg,
          dir,
          parentId: it.id,
        }))
      );
      it.childIds = children.map(c => c.id);
      it.status = 'handed-off';
      it.progress = 1;
      it.speed = 0;
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (this.settings.debridFallback !== false) this.fallBack(it, e);
      else this.fail(it, e);
    } finally {
      if (this.tasks.get(it.id) === ac) this.tasks.delete(it.id);
      this.dirty = true;
      this.emitUpdate();
    }
  }

  // ---------- host special cases: waits, retries, mirrors ----------

  setWaiting(it, ms, reason) {
    it.status = 'waiting';
    it.waitUntil = Date.now() + Math.max(1000, ms);
    it.error = reason;
    it.speed = 0;
    this.dirty = true;
    this.emitUpdate();
  }

  // Waits the host asked for (Retry-After, "wait 30 minutes", quota, full disk). Returns true when handled.
  handleHostError(it, e) {
    if (!(e instanceof HostError) || !e.wait) return false;
    const host = this.hostKey(it);
    // An IP limit can be dodged by moving to the next proxy route (JDownloader's proxy rotation).
    if (e.ipLimit && net.routeCount(it.source) > 1 && (it.routeTries || 0) < net.routeCount(it.source) - 1) {
      it.routeTries = (it.routeTries || 0) + 1;
      it.route = (it.route || 0) + 1;
      it.status = 'queued';
      it.error = null;
      Object.assign(it, { probed: false, segments: null, downloaded: it.resumable ? it.downloaded : 0 });
      this.emit('hostWait', it, `${e.message}: switched to ${net.routeLabel(it.source, it.route)}`);
      return true;
    }
    if (it.mirrors?.length && !e.diskFull && this.tryMirror(it, e)) return true;
    if (e.hostWide && host) this.hostWaits.set(host, { until: Date.now() + e.wait, reason: e.message });
    this.setWaiting(it, e.wait, `${e.message}. Trying again in ${fmtWait(e.wait)}`);
    this.emit('hostWait', it, e.message);
    return true;
  }

  // Connection problems: wait 1, 5, 15 minutes between tries (setting autoRetries), like JDownloader's retry.
  autoRetry(it, e) {
    const max = Number(this.settings.autoRetries ?? 3);
    if ((it.retries || 0) >= max) return false;
    const ms = RETRY_WAITS[Math.min(it.retries || 0, RETRY_WAITS.length - 1)];
    it.retries = (it.retries || 0) + 1;
    this.setWaiting(it, ms, `${e.message}. Try ${it.retries + 1} of ${max + 1} in ${fmtWait(ms)}`);
    return true;
  }

  // Another host has the same file: switch to it (JDownloader's mirror handling). Returns true when switched.
  tryMirror(it, e) {
    if (it.kind !== 'http' || !it.mirrors?.length) return false;
    const next = it.mirrors.shift();
    const old = it.source;
    it.triedMirrors = [...(it.triedMirrors || []), old];
    const oldPart = it.filename && !it.downloaded ? null : it.filename && path.join(it.dir, it.filename + '.part');
    if (oldPart) fsp.rm(oldPart, { force: true }).catch(() => {});
    Object.assign(it, {
      source: next,
      pageUrl: null,
      needsBrowser: false,
      via: this.defaultRoute({ kind: 'http', source: next }),
      probed: false,
      segments: null,
      filename: null,
      downloaded: 0,
      progress: 0,
      route: 0,
      routeTries: 0,
      retries: 0,
      status: 'queued',
      error: null,
      fallbackFrom: null,
      remote: null,
      remoteId: null,
    });
    this.dirty = true;
    this.emit('mirror', it, { from: hostOf(old), to: hostOf(next), reason: e?.message || '' });
    this.schedule();
    this.emitUpdate();
    return true;
  }

  // ---------- after a direct download: hash check, then extraction ----------

  async afterHttp(it) {
    if (this.settings.verifyHashes !== false && !it.skipped) {
      const bad = await this.verifyFile(it);
      if (bad) return;
      if (await this.verifyPackage(it)) return;
    }
    await this.maybeExtract(it);
  }

  // A file whose hash doesn't match is downloaded again once, then marked damaged. Returns true when it was bad.
  async markBad(it, algo) {
    const name = algo.toUpperCase();
    if (this.settings.redownloadBad !== false && !it.redownloaded) {
      it.redownloaded = true;
      try {
        await fsp.rm(path.join(it.dir, it.filename), { force: true });
      } catch {}
      Object.assign(it, { status: 'queued', probed: false, segments: null, downloaded: 0, progress: 0, hash: { state: 'bad', algo }, error: null });
      this.emit('hashBad', it, `${name} mismatch, downloading again`);
      this.schedule();
    } else {
      it.status = 'error';
      it.error = `Damaged download: ${name} doesn't match`;
      it.hash = { state: 'bad', algo };
      this.emit('hashBad', it, it.error);
    }
    this.dirty = true;
    this.emitUpdate();
    return true;
  }

  async checkHash(it, want) {
    it.hash = { state: 'checking', algo: want.algo, progress: 0 };
    this.emitUpdate();
    const got = await hashFile(path.join(it.dir, it.filename), want.algo, {
      onProgress: p => {
        it.hash = { ...it.hash, progress: p };
        this.emitUpdate();
      },
    });
    if (got !== want.value) return this.markBad(it, want.algo);
    it.hash = { state: 'ok', algo: want.algo };
    this.dirty = true;
    this.emitUpdate();
    return false;
  }

  async verifyFile(it) {
    if (!it.expectedHash || !it.filename) return false;
    try {
      return await this.checkHash(it, it.expectedHash);
    } catch (e) {
      it.hash = { state: 'error', error: e.message };
      return false;
    }
  }

  // When the whole package is done, check its files against any .sfv/.md5/.sha* that came with it.
  async verifyPackage(it) {
    if (!it.package) return false;
    const group = [...this.items.values()].filter(i => i.kind === 'http' && i.package === it.package && i.dir === it.dir);
    if (!group.every(i => i.status === 'completed')) return false;
    const want = expectedFromHashFiles(it.dir, group.map(i => i.filename).filter(Boolean));
    if (!want.size) return false;
    let bad = false;
    for (const i of group) {
      const w = i.filename && want.get(i.filename.toLowerCase());
      if (!w || i.hash?.state === 'ok') continue;
      try {
        if (await this.checkHash(i, w)) bad = true;
      } catch (e) {
        i.hash = { state: 'error', error: e.message };
      }
    }
    return bad;
  }

  isDebridVia(via) {
    return via === 'torbox' || via === 'realdebrid';
  }

  providerName(via) {
    return { torbox: 'TorBox', realdebrid: 'Real-Debrid' }[via] || via;
  }

  // Debrid failed: download it ourselves instead (P2P for torrents, the host link directly otherwise).
  fallBack(it, err) {
    it.fallbackFrom = it.via;
    it.fallbackReason = err?.message || String(err);
    it.fallbackAttempts = 0;
    it.via = it.kind === 'torrent' ? 'p2p' : 'direct';
    it.remote = null;
    it.remoteId = null;
    it.childIds = [];
    it.progress = 0;
    it.speed = 0;
    it.error = null;
    it.status = 'queued';
    // A file-host page has no file name yet; let the HTTP engine discover it.
    if (it.kind === 'http') Object.assign(it, { probed: false, segments: null, filename: null, downloaded: 0 });
    this.dirty = true;
    this.emit('fallback', it);
    this.schedule();
    this.emitUpdate();
  }

  fail(it, e) {
    it.status = 'error';
    it.error = e?.message || String(e);
    it.speed = it.upSpeed = 0;
    this.dirty = true;
    this.emitUpdate();
  }

  // ---------- user actions ----------

  async pause(id) {
    const it = this.items.get(id);
    if (!it) return;
    if (!['active', 'queued', 'resolving', 'seeding', 'retrying', 'waiting'].includes(it.status)) return;
    const wasSeeding = it.status === 'seeding';
    it.status = wasSeeding ? 'completed' : 'paused';
    this.tasks.get(id)?.abort();
    if (this.torrents.active.has(id)) {
      this.torrents.stats(it);
      it.uploadedBase = it.uploaded;
      await this.torrents.stop(id);
    }
    it.speed = it.upSpeed = it.peers = 0;
    this.dirty = true;
    this.schedule();
    this.emitUpdate();
  }

  // ---------- browser hand-off (JDownloader's "open in browser" for hosts with waits or captchas) ----------
  // The page opens in the user's browser; they wait / solve the captcha and click download there; the Hakobu
  // extension catches that download and browserHandoff() restarts this same item with the real file URL.
  browserOpened(id) {
    const it = this.items.get(id);
    if (!it?.needsBrowser) return null;
    it.status = 'browser';
    it.error = null;
    it.browserOpenedAt = Date.now();
    this.dirty = true;
    this.emitUpdate();
    return it.pageUrl;
  }

  // The waiting item a browser download belongs to: same page first, else the newest one opened on that site.
  // Hosts often serve the file from a sub-domain, and some downloads carry no referrer, so the file's own URL counts too.
  matchBrowserWait(referrer, url) {
    const site = u => {
      try {
        const parts = new URL(u).hostname.split('.');
        return parts.slice(/^(co|com|net|org)$/.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? -3 : -2).join('.');
      } catch {
        return '';
      }
    };
    const page = u => String(u || '').replace(/#.*$/, '').replace(/\/+$/, '');
    const sites = [site(referrer), site(url)].filter(Boolean);
    if (!sites.length) return null;
    const waiting = [...this.items.values()].filter(i => i.needsBrowser && i.status === 'browser' && sites.includes(site(i.pageUrl)));
    return waiting.find(i => page(i.pageUrl) === page(referrer)) || waiting.sort((a, b) => b.browserOpenedAt - a.browserOpenedAt)[0] || null;
  }

  browserHandoff(id, entry) {
    const it = this.items.get(id);
    if (!it) return;
    Object.assign(it, { source: entry.source, headers: entry.headers || null, needsBrowser: false, status: 'queued', error: null, downloaded: 0, progress: 0, size: null });
    if (entry.suggestedName) it.suggestedName = entry.suggestedName;
    delete it.segments;
    delete it.resumable;
    this.dirty = true;
    this.schedule();
    this.emitUpdate();
  }

  resume(id) {
    const it = this.items.get(id);
    if (!it || !['paused', 'error', 'retrying', 'browser', 'waiting'].includes(it.status)) return;
    // Resume = "start now": skip this item's wait (a host-wide wait is lifted too, the user asked for it).
    if (it.status === 'waiting') this.hostWaits.delete(this.hostKey(it));
    if (it.status === 'error') it.retries = 0;
    it.status = 'queued';
    it.error = null;
    it.waitUntil = null;
    this.dirty = true;
    this.schedule();
    this.emitUpdate();
  }

  // Re-seed a finished torrent (qBittorrent's "force resume" on a completed torrent).
  seed(id) {
    const it = this.items.get(id);
    if (it?.via === 'p2p' && it.status === 'completed' && !this.torrents.active.has(id)) this.startTorrent(it, true);
  }

  // ---------- archive extraction (JDownloader-style) ----------

  // When every file of a package is finished, extract its archives. Torrents extract in place and keep their archives (still seeding).
  async maybeExtract(it) {
    if (!this.settings.autoExtract) return;
    let dir, names, owners, keep;
    if (it.via === 'p2p') {
      const files = (it.files || []).filter(f => f.selected !== false).map(f => f.path);
      if (!files.some(f => isFirstVolume(f))) return;
      dir = it.dir;
      names = files;
      owners = [it];
      keep = true;
    } else {
      const group = it.package ? [...this.items.values()].filter(i => i.kind === 'http' && i.package === it.package && i.dir === it.dir) : [it];
      if (!group.every(i => i.status === 'completed')) return; // wait for the rest of the package
      names = group.map(i => i.filename).filter(Boolean);
      if (!names.some(isFirstVolume) || group.some(i => i.extract)) return;
      dir = it.dir;
      owners = group;
      keep = !this.settings.deleteArchives;
    }
    const passwords = [...new Set([...owners.flatMap(o => o.archivePasswords || []), ...(this.settings.archivePasswords || [])])];
    const byFile = new Map(owners.map(o => [o.filename, o]));
    const owner = name => byFile.get(name) || it;
    names.filter(isFirstVolume).forEach(n => (owner(n).extract = { state: 'queued', progress: 0 }));
    this.emitUpdate();
    await extractAll(dir, names, {
      subfolder: this.settings.extractSubfolder,
      deleteAfter: !keep,
      passwords,
      onState: (name, state) => {
        owner(name).extract = { ...state, archive: name };
        this.dirty = true;
        this.emitUpdate();
        if (state.state === 'done') this.emit('extracted', owner(name), state);
        if (state.state === 'error' || state.state === 'password') this.emit('extractFailed', owner(name), state);
      },
    });
  }

  // Retry extraction (e.g. after adding the right password to the list).
  async extractNow(id) {
    const it = this.items.get(id);
    if (!it || it.status !== 'completed' && it.status !== 'seeding') return;
    const group = it.package ? [...this.items.values()].filter(i => i.package === it.package && i.dir === it.dir) : [it];
    group.forEach(i => delete i.extract);
    const enabled = this.settings.autoExtract;
    this.settings.autoExtract = true;
    try {
      await this.maybeExtract(it);
    } finally {
      this.settings.autoExtract = enabled;
    }
  }

  // ---------- download scheduler + "when done" ----------

  runSchedule(now = new Date()) {
    const hhmm = now.toTimeString().slice(0, 5);
    const key = now.toDateString() + ' ' + hhmm;
    if (this.lastScheduleKey === key) return;
    this.lastScheduleKey = key;
    for (const job of this.settings.downloadSchedule || []) {
      if (job.time !== hhmm || !(job.days || []).includes(now.getDay())) continue;
      this.emit('scheduled', job);
      if (job.action === 'start') for (const i of this.items.values()) this.resume(i.id);
      if (job.action === 'pause') for (const i of this.items.values()) if (['active', 'queued', 'resolving', 'waiting'].includes(i.status)) Promise.resolve(this.pause(i.id)).catch(() => {});
      if (job.action === 'turtle-on' || job.action === 'turtle-off') this.applySettings({ altActive: job.action === 'turtle-on' });
    }
  }

  // True while anything is still downloading (seeding doesn't count).
  busy() {
    return [...this.items.values()].some(i => ['active', 'queued', 'resolving', 'retrying', 'waiting'].includes(i.status) || ['queued', 'extracting'].includes(i.extract?.state) || i.hash?.state === 'checking');
  }

  checkAllDone() {
    const busy = this.busy();
    if (this.wasBusy && !busy && this.settings.whenDone !== 'none') {
      const action = this.settings.whenDone;
      this.settings.whenDone = 'none'; // one-shot, like JDownloader
      this.dirty = true;
      this.emit('allDone', action);
    }
    this.wasBusy = busy;
  }

  // Change options on an existing item. Torrents restart when their file selection, strategy or trackers change.
  async update(id, patch) {
    const it = this.items.get(id);
    if (!it) return;
    const restartKeys = ['selectedFiles', 'sequential', 'extraTrackers'];
    const needsRestart = this.torrents.active.has(id) && restartKeys.some(k => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(it[k]));
    for (const k of EDITABLE) if (k in patch) it[k] = patch[k];
    if ('selectedFiles' in patch && it.files) {
      const sel = it.selectedFiles ? new Set(it.selectedFiles) : null;
      it.files = it.files.map((f, i) => ({ ...f, selected: !sel || sel.has(i) }));
      it.size = it.files.reduce((a, f) => a + (f.selected ? f.size : 0), 0);
    }
    if ('limitKB' in patch) {
      const lim = this.itemLimiters.get(id);
      if (lim) lim.setRate(it.limitKB > 0 ? it.limitKB * 1024 : 0);
      else if (it.limitKB > 0 && this.tasks.get(id)?.setItemLimiter) {
        const l = new RateLimiter(it.limitKB * 1024);
        this.itemLimiters.set(id, l);
        this.tasks.get(id).setItemLimiter(l);
      }
    }
    if (needsRestart) {
      this.torrents.stats(it);
      it.uploadedBase = it.uploaded;
      await this.torrents.stop(id);
      if (it.status === 'seeding') it.status = 'active';
      this.startTorrent(it);
    }
    if (it.status === 'seeding') this.checkSeedLimit(it);
    this.dirty = true;
    this.emitUpdate();
  }

  // Like qBittorrent, changing a category's folder only affects new downloads.
  setCategories(categories) {
    this.settings.categories = categories;
    for (const it of this.items.values()) if (it.category && !(it.category in categories)) it.category = '';
    this.dirty = true;
    this.emitUpdate();
  }

  peers(id) {
    return this.torrents.peers(id);
  }

  trackers(id) {
    const it = this.items.get(id);
    return it ? this.torrents.trackers(id, it) : [];
  }

  async remove(id, deleteFiles = false) {
    const it = this.items.get(id);
    if (!it) return;
    this.tasks.get(id)?.abort();
    await this.torrents.stop(id);
    this.items.delete(id);
    if (deleteFiles) {
      const names =
        it.kind === 'http' && it.filename ? [it.filename, it.filename + '.part']
        : it.kind === 'media' ? (it.files || []).map(f => path.relative(it.dir, f))
        : it.via === 'p2p' && it.name ? [it.name] : [];
      for (const n of names) {
        try {
          await fsp.rm(safeJoin(it.dir, n), { recursive: true, force: true });
        } catch (e) {
          console.error('[remove]', e.message);
        }
      }
    }
    this.dirty = true;
    this.schedule();
    this.emitUpdate();
  }

  location(id) {
    const it = this.items.get(id);
    if (!it) return null;
    if (it.kind === 'media') return it.filepath || it.dir;
    const name = it.kind === 'http' ? it.filename : it.name;
    return name ? safeJoin(it.dir, name) : it.dir;
  }

  // ---------- reporting ----------

  tick() {
    this.runSchedule();
    let woke = false;
    const now = Date.now();
    for (const it of this.items.values()) {
      if (it.status === 'waiting' && (it.waitUntil || 0) <= now) {
        it.status = 'queued';
        it.error = null;
        it.waitUntil = null;
        woke = true;
      }
    }
    if (woke) {
      this.dirty = true;
      this.schedule();
    }
    if (Date.now() - (this.lastResumeCapture || 0) > 60000) {
      this.lastResumeCapture = Date.now();
      for (const id of this.torrents.active.keys()) this.torrents.captureResume(id);
    }
    this.checkAllDone();
    if (this.altLimitsOn() !== this.limitsAlt) {
      this.applyLimits();
      this.emit('limits', this.limitsAlt);
    }
    for (const it of this.items.values()) {
      if (this.torrents.active.has(it.id)) {
        this.torrents.stats(it);
        if (it.status === 'seeding') this.checkSeedLimit(it);
      } else if (it.kind === 'http' && it.status === 'active') {
        const delta = it.downloaded - (it._last ?? it.downloaded);
        it.speed = Math.round((it.speed || 0) * 0.4 + delta * 0.6);
        it.progress = it.size ? it.downloaded / it.size : 0;
      }
      it._last = it.downloaded;
    }
    // Active downloads are saved every few seconds; seeding-only stats (upload, ratio) every minute.
    const all = [...this.items.values()];
    if (all.some(i => i.status === 'active' || i.status === 'resolving')) this.dirty = true;
    else if (all.some(i => i.status === 'seeding') && Date.now() - (this.lastSeedSave || 0) > 60000) {
      this.lastSeedSave = Date.now();
      this.dirty = true;
    }
    this.emitUpdate();
  }

  snapshot() {
    return [...this.items.values()].map(({ _last, segments, torrentB64, headers, resume, ...rest }) => rest);
  }

  emitUpdate() {
    if (this.pendingEmit) return;
    this.pendingEmit = setTimeout(() => {
      this.pendingEmit = null;
      this.emit('update', this.snapshot());
    }, 150);
  }

  // Saves run one at a time (the 3 s timer, shutdown and others may overlap) and never throw:
  // a failed write (disk full, file locked by OneDrive or antivirus) keeps the state dirty for the next try.
  save(force = false) {
    this.saveChain = (this.saveChain || Promise.resolve()).then(() => this.writeState(force)).catch(e => {
      this.dirty = true;
      if (this.lastSaveError !== e.message) console.error('[save]', e.message);
      this.lastSaveError = e.message;
    });
    return this.saveChain;
  }

  async writeState(force) {
    if (!this.statePath || (!this.dirty && !force)) return;
    this.dirty = false;
    const items = [...this.items.values()].map(({ _last, speed, upSpeed, peers, ...rest }) => rest);
    const tmp = this.statePath + '.tmp';
    await fsp.mkdir(path.dirname(this.statePath), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify({ items }));
    await renameRetry(tmp, this.statePath);
    this.lastSaveError = null;
  }
}

// Windows refuses a rename for a moment while another program (antivirus, OneDrive, Explorer) has the file open.
async function renameRetry(from, to, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      return await fsp.rename(from, to);
    } catch (e) {
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await new Promise(r => setTimeout(r, 100 * i));
    }
  }
}

// Reads a JSON state file. A file that exists but can't be parsed is kept as "<name>.corrupt-<time>" instead of being
// overwritten by the next save, and the last good temp copy is used when there is one. onCorrupt(backupPath) reports it.
function readJsonSafe(file, onCorrupt) {
  if (!fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file + '.tmp', 'utf8')); // a crash between write and rename
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.copyFileSync(file, backup);
    } catch {}
    console.error('[state] unreadable', file, e.message);
    onCorrupt?.(backup);
    try {
      return JSON.parse(fs.readFileSync(file + '.tmp', 'utf8'));
    } catch {
      return null;
    }
  }
}

function loadItems(statePath, onCorrupt) {
  const data = readJsonSafe(statePath, onCorrupt);
  return Array.isArray(data?.items) ? data.items : [];
}

module.exports = { Manager, DEFAULT_SETTINGS, loadItems, readJsonSafe, renameRetry };
