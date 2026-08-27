// Shared HTTP helper.
//
// Two hosts have opinions we have to respect:
//   - Fund websites block obvious bots, so we send a real browser User-Agent.
//   - api.gouv.fr rate-limits to ~7 calls/second per IP and answers 429 above it.
// Everything is therefore serialised through a per-host minimum gap.

const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'raw');
const lastCall = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttle(host, minGapMs) {
  const previous = lastCall.get(host) || 0;
  const wait = previous + minGapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall.set(host, Date.now());
}

// Fetch with retry. `cacheKey` writes the body to data/raw/ so a re-run while
// developing an adapter does not re-hammer the fund's website.
async function get(url, { minGapMs = 250, retries = 3, cacheKey = null, json = false } = {}) {
  const cachePath = cacheKey ? path.join(CACHE_DIR, cacheKey) : null;
  if (cachePath && process.env.USE_CACHE === '1' && fs.existsSync(cachePath)) {
    const body = fs.readFileSync(cachePath, 'utf8');
    return json ? JSON.parse(body) : body;
  }

  const host = new URL(url).host;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    await throttle(host, minGapMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: json ? 'application/json' : 'text/html,*/*' },
        redirect: 'follow',
      });
      // 429 and 5xx are worth retrying; a 404 is a wrong URL and never fixes itself.
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`${res.status} ${res.statusText} for ${url}`);
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
      const body = await res.text();
      if (cachePath) {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, body);
      }
      return json ? JSON.parse(body) : body;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

module.exports = { get, sleep, UA };
