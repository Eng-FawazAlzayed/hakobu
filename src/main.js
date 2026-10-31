const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, safeStorage, Notification, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const { Manager, DEFAULT_SETTINGS, loadItems } = require('./engine/manager');
const { parseLinks } = require('./linkparse');
const { FeedService, search, loadPlugins, loadSearchPlugins, resolveTorrentLink } = require('./engine/feeds');
const { LocalApi } = require('./engine/api');
const { checkLinks, packageName } = require('./engine/linkcheck');
const { HosterRegistry } = require('./engine/hosters');
const { ToolManager } = require('./engine/tools');
const { mediaInfo } = require('./engine/media');
const { execFile } = require('child_process');
const crypto = require('crypto');

const SECRET_KEYS = ['torboxKey', 'realdebridToken'];
let win = null;
let manager = null;
let feeds = null;
let localApi = null;
let hosters = null;
let tools = null;

// Installer step: "Hakobu.exe --setup-tools" shows a small window, fetches the newest yt-dlp, Deno and ffmpeg, then exits.
async function runSetupTools() {
  const tm = new ToolManager(TOOLS_DIR);
  const w = new BrowserWindow({
    width: 520, height: 380, resizable: false, maximizable: false, minimizable: false, title: 'Setting up Hakobu',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1117' : '#f4f5f9', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  w.setMenu(null);
  await w.loadFile(path.join(__dirname, 'renderer', 'setup.html'));
  const send = (ch, v) => !w.isDestroyed() && w.webContents.send(ch, v);
  const results = await tm.install(undefined, p => send('toolsProgress', p));
  const failed = Object.entries(results).filter(([, r]) => !r.ok);
  send('toolsDone', { results, failed: failed.length });
  // leave the result on screen briefly; failures stay until closed (the app retries on first start)
  setTimeout(() => app.exit(failed.length ? 2 : 0), failed.length ? 15000 : 1800);
  w.on('closed', () => app.exit(failed.length ? 2 : 0));
}

// Every grabbed link gets an automatic package name (JDownloader groups LinkGrabber by these).
const withPackages = entries => entries.map(e => ({ ...e, autoPackage: e.package || (e.kind === 'torrent' ? e.name : packageName(e.suggestedName || e.name)) }));

function extensionDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(__dirname, '..', 'extension');
}

async function startApi() {
  const s = manager.settings;
  return localApi.start({ apiPort: s.apiPort || 6464, token: s.apiToken, cnl: s.cnlEnabled });
}
let pendingGrab = [];

// Dev helpers: HAKOBU_PROFILE=<dir> uses a throwaway profile, HAKOBU_SHOT=<png> screenshots and quits.
if (process.env.HAKOBU_PROFILE) app.setPath('userData', process.env.HAKOBU_PROFILE);
else {
  // Renamed from "Conduit": move the old profile (settings, downloads list, media tools, encrypted keys) once.
  // Electron creates the (empty) new folder before this code runs, so "has app data" is what counts, not "exists".
  const oldDir = path.join(app.getPath('appData'), 'Conduit');
  const newDir = app.getPath('userData');
  const hasData = d => ['settings.json', 'downloads.json'].some(f => fs.existsSync(path.join(d, f)));
  if (hasData(oldDir) && !hasData(newDir)) {
    try {
      fs.rmSync(newDir, { recursive: true, force: true });
      fs.renameSync(oldDir, newDir);
    } catch {
      app.setPath('userData', oldDir); // couldn't move it: keep using the old folder rather than starting empty
    }
  }
}
const SETUP_MODE = process.argv.includes('--setup-tools');
const TOOLS_DIR = path.join(app.getPath('userData'), 'tools');
if (SETUP_MODE) app.setPath('userData', path.join(app.getPath('temp'), 'hakobu-setup-profile'));
else if (!app.requestSingleInstanceLock()) app.quit();

const userFile = name => path.join(app.getPath('userData'), name);

// ---------- settings with API keys encrypted by the OS (DPAPI on Windows) ----------

function loadSettings() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(userFile('settings.json'), 'utf8'));
  } catch {}
  for (const k of SECRET_KEYS) {
    if (typeof raw[k] === 'string' && raw[k].startsWith('enc:')) {
      try {
        raw[k] = safeStorage.decryptString(Buffer.from(raw[k].slice(4), 'base64'));
      } catch {
        raw[k] = '';
      }
    }
  }
  return { ...DEFAULT_SETTINGS, downloadDir: app.getPath('downloads'), ...raw };
}

function saveSettings(settings) {
  const out = { ...settings };
  if (safeStorage.isEncryptionAvailable()) {
    for (const k of SECRET_KEYS) if (out[k]) out[k] = 'enc:' + safeStorage.encryptString(out[k]).toString('base64');
  }
  fs.writeFileSync(userFile('settings.json'), JSON.stringify(out, null, 2));
}

// ---------- link intake (magnet:// handler, .torrent files, clipboard) ----------

function grabFromArgs(argv) {
  const entries = [];
  for (const arg of argv.slice(1)) {
    if (/^magnet:/i.test(arg)) entries.push(...parseLinks(arg));
    else if (/\.torrent$/i.test(arg) && fs.existsSync(arg)) {
      entries.push({
        kind: 'torrent',
        source: arg,
        name: path.basename(arg, '.torrent'),
        torrentB64: fs.readFileSync(arg).toString('base64'),
      });
    }
  }
  sendGrab(entries);
}

function sendGrab(entries) {
  if (!entries.length) return;
  entries = withPackages(entries);
  if (win && !win.webContents.isLoading()) {
    win.webContents.send('grab', entries);
    if (win.isMinimized()) win.restore();
    win.focus();
  } else {
    pendingGrab.push(...entries);
  }
}

let lastClip = '';
function pollClipboard() {
  if (!manager?.settings.clipboardMonitor) return;
  const text = clipboard.readText();
  if (text === lastClip) return;
  lastClip = text;
  const entries = parseLinks(text);
  if (entries.length) win?.webContents.send('grab', withPackages(entries));
}

// ---------- window ----------

let resolvedTheme = null;
function titleBarColors() {
  const dark = resolvedTheme ? ['dark', 'oled'].includes(resolvedTheme) : nativeTheme.shouldUseDarkColors;
  return { color: '#00000000', symbolColor: dark ? '#c9cede' : '#3a3f4f', height: 44 };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1117' : '#f4f5f9',
    title: 'Hakobu',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarColors(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenu(null);
  const resync = () => manager && win.webContents.send('items', manager.snapshot());
  win.on('restore', resync);
  win.on('show', resync);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    if (pendingGrab.length) win.webContents.send('grab', pendingGrab.splice(0));
    if (process.env.HAKOBU_SHOT) runScreenshots();
  });
  // Never navigate the app window; open external links in the browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', e => e.preventDefault());
}

// Dev only: render demo data in every theme and save screenshots to HAKOBU_SHOT (a folder).
async function runScreenshots() {
  const demo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', 'ui-demo.json'), 'utf8'));
  const out = process.env.HAKOBU_SHOT;
  const js = code => win.webContents.executeJavaScript(code);
  const shot = async name => fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await wait(800);
  await js("toolsDismissed = true; document.querySelector('#toolsDlg').classList.remove('show')");
  win.webContents.send('items', demo.items);
  await wait(300);
  await js(`Object.assign(settings, ${JSON.stringify(demo.settings || {})}); catKey = ''; selected = new Set(['a']); render();`);
  win.webContents.send('feeds', demo.rss);
  for (const theme of ['dark', 'aero']) {
    await js(`__setTheme('${theme}')`);
    await wait(1200);
    await shot('downloads-' + theme);
  }
  await js(`__setTheme('dark'); detailTab = 'options'; detailKey = ''; renderDetails();`);
  await wait(900);
  await shot('details-options');
  await js(`detailTab = 'files'; detailKey = ''; renderDetails();`);
  await wait(900);
  await shot('details-files');
  await js(`showView('search'); results = ${JSON.stringify(demo.search || [])}; document.querySelector('#searchQ').value = 'linux iso'; document.querySelector('#searchInfo').textContent = results.length + ' results'; renderResults();`);
  await wait(1000);
  await shot('search-dark');
  await js(`showView('rss'); selectRss({ type: 'feed', id: 'f1' });`);
  await wait(400);
  win.webContents.send('feeds', demo.rss);
  await js(`selectRss({ type: 'feed', id: 'f1' });`);
  await wait(1000);
  await shot('rss-dark');
  await js(`__setTheme('light'); selectRss({ type: 'rule', id: 'r1' });`);
  await wait(1200);
  await shot('rss-rule-light');
  await js(`__setTheme('dark'); grab = ${JSON.stringify(demo.grab || [])}; renderGrab(); showView('grabber');`);
  await wait(1000);
  await shot('grabber-packages');
  await js(`showView('downloads'); groupPkgs = true; selected = new Set(); render();`);
  await wait(1000);
  await shot('downloads-packages');
  await js(`showView('settings'); document.querySelector('.settings').scrollTop = 880;`);
  await wait(1000);
  await shot('settings-jd');
  await js(`__setTheme('dark'); showView('settings'); document.querySelector('.settings').scrollTop = 520;`);
  await wait(1000);
  await shot('settings-dark');
  app.quit();
}

function registerIpc() {
  ipcMain.handle('state', () => ({ items: manager.snapshot(), settings: manager.settings, peerPort: manager.torrents.port, altLimits: manager.limitsAlt }));
  ipcMain.handle('parse', (_e, text) => withPackages(parseLinks(text)));
  ipcMain.handle('checkLinks', async (_e, urls) => {
    await hosters.refresh().catch(() => {});
    return checkLinks(urls, { registry: hosters, route: url => manager.defaultRoute({ kind: 'http', source: url }) });
  });
  ipcMain.handle('hosters', async (_e, force) => {
    await hosters.refresh(!!force).catch(() => {});
    return hosters.list();
  });
  ipcMain.handle('extractNow', (_e, id) => manager.extractNow(id));
  ipcMain.handle('apiStatus', () => ({ ...localApi.status, port: manager.settings.apiPort, token: manager.settings.apiToken, extensionDir: extensionDir() }));
  ipcMain.handle('openExtensionDir', () => shell.openPath(extensionDir()));
  ipcMain.handle('newApiToken', async () => {
    manager.applySettings({ apiToken: crypto.randomBytes(18).toString('base64url') });
    saveSettings(manager.settings);
    await startApi();
    return manager.settings.apiToken;
  });
  // The renderer shows a cancellable countdown first; this runs only after it finishes.
  ipcMain.handle('powerAction', (_e, action) => {
    if (action === 'quit') return app.quit();
    if (action === 'sleep') return execFile('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']);
    if (action === 'shutdown') return execFile('shutdown', ['/s', '/t', '0']);
  });
  ipcMain.handle('add', (_e, entries) => manager.add(entries).length);
  ipcMain.handle('action', async (_e, ids, action) => {
    for (const id of ids) {
      if (action === 'pause') await manager.pause(id);
      else if (action === 'resume') manager.resume(id);
      else if (action === 'seed') manager.seed(id);
      else if (action === 'remove') await manager.remove(id, false);
      else if (action === 'delete') await manager.remove(id, true);
      else if (action === 'open') {
        const loc = manager.location(id);
        if (loc && fs.existsSync(loc)) shell.showItemInFolder(loc);
        else if (loc) shell.openPath(path.dirname(loc));
      }
    }
  });
  ipcMain.handle('setTheme', (_e, theme) => {
    resolvedTheme = theme;
    win?.setTitleBarOverlay(titleBarColors());
    win?.setBackgroundColor({ dark: '#0f1117', oled: '#000000', light: '#f4f5f9', aero: '#9fdcff' }[theme] || '#0f1117');
  });
  ipcMain.handle('pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('saveSettings', async (_e, patch) => {
    const restartApi = ['apiPort', 'cnlEnabled'].some(k => k in patch && patch[k] !== manager.settings[k]);
    manager.applySettings(patch);
    saveSettings(manager.settings);
    if (restartApi) await startApi();
    return manager.settings;
  });
  ipcMain.handle('testDebrid', async (_e, name, key) => {
    const p = manager.provider(name);
    if (key !== undefined) {
      if (name === 'torbox') p.key = key;
      else p.token = key;
    }
    return p.user();
  });
  ipcMain.handle('torrentInfo', (_e, entry) => manager.torrents.fetchMetadata(entry));
  ipcMain.handle('mediaInfo', (_e, url) => mediaInfo(url, tools));
  ipcMain.handle('toolsStatus', (_e, checkLatest) => tools.status({ checkLatest: !!checkLatest }));
  ipcMain.handle('toolsInstall', async (_e, names) => {
    const results = await tools.install(names || undefined, p => win?.webContents.send('toolsProgress', p));
    manager.applySettings({ lastToolsCheck: Date.now() });
    saveSettings(manager.settings);
    return results;
  });
  ipcMain.handle('toolsUpdate', async () => {
    const r = await tools.update(p => win?.webContents.send('toolsProgress', p));
    manager.applySettings({ lastToolsCheck: Date.now() });
    saveSettings(manager.settings);
    return r;
  });
  ipcMain.handle('update', (_e, ids, patch) => Promise.all(ids.map(id => manager.update(id, patch))));
  ipcMain.handle('setCategories', (_e, cats) => {
    manager.setCategories(cats);
    saveSettings(manager.settings);
    return manager.settings;
  });
  ipcMain.handle('peers', (_e, id) => manager.peers(id));
  ipcMain.handle('trackers', (_e, id) => manager.trackers(id));
  ipcMain.handle('resolveLink', (_e, url) => resolveTorrentLink(url));
  const pluginDir = () => userFile('plugins');
  const offPlugins = () => manager.settings.disabledPlugins || [];
  ipcMain.handle('search', (_e, q) => search(manager.settings.searchProviders || [], q, loadSearchPlugins(pluginDir(), offPlugins())));
  const pluginSource = id => {
    const p = loadPlugins(pluginDir(), offPlugins()).find(x => x.id === id && x.source);
    if (!p) throw new Error('That plugin is turned off or no longer in the plugins folder');
    return p.source;
  };
  ipcMain.handle('sources', () => loadPlugins(pluginDir(), offPlugins()).filter(p => p.source).map(p => ({ id: p.id, title: p.source.title || p.name, icon: p.source.icon || '' })));
  // Settings → Plugins: every .js in the folder, including turned-off and broken ones.
  const pluginList = () => {
    const off = offPlugins();
    const on = new Map(loadPlugins(pluginDir()).map(p => [p.id, p]));
    return [...on.values()].map(p => ({ id: p.id, name: p.source?.title || p.name, search: !!p.search, source: !!p.source, error: p.error || null, enabled: !off.includes(p.id) }));
  };
  ipcMain.handle('plugins', pluginList);
  ipcMain.handle('pluginAdd', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Add a Hakobu plugin', filters: [{ name: 'Hakobu plugin', extensions: ['js'] }], properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return pluginList();
    fs.mkdirSync(pluginDir(), { recursive: true });
    for (const f of r.filePaths) fs.copyFileSync(f, path.join(pluginDir(), path.basename(f)));
    return pluginList();
  });
  // Removing sends the file to the Recycle Bin, so it can be restored.
  ipcMain.handle('pluginRemove', async (_e, id) => {
    const p = loadPlugins(pluginDir()).find(x => x.id === id);
    if (p) await shell.trashItem(p.file);
    manager.applySettings({ disabledPlugins: offPlugins().filter(x => x !== id) });
    saveSettings(manager.settings);
    return pluginList();
  });
  ipcMain.handle('pluginToggle', (_e, id, enabled) => {
    const off = offPlugins().filter(x => x !== id);
    manager.applySettings({ disabledPlugins: enabled ? off : [...off, id] });
    saveSettings(manager.settings);
    return pluginList();
  });
  ipcMain.handle('openPluginsDir', () => {
    fs.mkdirSync(pluginDir(), { recursive: true });
    return shell.openPath(pluginDir());
  });
  ipcMain.handle('sourceCategories', async (_e, id) => (await pluginSource(id).categories?.()) || []);
  ipcMain.handle('sourceList', (_e, id, cat) => pluginSource(id).list(cat));
  ipcMain.handle('sourceResolve', (_e, id, picks) => pluginSource(id).resolve(picks));
  ipcMain.handle('feeds', () => feeds.state());
  ipcMain.handle('feedAdd', (_e, url, refreshMin) => feeds.addFeed(url, refreshMin));
  ipcMain.handle('feedUpdate', (_e, id, patch) => feeds.updateFeed(id, patch));
  ipcMain.handle('feedRemove', (_e, id) => feeds.removeFeed(id));
  ipcMain.handle('feedRefresh', (_e, id) => (id ? feeds.refresh(id) : Promise.all(feeds.feeds.map(f => feeds.refresh(f.id)))));
  ipcMain.handle('ruleSave', (_e, rule) => feeds.saveRule(rule));
  ipcMain.handle('ruleRemove', (_e, id) => feeds.removeRule(id));
  ipcMain.handle('rulePreview', (_e, rule) => feeds.preview(rule));
  ipcMain.handle('checkCached', async (_e, hashes) => {
    if (!manager.settings.torboxKey) return {};
    try {
      return await manager.provider('torbox').checkCached(hashes);
    } catch {
      return {};
    }
  });
  ipcMain.handle('registerMagnet', () => {
    const args = app.isPackaged ? [] : [path.resolve(process.argv[1] || '.')];
    return app.setAsDefaultProtocolClient('magnet', process.execPath, args);
  });
}

app.on('second-instance', (_e, argv) => grabFromArgs(argv));

app.whenReady().then(async () => {
  if (SETUP_MODE) return runSetupTools();
  const settings = loadSettings();
  tools = new ToolManager(TOOLS_DIR);
  hosters = new HosterRegistry(userFile('hosters.json'));
  hosters.refresh().catch(() => {});
  setInterval(() => hosters.refresh().catch(() => {}), 6 * 3600 * 1000);
  manager = new Manager({ statePath: userFile('downloads.json'), settings, items: loadItems(userFile('downloads.json')), hosters, tools });
  await manager.init();
  manager.on('limits', alt => win?.webContents.send('limits', alt));
  manager.on('extracted', (it, st) => win?.webContents.send('toast', { kind: 'ok', title: 'Extracted', text: path.basename(st.dest || it.name) }));
  manager.on('extractFailed', (it, st) => win?.webContents.send('toast', { kind: 'err', title: st.state === 'password' ? 'Archive needs a password' : 'Extraction failed', text: `${st.archive}: ${st.error}` }));
  manager.on('allDone', action => win?.webContents.send('allDone', action));
  manager.on('fallback', it =>
    win?.webContents.send('toast', {
      kind: 'info',
      title: `${manager.providerName(it.fallbackFrom)} failed, trying without it`,
      text: `${it.name}: ${it.kind === 'torrent' ? 'downloading by P2P' : 'downloading directly'}. (${it.fallbackReason})`,
    })
  );
  manager.on('scheduled', job => win?.webContents.send('toast', { kind: 'info', title: 'Scheduler', text: { start: 'Started downloads', pause: 'Paused downloads', 'turtle-on': 'Turtle mode on', 'turtle-off': 'Turtle mode off' }[job.action] }));

  // Browser extension + Click'n'Load. A token is generated on first run.
  if (!manager.settings.apiToken) {
    manager.settings.apiToken = crypto.randomBytes(18).toString('base64url');
    saveSettings(manager.settings);
  }
  localApi = new LocalApi({
    version: app.getVersion(),
    onLinks: (entries, meta) => {
      sendGrab(entries);
      if (meta.source === 'clicknload') win?.webContents.send('toast', { kind: 'info', title: "Click'n'Load", text: `${entries.length} link(s) from ${meta.page || 'a website'}` });
    },
    getState: () => ({ active: manager.snapshot().filter(i => i.status === 'active').length }),
  });
  await startApi();
  // RSS rules add matching articles straight to the download list.
  feeds = new FeedService({
    file: userFile('rss.json'),
    onDownload: async (article, rule) => {
      try {
        const link = article.magnet ? { source: article.magnet } : await resolveTorrentLink(article.torrentUrl || article.link);
        manager.add([{ kind: 'torrent', name: article.title, ...link, via: rule.via || undefined, category: rule.category, dir: rule.dir || undefined, rssRule: rule.name }]);
      } catch (e) {
        win?.webContents.send('toast', { kind: 'err', title: `RSS: couldn't add "${article.title}"`, text: e.message });
      }
    },
  });
  feeds.on('update', state => win?.webContents.send('feeds', state));
  feeds.on('grabbed', g => win?.webContents.send('toast', { kind: 'info', title: `RSS rule "${g.rule}" matched`, text: g.title }));
  // A minimized or hidden window gets no updates; it receives a fresh snapshot when shown again.
  const windowShown = () => win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  if (!process.env.HAKOBU_SHOT) manager.on('update', items => windowShown() && win.webContents.send('items', items));
  manager.on('completed', it => {
    if (Notification.isSupported()) new Notification({ title: 'Download complete', body: it.name }).show();
  });
  registerIpc();
  createWindow();
  // Keep yt-dlp (YouTube breaks old versions), Deno and ffmpeg current: check once a day, update in the background.
  const autoUpdateTools = async () => {
    if (!manager.settings.autoUpdateTools || !tools.ready()) return;
    if (Date.now() - (manager.settings.lastToolsCheck || 0) < 24 * 3600 * 1000) return;
    try {
      const r = await tools.update(p => win?.webContents.send('toolsProgress', p));
      manager.applySettings({ lastToolsCheck: Date.now() });
      saveSettings(manager.settings);
      if (r.updated.length) {
        const names = r.updated.map(n => `${r.status[n].label} ${r.status[n].version}`).join(', ');
        win?.webContents.send('toast', { kind: 'ok', title: 'Media tools updated', text: names });
      }
    } catch {}
  };
  setTimeout(autoUpdateTools, 15000);
  setInterval(autoUpdateTools, 3 * 3600 * 1000);
  lastClip = clipboard.readText();
  setInterval(pollClipboard, 1200);
  grabFromArgs(process.argv);
});

let quitting = false;
app.on('before-quit', async e => {
  if (quitting || !manager) return;
  e.preventDefault();
  quitting = true;
  try {
    feeds?.stop();
    await localApi?.stop();
    await manager.shutdown();
  } finally {
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
