// Stage 6 — a one-sentence description for every company, from its own website.
//
// Most companies in the deal log arrive with no website: the register sweeps
// know a company's legal name and nothing about its web presence. So this stage
// has two jobs, and the first is the risky one.
//
// 1. Find the website. Where a fund's page linked it, use that. Otherwise ask
//    Clearbit's keyless name-to-domain lookup, accept only a candidate whose name
//    matches exactly — "Otodo" also returns Otodom and Otodoke — and then confirm
//    the site itself shows the company's name before believing it. A wrong domain
//    would put another company's description on the row, which is worse than a
//    dash.
// 2. Read the site's own meta description and keep its first sentence, in the
//    language the company wrote it. Nothing is paraphrased or translated here:
//    the text is the company's, verbatim.
//
// Output: data/descriptions.json — TRACKED. One lookup per company, rechecked
// only after RECHECK_DAYS, because websites rarely change their tagline.

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const OUT = path.join(DATA, 'descriptions.json');

const RECHECK_DAYS = 120;
const CONCURRENCY = 12; // different hosts, so parallel is polite enough
const CLEARBIT_GAP_MS = 220;
const TIMEOUT_MS = 12000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const LEGAL = /\b(SAS|SASU|SA|SARL|INC|INCORPORATED|CORP|CORPORATION|LLC|LTD|LIMITED|CO|COMPANY|PBC|GROUP|GROUPE|HOLDINGS?)\b/g;
const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(LEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// French legal names carry the trading name in brackets: "GRYZZ-LAB (DIDASK)"
// trades as Didask. The brand is what a website and Clearbit know it by.
//
// The legal suffix has to come off the QUERY, not only the comparison: Clearbit
// finds "GlossGenius" and returns nothing at all for "GlossGenius, Inc.". Every
// company in the US register is named "..., Inc.", so this was most of the misses.
// Two strengths of stripping, tried in order. The legal form always goes. The
// descriptive word only goes second: "Altana Technologies" finds altana.ai, while
// plain "Altana" finds the German chemicals group first.
const LEGAL_SUFFIX = /[,\s]+(SAS|SASU|SA|SARL|SE|INC|INCORPORATED|CORP|CORPORATION|LLC|LTD|LIMITED|CO|PBC)\.?$/i;
const DESCRIPTIVE_SUFFIX = /[,\s]+(HOLDINGS?|TECHNOLOGIES|TECHNOLOGY|LABS?|FRANCE|GROUP|GROUPE)\.?$/i;
const stripRepeated = (name, re) => {
  let n = name.replace(/[.]+$/, '').trim();
  for (let i = 0; i < 3; i++) n = n.replace(re, '').trim();
  return n;
};

function searchNames(company) {
  const names = [];
  const brackets = [...String(company).matchAll(/\(([^)]+)\)/g)].map((m) => m[1].trim());
  const bare = String(company).replace(/\([^)]*\)/g, '').trim();
  for (const n of [...brackets.filter((b) => b.length > 1), bare]) {
    const legalOff = stripRepeated(n, LEGAL_SUFFIX);
    names.push(legalOff);
    names.push(stripRepeated(legalOff, DESCRIPTIVE_SUFFIX));
  }
  return [...new Set(names.filter((n) => norm(n).length >= 3))];
}

// Taglines that are about the website rather than the company.
const BOILERPLATE = /cookies?|javascript|site en construction|coming soon|under construction|just another wordpress|page not found|404|access denied|captcha|log ?in|sign ?in|bienvenue (sur|chez|dans)|site d'accueil|page d'accueil|welcome to|home ?page|official (web)?site|en quelques chiffres|chiffres cl[ée]s|key figures|domain (is )?for sale|this domain/i;

function firstSentence(text) {
  const clean = String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&').replace(/&rsquo;|&apos;/g, '’').replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length < 25 || BOILERPLATE.test(clean)) return null;
  // End at the first full stop that closes a sentence, not one inside "Inc." or "e.g."
  const m = clean.match(/^(.{25,220}?[.!?])(\s|$)/);
  let sentence = m ? m[1] : clean;
  if (sentence.length > 220) sentence = sentence.slice(0, sentence.lastIndexOf(' ', 217)) + '…';
  return sentence;
}

function meta(html, attr, value) {
  // Capture up to the quote that opened the attribute: an apostrophe inside a
  // double-quoted "the world's" used to end the description at "the world".
  const a = new RegExp('<meta[^>]+' + attr + '=["\']' + value + '["\'][^>]*content=(["\'])([\\s\\S]{10,600}?)\\1', 'i');
  const b = new RegExp('<meta[^>]+content=(["\'])([\\s\\S]{10,600}?)\\1[^>]*' + attr + '=["\']' + value + '["\']', 'i');
  return (html.match(a) || html.match(b) || [])[2] || null;
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (!type.includes('html')) return null;
    return { html: (await res.text()).slice(0, 400000), finalUrl: res.url };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// The site must show the company's name somewhere a site states its own identity:
// title, og:site_name, or the host itself. Otherwise the domain is someone else's.
// The domain itself must be the company's name, optionally with a standard
// add-on. A site that merely shows the name is not enough: in a random audit of
// name-matched sites, one in eight belonged to a different company, and the
// telltale was usually a domain that was the name plus other words —
// cinderatlanta.com for Cinder Technologies, kestraholdings.com for Kestra,
// wallaroofoods.com for Wallaroo Labs. Applied to all 909 name matches it caught
// about 40 wrong companies.
//
// It cannot catch a namesake that owns the bare name (Task Genie → a window
// cleaner at taskgenie.pro). Those remain possible, which is why the page shows
// the domain each description came from.
const DOMAIN_PREFIX = '(get|try|join|use|go|with|hello|hey|meet|the|a|my|app|run|drink|les)?';
const DOMAIN_SUFFIX = '(hq|app|ai|io|labs?|inc|co|tech|health|bio|med|rx|tx|thera|gtx|gen|3d|pharma|therapeutics|group|official|hub|studio|us|usa|france|fr|paris|nyc)?';
const DESCRIPTIVE_LAST_WORD = /^(bio|bioscience|biosciences|biomedicines|biotechnologies|biotherapeutics|therapeutics?|pharma|pharmaceuticals|health|healthcare|medical|robotics|technologies|technology|systems|solutions|software|labs|energy|capital|analytics|data|ai|innovations|bioinnovations|sciences|automation|advisory)$/;

function domainMatchesName(name, url) {
  let host;
  try { host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.toLowerCase(); } catch { return false; }
  const parts = host.split('.');
  const tld = parts.pop();
  const label = (parts.pop() || '').replace(/[^a-z0-9]/g, '');
  const slugs = new Set();
  for (const n of searchNames(name)) {
    const words = norm(n).toLowerCase().split(' ').filter(Boolean);
    if (!words.length) continue;
    slugs.add(words.join(''));
    // "Switch Therapeutics" -> switchthera.com: when the last word is descriptive,
    // the brand is what comes before it.
    if (words.length > 1 && DESCRIPTIVE_LAST_WORD.test(words[words.length - 1])) slugs.add(words.slice(0, -1).join(''));
  }
  for (const slug of slugs) {
    if (slug.length < 3) continue;
    if (label + tld === slug) return true; // craft.ai, transient.ai
    if (new RegExp('^' + DOMAIN_PREFIX + slug + DOMAIN_SUFFIX + '$').test(label)) return true;
  }
  return false;
}

function siteShowsName(page, names) {
  const title = (page.html.match(/<title[^>]*>([^<]{1,200})</i) || [])[1] || '';
  const siteName = meta(page.html, 'property', 'og:site_name') || '';
  let host = '';
  try { host = new URL(page.finalUrl).hostname.replace(/^www\./, ''); } catch {}
  const haystack = norm(`${title} ${siteName} ${host.replace(/\.[a-z]+$/, '').replace(/[.-]/g, ' ')}`);
  return names.some((n) => {
    const key = norm(n);
    return key.length >= 3 && haystack.split(' ').join(' ').includes(key);
  });
}

function describe(page) {
  const candidates = [
    meta(page.html, 'property', 'og:description'),
    meta(page.html, 'name', 'description'),
    meta(page.html, 'name', 'twitter:description'),
  ];
  for (const c of candidates) {
    const s = firstSentence(c);
    if (s) return s;
  }
  // No description tag. The homepage's main heading is usually the tagline —
  // altana.ai and beyond-aero.com both have one and no meta description — so it
  // stands in, still in the company's own words. Only a heading long enough to be
  // a sentence; "Welcome" or a lone brand name is not a description.
  const stripTags = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  for (const tag of ['h1', 'h2']) {
    for (const m of page.html.matchAll(new RegExp('<' + tag + '[^>]*>([\\s\\S]{0,400}?)</' + tag + '>', 'gi'))) {
      const text = stripTags(m[1]).replace(/\s+/g, ' ').trim();
      if (text.split(' ').length >= 5) {
        const s = firstSentence(text);
        if (s) return s;
      }
    }
  }
  return null;
}

// One queue for every worker. Twelve workers each checking a shared timestamp
// raced past it together, bursts got rate-limited, and a rejection was recorded
// as "no match" — GlossGenius and Dandelion Health came back with no website.
let clearbitChain = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function clearbitGet(url) {
  const run = clearbitChain.then(async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await sleep(CLEARBIT_GAP_MS);
      const res = await fetch(url).catch(() => null);
      if (res && res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
      return res;
    }
    return null;
  });
  clearbitChain = run.catch(() => null);
  return run;
}

// Every exact-name candidate across all the name variants, best first, rather
// than only the first one. "Altana" returns the German chemicals group's site
// before altana.ai; stopping at the first match meant the right one was never tried.
async function clearbitDomains(names) {
  const out = [];
  for (const name of names) {
    try {
      const res = await clearbitGet(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(name)}`);
      if (!res || !res.ok) continue;
      const hits = await res.json();
      const exact = hits.filter((h) => h.domain && norm(h.name) === norm(name));
      // Several companies can share a name. Prefer the domain built from the name
      // itself — glossgenius.com over carglossgenius.com — then Clearbit's order.
      const slug = norm(name).replace(/\s+/g, '').toLowerCase();
      const own = (h) => h.domain.split('.')[0].replace(/[^a-z0-9]/g, '') === slug;
      for (const h of [...exact.filter(own), ...exact.filter((h) => !own(h))]) {
        if (!out.includes(h.domain)) out.push(h.domain);
      }
    } catch {
      // try the next name
    }
  }
  return out.slice(0, 4);
}

const rootOf = (url) => {
  try {
    const parts = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '').split('.');
    return parts.slice(-2).join('.');
  } catch {
    return '';
  }
};

// A site that now redirects to another company's domain has been acquired or
// shut: Stilla Technologies' site lands on Bio-Rad, and showing Bio-Rad's
// product copy as Stilla's description would be wrong.
function redirectedAway(requested, page, names) {
  const from = rootOf(requested);
  const to = rootOf(page.finalUrl);
  if (!from || !to || from === to) return null;
  const toSlug = to.split('.')[0].replace(/[^a-z0-9]/g, '');
  const ours = names.some((n) => {
    const s = norm(n).replace(/\s+/g, '').toLowerCase();
    return s.length >= 3 && (toSlug.includes(s) || s.includes(toSlug));
  });
  return ours ? null : to;
}

// A Paris company on a Canadian or German domain is a namesake: AUUM matched
// auum.ca, a supplement maker, because the site really is called AUUM.
//
// An allow-list, not a block-list: a list of forbidden countries always has gaps
// (KARMEN matched karmen.sa, a Saudi perfume house). Generic extensions are fine
// anywhere; a two-letter country extension is only accepted for the company's
// own country — plus the handful that startups use as generic (.io, .ai, .co...).
const GENERIC_CC = new Set(['io', 'ai', 'co', 'me', 'tv', 'so', 'gg', 'ly', 'to', 'cc', 'eu']);
const HOME_CC = { FR: 'fr', US: 'us' };
function wrongCountry(domain, register) {
  const tld = domain.toLowerCase().split('.').pop();
  if (tld.length !== 2) return false; // .com, .app, .tech, .health...
  if (GENERIC_CC.has(tld)) return false;
  return tld !== HOME_CC[register];
}

// The page's declared language. A Paris startup writes in French or English and a
// New York one in English: OTIUM matched a Spanish gym whose site was called
// Otium, and no domain rule could have told.
function wrongLanguage(html, register) {
  const lang = ((html.match(/<html[^>]*\blang=["']?([a-zA-Z]{2})/i) || [])[1] || '').toLowerCase();
  if (!lang) return false;
  if (register === 'FR') return !['fr', 'en'].includes(lang);
  if (register === 'US') return lang !== 'en';
  return false;
}

async function lookup(company) {
  const names = searchNames(company.company);
  const tried = [];

  // A website the fund linked is trusted as the company's own — unless it now
  // redirects to somebody else's domain.
  //
  // Whatever happens to that link, the name search never runs after it. Stilla
  // Technologies' site redirects to Bio-Rad, which acquired it; searching by name
  // next found a flower shop called STILLA.
  if (company.website) {
    const page = await fetchText(company.website);
    if (!page) return { status: 'no-website', why: 'the fund-linked site did not load' };
    const away = redirectedAway(company.website, page, names);
    if (away) {
      return { status: 'redirected', website: page.finalUrl, why: `the fund-linked site now redirects to ${away}, usually after an acquisition` };
    }
    const description = describe(page);
    if (description) return { status: 'found', website: page.finalUrl, websiteSource: 'fund page', description };
    // The fund's link settles which site is the company's. Searching by name after
    // it is how Beyond Aero, the hydrogen aircraft company whose site has no
    // description tag, was matched to a bicycle retailer with the same name.
    return { status: 'no-description', website: page.finalUrl, websiteSource: 'fund page', why: 'the fund-linked site publishes no usable description' };
  }

  const domains = await clearbitDomains(names);
  if (!domains.length) return { status: 'no-website', why: [...tried, 'no exact name match for a domain'].join('; ') };

  let foundSite = null;
  for (const domain of domains) {
    if (wrongCountry(domain, company.register)) { tried.push(`${domain}: foreign-country domain`); continue; }
    const page = (await fetchText(`https://${domain}`)) || (await fetchText(`https://www.${domain}`));
    if (!page) { tried.push(`${domain}: did not load`); continue; }
    const away = redirectedAway(domain, page, names);
    if (away) { tried.push(`${domain}: redirects to ${away}`); continue; }
    if (!domainMatchesName(company.company, page.finalUrl)) { tried.push(`${rootOf(page.finalUrl)}: domain is not the company's name`); continue; }
    if (!siteShowsName(page, names)) { tried.push(`${domain}: does not show the company name`); continue; }
    if (wrongLanguage(page.html, company.register)) { tried.push(`${domain}: written in another language, likely a namesake`); continue; }
    const description = describe(page);
    if (!description) { foundSite = foundSite || page.finalUrl; tried.push(`${domain}: no usable description`); continue; }
    return { status: 'found', website: page.finalUrl, websiteSource: 'name lookup', description };
  }
  if (foundSite) return { status: 'no-description', website: foundSite, websiteSource: 'name lookup', why: tried.join('; ') };
  return { status: 'rejected-domain', why: tried.join('; ') };
}

async function main() {
  const deals = JSON.parse(fs.readFileSync(path.join(DATA, 'deals.json'), 'utf8')).deals;
  const companies = new Map();
  for (const d of deals) if (!companies.has(d.key)) companies.set(d.key, { key: d.key, company: d.company, website: d.website, register: d.register });

  const cache = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const due = (entry) => !entry || (Date.now() - new Date(entry.checkedAt)) / 864e5 > RECHECK_DAYS;
  let queue = [...companies.values()].filter((c) => due(cache[c.key]));
  if (process.env.SAMPLE) queue = queue.filter((_, i) => i % Math.ceil(queue.length / Number(process.env.SAMPLE)) === 0);

  console.log(`${companies.size} companies, ${queue.length} to look up`);
  let done = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const c = queue.shift();
      const result = await lookup(c);
      cache[c.key] = { name: c.company, ...result, checkedAt: new Date().toISOString().slice(0, 10) };
      if (++done % 100 === 0) {
        fs.writeFileSync(OUT, JSON.stringify(cache, null, 1));
        process.stdout.write(`  ${done}\r`);
      }
    }
  });
  await Promise.all(workers);
  fs.writeFileSync(OUT, JSON.stringify(cache, null, 1));

  const values = [...companies.keys()].map((k) => cache[k]).filter(Boolean);
  const tally = values.reduce((a, v) => ({ ...a, [v.status]: (a[v.status] || 0) + 1 }), {});
  console.log(`\n${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`descriptions for ${tally.found || 0} of ${companies.size} companies`);
}

module.exports = { firstSentence, searchNames, norm, domainMatchesName };
if (require.main === module) main();
