// JDownloader-style LinkGrabber helpers: online check for links and automatic package names.
const { probe, PageError } = require('./http');
const { isHoster } = require('../linkparse');
const { resolverFor } = require('./resolvers');

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
  const res = await fetch('https://api.real-debrid.com/rest/1.0/unrestrict/check', {
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
async function checkLink(url, { registry, route } = {}) {
  const providers = registry ? registry.providersFor(url).map(p => p.provider) : [];
  const via = route ? route(url) : null;
  const extra = { providers, route: via };
  const resolver = resolverFor(url);
  if (resolver && via === 'direct') {
    try {
      const r = await resolver.resolve(url, AbortSignal.timeout(15000));
      const p = await probe(r.url, r.headers, AbortSignal.timeout(15000));
      return { status: 'online', filename: p.filename, size: p.size, host: resolver.name, ...extra };
    } catch (e) {
      return { status: /not found/i.test(e.message) ? 'offline' : 'unknown', error: e.message, host: resolver.name, ...extra };
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
    const p = await probe(url, {}, AbortSignal.timeout(15000));
    return { status: 'online', filename: p.filename, size: p.size, resumable: p.resumable, ...extra };
  } catch (e) {
    if (e instanceof PageError) return { status: 'page', error: 'Web page, not a file. This host is not supported by your debrid services.', ...extra };
    // Only a definite "gone" counts as offline; rate limits, timeouts and server errors may be temporary.
    const gone = /HTTP (404|410)/.test(e.message);
    return { status: gone ? 'offline' : 'unknown', error: e.name === 'TimeoutError' ? 'Timed out' : e.message, ...extra };
  }
}

// Check many links, a few at a time.
async function checkLinks(urls, opts = {}, concurrency = 6) {
  const out = new Array(urls.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
      while (next < urls.length) {
        const i = next++;
        const r = await checkLink(urls[i], opts);
        out[i] = { ...r, autoPackage: r.filename ? packageName(r.filename) : null };
      }
    })
  );
  return out;
}

module.exports = { checkLinks, checkLink, packageName };
