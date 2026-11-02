// XFileSharing sites: the shared free-download flow, offline detection, waits and error handling.
//
// Ported from JDownloader 2 (GPL-3.0-or-later, Copyright JD-Team), source mirror commit 6ab1aecd of 2026-11-02:
//   org/jdownloader/plugins/components/XFileSharingProBasic.java  r53786
//   jd/plugins/hoster: DatanodesTo r53121, SendNow r52974, DdownloadCom r53187, KatfileCom r53743, HexloadCom r52647,
//   ClicknuploadOrg r52239, UsersdriveCom r46225, DailyuploadsNet r53165, FilespayoutCom r50684
// Left out on purpose: captcha helpers (the person solves them in the window), JDownloader's Cloudflare and "security
// verification" workarounds, DataNodes' g_captch__a field, video and image host handling, accounts.
const { fetcher, getText, hostIn, decodeHtml, gone, HostError } = require('./common');
const { guard, waitOut, allForms, withoutComments } = require('./pagekit');

const OFFLINE = [
  /No such file/,
  />\s*(?:[*-]\s*)?File Not Found\s*</,
  />\s*(?:[*-]\s*)?File Deleted\s*</,
  />\s*(?:[*-]\s*)?The file was (?:removed|deleted) by/,
  />[^<>]*Reason for deletion:?/,
  />\s*(?:[*-]\s*)?File has been removed due to copyright issues\s*</,
  />\s*(?:[*-]\s*)?The file expired/,
  />\s*(?:[*-]\s*)?Sorry, we can't find the page you're looking for/,
  />\s*(?:[*-]\s*)?File could not be found due to expiration or removal by the file owner/,
  />\s*(?:[*-]\s*)?The file of the above link no longer exists/,
  />\s*(?:[*-]\s*)?The file you were looking for doesn't exist/,
  />\s*(?:[*-]\s*)?File is not? longer available as it/,
];

function isOffline(status, html, spec = {}) {
  return status === 404 || OFFLINE.some(r => r.test(html)) || !!spec.offline?.test(html);
}

const PREMIUM_ONLY = [
  'The file you requested reached max downloads',
  'This file reached max downloads',
  'Available Only for Premium Members',
  'File is available only for Premium users',
  'Please Buy Premium To download',
  'This file is not available for free download',
  'Only Premium user can download this file',
  'This video is available for Premium Users only',
  'This file is available for Premium Users only',
];

function premiumOnly(url, html) {
  if (/\/\?op=login&redirect=|\/login\?redirect=|\/\?op=registration&redirect=/i.test(url || '')) return 'Account required to download this file';
  for (const text of PREMIUM_ONLY) {
    const m = new RegExp(`>\\s*(${text}[^<]*)`).exec(html);
    if (m) return m[1].trim();
  }
  return (
    />\s*((?:Sorry\s*,)?\s*This file (?:can|only can|can only) be downloaded by[^<]+)/.exec(html)?.[1] ||
    />\s*(You can download files up to \d+ [^<]*)/.exec(html)?.[1] ||
    />\s*(This file is available for[^<]+)/.exec(html)?.[1] ||
    null
  );
}

// "You have to wait 1 hour, 3 minutes" -> milliseconds.
function preciseWait(text) {
  const part = unit => Number(new RegExp(`(\\d+)\\s*${unit}s?`, 'i').exec(text)?.[1] || 0);
  const secs = part('day') * 86400 + part('hour') * 3600 + part('minute') * 60 + part('second');
  return secs ? (secs + 1) * 1000 : 3600000;
}

const IP_LIMIT = { ipLimit: true, hostWide: true };

// What the page says -> a wait, a permanent error or a message. Returns nothing when the page has none of these.
function checkErrors(name, status, url, html, spec = {}) {
  if (status === 429) throw new HostError(`${name}: too many requests`, { wait: 60000, ...IP_LIMIT });
  if (status === 500) throw new HostError(`${name}: server error 500`, { wait: 60000 });
  if (/>\s*Wrong password/i.test(html)) throw new HostError(`${name}: this file has a password; open it in the window`, { browser: true });
  if (/>\s*Skipped countdown\s*</i.test(html)) throw new HostError(`${name} says the countdown was skipped`, { wait: 5 * 60000 });
  const limit = />\s*(You have reached the maximum limit \d+ files in \d+ hours)/i.exec(html)?.[1];
  const wait = /((?:You have reached the download(?:-| )limit|You have to wait)[^<>]+)/i.exec(html)?.[1] || /Download limit reached\.\s*Please wait\s*(.*?)\s*before your next download/.exec(html)?.[1];
  if (wait) throw new HostError(`${name}: download limit reached, waiting`, { wait: preciseWait(wait), ...IP_LIMIT });
  if (limit) throw new HostError(`${name}: ${limit}`, { wait: 15 * 60000, ...IP_LIMIT });
  if (/You're using all download slots for IP/i.test(html)) throw new HostError(`${name}: all download slots for your IP are in use`, { wait: 5 * 60000, ...IP_LIMIT });
  if (/Error happened when generating Download Link/i.test(html)) throw new HostError(`${name}: server error while making the link`, { wait: 10 * 60000 });
  const premium = premiumOnly(url, html);
  if (premium) throw new HostError(`${name}: ${premium}`, { browser: true });
  if (/>\s*Expired download session/i.test(html)) throw new HostError(`${name}: the download session expired`, { wait: 10 * 60000 });
  if (/>\s*(?:This server is in maintenance mode|Website is under maintenance|Server is under maintenance)/i.test(html)) throw new HostError(`${name} is under maintenance`, { wait: 30 * 60000 });
  if (isOffline(status, html, spec)) throw gone(name);
  if (/>\s*Downloads disabled for this file/.test(html)) throw new HostError(`${name}: the uploader has disabled downloads for this file`, { permanent: true });
  if (/>\s*Downloads are disabled for your country/.test(html)) throw new HostError(`${name}: downloads are disabled for your country`, { permanent: true });
  if (/>\s*File was locked by administrator/.test(html)) throw new HostError(`${name}: the file was locked by an administrator`, { permanent: true });
  if (/>\s*Couldn't generate direct link/.test(html)) throw new HostError(`${name} couldn't make a direct link`, { wait: 5 * 60000 });
  if (/>\s*Not allowed from domain you/.test(html)) throw new HostError(`${name}: not allowed from the domain you came from`, { permanent: true });
  if (/>\s*You can download up to/.test(html)) throw new HostError(`${name}: free download limit reached`, { wait: 3600000, ...IP_LIMIT });
}

function regexWaittime(html, spec = {}) {
  const page = withoutComments(html);
  const found = spec.wait?.(page);
  if (found != null) return found;
  const m =
    /id=["']countdown_str["'][^>]*>[^<>]*<span id=[^>]*>\s*(\d+)\s*<\/span>/.exec(page) ||
    /class="seconds"[^>]*>\s*(\d+)\s*</.exec(page) ||
    /id="seconds"[^>]*>\s*(\d+)\s*</.exec(page);
  return m ? Number(m[1]) : 0;
}

// The file link on a page.
function getDllink(html, spec = {}) {
  const page = withoutComments(html);
  const fromSpec = spec.link?.(page);
  if (fromSpec) return fromSpec;
  const host = '(?:\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|[A-Za-z0-9\\-.]*)';
  const patterns = [
    new RegExp(`(https?://${host}(?::\\d*)?/(?:files|d|cgi-bin/dl\\.cgi|dl)/(?:\\d+/)?[a-z0-9]+/[^<>"'/]*)`),
    /href="(https?:\/\/[^"]+)"[^>]*>\s*(?:<i[^>]*>[^>]*\/i>)?\s*Direct Download Link/,
    /href="(https?:\/\/[^"]+)"[^>]*>\s*(?:<i[^>]*>[^>]*\/i>)?\s*Lancer le téléchargement/,
    /href="(https?:\/\/[^"]+)"[^>]*>\s*<i[^>]*class\s*=\s*"[^"]*fa-download[^"]*"/,
  ];
  for (const r of patterns) {
    const m = r.exec(page);
    if (m) {
      const link = decodeHtml(m[1]);
      if (!/adskeeper.+\.\d+\.js$/.test(link)) return link;
    }
  }
  return null;
}

function findFormDownload1(html, spec = {}) {
  const form = allForms(html).find(f => f.fields.op === 'download1');
  if (form) {
    const fields = { ...form.fields };
    delete fields.method_premium;
    if (!fields.method_free) fields.method_free = 'Free Download';
    return fields;
  }
  return spec.form1?.(html) || null;
}

function findFormDownload2(html, spec = {}) {
  const forms = allForms(html);
  const form =
    forms.find(f => /method_/.test(f.html) && /download/.test(f.fields.op || '')) ||
    forms.find(f => /name=["']F1["']/i.test(f.attrs)) ||
    forms.find(f => f.fields.op === 'download2');
  const fields = form ? { ...form.fields } : spec.form2?.(html);
  if (!fields) return null;
  if (fields.adblock_detected === '') fields.adblock_detected = '0';
  return spec.extendForm2 ? spec.extendForm2(fields) : fields;
}

const meta = (html, spec) => {
  const name = /name=["']fname["'][^>]*value=["']([^"']+)["']/i.exec(html)?.[1] || /value=["']([^"']+)["'][^>]*name=["']fname["']/i.exec(html)?.[1];
  return name ? decodeHtml(name).trim() : undefined;
};

function xfsHost(spec) {
  const { id, name, domains } = spec;
  async function resolve(url, ctx) {
    let { res, text } = await getText(ctx, url);
    let page = res.url || url;
    guard(name, res, text);
    checkErrors(name, res.status, page, text, spec);
    const filename = meta(text, spec);
    const done = link => ({ url: new URL(link, page).href, headers: { Referer: page }, filename });
    const post = async fields => {
      const answer = await fetcher(ctx)(spec.action || page, {
        method: 'POST',
        redirect: 'manual',
        body: new URLSearchParams(fields),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: page },
      });
      const location = answer.headers.get('location');
      if (location) {
        await answer.body?.cancel().catch(() => {});
        return { location };
      }
      const body = await answer.text();
      guard(name, answer, body);
      checkErrors(name, answer.status, page, body, spec);
      return { body };
    };
    for (let step = 0; step < 3; step++) {
      const direct = getDllink(text, spec);
      if (direct) return done(direct);
      const first = findFormDownload1(text, spec);
      if (first) {
        const r = await post(first);
        if (r.location) return done(r.location);
        text = r.body;
        continue;
      }
      const second = findFormDownload2(text, spec);
      if (!second) break;
      await waitOut(name, regexWaittime(text, spec), ctx);
      const r = await post(second);
      if (r.location) return done(r.location);
      text = r.body;
    }
    const last = getDllink(text, spec);
    if (last) return done(last);
    const said = /class="[^"]*(?:err|alert-danger)[^"]*"[^>]*>([^<]+)</.exec(text)?.[1];
    throw new HostError(said ? `${name}: ${decodeHtml(said).trim()}` : `${name} didn't hand out a free link`, { browser: true });
  }
  async function check(url, ctx) {
    try {
      const { res, text } = await getText(ctx, url);
      guard(name, res, text);
      checkErrors(name, res.status, res.url || url, text, spec);
      // A page with no form, name or link says nothing about the file (these sites answer 200 to anything).
      const known = meta(text, spec) || getDllink(text, spec) || findFormDownload1(text, spec) || findFormDownload2(text, spec);
      return known ? { status: 'online', filename: meta(text, spec) } : { status: 'unknown', error: `${name}: couldn't tell from its page` };
    } catch (e) {
      if (e.permanent) return { status: 'offline', error: e.message };
      if (e.browser) return { status: 'browser', error: e.message };
      throw e;
    }
  }
  return { id, name, test: hostIn(...domains), free: true, maxConnections: spec.connections ?? 1, resolve, check };
}

// JSON answers: DataNodes { url }, Hexload { link: base64 }.
const jsonUrl = page => {
  if (!page.trimStart().startsWith('{')) return null;
  try {
    const url = JSON.parse(page).url;
    return url ? decodeURIComponent(url).replace(/[\r\n]/g, '') : null;
  } catch {
    return null;
  }
};
const jsonB64Link = page => {
  if (!page.trimStart().startsWith('{')) return null;
  try {
    return Buffer.from(JSON.parse(page).link, 'base64').toString('utf8');
  } catch {
    return null;
  }
};
const num = re => page => {
  const m = re.exec(page);
  return m ? Number(m[1]) : null;
};

const HOSTS = [
  { id: 'send', name: 'Send', domains: ['send.now', 'send.cm', 'sendit.cloud', 'usersfiles.com', 'tusfiles.com', 'tusfiles.net', 'userscloud.com', 'usercdn.com'], offline: />\s*The file you were looking for doesn/ },
  {
    id: 'datanodes',
    name: 'DataNodes',
    domains: ['datanodes.to'],
    connections: 0,
    action: 'https://datanodes.to/download',
    wait: num(/countdown="(\d+)"/),
    link: jsonUrl,
    // Its page builds the form in a script: the same fields, taken from the page's attributes.
    form2: html => {
      const id = /file-actions link="https?:\/\/[^/]+\/([a-z0-9]{12})\//.exec(html)?.[1];
      if (!id && !/countdown="\d+"/.test(html)) return null;
      const dlToken = /dl-token="([^"]+)"/.exec(html)?.[1];
      return { op: 'download2', id: id || '', rand: /rand="([^"]+)"/.exec(html)?.[1] || '', ...(dlToken ? { dl_token: dlToken } : {}), referer: '', method_free: 'Free Download >>', method_premium: '' };
    },
  },
  { id: 'ddownload', name: 'DDownload', domains: ['ddownload.com'], wait: num(/id="dk2CountdownNum"[^>]*>\s*(\d{1,2})/), offline: />\s*This file was banned by copyright/ },
  {
    id: 'katfile',
    name: 'Katfile',
    domains: ['katfile.com', 'katfile.co', 'katfile.biz', 'katfile.space', 'katfile.ws', 'katfile.vip', 'katfile.online', 'katfile.cloud'],
    offline: /\/404-remove|>\s*The file expired|>\s*The file was deleted by its owner/,
    wait: page => {
      const m = /var estimated_time = (\d+)/.exec(page);
      return m ? Math.floor(Number(m[1]) / 10) : null;
    },
    form1: html => {
      const id = /var\s+FILE_ID\s*=\s*"([^"]+)"/.exec(html)?.[1];
      if (!id) return null;
      const v = key => new RegExp(`var\\s+${key}\\s*=\\s*"([^"]*)"`).exec(html)?.[1] || '';
      return { op: 'download1', usr_login: v('USR_LOGIN'), id, fname: v('FNAME'), referer: v('REFERER'), method_free: '1' };
    },
  },
  {
    id: 'hexload',
    name: 'Hexload',
    domains: ['hexload.com', 'hexupload.net', 'hexupload.com'],
    link: page => jsonB64Link(page) || (m => (m ? Buffer.from(m[1], 'base64').toString('utf8') : null))(/(?:start_worker|ldl\.ld)\('(aHR0c.*?)'/.exec(page)),
  },
  { id: 'clicknupload', name: 'ClicknUpload', domains: ['clicknupload.click', 'clicknupload.link', 'clicknupload.red', 'clicknupload.to', 'clicknupload.cc', 'clicknupload.co', 'clicknupload.org', 'clicknupload.com'] },
  { id: 'usersdrive', name: 'UsersDrive', domains: ['usersdrive.com'] },
  { id: 'dailyuploads', name: 'DailyUploads', domains: ['dailyuploads.net', 'dailyuploads.cc', 'dailyuploads.im', 'dailyuploads.in', 'dailyuploads.io'] },
  { id: 'filespayout', name: 'FilesPayout', domains: ['filespayout.com', 'filespayouts.com'] },
];

module.exports = HOSTS.map(xfsHost);
module.exports._test = { isOffline, premiumOnly, preciseWait, checkErrors, regexWaittime, getDllink, findFormDownload1, findFormDownload2, HOSTS };
