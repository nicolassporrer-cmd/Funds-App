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
const prospects = read('prospects.json');
const contacts = read('contacts.json');

const prospectByKey = new Map(prospects.companies.map((p) => [p.key, p]));

// Scraped deal lead per company, where a fund publishes one.
const dealLeadByKey = new Map();
for (const fund of portfolios.funds) {
  for (const company of fund.companies) {
    if (company.dealLead) dealLeadByKey.set(company.name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(), company.dealLead);
  }
}

// Curated contact: a per-company entry wins over the fund default. Kept separate
// from everything else in the payload so the page can mark it as hand-entered
// rather than sourced.
function contactFor(key, funds) {
  const byCompany = contacts.byCompany?.[key];
  if (byCompany) return { who: byCompany, origin: 'curated' };
  const scraped = dealLeadByKey.get(key);
  if (scraped) return { who: scraped, origin: 'from the fund’s own company page' };
  for (const id of funds) {
    if (contacts.byFund?.[id]) return { who: contacts.byFund[id], origin: `curated, ${id} default` };
  }
  return null;
}

// What can honestly be said about how far along a company is. Deliberately NOT
// a "Series B" label: no free source publishes one, and inventing it would be
// exactly the kind of plausible-looking fiction this app exists to avoid.
function stageEvidence(meta, company) {
  const out = [];
  if (meta.headcount && meta.headcount !== 'NN') out.push({ label: 'Headcount bracket', value: meta.headcount, source: 'INSEE' });
  if (meta.sizeCategory) out.push({ label: 'Size category', value: meta.sizeCategory, source: 'INSEE' });
  if (company?.rounds?.length) out.push({ label: 'Rounds visible in the register', value: String(company.rounds.length), source: 'BODACC' });
  if (meta.founded) out.push({ label: 'Incorporated', value: meta.founded, source: 'company registry' });
  const years = Object.keys(meta.accounts || {}).sort();
  const latest = years[years.length - 1];
  if (latest) {
    const f = meta.accounts[latest];
    // The year is part of the value, never dropped: the most recent filed
    // accounts are frequently several years old.
    if (f.ca != null) out.push({ label: `Revenue (${latest}, last filed)`, value: Math.round(f.ca).toLocaleString('fr-FR') + ' €', source: 'filed accounts' });
    if (f.resultat_net != null) out.push({ label: `Net result (${latest}, last filed)`, value: Math.round(f.resultat_net).toLocaleString('fr-FR') + ' €', source: 'filed accounts' });
  }
  return out;
}

const byKey = new Map(rounds.companies.map((c) => [c.key, c]));

// Only events that mean something get shipped. "Dépôt des comptes" rows are 60%
// of the register and say nothing about fundraising.
const INTERESTING = new Set(['round-candidate', 'bridge', 'employee-equity', 'increase-unsized', 'capital-decrease', 'capital-restructure', 'structural', 'structural-with-capital']);

// A company appears once but can be held by several funds, and they can disagree
// — Partech may have exited what Kima still holds. "Still held by at least one
// fund" is the useful reading, so any 'current' wins; only when every fund that
// publishes a status says exited is the company treated as exited.
function overallHolding(holdings = {}) {
  const values = Object.values(holdings).filter((v) => v && v !== 'unknown');
  if (!values.length) return 'unknown';
  return values.includes('current') ? 'current' : 'exited';
}

// Why a company has no register history. Shown verbatim rather than hidden: on a
// global fund's page most of the portfolio is simply not French.
const UNTRACKED_REASON = {
  'not-found': 'No French company registry entry under this name — most likely headquartered abroad.',
  'no-name-match': 'French companies exist with similar names, but none matched closely enough to be safe.',
  ambiguous: 'Several French companies match this name equally well, so picking one would be a guess.',
  error: 'The company registry lookup failed for this name.',
};

const tracked = rounds.companies.map((c) => {
  const meta = sirenMap.companies[c.key] || {};
  const holding = overallHolding(meta.holdings);
  const prospect = prospectByKey.get(c.key) || {};
  return {
    tracked: true,
    // The raise signal — the reason this app exists. Every component is carried
    // with it so the ranking can be argued with rather than trusted blindly.
    score: prospect.score ?? 0,
    signals: prospect.signals || [],
    dueInMonths: prospect.dueInMonths ?? null,
    hasBridge: prospect.hasBridge || false,
    investorOfficers: prospect.investorOfficers || [],
    auditors: prospect.auditors || [],
    stage: stageEvidence(meta, c),
    contact: contactFor(c.key, c.funds),
    holding,
    holdings: meta.holdings || {},
    key: c.key,
    name: c.name,
    legalName: meta.legalName || null,
    siren: c.siren,
    confidence: meta.confidence || null,
    department: meta.department || null,
    founded: meta.founded || null,
    city: meta.city || null,
    country: meta.country || meta.portfolioCountry || null,
    website: meta.website || null,
    blurb: meta.blurb || null,
    funds: c.funds,
    // A fund saying it has exited outranks anything the register timing implies:
    // there is no point alerting that a company is overdue to raise from a fund
    // that has already sold its position.
    status: holding === 'exited' ? 'exited' : c.status,
    why:
      holding === 'exited'
        ? `Every fund here that publishes a holding status lists this company as exited or alumni. Excluded from the alerts. Register timing is still shown below.`
        : c.why,
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

// Every OTHER company on a fund's portfolio page — the ones with no usable
// French SIREN. Previously dropped, which made a fund's page look like a
// French-only portfolio: Partech listed 271 companies and showed 125.
// They carry no round data and say so, but the name, what they do and where
// they are is real information the fund itself published.
const trackedKeys = new Set(tracked.map((c) => c.key));
const untracked = Object.entries(sirenMap.companies)
  .filter(([key]) => !trackedKeys.has(key))
  .map(([key, meta]) => ({
    tracked: false,
    score: 0,
    signals: [],
    dueInMonths: null,
    hasBridge: false,
    investorOfficers: [],
    auditors: [],
    stage: [],
    contact: contactFor(key, meta.funds || []),
    holding: overallHolding(meta.holdings),
    holdings: meta.holdings || {},
    key,
    name: meta.name,
    legalName: null,
    siren: meta.confidence === 'low' ? meta.siren || null : null,
    confidence: meta.confidence || null,
    department: null,
    founded: null,
    city: null,
    country: meta.portfolioCountry || null,
    website: meta.website || null,
    blurb: meta.blurb || null,
    funds: meta.funds || [],
    status: 'untracked',
    why: UNTRACKED_REASON[meta.status] || 'No French company registry match confident enough to use.',
    lastRound: null,
    monthsSince: null,
    cycleMonths: null,
    cycleMeasured: false,
    roundCount: 0,
    capital: null,
    events: [],
  }));

const companies = [...tracked, ...untracked];

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
    listedCurrent: scraped ? scraped.companies.filter((c) => c.holding === 'current').length : 0,
    listedExited: scraped ? scraped.companies.filter((c) => c.holding === 'exited').length : 0,
    tracked: mine.filter((c) => c.tracked).length,
    untracked: mine.filter((c) => !c.tracked).length,
    // What the fund still holds, as far as anyone can tell: it has not said it
    // exited, the register does not say it is dormant, and the SIREN checks out.
    live: mine.filter((c) => !['exited', 'dormant', 'unverified'].includes(c.status)).length,
    // Companies this fund holds that are showing a raise signal — the headline
    // number for a fund, and what its row is sorted by.
    raising: mine.filter((c) => c.tracked && !['exited','dormant','unverified'].includes(c.status) && c.score >= 40).length,
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
    companies: companies.length,
    tracked: tracked.length,
    overdue: statusCount('overdue'),
    dueSoon: statusCount('due-soon'),
    recent: statusCount('recent'),
    noSignal: statusCount('no-signal'),
    unverified: statusCount('unverified'),
    untracked: statusCount('untracked'),
    dormant: statusCount('dormant'),
    exited: statusCount('exited'),
    holdingCurrent: companies.filter((c) => c.holding === 'current').length,
    holdingUnknown: companies.filter((c) => c.holding === 'unknown').length,
    roundCandidates: companies.reduce((n, c) => n + c.roundCount, 0),
    strongSignal: companies.filter((c) => c.score >= 60).length,
    withBridge: companies.filter((c) => c.hasBridge).length,
    withInvestorOfficer: companies.filter((c) => c.investorOfficers.length).length,
    withContact: companies.filter((c) => c.contact).length,
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
    'INVESTOR identity per round is not in BODACC. Which fund holds which company comes from the fund’s own portfolio page, so it reflects what the fund chooses to publish.',
    'A fund’s portfolio page is a HISTORY, not an inventory. Most list every company the fund has ever backed — Partech tags 63 of its 271 as alumni, Kima lists over 950 against a far smaller live portfolio. Only Partech and Elaia publish the current/exited distinction; for every other fund the split is unknown, and dormancy in the register is the only exit signal available.',
    'A "round candidate" is a heuristic: a capital increase of at least ' + Math.round(rounds.thresholds.ROUND_MIN_GROWTH * 100) + '% of existing capital. Smaller increases are treated as employee option exercises and excluded.',
    'Companies with no usable SIREN are omitted entirely rather than shown with unverified data. Most are non-French holdings.',
    'Companies marked “dormant” have filed nothing at all with the register for four years or more. They have almost certainly been acquired, wound down or listed — funds routinely leave exits on their portfolio pages — so they are excluded from the alerts rather than reported as wildly overdue.',
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
