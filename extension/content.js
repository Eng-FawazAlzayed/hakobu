// Catch clicks on magnet links and hand them to Hakobu instead of the OS handler.
document.addEventListener(
  'click',
  e => {
    const a = e.target.closest?.('a[href^="magnet:"]');
    if (!a || e.defaultPrevented || e.button !== 0) return;
    chrome.storage.sync.get({ captureMagnets: true }, s => {
      if (!s.captureMagnets) return location.assign(a.href);
      chrome.runtime.sendMessage({ type: 'magnet', url: a.href }, r => {
        if (!r?.ok) location.assign(a.href); // Hakobu unreachable: fall back to the normal handler
      });
    });
    e.preventDefault();
    e.stopPropagation();
  },
  true
);
