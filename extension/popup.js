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

// YouTube sign-in: goes only to Hakobu on this PC, and only while this is on.
function shareResult(r) {
  $('#shareYoutubeState').textContent = !r?.ok ? r?.error?.includes('fetch') ? 'Hakobu is not running' : r?.error || 'Failed' : r.signedIn ? 'Hakobu is using your sign-in' : 'Sign in to YouTube in this browser first';
  return !!r?.ok && !!r.signedIn;
}
chrome.storage.sync.get({ shareYoutube: false }, s => {
  $('#shareYoutube').checked = s.shareYoutube;
  if (s.shareYoutube) chrome.runtime.sendMessage({ type: 'shareYoutube' }, shareResult);
});
$('#shareYoutube').addEventListener('change', e => {
  const on = e.target.checked;
  chrome.runtime.sendMessage({ type: 'shareYoutube', manual: on, forget: !on }, r => {
    if (!on) {
      chrome.storage.sync.set({ shareYoutube: false });
      $('#shareYoutubeState').textContent = r?.ok ? 'Hakobu forgot your sign-in' : 'Hakobu is not running, so it still has your sign-in';
      return;
    }
    const good = shareResult(r);
    e.target.checked = good;
    chrome.storage.sync.set({ shareYoutube: good });
  });
});

$('#sendPage').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('#sendPage').textContent = 'Sending…';
  chrome.runtime.sendMessage({ type: 'sendPage', tabId: tab.id, url: tab.url }, r => {
    $('#sendPage').textContent = r?.added != null ? `Sent ${r.added} link(s)` : 'Failed';
    setTimeout(() => window.close(), 900);
  });
});
