// Local endpoints for the browser extension and for Click'n'Load (the protocol link sites use to hand links to JDownloader).
// Both only listen on 127.0.0.1, and everything they receive lands in LinkGrabber for approval.
const http = require('http');
const crypto = require('crypto');
const { parseLinks } = require('../linkparse');

const MAX_BODY = 4 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string';
  res.writeHead(status, { 'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json', ...headers });
  res.end(isText ? body : JSON.stringify(body));
}

// Click'n'Load "crypted2": AES-128-CBC, key = IV = hex string returned by the page's jk() function.
function decryptCnl(crypted, jk) {
  const hex = /['"]([0-9a-fA-F]{32})['"]/.exec(jk || '')?.[1];
  if (!hex) throw new Error('Unsupported Click\'n\'Load key');
  const key = Buffer.from(hex, 'hex');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, key);
  decipher.setAutoPadding(false);
  const out = Buffer.concat([decipher.update(Buffer.from(crypted, 'base64')), decipher.final()]);
  return out.toString('utf8').replace(/\0+$/, '');
}

const timingSafeEq = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

class LocalApi {
  // onLinks(entries, meta) is called with parsed LinkGrabber entries.
  // expecting(referrer) says whether a download in "Needs browser" is waiting for a browser download from that page.
  // onYoutubeSignIn({ cookies, browser, manual }) receives the sign-in the user chose to share and returns its status.
  constructor({ onLinks, getState, expecting = () => false, onYoutubeSignIn, version = '0.1.0' }) {
    this.onLinks = onLinks;
    this.onYoutubeSignIn = onYoutubeSignIn;
    this.getState = getState;
    this.expecting = expecting;
    this.version = version;
    this.servers = {};
    this.status = { api: 'off', cnl: 'off' };
  }

  async start({ apiPort, token, cnl }) {
    await this.stop();
    this.token = token;
    this.status.api = await this.listen('api', apiPort, (req, res) => this.handleApi(req, res));
    this.status.cnl = cnl ? await this.listen('cnl', 9666, (req, res) => this.handleCnl(req, res)) : 'off';
    return this.status;
  }

  listen(name, port, handler) {
    return new Promise(resolve => {
      const srv = http.createServer((req, res) => handler(req, res).catch(e => send(res, 500, { error: e.message })));
      srv.once('error', e => resolve(e.code === 'EADDRINUSE' ? `port ${port} is in use` : e.message));
      srv.listen(port, '127.0.0.1', () => {
        this.servers[name] = srv;
        resolve('on');
      });
    });
  }

  async stop() {
    await Promise.all(Object.values(this.servers).map(s => new Promise(r => s.close(() => r()))));
    this.servers = {};
  }

  // ---- extension API: /api/*, requires the token ----
  async handleApi(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (!timingSafeEq(req.headers['x-hakobu-token'], this.token)) return send(res, 401, { error: 'Bad or missing token' });
    if (req.method === 'GET' && url.pathname === '/api/ping') return send(res, 200, { app: 'Hakobu', version: this.version });
    if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, this.getState?.() || {});
    // The extension asks before taking over a browser download it would otherwise leave alone.
    if (req.method === 'GET' && url.pathname === '/api/expecting') return send(res, 200, { expecting: !!this.expecting(url.searchParams.get('referrer') || '', url.searchParams.get('url') || '') });
    if (req.method === 'POST' && url.pathname === '/api/youtube-signin' && this.onYoutubeSignIn) {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: 'Expected JSON' });
      }
      return send(res, 200, this.onYoutubeSignIn({ cookies: body.cookies, browser: body.browser, manual: body.manual === true }));
    }
    if (req.method === 'POST' && url.pathname === '/api/add') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: 'Expected JSON' });
      }
      const text = [body.text || '', ...(Array.isArray(body.links) ? body.links : [])].join('\n');
      const entries = parseLinks(text);
      // A captured browser download carries its cookies/referrer so authenticated downloads still work.
      const headers = {};
      if (typeof body.cookie === 'string' && body.cookie) headers.Cookie = body.cookie.slice(0, 8192);
      if (typeof body.referrer === 'string' && /^https?:/i.test(body.referrer)) headers.Referer = body.referrer;
      for (const e of entries) {
        if (e.kind === 'http' && Object.keys(headers).length) e.headers = headers;
        if (typeof body.filename === 'string' && entries.length === 1) e.suggestedName = body.filename.slice(0, 200);
        if (typeof body.package === 'string') e.package = body.package.slice(0, 200);
        if (body.dlc === true && e.kind === 'http' && !/\.dlc(?:$|[?#])/i.test(e.source)) e.source += (e.source.includes('#') ? '' : '#') + '.dlc';
      }
      if (entries.length) this.onLinks(entries, { source: 'extension', page: body.page, capture: !!body.capture, referrer: headers.Referer || '' });
      return send(res, 200, { added: entries.length });
    }
    send(res, 404, { error: 'Not found' });
  }

  // ---- Click'n'Load v2 on port 9666 ----
  async handleCnl(req, res) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname.replace(/\/+$/, '');
    if (req.method === 'OPTIONS') return send(res, 204, '', cors);
    if (p === '/jdcheck.js') return send(res, 200, "jdownloader=true; var version='17461';\n", { ...cors, 'Content-Type': 'text/javascript' });
    if (p === '/crossdomain.xml') {
      return send(res, 200, '<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*" /></cross-domain-policy>', { 'Content-Type': 'text/xml' });
    }
    if (p === '' || p === '/flash') return send(res, 200, 'JDownloader\r\n', cors);
    if (req.method !== 'POST' || !p.startsWith('/flash/add')) return send(res, 404, 'not found', cors);

    const form = new URLSearchParams(await readBody(req));
    let text = form.get('urls') || '';
    if (p === '/flash/addcrypted2') {
      try {
        text = decryptCnl(form.get('crypted') || '', form.get('jk') || '');
      } catch (e) {
        return send(res, 400, 'failed ' + e.message + '\r\n', cors);
      }
    }
    const entries = parseLinks(text);
    const pkg = form.get('package') || null;
    const passwords = (form.get('passwords') || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (const e of entries) {
      if (pkg) e.package = pkg.slice(0, 200);
      if (passwords.length) e.archivePasswords = passwords;
    }
    if (entries.length) this.onLinks(entries, { source: 'clicknload', page: form.get('source') });
    send(res, 200, 'success\r\n', cors);
  }
}

module.exports = { LocalApi, decryptCnl };
