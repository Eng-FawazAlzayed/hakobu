// RSS / Atom / Torznab parsing, RSS auto-download rules, and Torznab search (Jackett / Prowlarr).
// No XML dependency: feeds are flat enough for a tolerant regex parser.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Hakobu/0.1';

function decode(s) {
  return String(s || '')
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&')
    .trim();
}
const tag = (xml, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? decode(m[1]) : '';
};
const attr = (xml, tagName, attrName, where = '') => {
  const m = new RegExp(`<${tagName}\\b[^>]*${where}[^>]*>`, 'i').exec(xml);
  if (!m) return '';
  const a = new RegExp(`\\b${attrName}\\s*=\\s*"([^"]*)"`, 'i').exec(m[0]) || new RegExp(`\\b${attrName}\\s*=\\s*'([^']*)'`, 'i').exec(m[0]);
  return a ? decode(a[1]) : '';
};
const torznab = (xml, name) => {
  const m = new RegExp(`<(?:torznab|newznab):attr[^>]*name="${name}"[^>]*value="([^"]*)"`, 'i').exec(xml);
  return m ? decode(m[1]) : '';
};

function parseFeed(xml) {
  const title = tag(xml.replace(/<(item|entry)\b[\s\S]*$/i, ''), 'title');
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  const items = blocks.map(b => {
    const link = tag(b, 'link') || attr(b, 'link', 'href');
    const enclosure = attr(b, 'enclosure', 'url');
    const magnet =
      torznab(b, 'magneturl') ||
      [link, enclosure, tag(b, 'guid')].find(u => /^magnet:/i.test(u)) ||
      (/(magnet:\?[^\s"'<]+)/i.exec(decode(b)) || [])[1] ||
      '';
    const torrentUrl = [enclosure, link].find(u => /^https?:/i.test(u) && (/\.torrent(\?|$)/i.test(u) || u === enclosure)) || '';
    const size = Number(tag(b, 'size') || torznab(b, 'size') || attr(b, 'enclosure', 'length') || tag(b, 'contentLength')) || null;
    return {
      title: tag(b, 'title'),
      guid: tag(b, 'guid') || tag(b, 'id') || link || magnet,
      link,
      magnet,
      torrentUrl,
      size,
      date: Date.parse(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated')) || null,
      seeders: torznab(b, 'seeders') ? Number(torznab(b, 'seeders')) : null,
      peers: torznab(b, 'peers') ? Number(torznab(b, 'peers')) : null,
      infoHash: (torznab(b, 'infohash') || tag(b, 'infoHash') || '').toLowerCase() || null,
    };
  });
  return { title, items: items.filter(i => i.title && (i.magnet || i.torrentUrl || i.link)) };
}

// qBittorrent-style matching: "a b" = AND, "a|b" = OR, * and ? wildcards; or a real regex.
function matcher(pattern, useRegex) {
  const p = String(pattern || '').trim();
  if (!p) return null;
  if (useRegex) {
    try {
      const re = new RegExp(p, 'i');
      return s => re.test(s);
    } catch {
      return () => false;
    }
  }
  const groups = p.split('|').map(g =>
    g.trim().split(/\s+/).filter(Boolean).map(w => new RegExp(w.replace(/[.+^${}()[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'), 'i'))
  );
  return s => groups.some(words => words.length && words.every(re => re.test(s)));
}

function ruleMatches(rule, title) {
  const must = matcher(rule.mustContain, rule.useRegex);
  const mustNot = matcher(rule.mustNotContain, rule.useRegex);
  if (must && !must(title)) return false;
  if (mustNot && mustNot(title)) return false;
  return !!(must || rule.mustContain === '*');
}

async function fetchText(url, signal) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' }, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.text();
}

// A torrent link may be a .torrent file, or (Jackett/Prowlarr) a redirect to a magnet.
async function resolveTorrentLink(url) {
  if (/^magnet:/i.test(url)) return { source: url };
  let current = url;
  for (let hops = 0; hops < 5; hops++) {
    const res = await fetch(current, { headers: { 'User-Agent': UA }, redirect: 'manual' });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      if (/^magnet:/i.test(loc)) return { source: loc };
      current = new URL(loc, current).href;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching torrent`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf[0] !== 0x64) throw new Error('Link did not return a .torrent file'); // bencoded dict starts with "d"
    return { source: url, torrentB64: buf.toString('base64') };
  }
  throw new Error('Too many redirects');
}

class FeedService extends EventEmitter {
  constructor({ file, onDownload }) {
    super();
    this.file = file;
    this.onDownload = onDownload;
    this.feeds = [];
    this.rules = [];
    this.seen = [];
    try {
      Object.assign(this, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {}
    this.timer = setInterval(() => this.refreshDue(), 60 * 1000);
    setTimeout(() => this.refreshDue(), 3000);
  }

  stop() {
    clearInterval(this.timer);
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const feeds = this.feeds.map(f => ({ ...f, articles: (f.articles || []).slice(0, 200) }));
    fs.writeFileSync(this.file, JSON.stringify({ feeds, rules: this.rules, seen: this.seen.slice(-5000) }));
  }

  state() {
    return { feeds: this.feeds, rules: this.rules };
  }

  changed() {
    this.save();
    this.emit('update', this.state());
  }

  async addFeed(url, refreshMin = 30) {
    const feed = { id: crypto.randomUUID(), url, name: url, refreshMin, articles: [], lastFetched: 0, error: null };
    this.feeds.push(feed);
    await this.refresh(feed.id);
    return feed;
  }

  updateFeed(id, patch) {
    const feed = this.feeds.find(f => f.id === id);
    if (!feed) return;
    Object.assign(feed, patch);
    this.changed();
  }

  removeFeed(id) {
    this.feeds = this.feeds.filter(f => f.id !== id);
    this.changed();
  }

  saveRule(rule) {
    const r = { enabled: true, mustContain: '', mustNotContain: '', useRegex: false, feedIds: [], category: '', via: '', dir: '', ...rule };
    if (!r.id) r.id = crypto.randomUUID();
    const i = this.rules.findIndex(x => x.id === r.id);
    if (i >= 0) this.rules[i] = r;
    else this.rules.push(r);
    this.changed();
    this.applyRules();
    return r;
  }

  removeRule(id) {
    this.rules = this.rules.filter(r => r.id !== id);
    this.changed();
  }

  // Articles from the given feeds that a rule would grab (for the rule editor preview).
  preview(rule) {
    return this.feeds
      .filter(f => !rule.feedIds?.length || rule.feedIds.includes(f.id))
      .flatMap(f => f.articles.filter(a => ruleMatches(rule, a.title)).map(a => a.title))
      .slice(0, 50);
  }

  async refreshDue() {
    const now = Date.now();
    for (const f of this.feeds) if (now - (f.lastFetched || 0) >= (f.refreshMin || 30) * 60000) await this.refresh(f.id);
  }

  async refresh(id) {
    const feed = this.feeds.find(f => f.id === id);
    if (!feed) return;
    feed.loading = true;
    this.emit('update', this.state());
    try {
      const { title, items } = parseFeed(await fetchText(feed.url));
      if (feed.name === feed.url && title) feed.name = title;
      const known = new Map(feed.articles.map(a => [a.guid, a]));
      feed.articles = items.map(a => ({ ...a, read: known.get(a.guid)?.read || false, isNew: !known.has(a.guid) && feed.lastFetched > 0 }));
      feed.error = null;
    } catch (e) {
      feed.error = e.message;
    }
    feed.loading = false;
    feed.lastFetched = Date.now();
    this.changed();
    this.applyRules();
  }

  applyRules() {
    const seen = new Set(this.seen);
    for (const rule of this.rules.filter(r => r.enabled)) {
      for (const feed of this.feeds) {
        if (rule.feedIds?.length && !rule.feedIds.includes(feed.id)) continue;
        for (const a of feed.articles) {
          if (seen.has(a.guid) || !ruleMatches(rule, a.title)) continue;
          seen.add(a.guid);
          this.seen.push(a.guid);
          this.onDownload(a, rule);
          this.emit('grabbed', { rule: rule.name, title: a.title });
        }
      }
    }
    this.save();
  }
}

// ---- Torznab search (Jackett / Prowlarr) ----
function torznabUrl(base, apikey, q) {
  const u = new URL(base.endsWith('/api') ? base : base.replace(/\/?$/, '/api'));
  u.searchParams.set('t', 'search');
  u.searchParams.set('q', q);
  if (apikey) u.searchParams.set('apikey', apikey);
  return u.href;
}

// Local search plugins: <profile>/plugins/*.js, each exporting { name, search(query) -> [{ title, magnet?, torrentUrl?, size?, seeders?, selectedFiles? }] }.
// They live only in the user's own profile folder, are never bundled, and run with the app's rights, like qBittorrent's search plugins.
function loadSearchPlugins(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    const file = path.join(dir, f);
    try {
      delete require.cache[require.resolve(file)];
      const p = require(file);
      if (typeof p.search === 'function') out.push({ name: p.name || f.replace(/\.js$/, ''), search: p.search, plugin: true });
    } catch (e) {
      console.warn('search plugin failed to load:', f, e.message);
    }
  }
  return out;
}

async function search(providers, q, plugins = []) {
  const enabled = [...providers.filter(p => p.enabled !== false && p.url), ...plugins];
  if (!enabled.length) throw new Error('Add a Jackett or Prowlarr Torznab URL in Settings → Search providers');
  const results = await Promise.allSettled(
    enabled.map(async p => {
      if (p.plugin) return (await p.search(q)).map(i => ({ ...i, provider: p.name }));
      const { items } = parseFeed(await fetchText(torznabUrl(p.url, p.apikey, q), AbortSignal.timeout(25000)));
      return items.map(i => ({ ...i, provider: p.name || new URL(p.url).host }));
    })
  );
  const errors = results.map((r, i) => (r.status === 'rejected' ? `${enabled[i].name || enabled[i].url}: ${r.reason.message}` : null)).filter(Boolean);
  const items = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
  items.sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1));
  return { items, errors };
}

module.exports = { parseFeed, matcher, ruleMatches, FeedService, search, loadSearchPlugins, resolveTorrentLink };
