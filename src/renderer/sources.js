/* global api, icon, svgIcon, $, $$, esc, bytes, settings, toast, items, showView, moveIndicator, confirmModal, addToGrabber */
// Plugin sources: a plugin can add a browsable catalogue under Source in the sidebar
// (e.g. a ROM archive: platform tiles -> file list -> tick files -> Start).

const SHOW_MAX = 400; // rows drawn at once; the filter narrows the rest
const srcState = { id: null, title: '', cats: [], cat: null, list: [], picked: new Set(), token: 0, region: 'all' };
let srcLayout = 'grid'; // covers (eShop-style) when the plugin gives art, else always a list
try {
  srcLayout = localStorage.getItem('srcLayout') || 'grid';
} catch {}
const srcLists = new Map(); // `${source}|${category}` -> rows, kept for the session
let srcCatalog = [];

const cleanErr = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function loadSources() {
  try {
    srcCatalog = await api.sources();
  } catch {
    srcCatalog = [];
  }
  // First in the list: below the library filters they sat out of sight on most window sizes.
  $('#srcFilters').innerHTML = (srcCatalog.length ? '<div class="label">Plugins</div>' : '') + srcCatalog
    .map(s => `<button data-source="${esc(s.id)}" title="${esc(s.title)}">${svgIcon(s.icon, 'archive')}<span>${esc(s.title)}</span><b></b></button>`)
    .join('');
  requestAnimationFrame(() => moveIndicator('#filters'));
}

function srcEmpty(title, text = '', busy = false) {
  $('#srcEmpty').classList.toggle('hidden', !title);
  if (!title) return;
  $('#srcEmptyTitle').innerHTML = busy ? `<span class="spinner sm"></span> ${esc(title)}` : esc(title);
  $('#srcEmptyText').textContent = text;
}

function srcFilterText() {
  return $('#srcFilter').value.trim().toLowerCase();
}

async function openSource(id) {
  const s = srcCatalog.find(x => x.id === id);
  if (!s) return;
  showView('source');
  $('#viewTitle').textContent = s.title;
  if (srcState.id === id && srcState.cats.length) return srcState.cat ? renderSrcRows() : renderSrcGrid();
  Object.assign(srcState, { id, title: s.title, cats: [], cat: null, list: [], token: srcState.token + 1 });
  srcState.picked.clear();
  const token = srcState.token;
  $('#srcFilter').value = '';
  $('#srcGrid').innerHTML = '';
  $('#srcRows').innerHTML = '';
  $('#srcTools').classList.add('hidden');
  $('#srcBack').classList.add('hidden');
  $('#srcInfo').textContent = '';
  srcEmpty('Loading…', '', true);
  try {
    const cats = await api.sourceCategories(id);
    if (token !== srcState.token) return;
    srcState.cats = cats;
    renderSrcGrid();
  } catch (e) {
    if (token === srcState.token) srcEmpty("Couldn't load this source", cleanErr(e));
  }
}

function renderSrcGrid() {
  const q = srcFilterText();
  const all = srcState.cats.filter(c => !c.hidden);
  const cats = all.filter(c => !q || `${c.name} ${c.group || ''}`.toLowerCase().includes(q));
  const s = srcCurrent();
  $('#srcRows').innerHTML = '';
  $('#srcTools').classList.add('hidden');
  $('#srcRegions').classList.add('hidden');
  $('#srcBack').classList.add('hidden');
  $('#srcFilter').placeholder = s.searchable ? `Search ${s.title} (Enter)` : `Filter ${(s.categoryLabel || 'categories').toLowerCase()}`;
  $('#srcInfo').textContent = `${all.length} ${(s.categoryLabel || 'categories').toLowerCase()}`;
  let group = null;
  let i = 0;
  $('#srcGrid').innerHTML = cats
    .map(c => {
      const head = c.group && c.group !== group ? `<div class="src-group">${esc(c.group)}</div>` : '';
      group = c.group;
      return `${head}<button class="src-tile" data-cat="${esc(c.id)}" style="animation-delay:${Math.min(i++, 24) * 14}ms">
        <span class="art">${svgIcon(c.icon, 'archive')}</span><strong>${esc(c.name)}</strong>${c.detail ? `<small>${esc(c.detail)}</small>` : ''}</button>`;
    })
    .join('');
  srcEmpty(cats.length ? '' : all.length ? (s.searchable ? 'Press Enter to search' : 'Nothing matches the filter') : 'This source is empty');
}

async function openSrcCategory(catId) {
  const cat = srcState.cats.find(c => c.id === catId);
  if (!cat) return;
  srcState.cat = cat;
  srcState.picked.clear();
  srcState.list = [];
  srcState.region = 'all';
  const token = ++srcState.token;
  $('#srcFilter').value = '';
  $('#srcFilter').placeholder = `Filter ${cat.name}`;
  $('#srcGrid').innerHTML = '';
  $('#srcRows').innerHTML = '';
  $('#srcBack').classList.remove('hidden');
  $('#srcBackLabel').textContent = srcCurrent().categoryLabel || 'Back';
  $('#viewTitle').textContent = `${srcState.title} · ${cat.name}`;
  $('#srcInfo').textContent = '';
  $('#srcTools').classList.add('hidden');
  $('#srcRegions').classList.add('hidden');
  const key = `${srcState.id}|${catId}`;
  try {
    if (!srcLists.has(key)) {
      srcEmpty(`Loading ${cat.name}…`, 'Big platforms can take a moment.', true);
      srcLists.set(key, await (cat.search ? api.sourceSearch(srcState.id, cat.search) : api.sourceList(srcState.id, catId)));
    }
    if (token !== srcState.token) return;
    srcState.list = srcLists.get(key);
    renderSrcRows();
  } catch (e) {
    if (token === srcState.token) srcEmpty(`Couldn't load ${cat.name}`, cleanErr(e));
  }
}

function srcShown() {
  const q = srcFilterText();
  const words = q.split(/\s+/).filter(Boolean);
  const region = srcState.region;
  return srcState.list.filter(r => {
    if (region !== 'all' && !(region === 'other' ? !r.regions?.some(x => srcTopRegions.includes(x)) : r.regions?.includes(region))) return false;
    const t = r.title.toLowerCase();
    return words.every(w => t.includes(w));
  });
}

// Region chips: the most common regions in this list, the rest under "Other".
let srcTopRegions = [];
function renderSrcRegions() {
  const counts = new Map();
  for (const r of srcState.list) for (const x of r.regions || []) counts.set(x, (counts.get(x) || 0) + 1);
  srcTopRegions = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([x]) => x);
  const other = srcState.list.filter(r => !r.regions?.some(x => srcTopRegions.includes(x))).length;
  const chips = [['all', 'All', srcState.list.length], ...srcTopRegions.map(x => [x, x, counts.get(x)]), ...(other && srcTopRegions.length ? [['other', 'Other', other]] : [])];
  $('#srcRegions').classList.toggle('hidden', !srcTopRegions.length);
  $('#srcRegions').innerHTML = chips
    .map(([id, label, n]) => `<button type="button" data-region="${esc(id)}" class="${srcState.region === id ? 'on' : ''}">${esc(label)}<b>${n.toLocaleString()}</b></button>`)
    .join('');
}

// A row's art is one https URL or a list of them; on a load error the next one is tried.
const artList = r => (Array.isArray(r.art) ? r.art : [r.art]).filter(u => /^https:\/\//.test(u || ''));
const artImg = r => {
  const [first, ...rest] = artList(r);
  return first ? `<img loading="lazy" decoding="async" alt="" src="${esc(first)}" data-next="${esc(rest.join(' '))}" />` : '';
};

function srcCard(r, i, on) {
  const regions = (r.regions || []).map(x => `<span class="chip">${esc(x)}</span>`).join('');
  const art = artImg(r);
  return `<div class="shop-card${on ? ' sel' : ''}${srcCurrent().artShape === 'portrait' ? ' portrait' : ''}" data-id="${esc(r.id)}" title="${esc(r.title)}" style="animation-delay:${Math.min(i, 24) * 14}ms">
    <div class="shop-art cover">${art}${svgIcon(srcState.cat?.icon, 'image')}<span class="check${on ? ' on' : ''}">${icon('check')}</span></div>
    <div class="shop-info"><strong>${esc(r.label || r.title)}</strong>
      <div class="shop-meta">${regions}${r.tags?.length ? `<span class="tagline">${esc(r.tags.join(' · '))}</span>` : ''}</div>
      <small>${r.size ? bytes(r.size) : ''}</small></div></div>`;
}

function renderSrcRows() {
  const shown = srcShown();
  const drawn = shown.slice(0, SHOW_MAX);
  const hasArt = srcState.list.some(r => r.art);
  const grid = hasArt && srcLayout === 'grid';
  $('#srcGrid').innerHTML = '';
  $('#srcTools').classList.toggle('hidden', !srcState.list.length);
  $('#srcLayout').classList.toggle('hidden', !hasArt);
  $$('#srcLayout button').forEach(b => b.classList.toggle('on', b.dataset.layout === (grid ? 'grid' : 'list')));
  $('#srcRows').classList.toggle('shop-grid', grid);
  $('#srcRows').classList.toggle('results', !grid);
  renderSrcRegions();
  $('#srcInfo').textContent = shown.length > SHOW_MAX
    ? `Showing ${SHOW_MAX} of ${shown.length.toLocaleString()}, type to narrow`
    : `${shown.length.toLocaleString()}${shown.length !== srcState.list.length ? ` of ${srcState.list.length.toLocaleString()}` : ''} files`;
  $('#srcRows').innerHTML = drawn
    .map((r, i) => {
      const on = srcState.picked.has(r.id);
      if (grid) return srcCard(r, i, on);
      const art = artImg(r);
      return `<div class="row result src-row${on ? ' sel' : ''}${hasArt ? ' has-art' : ''}" data-id="${esc(r.id)}" style="animation-delay:${Math.min(i, 15) * 18}ms">
        <span class="check${on ? ' on' : ''}">${icon('check')}</span>${hasArt ? `<span class="cover">${art}${icon('image')}</span>` : ''}
        <div class="body"><div class="title"><span class="name" title="${esc(r.title)}">${esc(r.title)}</span></div>
          ${r.detail ? `<div class="meta"><span>${esc(r.detail)}</span></div>` : ''}</div>
        <div class="side"><span class="size">${r.size ? bytes(r.size) : ''}</span></div></div>`;
    })
    .join('');
  srcEmpty(drawn.length ? '' : srcState.list.length ? 'Nothing matches the filter' : 'No files here yet');
  renderSrcSel();
}

function renderSrcSel() {
  const picked = srcState.list.filter(r => srcState.picked.has(r.id));
  const size = picked.reduce((a, r) => a + (r.size || 0), 0);
  $('#srcSel').textContent = picked.length ? `${picked.length} selected${size ? ` · ${bytes(size)}` : ''}` : 'Tick the files you want';
  $('#srcStart').disabled = !picked.length;
  const shown = srcShown();
  const all = shown.length && shown.every(r => srcState.picked.has(r.id));
  $('#srcAll').classList.toggle('on', !!all);
  $('#srcAll').classList.toggle('part', !all && shown.some(r => srcState.picked.has(r.id)));
}

// Files from the same collection torrent become one download with all their picks; picks for a torrent
// that's already in the list are added to it instead of starting a duplicate.
async function startSrcPicked(picks = srcState.list.filter(r => srcState.picked.has(r.id))) {
  if (!picks.length) return;
  const btn = $('#srcStart');
  btn.disabled = true;
  $('#srcSel').innerHTML = `<span class="spinner sm"></span> Getting ${picks.length} file${picks.length > 1 ? 's' : ''} ready…`;
  try {
    const got = await api.sourceResolve(srcState.id, picks);
    // File-host links (no torrent) go to LinkGrabber, one package per pick, where they're checked and routed.
    const hosted = got.filter(g => !g.magnet && g.links?.length);
    for (const g of hosted) addToGrabber((await api.parse(g.links.join('\n'))).map(e => ({ ...e, package: g.title, autoPackage: g.title })), false);
    if (hosted.length) toast('ok', `${hosted.length} game${hosted.length > 1 ? 's' : ''} sent to LinkGrabber`, 'Check the links there and press Start. File hosts usually need TorBox or Real-Debrid.');
    const byHash = new Map();
    for (const g of got.filter(x => x.magnet)) {
      const k = g.infoHash || g.magnet;
      const e = byHash.get(k) || { ...g, titles: [], selectedFiles: [], size: 0 };
      e.titles.push(g.title);
      e.selectedFiles.push(...(g.selectedFiles || []));
      e.size += g.size || 0;
      byHash.set(k, e);
    }
    const fresh = [];
    let merged = 0;
    for (const e of byHash.values()) {
      const files = [...new Set(e.selectedFiles)].sort((a, b) => a - b);
      const existing = e.infoHash && items.find(i => i.infoHash === e.infoHash && i.via === 'p2p');
      if (existing) {
        if (existing.selectedFiles) await api.update([existing.id], { selectedFiles: [...new Set([...existing.selectedFiles, ...files])].sort((a, b) => a - b) });
        merged += e.titles.length;
        continue;
      }
      const name = e.titles.length === 1 ? e.titles[0] : `${srcState.cat.name} · ${e.titles.length} files`;
      fresh.push({ kind: 'torrent', via: 'p2p', source: e.magnet, infoHash: e.infoHash, name, selectedFiles: files.length ? files : undefined, size: e.size || undefined, dir: settings.downloadDir });
    }
    const n = fresh.length ? await api.add(fresh) : 0;
    for (const p of picks) srcState.picked.delete(p.id);
    renderSrcRows();
    const parts = [n && `${n} download${n > 1 ? 's' : ''} started`, merged && `${merged} file${merged > 1 ? 's' : ''} added to a running download`].filter(Boolean);
    const torrents = got.length - hosted.length;
    if (torrents) toast('ok', `${torrents} file${torrents === 1 ? '' : 's'} on the way`, parts.join(' · ') || 'Already in your downloads');
    if (got.length < picks.length) toast('err', `${picks.length - got.length} file${picks.length - got.length > 1 ? 's' : ''} couldn't be fetched`, `${srcState.title} didn't answer for them. Tick them and press Start again.`);
  } catch (e) {
    toast('err', "Couldn't start the download", cleanErr(e));
    renderSrcSel();
  }
}

$('#filters').addEventListener('click', e => {
  const b = e.target.closest('button[data-source]');
  if (!b) return;
  $$('#filters button').forEach(x => x.classList.toggle('active', x === b));
  moveIndicator('#filters');
  openSource(b.dataset.source);
});
$('#srcGrid').addEventListener('click', e => {
  const t = e.target.closest('.src-tile');
  if (t) openSrcCategory(t.dataset.cat);
});
// A card opens its detail page when there's more to show; the tick box always just picks it.
const srcCurrent = () => srcCatalog.find(s => s.id === srcState.id) || {};
const hasDetail = r => srcCurrent().info || r.description || r.screens?.length || r.facts?.length;
$('#srcRows').addEventListener('click', e => {
  const row = e.target.closest('.src-row, .shop-card');
  if (!row) return;
  const id = row.dataset.id;
  const r = srcState.list.find(x => x.id === id);
  if (r && row.classList.contains('shop-card') && !e.target.closest('.check') && hasDetail(r)) return openSrcDetail(r);
  const on = !srcState.picked.has(id);
  if (on) srcState.picked.add(id);
  else srcState.picked.delete(id);
  row.classList.toggle('sel', on);
  row.querySelector('.check').classList.toggle('on', on);
  renderSrcSel();
});
// No cover for that game: keep the placeholder icon.
$('#srcRows').addEventListener(
  'error',
  e => {
    const img = e.target;
    if (!img.matches?.('.cover img')) return;
    const [next, ...rest] = (img.dataset.next || '').split(' ').filter(Boolean);
    if (!next) return img.remove();
    img.dataset.next = rest.join(' ');
    img.src = next;
  },
  true
);
$('#srcRows').addEventListener('load', e => e.target.matches?.('.cover img') && e.target.parentNode.classList.add('loaded'), true);
$('#srcRegions').addEventListener('click', e => {
  const b = e.target.closest('[data-region]');
  if (!b) return;
  srcState.region = b.dataset.region;
  renderSrcRows();
});
$('#srcLayout').addEventListener('click', e => {
  const b = e.target.closest('[data-layout]');
  if (!b) return;
  srcLayout = b.dataset.layout;
  try {
    localStorage.setItem('srcLayout', srcLayout);
  } catch {}
  renderSrcRows();
});
$('#srcAll').addEventListener('click', () => {
  const shown = srcShown();
  const all = shown.every(r => srcState.picked.has(r.id));
  for (const r of shown) all ? srcState.picked.delete(r.id) : srcState.picked.add(r.id);
  renderSrcRows();
});
$('#srcBack').addEventListener('click', () => {
  srcState.cat = null;
  srcState.list = [];
  srcState.picked.clear();
  srcState.token++;
  $('#srcFilter').value = '';
  $('#viewTitle').textContent = srcState.title;
  renderSrcGrid();
});
let srcFilterTimer = null;
$('#srcFilter').addEventListener('input', () => {
  clearTimeout(srcFilterTimer);
  srcFilterTimer = setTimeout(() => (srcState.cat ? renderSrcRows() : renderSrcGrid()), 120);
});
$('#srcStart').addEventListener('click', () => startSrcPicked());

// ---------- detail page (shop "product page") ----------
let detailRow = null;
const paragraphs = t =>
  String(t || '')
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
// Rows can list their files with a choice of mirrors: downloads: [{ label, note?, selected?, mirrors: [{ name, url }] }].
// The detail page then shows a tick box and a host picker per file; the last host picked is remembered per source.
const hostKey = () => `srcHost:${srcState.id}`;
const preferredHost = () => {
  try {
    return localStorage.getItem(hostKey()) || '';
  } catch {
    return '';
  }
};
function dlState(r) {
  if (!r._dl) {
    const pref = preferredHost();
    r._dl = (r.downloads || []).map(d => ({ on: d.selected !== false, host: (d.mirrors.find(m => m.name === pref) || d.mirrors[0])?.name }));
  }
  return r._dl;
}
function downloadsHtml(r) {
  const files = r.downloads || [];
  if (!files.length) return '';
  const st = dlState(r);
  const hosts = [...new Set(files.flatMap(d => d.mirrors.map(m => m.name)))];
  const n = st.filter(s => s.on).length;
  return `<div class="sd-dl">
      <div class="sd-dl-head"><h3>Downloads</h3><span class="grow"></span>
        <label class="muted">Host for all <select data-dl-all><option value="">Pick…</option>${hosts.map(h => `<option>${esc(h)}</option>`).join('')}</select></label></div>
      ${files
        .map((d, i) => `<div class="sd-dl-row${st[i].on ? ' on' : ''}">
          <span class="check${st[i].on ? ' on' : ''}" data-dl-tick="${i}">${icon('check')}</span>
          <div class="sd-dl-name"><b>${esc(d.label)}</b>${d.note ? `<small>${esc(d.note)}</small>` : ''}</div>
          <select data-dl-host="${i}">${d.mirrors.map(m => `<option${m.name === st[i].host ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
        </div>`)
        .join('')}
      <div class="hrow end"><span class="muted">File hosts go through LinkGrabber; most need TorBox or Real-Debrid.</span><span class="grow"></span>
        <button type="button" class="btn primary" data-sd="dl"${n ? '' : ' disabled'}>${icon('download')}Download ${n} file${n === 1 ? '' : 's'}</button></div>
    </div>`;
}
async function downloadPicked(r) {
  const st = dlState(r);
  const links = (r.downloads || []).map((d, i) => st[i].on && d.mirrors.find(m => m.name === st[i].host)?.url).filter(Boolean);
  if (!links.length) return;
  addToGrabber((await api.parse(links.join('\n'))).map(e => ({ ...e, package: r.label || r.title, autoPackage: r.label || r.title })), false);
  toast('ok', `${links.length} file${links.length > 1 ? 's' : ''} sent to LinkGrabber`, `${r.label || r.title}: check them there and press Start.`);
}

function renderSrcDetail(r, loading) {
  const [cover] = artList(r);
  const on = srcState.picked.has(r.id);
  const regions = (r.regions || []).map(x => `<span class="chip">${esc(x)}</span>`).join('');
  const facts = [...(r.facts || []), ...(r.size ? [['Size', bytes(r.size)]] : [])];
  const shots = (r.screens || []).filter(u => /^https:\/\//.test(u));
  $('#srcDetail').innerHTML = `<div class="sd-panel card">
      <button type="button" class="x sd-close" title="Close">${icon('x')}</button>
      <div class="sd-top">
        <div class="sd-cover${srcCurrent().artShape === 'portrait' ? ' portrait' : ''}">${cover ? `<img alt="" src="${esc(cover)}" />` : svgIcon(srcState.cat?.icon, 'image')}</div>
        <div class="sd-head">
          <h2>${esc(r.label || r.title)}</h2>
          <div class="shop-meta">${regions}${r.tags?.length ? `<span class="tagline">${esc(r.tags.join(' · '))}</span>` : ''}</div>
          ${facts.length ? `<dl class="sd-facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
          <div class="hrow">
            <button type="button" class="btn ghost" data-sd="pick">${icon(on ? 'check' : 'plus')}${on ? 'Selected' : 'Select'}</button>
            <button type="button" class="btn primary" data-sd="get">${icon('download')}Download</button>
            ${r.link && /^https:\/\//.test(r.link) ? `<span class="muted ell" title="${esc(r.link)}">${esc(new URL(r.link).host)}</span>` : ''}
          </div>
        </div>
      </div>
      ${downloadsHtml(r)}
      ${shots.length ? `<div class="sd-shots">${shots.map(u => `<img loading="lazy" alt="" src="${esc(u)}" />`).join('')}</div>` : ''}
      <div class="sd-desc">${loading ? '<span class="spinner sm"></span> Loading details…' : paragraphs(r.description) || '<p class="muted">No description.</p>'}</div>
    </div>`;
}
async function openSrcDetail(r) {
  detailRow = r;
  $('#srcDetail').classList.remove('hidden');
  const needInfo = srcCurrent().info && !r.infoLoaded;
  renderSrcDetail(r, needInfo);
  $('#srcDetail .sd-panel').scrollTop = 0;
  if (!needInfo) return;
  const hadArt = artList(r).length;
  try {
    Object.assign(r, await api.sourceInfo(srcState.id, r), { infoLoaded: true });
  } catch (e) {
    r.description = r.description || `Couldn't load the details: ${cleanErr(e)}`;
  }
  if (detailRow === r) renderSrcDetail(r);
  if (!hadArt && artList(r).length) renderSrcRows();
}
const closeSrcDetail = () => {
  detailRow = null;
  $('#srcDetail').classList.add('hidden');
};
$('#srcDetail').addEventListener('click', e => {
  if (e.target === e.currentTarget || e.target.closest('.sd-close')) return closeSrcDetail();
  const tick = e.target.closest('[data-dl-tick]')?.dataset.dlTick;
  if (tick !== undefined && detailRow) {
    const s = dlState(detailRow)[tick];
    s.on = !s.on;
    return renderSrcDetail(detailRow);
  }
  const act = e.target.closest('[data-sd]')?.dataset.sd;
  if (!act || !detailRow) return;
  if (act === 'dl' || (act === 'get' && detailRow.downloads?.length)) {
    downloadPicked(detailRow);
    return closeSrcDetail();
  }
  if (act === 'get') {
    startSrcPicked([detailRow]);
    return closeSrcDetail();
  }
  srcState.picked.has(detailRow.id) ? srcState.picked.delete(detailRow.id) : srcState.picked.add(detailRow.id);
  renderSrcDetail(detailRow);
  renderSrcRows();
});
$('#srcDetail').addEventListener('change', e => {
  if (!detailRow) return;
  const sel = e.target.closest('select');
  if (!sel) return;
  const st = dlState(detailRow);
  const host = sel.value;
  if (sel.matches('[data-dl-all]')) {
    if (!host) return;
    // every file that has this host switches to it; the others keep theirs
    detailRow.downloads.forEach((d, i) => d.mirrors.some(m => m.name === host) && (st[i].host = host));
  } else st[sel.dataset.dlHost].host = host;
  try {
    localStorage.setItem(hostKey(), host);
  } catch {}
  renderSrcDetail(detailRow);
});
$('#srcDetail').addEventListener('error', e => e.target.matches?.('.sd-shots img') && e.target.remove(), true);
document.addEventListener('keydown', e => e.key === 'Escape' && detailRow && closeSrcDetail());

// ---------- search inside a source (Enter in the filter box on the categories page) ----------
async function searchSource(q) {
  const s = srcCurrent();
  srcState.cats.length || (await openSource(s.id));
  const cat = { id: `search:${q}`, name: `“${q}”`, icon: s.icon, search: q };
  if (!srcState.cats.some(c => c.id === cat.id)) srcState.cats.push({ ...cat, hidden: true });
  openSrcCategory(cat.id);
}
$('#srcFilter').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !srcCurrent().searchable) return;
  const q = $('#srcFilter').value.trim();
  if (q) searchSource(q);
});

// ---------- Settings → Plugins ----------
function renderPlugins(list) {
  $('#plugList').innerHTML = list.length
    ? list
        .map(p => {
          const adds = [p.source && 'sidebar source', p.search && 'search'].filter(Boolean).join(' + ');
          const sub = p.error
            ? `<span class="err ell" title="${esc(p.error)}">Doesn't load: ${esc(p.error)}</span>`
            : `${p.description ? `<span class="plug-desc">${esc(p.description)}</span>` : ''}<span class="muted">${esc(p.id)}.js${p.version ? ` · v${esc(p.version)}` : ''}${adds ? ` · adds ${adds}` : ''}${p.enabled ? '' : ' · off'}</span>`;
          return `<div class="mini plug"><label class="switch" title="${p.enabled ? 'Turn off' : 'Turn on'}"><input type="checkbox" data-plug-on="${esc(p.id)}" ${p.enabled ? 'checked' : ''} ${p.error ? 'disabled' : ''} /><i></i></label>
            <span class="grow plug-name"><strong class="ell">${esc(p.name)}</strong>${sub}</span>
            ${p.error ? '' : `<button type="button" class="x" data-plug-share="${esc(p.id)}" title="Save as a .hakobu-plugin file to share">${icon('upload')}</button>`}
            <button type="button" class="x" data-plug-del="${esc(p.id)}" title="Remove">${icon('trash')}</button></div>`;
        })
        .join('')
    : '<div class="muted">No plugins installed. Press Install plugin, or drop a .js plugin file onto this window.</div>';
}

// Install = copy into the plugins folder. Used by the button and by dropping .js files on the window.
async function installedToast(before, list) {
  await pluginsChanged(list);
  const added = list.filter(p => !before.has(p.id));
  if (added.length) toast('ok', `Installed ${added.map(p => p.name).join(', ')}`, added.some(p => p.error) ? "One of them doesn't load, see Settings → Plugins." : 'If it adds a source, it is under Source in the sidebar.');
}
window.installPluginFiles = async files => {
  const before = new Set((await api.plugins()).map(p => p.id));
  await installedToast(before, await api.pluginInstall(files));
};

// After any change: refresh the list and the sidebar; leave a source view whose plugin is gone.
async function pluginsChanged(list) {
  renderPlugins(list || (await api.plugins()));
  srcLists.clear();
  await loadSources();
  if (srcState.id && !srcCatalog.some(s => s.id === srcState.id)) {
    Object.assign(srcState, { id: null, cats: [], cat: null, list: [] });
    if (!$('#view-source').classList.contains('hidden')) showView('downloads');
  } else if (srcState.id) {
    srcState.cats = [];
  }
}

$('#plugAdd').addEventListener('click', async () => {
  const before = new Set((await api.plugins()).map(p => p.id));
  await installedToast(before, await api.pluginAdd());
});
$('#plugDir').addEventListener('click', () => api.openPluginsDir());
$('#plugReload').addEventListener('click', () => pluginsChanged());
$('#plugList').addEventListener('change', async e => {
  const id = e.target.dataset.plugOn;
  if (id !== undefined) await pluginsChanged(await api.pluginToggle(id, e.target.checked));
});
$('#plugList').addEventListener('click', async e => {
  const share = e.target.closest('[data-plug-share]')?.dataset.plugShare;
  if (share !== undefined) {
    if (await api.pluginShare(share)) toast('ok', 'Plugin saved', 'Send the .hakobu-plugin file to anyone with Hakobu: they double-click it to install.');
    return;
  }
  const id = e.target.closest('[data-plug-del]')?.dataset.plugDel;
  if (id === undefined) return;
  if (!(await confirmModal('Remove plugin?', `${id}.js goes to the Recycle Bin. You can restore it from there or add it again later.`))) return;
  await pluginsChanged(await api.pluginRemove(id));
});
// A .hakobu-plugin file was opened (double-click) and installed by the main process.
api.onPluginsChanged(async id => {
  await pluginsChanged();
  const p = (await api.plugins()).find(x => x.id === id);
  if (p) toast(p.error ? 'err' : 'ok', p.error ? `${p.name} doesn't load` : `Installed ${p.name}`, p.error || 'If it adds a source, it is under Source in the sidebar.');
});
const prevViewShown = window.onViewShown;
window.onViewShown = name => {
  prevViewShown?.(name);
  if (name === 'settings') pluginsChanged();
};

loadSources();
