// Stage 2b — turn a US portfolio company name into an SEC CIK.
//
// The US counterpart to resolve-sirens.cjs, and it carries the same danger: a
// wrong CIK produces a complete, plausible, entirely fictional funding history.
// So matches are scored and anything weak is recorded as unresolved, never guessed.
//
// The search is restricted to companies that have actually filed a Form D. That
// is a strong filter on its own — a Form D means a private securities offering,
// which is what we are looking for — and it keeps the namespace far smaller than
// the French one, where every SCI shares a startup's name.
//
// Output: data/cik-map.json — TRACKED, same reasoning as the SIREN map.

const fs = require('fs');
const path = require('path');
const { get } = require('./lib/http.cjs');

const DATA = path.join(__dirname, '..', 'data');
const MAP_PATH = path.join(DATA, 'cik-map.json');

// www.sec.gov answers 403 to any request without a declared "AppName contact@email"
// user agent, on the very first call. The message says "Request Rate Threshold
// Exceeded", which it is not.
const UA = process.env.SEC_USER_AGENT;
if (!UA || !UA.includes('@')) {
  console.error('SEC_USER_AGENT must be set to "AppName you@example.com" — SEC returns 403 without it.');
  process.exit(1);
}

const SCORER_VERSION = 1;

function normalise(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// US legal suffixes, stripped before comparison: "Ramp" trades as Ramp and files
// as "Ramp Business Corp".
const SUFFIXES = /\b(INC|INCORPORATED|CORP|CORPORATION|LLC|LP|LTD|LIMITED|CO|COMPANY|HOLDINGS?|GROUP|TECHNOLOGIES|TECHNOLOGY|LABS?|BUSINESS|SOFTWARE|SYSTEMS)\b/g;
const bare = (n) => normalise(n).replace(SUFFIXES, ' ').replace(/\s+/g, ' ').trim();

function scoreCandidate(candidate, wanted) {
  const name = normalise(candidate.name);
  const why = [];
  let points = 0;

  if (name === wanted) { points += 5; why.push('exact name'); }
  else if (bare(candidate.name) === bare(wanted)) { points += 4; why.push('name minus legal suffix'); }
  else if (name.startsWith(wanted + ' ')) { points += 3; why.push('name prefix'); }
  else return { points: -1, why: ['name does not match'] };

  // A Form D filer is by definition a private issuer raising capital.
  if (candidate.formDCount >= 2) { points += 2; why.push(`${candidate.formDCount} Form D filings`); }
  else if (candidate.formDCount === 1) { points += 1; why.push('1 Form D filing'); }

  if (candidate.state === 'NY') { points += 1; why.push('New York'); }

  return { points, why };
}

const confidenceOf = (p) => (p >= 7 ? 'high' : p >= 5 ? 'medium' : 'low');

// EDGAR's company search, filtered to Form D filers.
//
// The Atom version of this endpoint is unusable: a long-standing SEC bug emits
// every company name as a raw Perl reference — `name="ARRAY(0x5602cff89378)"` —
// so the feed carries CIKs and addresses but no names at all. The HTML listing
// carries the names, so that is what we parse.
function parseCompanyList(html) {
  const out = [];
  // Row by row, because the state cell wraps its value in a link
  // (`<td><a href="...">NY</a></td>`) while the name cell does not — one
  // expression spanning both silently matched nothing.
  for (const row of html.split(/<tr[^>]*>/i).slice(1)) {
    const cik = (row.match(/CIK=(\d{10})/) || [])[1];
    if (!cik) continue;
    const name = (row.match(/<td[^>]*>([^<]{2,90})<\/td>/) || [])[1];
    if (!name || !/[A-Za-z]/.test(name)) continue;
    const state = (row.match(/>([A-Z]{2})<\/a>\s*<\/td>/) || [])[1] || null;
    out.push({ cik, name: name.trim(), state, formDCount: 0 });
  }
  return out;
}

async function candidatesFor(name) {
  const url =
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany' +
    `&company=${encodeURIComponent(name)}&type=D&dateb=&owner=include&count=20`;
  const html = await get(url, { minGapMs: 130, headers: { 'User-Agent': UA } });
  return parseCompanyList(html);
}

// The company-search feed gives a CIK but not always a usable name or state, so
// the winner is confirmed against the submissions API, which also tells us where
// the issuer is based — the field the New York filter needs.
async function confirm(cik) {
  const padded = String(cik).padStart(10, '0');
  const json = await get(`https://data.sec.gov/submissions/CIK${padded}.json`, {
    minGapMs: 130,
    json: true,
    headers: { 'User-Agent': UA },
  });
  const recent = json.filings?.recent || {};
  const formD = (recent.form || []).filter((f) => f === 'D' || f === 'D/A').length;
  return {
    name: json.name,
    state: json.addresses?.business?.stateOrCountry || null,
    city: json.addresses?.business?.city || null,
    sic: json.sicDescription || null,
    formDCount: formD,
  };
}

async function resolve(name) {
  const wanted = normalise(name);
  let candidates;
  try {
    candidates = await candidatesFor(name);
  } catch (err) {
    return { status: 'error', error: err.message };
  }
  if (!candidates.length) return { status: 'not-found' };

  const ranked = candidates
    .map((c) => ({ c, ...scoreCandidate(c, wanted) }))
    .filter((r) => r.points >= 0)
    .sort((a, b) => b.points - a.points);
  if (!ranked.length) return { status: 'no-name-match', candidates: candidates.length };

  const best = ranked[0];
  let detail = {};
  try {
    detail = await confirm(best.c.cik);
  } catch {
    // The submissions API occasionally 404s for a CIK the search feed knows.
    // Keep the match but say the state is unknown rather than inventing one.
  }

  const points = best.points + (detail.state === 'NY' ? 1 : 0);
  return {
    status: 'resolved',
    cik: best.c.cik,
    legalName: detail.name || best.c.name,
    state: detail.state || null,
    city: detail.city || null,
    sic: detail.sic || null,
    formDCount: detail.formDCount ?? best.c.formDCount,
    confidence: confidenceOf(points),
    scorerVersion: SCORER_VERSION,
    score: points,
    reasons: best.why,
    alternatives: ranked.slice(1, 3).map((r) => `${r.c.cik} ${r.c.name} (${r.points})`),
  };
}

module.exports = { resolve, normalise, scoreCandidate };

if (require.main === module) {
  (async () => {
    const { funds } = JSON.parse(fs.readFileSync(path.join(DATA, 'portfolios.json'), 'utf8'));
    const usFunds = funds.filter((f) => f.register === 'US');
    const existing = fs.existsSync(MAP_PATH)
      ? JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'))
      : { note: 'name -> SEC CIK cache. Set "manual": true on an entry to pin it; the pipeline never overwrites those.', companies: {} };

    const names = new Map();
    for (const fund of usFunds) {
      for (const company of fund.companies) {
        const key = normalise(company.name);
        if (!key) continue;
        if (!names.has(key)) names.set(key, { name: company.name, funds: [], holdings: {}, blurb: company.blurb, website: company.website });
        const entry = names.get(key);
        entry.funds.push(fund.id);
        entry.holdings[fund.id] = company.holding || 'unknown';
      }
    }

    console.log(`${usFunds.length} US funds, ${names.size} distinct companies to resolve`);
    const tally = {};
    let done = 0;

    for (const [key, info] of names) {
      const prior = existing.companies[key];
      if (prior) { prior.funds = info.funds; prior.holdings = info.holdings; prior.blurb = info.blurb || null; }
      if (prior?.manual) { tally.manual = (tally.manual || 0) + 1; continue; }
      if (prior && prior.scorerVersion === SCORER_VERSION && prior.status === 'resolved' && prior.confidence !== 'low') {
        tally.cached = (tally.cached || 0) + 1;
        continue;
      }

      const result = await resolve(info.name);
      existing.companies[key] = { name: info.name, funds: info.funds, holdings: info.holdings, blurb: info.blurb || null, website: info.website || null, ...result };
      tally[result.status] = (tally[result.status] || 0) + 1;
      if (++done % 50 === 0) process.stdout.write(`  ${done} resolved\r`);
    }

    const current = new Set(names.keys());
    Object.keys(existing.companies)
      .filter((k) => !current.has(k) && !existing.companies[k].manual)
      .forEach((k) => delete existing.companies[k]);

    fs.writeFileSync(MAP_PATH, JSON.stringify(existing, null, 2) + '\n');

    const all = Object.values(existing.companies);
    const usable = all.filter((c) => c.status === 'resolved' && c.confidence !== 'low');
    console.log(`\nStatus: ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    console.log(`Usable CIKs: ${usable.length}/${all.length} (${usable.filter((c) => c.state === 'NY').length} New York)`);
  })();
}
