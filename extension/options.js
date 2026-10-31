const $ = s => document.querySelector(s);
const DEFAULTS = { port: 6464, token: '', captureDownloads: false, captureMinMB: 1, captureMagnets: true };

chrome.storage.sync.get(DEFAULTS, s => {
  $('#port').value = s.port;
  $('#token').value = s.token;
  $('#captureDownloads').checked = s.captureDownloads;
  $('#captureMagnets').checked = s.captureMagnets;
  $('#captureMinMB').value = s.captureMinMB;
});

$('#save').addEventListener('click', () => {
  chrome.storage.sync.set(
    {
      port: Number($('#port').value) || 6464,
      token: $('#token').value.trim(),
      captureDownloads: $('#captureDownloads').checked,
      captureMagnets: $('#captureMagnets').checked,
      captureMinMB: Number($('#captureMinMB').value) || 0,
    },
    () =>
      chrome.runtime.sendMessage({ type: 'ping' }, r => {
        $('#result').textContent = r?.ok ? `✓ Connected to Hakobu ${r.version}` : `✕ ${r?.error || 'Hakobu is not running'}`;
        $('#result').className = r?.ok ? 'ok' : 'bad';
      })
  );
});
