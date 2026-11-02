// Built-in host modules (JDownloader's "host plugins"): turn a file host's page link into a direct link for the HTTP
// engine, list folder links, and use premium accounts where the host has an API.
// Each module: { id, name, test(host), free, account?, maxDownloads?, maxConnections?, noBrowser?, resolve(url, ctx),
//                check?(url, ctx), crawl?(url, ctx), isFolder?(url), accountInfo?(account, ctx) }
// ctx = { signal, route, account }
const { hostOf } = require('./hosters');

const HOSTS = [
  require('./hosts/mega'),
  require('./hosts/pixeldrain'),
  require('./hosts/gofile'),
  require('./hosts/mediafire'),
  require('./hosts/gdrive'),
  require('./hosts/onefichier'),
  require('./hosts/buzzheavier'),
  ...require('./hosts/xfs'),
  ...require('./hosts/simple'),
  ...require('./hosts/premium'),
];

let accounts = {}; // host id -> { field: value, enabled }
function setAccounts(a) {
  accounts = a && typeof a === 'object' ? a : {};
}
const accountFor = mod => {
  const a = mod && accounts[mod.id];
  return a && a.enabled !== false && mod.account?.fields.every(f => a[f.key]) ? a : null;
};

const moduleFor = url => {
  const host = hostOf(url);
  return host ? HOSTS.find(r => r.test(host)) || null : null;
};

// The module that can download this URL right now: a free host, or a premium-only one with an account set up.
// Returns { name, mod, account, resolve(signal, route) } or null.
function resolverFor(url) {
  const mod = moduleFor(url);
  if (!mod) return null;
  const account = accountFor(mod);
  if (!mod.free && !account) return null;
  return {
    name: mod.name,
    id: mod.id,
    mod,
    account,
    premium: !!account,
    maxDownloads: account ? 0 : mod.maxDownloads || 0,
    maxConnections: account ? 0 : mod.maxConnections || 0,
    resolve: (u, signal, route = 0) => mod.resolve(u, { signal, route, account }),
  };
}

const isFolderLink = url => !!moduleFor(url)?.isFolder?.(url);

module.exports = { resolverFor, moduleFor, accountFor, setAccounts, isFolderLink, HOSTS, RESOLVERS: HOSTS };
