// Live lists of the file hosts each debrid service supports (both lists are public, no account needed).
// Used to route hoster links to a service that can actually unlock them, and for the icon grid in Settings.
const fs = require('fs');

const RD_HOSTS = 'https://api.real-debrid.com/rest/1.0/hosts';
const RD_DOMAINS = 'https://api.real-debrid.com/rest/1.0/hosts/domains';
const TB_HOSTERS = 'https://api.torbox.app/v1/api/webdl/hosters';
const MAX_AGE = 6 * 3600 * 1000;

const hostOf = url => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};
const matches = (host, domain) => host === domain || host.endsWith('.' + domain);

// These APIs occasionally time out or drop the connection: retry a few times before giving up
// (a failed refresh keeps the previous list anyway).
async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
}

class HosterRegistry {
  constructor(file) {
    this.file = file;
    this.data = { torbox: [], realdebrid: [], realdebridDomains: [], updated: 0 };
    try {
      if (file) Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {}
  }

  async refresh(force = false) {
    if (!force && Date.now() - this.data.updated < MAX_AGE && this.data.torbox.length) return this.data;
    const [tb, rd, rdDomains] = await Promise.allSettled([getJson(TB_HOSTERS), getJson(RD_HOSTS), getJson(RD_DOMAINS)]);
    if (tb.status === 'fulfilled') {
      this.data.torbox = (tb.value.data || [])
        .filter(h => h.type === 'hoster')
        .map(h => ({ name: h.name, domains: h.domains || [], icon: h.icon, up: h.status !== false, note: h.note || null, dailyLinks: h.daily_link_limit ?? null }));
    }
    if (rd.status === 'fulfilled') {
      this.data.realdebrid = Object.entries(rd.value).map(([domain, h]) => ({ name: h.name, domains: [domain], icon: h.image_big || h.image, up: true }));
    }
    if (rdDomains.status === 'fulfilled') this.data.realdebridDomains = rdDomains.value;
    if (tb.status === 'fulfilled' || rd.status === 'fulfilled') {
      this.data.updated = Date.now();
      try {
        if (this.file) fs.writeFileSync(this.file, JSON.stringify(this.data));
      } catch {}
    }
    return this.data;
  }

  // Which services can unlock this URL? -> e.g. ['torbox'] (services whose host entry is currently down come last)
  providersFor(url) {
    const host = hostOf(url);
    if (!host) return [];
    const out = [];
    const tb = this.data.torbox.find(h => h.domains.some(d => matches(host, d)));
    if (tb) out.push({ provider: 'torbox', name: tb.name, up: tb.up });
    const rdName = this.data.realdebrid.find(h => h.domains.some(d => matches(host, d)))?.name;
    if (rdName || this.data.realdebridDomains.some(d => matches(host, d))) out.push({ provider: 'realdebrid', name: rdName || host, up: true });
    return out.sort((a, b) => Number(b.up) - Number(a.up));
  }

  isKnownHoster(url) {
    return this.providersFor(url).length > 0;
  }

  list() {
    return this.data;
  }
}

module.exports = { HosterRegistry, hostOf };
