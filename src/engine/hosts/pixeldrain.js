// Pixeldrain: files (/u/ID) and lists (/l/ID) through its public API. An API key (pixeldrain.com → API keys) lifts the
// free daily limit. When a file needs a captcha (rate limit or virus flag) the download goes to the browser.
const { getJson, hostIn, HostError, gone } = require('./common');

const BASE = 'https://pixeldrain.com/api';
const idOf = (url, kind) => new RegExp(`/${kind}/([\\w-]+)`).exec(String(url))?.[1] || null;
const auth = account => (account?.apiKey ? { Authorization: 'Basic ' + Buffer.from(':' + account.apiKey).toString('base64') } : {});

async function info(id, ctx) {
  const { res, data } = await getJson(ctx, `${BASE}/file/${id}/info`, { headers: auth(ctx.account) });
  if (res.status === 404 || data?.value === 'not_found') throw gone('Pixeldrain');
  if (!res.ok || !data) throw new Error(`Pixeldrain info failed (HTTP ${res.status})`);
  return data;
}

async function resolve(url, ctx) {
  const id = idOf(url, 'u') || idOf(url, 'file');
  if (!id) throw new HostError('Pixeldrain: this is a list link; add it to LinkGrabber to see its files', { permanent: true });
  const d = await info(id, ctx);
  if (/captcha/.test(d.availability || '')) {
    throw new HostError(`Pixeldrain wants a captcha for this file (${d.availability.replace(/_/g, ' ')})`, { browser: true });
  }
  return {
    url: `${BASE}/file/${id}?download`,
    headers: auth(ctx.account),
    filename: d.name,
    size: d.size,
    hash: d.hash_sha256 ? { algo: 'sha256', value: d.hash_sha256 } : null,
  };
}

async function check(url, ctx) {
  const id = idOf(url, 'u') || idOf(url, 'file');
  if (!id) return null;
  try {
    const d = await info(id, ctx);
    return { status: 'online', filename: d.name, size: d.size };
  } catch (e) {
    if (e.permanent) return { status: 'offline', error: e.message };
    throw e;
  }
}

async function crawl(url, ctx) {
  const id = idOf(url, 'l');
  if (!id) return null;
  const { res, data } = await getJson(ctx, `${BASE}/list/${id}`, { headers: auth(ctx.account) });
  if (res.status === 404) throw gone('Pixeldrain list');
  if (!data?.files) throw new Error(`Pixeldrain list failed (HTTP ${res.status})`);
  return { package: data.title || 'Pixeldrain list', links: data.files.map(f => ({ source: `https://pixeldrain.com/u/${f.id}`, name: f.name, size: f.size })) };
}

async function accountInfo(account, ctx) {
  const { res, data } = await getJson(ctx, `${BASE}/user`, { headers: auth(account) });
  if (!res.ok || !data) throw new Error(res.status === 401 ? 'Wrong API key' : `Pixeldrain said HTTP ${res.status}`);
  return { user: data.username, premium: !!data.subscription?.id && data.subscription.id !== 'free', plan: data.subscription?.name || null };
}

module.exports = {
  id: 'pixeldrain',
  name: 'Pixeldrain',
  test: hostIn('pixeldrain.com', 'pixeldra.in', 'pixeldrain.net', 'pixeldrain.dev'),
  free: true,
  isFolder: url => !!idOf(url, 'l'),
  account: { fields: [{ key: 'apiKey', label: 'API key', secret: true }], help: 'pixeldrain.com → Settings → API keys' },
  resolve,
  check,
  crawl,
  accountInfo,
};
