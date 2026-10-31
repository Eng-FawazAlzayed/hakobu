// Built-in resolvers for file hosts that hand out direct links without an account (no debrid needed).
// Each turns a host's page URL into { url, headers } for the HTTP engine.
const { hostOf } = require('./hosters');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const RESOLVERS = [
  {
    // BuzzHeavier: GET <page>/download as an htmx request; the direct link comes back in the "hx-redirect" header.
    name: 'BuzzHeavier',
    test: host => /(^|\.)(buzzheavier\.com|bzzhr\.co)$/.test(host),
    async resolve(url, signal) {
      const page = new URL(url);
      page.hash = '';
      page.search = '';
      const base = page.href.replace(/\/+$/, '');
      const headers = { 'User-Agent': UA, 'HX-Request': 'true', 'HX-Current-URL': base, Referer: base };
      const res = await fetch(base + '/download', { headers, redirect: 'manual', signal });
      const link = res.headers.get('hx-redirect') || res.headers.get('location');
      if (!link) {
        if (res.status === 404) throw new Error('BuzzHeavier: file not found (deleted or wrong link)');
        throw new Error(`BuzzHeavier didn't return a download link (HTTP ${res.status})`);
      }
      return { url: new URL(link, base).href, headers: { 'User-Agent': UA, Referer: base } };
    },
  },
];

const resolverFor = url => {
  const host = hostOf(url);
  return host ? RESOLVERS.find(r => r.test(host)) || null : null;
};

module.exports = { resolverFor, RESOLVERS };
