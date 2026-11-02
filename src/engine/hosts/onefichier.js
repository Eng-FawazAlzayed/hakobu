// 1fichier: free downloads (one at a time, with a wait between files per IP) and premium through its API key.
// The messages in freeWait are from JDownloader 2 (GPL-3.0-or-later, JD-Team), jd/plugins/hoster/OneFichierCom.java r53703,
// source mirror commit 6ab1aecd of 2026-11-02.
const { getText, getJson, hostIn, decodeHtml, HostError, gone } = require('./common');

const DOMAINS = ['1fichier.com', 'alterupload.com', 'cjoint.net', 'desfichiers.com', 'dfichiers.com', 'megadl.fr', 'mesfichiers.org', 'piecejointe.net', 'pjointe.com', 'tenvoi.com', 'dl4free.com'];

const canonical = url => {
  const id = /\?([a-z0-9]{5,})/i.exec(String(url))?.[1] || /\/\/([a-z0-9]{5,})\.1fichier\.com/i.exec(String(url))?.[1];
  return id ? `https://1fichier.com/?${id}` : String(url);
};

function freeWait(html) {
  if (/>\s*Your requests are too fast/i.test(html)) return new HostError('1fichier: requests too fast, waiting', { wait: 5 * 60000, ipLimit: true, hostWide: true });
  if (/>\s*Our services are in maintenance/i.test(html)) return new HostError('1fichier is under maintenance', { wait: 30 * 60000, hostWide: true });
  if (/>\s*Software error:?\s*<|>\s*Connexion à la base de données impossible<|>Can\'t connect DB/i.test(html)) return new HostError('1fichier: server error', { wait: 15 * 60000 });
  if (/>\s*IP Locked|>\s*Will be unlocked within 1h\.|Your account will be unlock/i.test(html)) return new HostError('1fichier locked your IP for an hour', { wait: 60 * 60000, ipLimit: true, hostWide: true });
  if (/not possible to free unregistered users/i.test(html)) return new HostError('1fichier: free downloads are not offered to your connection', { wait: 60 * 60000, ipLimit: true, hostWide: true });
  if (/>\s*(?:Access to this file is protected|This file is protected)/i.test(html)) return new HostError('1fichier: the uploader only allows subscribers or chosen users to download this', { permanent: true });
  const m = /you must wait (?:at least |up to )?\s*(\d+)\s*minutes?/i.exec(html) || /Vous devez attendre (?:encore )?(\d+) minutes?/i.exec(html);
  if (m) return new HostError(`1fichier: wait ${m[1]} minutes between free downloads`, { wait: (Number(m[1]) + 1) * 60000, ipLimit: true, hostWide: true });
  if (/only download one file at a time|un seul fichier à la fois|>\s*You already downloading (?:some|a) file|>\s*veuillez patienter avant de télécharger un autre fichier|\/>\s*Téléchargements en cours/i.test(html)) {
    return new HostError('1fichier: free users get one download at a time', { wait: 2 * 60000, ipLimit: true, hostWide: true });
  }
  return null;
}

const directLink = html => {
  const m = /href="(https?:\/\/[a-z0-9-]+\.1fichier\.com\/[^"]+)"[^>]*class="[^"]*ok btn-general/i.exec(html) || /class="[^"]*ok btn-general[^"]*"[^>]*href="(https?:\/\/[^"]+)"/i.exec(html);
  return m ? decodeHtml(m[1]) : null;
};

async function premium(url, ctx) {
  const { res, data } = await getJson(ctx, 'https://api.1fichier.com/v1/download/get_token.cgi', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.account.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: canonical(url) }),
  });
  if (data?.status === 'OK' && data.url) return { url: data.url, headers: {} };
  const msg = data?.message || `HTTP ${res.status}`;
  if (/not found|Resource not found|#\d*: File not/i.test(msg)) throw gone('1fichier');
  if (/Flood detected|too many/i.test(msg)) throw new HostError(`1fichier API: ${msg}`, { wait: 5 * 60000 });
  throw new Error(`1fichier API: ${msg}`);
}

async function free(url, ctx) {
  const page = canonical(url);
  const { res, text } = await getText(ctx, page, { headers: { Cookie: 'LG=en' } });
  if (res.status === 404 || /The requested file (could not be found|has been deleted)|File not found/i.test(text)) throw gone('1fichier');
  const wait = freeWait(text);
  if (wait) throw wait;
  if (/name="pass"/i.test(text)) throw new HostError('1fichier: this file has a password; open it in your browser', { browser: true });
  const adz = /name="adz"\s+value="([^"]+)"/i.exec(text)?.[1];
  const body = new URLSearchParams(adz ? { adz } : {});
  const r2 = await getText(ctx, page, { method: 'POST', body, headers: { Cookie: 'LG=en', 'Content-Type': 'application/x-www-form-urlencoded', Referer: page } });
  const wait2 = freeWait(r2.text);
  if (wait2) throw wait2;
  const link = directLink(r2.text);
  if (!link) throw new HostError("1fichier didn't hand out a free link (it may want a captcha)", { browser: true });
  return { url: link, headers: { Referer: page }, maxConnections: 1, resumable: false };
}

async function accountInfo(account, ctx) {
  const { data } = await getJson(ctx, 'https://api.1fichier.com/v1/user/info.cgi', {
    method: 'POST',
    headers: { Authorization: `Bearer ${account.apiKey}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!data || data.status === 'KO') throw new Error(data?.message || 'Wrong API key');
  return { user: data.email, premium: Number(data.offer) > 0, expires: data.premium_expire || data.access_ca_expire || null };
}

module.exports = {
  id: '1fichier',
  name: '1fichier',
  test: hostIn(...DOMAINS),
  free: true,
  maxDownloads: 1,
  maxConnections: 1,
  account: { fields: [{ key: 'apiKey', label: 'API key', secret: true }], help: '1fichier.com → Parameters → API key (premium)' },
  resolve: (url, ctx) => (ctx.account?.apiKey ? premium(url, ctx) : free(url, ctx)),
  accountInfo,
  _test: { freeWait, directLink, canonical },
};
