// BuzzHeavier: GET <page>/download as an htmx request; the direct link comes back in the "hx-redirect" header.
const { fetcher, hostIn, UA, gone } = require('./common');

async function resolve(url, ctx) {
  const page = new URL(url);
  page.hash = '';
  page.search = '';
  const base = page.href.replace(/\/+$/, '');
  const headers = { 'User-Agent': UA, 'HX-Request': 'true', 'HX-Current-URL': base, Referer: base };
  const res = await fetcher(ctx)(base + '/download', { headers, redirect: 'manual' });
  const link = res.headers.get('hx-redirect') || res.headers.get('location');
  if (!link) {
    if (res.status === 404) throw gone('BuzzHeavier');
    throw new Error(`BuzzHeavier didn't return a download link (HTTP ${res.status})`);
  }
  return { url: new URL(link, base).href, headers: { 'User-Agent': UA, Referer: base } };
}

module.exports = { id: 'buzzheavier', name: 'BuzzHeavier', test: hostIn('buzzheavier.com', 'bzzhr.co'), free: true, resolve };
