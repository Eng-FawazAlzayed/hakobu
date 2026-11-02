// YouTube (and other video/audio sites) via yt-dlp. Options follow the YT Batch Downloader handover:
// MP3 with cover art + tags, MP4 capped at a height preferring mp4+m4a (fast remux), playlists into a subfolder,
// progress that folds video+audio parts and playlist position together, friendly errors.
const { spawn, execFile } = require('child_process');
const { abortError } = require('../util');

const MEDIA_SITES = [
  'youtube.com', 'youtu.be', 'youtube-nocookie.com', 'music.youtube.com', 'vimeo.com', 'soundcloud.com', 'twitch.tv', 'dailymotion.com',
  'bandcamp.com', 'tiktok.com', 'x.com', 'twitter.com', 'instagram.com', 'reddit.com', 'v.redd.it', 'bilibili.com', 'nicovideo.jp', 'streamable.com',
];

function isMediaUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\.|^m\./, '');
    return MEDIA_SITES.some(d => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

// 11-character YouTube video id from any of its URL shapes.
function youtubeId(url) {
  const m = /(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/.exec(url || '');
  return m ? m[1] : null;
}
const youtubePlaylist = url => /[?&]list=([A-Za-z0-9_-]+)/.exec(url || '')?.[1] || null;

const isYoutube = url => {
  try {
    return /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

// The sign-in shared by the extension, as a cookies.txt for one yt-dlp run. Only ever for YouTube links.
function sharedCookies(url, settings, youtubeCookies) {
  return settings?.ytCookiesBrowser === 'extension' && isYoutube(url) ? youtubeCookies?.tempFile() || null : null;
}

const SIGN_IN_HOW = 'In your browser, sign in to YouTube, then turn on "Share my YouTube sign-in" in the Hakobu extension.';

// Raw yt-dlp errors -> plain language. usedSignIn: this run already sent the sign-in shared by the extension.
function friendlyError(raw, { usedSignIn = false } = {}) {
  const s = String(raw || '');
  const rules = [
    [/could not copy .*cookie database|failed to decrypt with dpapi|app.?bound/i, `Hakobu can't read this browser's cookies directly. ${SIGN_IN_HOW}`],
    [/could not find .*cookies? database/i, `That browser has no cookies Hakobu can read (Settings → YouTube). ${SIGN_IN_HOW}`],
    [/confirm you.?re not a bot|sign in to confirm/i, usedSignIn
      ? 'YouTube still wants a sign-in, so the one Hakobu has may have expired. Open YouTube in your browser, check you are signed in, then open the Hakobu extension and try again.'
      : `YouTube is asking to confirm you're not a bot, which takes a sign-in. ${SIGN_IN_HOW}`],
    [/HTTP Error 429|Too Many Requests/i, 'YouTube is rate-limiting this connection (HTTP 429). Wait a bit and retry.'],
    [/Private video/i, 'This video is private.'],
    [/members-only|join this channel/i, 'This video is for channel members only.'],
    [/age.?restricted|confirm your age|inappropriate for some users/i, `This video is age-restricted. ${SIGN_IN_HOW}`],
    [/Video unavailable|This video is not available|has been removed/i, 'This video is unavailable (removed, blocked in your country, or the link is wrong).'],
    [/Unsupported URL/i, "yt-dlp doesn't support this site."],
    [/ffmpeg.*not (found|installed)|ffprobe.*not found/i, 'ffmpeg is missing. Settings → Media tools → Install.'],
    [/getaddrinfo|Unable to download webpage.*(timed out|resolve|11001)|No connection|Network is unreachable/i, "Can't reach the site: check your internet connection."],
    [/Requested format is not available/i, 'That quality is not available for this video.'],
    [/n challenge|signature (extraction|solving) failed|js runtime/i, 'YouTube changed something yt-dlp needs to solve. Update the media tools (Settings → Media tools).'],
  ];
  for (const [re, msg] of rules) if (re.test(s)) return msg;
  const line = s.split(/\r?\n/).reverse().find(l => /ERROR:/.test(l)) || s.split(/\r?\n/).filter(Boolean).pop() || 'yt-dlp failed';
  return line.replace(/^.*?ERROR:\s*/, '').replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '').slice(0, 300);
}

const PP_LABEL = {
  ExtractAudio: 'Converting to MP3',
  FFmpegExtractAudio: 'Converting to MP3',
  Merger: 'Merging audio & video',
  FFmpegMerger: 'Merging audio & video',
  EmbedThumbnail: 'Adding cover art',
  FFmpegThumbnailsConvertor: 'Preparing cover art',
  ThumbnailsConvertor: 'Preparing cover art',
  FFmpegMetadata: 'Writing tags',
  Metadata: 'Writing tags',
  MoveFiles: 'Finishing',
  FFmpegVideoRemuxer: 'Remuxing',
  FFmpegFixupM3u8: 'Fixing stream',
  FixupM3u8: 'Fixing stream',
};

const SEP = '␞'; // field separator unlikely to appear in titles

function buildArgs(it, { tools, settings, cookieFile }) {
  const fmt = it.mediaFormat || settings.ytFormat || 'mp4';
  const q = it.mediaQuality || (fmt === 'mp3' ? settings.ytAudioQuality || '192' : settings.ytVideoQuality || '1080');
  const args = [
    '--newline', '--progress', '--no-simulate', '--no-warnings', '--encoding', 'utf-8',
    '--windows-filenames', '--retries', '5', '--fragment-retries', '5', '-N', '4',
    '--ffmpeg-location', tools.dir,
    '--js-runtimes', `deno:${tools.path('deno.exe')}`,
    '-P', it.dir,
    '-o', '%(playlist_title&{}/|)s%(title)s.%(ext)s',
    '--print', `before_dl:[info]%(id)s${SEP}%(title)s${SEP}%(playlist_index|)s${SEP}%(n_entries|)s${SEP}%(format_id)s${SEP}%(playlist_title|)s${SEP}%(uploader|)s`,
    '--print', 'after_move:[done]%(filepath)s',
    '--progress-template',
    // progress lines lose non-ASCII characters and only carry numbers/ids, so a plain | is safe here
    'download:[dl]%(progress.status)s|%(progress.downloaded_bytes|0)s|%(progress.total_bytes|)s|%(progress.total_bytes_estimate|)s|%(progress.speed|0)s|%(progress.eta|)s|%(info.id)s',
    '--progress-template', 'postprocess:[pp]%(progress.postprocessor)s|%(progress.status)s',
    '--embed-metadata', '--embed-thumbnail', '--convert-thumbnails', 'jpg',
  ];
  if (!it.playlist) args.push('--no-playlist'); // watch?v=X&list=Y downloads just X; a pure playlist URL still expands
  if (fmt === 'mp3') {
    args.push('-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', `${q}K`);
  } else {
    const h = q === 'best' ? '' : `[height<=${q}]`;
    args.push('-f', `bv*${h}[ext=mp4]+ba[ext=m4a]/bv*${h}+ba/b${h}/b`, '--merge-output-format', 'mp4');
  }
  if (cookieFile) args.push('--cookies', cookieFile);
  else if (settings.ytCookiesBrowser && settings.ytCookiesBrowser !== 'extension') args.push('--cookies-from-browser', settings.ytCookiesBrowser);
  if (it.limitKB > 0) args.push('--limit-rate', `${it.limitKB}K`);
  args.push('--', it.source);
  return args;
}

class MediaTask {
  constructor(item, { tools, settings, youtubeCookies }) {
    this.item = item;
    this.tools = tools;
    this.settings = settings;
    this.youtubeCookies = youtubeCookies;
    this.aborted = false;
  }

  abort() {
    this.aborted = true;
    // yt-dlp starts ffmpeg children: kill the whole tree
    if (this.proc?.pid) execFile('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  }

  run() {
    const it = this.item;
    if (!this.tools.ready()) return Promise.reject(new Error('Media tools are not installed yet. Settings → Media tools → Install.'));
    const cookies = sharedCookies(it.source, this.settings, this.youtubeCookies);
    const args = buildArgs(it, { tools: this.tools, settings: this.settings, cookieFile: cookies?.file });
    it.files = it.files || [];
    const parts = {}; // video id -> { total parts, done parts }
    let current = null;
    let stderr = '';

    return new Promise((resolve, reject) => {
      const proc = (this.proc = spawn(this.tools.path('yt-dlp.exe'), args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }));
      let buf = '';
      const onLine = line => {
        if (line.startsWith('[info]')) {
          const [id, title, pIndex, nEntries, formatId, pTitle, uploader] = line.slice(6).split(SEP);
          current = id;
          parts[id] = { total: Math.max(1, (formatId || '').split('+').length), done: 0 };
          it.title = title;
          it.name = pTitle && nEntries ? `${pTitle}` : title;
          it.uploader = uploader || it.uploader;
          if (pTitle) it.playlistTitle = pTitle;
          it.playlistIndex = Number(pIndex) || null;
          it.playlistCount = Number(nEntries) || null;
          it.stage = it.playlistCount ? `Downloading ${it.playlistIndex} of ${it.playlistCount}` : 'Downloading';
        } else if (line.startsWith('[dl]')) {
          const [status, done, total, est, speed, eta, id] = line.slice(4).split('|');
          const p = parts[id] || (parts[id] = { total: 1, done: 0 });
          const size = Number(total) || Number(est) || 0;
          let frac = size ? Number(done) / size : 0;
          if (status === 'finished') {
            p.done = Math.min(p.total, p.done + 1);
            frac = 0;
          }
          if (status === 'downloading') {
            const part = p.total > 1 ? (p.done === 0 ? ' video' : ' audio') : '';
            it.stage = it.playlistCount ? `Downloading ${it.playlistIndex} of ${it.playlistCount}${part}` : `Downloading${part}`;
          }
          const itemFrac = Math.min(1, (p.done + frac) / p.total);
          it.progress = it.playlistCount ? (((it.playlistIndex || 1) - 1) + itemFrac) / it.playlistCount : itemFrac;
          it.speed = Number(speed) || 0;
          it.eta = Number(eta) || null;
          if (size && !it.playlistCount) it.size = Math.max(it.size || 0, size);
          if (!it.playlistCount) it.downloaded = Math.round(it.progress * (it.size || 0));
        } else if (line.startsWith('[pp]')) {
          const [pp, status] = line.slice(4).split('|');
          if (status === 'started') {
            it.stage = PP_LABEL[pp] || pp;
            it.speed = 0;
          }
        } else if (line.startsWith('[done]')) {
          const f = line.slice(6).trim();
          if (f && !it.files.includes(f)) it.files.push(f);
          it.filepath = f;
        }
      };
      proc.stdout.on('data', d => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, i).replace(/\r$/, ''));
          buf = buf.slice(i + 1);
        }
      });
      // post-processing progress arrives on stderr, mixed in with warnings and errors
      let ebuf = '';
      proc.stderr.on('data', d => {
        ebuf += d.toString('utf8');
        let i;
        while ((i = ebuf.indexOf('\n')) >= 0) {
          const line = ebuf.slice(0, i).replace(/\r$/, '');
          ebuf = ebuf.slice(i + 1);
          if (line.startsWith('[pp]') || line.startsWith('[dl]')) onLine(line);
          else if ((stderr += line + '\n').length > 20000) stderr = stderr.slice(-10000);
        }
      });
      proc.on('error', e => {
        cookies?.remove();
        reject(e);
      });
      proc.on('close', code => {
        cookies?.remove();
        if (buf) onLine(buf);
        if (this.aborted) return reject(abortError());
        if (code === 0) return resolve();
        const e = new Error(friendlyError(stderr, { usedSignIn: !!cookies }));
        e.raw = stderr.slice(-2000);
        reject(e);
      });
    });
  }
}

// Title / channel / thumbnail for LinkGrabber. oEmbed is instant for YouTube; other sites and playlists use yt-dlp.
async function mediaInfo(url, tools, { settings, youtubeCookies } = {}) {
  const id = youtubeId(url);
  const list = youtubePlaylist(url);
  if (id) {
    try {
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        const j = await r.json();
        return { title: j.title, uploader: j.author_name, thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, id, playlistId: list };
      }
      if (r.status === 401 || r.status === 403) return { title: null, error: 'Private or embedding disabled', thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, id };
      if (r.status === 404 || r.status === 400) return { error: 'Video unavailable', id, offline: true };
    } catch {}
  }
  if (!tools?.installed('yt-dlp')) return id ? { thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, id } : {};
  const cookies = sharedCookies(url, settings, youtubeCookies);
  return new Promise(resolve => {
    execFile(
      tools.path('yt-dlp.exe'),
      ['-J', '--flat-playlist', '--no-warnings', '--encoding', 'utf-8', '--js-runtimes', `deno:${tools.path('deno.exe')}`, ...(cookies ? ['--cookies', cookies.file] : []), '--', url],
      { windowsHide: true, timeout: 45000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
      (err, stdout, stderr) => {
        cookies?.remove();
        if (err) return resolve({ error: friendlyError(stderr || err.message, { usedSignIn: !!cookies }), offline: /unavailable|private|Unsupported URL/i.test(stderr || '') });
        try {
          const j = JSON.parse(stdout);
          const thumb = j.thumbnail || j.thumbnails?.slice(-1)[0]?.url || (j.entries?.[0]?.thumbnails?.slice(-1)[0]?.url ?? null);
          resolve({ title: j.title, uploader: j.uploader || j.channel, thumbnail: thumb, duration: j.duration, count: j._type === 'playlist' ? j.entries?.length || j.playlist_count : null, extractor: j.extractor_key });
        } catch {
          resolve({});
        }
      }
    );
  });
}

module.exports = { MediaTask, mediaInfo, isMediaUrl, youtubeId, youtubePlaylist, friendlyError, buildArgs };
