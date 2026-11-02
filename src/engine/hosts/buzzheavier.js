// BuzzHeavier: GET <page>/download as an htmx request; the direct link comes back in the "hx-redirect" header.
// Link check and SHA-1 ported from JDownloader 2 (GPL-3.0-or-later, JD-Team), jd/plugins/hoster/BuzzheavierCom.java r52799,
// source mirror commit 6ab1aecd of 2026-11-02.
const { fetcher, getText, hostIn, decodeHtml, UA, gone } = require('./common');
const { guard } = require('./pagekit');

function pageInfo(url, status, html) {
  if (status === 404 || /\/notfound$/i.test(url) || />\s*File Not Found Or Deleted/.test(html)) throw gone('BuzzHeavier');
  const name = /<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1];
  const size = /Size - ([\d.]+)\s*(KB|MB|GB|TB)[^|]*\| Views - \d+/i.exec(html);
  return {
    filename: name ? decodeHtml(name).trim() : undefined,
    size: size ? Math.round(Number(size[1]) * { KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 }[size[2].toUpperCase()]) : undefined,
    sha1: /SHA-1:?\s*<\/strong>\s*<code>\s*([a-f0-9]{40})/.exec(html)?.[1],
  };
}

async function check(url, ctx) {
  try {
    const { res, text } = await getText(ctx, url);
    guard('BuzzHeavier', res, text);
    const { filename, size } = pageInfo(res.url || url, res.status, text);
    return { status: 'online', filename, size };
  } catch (e) {
    if (e.permanent) return { status: 'offline', error: e.message };
    if (e.browser) return { status: 'browser', error: e.message };
    throw e;
  }
}

async function resolve(url, ctx) {
  const page = new URL(url);
  page.hash = '';
  page.search = '';
  const base = page.href.replace(/\/+$/, '');
  const headers = { 'User-Agent': UA, 'HX-Request': 'true', 'HX-Current-URL': base, Referer: base };
  const res = await fetcher(ctx)(base + '/download', { headers, redirect: 'manual' });
  const link = res.headers.get('hx-redirect') || res.headers.get('location');
  if (!link) {
    if (res.headers.get('cf-mitigated')) guard('BuzzHeavier', res, '');
    if (res.status === 404) throw gone('BuzzHeavier');
    throw new Error(`BuzzHeavier didn't return a download link (HTTP ${res.status})`);
  }
  return { url: new URL(link, base).href, headers: { 'User-Agent': UA, Referer: base } };
}

module.exports = { id: 'buzzheavier', name: 'BuzzHeavier', test: hostIn('buzzheavier.com', 'bzzhr.co'), free: true, resolve, check, _test: { pageInfo } };
