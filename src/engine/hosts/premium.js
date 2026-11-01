// Premium accounts for hosts whose free mode needs captchas (so only an account helps): Rapidgator, Nitroflare, Keep2Share.
const { getJson, hostIn, HostError, gone } = require('./common');

// A refused login isn't retried (retries can lock the account): the user fixes it in Settings → Host accounts.
const loginError = (host, msg) =>
  new HostError(`${host} login failed: ${String(msg).replace(/^(Error:\s*)+/i, '')} (check Settings → Host accounts; if it asks for a captcha, log in on the website once)`, { permanent: true });

// ---- Rapidgator (API v2) ----
const rgTokens = new Map(); // login -> token
async function rgLogin(account, ctx, fresh = false) {
  if (!fresh && rgTokens.has(account.login)) return rgTokens.get(account.login);
  const q = new URLSearchParams({ login: account.login, password: account.password });
  const { data } = await getJson(ctx, `https://rapidgator.net/api/v2/user/login?${q}`);
  if (data?.status !== 200 || !data.response?.token) throw loginError('Rapidgator', data?.details || 'no token');
  rgTokens.set(account.login, data.response.token);
  return data.response;
}
const rgId = url => /\/file\/([a-z0-9]+)/i.exec(String(url))?.[1];
const rapidgator = {
  id: 'rapidgator',
  name: 'Rapidgator',
  test: hostIn('rapidgator.net', 'rg.to', 'rapidgator.asia'),
  free: false,
  account: { fields: [{ key: 'login', label: 'E-mail' }, { key: 'password', label: 'Password', secret: true }], help: 'Your Rapidgator premium login' },
  async resolve(url, ctx) {
    const id = rgId(url);
    if (!id) throw new HostError('Rapidgator: no file id in this link', { permanent: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      const auth = await rgLogin(ctx.account, ctx, attempt > 0);
      const token = typeof auth === 'string' ? auth : auth.token;
      const { data } = await getJson(ctx, `https://rapidgator.net/api/v2/file/download?file_id=${id}&token=${token}`);
      if (data?.response?.download_url) return { url: data.response.download_url, headers: {} };
      if (data?.status === 404) throw gone('Rapidgator');
      if (data?.status === 401) continue; // token expired
      const msg = data?.details || 'no link';
      if (/traffic|limit/i.test(msg)) throw new HostError(`Rapidgator: ${msg}`, { wait: 60 * 60000, hostWide: true });
      throw new Error(`Rapidgator: ${msg}`);
    }
    throw new Error('Rapidgator login expired');
  },
  async accountInfo(account, ctx) {
    const r = await rgLogin(account, ctx, true);
    const u = r.user || {};
    return { user: u.email, premium: !!u.is_premium, expires: u.premium_end_time ? new Date(u.premium_end_time * 1000).toISOString() : null, trafficLeft: Number(u.traffic?.left) || null };
  },
};

// ---- Nitroflare (API v2) ----
const nfId = url => /\/view\/([A-Z0-9]+)/i.exec(String(url))?.[1];
const nitroflare = {
  id: 'nitroflare',
  name: 'Nitroflare',
  test: hostIn('nitroflare.com', 'nitro.download'),
  free: false,
  account: { fields: [{ key: 'user', label: 'E-mail' }, { key: 'premiumKey', label: 'Premium key', secret: true }], help: 'nitroflare.com → Account → Premium key' },
  async resolve(url, ctx) {
    const id = nfId(url);
    if (!id) throw new HostError('Nitroflare: no file id in this link', { permanent: true });
    const q = new URLSearchParams({ file: id, user: ctx.account.user, premiumKey: ctx.account.premiumKey });
    const { data } = await getJson(ctx, `https://nitroflare.com/api/v2/getDownloadLink?${q}`);
    if (data?.type === 'success' && data.result?.url) return { url: data.result.url, headers: {}, filename: data.result.name, size: Number(data.result.size) || null };
    const msg = data?.message || 'no link';
    if (/not exist|not found|deleted/i.test(msg)) throw gone('Nitroflare');
    if (/captcha|premium key|wrong|invalid|user/i.test(msg)) throw loginError('Nitroflare', msg);
    throw new Error(`Nitroflare: ${msg}`);
  },
  async accountInfo(account, ctx) {
    const q = new URLSearchParams({ user: account.user, premiumKey: account.premiumKey });
    const { data } = await getJson(ctx, `https://nitroflare.com/api/v2/getKeyInfo?${q}`);
    if (data?.type !== 'success') throw loginError('Nitroflare', data?.message || 'wrong key');
    return { user: account.user, premium: data.result?.status === 'active', expires: data.result?.expiryDate || null, trafficLeft: Number(data.result?.trafficLeft) || null };
  },
};

// ---- Keep2Share / K2S (API v2) ----
const k2sTokens = new Map();
const k2sCall = (ctx, method, body) =>
  getJson(ctx, `https://k2s.cc/api/v2/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.data || {});
async function k2sLogin(account, ctx, fresh) {
  if (!fresh && k2sTokens.has(account.login)) return k2sTokens.get(account.login);
  const d = await k2sCall(ctx, 'login', { username: account.login, password: account.password });
  if (d.status !== 'success' || !d.auth_token) throw loginError('Keep2Share', d.message || 'no token');
  k2sTokens.set(account.login, d.auth_token);
  return d.auth_token;
}
const k2sId = url => /\/file\/([a-z0-9]+)/i.exec(String(url))?.[1];
const k2s = {
  id: 'k2s',
  name: 'Keep2Share',
  test: hostIn('k2s.cc', 'keep2share.cc', 'keep2s.cc', 'k2share.cc'),
  free: false,
  account: { fields: [{ key: 'login', label: 'E-mail' }, { key: 'password', label: 'Password', secret: true }], help: 'Your Keep2Share premium login' },
  async resolve(url, ctx) {
    const id = k2sId(url);
    if (!id) throw new HostError('Keep2Share: no file id in this link', { permanent: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      const auth_token = await k2sLogin(ctx.account, ctx, attempt > 0);
      const d = await k2sCall(ctx, 'getUrl', { auth_token, file_id: id });
      if (d.status === 'success' && d.url) return { url: d.url, headers: {} };
      if (d.code === 404 || /not found/i.test(d.message || '')) throw gone('Keep2Share');
      if (d.code === 401 || /auth/i.test(d.message || '')) continue;
      throw new Error(`Keep2Share: ${d.message || 'no link'}`);
    }
    throw new Error('Keep2Share login expired');
  },
  async accountInfo(account, ctx) {
    const auth_token = await k2sLogin(account, ctx, true);
    const d = await k2sCall(ctx, 'accountInfo', { auth_token });
    return { user: account.login, premium: d.account_expires > Date.now() / 1000, expires: d.account_expires ? new Date(d.account_expires * 1000).toISOString() : null, trafficLeft: Number(d.available_traffic) || null };
  },
};

module.exports = [rapidgator, nitroflare, k2s];
