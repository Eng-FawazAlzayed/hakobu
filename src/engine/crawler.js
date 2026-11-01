// LinkCrawler (JDownloader's "decrypter plugins"): opens links that stand for other links.
//  - folder links on MEGA, Google Drive, Gofile, Pixeldrain, MediaFire -> their files
//  - DLC containers (.dlc files, as link sites and filecrypt offer them) -> the links inside
//  - paste sites (pastebin, rentry, ...) -> the links in the paste
//  - web server folder listings ("Index of /") -> the files in it
//  - link protectors (filecrypt, keeplinks, ouo, ...) need a captcha: they're marked "protected" so the user opens them
//    in the browser and sends the links back with Click'n'Load, the DLC button or the extension.
const crypto = require('crypto');
const { netFetch } = require('./net');
const { hostOf } = require('./hosters');
const { moduleFor, accountFor } = require('./resolvers');
const { UA, decodeHtml } = require('./hosts/common');

const PROTECTORS = [
  'filecrypt.cc', 'filecrypt.co', 'keeplinks.org', 'keeplinks.co', 'keeplinks.eu', 'ouo.io', 'ouo.press', 'safelinking.net',
  'linkvertise.com', 'link-to.net', 'adf.ly', 'shorte.st', 'bc.vc', 'exe.io', 'shrinkme.io', 'shrinkearn.com', 'linkshrink.net',
  'protect-link.biz', 'lnk2.cc', 'hide.cx', 'share-links.biz', 'ncrypt.in', 'relink.to', 'linksafe.cc', 'go4up.com', 'multiup.io', 'multiup.org',
];
const isProtector = url => {
  const h = hostOf(url);
  return !!h && PROTECTORS.some(d => h === d || h.endsWith('.' + d));
};

// ---- paste sites: fetch the raw text, pull the links out ----
const PASTES = [
  { test: /^(?:www\.)?pastebin\.com$/, raw: u => `https://pastebin.com/raw/${/pastebin\.com\/(?:raw\/)?(\w+)/.exec(u)?.[1]}` },
  { test: /^(?:www\.)?rentry\.(?:co|org)$/, raw: null }, // its /raw view now needs an access code
  { test: /^(?:www\.)?pastes\.io$/, raw: u => `https://pastes.io/raw/${/pastes\.io\/(?:raw\/)?([\w-]+)/.exec(u)?.[1]}` },
  { test: /^(?:www\.)?paste\.ee$/, raw: u => `https://paste.ee/r/${/paste\.ee\/[pr]\/(\w+)/.exec(u)?.[1]}` },
  { test: /^(?:www\.)?controlc\.com$/, raw: null }, // HTML page: links are read from it
  { test: /^(?:www\.)?justpaste\.it$/, raw: null },
];
const pasteFor = url => {
  const h = hostOf(url);
  return h ? PASTES.find(p => p.test.test(h)) : null;
};

// A paste shown as a web page: only its content area (not the site's menus), with link targets kept as text.
function pasteText(html) {
  const s = String(html);
  const part =
    /<div[^>]+class="[^"]*entry-text[^"]*"[^>]*>([\s\S]*?)<\/article>/i.exec(s)?.[1] ||
    /<article[^>]*>([\s\S]*?)<\/article>/i.exec(s)?.[1] ||
    /<body[^>]*>([\s\S]*)<\/body>/i.exec(s)?.[1] ||
    s;
  const body = part.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<a\s[^>]*href="(https?:\/\/[^"]+)"[^>]*>/gi, ' $1 ');
  return decodeHtml(body.replace(/<[^>]+>/g, ' '));
}

// ---- DLC containers ----
// The container's last 88 characters are its key, which JDownloader's service turns into the AES key for the rest.
const DLC_SERVICE = 'http://service.jdownloader.org/dlcrypt/service.php';
const DLC_KEY = Buffer.from('cb99b5cbc24db398');
const DLC_IV = Buffer.from('9bc24cb995cb8db3');

function aesCbc(key, iv, data, pad = false) {
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
  d.setAutoPadding(pad);
  return Buffer.concat([d.update(data), d.final()]);
}

// Decrypted DLC XML -> { package, links: [{ source, name, size }] } (fields are base64 in the XML).
function parseDlcXml(xml) {
  const b64 = s => {
    try {
      return Buffer.from(String(s || '').trim(), 'base64').toString('utf8');
    } catch {
      return '';
    }
  };
  const pkg = /<package[^>]*\bname="([^"]*)"/i.exec(xml);
  const links = [];
  for (const m of xml.matchAll(/<file>([\s\S]*?)<\/file>/gi)) {
    const url = b64(/<url>([\s\S]*?)<\/url>/i.exec(m[1])?.[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const name = b64(/<filename>([\s\S]*?)<\/filename>/i.exec(m[1])?.[1]) || undefined;
    const size = Number(b64(/<size>([\s\S]*?)<\/size>/i.exec(m[1])?.[1])) || undefined;
    links.push({ source: url.trim(), name, size });
  }
  const passwords = [...xml.matchAll(/<passwords>([\s\S]*?)<\/passwords>/gi)].map(m => b64(m[1])).flatMap(p => p.split(/[\r\n,]+/)).map(s => s.trim()).filter(Boolean);
  return { package: pkg ? b64(pkg[1]) || 'DLC container' : 'DLC container', links, passwords };
}

// keyFetcher(dlcKey) -> base64 "rc" answer of the service (injectable for tests).
async function decryptDlc(content, { keyFetcher = fetchDlcKey } = {}) {
  const text = String(content).replace(/\s+/g, '');
  if (text.length < 100) throw new Error('This is not a DLC container');
  const dlcKey = text.slice(-88);
  const data = Buffer.from(text.slice(0, -88), 'base64');
  const rc = Buffer.from(await keyFetcher(dlcKey), 'base64').subarray(0, 16);
  const key = aesCbc(DLC_KEY, DLC_IV, rc);
  const plain = aesCbc(key, key, data.subarray(0, data.length - (data.length % 16))).toString('utf8').replace(/[\0\s]+$/, '');
  const xml = Buffer.from(plain, 'base64').toString('utf8');
  if (!/<dlc|<content|<file>/i.test(xml)) throw new Error("Couldn't decrypt this DLC container");
  return parseDlcXml(xml);
}

async function fetchDlcKey(dlcKey) {
  const q = new URLSearchParams({ srcType: 'dlc', destType: 'pylo', data: dlcKey });
  const res = await netFetch(`${DLC_SERVICE}?${q}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  const body = await res.text();
  const m = /<rc>([\s\S]+?)<\/rc>/i.exec(body);
  if (!m) throw new Error('The DLC key service refused this container (it may be expired)');
  return m[1].trim();
}

// For tests and tools: the reverse of decryptDlc given an rc answer.
function encryptDlcForTest(xml, rcB64, dlcKey) {
  const rc = Buffer.from(rcB64, 'base64').subarray(0, 16);
  const key = aesCbc(DLC_KEY, DLC_IV, rc);
  const c = crypto.createCipheriv('aes-128-cbc', key, key);
  c.setAutoPadding(false);
  const plain = Buffer.from(Buffer.from(xml).toString('base64'));
  const padded = Buffer.concat([plain, Buffer.alloc((16 - (plain.length % 16)) % 16)]);
  return Buffer.concat([c.update(padded), c.final()]).toString('base64') + dlcKey;
}
// aesCbc above decrypts; the test helper needs the "rc -> key" step the other way round too.
function rcForKey(key16) {
  const c = crypto.createCipheriv('aes-128-cbc', DLC_KEY, DLC_IV);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(key16), c.final()]).toString('base64');
}

// ---- web server listings ("Index of /dir") ----
function parseIndex(html, base) {
  if (!/<title>\s*Index of\b|<h1>\s*Index of\b|Directory listing for/i.test(html)) return null;
  const title = decodeHtml(/<title>\s*([^<]*)<\/title>/i.exec(html)?.[1] || 'Folder').replace(/^Index of\s*/i, '').replace(/\/+$/, '').split('/').pop() || 'Folder';
  const links = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a\s[^>]*href="([^"?#]+)"/gi)) {
    const href = decodeHtml(m[1]);
    if (href.endsWith('/') || /^(\.\.|\/)$/.test(href) || /^(mailto|javascript):/i.test(href)) continue;
    let abs;
    try {
      abs = new URL(href, base).href;
    } catch {
      continue;
    }
    if (!abs.startsWith(base.replace(/[^/]*$/, '')) || seen.has(abs)) continue; // stay inside this folder
    seen.add(abs);
    links.push({ source: abs, name: decodeURIComponent(abs.split('/').pop()) });
  }
  return links.length ? { package: decodeURIComponent(title), links } : null;
}

// ---- entry points ----

const isDlcUrl = url => /\.dlc(?:$|[?#])/i.test(String(url));

// Whether crawl() should be tried for this URL before it's checked like a file.
function isCrawlable(url) {
  return isDlcUrl(url) || !!pasteFor(url) || !!moduleFor(url)?.isFolder?.(url);
}

// -> { package, links: [{ source, name?, size?, headers?, subfolder?, check? }], passwords? } or null (not a container).
async function crawl(url, { headers = {}, signal, route = 0 } = {}) {
  const sig = signal || AbortSignal.timeout(60000);
  if (isDlcUrl(url)) {
    const res = await netFetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: sig, route });
    if (!res.ok) throw new Error(`Couldn't fetch the DLC container (HTTP ${res.status})`);
    return decryptDlc(await res.text());
  }
  const paste = pasteFor(url);
  if (paste) {
    const raw = paste.raw ? paste.raw(url) : url;
    const res = await netFetch(raw, { headers: { 'User-Agent': UA }, signal: sig, route });
    if (res.status === 404) throw new Error('Paste not found');
    let text = await res.text();
    if (!paste.raw || /text\/html/i.test(res.headers.get('content-type') || '')) text = pasteText(text);
    const { parseLinks } = require('../linkparse');
    const own = hostOf(url);
    const links = parseLinks(text)
      .filter(e => e.source !== url && hostOf(e.source) !== own) // the paste site's own pages aren't part of the paste
      .map(e => ({ source: e.source, name: e.name }));
    return { package: `Paste ${hostOf(url)}`, links };
  }
  const mod = moduleFor(url);
  if (mod?.isFolder?.(url)) return mod.crawl(url, { signal: sig, route, account: accountFor(mod) });
  return null;
}

module.exports = { crawl, isCrawlable, isProtector, isDlcUrl, decryptDlc, parseDlcXml, parseIndex, PROTECTORS, _test: { pasteText, encryptDlcForTest, rcForKey, fetchDlcKey } };
