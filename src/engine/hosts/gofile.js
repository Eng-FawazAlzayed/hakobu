// Gofile (gofile.io/d/CODE): every link is a folder. Its API only lists folders for premium accounts, so Hakobu uses
// your premium token (Settings → Host accounts) and downloads each file with its cookie. Without a token the folder
// opens in the browser.
const { getJson, hostIn, HostError, gone } = require('./common');

const API = 'https://api.gofile.io';

function token(ctx) {
  if (ctx.account?.token) return ctx.account.token;
  throw new HostError('Gofile folders need a premium token: open it in your browser, or add your token in Settings → Host accounts', { browser: true });
}

const codeOf = url => /\/d\/([\w-]+)/.exec(String(url))?.[1] || null;

async function contents(code, ctx) {
  const tok = token(ctx);
  const { res, data } = await getJson(ctx, `${API}/contents/${code}?cache=true&sortField=name&sortDirection=1`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (data?.status === 'error-notFound' || res.status === 404) throw gone('Gofile');
  if (data?.status === 'error-passwordRequired') throw new HostError('Gofile: this folder has a password; open it in your browser', { browser: true });
  if (data?.status === 'error-notPremium') throw new HostError('Gofile says this token is not premium: open the folder in your browser', { browser: true });
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
  free: false,
  isFolder: url => !!codeOf(url),
  account: { fields: [{ key: 'token', label: 'Account token', secret: true }], help: 'gofile.io → My profile → Account token' },
  resolve,
  crawl,
  accountInfo,
};
