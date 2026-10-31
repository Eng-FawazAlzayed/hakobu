/* global api */
document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
const row = name => document.querySelector(`.tool[data-tool="${name}"]`);

api.onToolsProgress(p => {
  const el = row(p.tool);
  if (!el) return;
  el.className = 'tool ' + (p.step === 'done' ? 'done' : p.step === 'error' ? 'error' : 'active');
  el.querySelector('.bar > i').style.width = Math.round((p.fraction || 0) * 100) + '%';
  el.querySelector('span').textContent =
    p.step === 'downloading' ? `${Math.round((p.fraction || 0) * 100)}%`
    : p.step === 'verifying' ? 'checking…'
    : p.step === 'done' ? `✓ ${p.version}`
    : `✕ ${p.error}`;
});

api.onToolsDone(r => {
  document.getElementById('foot').textContent = r.failed
    ? "Some tools couldn't be downloaded. Hakobu will try again when it starts; everything else works."
    : 'All set. Starting Hakobu…';
});
