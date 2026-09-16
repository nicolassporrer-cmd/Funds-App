// Stage US-1 — every venture round raised in New York, from SEC's bulk Form D data.
//
// This replaces the fund-first route for New York. That route scraped six fund
// websites, name-matched each company to an SEC CIK and then fetched its filings,
// and it lost coverage at every step: 1,710 portfolio names became 111 CIKs and
// 72 real companies — about ten rounds in the two-year window.
//
// SEC publishes every Form D as quarterly bulk data. Starting from those and
// filtering to venture-shaped companies gives the whole market instead: around
// 50 New York venture rounds of $5m+ per quarter. Which fund is behind a round
// becomes a join against the portfolio lists afterwards, not the gate that
// decides whether the round is seen at all.
//
// Output: data/us-deals.json — TRACKED. Historical quarters never change once
// published, so they are parsed once and kept; a daily run only re-reads the
// latest two quarters, where new filings and amendments land.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { get } = require('./lib/http.cjs');

const DATA = path.join(__dirname, '..', 'data');
const RAW = path.join(DATA, 'raw', 'formd-bulk');
const OUT = path.join(DATA, 'us-deals.json');

const UA = process.env.SEC_USER_AGENT;
if (!UA || !UA.includes('@')) {
  console.error('SEC_USER_AGENT must be set to "AppName you@example.com" — SEC returns 403 without it.');
  process.exit(1);
}

// --- What counts as a venture round. Every rule here exists because a specific
// kind of filing was polluting the list without it.
const STATES = new Set(['NY']);
const MIN_AMOUNT_USD = 5_000_000;
const QUARTERS_BACK = 20; // five years: covers the 1-4 year windows plus history
const REFRESH_LATEST = 2; // quarters re-read on every run

// A startup raising venture money is almost always a corporation. The LLCs and
// LPs above $5m in New York are buyout holdcos and property vehicles:
// Speedway Holdings L.P., Nars Recap Investors LLC, OSP Rita Holdings LLC.
const VENTURE_ENTITY = 'Corporation';

// Real estate, fund-of-funds and energy project vehicles file Form D in volume
// and are never venture dealflow.
const NOT_VENTURE_INDUSTRY = /Real Estate|REITS|Investing|Oil and Gas|Other Energy|Coal|Electric Utilities|Lodging|Restaurants|Pooled Investment Fund/i;

// Corporations can still be holdcos or SPVs; their names give them away.
// "Delta Parent Holdings, Inc." is a buyout parent, not a startup.
const SPV_NAME = /\b(L\.?P\.?|LLC|L\.L\.C\.|TRUST|FUND|RECAP|PARENT|ACQUISITION|PROPERTIES|REALTY|CAPITAL PARTNERS|INVESTOR HOLDINGS)\b/i;

const truthy = (v) => /^(true|y|yes)$/i.test(String(v || '').trim());

// Name normalisation shared with the portfolio lists. Legal suffixes go, because
// a fund lists "Ramp" and Form D files "Ramp Business Corp".
const SUFFIXES = /\b(INC|INCORPORATED|CORP|CORPORATION|LLC|LP|LTD|LIMITED|CO|COMPANY|HOLDINGS?|GROUP|TECHNOLOGIES|TECHNOLOGY|LABS?|PBC|BUSINESS|SOFTWARE|SYSTEMS|AI|HQ)\b/g;
const norm = (n) => String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
  .replace(/&/g, ' AND ').replace(/[^A-Z0-9 ]/g, ' ').replace(SUFFIXES, ' ').replace(/\s+/g, ' ').trim();

// Every company on a tracked fund's portfolio page, keyed by normalised name.
// A round is kept if it is in New York OR belongs to one of these, wherever the
// company is based: a Bessemer company in San Francisco is still a New York
// fund's deal, and a Partech company in Austin is still a Paris fund's deal.
function loadPortfolioIndex() {
  const file = path.join(DATA, 'portfolios.json');
  const index = new Map();
  if (!fs.existsSync(file)) return index;
  for (const fund of JSON.parse(fs.readFileSync(file, 'utf8')).funds) {
    for (const c of fund.companies) {
      const key = norm(c.name);
      // Two-letter or generic names ("AI", "Go") would match half the register.
      if (key.length < 4) continue;
      const entry = index.get(key) || { funds: new Set(), blurb: null, website: null };
      entry.funds.add(fund.id);
      entry.blurb = entry.blurb || c.blurb || null;
      entry.website = entry.website || c.website || null;
      index.set(key, entry);
    }
  }
  return index;
}

function quarterList(now) {
  const out = [];
  let y = now.getUTCFullYear();
  let q = Math.floor(now.getUTCMonth() / 3) + 1;
  // SEC publishes a quarter some weeks after it ends, so start from the previous one.
  q -= 1;
  if (q === 0) { q = 4; y -= 1; }
  for (let i = 0; i < QUARTERS_BACK; i++) {
    out.push(`${y}q${q}`);
    q -= 1;
    if (q === 0) { q = 4; y -= 1; }
  }
  return out;
}

// SEC has moved these files between two directories over time; try both.
const URLS = (quarter) => [
  `https://www.sec.gov/files/structureddata/data/form-d-data-sets/${quarter}_d.zip`,
  `https://www.sec.gov/files/datastandardsinnovation/data/form-d-data-sets/${quarter}_d.zip`,
];

async function download(quarter) {
  const zip = path.join(RAW, `${quarter}.zip`);
  for (const url of URLS(quarter)) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) continue;
      fs.mkdirSync(RAW, { recursive: true });
      fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
      return zip;
    } catch {
      // try the other location
    }
  }
  return null;
}

function unzip(zip, quarter) {
  const dest = path.join(RAW, quarter);
  fs.mkdirSync(dest, { recursive: true });
  // Neither extractor works everywhere. On Windows, the `tar` first on PATH is
  // often Git Bash's GNU tar, which reads "C:" in a path as a remote host and
  // fails with "Cannot connect to C: resolve failed"; the bsdtar that ships in
  // System32 reads zip files correctly. On the Ubuntu CI runner GNU tar cannot
  // read zip at all, but `unzip` is installed.
  if (process.platform === 'win32') {
    execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dest]);
  } else {
    execFileSync('unzip', ['-o', '-q', zip, '-d', dest]);
  }
  const find = (dir, name) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { const hit = find(p, name); if (hit) return hit; }
      else if (entry.name === name) return p;
    }
    return null;
  };
  return { issuers: find(dest, 'ISSUERS.tsv'), offering: find(dest, 'OFFERING.tsv'), related: find(dest, 'RELATEDPERSONS.tsv') };
}

function readTsv(file) {
  const [head, ...rows] = fs.readFileSync(file, 'utf8').split('\n');
  const cols = head.split('\t').map((s) => s.trim());
  return rows.filter(Boolean).map((r) => {
    const cells = r.split('\t');
    return Object.fromEntries(cols.map((c, i) => [c, (cells[i] || '').trim()]));
  });
}

function parseQuarter(files, publicCiks, portfolio) {
  const offering = new Map(readTsv(files.offering).map((r) => [r.ACCESSIONNUMBER, r]));

  // Directors and executive officers per filing — where a fund partner sitting
  // on the board shows up, and the only investor-side names Form D carries.
  const people = new Map();
  if (files.related) {
    for (const r of readTsv(files.related)) {
      const name = [r.FIRSTNAME, r.MIDDLENAME, r.LASTNAME].filter(Boolean).join(' ');
      if (!name) continue;
      const list = people.get(r.ACCESSIONNUMBER) || [];
      list.push({ name, role: r.RELATIONSHIP_1 || r.RELATIONSHIPCLARIFICATION || null });
      people.set(r.ACCESSIONNUMBER, list);
    }
  }

  const tally = { filings: 0, inState: 0, viaPortfolio: 0, kept: 0, amendment: 0, notEquity: 0, small: 0, entity: 0, industry: 0, spvName: 0, public: 0 };
  const deals = [];

  for (const issuer of readTsv(files.issuers)) {
    if (issuer.IS_PRIMARYISSUER_FLAG !== 'YES') continue;
    tally.filings++;
    const match = portfolio.get(norm(issuer.ENTITYNAME));
    const inState = STATES.has(issuer.STATEORCOUNTRY);
    if (!inState && !match) continue;
    if (inState) tally.inState++; else tally.viaPortfolio++;

    const o = offering.get(issuer.ACCESSIONNUMBER);
    if (!o) continue;
    const amount = Number(o.TOTALAMOUNTSOLD) || 0;

    if (truthy(o.ISAMENDMENT)) { tally.amendment++; continue; }
    if (!truthy(o.ISEQUITYTYPE)) { tally.notEquity++; continue; }
    if (amount < MIN_AMOUNT_USD) { tally.small++; continue; }
    if (issuer.ENTITYTYPE !== VENTURE_ENTITY) { tally.entity++; continue; }
    if (truthy(o.ISPOOLEDINVESTMENTFUNDTYPE) || NOT_VENTURE_INDUSTRY.test(o.INDUSTRYGROUPTYPE || '')) { tally.industry++; continue; }
    if (SPV_NAME.test(issuer.ENTITYNAME)) { tally.spvName++; continue; }
    // A listed company raising privately (a PIPE) is not venture dealflow.
    // Immunovant and DarioHealth were the two that got through without this.
    if (publicCiks.has(Number(issuer.CIK))) { tally.public++; continue; }

    tally.kept++;
    const saleDate = /^\d{4}-\d{2}-\d{2}$/.test(o.SALE_DATE) ? o.SALE_DATE : null;
    deals.push({
      accession: issuer.ACCESSIONNUMBER,
      cik: String(Number(issuer.CIK)),
      company: issuer.ENTITYNAME,
      city: issuer.CITY || null,
      state: issuer.STATEORCOUNTRY,
      date: saleDate,
      incorporated: issuer.YEAROFINC_VALUE_ENTERED || null,
      incorporatedWithinFiveYears: issuer.YEAROFINC_TIMESPAN_CHOICE === 'withinFiveYears',
      industry: o.INDUSTRYGROUPTYPE || null,
      amountSold: amount,
      amountOffered: Number(o.TOTALOFFERINGAMOUNT) || null,
      investors: Number(o.TOTALNUMBERALREADYINVESTED) || null,
      revenueRange: o.REVENUERANGE && !/decline/i.test(o.REVENUERANGE) ? o.REVENUERANGE : null,
      directors: (people.get(issuer.ACCESSIONNUMBER) || []).slice(0, 12),
      // Which tracked funds list this company. Empty for most New York rounds:
      // the market is far larger than sixteen portfolio pages.
      funds: match ? [...match.funds] : [],
      blurb: match?.blurb || null,
      website: match?.website || null,
      source: inState ? 'new-york-market' : 'fund-portfolio',
    });
  }
  return { deals, tally };
}

(async () => {
  // Every CIK with a stock ticker, to drop PIPEs.
  const tickers = await get('https://www.sec.gov/files/company_tickers.json', { json: true, headers: { 'User-Agent': UA } });
  const publicCiks = new Set(Object.values(tickers).map((t) => Number(t.cik_str)));
  const portfolio = loadPortfolioIndex();
  console.log(`${portfolio.size} portfolio company names indexed for fund attribution`);
  console.log(`${publicCiks.size} listed companies loaded to exclude PIPEs`);

  const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { quarters: {} };
  const quarters = quarterList(new Date());
  let fetched = 0;
  let missing = [];

  for (const [i, quarter] of quarters.entries()) {
    const stale = i < REFRESH_LATEST;
    if (existing.quarters[quarter] && !stale) continue;

    process.stdout.write(`${quarter} `);
    const zip = (fs.existsSync(path.join(RAW, `${quarter}.zip`)) && !stale)
      ? path.join(RAW, `${quarter}.zip`)
      : await download(quarter);
    if (!zip) {
      // Not published yet (the newest quarter lags) — not an error.
      missing.push(quarter);
      console.log('not published yet');
      continue;
    }
    const { deals, tally } = parseQuarter(unzip(zip, quarter), publicCiks, portfolio);
    existing.quarters[quarter] = { deals, tally, parsedAt: new Date().toISOString() };
    fetched++;
    console.log(`${tally.kept} venture rounds (${tally.inState} New York filings + ${tally.viaPortfolio} portfolio companies elsewhere; dropped: ${tally.amendment} amendments, ${tally.notEquity} non-equity, ${tally.small} under $5m, ${tally.entity} LLC/LP, ${tally.industry} fund/real-estate/energy, ${tally.spvName} holdco names, ${tally.public} public)`);
  }

  existing.generatedAt = new Date().toISOString();
  existing.rules = { states: [...STATES], minAmountUsd: MIN_AMOUNT_USD, entity: VENTURE_ENTITY };
  fs.writeFileSync(OUT, JSON.stringify(existing, null, 1));

  const all = Object.values(existing.quarters).flatMap((q) => q.deals);
  const companies = new Set(all.map((d) => d.cik));
  console.log(`\n${Object.keys(existing.quarters).length} quarters held, ${fetched} parsed this run`);
  console.log(`${all.length} New York venture rounds across ${companies.size} companies`);
  if (missing.length) console.log(`not yet published: ${missing.join(', ')}`);
})();
