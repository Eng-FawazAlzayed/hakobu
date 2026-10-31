// JDownloader-style LinkGrabber helpers: online check for links and automatic package names.
const { probe, PageError } = require('./http');
const { isHoster } = require('../linkparse');
const { resolverFor } = require('./resolvers');
const { crawl, isCrawlable, isProtector, parseIndex } = require('./crawler');
const { netFetch } = require('./net');
const { HostError } = require('./errors');

// "Show.S01.part03.rar" -> "Show.S01", "Movie.CD2.avi" -> "Movie", "backup.7z.001" -> "backup"
function packageName(filename) {
  let n = String(filename || '').split(/[\\/]/).pop();
  // Strip one suffix: an archive volume pattern if present, otherwise the plain extension.
  const volume = /\.part\d+\.rar$|\.(7z|zip|rar|tar)\.\d{2,3}$|\.(r|z)\d{2}$/i;
  n = volume.test(n) ? n.replace(volume, '') : n.replace(/\.[a-z0-9]{1,5}$/i, '');
  n = n.replace(/[ ._-]+(cd|disc|disk|part|vol)[ ._-]?\d+$/i, '').replace(/[ ._-]+$/, '');
  return n || String(filename || 'Package');
}

// Real-Debrid's link check needs no account and tells us if a hoster file exists.
async function checkHoster(url) {
  const res = await netFetch('https://api.real-debrid.com/rest/1.0/unrestrict/check', {
    method: 'POST',
    body: new URLSearchParams({ link: url }),
    signal: AbortSignal.timeout(15000),
  });
  const d = await res.json().catch(() => null);
  if (res.status === 503 || d?.error_code === 24) return { status: 'offline', error: 'File unavailable' };
  if (!res.ok || !d) return { status: 'unknown', error: d?.error || `check failed (${res.status})` };
  return { status: d.supported ? 'online' : 'unknown', filename: d.filename, size: d.filesize || null, host: d.host };
}

// registry: HosterRegistry (which debrid services support the host); route(url): the route the app would pick.
// HostError -> a LinkGrabber status.
const statusOf = e => (e instanceof HostError ? (e.permanent ? 'offline' : e.browser ? 'browser' : 'unknown') : /not found/i.test(e.message) ? 'offline' : 'unknown');

async function checkLink(url, { registry, route, headers = {} } = {}) {
  const providers = registry ? registry.providersFor(url).map(p => p.provider) : [];
  const via = route ? route(url) : null;
  const extra = { providers, route: via };
  // Link protectors want a captcha: the user opens them and sends the links back (Click'n'Load, DLC, extension).
  if (isProtector(url)) {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return { status: 'protected', host, error: `${host} protects its links with a captcha. Open it in your browser, solve it, then use its Click'n'Load or DLC button (or send the page's links with the Hakobu extension).`, ...extra };
  }
  // Folders, DLC containers, pastes: list what's inside; LinkGrabber swaps the link for those.
  if (isCrawlable(url)) {
    try {
      const r = await crawl(url, { headers });
      if (r) {
        const links = r.links.map(l => ({ ...l, route: l.headers ? 'direct' : route ? route(l.source) : undefined }));
        return { status: 'folder', package: r.package, links, passwords: r.passwords || [], count: links.length, ...extra };
      }
    } catch (e) {
      return { status: statusOf(e), error: e.message, ...extra };
    }
  }
  const resolver = resolverFor(url);
  if (resolver && (via === 'direct' || !providers.length)) {
    const host = resolver.name + (resolver.premium ? ' (premium)' : '');
    try {
      if (resolver.mod.check) {
        const c = await resolver.mod.check(url, { signal: AbortSignal.timeout(20000), account: resolver.account });
        if (c) return { host, ...c, ...extra };
      }
      if (!resolver.premium) {
        const r = await resolver.resolve(url, AbortSignal.timeout(20000));
        if (r.filename && r.size) return { status: 'online', filename: r.filename, size: r.size, host, ...extra };
        const p = await probe(r.url, r.headers, AbortSignal.timeout(15000));
        return { status: 'online', filename: r.filename || p.filename, size: r.size || p.size, host, ...extra };
      }
      return { status: 'online', host, ...extra }; // premium hosts are checked when they start (logins cost requests)
    } catch (e) {
      return { status: statusOf(e), error: e.message, host, ...extra };
    }
  }
  if (providers.includes('realdebrid')) {
    try {
      return { ...(await checkHoster(url)), ...extra };
    } catch (e) {
      return { status: 'unknown', error: e.message, ...extra };
    }
  }
  if (providers.length) return { status: 'hoster', host: registry.providersFor(url)[0].name, ...extra };
  if (isHoster(url)) {
    // A file host neither service lists: there is no way to get the file without its website (captchas, waits).
    if (registry?.list().updated) {
      const host = new URL(url).hostname.replace(/^www\./, '');
      return { status: 'unsupported', host, error: `${host} isn't supported by TorBox or Real-Debrid, and has no built-in resolver yet.`, ...extra };
    }
    try {
      return { ...(await checkHoster(url)), ...extra };
    } catch (e) {
      return { status: 'unknown', error: e.message, ...extra };
    }
  }
  try {
    const p = await probe(url, headers, AbortSignal.timeout(15000));
    return { status: 'online', filename: p.filename, size: p.size, resumable: p.resumable, ...extra };
  } catch (e) {
    if (e instanceof PageError) {
      // A web server's folder listing ("Index of /"): its files, like JDownloader's deep decrypt.
      try {
        const res = await netFetch(url, { headers, signal: AbortSignal.timeout(15000) });
        const listing = parseIndex(await res.text(), res.url || url);
        if (listing) return { status: 'folder', package: listing.package, links: listing.links, passwords: [], count: listing.links.length, ...extra };
      } catch {}
      return { status: 'page', error: 'Web page, not a file. This host is not supported by your debrid services.', ...extra };
    }
    if (e instanceof HostError && e.wait) return { status: 'unknown', error: e.message, ...extra };
    // Only a definite "gone" counts as offline; rate limits, timeouts and server errors may be temporary.
    const gone = /HTTP (404|410)/.test(e.message);
    return { status: gone ? 'offline' : 'unknown', error: e.name === 'TimeoutError' ? 'Timed out' : e.message, ...extra };
  }
}

// Check many links, a few at a time.
// urls: strings or { url, headers } (headers from the browser extension: cookies, referrer).
async function checkLinks(urls, opts = {}, concurrency = 6) {
  const out = new Array(urls.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
      while (next < urls.length) {
        const i = next++;
        const u = typeof urls[i] === 'string' ? { url: urls[i] } : urls[i] || {};
        const r = await checkLink(u.url, { ...opts, headers: u.headers || {} }).catch(e => ({ status: 'unknown', error: e.message }));
        out[i] = { ...r, autoPackage: r.filename ? packageName(r.filename) : null };
      }
    })
  );
  return out;
}

module.exports = { checkLinks, checkLink, packageName };
