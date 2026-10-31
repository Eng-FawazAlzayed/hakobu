// Every engine request goes through netFetch so a proxy can apply (JDownloader's proxy manager).
// Proxies: [{ url: 'http://host:port' | 'socks5://user:pass@host:port', hosts: 'mega.nz, 1fichier.com' | '', mode: 'always' | 'rotate', enabled }]
//  - "always" proxies carry that traffic by default (the first one that matches the host).
//  - "rotate" proxies are only used when a host makes you wait for your IP (daily limit, "wait 30 minutes"):
//    the download moves to the next route instead of waiting.
// Without a matching "always" proxy the first route is a direct connection.
const { hostOf } = require('./hosters');

let proxies = [];
const dispatchers = new Map();

function configure(list) {
  proxies = (Array.isArray(list) ? list : []).filter(p => p && p.enabled !== false && /^(https?|socks[45]h?):\/\//i.test(p.url || ''));
  for (const d of dispatchers.values()) d.close?.().catch?.(() => {});
  dispatchers.clear();
}

const matchesHost = (p, host) => {
  const list = String(p.hosts || '').split(/[\s,;]+/).map(s => s.trim().toLowerCase().replace(/^www\./, '')).filter(Boolean);
  return !list.length || list.some(d => host === d || host.endsWith('.' + d));
};

// The ordered ways to reach a URL: index 0 is the default, later ones are tried when a host limits your IP.
function routes(url) {
  const host = hostOf(url);
  const mine = proxies.filter(p => matchesHost(p, host));
  const always = mine.filter(p => p.mode !== 'rotate');
  const rotate = mine.filter(p => p.mode === 'rotate');
  return [...(always.length ? always : [null]), ...rotate];
}

function dispatcher(proxyUrl) {
  if (dispatchers.has(proxyUrl)) return dispatchers.get(proxyUrl);
  const u = new URL(proxyUrl);
  let d;
  if (/^socks/i.test(u.protocol)) {
    const { socksDispatcher } = require('fetch-socks');
    d = socksDispatcher({
      type: /^socks4/i.test(u.protocol) ? 4 : 5,
      host: u.hostname,
      port: Number(u.port) || 1080,
      ...(u.username ? { userId: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : {}),
    });
  } else {
    const { ProxyAgent } = require('undici');
    d = new ProxyAgent(proxyUrl);
  }
  dispatchers.set(proxyUrl, d);
  return d;
}

// fetch() with the proxy for this URL. opts.route picks a later route (see routes()); it wraps around.
function netFetch(url, opts = {}) {
  const { route = 0, ...rest } = opts;
  const list = proxies.length ? routes(String(url)) : [null];
  const p = list[((route % list.length) + list.length) % list.length];
  if (!p) return fetch(url, rest);
  return require('undici').fetch(url, { ...rest, dispatcher: dispatcher(p.url) });
}

const routeCount = url => (proxies.length ? routes(String(url)).length : 1);
const routeLabel = (url, route = 0) => {
  const list = proxies.length ? routes(String(url)) : [null];
  const p = list[route % list.length];
  return p ? new URL(p.url).host : 'direct';
};

module.exports = { netFetch, configure, routes, routeCount, routeLabel };
