/* global api, icon, hydrateIcons, $, $$, esc, bytes, settings, toast, grab, renderGrab, showView */
// qBittorrent-style "Add torrent" dialog: file tree with checkboxes, route, save folder, cache status.
const TorrentDialog = (() => {
  const queue = [];
  let entry = null; // grabber entry being edited
  let files = []; // [{path, size}]
  let sel = new Set();
  let collapsed = new Set();
  let loadToken = 0;

  const extIcon = name => {
    const ext = name.split('.').pop().toLowerCase();
    if (/^(mkv|mp4|avi|mov|wmv|webm|m4v|ts)$/.test(ext)) return 'film';
    if (/^(mp3|flac|wav|aac|ogg|m4a|opus)$/.test(ext)) return 'music';
    if (/^(zip|rar|7z|tar|gz|iso|bin)$/.test(ext)) return 'archive';
    if (/^(jpe?g|png|gif|webp|bmp)$/.test(ext)) return 'image';
    return 'file';
  };

  // Build a folder tree from flat paths. The torrent's root folder is skipped when every file shares it.
  function buildTree() {
    const root = { name: '', dirs: new Map(), files: [] };
    const parts = files.map(f => f.path.split(/[\\/]/));
    const strip = parts.length > 1 && parts.every(p => p.length > 1 && p[0] === parts[0][0]) ? 1 : 0;
    parts.forEach((p, idx) => {
      let node = root;
      const segs = p.slice(strip);
      segs.slice(0, -1).forEach((seg, d) => {
        const key = segs.slice(0, d + 1).join('/');
        if (!node.dirs.has(seg)) node.dirs.set(seg, { name: seg, key, dirs: new Map(), files: [] });
        node = node.dirs.get(seg);
      });
      node.files.push(idx);
    });
    return root;
  }

  const allIn = node => [...node.files, ...[...node.dirs.values()].flatMap(allIn)];
  const sizeOf = idxs => idxs.reduce((a, i) => a + files[i].size, 0);

  function renderTree() {
    const tree = $('#tdTree');
    const q = $('#tdFilter').value.trim().toLowerCase();
    const out = [];
    let n = 0;
    const walk = (node, depth) => {
      for (const d of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const idxs = allIn(d).filter(i => !q || files[i].path.toLowerCase().includes(q));
        if (!idxs.length) continue;
        const on = idxs.filter(i => sel.has(i)).length;
        const state = on === 0 ? '' : on === idxs.length ? 'on' : 'part';
        const isCollapsed = collapsed.has(d.key) && !q;
        out.push(`<div class="node dir ${isCollapsed ? 'collapsed' : ''} ${on ? '' : 'off'}" data-dir="${esc(d.key)}" style="padding-left:${depth * 20 + 6}px;animation-delay:${Math.min(n++, 20) * 12}ms">
          <span class="twisty">${icon('chevron')}</span><span class="check ${state}">${icon('check')}</span>${icon('folder', 'fi')}
          <span class="nm">${esc(d.name)}</span><span class="sz">${bytes(sizeOf(idxs))}</span></div>`);
        if (!isCollapsed) walk(d, depth + 1);
      }
      for (const i of node.files) {
        const f = files[i];
        if (q && !f.path.toLowerCase().includes(q)) continue;
        const name = f.path.split(/[\\/]/).pop();
        out.push(`<div class="node ${sel.has(i) ? '' : 'off'}" data-file="${i}" style="padding-left:${depth * 20 + 30}px;animation-delay:${Math.min(n++, 20) * 12}ms">
          <span class="check ${sel.has(i) ? 'on' : ''}">${icon('check')}</span>${icon(extIcon(name), 'fi')}
          <span class="nm" title="${esc(f.path)}">${esc(name)}</span><span class="sz">${bytes(f.size)}</span></div>`);
      }
    };
    walk(buildTree(), 0);
    tree.innerHTML = out.join('');
    updateSummary();
  }

  function updateSummary() {
    const all = files.length;
    $('#tdSel').textContent = all ? `${sel.size} of ${all} files · ${bytes(sizeOf([...sel]))} of ${bytes(sizeOf(files.map((_, i) => i)))}` : '';
    const st = sel.size === 0 ? '' : sel.size === all ? 'on' : 'part';
    $('#tdAll').className = `check ${st}`;
    $('#tdStart').disabled = files.length > 0 && sel.size === 0;
  }

  function setRoute(r) {
    entry.via = r;
    $$('#tdRoute button').forEach(b => b.classList.toggle('on', b.dataset.route === r));
  }

  function renderHead() {
    $('#tdName').textContent = entry.name;
    const meta = [];
    if (entry.size) meta.push(`<span>${bytes(entry.size)}</span>`);
    if (files.length) meta.push(`<span>${files.length} file${files.length === 1 ? '' : 's'}</span>`);
    if (entry.infoHash) meta.push(`<span title="Info hash">${entry.infoHash.slice(0, 16)}…</span>`);
    if (entry.cached === true) meta.push(`<span class="tag tag-cached">${icon('bolt')}CACHED ON TORBOX · INSTANT</span>`);
    else if (entry.cached === false) meta.push('<span class="muted">Not cached on TorBox</span>');
    else if (settings.torboxKey && entry.infoHash) meta.push('<span class="muted">Checking TorBox cache…</span>');
    $('#tdMeta').innerHTML = meta.join('');
    $('#tdQueue').classList.toggle('hidden', !queue.length);
    $('#tdQueue').textContent = `+${queue.length} more`;
  }

  async function open(e) {
    entry = e;
    files = e.files || [];
    sel = new Set(Array.isArray(e.selectedFiles) ? e.selectedFiles : files.map((_, i) => i));
    collapsed = new Set();
    $('#tdFilter').value = '';
    $('#tdDir').value = e.dir || $('#grabDir').value || settings.downloadDir;
    $('#tdCat').innerHTML = catOptions(e.category || '');
    $('#tdSeq').checked = !!e.sequential;
    $$('#tdRoute button').forEach(b => {
      const r = b.dataset.route;
      b.disabled = (r === 'torbox' && !settings.torboxKey) || (r === 'realdebrid' && !settings.realdebridToken);
      b.title = b.disabled ? 'Add an API key in Settings → Debrid' : '';
    });
    setRoute(e.via || 'p2p');
    renderHead();
    renderTree();
    $('#tdLoading').classList.toggle('gone', files.length > 0);
    $('#torrentDlg').classList.add('show');

    const token = ++loadToken;
    if (entry.infoHash && entry.cached === undefined && settings.torboxKey) {
      api.checkCached([entry.infoHash]).then(c => {
        if (token !== loadToken) return;
        entry.cached = !!c[entry.infoHash];
        renderHead();
      });
    }
    if (!files.length) {
      try {
        const info = await api.torrentInfo({ source: e.source, torrentB64: e.torrentB64 });
        if (token !== loadToken) return;
        const one = entry.selectedFiles?.length === 1 && info.files[entry.selectedFiles[0]];
        Object.assign(entry, { name: one ? one.path.split(/[\\/]/).pop() : info.name, size: info.size, infoHash: info.infoHash, torrentB64: info.torrentB64, files: info.files });
        files = info.files;
        // a magnet's so= (or a search plugin) may have picked files already
        const pre = (entry.selectedFiles || []).filter(i => i < files.length);
        sel = new Set(pre.length ? pre : files.map((_, i) => i));
        renderHead();
        renderTree();
        $('#tdLoading').classList.add('gone');
      } catch (err) {
        if (token !== loadToken) return;
        $('#tdLoading').innerHTML = `<p>Couldn't get the file list</p><small class="muted">${esc(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))}</small>`;
      }
    }
  }

  function commit() {
    entry.dir = $('#tdDir').value.trim() || settings.downloadDir;
    entry.category = $('#tdCat').value;
    entry.sequential = $('#tdSeq').checked;
    if (files.length) {
      entry.files = files;
      entry.selectedFiles = sel.size === files.length ? null : [...sel].sort((a, b) => a - b);
    }
  }

  function close() {
    loadToken++;
    $('#torrentDlg').classList.remove('show');
    setTimeout(() => {
      $('#tdLoading').innerHTML = '<span class="spinner"></span><p>Fetching the file list from peers…</p><small class="muted">You can download now without picking, or wait.</small>';
      if (queue.length) open(queue.shift());
    }, 260);
  }

  // ---- events ----
  $('#tdTree').addEventListener('click', e => {
    const node = e.target.closest('.node');
    if (!node) return;
    if (node.dataset.file !== undefined) {
      const i = Number(node.dataset.file);
      sel.has(i) ? sel.delete(i) : sel.add(i);
    } else {
      const key = node.dataset.dir;
      if (e.target.closest('.twisty')) {
        collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key);
      } else {
        const find = (n) => (n.key === key ? n : [...n.dirs.values()].map(find).find(Boolean));
        const idxs = allIn(find(buildTree()));
        const allOn = idxs.every(i => sel.has(i));
        idxs.forEach(i => (allOn ? sel.delete(i) : sel.add(i)));
      }
    }
    renderTree();
  });
  $('#tdCat').addEventListener('change', () => {
    const p = settings.categories?.[$('#tdCat').value];
    if (p) $('#tdDir').value = p;
  });
  $('#tdAll').addEventListener('click', () => {
    sel = sel.size === files.length ? new Set() : new Set(files.map((_, i) => i));
    renderTree();
  });
  $('#tdFilter').addEventListener('input', renderTree);
  $$('#tdRoute button').forEach(b => b.addEventListener('click', () => setRoute(b.dataset.route)));
  $('#tdDirBtn').addEventListener('click', async () => {
    const d = await api.pickFolder();
    if (d) $('#tdDir').value = d;
  });
  $('#tdStart').addEventListener('click', async () => {
    commit();
    const { sel: _s, cached, ...rest } = entry;
    const n = await api.add([{ ...rest, package: rest.package || null, paused: $('#grabPaused').checked }]);
    const i = grab.indexOf(entry);
    if (i >= 0) grab.splice(i, 1);
    renderGrab();
    if (n) toast('ok', 'Torrent added', entry.selectedFiles ? `${entry.selectedFiles.length} of ${files.length} files` : entry.name);
    else toast('err', 'Already in your list', entry.name);
    if (!queue.length) showView('downloads');
    close();
  });
  $('#tdGrab').addEventListener('click', () => {
    commit();
    renderGrab();
    close();
  });
  $('#tdSkip').addEventListener('click', () => {
    const i = grab.indexOf(entry);
    if (i >= 0) grab.splice(i, 1);
    renderGrab();
    close();
  });

  return {
    // Show the dialog for each torrent entry, one after another.
    enqueue(entries) {
      queue.push(...entries);
      if (!$('#torrentDlg').classList.contains('show')) open(queue.shift());
    },
    open,
  };
})();
