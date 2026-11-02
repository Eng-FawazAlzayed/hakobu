// JDownloader's "show it to the user": a host page with a captcha or a bot check opens in a window inside Hakobu. The
// person solves it and clicks download; Hakobu never fills in or solves anything. The download is taken over from there
// (chunks, resume, hash checks), and later requests to that site use the same session and so its cookies.
const { BrowserWindow, session } = require('electron');
const fs = require('fs');
const { siteOf, registerSiteFetch } = require('./engine/net');

class HostWindows {
  // file: where the sites with a session are remembered. onHandoff(item, title) / onClosed(item): tell the user.
  constructor({ manager, file, parent, onHandoff }) {
    this.manager = manager;
    this.file = file;
    this.parent = parent;
    this.onHandoff = onHandoff;
    this.windows = new Map(); // item id -> BrowserWindow
    this.hooked = new Set();
    this.sites = {}; // site -> site whose session it uses (the file's server may be on another domain)
    try {
      this.sites = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch {}
    for (const [site, owner] of Object.entries(this.sites)) this.useSession(site, owner);
  }

  remember(site, owner) {
    if (this.sites[site] === owner) return;
    this.sites[site] = owner;
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.sites, null, 2));
    } catch {}
  }

  sessionFor(site) {
    const ses = session.fromPartition(`persist:host-${site}`);
    if (!this.hooked.has(site)) {
      this.hooked.add(site);
      ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Hakobu|hakobu|Electron)\/\S+/g, ''));
      ses.on('will-download', (e, dl, wc) => {
        this.caught(e, dl, wc, site, ses).catch(err => console.error('[host window]', err.message));
      });
    }
    return ses;
  }

  // Requests to `site` go through the session of `owner`: same cookies and the same connection as the window.
  useSession(site, owner) {
    const ses = this.sessionFor(owner);
    registerSiteFetch(site, (url, opts = {}) => {
      const headers = { ...(opts.headers || {}) };
      delete headers['User-Agent']; // keep the session's own: a site's clearance is tied to it
      delete headers.Cookie;
      // Chromium refuses some requests from code (ERR_BLOCKED_BY_CLIENT): the link's own cookie still works without it.
      return ses.fetch(String(url), { ...opts, headers, credentials: 'include' }).catch(e => {
        if (!/ERR_BLOCKED_BY_CLIENT/.test(e.message)) throw e;
        return fetch(url, opts);
      });
    });
  }

  open(id) {
    const open = this.windows.get(id);
    if (open && !open.isDestroyed()) {
      if (open.isMinimized()) open.restore();
      open.focus();
      return true;
    }
    const url = this.manager.browserOpened(id);
    const site = siteOf(url);
    if (!site || !/^https?:\/\//i.test(url)) return false;
    const it = this.manager.items.get(id);
    const ses = this.sessionFor(site);
    this.useSession(site, site);
    this.remember(site, site);
    const w = new BrowserWindow({
      width: 1100,
      height: 800,
      title: `Solve this to download: ${it.name}`,
      autoHideMenuBar: true,
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.windows.set(id, w);
    w.itemId = id;
    // The page's own title would hide what this window is for.
    w.on('page-title-updated', e => e.preventDefault());
    // New tabs stay in this window when they're the host's own; other sites' pop-ups (ads) don't open.
    w.webContents.setWindowOpenHandler(({ url: next }) => {
      if (siteOf(next) === site) w.loadURL(next);
      return { action: 'deny' };
    });
    w.on('closed', () => {
      this.windows.delete(id);
      this.manager.browserClosed(id);
    });
    w.loadURL(url).catch(() => {});
    return true;
  }

  // The person got as far as the download: it continues in Hakobu.
  async caught(e, dl, wc, site, ses) {
    const url = dl.getURL();
    const filename = dl.getFilename(); // the item is gone once the download is cancelled
    if (!/^https?:/i.test(url)) return; // made inside the page (a blob): only the page has it, so the window saves it
    e.preventDefault();
    const w = BrowserWindow.fromWebContents(wc);
    const id = w?.itemId || [...this.windows.entries()].find(([, x]) => !x.isDestroyed() && x.webContents.session === ses)?.[0];
    if (!id) return;
    const fileSite = siteOf(url);
    if (fileSite && fileSite !== site) {
      this.useSession(fileSite, site);
      this.remember(fileSite, site);
    }
    const cookies = await ses.cookies.get({ url }).catch(() => []);
    const headers = {};
    if (cookies.length) headers.Cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const referrer = wc?.getURL?.();
    if (/^https?:/i.test(referrer || '')) headers.Referer = referrer;
    const it = this.manager.items.get(id);
    this.manager.browserHandoff(id, { source: url, headers, suggestedName: filename || undefined });
    if (it) this.onHandoff?.(it);
    if (w && !w.isDestroyed()) {
      this.windows.delete(id);
      w.destroy();
    }
  }
}

module.exports = { HostWindows };
