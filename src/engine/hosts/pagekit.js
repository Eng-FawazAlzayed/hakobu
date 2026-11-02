// Shared helpers for host modules that read web pages: forms, countdowns and pages that need a person.
// Captchas and bot checks are never solved or worked around: such a download goes to the captcha window, or to debrid
// when one is set up.
const { decodeHtml, HostError } = require('./common');
const { sleep } = require('../../util');

const MAX_WAIT = 120; // seconds; a longer countdown goes to the queue as a wait

const withoutComments = html => String(html).replace(/<!--[\s\S]*?-->/g, '');

// The site wants a person: Cloudflare's check, or a captcha on the download form.
function needsPerson(res, html) {
  const page = withoutComments(html);
  if (res?.headers?.get?.('cf-mitigated') || /<title>\s*Just a moment|challenges\.cloudflare\.com\/turnstile\/[\w/]*\/orchestrate|cdn-cgi\/challenge-platform\/h\/[\w]+\/orchestrate/i.test(page)) return 'a bot check';
  if (/class=["'][^"']*(?:g-recaptcha|h-captcha|cf-turnstile)|name=["'](?:g-recaptcha-response|h-captcha-response|cf-turnstile-response|captcha_code)["']|challenges\.cloudflare\.com\/turnstile\//i.test(page)) return 'a captcha';
  return null;
}

function guard(name, res, html) {
  const what = needsPerson(res, html);
  if (what) throw new HostError(`${name} shows ${what}: solve it in the window, or download it through debrid`, { browser: true });
}

// The seconds a page counts down before its download button works.
function countdown(html) {
  const page = withoutComments(html);
  const m =
    /<span[^>]+(?:id|class)=["'][^"']*(?:countdown|seconds)[^"']*["'][^>]*>\s*(\d+)\s*</i.exec(page) ||
    /\b(?:var\s+)?(?:seconds|countdown|count)\s*=\s*(\d+)\s*;/i.exec(page);
  return m ? Number(m[1]) : 0;
}

async function waitOut(name, seconds, ctx) {
  if (seconds > MAX_WAIT) throw new HostError(`${name}: wait ${Math.ceil(seconds / 60)} minutes between free downloads`, { wait: (seconds + 5) * 1000, ipLimit: true });
  if (seconds > 0) await sleep(seconds * 1000, ctx.signal);
}

// All forms of a page: { attrs, html, fields } where fields are the inputs with a name (and their values).
function allForms(html) {
  const out = [];
  for (const m of withoutComments(html).matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const fields = {};
    for (const i of m[2].matchAll(/<input\b[^>]*>/gi)) {
      const name = /name=["']([^"']+)["']/i.exec(i[0])?.[1];
      if (name) fields[name] = decodeHtml(/value=["']([^"']*)["']/i.exec(i[0])?.[1] ?? '');
    }
    out.push({ attrs: m[1], html: m[2], fields });
  }
  return out;
}

// Fields of the form that holds "op" (XFileSharing sites).
const formFields = html => allForms(html).find(f => 'op' in f.fields)?.fields || null;

module.exports = { MAX_WAIT, withoutComments, needsPerson, guard, countdown, waitOut, allForms, formFields };
