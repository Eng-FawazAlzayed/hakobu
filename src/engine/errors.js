// Errors that tell the queue what to do next, like JDownloader's plugin results.
//  wait:      try again after this many ms (host busy, daily limit, "wait 30 minutes", HTTP 429/503 Retry-After)
//  ipLimit:   the wait is tied to your IP address, so another proxy route can skip it
//  hostWide:  every download from this host has to wait, not just this one
//  permanent: the file is gone or never existed; retrying won't help (a mirror might)
//  browser:   a person has to do something on the page (captcha)
//  diskFull:  not enough free space; waits like JDownloader and tries again
class HostError extends Error {
  constructor(message, { wait = 0, ipLimit = false, hostWide = false, permanent = false, browser = false, diskFull = false } = {}) {
    super(message);
    this.name = 'HostError';
    Object.assign(this, { wait, ipLimit, hostWide, permanent, browser, diskFull });
  }
}

// Retry-After is either seconds or an HTTP date. Returns ms or null.
function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const s = Number(value);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

// HTTP status -> HostError (or null when an ordinary retry is right).
function errorForStatus(res, host) {
  const after = retryAfterMs(res.headers?.get?.('retry-after'));
  const where = host || 'The server';
  if (res.status === 429) return new HostError(`${where} says too many requests`, { wait: after ?? 60000, ipLimit: true, hostWide: true });
  if (res.status === 503 && after != null) return new HostError(`${where} is busy`, { wait: Math.max(after, 5000), hostWide: true });
  if (res.status === 509) return new HostError(`${where}: bandwidth limit reached`, { wait: after ?? 30 * 60000, ipLimit: true, hostWide: true });
  if (res.status === 404 || res.status === 410) return new HostError(`File not found (HTTP ${res.status})`, { permanent: true });
  return null;
}

const minutes = n => n * 60000;

module.exports = { HostError, retryAfterMs, errorForStatus, minutes };
