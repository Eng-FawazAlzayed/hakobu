// The user's own YouTube sign-in, shared by the Hakobu browser extension (only when they turn that on) so yt-dlp can
// download as them. Only youtube.com cookies are accepted. They stay encrypted on disk (DPAPI); yt-dlp needs a plain
// cookies.txt, so one is written for each run and removed afterwards.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_COOKIES = 200;
const isYoutubeDomain = d => /^\.?([a-z0-9-]+\.)*youtube\.com$/i.test(String(d || ''));
const clean = s => typeof s === 'string' && !/[\t\r\n]/.test(s);

// What a browser reports -> only well-formed youtube.com cookies. A tab or line break would break the file format.
function sanitize(cookies) {
  if (!Array.isArray(cookies)) return [];
  return cookies
    .filter(c => c && isYoutubeDomain(c.domain) && clean(c.name) && c.name && clean(c.value) && clean(c.path || '/'))
    .slice(0, MAX_COOKIES)
    .map(c => ({
      domain: c.domain,
      path: c.path || '/',
      secure: !!c.secure,
      expires: Number(c.expirationDate ?? c.expires) > 0 ? Math.floor(Number(c.expirationDate ?? c.expires)) : 0,
      name: c.name,
      value: c.value,
    }));
}

// A signed-in session has one of these; without them yt-dlp would just be anonymous again.
const signedIn = cookies => cookies.some(c => /^(SID|__Secure-[13]PSID|SAPISID|__Secure-[13]PAPISID|LOGIN_INFO)$/.test(c.name));

function toNetscape(cookies) {
  const lines = cookies.map(c => [c.domain, c.domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path, c.secure ? 'TRUE' : 'FALSE', c.expires, c.name, c.value].join('\t'));
  return `# Netscape HTTP Cookie File\n${lines.join('\n')}\n`;
}

class YoutubeCookies {
  // encrypt/decrypt: string <-> Buffer (Electron's safeStorage). Without them the sign-in stays in memory only.
  constructor({ file, tempDir, encrypt, decrypt }) {
    this.file = file;
    this.tempDir = tempDir;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.data = null;
    fs.rmSync(tempDir, { recursive: true, force: true }); // left behind if the app was killed during a download
    try {
      if (decrypt) this.data = JSON.parse(decrypt(fs.readFileSync(file)));
    } catch {}
  }

  // Returns the status. Cookies from a signed-out browser count as signing out.
  set(cookies, browser) {
    const list = sanitize(cookies);
    if (!signedIn(list)) {
      this.clear();
      return this.status();
    }
    this.data = { cookies: list, browser: typeof browser === 'string' ? browser.slice(0, 40) : '', updatedAt: Date.now() };
    if (this.encrypt) {
      fs.writeFileSync(this.file + '.tmp', this.encrypt(JSON.stringify(this.data)));
      fs.renameSync(this.file + '.tmp', this.file);
    }
    return this.status();
  }

  clear() {
    this.data = null;
    fs.rmSync(this.file, { force: true });
  }

  status() {
    return this.data ? { signedIn: true, browser: this.data.browser, updatedAt: this.data.updatedAt } : { signedIn: false };
  }

  // A private cookies.txt for one yt-dlp run. Returns { file, remove } or null when not signed in.
  tempFile() {
    if (!this.data) return null;
    fs.mkdirSync(this.tempDir, { recursive: true });
    const file = path.join(this.tempDir, `${crypto.randomUUID()}.txt`);
    fs.writeFileSync(file, toNetscape(this.data.cookies), { mode: 0o600 });
    return { file, remove: () => fs.rmSync(file, { force: true }) };
  }
}

module.exports = { YoutubeCookies, sanitize, signedIn, toNetscape };
