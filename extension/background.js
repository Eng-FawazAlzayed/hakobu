// Hakobu browser extension: context menus, magnet capture and (optional) download capture.
const DEFAULTS = { port: 6464, token: '', captureDownloads: false, captureMinMB: 1, captureMagnets: true };

const settings = () => chrome.storage.sync.get(DEFAULTS);

async function api(path, body) {
  const s = await settings();
  const res = await fetch(`http://127.0.0.1:${s.port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Hakobu-Token': s.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error('Wrong token: copy it from Hakobu → Settings → Browser extension');
  if (!res.ok) throw new Error(`Hakobu replied ${res.status}`);
  return res.json();
}

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/128.png', title, message });
}

async function send(payload, label) {
  try {
    const r = await api('/api/add', payload);
    notify('Sent to Hakobu', r.added ? `${r.added} ${label} in LinkGrabber` : 'No links found');
    return r;
  } catch (e) {
    notify("Couldn't reach Hakobu", e.message.includes('fetch') ? 'Is Hakobu running?' : e.message);
    throw e;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'link', title: 'Download with Hakobu', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'selection', title: 'Send selected links to Hakobu', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'page', title: 'Send all links on this page to Hakobu', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'media', title: 'Download this media with Hakobu', contexts: ['video', 'audio', 'image'] });
  });
});

// All <a href> on the page plus magnets/URLs in its text.
async function pageLinks(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => [...new Set([...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => /^(https?|magnet):/i.test(h)))],
  });
  return result || [];
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const page = tab?.url;
  if (info.menuItemId === 'link') return send({ links: [info.linkUrl], page }, 'link');
  if (info.menuItemId === 'media') return send({ links: [info.srcUrl], page }, 'file');
  if (info.menuItemId === 'selection') return send({ text: info.selectionText, page }, 'links');
  if (info.menuItemId === 'page') return send({ links: await pageLinks(tab.id), page }, 'links');
});

// Magnet clicks reported by content.js.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'magnet') {
    send({ links: [msg.url], page: sender.tab?.url }, 'magnet').then(() => reply({ ok: true }), () => reply({ ok: false }));
    return true;
  }
  if (msg.type === 'ping') {
    api('/api/ping').then(r => reply({ ok: true, version: r.version }), e => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'sendPage') {
    pageLinks(msg.tabId).then(links => send({ links, page: msg.url }, 'links')).then(r => reply(r), e => reply({ error: e.message }));
    return true;
  }
});

// Optional: take over browser downloads (cookies + referrer go along so logged-in downloads work).
chrome.downloads.onCreated.addListener(async item => {
  const s = await settings();
  if (!s.captureDownloads || !/^https?:/i.test(item.finalUrl || item.url)) return;
  if (item.totalBytes > 0 && item.totalBytes < s.captureMinMB * 1024 * 1024) return;
  const url = item.finalUrl || item.url;
  try {
    await api('/api/ping');
  } catch {
    return; // Hakobu not running: let the browser handle it
  }
  await chrome.downloads.cancel(item.id).catch(() => {});
  chrome.downloads.erase({ id: item.id }).catch(() => {});
  const cookies = await chrome.cookies.getAll({ url }).catch(() => []);
  const filename = item.filename ? item.filename.split(/[\\/]/).pop() : undefined;
  send({ links: [url], referrer: item.referrer, cookie: cookies.map(c => `${c.name}=${c.value}`).join('; '), filename }, 'download').catch(() => {});
});
