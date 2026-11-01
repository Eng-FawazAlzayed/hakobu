// Gofile (gofile.io/d/CODE): every link is a folder. Hakobu makes a guest account (as the website does), lists the
// folder and its sub-folders, and downloads each file with that account's cookie. A premium token can be set instead.
const crypto = require('crypto');
const { getJson, getText, hostIn, HostError, gone, UA } = require('./common');

const API = 'https://api.gofile.io';
let guest = null; // { token, at }
let wt = null; // website token, read from gofile's own script

async function token(ctx) {
  if (ctx.account?.token) return ctx.account.token;
  if (guest && Date.now() - guest.at < 6 * 3600 * 1000) return guest.token;
  const { data } = await getJson(ctx, `${API}/accounts`, { method: 'POST' });
  if (data?.status !== 'ok' || !data.data?.token) throw new Error('Gofile: could not create a guest account');
  guest = { token: data.data.token, at: Date.now() };
  return guest.token;
}

async function websiteToken(ctx, tok) {
  if (!wt) {
    for (const src of ['https://gofile.io/dist/js/config.js', 'https://gofile.io/dist/js/global.js']) {
      try {
        const { text } = await getText(ctx, src);
        const m = /\bwt\s*[:=]\s*["']([\w-]+)["']/.exec(text) || /websiteToken\s*[:=]\s*["']([\w-]+)["']/.exec(text);
        if (m) {
          wt = m[1];
          break;
        }
      } catch {}
    }
    wt = wt || '4fd6sg89d7s6';
  }
  // Newer site versions sign each request: sha256(UA::lang::token::4-hour slot::secret). Sent alongside the old ?wt=.
  const slot = Math.floor(Date.now() / 1000 / 14400);
  const signed = crypto.createHash('sha256').update(`${UA}::en-US::${tok}::${slot}::5d4f7g8sd45fsd`).digest('hex');
  return { wt, signed };
}

const codeOf = url => /\/d\/([\w-]+)/.exec(String(url))?.[1] || null;

async function contents(code, ctx) {
  const tok = await token(ctx);
  const { wt: w, signed } = await websiteToken(ctx, tok);
  const { res, data } = await getJson(ctx, `${API}/contents/${code}?wt=${w}&cache=true&sortField=name&sortDirection=1`, {
    headers: { Authorization: `Bearer ${tok}`, 'X-Website-Token': signed, 'X-BL': 'en-US' },
  });
  if (data?.status === 'error-notFound' || res.status === 404) throw gone('Gofile');
  if (data?.status === 'error-passwordRequired') throw new HostError('Gofile: this folder has a password; open it in your browser', { browser: true });
  // Also what guests get when Gofile's website check changes: the browser (or a premium token) still works.
  if (data?.status === 'error-notPremium') throw new HostError('Gofile only lists folders for its website or premium accounts: open it in your browser, or add your premium token in Settings → Host accounts', { browser: true });
  if (data?.status !== 'ok') throw new HostError(`Gofile refused the listing (${data?.status || 'HTTP ' + res.status})`, { browser: true });
  return { tok, folder: data.data };
}

async function crawl(url, ctx) {
  const code = codeOf(url);
  if (!code) return null;
  const links = [];
  let top = null;
  const walk = async (c, sub, depth) => {
    const { tok, folder } = await contents(c, ctx);
    top = top || folder.name;
    if (folder.type === 'file') {
      links.push(fileLink(folder, tok, sub));
      return;
    }
    for (const ch of Object.values(folder.children || {})) {
      if (ch.type === 'file') links.push(fileLink(ch, tok, sub));
      else if (ch.type === 'folder' && depth < 6 && links.length < 5000) await walk(ch.code || ch.id, [sub, ch.name].filter(Boolean).join('/'), depth + 1);
    }
  };
  await walk(code, '', 0);
  return { package: top || `Gofile ${code}`, links };
}

const fileLink = (f, tok, sub) => ({
  source: f.link,
  name: f.name,
  size: f.size,
  subfolder: sub,
  headers: { Cookie: `accountToken=${tok}`, Referer: 'https://gofile.io/' },
  hash: f.md5 ? { algo: 'md5', value: f.md5 } : null,
  check: { status: 'online' },
});

// A /d/ link added straight to the list (not through LinkGrabber): one file -> that file, more -> ask for LinkGrabber.
async function resolve(url, ctx) {
  const list = await crawl(url, ctx);
  if (!list?.links.length) throw gone('Gofile');
  if (list.links.length > 1) throw new HostError('Gofile: this folder has several files; add it to LinkGrabber to pick them', { permanent: true });
  const f = list.links[0];
  return { url: f.source, headers: f.headers, filename: f.name, size: f.size, hash: f.hash };
}

async function accountInfo(account, ctx) {
  const { data } = await getJson(ctx, `${API}/accounts/website`, { headers: { Authorization: `Bearer ${account.token}` } });
  if (data?.status !== 'ok') throw new Error('Gofile rejected that token');
  return { user: data.data?.email || data.data?.id, premium: data.data?.tier === 'premium', plan: data.data?.tier };
}

module.exports = {
  id: 'gofile',
  name: 'Gofile',
  test: hostIn('gofile.io'),
  free: true,
  isFolder: url => !!codeOf(url),
  account: { fields: [{ key: 'token', label: 'Account token', secret: true }], help: 'gofile.io → My profile → Account token' },
  resolve,
  crawl,
  accountInfo,
};
