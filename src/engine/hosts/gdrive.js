// Google Drive: shared files and folders ("anyone with the link"). Big files show a virus-scan warning page first;
// its form holds the confirm token. "Quota exceeded" means too many people downloaded it today: the queue waits.
// Extra page messages from JDownloader 2 (GPL-3.0-or-later, JD-Team), jd/plugins/hoster/GoogleDrive.java r53450,
// source mirror commit 6ab1aecd of 2026-11-02.
const { getText, hostIn, decodeHtml, HostError, gone } = require('./common');

const fileId = url => {
  const u = String(url);
  return (/\/file\/d\/([\w-]{10,})/.exec(u) || /[?&]id=([\w-]{10,})/.exec(u) || /\/uc\?.*id=([\w-]{10,})/.exec(u))?.[1] || null;
};
const folderId = url => /\/(?:drive\/(?:u\/\d+\/)?folders|folderview\?id=|embeddedfolderview\?id=)\/?([\w-]{10,})/.exec(String(url))?.[1] || null;
const isFolderUrl = url => /\/folders\/|folderview\?id=/.test(String(url));
// Google Docs, Sheets and Slides have no file to download: they're exported as Office files.
const EXPORTS = { document: 'docx', spreadsheets: 'xlsx', presentation: 'pptx' };
const docOf = url => {
  const m = /docs\.google\.com\/(document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\/([\w-]{10,})/.exec(String(url));
  return m ? { kind: m[1], id: m[2], format: EXPORTS[m[1]] } : null;
};
const withExt = (name, ext) => (name.toLowerCase().endsWith('.' + ext) ? name : `${name}.${ext}`);

// The warning page's form: <form id="download-form" action="..."> with hidden inputs.
function confirmUrl(html) {
  const form = /<form[^>]+id="download-form"[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (!form) return null;
  const u = new URL(decodeHtml(form[1]));
  for (const m of form[2].matchAll(/<input[^>]+type="hidden"[^>]*>/gi)) {
    const name = /name="([^"]+)"/.exec(m[0])?.[1];
    const value = /value="([^"]*)"/.exec(m[0])?.[1] ?? '';
    if (name) u.searchParams.set(name, decodeHtml(value));
  }
  return u.href;
}

function pageError(html) {
  if (/but your computer or network may be sending automated queries/i.test(html)) return new HostError('Google Drive is limiting your connection: solve its check in the window', { browser: true });
  if (/>\s*Sorry, this file is infected with a virus/.test(html)) return new HostError('Google Drive: this file is infected with a virus', { permanent: true });
  if (/<p class="error-caption"[^>]*>\s*Sorry, we are unable to retrieve this document/.test(html)) return gone('Google Drive');
  if (/Too many users have viewed or downloaded this file|download quota|quota exceeded/i.test(html)) {
    return new HostError('Google Drive: download quota for this file is used up for today', { wait: 60 * 60000 });
  }
  if (/ServiceLogin|accounts\.google\.com\/v3\/signin|You need access|Request access/i.test(html)) {
    return new HostError("Google Drive: this file isn't shared publicly", { permanent: true });
  }
  if (/Sorry, the file you have requested does not exist|404\. That’s an error/i.test(html)) return gone('Google Drive');
  return null;
}

async function exportDoc(doc, ctx) {
  const url = `https://docs.google.com/${doc.kind}/d/${doc.id}/export?format=${doc.format}`;
  const res = await require('./common').fetcher(ctx)(url, { headers: { Range: 'bytes=0-0' } });
  await res.body?.cancel().catch(() => {});
  if (res.status === 404) throw gone('Google Docs');
  if (/text\/html/i.test(res.headers.get('content-type') || '')) throw new HostError("Google Docs: this document isn't shared publicly", { browser: true });
  return { url, headers: {} };
}

async function resolve(url, ctx) {
  const doc = docOf(url);
  if (doc) return exportDoc(doc, ctx);
  const id = fileId(url);
  if (!id || isFolderUrl(url)) throw new HostError('Google Drive: this is a folder link; add it to LinkGrabber to see its files', { permanent: true });
  const first = `https://drive.usercontent.google.com/download?id=${id}&export=download`;
  const res = await require('./common').fetcher(ctx)(first, { headers: { Range: 'bytes=0-0' } });
  const type = res.headers.get('content-type') || '';
  if (!/text\/html/i.test(type) || res.status === 416) {
    // 416: an empty file (no byte 0 to send); it downloads like any other.
    await res.body?.cancel().catch(() => {});
    if (res.status === 404) throw gone('Google Drive');
    return { url: first, headers: {} };
  }
  const html = await res.text();
  const err = pageError(html);
  if (err) throw err;
  const next = confirmUrl(html);
  if (!next) throw new HostError('Google Drive showed a page Hakobu does not understand', { browser: true });
  return { url: next, headers: {} };
}

// <div class="flip-entry" id="entry-ID"> ... <a href=".../file/d/ID/view"> ... <div class="flip-entry-title">name</div>
function parseFolder(html) {
  const title = decodeHtml(/<title>([^<]*)<\/title>/i.exec(html)?.[1] || '').replace(/ - Google Drive$/, '').trim();
  const files = [];
  const folders = [];
  for (const m of html.matchAll(/<div class="flip-entry" id="entry-([\w-]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="flip-entry-title">([^<]*)<\/div>/g)) {
    const [, id, href, name] = m;
    (/\/folders\//.test(href) ? folders : files).push({ id, name: decodeHtml(name).trim(), doc: docOf(decodeHtml(href)) });
  }
  return { title, files, folders };
}

async function crawl(url, ctx) {
  const root = folderId(url);
  if (!root) return null;
  const links = [];
  let top = null;
  const walk = async (id, sub, depth) => {
    const { res, text } = await getText(ctx, `https://drive.google.com/embeddedfolderview?id=${id}`);
    if (res.status === 404) throw gone('Google Drive folder');
    const err = pageError(text);
    if (err && !depth) throw err;
    const f = parseFolder(text);
    top = top ?? (f.title || 'Google Drive folder');
    for (const file of f.files) {
      const d = file.doc;
      links.push(
        d
          ? { source: `https://docs.google.com/${d.kind}/d/${d.id}/edit`, name: withExt(file.name, d.format), subfolder: sub }
          : { source: `https://drive.google.com/file/d/${file.id}/view`, name: file.name, subfolder: sub },
      );
    }
    if (depth < 6) for (const d of f.folders) await walk(d.id, [sub, d.name].filter(Boolean).join('/'), depth + 1);
  };
  await walk(root, '', 0);
  return { package: top, links };
}

module.exports = {
  id: 'gdrive',
  name: 'Google Drive',
  test: hostIn('drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'),
  free: true,
  isFolder: url => !!folderId(url),
  resolve,
  crawl,
  _test: { confirmUrl, parseFolder, fileId, folderId, pageError, docOf },
};
