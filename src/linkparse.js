// Pulls magnets, info hashes and http(s) links out of arbitrary pasted text (LinkGrabber).

const HOSTERS = [
  'mega.nz', 'mega.co.nz', 'rapidgator.net', 'rg.to', '1fichier.com', 'nitroflare.com', 'turbobit.net',
  'katfile.com', 'ddownload.com', 'filefactory.com', 'hitfile.net', 'uploadgig.com', 'k2s.cc',
  'keep2share.cc', 'fikper.com', 'mediafire.com', 'gofile.io', 'uptobox.com', 'filespace.com',
  'dailyuploads.net', 'usersdrive.com', 'clicknupload.click', 'hexload.com', 'pixeldrain.com',
  'vikingfile.com', 'vik1ngfile.site', 'akirabox.com', 'akirabox.to', 'buzzheavier.com', 'bzzhr.co', 'datavaults.co', 'fuckingfast.co',
  'qiwi.gg', 'filecrypt.cc', 'megaup.net', 'send.cm', 'krakenfiles.com',
];

function isHoster(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return HOSTERS.some(h => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}

function base32ToHex(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.toUpperCase()) {
    const v = alphabet.indexOf(c);
    if (v < 0) return null;
    bits += v.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

function infoHashFromMagnet(magnet) {
  const m = /xt=urn:btih:([a-z0-9]+)/i.exec(magnet);
  if (!m) return null;
  const h = m[1];
  if (/^[a-f0-9]{40}$/i.test(h)) return h.toLowerCase();
  if (h.length === 32) return base32ToHex(h);
  return null;
}

// BEP 53 "select only": so=0,2,4-6 -> [0, 2, 4, 5, 6]
function selectOnlyFromMagnet(magnet) {
  const m = /[?&]so=([0-9,\-]+)/i.exec(magnet);
  if (!m) return null;
  const out = new Set();
  for (const part of m[1].split(',')) {
    const [a, b] = part.split('-').map(Number);
    if (!Number.isInteger(a)) continue;
    for (let i = a; i <= (Number.isInteger(b) ? Math.min(b, a + 100000) : a); i++) out.add(i);
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}

function nameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : new URL(url).hostname;
  } catch {
    return url;
  }
}

// Video/audio sites go to yt-dlp (lazy require: media.js has no other deps on this file).
const isMediaUrl = url => require('./engine/media').isMediaUrl(url);

function parseLinks(text) {
  const out = [];
  const seen = new Set();
  const push = entry => {
    const key = entry.infoHash || entry.source;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };

  let rest = String(text || '');

  for (const m of rest.match(/magnet:\?[^\s"'<>]+/gi) || []) {
    const magnet = m.replace(/&amp;/g, '&');
    const infoHash = infoHashFromMagnet(magnet);
    let name = infoHash || 'magnet';
    try {
      name = new URLSearchParams(magnet.slice(8)).get('dn') || name;
    } catch {}
    const selectedFiles = selectOnlyFromMagnet(magnet);
    push({ kind: 'torrent', source: magnet, name, infoHash, ...(selectedFiles ? { selectedFiles } : {}) });
  }
  rest = rest.replace(/magnet:\?[^\s"'<>]+/gi, ' ');

  for (let url of rest.match(/https?:\/\/[^\s"'<>]+/gi) || []) {
    url = url.replace(/[),.;\]]+$/, '');
    let isTorrent;
    try {
      isTorrent = /\.torrent$/i.test(new URL(url).pathname);
    } catch {
      continue;
    }
    if (!isTorrent && isMediaUrl(url)) {
      const playlist = /[?&]list=/.test(url) && !/[?&]v=/.test(url);
      push({ kind: 'media', source: url, name: url, playlist });
      continue;
    }
    push({
      kind: isTorrent ? 'torrent' : 'http',
      source: url,
      name: nameFromUrl(url),
      hoster: !isTorrent && isHoster(url),
    });
  }
  rest = rest.replace(/https?:\/\/[^\s"'<>]+/gi, ' ');

  // Bare 40-char info hashes.
  for (const h of rest.match(/\b[a-f0-9]{40}\b/gi) || []) {
    const infoHash = h.toLowerCase();
    push({ kind: 'torrent', source: `magnet:?xt=urn:btih:${infoHash}`, name: infoHash, infoHash });
  }

  return out;
}

module.exports = { parseLinks, infoHashFromMagnet, selectOnlyFromMagnet, isHoster, HOSTERS };
