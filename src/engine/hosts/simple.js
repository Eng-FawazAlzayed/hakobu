// Free file hosts with their own small flow.
//
// Ported from JDownloader 2 (GPL-3.0-or-later, Copyright JD-Team), source mirror commit 6ab1aecd of 2026-11-02,
// jd/plugins/hoster: KrakenfilesCom r52214, FuckingfastCo r53129, UploadhavenCom r52786, VikingfileCom r51437.
// JDownloader asks for a Turnstile captcha on KrakenFiles, VikingFile and sometimes FuckingFast: here the person solves
// it in the window, and these modules stop there instead of sending a token.
const { fetcher, getJson, getText, hostIn, decodeHtml, gone, HostError } = require('./common');
const { guard, needsPerson, countdown, waitOut, formFields, allForms } = require('./pagekit');

const person = (name, what = 'a captcha') => new HostError(`${name} free downloads need ${what}: solve it in the window, or download it through debrid`, { browser: true });
const sizeOf = text => {
  const m = /([\d.]+)\s*(KB|MB|GB|TB)/i.exec(String(text || ''));
  return m ? Math.round(Number(m[1]) * { KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 }[m[2].toUpperCase()]) : undefined;
};
const asCheck = fn => async (url, ctx) => {
  try {
    return await fn(url, ctx);
  } catch (e) {
    if (e.permanent) return { status: 'offline', error: e.message };
    if (e.browser) return { status: 'browser', error: e.message };
    throw e;
  }
};

// ---- KrakenFiles: /json/<id> tells if it's there; the free download needs a Turnstile captcha ----
const krakenHash = url => /\/view\/([a-z0-9]+)/i.exec(new URL(url).pathname)?.[1] || null;
async function krakenInfo(url, ctx) {
  const hash = krakenHash(url);
  if (!hash) throw gone('KrakenFiles');
  const { res, data } = await getJson(ctx, `https://krakenfiles.com/json/${hash}`);
  if (res.status === 404 || !data || String(data.hash || '').toLowerCase() !== hash.toLowerCase()) throw gone('KrakenFiles');
  return { status: 'online', filename: data.title, size: sizeOf(data.size) };
}
const kraken = {
  id: 'krakenfiles',
  name: 'KrakenFiles',
  test: hostIn('krakenfiles.com'),
  free: true,
  maxConnections: 1,
  async resolve(url, ctx) {
    await krakenInfo(url, ctx);
    throw person('KrakenFiles');
  },
  check: asCheck(krakenInfo),
};

// ---- FuckingFast: window.open("<file>") on the page, or POST /f/<id>/go answering with a Hx-Redirect ----
const ffId = url => /\/(?:f\/)?([a-z0-9]{12})/i.exec(new URL(url).pathname)?.[1] || null;
function ffMeta(html) {
  const name = /<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1];
  return { filename: name ? decodeHtml(name).trim() : undefined, size: sizeOf(/>\s*Size\s*(?::|-)\s*([^<]+)\s*\|/.exec(html)?.[1]) };
}
const fuckingfast = {
  id: 'fuckingfast',
  name: 'FuckingFast',
  test: hostIn('fuckingfast.co'),
  free: true,
  async resolve(url, ctx) {
    const { res, text } = await getText(ctx, url);
    if (res.status === 404) throw gone('FuckingFast');
    if (res.headers.get('cf-mitigated')) guard('FuckingFast', res, text);
    const meta = ffMeta(text);
    const opened = /window\.open\("(https?:\/\/[^"]+)/.exec(text)?.[1];
    if (opened) return { url: opened, headers: { Referer: url }, ...meta };
    const id = ffId(url);
    if (!id || !text.includes(`/f/${id}/go`)) throw person('FuckingFast', 'a person');
    if (/challenges\.cloudflare\.com\/turnstile\//.test(text) && /turnstileSuccess:\s*false/.test(text)) throw person('FuckingFast');
    const go = await fetcher(ctx)(`https://fuckingfast.co/f/${id}/go`, { method: 'POST', headers: { Referer: url } });
    const link = go.headers.get('hx-redirect');
    await go.body?.cancel().catch(() => {});
    if (!link) throw person('FuckingFast', 'a person');
    return { url: new URL(link, url).href, headers: { Referer: url }, ...meta };
  },
  check: asCheck(async (url, ctx) => {
    const { res, text } = await getText(ctx, url);
    if (res.status === 404) throw gone('FuckingFast');
    if (res.headers.get('cf-mitigated')) guard('FuckingFast', res, text);
    return { status: 'online', ...ffMeta(text) };
  }),
};

// ---- Uploadhaven: a form, a countdown, then the link in the answer ----
const uploadhaven = {
  id: 'uploadhaven',
  name: 'Uploadhaven',
  test: hostIn('uploadhaven.com'),
  free: true,
  maxConnections: 1,
  async resolve(url, ctx) {
    const { res, text } = await getText(ctx, url);
    if (res.status === 404) throw gone('Uploadhaven');
    guard('Uploadhaven', res, text);
    if (/>\s*Hotlink protection active/.test(text)) throw new HostError('Uploadhaven only allows this link from the page it was posted on: open that page and click the link in the window', { browser: true });
    const form = allForms(text).find(f => /id=["']form-(?:join|download)["']/.test(f.attrs));
    if (!form) throw person('Uploadhaven', 'a person');
    const seconds = /var\s*seconds\s*=\s*(\d+)\s*;/.exec(text)?.[1] ?? /class\s*=\s*"download-timer-seconds[^"]*"\s*>\s*(\d+)/.exec(text)?.[1] ?? 5;
    await waitOut('Uploadhaven', Number(seconds) + 3, ctx);
    const answer = await getText(ctx, url, { method: 'POST', body: new URLSearchParams(form.fields), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: url } });
    guard('Uploadhaven', answer.res, answer.text);
    const link = /downloadFile"\)\.attr\("src",\s*"(https?[^">]+)/.exec(answer.text)?.[1] || /(https?:\/\/[A-Za-z0-9-]+\.uploadhaven\.com\/[^"]+key=[^"]+)/.exec(answer.text)?.[1];
    if (!link) throw person('Uploadhaven', 'a person');
    return { url: link, headers: { Referer: url } };
  },
};

// ---- VikingFile: /api/check-file for the name and size; the download needs a Turnstile captcha ----
const vikingId = url => /\/f\/([A-Za-z0-9]{10})/.exec(new URL(url).pathname)?.[1] || null;
async function vikingInfo(url, ctx) {
  const id = vikingId(url);
  if (!id) throw gone('VikingFile');
  const { data } = await getJson(ctx, `https://${new URL(url).hostname}/api/check-file`, { method: 'POST', body: `hash[]=${id}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  if (!Array.isArray(data) || !data[0]) throw new Error('VikingFile check failed');
  if (data[0].exist !== true) throw gone('VikingFile');
  return { status: 'online', filename: data[0].name, size: Number(data[0].size) || undefined };
}
const viking = {
  id: 'vikingfile',
  name: 'VikingFile',
  test: hostIn('vikingfile.com', 'vik1ngfile.site'),
  free: true,
  async resolve(url, ctx) {
    await vikingInfo(url, ctx);
    throw person('VikingFile');
  },
  check: asCheck(vikingInfo),
};

module.exports = [kraken, fuckingfast, uploadhaven, viking];
module.exports._test = { needsPerson, countdown, formFields, krakenHash, ffId, ffMeta, sizeOf, vikingId };
