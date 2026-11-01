// Free file hosts with a plain flow: a page, sometimes a short countdown, then a file link. Hakobu waits out the time
// the site shows. Captchas and bot checks are never solved or worked around: such a download goes to the browser,
// or to debrid when one is set up.
const { fetcher, getText, hostIn, decodeHtml, gone, HostError } = require('./common');
const { sleep } = require('../../util');

const MAX_WAIT = 120; // seconds; a longer countdown goes to the queue as a wait

const withoutComments = html => String(html).replace(/<!--[\s\S]*?-->/g, '');

// The site wants a person: Cloudflare's check, or a captcha on the download form.
function needsPerson(res, html) {
  const page = withoutComments(html);
  if (res?.headers?.get?.('cf-mitigated') || /<title>\s*Just a moment|challenges\.cloudflare\.com\/turnstile\/[\w/]*\/orchestrate|cdn-cgi\/challenge-platform\/h\/[\w]+\/orchestrate/i.test(page)) return 'a bot check';
  if (/class=["'][^"']*(?:g-recaptcha|h-captcha|cf-turnstile)|name=["'](?:g-recaptcha-response|h-captcha-response|cf-turnstile-response|captcha_code)["']/i.test(page)) return 'a captcha';
  return null;
}

function guard(name, res, html) {
  const what = needsPerson(res, html);
  if (what) throw new HostError(`${name} shows ${what}: open it in your browser, or download it through debrid`, { browser: true });
}

// The seconds a page counts down before its download button works.
function countdown(html) {
  const page = withoutComments(html);
  const m =
    /<span[^>]+(?:id|class)=["'][^"']*(?:countdown|seconds)[^"']*["'][^>]*>\s*(\d+)\s*</i.exec(page) ||
    /\b(?:var\s+)?(?:seconds|countdown|count)\s*=\s*(\d+)\s*;/i.exec(page);
  return m ? Number(m[1]) : 0;
}

async function waitOut(name, seconds, ctx) {
  if (seconds > MAX_WAIT) throw new HostError(`${name}: wait ${Math.ceil(seconds / 60)} minutes between free downloads`, { wait: (seconds + 5) * 1000, ipLimit: true });
  if (seconds > 0) await sleep(seconds * 1000, ctx.signal);
}

// Hidden fields of the form that holds "op" (XFileSharing sites).
function formFields(html) {
  const page = withoutComments(html);
  const forms = [...page.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)].map(m => m[1]);
  const form = forms.find(f => /name=["']op["']/i.test(f));
  if (!form) return null;
  const out = {};
  for (const m of form.matchAll(/<input\b[^>]*>/gi)) {
    const name = /name=["']([^"']+)["']/i.exec(m[0])?.[1];
    if (name) out[name] = decodeHtml(/value=["']([^"']*)["']/i.exec(m[0])?.[1] ?? '');
  }
  return out;
}

// ---- Send (send.now, formerly send.cm): the form's POST answers with a redirect to the file ----
const sendCode = url => /^\/(?:d\/)?([a-z0-9]{8,})/i.exec(new URL(url).pathname)?.[1] || null;
const send = {
  id: 'send',
  name: 'Send',
  test: hostIn('send.now', 'send.cm'),
  free: true,
  maxConnections: 1,
  async resolve(url, ctx) {
    const code = sendCode(url);
    if (!code) throw gone('Send');
    const page = `https://send.now/${code}`;
    const { res, text } = await getText(ctx, page);
    if (res.status === 404 || /File Not Found|No such file/i.test(text)) throw gone('Send');
    guard('Send', res, text);
    await waitOut('Send', countdown(text), ctx);
    const fields = formFields(text) || { op: 'download2', id: code, rand: '', referer: '', method_free: '', method_premium: '' };
    const post = await fetcher(ctx)(page, {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams(fields),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: page },
    });
    const location = post.headers.get('location');
    if (location) {
      await post.body?.cancel().catch(() => {});
      return { url: new URL(location, page).href, headers: { Referer: page }, filename: fields.fname || undefined };
    }
    const after = await post.text();
    guard('Send', post, after);
    throw new HostError("Send didn't hand out a free link", { browser: true });
  },
};

// ---- DataNodes: the download form answers with JSON holding the file's link ----
function datanodesPath(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  if (parts.length >= 3) return { code: parts[1], name: decodeURIComponent(parts[2]) };
  if (parts.length === 2) return { code: parts[0], name: decodeURIComponent(parts[1]) };
  return parts.length === 1 ? { code: parts[0], name: '' } : null;
}
const datanodes = {
  id: 'datanodes',
  name: 'DataNodes',
  test: hostIn('datanodes.to'),
  free: true,
  maxConnections: 1,
  async resolve(url, ctx) {
    const f = datanodesPath(url);
    if (!f) throw gone('DataNodes');
    const cookie = `lang=english; file_code=${f.code}; file_name=${encodeURIComponent(f.name)}`;
    const { res, text } = await getText(ctx, url, { headers: { Cookie: cookie } });
    if (res.status === 404 || /File Not Found|No such file/i.test(text)) throw gone('DataNodes');
    guard('DataNodes', res, text);
    await waitOut('DataNodes', countdown(text), ctx);
    const post = await getText(ctx, 'https://datanodes.to/download', {
      method: 'POST',
      body: new URLSearchParams({ op: 'download2', id: f.code, rand: '', method_free: 'Free Download >>', dl: '1' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, Referer: url },
    });
    guard('DataNodes', post.res, post.text);
    let link = null;
    try {
      link = JSON.parse(post.text).url;
    } catch {}
    if (!link) throw new HostError("DataNodes didn't hand out a free link", { browser: true });
    return { url: decodeURIComponent(link), headers: { Referer: 'https://datanodes.to/' }, filename: f.name || undefined };
  },
};

// ---- KrakenFiles: a token on the page, posted to its download endpoint ----
const krakenHash = url => /\/view\/([\w-]+)/.exec(new URL(url).pathname)?.[1] || null;
const krakenToken = html => /<form[^>]+id=["']dl-form["'][\s\S]*?name=["']token["'][^>]*value=["']([^"']+)["']/i.exec(html)?.[1] || null;
const kraken = {
  id: 'krakenfiles',
  name: 'KrakenFiles',
  test: hostIn('krakenfiles.com'),
  free: true,
  maxConnections: 2,
  async resolve(url, ctx) {
    const hash = krakenHash(url);
    if (!hash) throw gone('KrakenFiles');
    const { res, text } = await getText(ctx, url);
    if (res.status === 404) throw gone('KrakenFiles');
    guard('KrakenFiles', res, text);
    const token = krakenToken(text);
    if (!token) throw new HostError("KrakenFiles' page had no download form", { browser: true });
    const post = await getText(ctx, `https://krakenfiles.com/download/${hash}`, {
      method: 'POST',
      body: new URLSearchParams({ token }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', hash, Referer: url },
    });
    guard('KrakenFiles', post.res, post.text);
    let link = null;
    try {
      link = JSON.parse(post.text).url;
    } catch {}
    if (!link) throw new HostError("KrakenFiles didn't hand out a free link", { browser: true });
    return { url: link, headers: { Referer: url } };
  },
};

module.exports = [send, datanodes, kraken];
module.exports._test = { needsPerson, countdown, formFields, krakenToken, sendCode, datanodesPath };
