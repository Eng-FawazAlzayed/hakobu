/* global api, icon, $, $$, esc, bytes, settings, toast, addToGrabber, catOptions */
// Search (Torznab via Jackett / Prowlarr) and RSS (feeds + auto-download rules) views.

const ago = ts => {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

// A search result or RSS article -> LinkGrabber entry (opens the torrent dialog).
async function grabArticle(a, extra = {}) {
  try {
    const link = a.magnet ? { source: a.magnet } : await api.resolveLink(a.torrentUrl || a.link);
    addToGrabber([{ kind: 'torrent', name: a.title, infoHash: a.infoHash || undefined, size: a.size || undefined, ...link, ...extra }]);
  } catch (e) {
    toast('err', "Couldn't fetch that torrent", String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  }
}

// ================= Search =================
let results = [];

function renderResults() {
  const min = Number($('#searchMinSeeds').value) || 0;
  const q = $('#searchFilter').value.trim().toLowerCase();
  const list = results.filter(r => (r.seeders ?? 0) >= min && (!q || r.title.toLowerCase().includes(q)));
  $('#searchResults').innerHTML = list
    .slice(0, 500)
    .map((r, i) => {
      const health = r.seeders == null ? '' : r.seeders >= 50 ? 'good' : r.seeders >= 5 ? 'ok' : 'bad';
      return `<div class="row result" data-i="${results.indexOf(r)}" style="animation-delay:${Math.min(i, 15) * 18}ms">
        <div class="type t-p2p">${icon('magnet')}</div>
        <div class="body"><div class="title"><span class="name" title="${esc(r.title)}">${esc(r.title)}</span></div>
          <div class="meta"><span>${bytes(r.size)}</span><span>${esc(r.provider)}</span>${r.date ? `<span>${ago(r.date)}</span>` : ''}</div></div>
        <div class="side">
          ${r.seeders != null ? `<span class="seeds ${health}" title="Seeders / leechers">▲ ${r.seeders}<small> / ${Math.max(0, (r.peers ?? r.seeders) - r.seeders)}</small></span>` : ''}
          <button class="btn primary sm" data-get>${icon('download')}Get</button>
        </div></div>`;
    })
    .join('');
  $('#searchEmpty').classList.toggle('hidden', results.length > 0);
}

$('#searchForm').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('#searchQ').value.trim();
  if (!q) return;
  $('#searchInfo').innerHTML = '<span class="spinner sm"></span> Searching…';
  results = [];
  renderResults();
  try {
    const res = await api.search(q);
    results = res.items;
    $('#searchInfo').textContent = `${results.length} results${res.errors.length ? ` · ${res.errors.length} provider(s) failed` : ''}`;
    if (res.errors.length) toast('err', 'Some providers failed', res.errors.join(' · '));
  } catch (err) {
    $('#searchInfo').textContent = '';
    toast('err', 'Search failed', String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  }
  renderResults();
});
$('#searchMinSeeds').addEventListener('input', renderResults);
$('#searchFilter').addEventListener('input', renderResults);
$('#searchResults').addEventListener('click', e => {
  const row = e.target.closest('.result');
  if (row && e.target.closest('[data-get]')) grabArticle(results[row.dataset.i]);
});

// ================= RSS =================
let rss = { feeds: [], rules: [] };
let rssSel = { type: 'all' };
let previewTimer = null;

function unread() {
  return rss.feeds.reduce((a, f) => a + (f.articles || []).filter(x => x.isNew).length, 0);
}

function renderRssSide() {
  const n = unread();
  $('#rssCount').textContent = n;
  $('#rssCount').classList.toggle('hidden', !n);
  const all = rss.feeds.reduce((a, f) => a + (f.articles || []).length, 0);
  $('#feedList').innerHTML =
    `<button class="rss-item ${rssSel.type === 'all' ? 'on' : ''}" data-all>${icon('layers')}<span class="grow ell">All articles</span><b>${all || ''}</b></button>` +
    rss.feeds
      .map(f => {
        const fresh = (f.articles || []).filter(a => a.isNew).length;
        return `<button class="rss-item ${rssSel.type === 'feed' && rssSel.id === f.id ? 'on' : ''}" data-feed="${f.id}">
          ${f.loading ? '<span class="spinner sm"></span>' : f.error ? `<span class="st-err" title="${esc(f.error)}">${icon('alert')}</span>` : icon('rss')}
          <span class="grow ell" title="${esc(f.url)}">${esc(f.name)}</span><b class="${fresh ? 'new' : ''}">${fresh || (f.articles || []).length || ''}</b></button>`;
      })
      .join('');
  $('#ruleList').innerHTML = rss.rules.length
    ? rss.rules
        .map(r => `<button class="rss-item ${rssSel.type === 'rule' && rssSel.id === r.id ? 'on' : ''}" data-rule="${r.id}">
          <span class="dot" style="background:${r.enabled ? 'var(--green)' : 'var(--text-3)'}"></span><span class="grow ell">${esc(r.name || 'Untitled rule')}</span></button>`)
        .join('')
    : '<p class="muted pad">Rules download matching articles automatically, like qBittorrent.</p>';
}

function articleRow(a, feedName, i) {
  return `<div class="row article ${a.isNew ? 'is-new' : ''}" data-guid="${esc(a.guid)}" style="animation-delay:${Math.min(i, 15) * 15}ms">
    <div class="body"><div class="title">${a.isNew ? '<span class="tag tag-cached">NEW</span>' : ''}<span class="name" title="${esc(a.title)}">${esc(a.title)}</span></div>
      <div class="meta">${feedName ? `<span>${esc(feedName)}</span>` : ''}${a.size ? `<span>${bytes(a.size)}</span>` : ''}${a.date ? `<span>${ago(a.date)}</span>` : ''}${a.seeders != null ? `<span>▲ ${a.seeders}</span>` : ''}</div></div>
    <div class="side"><button class="btn ghost sm" data-get>${icon('download')}Get</button></div></div>`;
}

function renderRssMain() {
  const main = $('#rssMain');
  if (rssSel.type === 'rule') return renderRuleEditor();
  let feedsShown = rss.feeds;
  let head = `<div class="rss-head big"><h3>All articles</h3><span class="grow"></span></div>`;
  if (rssSel.type === 'feed') {
    const f = rss.feeds.find(x => x.id === rssSel.id);
    if (!f) {
      rssSel = { type: 'all' };
      return renderRssMain();
    }
    feedsShown = [f];
    head = `<div class="rss-head big"><div class="grow" style="min-width:0"><h3 class="ell">${esc(f.name)}</h3><div class="meta"><span class="ell">${esc(f.url)}</span>${f.lastFetched ? `<span>updated ${ago(f.lastFetched)}</span>` : ''}${f.error ? `<span class="err">${esc(f.error)}</span>` : ''}</div></div>
      <label class="field inline"><span>Every</span><select id="feedEvery">${[5, 15, 30, 60, 180, 720].map(m => `<option value="${m}" ${f.refreshMin === m ? 'selected' : ''}>${m < 60 ? m + ' min' : m / 60 + ' h'}</option>`).join('')}</select></label>
      <button class="btn ghost sq" id="feedRefresh" title="Refresh">${icon('refresh')}</button><button class="btn ghost sq danger" id="feedDelete" title="Remove feed">${icon('trash')}</button></div>`;
  }
  const arts = feedsShown
    .flatMap(f => (f.articles || []).map(a => ({ a, feed: f.name })))
    .sort((x, y) => (y.a.date || 0) - (x.a.date || 0))
    .slice(0, 400);
  main.innerHTML =
    head +
    (arts.length
      ? `<div class="list art-list">${arts.map(({ a, feed }, i) => articleRow(a, rssSel.type === 'all' ? feed : '', i)).join('')}</div>`
      : `<div class="empty small" style="position:relative;inset:auto;flex:1"><div class="empty-art">${icon('rss')}</div><h2>${rss.feeds.length ? 'No articles yet' : 'Add your first feed'}</h2><p>Paste an RSS or Atom URL on the left. Torrent sites, Nyaa, showRSS, and Jackett/Prowlarr feeds all work.</p></div>`);
}

function renderRuleEditor() {
  const r = rss.rules.find(x => x.id === rssSel.id) || rssSel.draft;
  if (!r) return;
  $('#rssMain').innerHTML = `<form class="rule" id="ruleForm">
    <div class="rss-head big"><h3>${r.id ? 'Edit rule' : 'New rule'}</h3><span class="grow"></span>
      <label class="switch"><input type="checkbox" name="enabled" ${r.enabled !== false ? 'checked' : ''} /><i></i>Enabled</label></div>
    <div class="rule-grid">
      <label class="field"><span>Rule name</span><input name="name" value="${esc(r.name || '')}" placeholder="e.g. My show 1080p" required /></label>
      <label class="switch" style="align-self:end;height:36px"><input type="checkbox" name="useRegex" ${r.useRegex ? 'checked' : ''} /><i></i>Use regular expressions</label>
      <label class="field"><span>Must contain <em>space = AND · | = OR · * wildcard</em></span><input name="mustContain" value="${esc(r.mustContain || '')}" placeholder="show name 1080p" /></label>
      <label class="field"><span>Must not contain</span><input name="mustNotContain" value="${esc(r.mustNotContain || '')}" placeholder="720p | cam" /></label>
      <label class="field"><span>Category</span><select name="category">${catOptions(r.category || '')}</select></label>
      <label class="field"><span>Download via</span><select name="via">
        ${[['', 'Default route'], ['p2p', 'P2P on this PC'], ['torbox', 'TorBox'], ['realdebrid', 'Real-Debrid']].map(([v, l]) => `<option value="${v}" ${(r.via || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field span2"><span>Save to <em>blank = category or default folder</em></span><input name="dir" value="${esc(r.dir || '')}" /></label>
    </div>
    <div class="field"><span>Apply to feeds <em>none ticked = all feeds</em></span>
      <div class="chips">${rss.feeds.map(f => `<label class="chipbox"><input type="checkbox" name="feed" value="${f.id}" ${(r.feedIds || []).includes(f.id) ? 'checked' : ''} /><span>${esc(f.name)}</span></label>`).join('') || '<span class="muted">No feeds yet</span>'}</div></div>
    <div class="field grow"><span>Matching articles <em id="previewCount"></em></span><div class="preview" id="rulePreview"></div></div>
    <div class="hrow end">${r.id ? `<button type="button" class="btn ghost danger" id="ruleDelete">${icon('trash')}Delete</button>` : ''}<button class="btn primary">${icon('check')}Save rule</button></div>
  </form>`;
  updatePreview();
}

function ruleFromForm() {
  const fd = new FormData($('#ruleForm'));
  const base = rss.rules.find(x => x.id === rssSel.id) || rssSel.draft || {};
  return {
    ...base,
    name: String(fd.get('name') || '').trim(),
    enabled: fd.get('enabled') === 'on',
    useRegex: fd.get('useRegex') === 'on',
    mustContain: String(fd.get('mustContain') || ''),
    mustNotContain: String(fd.get('mustNotContain') || ''),
    category: fd.get('category') || '',
    via: fd.get('via') || '',
    dir: String(fd.get('dir') || '').trim(),
    feedIds: fd.getAll('feed'),
  };
}

async function updatePreview() {
  if (!$('#ruleForm')) return;
  const list = await api.rulePreview(ruleFromForm());
  if (!$('#rulePreview')) return;
  $('#previewCount').textContent = list.length ? `${list.length}${list.length === 50 ? '+' : ''} match` : 'none yet';
  $('#rulePreview').innerHTML = list.map(t => `<div>${icon('check')}<span class="ell">${esc(t)}</span></div>`).join('') || '<p class="muted">Type a pattern to see which current articles it would grab.</p>';
}

$('#rssMain').addEventListener('input', e => {
  if (!e.target.closest('#ruleForm')) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, 250);
});
$('#rssMain').addEventListener('change', e => {
  if (e.target.closest('#ruleForm')) updatePreview();
  if (e.target.id === 'feedEvery') api.feedUpdate(rssSel.id, { refreshMin: Number(e.target.value) });
});
$('#rssMain').addEventListener('submit', async e => {
  e.preventDefault();
  const r = ruleFromForm();
  if (!r.mustContain.trim()) return toast('err', 'Add a "Must contain" pattern', 'Use * to match everything.');
  const saved = await api.ruleSave(r);
  rssSel = { type: 'rule', id: saved.id };
  toast('ok', 'Rule saved', `"${saved.name}" will grab new matches automatically`);
});
$('#rssMain').addEventListener('click', async e => {
  if (e.target.closest('#ruleDelete')) {
    await api.ruleRemove(rssSel.id);
    rssSel = { type: 'all' };
    return;
  }
  if (e.target.closest('#feedRefresh')) return api.feedRefresh(rssSel.id);
  if (e.target.closest('#feedDelete')) {
    if (await confirmModal('Remove feed?', 'Its articles disappear; rules stay.')) api.feedRemove(rssSel.id);
    return;
  }
  const art = e.target.closest('.article');
  if (art && e.target.closest('[data-get]')) {
    const a = rss.feeds.flatMap(f => f.articles || []).find(x => x.guid === art.dataset.guid);
    if (a) grabArticle(a);
  }
});

function selectRss(sel) {
  rssSel = sel;
  if (sel.type === 'feed') {
    const f = rss.feeds.find(x => x.id === sel.id);
    if (f?.articles?.some(a => a.isNew)) api.feedUpdate(f.id, { articles: f.articles.map(a => ({ ...a, isNew: false })) });
  }
  renderRssSide();
  renderRssMain();
}
$('#feedList').addEventListener('click', e => {
  const b = e.target.closest('.rss-item');
  if (!b) return;
  selectRss(b.dataset.feed ? { type: 'feed', id: b.dataset.feed } : { type: 'all' });
});
$('#ruleList').addEventListener('click', e => {
  const b = e.target.closest('.rss-item');
  if (b) selectRss({ type: 'rule', id: b.dataset.rule });
});
$('#ruleNew').addEventListener('click', () => selectRss({ type: 'rule', id: null, draft: { name: '', enabled: true, feedIds: [] } }));
$('#feedAddForm').addEventListener('submit', async e => {
  e.preventDefault();
  const url = $('#feedUrl').value.trim();
  if (!/^https?:\/\//i.test(url)) return toast('err', 'Enter a feed URL', 'It starts with http:// or https://');
  $('#feedUrl').value = '';
  const f = await api.feedAdd(url, 30);
  selectRss({ type: 'feed', id: f.id });
});
$('#feedRefreshAll').addEventListener('click', () => api.feedRefresh(null));

api.onFeeds(state => {
  rss = state;
  renderRssSide();
  const editing = rssSel.type === 'rule' && document.activeElement?.closest?.('#ruleForm');
  if (!editing && !$('#view-rss').classList.contains('hidden')) renderRssMain();
});
api.feeds().then(state => {
  rss = state;
  renderRssSide();
  renderRssMain();
});
window.onViewShown = name => {
  if (name === 'rss') renderRssMain();
  if (name === 'search') setTimeout(() => $('#searchQ').focus(), 50);
};
