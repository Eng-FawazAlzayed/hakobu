/* global api, icon, hydrateIcons */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

let items = [];
let settings = {};
let filter = 'all';
let selected = new Set();
let grab = [];
const rowEls = new Map(); // id -> row element (kept between updates so CSS transitions run smoothly)
const lastStatus = new Map();
const history = []; // [down, up] samples for the sparkline

const PROVIDER = { torbox: 'TorBox', realdebrid: 'Real-Debrid' };
const TYPE_ICON = { direct: 'globe', p2p: 'magnet', torbox: 'cloud', realdebrid: 'cloud', ytdlp: 'youtube' };
const mediaLabel = it => (it.mediaFormat === 'mp3' ? `MP3 ${it.mediaQuality || ''}k` : `MP4 ${it.mediaQuality === 'best' ? 'best' : (it.mediaQuality || '') + 'p'}`);
const VIEW_TITLE = { downloads: 'Downloads', grabber: 'LinkGrabber', search: 'Search', rss: 'RSS', settings: 'Settings', source: '' };
let detailTab = 'general';
let detailKey = '';
let limitsAlt = false;

// ---------- formatting ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function bytes(n) {
  if (n == null || isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${n.toFixed(i && n < 100 ? 1 : 0)} ${u[i]}`;
}
const speed = n => bytes(n || 0) + '/s';
function duration(s) {
  if (!isFinite(s) || s > 86400 * 7) return '∞';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}

// Normalised view of an item (a debrid job that handed off shows its child downloads' totals).
function view(it) {
  if (it.status === 'handed-off') {
    const kids = items.filter(c => c.parentId === it.id);
    const size = kids.reduce((a, c) => a + (c.size || 0), 0);
    const downloaded = kids.reduce((a, c) => a + (c.downloaded || 0), 0);
    const done = kids.length > 0 && kids.every(c => c.status === 'completed');
    const err = kids.some(c => c.status === 'error');
    return {
      size, downloaded, speed: kids.reduce((a, c) => a + (c.speed || 0), 0),
      progress: size ? downloaded / size : done ? 1 : 0,
      group: done ? 'completed' : err ? 'error' : 'downloading',
      label: done ? 'Completed' : err ? 'A file failed' : `Fetching ${kids.length} file${kids.length === 1 ? '' : 's'}`,
      cls: done ? 'completed' : err ? 'error' : 'active',
    };
  }
  const map = {
    queued: ['downloading', 'Queued', 'queued'],
    active: ['downloading', it.kind === 'media' ? it.stage || 'Downloading' : it.via === 'p2p' && !it.size ? 'Finding metadata' : 'Downloading', 'active'],
    resolving: ['downloading', `${PROVIDER[it.via]} · ${it.remote?.state || 'submitting'}`, 'resolving'],
    seeding: ['seeding', 'Seeding', 'seeding'],
    completed: ['completed', 'Completed', 'completed'],
    paused: ['paused', 'Paused', 'paused'],
    error: ['error', 'Error', 'error'],
    retrying: ['downloading', 'Retrying soon', 'paused'],
  };
  const [group, label, cls] = map[it.status] || ['paused', it.status, 'paused'];
  return { size: it.size, downloaded: it.downloaded, speed: it.speed, progress: it.progress || 0, group, label, cls };
}

function matches(it, f = filter) {
  switch (f) {
    case 'all': return true;
    case 'direct': return it.via === 'direct';
    case 'p2p': return it.via === 'p2p';
    case 'debrid': return it.via === 'torbox' || it.via === 'realdebrid' || !!it.parentId;
    case 'nocat': return !it.category;
    case 'media': return it.kind === 'media';
    default:
      if (f.startsWith('cat:')) return it.category === f.slice(4);
      if (f.startsWith('tag:')) return (it.tags || []).includes(f.slice(4));
      return view(it).group === f;
  }
}

function metaLine(it, v) {
  const parts = [];
  if (it.status === 'error') return `<span class="err" title="${esc(it.error)}">${esc(it.error)}</span>`;
  if (v.size) parts.push(v.group === 'completed' || v.group === 'seeding' ? bytes(v.size) : `${bytes(v.downloaded)} of ${bytes(v.size)}`);
  else if (v.downloaded) parts.push(bytes(v.downloaded));
  if (v.group === 'downloading' && v.speed > 0) {
    parts.push(`<span class="sp">↓ ${speed(v.speed)}</span>`);
    if (v.size) parts.push(`${duration((v.size - v.downloaded) / v.speed)} left`);
  }
  if (it.via === 'p2p' && (it.status === 'active' || it.status === 'seeding')) {
    if (it.upSpeed > 0) parts.push(`<span class="sp">↑ ${speed(it.upSpeed)}</span>`);
    parts.push(`${it.peers || 0} peers`);
  }
  if (it.via === 'p2p' && it.ratio) parts.push(`ratio ${it.ratio.toFixed(2)}`);
  if (it.remote?.seeders != null && it.status === 'resolving') parts.push(`${it.remote.seeders} seeders (cloud)`);
  if (it.parentId) parts.push('via debrid');
  if (it.rssRule) parts.push(`RSS · ${esc(it.rssRule)}`);
  if (it.kind === 'media') {
    parts.unshift(`<span>${mediaLabel(it)}</span>`);
    if (it.uploader) parts.push(esc(it.uploader));
    if (it.playlistCount) parts.push(`playlist · ${it.playlistIndex || 0} of ${it.playlistCount}`);
  }
  if (it.fallbackFrom) parts.push(`<span class="xchip x-error" title="${esc(it.fallbackReason || '')}">↩ ${PROVIDER[it.fallbackFrom] || it.fallbackFrom} failed, no debrid now</span>`);
  const x = it.extract;
  if (x) {
    const label = { queued: 'extract queued', extracting: `extracting ${Math.round((x.progress || 0) * 100)}%`, done: 'extracted', password: 'needs password', error: 'extract failed' }[x.state];
    parts.push(`<span class="xchip x-${x.state}" title="${esc(x.error || x.dest || '')}">${icon('archive')}${label}</span>`);
  }
  let out = parts.map(p => `<span>${p}</span>`).join('');
  if (it.category) out += `<span class="pill-cat">${esc(it.category)}</span>`;
  for (const t of it.tags || []) out += `<span class="pill-tag">#${esc(t)}</span>`;
  return out;
}

// ---------- downloads list (keyed, patched in place) ----------
function createRow(it) {
  const el = document.createElement('div');
  el.className = 'row';
  el.dataset.id = it.id;
  const type = it.parentId ? 'direct' : it.via;
  el.innerHTML = `
    <div class="type t-${type}${it.thumbnail ? ' thumb' : ''}"${it.thumbnail ? ` style="background-image:url('${esc(it.thumbnail)}')"` : ''}>${it.thumbnail ? '' : icon(TYPE_ICON[type])}<span class="ring"></span></div>
    <div class="body">
      <div class="title">${it.package ? `<span class="pkg">${esc(it.package)} ›</span>` : ''}<span class="name"></span></div>
      <div class="bar"><i></i></div>
      <div class="meta"></div>
    </div>
    <div class="side">
      <span class="status"></span>
      <span class="pct"></span>
      <div class="quick">
        <button data-q="toggle"></button>
        <button data-q="open" title="Show in folder">${icon('folder')}</button>
        <button data-q="remove" title="Remove">${icon('x')}</button>
      </div>
    </div>`;
  return el;
}

function patchRow(el, it) {
  const v = view(it);
  const pct = Math.min(100, v.progress * 100);
  const active = it.status === 'active' || it.status === 'resolving' || (it.status === 'handed-off' && v.group === 'downloading');
  el.className = `row c-${v.cls}${active ? ' is-active' : ''}${selected.has(it.id) ? ' sel' : ''}${it.status === 'active' && it.via === 'p2p' && !it.size ? ' indeterminate' : ''}`;
  const name = el.querySelector('.name');
  if (name.textContent !== it.name) {
    name.textContent = it.name;
    name.title = it.name;
  }
  el.querySelector('.bar > i').style.width = pct + '%';
  el.querySelector('.meta').innerHTML = metaLine(it, v);
  const st = el.querySelector('.status');
  st.textContent = v.label;
  st.title = it.error || v.label;
  el.querySelector('.pct').textContent = v.group === 'completed' ? '' : pct.toFixed(pct < 10 ? 1 : 0) + '%';
  const canPause = ['active', 'queued', 'resolving', 'seeding', 'retrying'].includes(it.status);
  const toggle = el.querySelector('[data-q="toggle"]');
  const want = canPause ? 'pause' : 'play';
  if (toggle.dataset.icon !== want) {
    toggle.dataset.icon = want;
    toggle.innerHTML = icon(want);
    toggle.title = canPause ? 'Pause' : 'Resume';
  }
}

function render() {
  const q = $('#search').value.trim().toLowerCase();
  const list = items
    .filter(it => matches(it))
    .filter(it => !q || (it.name || '').toLowerCase().includes(q) || (it.package || '').toLowerCase().includes(q))
    .sort((a, b) => a.createdAt - b.createdAt);

  const container = $('#list');
  const nodes = groupPkgs ? groupedNodes(list) : list.map(it => ({ it }));
  const keep = new Set(list.map(i => i.id));
  for (const [k, el] of pkgEls) {
    if (!nodes.some(n => n.pkg === k)) {
      el.remove();
      pkgEls.delete(k);
    }
  }
  for (const [id, el] of rowEls) {
    if (!keep.has(id) && !el.classList.contains('leaving')) {
      el.classList.add('leaving');
      el.addEventListener('animationend', () => el.remove(), { once: true });
      rowEls.delete(id);
    }
  }
  let prev = null;
  nodes.forEach((node, i) => {
    if (node.pkg) {
      let h = pkgEls.get(node.pkg);
      if (!h) {
        h = document.createElement('div');
        h.className = 'dl-pkg';
        h.dataset.pkg = node.pkg;
        pkgEls.set(node.pkg, h);
      }
      patchPkgHead(h, node);
      const anchor = prev ? prev.nextSibling : container.firstChild;
      if (anchor !== h) container.insertBefore(h, anchor);
      prev = h;
      return;
    }
    const it = node.it;
    if (node.hidden) {
      rowEls.get(it.id)?.remove();
      rowEls.delete(it.id);
      return;
    }
    let el = rowEls.get(it.id);
    if (!el) {
      el = createRow(it);
      el.style.animationDelay = Math.min(i, 12) * 28 + 'ms';
      rowEls.set(it.id, el);
    }
    patchRow(el, it);
    if (node.child) el.classList.add('child');
    const anchor = prev ? prev.nextSibling : container.firstChild;
    if (anchor !== el) container.insertBefore(el, anchor);
    prev = el;
  });
  $('#empty').classList.toggle('hidden', items.length > 0);

  renderCatFilters();
  for (const b of $$('#filters button[data-filter]')) b.querySelector('b').textContent = items.filter(it => matches(it, b.dataset.filter)).length || '';

  const n = [...selected].filter(id => items.some(i => i.id === id)).length;
  $('#actionbar').classList.toggle('has-sel', n > 0);
  $('#selInfo').textContent = n ? `${n} selected` : `${items.length} download${items.length === 1 ? '' : 's'}`;

  const deb = [settings.torboxKey && 'TorBox', settings.realdebridToken && 'Real-Debrid'].filter(Boolean);
  $('#stDebrid').innerHTML = deb.length ? deb.map(d => `<span class="chip" style="color:var(--green)">${d}</span>`).join('') : '<span class="chip">No debrid connected</span>';
  renderDetails();
}

let catKey = '';
function renderCatFilters() {
  const cats = [...new Set([...Object.keys(settings.categories || {}), ...items.map(i => i.category).filter(Boolean)])].sort();
  const tags = [...new Set(items.flatMap(i => i.tags || []))].sort();
  const key = JSON.stringify([cats, tags, filter]);
  if (key === catKey) return;
  catKey = key;
  const btn = (f, ico, label) => `<button data-filter="${esc(f)}" class="${filter === f ? 'active' : ''}">${icon(ico)}<span>${esc(label)}</span><b></b></button>`;
  $('#catFilters').innerHTML =
    (cats.length ? '<div class="label">Categories</div>' + cats.map(c => btn('cat:' + c, 'tag', c)).join('') + btn('nocat', 'tag', 'Uncategorized') : '') +
    (tags.length ? '<div class="label">Tags</div>' + tags.map(t => btn('tag:' + t, 'layers', '#' + t)).join('') : '');
  requestAnimationFrame(() => moveIndicator('#filters'));
}

// ---------- package grouping in the download list ----------
let groupPkgs = false;
try {
  groupPkgs = localStorage.getItem('groupPkgs') === '1';
} catch {}
const pkgEls = new Map();
const collapsedDl = new Set();

function groupedNodes(list) {
  const counts = {};
  for (const it of list) if (it.package) counts[it.package] = (counts[it.package] || 0) + 1;
  const out = [];
  const seen = new Set();
  for (const it of list) {
    const p = it.package;
    if (p && counts[p] > 1) {
      if (seen.has(p)) continue;
      seen.add(p);
      const members = list.filter(x => x.package === p);
      out.push({ pkg: p, members });
      for (const m of members) out.push({ it: m, hidden: collapsedDl.has(p), child: true });
    } else out.push({ it });
  }
  return out;
}

function patchPkgHead(h, { pkg, members }) {
  const size = members.reduce((a, m) => a + (view(m).size || 0), 0);
  const got = members.reduce((a, m) => a + (view(m).downloaded || 0), 0);
  const spd = members.reduce((a, m) => a + (m.status === 'active' ? m.speed || 0 : 0), 0);
  const done = members.filter(m => m.status === 'completed').length;
  const pct = size ? (got / size) * 100 : done === members.length ? 100 : 0;
  const x = members.find(m => m.extract)?.extract;
  h.classList.toggle('collapsed', collapsedDl.has(pkg));
  h.classList.toggle('is-active', spd > 0);
  h.innerHTML = `<span class="twisty">${icon('chevron')}</span>${icon('archive', 'pkg-ico')}
    <span class="pkg-name">${esc(pkg)}</span>
    <span class="pkg-meta">${done}/${members.length} files · ${bytes(size)}${spd ? ' · ↓ ' + speed(spd) : ''}${x ? ' · ' + ({ extracting: 'extracting', done: 'extracted', password: 'needs password', error: 'extract failed', queued: 'extract queued' }[x.state] || '') : ''}</span>
    <div class="bar"><i style="width:${pct}%"></i></div><span class="pct">${pct.toFixed(0)}%</span>`;
}

$('#groupPkgs').checked = groupPkgs;
$('#groupPkgs').addEventListener('change', e => {
  groupPkgs = e.target.checked;
  try {
    localStorage.setItem('groupPkgs', groupPkgs ? '1' : '0');
  } catch {}
  render();
});
$('#list').addEventListener('click', e => {
  const h = e.target.closest('.dl-pkg');
  if (!h) return;
  const p = h.dataset.pkg;
  if (e.ctrlKey || e.shiftKey) {
    items.filter(i => i.package === p).forEach(i => selected.add(i.id));
  } else collapsedDl.has(p) ? collapsedDl.delete(p) : collapsedDl.add(p);
  render();
});

function notifyTransitions() {
  for (const it of items) {
    const before = lastStatus.get(it.id);
    if (before && before !== it.status) {
      if (it.status === 'completed' && before !== 'seeding') toast('ok', 'Download complete', it.name);
      else if (it.status === 'seeding' && before === 'active') toast('ok', 'Torrent finished · seeding', it.name);
      else if (it.status === 'error') toast('err', 'Download failed', it.error || it.name);
      else if (it.status === 'handed-off') toast('info', `${PROVIDER[it.via]} is ready`, `${it.childIds?.length || 0} file(s) now downloading`);
    }
    lastStatus.set(it.id, it.status);
  }
}

function renderDetails() {
  const box = $('#details');
  const it = selected.size === 1 && items.find(i => selected.has(i.id));
  box.classList.toggle('open', !!it);
  if (!it) return (detailKey = '');
  const p2p = it.via === 'p2p';
  $$('#detailTabs button').forEach(b => {
    b.classList.toggle('hidden', !p2p && ['peers', 'trackers'].includes(b.dataset.tab));
    b.classList.toggle('on', b.dataset.tab === detailTab);
  });
  if (!p2p && ['peers', 'trackers'].includes(detailTab)) detailTab = 'general';
  moveTabInd();
  const key = it.id + detailTab;
  const fresh = key !== detailKey;
  detailKey = key;
  const body = $('#detailBody');
  if (detailTab === 'general') body.innerHTML = generalTab(it);
  else if (detailTab === 'files') fresh ? (body.innerHTML = filesTab(it)) : patchFiles(it);
  else if (detailTab === 'options' && fresh) body.innerHTML = optionsTab(it);
  else if ((detailTab === 'peers' || detailTab === 'trackers') && fresh) {
    body.innerHTML = '<div class="muted">Loading…</div>';
    pollPeers();
  }
}

function generalTab(it) {
  const rows = [
    ['Name', it.name],
    ['Route', it.parentId ? 'Direct (from debrid)' : { direct: 'Direct HTTP', p2p: 'BitTorrent P2P', torbox: 'TorBox', realdebrid: 'Real-Debrid', ytdlp: 'yt-dlp (media)' }[it.via]],
    ['Save path', it.dir],
    ['Source', it.kind === 'http' && it.parentId ? '(debrid direct link)' : it.source],
    it.infoHash && ['Info hash', it.infoHash],
    it.category && ['Category', it.category],
    it.remote && ['Cloud status', `${it.remote.state} · ${(it.remote.progress * 100).toFixed(1)}%${it.remote.speed ? ' · ' + speed(it.remote.speed) : ''}`],
    it.via === 'p2p' && ['Transfer', `↓ ${bytes(it.downloaded)} · ↑ ${bytes(it.uploaded)} · ratio ${(it.ratio || 0).toFixed(2)}`],
    it.via === 'p2p' && ['Swarm', `${it.peers || 0} connected · ${it.seeds || 0} seeds${it.sequential ? ' · sequential' : ''}`],
    it.kind === 'http' && it.resumable != null && ['Resumable', it.resumable ? 'Yes' : 'No (server does not support ranges)'],
    it.kind === 'media' && ['Format', mediaLabel(it)],
    it.kind === 'media' && it.uploader && ['Channel', it.uploader],
    it.kind === 'media' && it.files?.length && ['Saved as', it.files.join('\n')],
    it.limitKB > 0 && ['Speed limit', it.limitKB + ' KB/s'],
    it.error && ['Error', it.error],
  ].filter(Boolean);
  return `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}

function filesTab(it) {
  if (!it.files?.length) return `<div class="muted">${it.via === 'p2p' ? 'The file list appears once metadata arrives.' : esc(it.filename || it.name)}</div>`;
  const sel = it.selectedFiles ? new Set(it.selectedFiles) : null;
  return `<div class="ftools"><span class="muted">${it.files.length} files · untick to skip, then apply</span><span class="grow"></span><button class="btn ghost" data-files="all">All</button><button class="btn ghost" data-files="none">None</button><button class="btn primary" data-files="apply">Apply</button></div>
    <div class="files">${it.files.slice(0, 1000).map((f, i) => `<div class="frow" data-i="${i}">
      <span class="check ${!sel || sel.has(i) ? 'on' : ''}">${icon('check')}</span><span class="fn" title="${esc(f.path)}">${esc(f.path)}</span>
      <span class="fbar"><i style="width:${(it.fileProgress?.[i] ?? 0) * 100}%"></i></span><span class="muted fsz">${bytes(f.size)}</span></div>`).join('')}</div>`;
}

function patchFiles(it) {
  $$('#detailBody .frow').forEach(r => {
    const bar = r.querySelector('.fbar i');
    if (bar) bar.style.width = (it.fileProgress?.[r.dataset.i] ?? 0) * 100 + '%';
  });
}

function catOptions(current) {
  const cats = Object.keys(settings.categories || {}).sort();
  if (current && !cats.includes(current)) cats.push(current);
  return '<option value="">None</option>' + cats.map(c => `<option ${c === current ? 'selected' : ''}>${esc(c)}</option>`).join('');
}

function optionsTab(it) {
  const p2p = it.via === 'p2p';
  return `<form class="opts" id="optForm">
    <label class="field"><span>Category</span><select name="category">${catOptions(it.category)}</select></label>
    <label class="field"><span>Tags <em>comma separated</em></span><input name="tags" value="${esc((it.tags || []).join(', '))}" /></label>
    ${it.kind === 'http' ? `<label class="field"><span>Speed limit <em>KB/s · 0 = none</em></span><input type="number" min="0" name="limitKB" value="${it.limitKB || 0}" /></label>` : ''}
    ${p2p ? `<label class="field"><span>Seed ratio <em>blank = global</em></span><input type="number" step="0.1" min="-1" name="seedRatio" value="${it.seedRatio ?? ''}" /></label>
    <label class="field"><span>Seed minutes <em>blank = global</em></span><input type="number" min="0" name="seedTimeMin" value="${it.seedTimeMin ?? ''}" /></label>
    <label class="switch"><input type="checkbox" name="sequential" ${it.sequential ? 'checked' : ''} /><i></i>Download in sequential order</label>` : ''}
    <button class="btn primary">Apply</button></form>`;
}

let peerTimer = null;
async function pollPeers() {
  clearTimeout(peerTimer);
  const it = selected.size === 1 && items.find(i => selected.has(i.id));
  if (!it || !$('#details').classList.contains('open') || !['peers', 'trackers'].includes(detailTab)) return;
  const body = $('#detailBody');
  if (detailTab === 'peers') {
    const peers = await api.peers(it.id);
    if (detailTab !== 'peers') return;
    body.innerHTML = peers.length
      ? `<table class="ptable"><thead><tr><th>Address</th><th>Client</th><th>Progress</th><th>↓</th><th>↑</th><th>Downloaded</th><th>Uploaded</th></tr></thead><tbody>${peers
          .sort((a, b) => b.down - a.down)
          .map(p => `<tr><td>${esc(p.addr)}</td><td>${esc(p.client)}</td><td>${(p.progress * 100).toFixed(1)}%</td><td>${p.down ? speed(p.down) : ''}</td><td>${p.up ? speed(p.up) : ''}</td><td>${bytes(p.downloaded)}</td><td>${bytes(p.uploaded)}</td></tr>`)
          .join('')}</tbody></table>`
      : `<div class="muted">${it.status === 'active' || it.status === 'seeding' ? 'No peers connected yet.' : 'Start the torrent to see peers.'}</div>`;
  } else {
    const list = await api.trackers(it.id);
    if (detailTab !== 'trackers') return;
    if (!body.querySelector('.ptable')) {
      body.innerHTML = `<table class="ptable"><thead><tr><th>URL</th><th>Status</th></tr></thead><tbody></tbody></table>
        <form class="addtr" id="trForm"><input name="url" placeholder="Add tracker URLs (one per line or space separated)" /><button class="btn ghost">Add trackers</button></form>`;
    }
    body.querySelector('tbody').innerHTML = list.map(t => `<tr><td>${esc(t.url)}</td><td>${esc(t.status)}</td></tr>`).join('');
  }
  peerTimer = setTimeout(pollPeers, 1500);
}

function moveTabInd() {
  const on = $('#detailTabs button.on');
  const ind = $('#detailTabs .tab-ind');
  if (!on || !ind) return;
  ind.style.width = on.offsetWidth + 'px';
  ind.style.transform = `translateX(${on.offsetLeft}px)`;
}

$('#detailTabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  detailTab = b.dataset.tab;
  detailKey = '';
  renderDetails();
});

$('#detailBody').addEventListener('click', e => {
  const it = selected.size === 1 && items.find(i => selected.has(i.id));
  if (!it) return;
  const row = e.target.closest('.frow');
  if (row) return row.querySelector('.check').classList.toggle('on');
  const act = e.target.closest('[data-files]')?.dataset.files;
  if (act === 'all' || act === 'none') $$('#detailBody .frow .check').forEach(c => c.classList.toggle('on', act === 'all'));
  if (act === 'apply') {
    const picked = $$('#detailBody .frow').filter(r => r.querySelector('.check.on')).map(r => Number(r.dataset.i));
    if (!picked.length) return toast('err', 'Pick at least one file', '');
    api.update([it.id], { selectedFiles: picked.length === it.files.length ? null : picked });
    toast('ok', 'File selection applied', `${picked.length} of ${it.files.length} files`);
  }
});

$('#detailBody').addEventListener('submit', e => {
  e.preventDefault();
  const it = selected.size === 1 && items.find(i => selected.has(i.id));
  if (!it) return;
  const fd = new FormData(e.target);
  if (e.target.id === 'trForm') {
    const urls = String(fd.get('url') || '').split(/\s+/).filter(u => /^(udp|https?|wss?):\/\//i.test(u));
    if (!urls.length) return toast('err', 'No tracker URLs found', '');
    api.update([it.id], { extraTrackers: [...new Set([...(it.extraTrackers || []), ...urls])] });
    e.target.reset();
    return toast('ok', `Added ${urls.length} tracker${urls.length > 1 ? 's' : ''}`, '');
  }
  const num = k => (fd.get(k) === '' || fd.get(k) === null ? null : Number(fd.get(k)));
  const patch = {
    category: fd.get('category') || '',
    tags: String(fd.get('tags') || '').split(',').map(t => t.trim()).filter(Boolean),
  };
  if (it.kind === 'http') patch.limitKB = num('limitKB') || 0;
  if (it.via === 'p2p') Object.assign(patch, { seedRatio: num('seedRatio'), seedTimeMin: num('seedTimeMin'), sequential: fd.get('sequential') === 'on' });
  api.update([it.id], patch);
  toast('ok', 'Options saved', it.name);
});

$('#list').addEventListener('click', async e => {
  const row = e.target.closest('.row');
  if (!row) return;
  const id = row.dataset.id;
  const q = e.target.closest('[data-q]')?.dataset.q;
  if (q) {
    const it = items.find(i => i.id === id);
    if (q === 'toggle') api.action([id], ['active', 'queued', 'resolving', 'seeding'].includes(it.status) ? 'pause' : 'resume');
    if (q === 'open') api.action([id], 'open');
    if (q === 'remove') api.action([id], 'remove');
    return;
  }
  if (e.ctrlKey) selected.has(id) ? selected.delete(id) : selected.add(id);
  else if (e.shiftKey && selected.size) {
    const ids = [...$$('#list .row:not(.leaving)')].map(r => r.dataset.id);
    const a = ids.indexOf([...selected].pop()), b = ids.indexOf(id);
    ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => selected.add(x));
  } else selected = selected.size === 1 && selected.has(id) ? new Set() : new Set([id]);
  render();
});
$('#list').addEventListener('dblclick', e => {
  const row = e.target.closest('.row');
  if (row && !e.target.closest('[data-q]')) api.action([row.dataset.id], 'open');
});
$$('[data-act]').forEach(b =>
  b.addEventListener('click', async () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (b.dataset.act === 'extract') {
      for (const id of ids) await api.extractNow(id);
      return toast('info', 'Extracting', 'Archives in the selected downloads are being extracted.');
    }
    if (b.dataset.act === 'delete' && !(await confirmModal('Delete files?', `This removes ${ids.length} download${ids.length > 1 ? 's' : ''} and deletes the files from disk. This can't be undone.`))) return;
    await api.action(ids, b.dataset.act);
    if (['remove', 'delete'].includes(b.dataset.act)) selected.clear();
  })
);
$('#search').addEventListener('input', render);
$('#filters').addEventListener('click', e => {
  const b = e.target.closest('button[data-filter]');
  if (!b) return;
  $$('#filters button').forEach(x => x.classList.toggle('active', x === b));
  filter = b.dataset.filter;
  moveIndicator('#filters');
  showView('downloads');
  render();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') $('#modalNo').click();
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === 'Delete' && selected.size) $('[data-act="remove"]').click();
  if (e.key === 'a' && e.ctrlKey) {
    e.preventDefault();
    selected = new Set(items.filter(it => matches(it)).map(i => i.id));
    render();
  }
});

// ---------- sliding nav indicators ----------
function moveIndicator(navSel) {
  const nav = $(navSel);
  const active = nav.querySelector('button.active');
  const ind = nav.querySelector('.indicator');
  if (!active) return (ind.style.opacity = 0);
  ind.style.opacity = 1;
  ind.style.height = active.offsetHeight + 'px';
  ind.style.transform = `translateY(${active.offsetTop}px)`;
}

// ---------- views ----------
function showView(name) {
  const current = $$('.view').find(v => !v.classList.contains('hidden'));
  if (current?.id === 'view-' + name) return;
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  moveIndicator('#nav');
  $$('.view').forEach(v => v.classList.toggle('hidden', v.id !== 'view-' + name));
  $('#viewTitle').textContent = VIEW_TITLE[name];
  $('.topbar .search').style.visibility = name === 'downloads' ? 'visible' : 'hidden';
  // Leaving a plugin source: the sidebar highlight goes back to the current download filter.
  if (name !== 'source' && $('#filters button[data-source].active')) {
    $$('#filters button').forEach(x => x.classList.toggle('active', x.dataset.filter === filter));
    moveIndicator('#filters');
  }
  if (name !== 'downloads') clearTimeout(peerTimer);
  window.onViewShown?.(name);
  if (name === 'settings') fillSettings();
}
$$('#nav button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

// ---------- idle: pause animations when Hakobu isn't focused, skip drawing while it's hidden ----------
let pageHidden = document.hidden;
let renderPending = false;
function updateIdle() {
  pageHidden = document.hidden;
  document.documentElement.classList.toggle('idle', document.hidden || !document.hasFocus());
  if (!pageHidden && renderPending) {
    renderPending = false;
    render();
  }
}
window.addEventListener('focus', updateIdle);
window.addEventListener('blur', updateIdle);
document.addEventListener('visibilitychange', updateIdle);
updateIdle();

// ---------- speed graph ----------
function sample() {
  const down = items.reduce((a, i) => a + (['active', 'resolving'].includes(i.status) && i.kind === 'http' || i.via === 'p2p' ? i.speed || 0 : 0), 0);
  const up = items.reduce((a, i) => a + (i.upSpeed || 0), 0);
  history.push([down, up]);
  if (history.length > 60) history.shift();
  if (pageHidden) return;
  $('#stDown').textContent = speed(down);
  $('#stUp').textContent = speed(up);
  const max = Math.max(64 * 1024, ...history.map(h => Math.max(h[0], h[1]))) * 1.15;
  const pts = idx => history.map((h, i) => [(i / 59) * 200 + (60 - history.length) * (200 / 59), 46 - (h[idx] / max) * 42]);
  const smooth = p => p.reduce((d, [x, y], i) => {
    if (!i) return `M${x},${y}`;
    const [px, py] = p[i - 1];
    const cx = (px + x) / 2;
    return `${d} C${cx},${py} ${cx},${y} ${x},${y}`;
  }, '');
  const d = pts(0);
  if (d.length < 2) return;
  $('#sparkLine').setAttribute('d', smooth(d));
  $('#sparkArea').setAttribute('d', `${smooth(d)} L200,48 L${d[0][0]},48 Z`);
  $('#sparkUp').setAttribute('d', smooth(pts(1)));
}
setInterval(sample, 1000);

// ---------- alternative speed limits ----------
function renderTurtle() {
  $('#btnTurtle').classList.toggle('on', limitsAlt);
  $('#btnTurtle').title = limitsAlt ? `Alternative limits ON (${settings.altDlKB} / ${settings.altUlKB} KB/s)` : 'Alternative speed limits (turtle mode)';
}
$('#btnTurtle').addEventListener('click', async () => {
  settings = await api.saveSettings({ altActive: !settings.altActive });
  limitsAlt = settings.altActive || limitsAlt;
  if (!settings.altActive) limitsAlt = false;
  renderTurtle();
  toast('info', settings.altActive ? 'Turtle mode on' : 'Turtle mode off', settings.altActive ? `Limited to ↓ ${settings.altDlKB} KB/s · ↑ ${settings.altUlKB} KB/s` : 'Normal speed limits');
});
api.onLimits(alt => {
  limitsAlt = alt;
  renderTurtle();
});
api.onToast(t => toast(t.kind, t.title, t.text));

// ---------- toasts & modal ----------
function toast(kind, title, text) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div class="ti">${icon(kind === 'ok' ? 'check' : kind === 'err' ? 'alert' : 'bolt')}</div><div><b>${esc(title)}</b><span>${esc(text || '')}</span></div>`;
  $('#toasts').appendChild(el);
  while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, 4200);
}

function confirmModal(title, text) {
  $('#modalTitle').textContent = title;
  $('#modalText').textContent = text;
  $('#modal').classList.add('show');
  return new Promise(resolve => {
    const done = v => {
      $('#modal').classList.remove('show');
      $('#modalYes').onclick = $('#modalNo').onclick = null;
      resolve(v);
    };
    $('#modalYes').onclick = () => done(true);
    $('#modalNo').onclick = () => done(false);
  });
}

// ---------- LinkGrabber ----------
function defaultVia(e) {
  if (e.kind === 'torrent') return settings.torrentRoute;
  if (settings.httpRoute !== 'auto') return settings.httpRoute;
  if (!e.hoster) return 'direct';
  if (settings.preferredDebrid === 'torbox' && settings.torboxKey) return 'torbox';
  if (settings.preferredDebrid === 'realdebrid' && settings.realdebridToken) return 'realdebrid';
  return settings.torboxKey ? 'torbox' : settings.realdebridToken ? 'realdebrid' : 'direct';
}

const collapsedPkgs = new Set();
const pkgDirs = {}; // package -> custom folder

async function addToGrabber(entries, focus = true) {
  const known = new Set(grab.map(g => g.infoHash || g.source));
  const fresh = entries
    .filter(e => !known.has(e.infoHash || e.source))
    .map(e => ({ ...e, sel: true, via: defaultVia(e), pkg: e.package || e.autoPackage || e.name, pkgAuto: !e.package, viaAuto: true, check: e.kind === 'torrent' ? null : { status: 'checking' },
      ...(e.kind === 'media' ? { mediaFormat: settings.ytFormat || 'mp4', mediaQuality: settings.ytFormat === 'mp3' ? settings.ytAudioQuality || '192' : settings.ytVideoQuality || '1080', pkg: e.playlist ? 'Playlist' : 'YouTube & media', pkgAuto: false } : {}) }));
  if (!fresh.length) return;
  grab.push(...fresh);
  renderGrab();
  if (focus) showView('grabber');
  const http = fresh.filter(e => e.kind === 'http');
  if (http.length) toast('info', `${http.length} link${http.length > 1 ? 's' : ''} grabbed`, 'Checking if they are online…');
  const media = fresh.filter(e => e.kind === 'media');
  if (media.length) {
    checkMedia(media);
    ensureTools();
  }
  const torrents = fresh.filter(e => e.kind === 'torrent');
  if (torrents.length) TorrentDialog.enqueue(torrents);
  const hashes = fresh.map(e => e.infoHash).filter(Boolean);
  if (hashes.length) {
    api.checkCached(hashes).then(cached => {
      for (const g of grab) if (g.infoHash && cached[g.infoHash]) g.cached = true;
      renderGrab();
    });
  }
  if (http.length) checkGrabbed(http);
}

// Title, channel and thumbnail for YouTube & media links (oEmbed is instant; playlists ask yt-dlp).
async function checkMedia(list) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, list.length) }, async () => {
      while (next < list.length) {
        const g = list[next++];
        const r = await api.mediaInfo(g.source).catch(e => ({ error: e.message }));
        if (r.title) g.name = r.count ? `${r.title} (${r.count} videos)` : r.title;
        if (r.thumbnail) g.thumbnail = r.thumbnail;
        if (r.uploader) g.uploader = r.uploader;
        if (r.count) g.playlist = true;
        g.check = r.offline ? { status: 'offline', error: r.error } : r.title ? { status: 'online' } : { status: 'unknown', error: r.error || 'Could not read details' };
        if (r.offline) g.sel = false;
        renderGrab();
      }
    })
  );
}

// JDownloader-style online check: status, real file name, size, and a better package name.
async function checkGrabbed(list) {
  const results = await api.checkLinks(list.map(g => g.source));
  list.forEach((g, i) => {
    const r = results[i] || { status: 'unknown' };
    g.check = r;
    if (r.filename) {
      g.name = r.filename;
      g.suggestedName = g.suggestedName || r.filename;
    }
    if (r.size) g.size = r.size;
    if (g.pkgAuto && r.autoPackage) g.pkg = r.autoPackage;
    // The main process knows which services support the host: use its route unless the user picked one.
    if (g.viaAuto && r.route && g.kind !== 'torrent') g.via = r.route;
    if (['offline', 'page', 'unsupported'].includes(r.status)) g.sel = false;
  });
  // Single files whose names now match another package join it.
  renderGrab();
  const off = list.filter(g => g.check?.status === 'offline').length;
  if (off) toast('err', `${off} link${off > 1 ? 's are' : ' is'} offline`, 'They were unticked. Use "Remove offline" to clear them.');
  const bad = list.filter(g => ['page', 'unsupported'].includes(g.check?.status));
  if (bad.length) toast('err', `${bad.length} link${bad.length > 1 ? 's' : ''} can't be downloaded`, bad[0].check.error);
}

const MEDIA_CHOICES = [
  ['mp4:2160', 'MP4 · 4K'], ['mp4:1440', 'MP4 · 1440p'], ['mp4:1080', 'MP4 · 1080p'], ['mp4:720', 'MP4 · 720p'], ['mp4:480', 'MP4 · 480p'], ['mp4:best', 'MP4 · best'],
  ['mp3:320', 'MP3 · 320k'], ['mp3:256', 'MP3 · 256k'], ['mp3:192', 'MP3 · 192k'], ['mp3:128', 'MP3 · 128k'],
];
const ROUTES = kind =>
  kind === 'media'
    ? MEDIA_CHOICES
    : (kind === 'torrent' ? ['p2p', 'torbox', 'realdebrid'] : ['direct', 'torbox', 'realdebrid', 'ytdlp']).map(v => [
        v,
        { p2p: 'P2P on this PC', direct: 'Direct download', torbox: 'TorBox', realdebrid: 'Real-Debrid', ytdlp: 'As media (yt-dlp)' }[v],
      ]);

function checkChip(g) {
  if (!g.check) return '';
  const s = g.check.status;
  if (s === 'checking') return '<span class="lc lc-checking"><span class="spinner sm"></span>checking</span>';
  if (s === 'online') return `<span class="lc lc-on">${icon('check')}online</span>`;
  if (s === 'offline') return `<span class="lc lc-off" title="${esc(g.check.error || '')}">${icon('x')}offline</span>`;
  if (s === 'page') return `<span class="lc lc-off" title="${esc(g.check.error || '')}">${icon('x')}web page</span>`;
  if (s === 'unsupported') return `<span class="lc lc-off" title="${esc(g.check.error || '')}">${icon('x')}unsupported host</span>`;
  if (s === 'hoster') {
    const names = (g.check.providers || []).map(p => (p === 'torbox' ? 'TorBox' : 'Real-Debrid'));
    const usable = g.via === 'torbox' || g.via === 'realdebrid';
    return `<span class="lc ${usable ? 'lc-on' : 'lc-unk'}" title="Supported by ${esc(names.join(' and '))}">${icon('cloud')}${usable ? 'via ' + (g.via === 'torbox' ? 'TorBox' : 'Real-Debrid') : 'needs ' + esc(names.join(' / '))}</span>`;
  }
  return `<span class="lc lc-unk" title="${esc(g.check.error || 'Could not verify')}">?</span>`;
}

function grabGroups() {
  const order = [];
  const map = new Map();
  grab.forEach((g, i) => {
    if (!map.has(g.pkg)) {
      map.set(g.pkg, []);
      order.push(g.pkg);
    }
    map.get(g.pkg).push(i);
  });
  return order.map(name => ({ name, idx: map.get(name) }));
}

function renderGrab() {
  let n = 0;
  $('#grabList').innerHTML = grabGroups()
    .map(({ name, idx }) => {
      const list = idx.map(i => grab[i]);
      const on = list.filter(g => g.sel).length;
      const state = on === 0 ? '' : on === list.length ? 'on' : 'part';
      const size = list.reduce((a, g) => a + (g.size || 0), 0);
      const online = list.filter(g => g.check?.status === 'online').length;
      const offline = list.filter(g => g.check?.status === 'offline').length;
      const collapsed = collapsedPkgs.has(name);
      const head = `<div class="pkg-head ${collapsed ? 'collapsed' : ''}" data-pkg="${esc(name)}" style="animation-delay:${Math.min(n++, 12) * 20}ms">
        <span class="twisty">${icon('chevron')}</span><span class="check ${state}">${icon('check')}</span>${icon('archive', 'pkg-ico')}
        <span class="pkg-name" title="Double-click to rename">${esc(name)}</span>
        <span class="pkg-meta">${list.length} file${list.length > 1 ? 's' : ''}${size ? ' · ' + bytes(size) : ''}${online ? ` · <span class="ok">${online} online</span>` : ''}${offline ? ` · <span class="err">${offline} offline</span>` : ''}</span>
        <span class="grow"></span>
        ${pkgDirs[name] ? `<span class="muted ell gdir" title="${esc(pkgDirs[name])}">→ ${esc(pkgDirs[name])}</span>` : ''}
        <button class="x" data-p="dir" title="Folder for this package">${icon('folder')}</button>
        <button class="x" data-p="rename" title="Rename package">${icon('edit')}</button>
        <button class="btn primary sm" data-p="start">${icon('play')}Start</button></div>`;
      const rows = collapsed
        ? ''
        : idx
            .map(i => {
              const g = grab[i];
              const type = g.kind === 'torrent' ? g.via : g.via;
              return `<div class="row grab-row ${g.check?.status === 'offline' ? 'offline' : ''}" data-i="${i}" style="animation-delay:${Math.min(n++, 12) * 20}ms">
              <span class="check ${g.sel ? 'on' : ''}">${icon('check')}</span>
              <div class="type t-${g.kind === 'media' ? 'ytdlp' : type}${g.thumbnail ? ' thumb' : ''}"${g.thumbnail ? ` style="background-image:url('${esc(g.thumbnail)}')"` : ''}>${g.thumbnail ? '' : icon(g.kind === 'torrent' ? 'magnet' : g.kind === 'media' ? 'youtube' : TYPE_ICON[type])}</div>
              <div class="body">
                <div class="title"><span class="name" title="${esc(g.source)}">${esc(g.name)}</span>${checkChip(g)}
                  ${g.cached ? `<span class="tag tag-cached">${icon('bolt')}CACHED</span>` : ''}${g.hoster ? `<span class="tag tag-hoster">${esc(g.check?.host || 'HOSTER')}</span>` : ''}${g.archivePasswords?.length ? '<span class="tag tag-hoster">🔑 password</span>' : ''}</div>
                <div class="meta"><span>${g.kind === 'torrent' ? 'Torrent' : g.kind === 'media' ? (g.playlist ? 'Playlist' : 'Video') : 'HTTP'}</span>${g.uploader ? `<span>${esc(g.uploader)}</span>` : ''}${g.size ? `<span>${bytes(g.size)}</span>` : ''}${
                  g.files ? `<span>${g.selectedFiles ? g.selectedFiles.length : g.files.length} of ${g.files.length} files</span>` : ''}${g.dir ? `<span class="gdir" title="${esc(g.dir)}">→ ${esc(g.dir)}</span>` : ''}${g.check?.error && g.check.status !== 'online' ? `<span class="err ell">${esc(g.check.error)}</span>` : ''}</div>
              </div>
              <div class="side">
                <select class="gvia">${ROUTES(g.kind).map(([v, l]) => `<option value="${v}" ${(g.kind === 'media' ? `${g.mediaFormat}:${g.mediaQuality}` : g.via) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
                <div class="quick">${g.kind === 'torrent' ? `<button data-g="files" title="Choose files">${icon('layers')}</button>` : ''}<button data-g="dir" title="Save this one somewhere else">${icon('folder')}</button><button data-g="remove" title="Remove">${icon('x')}</button></div>
              </div></div>`;
            })
            .join('');
      return `<div class="pkg">${head}<div class="pkg-items">${rows}</div></div>`;
    })
    .join('');
  updateGrabSummary();
}

function updateGrabSummary() {
  const n = grab.length;
  $('#grabEmpty').classList.toggle('hidden', n > 0);
  $('#grabCount').textContent = n;
  $('#grabCount').classList.toggle('hidden', !n);
  const pk = new Set(grab.map(g => g.pkg)).size;
  const off = grab.filter(g => ['offline', 'page', 'unsupported'].includes(g.check?.status)).length;
  $('#grabSummary').textContent = n ? `${grab.filter(g => g.sel).length} of ${n} selected · ${pk} package${pk === 1 ? '' : 's'}${off ? ` · ${off} offline` : ''}` : '';
  $('#btnGrabStart').disabled = !grab.some(g => g.sel);
  $('#btnRemoveOffline').classList.toggle('hidden', !off);
}

$('#grabList').addEventListener('change', e => {
  const row = e.target.closest('.row');
  if (row && e.target.classList.contains('gvia')) {
    const g = grab[row.dataset.i];
    if (g.kind === 'media') {
      [g.mediaFormat, g.mediaQuality] = e.target.value.split(':');
      return renderGrab();
    }
    g.via = e.target.value;
    g.viaAuto = false;
    renderGrab();
  }
});

function renamePackage(old) {
  const head = [...$$('.pkg-head')].find(h => h.dataset.pkg === old);
  const label = head?.querySelector('.pkg-name');
  if (!label) return;
  const input = document.createElement('input');
  input.className = 'pkg-rename';
  input.value = old;
  label.replaceWith(input);
  input.focus();
  input.select();
  const done = commit => {
    const v = input.value.trim();
    if (commit && v && v !== old) {
      grab.forEach(g => {
        if (g.pkg === old) {
          g.pkg = v;
          g.pkgAuto = false;
        }
      });
      if (pkgDirs[old]) pkgDirs[v] = pkgDirs[old];
    }
    renderGrab();
  };
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') done(true);
    if (ev.key === 'Escape') done(false);
  });
  input.addEventListener('blur', () => done(true), { once: true });
}

$('#grabList').addEventListener('dblclick', e => {
  const head = e.target.closest('.pkg-head');
  if (head && e.target.closest('.pkg-name')) renamePackage(head.dataset.pkg);
});

$('#grabList').addEventListener('click', e => {
  const head = e.target.closest('.pkg-head');
  if (head) {
    if (e.target.closest('input')) return;
    const name = head.dataset.pkg;
    const items = grab.filter(g => g.pkg === name);
    const act = e.target.closest('[data-p]')?.dataset.p;
    if (act === 'start') return startGrabbed(items);
    if (act === 'rename') return renamePackage(name);
    if (act === 'dir') {
      api.pickFolder().then(d => {
        if (d) {
          pkgDirs[name] = d;
          renderGrab();
        }
      });
      return;
    }
    if (e.target.closest('.check')) {
      const all = items.every(g => g.sel);
      items.forEach(g => (g.sel = !all));
    } else collapsedPkgs.has(name) ? collapsedPkgs.delete(name) : collapsedPkgs.add(name);
    return renderGrab();
  }
  const row = e.target.closest('.row');
  if (!row || e.target.closest('select')) return;
  if (e.target.closest('[data-g="files"]')) return TorrentDialog.open(grab[row.dataset.i]);
  if (e.target.closest('[data-g="dir"]')) {
    const g = grab[row.dataset.i];
    api.pickFolder().then(d => {
      if (d) {
        g.dir = d;
        renderGrab();
      }
    });
    return;
  }
  if (e.target.closest('[data-g="remove"]')) {
    row.classList.add('leaving');
    row.addEventListener('animationend', () => {
      grab.splice(row.dataset.i, 1);
      renderGrab();
    }, { once: true });
    return;
  }
  const g = grab[row.dataset.i];
  g.sel = !g.sel;
  renderGrab();
});
$('#grabSelAll').addEventListener('change', e => {
  grab.forEach(g => (g.sel = e.target.checked));
  renderGrab();
});
$('#btnAnalyze').addEventListener('click', async () => {
  const entries = await api.parse($('#grabText').value);
  if (!entries.length) return toast('err', 'Nothing found', 'No links, magnets or info hashes in that text.');
  $('#grabText').value = '';
  addToGrabber(entries);
});
$('#btnClearGrab').addEventListener('click', () => {
  grab = [];
  renderGrab();
});
$('#btnRemoveOffline').addEventListener('click', () => {
  grab = grab.filter(g => !['offline', 'page', 'unsupported'].includes(g.check?.status));
  renderGrab();
});
$('#btnGrabDir').addEventListener('click', async () => {
  const d = await api.pickFolder();
  if (d) $('#grabDir').value = d;
});

const safeName = s => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 150) || 'Package';

// Multi-file packages go into their own subfolder (JDownloader's default).
async function startGrabbed(chosen) {
  chosen = chosen.filter(g => g.sel);
  if (!chosen.length) return;
  if (chosen.some(g => g.kind === 'media' || g.via === 'ytdlp') && !(await ensureTools(true))) return;
  const base = ($('#grabDir').value.trim() || settings.downloadDir).replace(/[\\/]+$/, '');
  const paused = $('#grabPaused').checked;
  const sizes = {};
  for (const g of grab) sizes[g.pkg] = (sizes[g.pkg] || 0) + 1;
  const n = await api.add(
    chosen.map(({ sel, cached, check, pkg, pkgAuto, autoPackage, viaAuto, ...e }) => {
      if (e.via === 'ytdlp' && e.kind === 'http') Object.assign(e, { kind: 'media', mediaFormat: settings.ytFormat || 'mp4' });
      if (e.kind === 'media') return { ...e, via: 'ytdlp', dir: e.dir || base, package: null, paused };
      const multi = sizes[pkg] > 1;
      const dir = e.dir || pkgDirs[pkg] || (multi && settings.packageSubfolder !== false && e.kind !== 'torrent' ? `${base}\\${safeName(pkg)}` : base);
      return { ...e, package: multi || e.archivePasswords?.length ? pkg : e.package || null, dir, paused };
    })
  );
  const started = new Set(chosen);
  grab = grab.filter(g => !started.has(g));
  renderGrab();
  if (!grab.length) showView('downloads');
  toast('ok', `Started ${n} download${n === 1 ? '' : 's'}`, [...new Set(chosen.map(g => g.pkg))].join(', '));
}
$('#btnGrabStart').addEventListener('click', () => startGrabbed(grab));

const openGrabber = () => {
  showView('grabber');
  $('#grabText').focus();
};
$('#btnAddLinks').addEventListener('click', openGrabber);
$('#btnEmptyAdd').addEventListener('click', openGrabber);

// Global paste → LinkGrabber (JDownloader style).
document.addEventListener('paste', async e => {
  if (e.target.matches('input, textarea')) return;
  const entries = await api.parse(e.clipboardData.getData('text'));
  if (entries.length) addToGrabber(entries);
});

// .torrent files: picker + drag & drop.
function b64(buf) {
  const arr = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < arr.length; i += 0x8000) s += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  return btoa(s);
}
async function addTorrentFiles(files) {
  const entries = [];
  for (const f of files) {
    if (!/\.torrent$/i.test(f.name)) continue;
    entries.push({ kind: 'torrent', source: f.name, name: f.name.replace(/\.torrent$/i, ''), torrentB64: b64(await f.arrayBuffer()) });
  }
  addToGrabber(entries);
}
['#torrentInput', '#torrentInput2'].forEach(sel =>
  $(sel).addEventListener('change', e => {
    addTorrentFiles([...e.target.files]);
    e.target.value = '';
  })
);
let dragDepth = 0;
window.addEventListener('dragenter', e => {
  e.preventDefault();
  dragDepth++;
  $('#dropHint').classList.add('show');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) $('#dropHint').classList.remove('show');
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropHint').classList.remove('show');
  const files = [...e.dataTransfer.files];
  const plugins = files.filter(f => /\.(js|hakobu-plugin)$/i.test(f.name));
  if (plugins.length) window.installPluginFiles?.(plugins);
  if (files.length > plugins.length) addTorrentFiles(files.filter(f => !plugins.includes(f)));
  else if (files.length) return;
  else api.parse(e.dataTransfer.getData('text')).then(addToGrabber);
});

// ---------- themes ----------
const systemDark = matchMedia('(prefers-color-scheme: dark)');
function applyTheme(choice, animate = true) {
  const resolved = choice === 'system' || !choice ? (systemDark.matches ? 'dark' : 'light') : choice;
  const root = document.documentElement;
  if (animate) {
    root.classList.add('theming');
    clearTimeout(applyTheme.t);
    applyTheme.t = setTimeout(() => root.classList.remove('theming'), 500);
  }
  root.dataset.theme = resolved;
  $$('[data-theme-opt]').forEach(b => b.classList.toggle('on', b.dataset.themeOpt === (choice || 'system')));
  api.setTheme(resolved);
}
systemDark.addEventListener('change', () => settings.theme === 'system' && applyTheme('system'));
$$('[data-theme-opt]').forEach(b =>
  b.addEventListener('click', async () => {
    applyTheme(b.dataset.themeOpt);
    settings = await api.saveSettings({ theme: b.dataset.themeOpt });
  })
);
window.__setTheme = t => applyTheme(t, false); // used by the screenshot helper

// ---------- settings ----------
const NUMERIC = ['maxConcurrentMedia', 'apiPort', 'maxConcurrent', 'connectionsPerDownload', 'maxActiveTorrents', 'dlLimitKB', 'ulLimitKB', 'seedRatio', 'torrentPort', 'altDlKB', 'altUlKB', 'seedTimeMin'];
$('#grabClip').addEventListener('change', async e => {
  settings = await api.saveSettings({ clipboardMonitor: e.target.checked });
  toast('info', e.target.checked ? 'Watching clipboard' : 'Clipboard watching off', e.target.checked ? 'Copied links will appear here for approval.' : '');
});

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function fillSettings() {
  for (const el of $('#settingsForm').elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') el.checked = !!settings[el.name];
    else el.value = settings[el.name] ?? '';
  }
  const sch = settings.schedule || {};
  $('#schEnabled').checked = !!sch.enabled;
  $('#schFrom').value = sch.from || '01:00';
  $('#schTo').value = sch.to || '08:00';
  $('#schDays').innerHTML = DAYS.map((d, i) => `<button type="button" data-day="${i}" class="${(sch.days || []).includes(i) ? 'on' : ''}">${d}</button>`).join('');
  renderCatList();
  renderProvList();
  $('#pwList').value = (settings.archivePasswords || []).join('\n');
  $('#jobDays').innerHTML = DAYS.map((d, i) => `<button type="button" data-day="${i}" class="on">${d}</button>`).join('');
  renderJobs();
  renderApiStatus();
  loadHosters();
  refreshTools(true);
}

// ---------- supported hosts grid ----------
let hosterData = null;
async function loadHosters(force = false) {
  if (!hosterData || force) {
    $('#tbHosts').innerHTML = $('#rdHosts').innerHTML = '<span class="spinner sm"></span>';
    hosterData = await api.hosters(force);
  }
  renderHosters();
}
function hostTile(h) {
  const label = `${h.name}${h.up ? '' : ' (down right now)'}${h.domains?.length ? ' · ' + h.domains[0] : ''}`;
  const letter = esc((h.name || '?').trim()[0].toUpperCase());
  return `<span class="host ${h.up ? '' : 'down'}" data-name="${esc(label)}" tabindex="0"><img src="${esc(h.icon || '')}" alt="" data-letter="${letter}" /></span>`;
}
function renderHosters() {
  if (!hosterData) return;
  const q = ($('#hostFilter').value || '').trim().toLowerCase();
  const hit = h => !q || h.name.toLowerCase().includes(q) || (h.domains || []).some(d => d.includes(q));
  const sort = list => [...list].sort((a, b) => a.name.localeCompare(b.name));
  const tb = sort(hosterData.torbox || []).filter(hit);
  const rd = sort(hosterData.realdebrid || []).filter(hit);
  $('#tbHosts').innerHTML = tb.map(hostTile).join('') || '<span class="muted">No match</span>';
  $('#rdHosts').innerHTML = rd.map(hostTile).join('') || '<span class="muted">No match</span>';
  const tbUp = (hosterData.torbox || []).filter(h => h.up).length;
  $('#tbCount').textContent = `${(hosterData.torbox || []).length} hosts · ${tbUp} working`;
  $('#rdCount').textContent = `${(hosterData.realdebrid || []).length} hosts`;
  $('#tbState').textContent = settings.torboxKey ? '· connected' : '· no key';
  $('#rdState').textContent = settings.realdebridToken ? '· connected' : '· no key';
  $('#hostHint').textContent = hosterData.updated
    ? `Hover an icon to see the host. Dimmed icons are down right now. Lists updated ${new Date(hosterData.updated).toLocaleString()}.`
    : "Couldn't load the host lists. Check your connection and press refresh.";
}
$('#hostFilter').addEventListener('input', renderHosters);
// Floating tooltip (a CSS one would be clipped by the scrolling grid).
const hostTip = Object.assign(document.createElement('div'), { className: 'host-tip' });
document.body.appendChild(hostTip);
const showTip = el => {
  const r = el.getBoundingClientRect();
  hostTip.textContent = el.dataset.name;
  hostTip.classList.add('show');
  const w = hostTip.offsetWidth;
  hostTip.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
  hostTip.style.top = r.top - hostTip.offsetHeight - 8 + 'px';
};
for (const id of ['#tbHosts', '#rdHosts']) {
  $(id).addEventListener('mouseover', e => { const h = e.target.closest('.host'); if (h) showTip(h); });
  $(id).addEventListener('mouseout', e => { if (e.target.closest('.host') && !e.relatedTarget?.closest?.('.host')) hostTip.classList.remove('show'); });
  $(id).addEventListener('focusin', e => { const h = e.target.closest('.host'); if (h) showTip(h); });
  $(id).addEventListener('focusout', () => hostTip.classList.remove('show'));
  $(id).addEventListener('scroll', () => hostTip.classList.remove('show'));
}
// Icons that fail to load become a letter tile (inline onerror is blocked by the CSP).
document.addEventListener('error', e => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.closest('.host')) img.replaceWith(Object.assign(document.createElement('b'), { textContent: img.dataset.letter || '?' }));
}, true);
$('#hostRefresh').addEventListener('click', () => loadHosters(true));

// ---------- media tools (yt-dlp, Deno, ffmpeg) ----------
let toolState = null;
let toolsDismissed = false;
function toolRow(name, s, p) {
  const prog = p && p.tool === name && !['done', 'error'].includes(p.step);
  const right = prog
    ? `${p.step === 'verifying' ? 'checking…' : Math.round((p.fraction || 0) * 100) + '%'}`
    : !s?.installed ? '<span class="err">not installed</span>'
    : s.updateAvailable ? `<span class="warn">${esc(s.version)} → ${esc(s.latest)}</span>`
    : `<span class="ok">${esc(s.version || '?')}${s.latest ? ' · newest' : ''}</span>`;
  return `<div class="tool-row" data-tool="${name}"><b>${esc(s?.label || name)}</b><span>${right}</span><div class="bar"><i style="width:${prog ? Math.round((p.fraction || 0) * 100) : s?.installed ? 100 : 0}%"></i></div></div>`;
}
function renderTools(p) {
  const html = ['yt-dlp', 'deno', 'ffmpeg'].map(n => toolRow(n, toolState?.[n], p)).join('');
  $('#toolsList').innerHTML = html;
  $('#toolsDlgList').innerHTML = html;
}
async function refreshTools(checkLatest = false) {
  toolState = await api.toolsStatus(checkLatest);
  renderTools();
  return toolState;
}
// Resolves true when the tools are ready; asks to install them otherwise.
async function ensureTools(force = false) {
  const st = toolState || (await refreshTools());
  if (Object.values(st).every(t => t.installed)) return true;
  if (toolsDismissed && !force) return false;
  renderTools();
  $('#toolsDlg').classList.add('show');
  return new Promise(resolve => {
    $('#toolsLater').onclick = () => {
      toolsDismissed = true;
      $('#toolsDlg').classList.remove('show');
      resolve(false);
    };
    $('#toolsNow').onclick = async () => {
      $('#toolsNow').disabled = $('#toolsLater').disabled = true;
      $('#toolsNow').innerHTML = '<span class="spinner sm"></span>Installing…';
      const r = await api.toolsInstall(null);
      await refreshTools();
      $('#toolsNow').disabled = $('#toolsLater').disabled = false;
      $('#toolsNow').innerHTML = icon('download') + 'Install now';
      const failed = Object.entries(r).filter(([, x]) => !x.ok);
      if (failed.length) return toast('err', "Some tools couldn't be installed", failed.map(([n, x]) => `${n}: ${x.error}`).join(' · '));
      $('#toolsDlg').classList.remove('show');
      toast('ok', 'YouTube & media ready', 'yt-dlp, Deno and ffmpeg are installed.');
      resolve(true);
    };
  });
}
api.onToolsProgress(p => renderTools(p));
$('#toolsCheck').addEventListener('click', async () => {
  $('#toolsCheck').disabled = true;
  const st = await refreshTools(true);
  const out = Object.values(st).filter(t => t.updateAvailable);
  if (out.length) {
    toast('info', 'Updating media tools', out.map(t => `${t.label} ${t.version || ''} → ${t.latest}`).join(', '));
    await api.toolsUpdate();
    await refreshTools(true);
    toast('ok', 'Media tools updated', '');
  } else toast('ok', 'Media tools are up to date', Object.values(st).map(t => `${t.label} ${t.version}`).join(' · '));
  $('#toolsCheck').disabled = false;
});
$('#toolsRepair').addEventListener('click', async () => {
  $('#toolsRepair').disabled = true;
  await api.toolsInstall(null);
  await refreshTools(true);
  $('#toolsRepair').disabled = false;
  toast('ok', 'Media tools reinstalled', '');
});

async function renderApiStatus() {
  const st = await api.apiStatus();
  $('#apiToken').value = st.token || '';
  const chip = (label, v) => `<span class="chip" style="color:var(${v === 'on' ? '--green' : v === 'off' ? '--text-3' : '--red'})">${label}: ${v === 'on' ? 'listening' : esc(v)}</span>`;
  $('#apiStatus').innerHTML = chip('Extension API', st.api) + chip("Click'n'Load", st.cnl);
}
$('#copyToken').addEventListener('click', () => {
  navigator.clipboard.writeText($('#apiToken').value);
  toast('ok', 'Token copied', 'Paste it into the extension settings.');
});
$('#newToken').addEventListener('click', async () => {
  $('#apiToken').value = await api.newApiToken();
  toast('info', 'New token created', 'Update it in the extension settings.');
});
$('#openExt').addEventListener('click', () => api.openExtensionDir());

const JOB_LABEL = { start: 'Start downloads', pause: 'Pause downloads', 'turtle-on': 'Turtle mode on', 'turtle-off': 'Turtle mode off' };
function renderJobs() {
  const jobs = settings.downloadSchedule || [];
  $('#jobList').innerHTML = jobs.length
    ? jobs.map((j, i) => `<div class="mini"><b>${esc(j.time)}</b><span class="grow">${JOB_LABEL[j.action]}</span><span class="muted">${j.days.length === 7 ? 'every day' : j.days.map(d => DAYS[d]).join(' ')}</span><button type="button" class="x" data-deljob="${i}">${icon('x')}</button></div>`).join('')
    : '<div class="muted">No scheduled actions. Example: start at 01:00, pause at 08:00.</div>';
}
$('#jobDays').addEventListener('click', e => e.target.closest('[data-day]')?.classList.toggle('on'));
$('#jobAdd').addEventListener('click', async () => {
  const days = $$('#jobDays .on').map(b => Number(b.dataset.day));
  if (!days.length) return toast('err', 'Pick at least one day', '');
  const job = { id: Date.now().toString(36), time: $('#jobTime').value || '01:00', action: $('#jobAction').value, days };
  settings = await api.saveSettings({ downloadSchedule: [...(settings.downloadSchedule || []), job] });
  renderJobs();
});
$('#jobList').addEventListener('click', async e => {
  const i = e.target.closest('[data-deljob]')?.dataset.deljob;
  if (i === undefined) return;
  settings = await api.saveSettings({ downloadSchedule: (settings.downloadSchedule || []).filter((_, j) => j !== Number(i)) });
  renderJobs();
});

// "When done" countdown: the PC action only runs if nobody cancels within 60 seconds.
api.onAllDone(async action => {
  const label = { quit: 'Quitting Hakobu', sleep: 'Putting the PC to sleep', shutdown: 'Shutting down the PC' }[action];
  let left = 60;
  $('#modalYes').textContent = 'Do it now';
  $('#modalYes').className = 'btn primary';
  const tick = () => ($('#modalText').textContent = `All downloads are finished. ${label} in ${left} s.`);
  const p = confirmModal('All downloads finished', '');
  tick();
  const timer = setInterval(() => {
    left--;
    tick();
    if (left <= 0) $('#modalYes').click();
  }, 1000);
  const go = await p;
  clearInterval(timer);
  $('#modalYes').textContent = 'Delete';
  $('#modalYes').className = 'btn danger-fill';
  settings.whenDone = 'none';
  if (go) api.powerAction(action);
  else toast('info', 'Cancelled', `${label} was cancelled.`);
});
$('#schDays').addEventListener('click', e => e.target.closest('[data-day]')?.classList.toggle('on'));

function renderCatList() {
  const cats = Object.entries(settings.categories || {});
  $('#catList').innerHTML = cats.length
    ? cats.map(([n, p]) => `<div class="mini"><span class="pill-cat">${esc(n)}</span><span class="muted grow ell">${esc(p || 'default folder')}</span><button type="button" class="x" data-delcat="${esc(n)}">${icon('x')}</button></div>`).join('')
    : '<div class="muted">No categories yet.</div>';
}
$('#catPick').addEventListener('click', async () => {
  const d = await api.pickFolder();
  if (d) $('#catPath').value = d;
});
$('#catAdd').addEventListener('click', async () => {
  const name = $('#catName').value.trim();
  if (!name) return;
  settings = await api.setCategories({ ...(settings.categories || {}), [name]: $('#catPath').value.trim() });
  $('#catName').value = $('#catPath').value = '';
  renderCatList();
  catKey = '';
  render();
});
$('#catList').addEventListener('click', async e => {
  const n = e.target.closest('[data-delcat]')?.dataset.delcat;
  if (!n) return;
  const cats = { ...settings.categories };
  delete cats[n];
  settings = await api.setCategories(cats);
  renderCatList();
  catKey = '';
  render();
});

function renderProvList() {
  const list = settings.searchProviders || [];
  $('#provList').innerHTML = list.length
    ? list.map((p, i) => `<div class="mini"><label class="switch"><input type="checkbox" data-prov-on="${i}" ${p.enabled !== false ? 'checked' : ''} /><i></i></label><span class="grow ell" title="${esc(p.url)}">${esc(p.name || p.url)}</span><button type="button" class="x" data-delprov="${i}">${icon('x')}</button></div>`).join('')
    : '<div class="muted">No providers yet.</div>';
}
async function saveProviders(list) {
  settings = await api.saveSettings({ searchProviders: list });
  renderProvList();
}
$('#provAdd').addEventListener('click', () => {
  const url = $('#provUrl').value.trim();
  if (!/^https?:\/\//i.test(url)) return toast('err', 'Enter a Torznab URL', 'It starts with http:// or https://');
  let name = url;
  try {
    const u = new URL(url);
    const idx = /indexers\/([^/]+)/.exec(u.pathname)?.[1];
    name = idx ? `${u.hostname} · ${idx}` : u.host;
  } catch {}
  saveProviders([...(settings.searchProviders || []), { name, url, apikey: $('#provKey').value.trim(), enabled: true }]);
  $('#provUrl').value = $('#provKey').value = '';
});
$('#provList').addEventListener('click', e => {
  const del = e.target.closest('[data-delprov]')?.dataset.delprov;
  if (del !== undefined) saveProviders((settings.searchProviders || []).filter((_, i) => i !== Number(del)));
});
$('#provList').addEventListener('change', e => {
  const i = e.target.dataset.provOn;
  if (i === undefined) return;
  const list = (settings.searchProviders || []).map((p, j) => (j === Number(i) ? { ...p, enabled: e.target.checked } : p));
  saveProviders(list);
});
$('#settingsForm').addEventListener('submit', async e => {
  e.preventDefault();
  const patch = {};
  for (const el of e.target.elements) {
    if (!el.name) continue;
    patch[el.name] = el.type === 'checkbox' ? el.checked : NUMERIC.includes(el.name) ? Number(el.value) : el.value.trim();
  }
  patch.archivePasswords = $('#pwList').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  patch.schedule = {
    enabled: $('#schEnabled').checked,
    from: $('#schFrom').value || '01:00',
    to: $('#schTo').value || '08:00',
    days: $$('#schDays .on').map(b => Number(b.dataset.day)),
  };
  settings = await api.saveSettings(patch);
  $('#grabDir').value = settings.downloadDir;
  toast('ok', 'Settings saved', '');
  render();
});
$('#btnDir').addEventListener('click', async () => {
  const d = await api.pickFolder();
  if (d) $('#settingsForm').elements.downloadDir.value = d;
});
$$('[data-test]').forEach(b =>
  b.addEventListener('click', async () => {
    const name = b.dataset.test;
    const key = $('#settingsForm').elements[name === 'torbox' ? 'torboxKey' : 'realdebridToken'].value.trim();
    try {
      const u = await api.testDebrid(name, key);
      toast('ok', `${PROVIDER[name]} connected`, `${u.username || 'Account'} · ${u.premium ? 'premium' : 'not premium'}${u.expires ? ' · until ' + String(u.expires).slice(0, 10) : ''}`);
    } catch (err) {
      toast('err', `${PROVIDER[name]} failed`, String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  })
);
$('#btnMagnet').addEventListener('click', async () => {
  const ok = await api.registerMagnet();
  ok ? toast('ok', 'Magnet links registered', 'Windows may ask you to confirm in Default Apps.') : toast('err', 'Registration refused', 'Windows did not allow it.');
});

// ---------- boot ----------
api.onItems(list => {
  items = list;
  const ids = new Set(items.map(i => i.id));
  for (const id of selected) if (!ids.has(id)) selected.delete(id);
  notifyTransitions();
  if (pageHidden) renderPending = true;
  else render();
});
api.onGrab(entries => addToGrabber(entries));
api.state().then(s => {
  items = s.items;
  settings = s.settings;
  items.forEach(i => lastStatus.set(i.id, i.status));
  applyTheme(settings.theme, false);
  $('#grabClip').checked = !!settings.clipboardMonitor;
  limitsAlt = !!s.altLimits;
  renderTurtle();
  setTimeout(() => ensureTools(), 1500);
  $('#grabDir').value = settings.downloadDir;
  $('#peerInfo').textContent = s.peerPort ? `Listening on TCP ${s.peerPort}. Peers see this client as "Hakobu" (-HB0010-).` : '';
  render();
  renderGrab();
  requestAnimationFrame(() => {
    moveIndicator('#nav');
    moveIndicator('#filters');
  });
});
window.addEventListener('resize', () => {
  moveTabInd();
  moveIndicator('#nav');
  moveIndicator('#filters');
});
