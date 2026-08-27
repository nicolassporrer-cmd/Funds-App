// Stage 5 — assemble everything the page renders, and nothing it does not.
//
// Output: data/payload.json — TRACKED. This is the only data file the site reads.

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));

const { funds: fundList } = read('funds.json');
const portfolios = read('portfolios.json');
const sirenMap = read('siren-map.json');
const rounds = read('rounds.json');

const byKey = new Map(rounds.companies.map((c) => [c.key, c]));

// Only events that mean something get shipped. "Dépôt des comptes" rows are 60%
// of the register and say nothing about fundraising.
const INTERESTING = new Set(['round-candidate', 'employee-equity', 'increase-unsized', 'capital-decrease', 'capital-restructure', 'structural', 'structural-with-capital']);

const companies = rounds.companies.map((c) => {
  const meta = sirenMap.companies[c.key] || {};
  return {
    key: c.key,
    name: c.name,
    legalName: meta.legalName || null,
    siren: c.siren,
    confidence: meta.confidence || null,
    department: meta.department || null,
    website: meta.website || null,
    blurb: meta.blurb || null,
    funds: c.funds,
    status: c.status,
    why: c.why,
    lastRound: c.lastRound,
    monthsSince: c.monthsSince,
    cycleMonths: c.cycle.months,
    cycleMeasured: c.cycle.measured,
    roundCount: c.rounds.length,
    capital: [...c.events].reverse().find((e) => e.capital !== null)?.capital ?? null,
    events: c.events
      .filter((e) => INTERESTING.has(e.verdict))
      .map((e) => ({ date: e.date, verdict: e.verdict, basis: e.basis, capital: e.capital, growth: e.growth })),
  };
});

const fundsOut = fundList.map((fund) => {
  const scraped = portfolios.funds.find((f) => f.id === fund.id);
  const mine = companies.filter((c) => c.funds.includes(fund.id));
  return {
    id: fund.id,
    name: fund.name,
    city: fund.city,
    type: fund.type,
    site: fund.site,
    portfolioUrl: fund.portfolioUrl,
    listed: scraped ? scraped.companies.length : 0,
    tracked: mine.length,
    overdue: mine.filter((c) => c.status === 'overdue').length,
    dueSoon: mine.filter((c) => c.status === 'due-soon').length,
  };
});

const statusCount = (s) => companies.filter((c) => c.status === s).length;

const payload = {
  generatedAt: new Date().toISOString(),
  thresholds: rounds.thresholds,
  totals: {
    funds: fundsOut.length,
    listedHoldings: fundsOut.reduce((n, f) => n + f.listed, 0),
    distinctNames: Object.keys(sirenMap.companies).length,
    tracked: companies.length,
    overdue: statusCount('overdue'),
    dueSoon: statusCount('due-soon'),
    recent: statusCount('recent'),
    noSignal: statusCount('no-signal'),
    unverified: statusCount('unverified'),
    roundCandidates: companies.reduce((n, c) => n + c.roundCount, 0),
  },
  sources: [
    { name: 'Fund portfolio pages', detail: `${fundsOut.length} Paris funds, scraped from their own published portfolio or sitemap` },
    { name: 'recherche-entreprises.api.gouv.fr', detail: 'company name to SIREN, scored — low-confidence matches are dropped, not guessed' },
    { name: 'BODACC (DILA open data)', detail: 'official register announcements: dates and share capital after each change' },
  ],
  // Shown on the page. These are limits of the source data, not of the code, and
  // they are the difference between a useful signal and a fabricated one.
  caveats: [
    'Round AMOUNTS are not published anywhere in the French register. Investment lands in the prime d’émission, which BODACC never prints — only nominal share capital moves. This app dates rounds; it never sizes them.',
    'Round LABELS (Seed, Series A/B) do not exist as a legal concept and are not shown.',
    'INVESTOR identity per round is not in BODACC. Which fund holds which company comes from the fund’s own portfolio page, so it reflects what the fund chooses to publish — including exits it has not removed.',
    'A "round candidate" is a heuristic: a capital increase of at least ' + Math.round(rounds.thresholds.ROUND_MIN_GROWTH * 100) + '% of existing capital. Smaller increases are treated as employee option exercises and excluded.',
    'Companies with no usable SIREN are omitted entirely rather than shown with unverified data. Most are non-French holdings.',
    'Companies marked “unverified” matched a SIREN that has no register announcements at all. An operating French company always has some, so the name almost certainly matched a dormant namesake. They are listed separately and never counted in the alerts.',
  ],
  funds: fundsOut,
  companies,
};

fs.writeFileSync(path.join(DATA, 'payload.json'), JSON.stringify(payload) + '\n');

const bytes = fs.statSync(path.join(DATA, 'payload.json')).size;
console.log(`payload.json: ${(bytes / 1024).toFixed(0)} KB`);
console.log(`  ${payload.totals.funds} funds, ${payload.totals.listedHoldings} listed holdings, ${payload.totals.tracked} companies tracked`);
console.log(`  ${payload.totals.overdue} overdue, ${payload.totals.dueSoon} due soon, ${payload.totals.recent} recent, ${payload.totals.noSignal} no signal`);
