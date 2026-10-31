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
const { HosterRegistry } = require('./hosters');
const { resolverFor } = require('./resolvers');
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
};

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
  }

  async init() {
    await this.torrents.init(this.settings, this.torrentOptions);
    this.applySettings();
    for (const it of this.items.values()) {
      if (RUNNING.has(it.status)) it.status = it.status === 'seeding' ? 'seeding-queued' : 'queued';
      it.speed = it.upSpeed = it.peers = 0;
    }
    // Resume seeding for finished torrents that hadn't hit their ratio.
    for (const it of this.items.values()) if (it.status === 'seeding-queued') this.startTorrent(it, true);
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

  schedule() {
    const all = [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
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
    const task = new HttpTask(it, {
      resolve: resolver ? signal => resolver.resolve(it.source, signal) : null,
      limiter: this.limiter,
      itemLimiter,
      connections: this.settings.connectionsPerDownload,
      taken: this.takenPaths(it),
    });
    this.tasks.set(it.id, task);
    task
      .run()
      .then(() => {
        it.status = 'completed';
        it.progress = 1;
        it.completedAt = Date.now();
        this.emit('completed', it);
        this.maybeExtract(it);
      })
      .catch(e => {
        if (e.name === 'AbortError') return;
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
        if (it.fallbackFrom) e.message = `${e.message} (${this.providerName(it.fallbackFrom)} failed first: ${it.fallbackReason})`;
        this.fail(it, e);
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
            this.maybeExtract(it);
          }
          it.status = 'seeding';
          this.checkSeedLimit(it);
          this.dirty = true;
          this.schedule();
        },
        onError: e => {
          this.torrents.stop(it.id);
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
    if (!['active', 'queued', 'resolving', 'seeding', 'retrying'].includes(it.status)) return;
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

  resume(id) {
    const it = this.items.get(id);
    if (!it || !['paused', 'error', 'retrying'].includes(it.status)) return;
    it.status = 'queued';
    it.error = null;
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
      if (job.action === 'pause') for (const i of this.items.values()) if (['active', 'queued', 'resolving'].includes(i.status)) this.pause(i.id);
      if (job.action === 'turtle-on' || job.action === 'turtle-off') this.applySettings({ altActive: job.action === 'turtle-on' });
    }
  }

  // True while anything is still downloading (seeding doesn't count).
  busy() {
    return [...this.items.values()].some(i => ['active', 'queued', 'resolving', 'retrying'].includes(i.status) || ['queued', 'extracting'].includes(i.extract?.state));
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

  async save(force = false) {
    if (!this.statePath || (!this.dirty && !force)) return;
    this.dirty = false;
    const items = [...this.items.values()].map(({ _last, speed, upSpeed, peers, ...rest }) => rest);
    const tmp = this.statePath + '.tmp';
    await fsp.mkdir(path.dirname(this.statePath), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify({ items }));
    await fsp.rename(tmp, this.statePath);
  }
}

function loadItems(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8')).items || [];
  } catch {
    return [];
  }
}

module.exports = { Manager, DEFAULT_SETTINGS, loadItems };
