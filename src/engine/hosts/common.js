// Shared bits for the built-in host modules.
const { netFetch } = require('../net');
const { HostError } = require('../errors');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// ctx = { signal, route, account } -> a fetch bound to that download's signal and proxy route.
function fetcher(ctx = {}) {
  return (url, opts = {}) =>
    netFetch(url, {
      signal: ctx.signal || AbortSignal.timeout(30000),
      route: ctx.route || 0,
      ...opts,
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...(opts.headers || {}) },
    });
}

async function getText(ctx, url, opts) {
  const res = await fetcher(ctx)(url, opts);
  const text = await res.text();
  return { res, text };
}

async function getJson(ctx, url, opts) {
  const res = await fetcher(ctx)(url, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { res, data };
}

const decodeHtml = s =>
  String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

const hostIn = (...domains) => host => domains.some(d => host === d || host.endsWith('.' + d));

const gone = what => new HostError(`${what}: file not found (deleted or wrong link)`, { permanent: true });

module.exports = { UA, fetcher, getText, getJson, decodeHtml, hostIn, gone, HostError };
