const $ = s => document.querySelector(s);

chrome.runtime.sendMessage({ type: 'ping' }, r => {
  $('#status').textContent = r?.ok ? `Connected · v${r.version}` : r?.error?.includes('token') ? 'Wrong token, open Settings' : 'Hakobu is not running';
  $('#status').className = r?.ok ? 'ok' : 'bad';
});

chrome.storage.sync.get({ captureDownloads: false, captureMagnets: true }, s => {
  $('#captureDownloads').checked = s.captureDownloads;
  $('#captureMagnets').checked = s.captureMagnets;
});
for (const id of ['captureDownloads', 'captureMagnets']) {
  $('#' + id).addEventListener('change', e => chrome.storage.sync.set({ [id]: e.target.checked }));
}

$('#sendPage').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('#sendPage').textContent = 'Sending…';
  chrome.runtime.sendMessage({ type: 'sendPage', tabId: tab.id, url: tab.url }, r => {
    $('#sendPage').textContent = r?.added != null ? `Sent ${r.added} link(s)` : 'Failed';
    setTimeout(() => window.close(), 900);
  });
});
