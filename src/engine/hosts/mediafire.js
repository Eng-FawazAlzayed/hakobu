// MediaFire: file pages carry the direct link on their download button; folders are listed through MediaFire's public API.
// Extra link patterns from JDownloader 2 (GPL-3.0-or-later, JD-Team), jd/plugins/hoster/MediafireCom.java r53182,
// source mirror commit 6ab1aecd of 2026-11-02.
const { getText, getJson, hostIn, decodeHtml, HostError, gone } = require('./common');

const keyOf = url => {
  const u = String(url);
  return (/\/(?:file|file_premium|download|view)\/([a-z0-9]+)/i.exec(u) || /mediafire\.com\/\?([a-z0-9]+)/i.exec(u))?.[1] || null;
};
const folderOf = url => /\/folder\/([a-z0-9]+)/i.exec(String(url))?.[1] || null;

// The button's href, or its base64 "data-scrambled-url" on newer pages.
function linkFromPage(html) {
  let m = /kNO\s*=\s*"(https?:\/\/.*?)"/.exec(html) || /href\s*=\s*"(https?:\/\/[^"]+)"\s*id\s*=\s*"downloadButton"/i.exec(html) || /id="downloadButton"[^>]*?href="(https?:\/\/[^"]+)"/i.exec(html) || /href="(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"/i.exec(html);
  if (m) return decodeHtml(m[1]);
  m = /data-scrambled-url="([^"]+)"/i.exec(html);
  if (m) {
    const url = Buffer.from(m[1], 'base64').toString('utf8');
    if (/^https?:\/\//.test(url)) return url;
  }
  return null;
}

async function info(key, ctx) {
  const { data } = await getJson(ctx, `https://www.mediafire.com/api/1.5/file/get_info.php?quick_key=${key}&response_format=json`);
  const f = data?.response?.file_info;
  return f ? { filename: f.filename, size: Number(f.size) || null, hash: f.hash ? { algo: 'sha256', value: f.hash } : null } : null;
}

async function resolve(url, ctx) {
  const key = keyOf(url);
  if (!key) throw new HostError('MediaFire: this is a folder link; add it to LinkGrabber to see its files', { permanent: true });
  const { res, text } = await getText(ctx, `https://www.mediafire.com/file/${key}/file`);
  if (res.status === 404 || /error\.php|File Removed|Invalid or Deleted File/i.test(res.url + text.slice(0, 20000))) throw gone('MediaFire');
  const link = linkFromPage(text);
  if (!link) {
    if (/dangerous|suspicious|captcha/i.test(text)) throw new HostError('MediaFire wants a person to confirm this download', { browser: true });
    throw new HostError("MediaFire's page had no download link", { browser: true });
  }
  const meta = await info(key, ctx).catch(() => null);
  return { url: link, headers: { Referer: 'https://www.mediafire.com/' }, ...(meta || {}) };
}

async function check(url, ctx) {
  const key = keyOf(url);
  if (!key) return null;
  const meta = await info(key, ctx);
  return meta ? { status: 'online', filename: meta.filename, size: meta.size } : { status: 'offline', error: 'MediaFire: file not found' };
}

async function crawl(url, ctx) {
  const root = folderOf(url);
  if (!root) return null;
  const links = [];
  let name = null;
  const walk = async (fk, sub, depth) => {
    if (name === null) {
      const { data } = await getJson(ctx, `https://www.mediafire.com/api/1.5/folder/get_info.php?folder_key=${fk}&response_format=json`);
      name = data?.response?.folder_info?.name || `MediaFire ${fk}`;
    }
    for (const type of ['files', 'folders']) {
      for (let chunk = 1; chunk < 50; chunk++) {
        const { data } = await getJson(ctx, `https://www.mediafire.com/api/1.5/folder/get_content.php?folder_key=${fk}&content_type=${type}&chunk=${chunk}&response_format=json`);
        const c = data?.response?.folder_content;
        if (!c) {
          if (chunk === 1 && type === 'files') throw gone('MediaFire folder');
          break;
        }
        if (type === 'files') {
          for (const f of c.files || []) {
            links.push({ source: `https://www.mediafire.com/file/${f.quickkey}/${encodeURIComponent(f.filename)}/file`, name: f.filename, size: Number(f.size) || null, subfolder: sub, check: { status: 'online' } });
          }
        } else if (depth < 6) {
          for (const d of c.folders || []) await walk(d.folderkey, [sub, d.name].filter(Boolean).join('/'), depth + 1);
        }
        if (c.more_chunks !== 'yes') break;
      }
    }
  };
  await walk(root, '', 0);
  return { package: name, links };
}

module.exports = { id: 'mediafire', name: 'MediaFire', test: hostIn('mediafire.com'), free: true, isFolder: url => !!folderOf(url), resolve, check, crawl, _test: { linkFromPage, keyOf } };
