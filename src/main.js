const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, safeStorage, Notification, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const { Manager, DEFAULT_SETTINGS, loadItems, readJsonSafe } = require('./engine/manager');
const { parseLinks } = require('./linkparse');
const { FeedService, search, loadPlugins, loadSearchPlugins, resolveTorrentLink } = require('./engine/feeds');
const { LocalApi } = require('./engine/api');
const { checkLinks, packageName } = require('./engine/linkcheck');
const { HosterRegistry } = require('./engine/hosters');
const { ToolManager } = require('./engine/tools');
const { mediaInfo } = require('./engine/media');
const { HOSTS } = require('./engine/resolvers');
const { HostWindows } = require('./hostwindow');
const { decryptDlc } = require('./engine/crawler');
const { execFile } = require('child_process');
const crypto = require('crypto');

const SECRET_KEYS = ['torboxKey', 'realdebridToken'];
const SECRET_JSON = ['hostAccounts', 'proxies']; // objects with passwords: stored as one encrypted JSON string each
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
let hostWindows = null;

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

// Files that were unreadable at start; their copies are kept and the user is told once the window is up.
const corruptFiles = [];

function loadSettings() {
  const raw = readJsonSafe(userFile('settings.json'), backup => corruptFiles.push(backup)) || {};
  for (const k of SECRET_KEYS) {
    if (typeof raw[k] === 'string' && raw[k].startsWith('enc:')) {
      try {
        raw[k] = safeStorage.decryptString(Buffer.from(raw[k].slice(4), 'base64'));
      } catch {
        raw[k] = '';
      }
    }
  }
  for (const k of SECRET_JSON) {
    if (typeof raw[k] !== 'string') continue;
    try {
      raw[k] = JSON.parse(raw[k].startsWith('enc:') ? safeStorage.decryptString(Buffer.from(raw[k].slice(4), 'base64')) : raw[k]);
    } catch {
      delete raw[k];
    }
  }
  return { ...DEFAULT_SETTINGS, downloadDir: app.getPath('downloads'), ...raw };
}

function saveSettings(settings) {
  const out = { ...settings };
  if (safeStorage.isEncryptionAvailable()) {
    for (const k of SECRET_KEYS) if (out[k]) out[k] = 'enc:' + safeStorage.encryptString(out[k]).toString('base64');
    for (const k of SECRET_JSON) if (out[k] && typeof out[k] === 'object') out[k] = 'enc:' + safeStorage.encryptString(JSON.stringify(out[k])).toString('base64');
  }
  // Write a temp file and rename it over the old one, so a crash or power cut mid-write can't leave half a file.
  const file = userFile('settings.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(out, null, 2));
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(file + '.tmp', file);
      return;
    } catch (e) {
      // Windows: antivirus or OneDrive can hold the file for a moment
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * i);
    }
  }
}

// ---------- link intake (magnet:// handler, .torrent files, clipboard) ----------

function grabFromArgs(argv) {
  const entries = [];
  for (const arg of argv.slice(1)) {
    if (/\.hakobu-plugin$/i.test(arg) && fs.existsSync(arg)) installPluginFile(arg);
    else if (/\.dlc$/i.test(arg) && fs.existsSync(arg)) openContainers([arg]);
    else if (/^magnet:/i.test(arg)) entries.push(...parseLinks(arg));
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

// DLC containers opened from disk (double-click, drop, Open with): their links go to LinkGrabber as one package.
async function openContainers(files) {
  let total = 0;
  for (const f of files) {
    try {
      const r = await decryptDlc(fs.readFileSync(f, 'utf8'));
      const entries = parseLinks(r.links.map(l => l.source).join('\n')).map(e => {
        const l = r.links.find(x => x.source === e.source);
        return { ...e, package: r.package, ...(l?.name ? { name: l.name } : {}), ...(r.passwords.length ? { archivePasswords: r.passwords } : {}) };
      });
      total += entries.length;
      sendGrab(entries);
    } catch (e) {
      const send = () => win?.webContents.send('toast', { kind: 'err', title: `Couldn't open ${path.basename(f)}`, text: e.message });
      if (win && !win.webContents.isLoading()) send();
      else app.whenReady().then(() => setTimeout(send, 2000));
    }
  }
  return total;
}

// "Needs browser": open the host's page in the default browser; the extension brings the real download back.
function openInBrowser(id) {
  const url = manager.browserOpened(id);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  shell.openExternal(url);
  return url;
}

// A double-clicked .hakobu-plugin file (a plugin's .js under its own extension): ask, then copy it into the plugins folder.
async function installPluginFile(file) {
  if (!win) return app.whenReady().then(() => setTimeout(() => installPluginFile(file), 1500));
  if (win.webContents.isLoading()) return win.webContents.once('did-finish-load', () => installPluginFile(file));
  if (win.isMinimized()) win.restore();
  win.focus();
  const id = path.basename(file).replace(/\.hakobu-plugin$/i, '');
  const exists = fs.existsSync(path.join(userFile('plugins'), id + '.js'));
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: [exists ? 'Update' : 'Install', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Install plugin',
    message: `${exists ? 'Update' : 'Install'} the plugin "${id}"?`,
    detail: "Plugins run with Hakobu's own rights, so only install ones from people you trust. You can switch it off or remove it any time in Settings → Plugin manager.",
  });
  if (response !== 0) return;
  fs.mkdirSync(userFile('plugins'), { recursive: true });
  fs.copyFileSync(file, path.join(userFile('plugins'), id + '.js'));
  win.webContents.send('pluginsChanged', id);
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
  win.on('closed', () => (win = null));
  win.webContents.on('did-finish-load', () => {
    if (pendingGrab.length) win.webContents.send('grab', pendingGrab.splice(0));
    for (const backup of corruptFiles.splice(0)) {
      win.webContents.send('toast', { kind: 'err', title: `${path.basename(backup).replace(/\.corrupt-.*$/, '')} was damaged`, text: `Hakobu started fresh and kept the old file as ${path.basename(backup)}.` });
    }
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
  ipcMain.handle('openContainers', (_e, files) => openContainers((Array.isArray(files) ? files : []).filter(f => /\.dlc$/i.test(f) && fs.existsSync(f))));
  ipcMain.handle('openUrl', (_e, url) => {
    if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url));
  });
  // Settings → Host accounts: the built-in hosts that take an account, and a login test.
  ipcMain.handle('hostModules', () =>
    HOSTS.filter(h => h.account).map(h => ({ id: h.id, name: h.name, free: !!h.free, fields: h.account.fields, help: h.account.help || '' }))
  );
  ipcMain.handle('accountTest', async (_e, id, account) => {
    const mod = HOSTS.find(h => h.id === id);
    if (!mod?.accountInfo) throw new Error('This host has no account check');
    return mod.accountInfo(account, { signal: AbortSignal.timeout(20000) });
  });
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
  ipcMain.handle('openInBrowser', (_e, ids) => ids.map(openInBrowser).filter(Boolean).length);
  ipcMain.handle('openHostWindow', (_e, id) => hostWindows?.open(id));
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
  ipcMain.handle('sources', () =>
    loadPlugins(pluginDir(), offPlugins())
      .filter(p => p.source)
      .map(({ id, name, source: s }) => ({
        id, title: s.title || name, icon: s.icon || '', categoryLabel: s.categoryLabel || '', artShape: s.artShape === 'portrait' ? 'portrait' : 'wide',
        searchable: typeof s.search === 'function', info: typeof s.info === 'function',
      }))
  );
  ipcMain.handle('sourceSearch', async (_e, id, q) => {
    const s = pluginSource(id);
    if (typeof s.search !== 'function') throw new Error("This source can't search");
    return s.search(String(q));
  });
  ipcMain.handle('sourceInfo', async (_e, id, row) => {
    const s = pluginSource(id);
    return typeof s.info === 'function' ? (await s.info(row)) || {} : {};
  });
  // Settings → Plugins: every .js in the folder, including turned-off and broken ones.
  const pluginList = () => {
    const off = offPlugins();
    const on = new Map(loadPlugins(pluginDir()).map(p => [p.id, p]));
    return [...on.values()].map(p => ({
      id: p.id, name: p.source?.title || p.name, description: p.description || '', version: p.version || '',
      search: !!p.search, source: !!p.source, error: p.error || null, enabled: !off.includes(p.id),
    }));
  };
  // Installing copies the file into the plugins folder (replacing an older copy with the same name).
  // A .hakobu-plugin file is the same .js under its own extension, so it can be shared and double-clicked.
  const PLUGIN_FILE = /\.(js|hakobu-plugin)$/i;
  const installPlugins = files => {
    fs.mkdirSync(pluginDir(), { recursive: true });
    for (const f of files.filter(f => PLUGIN_FILE.test(f) && fs.existsSync(f))) fs.copyFileSync(f, path.join(pluginDir(), path.basename(f).replace(PLUGIN_FILE, '.js')));
    return pluginList();
  };
  ipcMain.handle('plugins', pluginList);
  ipcMain.handle('pluginAdd', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Install a Hakobu plugin', filters: [{ name: 'Hakobu plugin', extensions: ['hakobu-plugin', 'js'] }], properties: ['openFile', 'multiSelections'] });
    return r.canceled ? pluginList() : installPlugins(r.filePaths);
  });
  ipcMain.handle('pluginShare', async (_e, id) => {
    const p = loadPlugins(pluginDir()).find(x => x.id === id);
    if (!p) return false;
    const r = await dialog.showSaveDialog(win, { title: 'Save plugin to share', defaultPath: path.join(app.getPath('desktop'), `${id}.hakobu-plugin`), filters: [{ name: 'Hakobu plugin', extensions: ['hakobu-plugin'] }] });
    if (r.canceled || !r.filePath) return false;
    fs.copyFileSync(p.file, r.filePath);
    shell.showItemInFolder(r.filePath);
    return true;
  });
  ipcMain.handle('pluginInstall', (_e, files) => installPlugins(Array.isArray(files) ? files : []));
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
  manager = new Manager({ statePath: userFile('downloads.json'), settings, items: loadItems(userFile('downloads.json'), backup => corruptFiles.push(backup)), hosters, tools });
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
  manager.on('hostWait', (it, why) => win?.webContents.send('toast', { kind: 'info', title: 'Host asked to wait', text: `${it.name}: ${why}` }));
  manager.on('mirror', (it, m) => win?.webContents.send('toast', { kind: 'info', title: `Switched to a mirror on ${m.to}`, text: `${it.name}: ${m.from} failed (${m.reason})` }));
  manager.on('hashBad', (it, why) => win?.webContents.send('toast', { kind: 'err', title: 'Damaged download', text: `${it.name}: ${why}` }));
  manager.on('scheduled', job => win?.webContents.send('toast', { kind: 'info', title: 'Scheduler', text: { start: 'Started downloads', pause: 'Paused downloads', 'turtle-on': 'Turtle mode on', 'turtle-off': 'Turtle mode off' }[job.action] }));

  // Browser extension + Click'n'Load. A token is generated on first run.
  if (!manager.settings.apiToken) {
    manager.settings.apiToken = crypto.randomBytes(18).toString('base64url');
    saveSettings(manager.settings);
  }
  localApi = new LocalApi({
    version: app.getVersion(),
    onLinks: (entries, meta) => {
      // A browser download from a page a "Needs browser" item is waiting on finishes that item instead.
      const waiting = meta.capture && entries.length === 1 && entries[0].kind === 'http' && manager.matchBrowserWait(meta.referrer, entries[0].source);
      if (waiting) {
        manager.browserHandoff(waiting.id, entries[0]);
        win?.webContents.send('toast', { kind: 'ok', title: 'Got it from the browser', text: waiting.name });
        return;
      }
      sendGrab(entries);
      if (meta.source === 'clicknload') win?.webContents.send('toast', { kind: 'info', title: "Click'n'Load", text: `${entries.length} link(s) from ${meta.page || 'a website'}` });
    },
    getState: () => ({ active: manager.snapshot().filter(i => i.status === 'active').length }),
    expecting: (referrer, url) => !!manager.matchBrowserWait(referrer, url),
  });
  await startApi();
  // Hosts with wait timers / captchas: optionally open the page in the browser right away (at most one every few seconds).
  let lastAutoOpen = 0;
  hostWindows = new HostWindows({
    manager,
    file: userFile('host-sessions.json'),
    onHandoff: it => win?.webContents.send('toast', { kind: 'ok', title: 'Got the download', text: it.name }),
  });
  manager.on('needsBrowser', it => {
    if (!manager.settings.autoOpenBrowser || Date.now() - lastAutoOpen < 4000) return;
    lastAutoOpen = Date.now();
    hostWindows.open(it.id);
  });
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
  // Never let a stuck torrent, socket or disk write keep Hakobu from closing.
  const cap = new Promise(r => setTimeout(r, 10000));
  try {
    feeds?.stop();
    await Promise.race([
      (async () => {
        await localApi?.stop();
        await manager.shutdown();
      })(),
      cap,
    ]);
  } catch (e) {
    console.error('[quit]', e.message);
  } finally {
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
