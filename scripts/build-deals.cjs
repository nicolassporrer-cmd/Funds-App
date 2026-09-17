// Stage 4c — one deal list across both registers.
//
// A deal is a round, not a company. Paris rounds come from BODACC capital
// increases, New York rounds from SEC Form D filings. They are not the same
// instrument and the page never pretends otherwise:
//
//   Paris     date only. The money goes into the prime d'émission, which is
//             never published, so an amount cannot be shown at any price.
//   New York  date AND amount. Form D states what was actually sold.
//
// Output: data/deals.json (gitignored intermediate)

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));

// --- The "Series A or later" floor.
//
// No register anywhere publishes a round label — Seed and Series A are market
// vocabulary, not legal categories — so this is a proxy, and it is named as one
// on every row.
//
// Two ways in, because neither works alone:
//   PRIOR ROUNDS  a company raising its second or later registered round is past
//                 seed by definition. Works identically in both countries, which
//                 is why it is the primary test.
//   HEADCOUNT     catches companies whose earlier rounds predate the register
//                 window — 64 French companies with 10+ staff would otherwise be
//                 dropped. INSEE only, so it cannot corroborate a US row.
const HEADCOUNT_FLOOR = '11'; // INSEE bracket 11 = 10-19 employees
const HEADCOUNT_ORDER = ['00', '01', '02', '03', '11', '12', '21', '22', '31', '32', '41', '42', '51', '52', '53'];
const bigEnough = (bracket) =>
  HEADCOUNT_ORDER.indexOf(bracket) >= HEADCOUNT_ORDER.indexOf(HEADCOUNT_FLOOR);

// The third route, US only. Form D states the amount, and an $8.6m or $19.8m
// round is past seed whatever its filing history says.
//
// Without this the prior-round test alone cut the US list from 17 rounds to 6 and
// threw out Greenlite at $16.0m and Litify at $19.8m, because a company's FIRST
// Form D looks identical to a seed. Form D history is shallower than BODACC
// history — many US companies have only ever filed once — so prior-round count
// is a much weaker instrument there than in France.
//
// This mirrors the French side rather than departing from it: each country gets
// the same primary test plus whichever scale evidence its own register publishes.
const SERIES_A_USD_FLOOR = 5_000_000;

function seriesATest({ priorRounds, headcount, amountSold }) {
  if (priorRounds >= 1) {
    return { pass: true, test: 'prior-rounds', why: `${priorRounds} earlier round${priorRounds > 1 ? 's' : ''} already on the register, so this is not a first raise` };
  }
  if (headcount && bigEnough(headcount)) {
    return { pass: true, test: 'headcount', why: `No earlier round on record, but the company declares INSEE headcount bracket ${headcount}` };
  }
  if (amountSold && amountSold >= SERIES_A_USD_FLOOR) {
    return {
      pass: true,
      test: 'amount',
      why: `No earlier round on record, but Form D states $${Math.round(amountSold).toLocaleString('en-US')} sold — past a seed round on size`,
    };
  }
  return {
    pass: false,
    test: null,
    why: headcount
      ? `First round on the register, and headcount bracket ${headcount} is below the floor`
      : amountSold
        ? `First round on the register, and Form D states $${Math.round(amountSold).toLocaleString('en-US')} sold, below the $5m floor`
        : 'First round on the register, and no headcount or amount is filed to corroborate scale',
  };
}

// Plain-language sector for a French NAF code. A company found through the
// register sweep has no fund description, and "62.01Z" means nothing to a reader,
// so the code's own INSEE heading stands in. Codes not listed show nothing rather
// than a guess.
const NAF_LABELS = [
  [/^62\.01/, 'Software development'],
  [/^62\.0/, 'IT services'],
  [/^58\.2/, 'Software publishing'],
  [/^63\.1/, 'Data processing and web platforms'],
  [/^72\.1/, 'Scientific R&D'],
  [/^72\.2/, 'Social sciences R&D'],
  [/^21/, 'Pharmaceuticals'],
  [/^26/, 'Electronics'],
  [/^32\.5/, 'Medical devices'],
  [/^61/, 'Telecommunications'],
  [/^64\.9|^66\.1/, 'Financial services'],
  [/^65/, 'Insurance'],
  [/^73/, 'Advertising and market research'],
  [/^74\.9/, 'Specialist services'],
  [/^78/, 'Employment services'],
  [/^85/, 'Education'],
  [/^86|^87|^88/, 'Health and care'],
  [/^47\.91/, 'E-commerce'],
  [/^10|^11/, 'Food and drink'],
  [/^29|^30/, 'Vehicles and transport equipment'],
  [/^27|^28/, 'Machinery and electrical equipment'],
  // The most common codes among companies whose description falls back to the
  // registry, labelled from the INSEE NAF rev. 2 headings.
  [/^70\.22/, 'Business consulting'],
  [/^70\.21/, 'Communications consulting'],
  [/^70\.10/, 'Head office and group management'],
  [/^71\.12/, 'Engineering and technical studies'],
  [/^71\.2/, 'Technical testing and analysis'],
  [/^82\.11|^82\.99/, 'Business support services'],
  [/^82\.30/, 'Events and trade shows'],
  [/^59\.1/, 'Film and video production'],
  [/^59\.2/, 'Sound recording and music publishing'],
  [/^58\.1/, 'Publishing'],
  [/^64\.19/, 'Banking'],
  [/^66\.2/, 'Insurance brokerage'],
  [/^93\.1/, 'Sports facilities and clubs'],
  [/^93\.2/, 'Leisure and entertainment'],
  [/^90\.0/, 'Performing arts'],
  [/^46\.4/, 'Wholesale of consumer goods'],
  [/^46\.3/, 'Food wholesale'],
  [/^46\.7/, 'Specialised wholesale'],
  [/^38\.1|^38\.2/, 'Waste collection and recycling'],
  [/^14/, 'Clothing'],
  [/^15/, 'Leather goods and footwear'],
  [/^33\.2/, 'Industrial installation'],
  [/^77\.1/, 'Vehicle rental'],
  [/^81\.2/, 'Cleaning services'],
  [/^22/, 'Plastics and rubber products'],
];
const SECTOR_LABEL = (naf) => (naf && NAF_LABELS.find(([re]) => re.test(naf))?.[1]) || null;

const monthsBetween = (a, b) => (new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24 * 30.44);
const GONE = ['exited', 'dormant', 'unverified'];

function build(today) {
  const { funds: fundList } = read('funds.json');
  const rounds = read('rounds.json');
  const sirenMap = read('siren-map.json');
  const fundRegion = Object.fromEntries(fundList.map((f) => [f.id, { region: f.region, register: f.register, name: f.name }]));

  const deals = [];

  // --- Paris: every capital increase large enough to read as a priced round.
  for (const company of rounds.companies) {
    if (GONE.includes(company.status)) continue;
    const meta = sirenMap.companies[company.key] || {};
    const priced = company.events.filter((e) => e.verdict === 'round-candidate');
    priced.forEach((event, index) => {
      const later = company.events.filter((e) => e.date > event.date);
      const gate = seriesATest({ priorRounds: index, headcount: meta.headcount, amountSold: null });
      deals.push({
        id: `FR:${company.siren}:${event.date}`,
        register: 'FR',
        region: 'Paris',
        regions: ['Paris'],
        date: event.date,
        monthsAgo: Math.round(monthsBetween(event.date, today) * 10) / 10,
        company: company.name,
        legalName: meta.legalName || null,
        key: company.key,
        identifier: company.siren,
        funds: company.funds,
        blurb: meta.blurb || null,
        website: meta.website || null,
        industry: SECTOR_LABEL(meta.naf),
        country: meta.country || meta.portfolioCountry || null,
        city: meta.city || null,
        founded: meta.founded || null,
        headcount: meta.headcount || null,
        // Structurally unavailable, not merely missing. The page shows a dash.
        amountSold: null,
        amountOffered: null,
        capitalAfter: event.capital ?? null,
        basis: event.basis,
        priorRounds: index,
        isLatest: index === priced.length - 1,
        bridgeSince: later.some((e) => e.verdict === 'bridge'),
        seriesA: gate.pass,
        seriesATest: gate.test,
        seriesAWhy: gate.why,
      });
    });
  }

  // --- Paris, market-wide: venture-shaped companies from every capital change
  // filed in Île-de-France, not only those on a tracked fund's page.
  //
  // A company already covered above is skipped — same register, and the portfolio
  // route carries the fund's own description. Attribution for the rest is by
  // SIREN, which is exact: if a tracked fund lists the company and its SIREN was
  // resolved, that fund is named; otherwise the round shows no fund, because the
  // French register does not name investors either.
  let parisMarket = { companies: [] };
  try {
    parisMarket = read('paris-market.json');
  } catch {
    // Market sweep has not run; the portfolio route above still stands.
  }
  const coveredSirens = new Set(rounds.companies.map((c) => c.siren));
  const fundsBySiren = new Map();
  for (const meta of Object.values(sirenMap.companies)) {
    if (meta.siren && meta.status === 'resolved' && meta.confidence !== 'low') fundsBySiren.set(meta.siren, meta);
  }

  for (const company of parisMarket.companies || []) {
    if (coveredSirens.has(company.siren)) continue;
    const known = fundsBySiren.get(company.siren);
    const sector = SECTOR_LABEL(company.naf);
    company.rounds.forEach((round, index) => {
      const later = company.series.filter((s) => s.date > round.date);
      const gate = seriesATest({ priorRounds: index, headcount: company.headcount, amountSold: null });
      deals.push({
        id: `FR:${company.siren}:${round.date}`,
        register: 'FR',
        region: 'Paris',
        regions: ['Paris'],
        date: round.date,
        monthsAgo: Math.round(monthsBetween(round.date, today) * 10) / 10,
        company: company.name,
        legalName: company.name,
        key: `FR:${company.siren}`,
        identifier: company.siren,
        funds: known?.funds || [],
        fundAttribution: known ? 'siren' : null,
        blurb: known?.blurb || null,
        website: known?.website || null,
        industry: sector,
        country: 'France',
        city: company.city,
        founded: company.founded,
        headcount: company.headcount,
        amountSold: null,
        amountOffered: null,
        capitalAfter: round.capitalAfter,
        basis: `capital +${Math.round(round.growth * 100)}% (${Math.round(round.capitalBefore).toLocaleString('fr-FR')} → ${Math.round(round.capitalAfter).toLocaleString('fr-FR')} EUR nominal)`,
        priorRounds: index,
        isLatest: index === company.rounds.length - 1,
        // A small capital step after the round is the bridge pattern.
        bridgeSince: later.some((s, i) => {
          const prev = i === 0 ? round.capitalAfter : later[i - 1].capital;
          const g = (s.capital - prev) / prev;
          return g >= 0.02 && g < 0.10;
        }),
        source: 'paris-market',
        seriesA: gate.pass,
        seriesATest: gate.test,
        seriesAWhy: gate.why,
      });
    });
  }

  // --- United States: every venture round from SEC's bulk Form D data.
  //
  // Two populations, both from fetch-formd-bulk.cjs: every New York venture round
  // regardless of backer, and any US round by a company on a tracked fund's
  // portfolio page wherever it is based. The first is what makes the New York
  // dealflow complete; the second is what shows a Paris fund's American deals.
  let usDeals = { quarters: {} };
  try {
    usDeals = read('us-deals.json');
  } catch {
    // The US stage has not run yet. Ship the French deals rather than nothing.
  }

  // Group by company so prior rounds and "latest" are computed across quarters.
  // A company can also appear twice in one quarter when it files a second
  // offering, so rounds are keyed on sale date as well.
  const byCik = new Map();
  for (const quarter of Object.values(usDeals.quarters || {})) {
    for (const d of quarter.deals) {
      if (!d.date) continue;
      const list = byCik.get(d.cik) || [];
      if (!list.some((x) => x.date === d.date)) list.push(d);
      byCik.set(d.cik, list);
    }
  }

  for (const [cik, companyRounds] of byCik) {
    companyRounds.sort((a, b) => a.date.localeCompare(b.date));
    companyRounds.forEach((round, index) => {
      const gate = seriesATest({ priorRounds: index, headcount: null, amountSold: round.amountSold });
      // The regions a deal belongs to: New York if the company is there, plus the
      // city of every tracked fund that lists it. A Kima company in Virginia is a
      // Paris fund's deal; a Bessemer company in New York is both.
      const regions = new Set();
      if (round.state === 'NY') regions.add('New York');
      for (const f of round.funds) if (fundRegion[f]) regions.add(fundRegion[f].region);
      deals.push({
        id: `US:${cik}:${round.date}`,
        register: 'US',
        region: [...regions][0] || 'New York',
        regions: [...regions],
        date: round.date,
        monthsAgo: Math.round(monthsBetween(round.date, today) * 10) / 10,
        company: round.company,
        legalName: round.company,
        key: `US:${cik}`,
        identifier: cik,
        funds: round.funds,
        // Name match against the fund's own portfolio page, never confirmed by
        // SEC — Form D does not name investors. Shown as such on the page.
        fundAttribution: round.funds.length ? 'name-match' : null,
        blurb: round.blurb || null,
        website: round.website || null,
        country: 'United States',
        city: round.city ? `${round.city}, ${round.state}` : round.state,
        founded: round.incorporated || null,
        headcount: null,
        industry: round.industry,
        directors: round.directors || [],
        investorCount: round.investors || null,
        amountSold: round.amountSold,
        amountOffered: round.amountOffered,
        capitalAfter: null,
        basis: `Form D: $${Math.round(round.amountSold).toLocaleString('en-US')} sold`,
        priorRounds: index,
        isLatest: index === companyRounds.length - 1,
        bridgeSince: false,
        seriesA: gate.pass,
        seriesATest: gate.test,
        seriesAWhy: gate.why,
      });
    });
  }

  deals.sort((a, b) => b.date.localeCompare(a.date));
  return { deals, fundRegion };
}

module.exports = { build, seriesATest };

if (require.main === module) {
  const today = new Date().toISOString().slice(0, 10);
  const { deals } = build(today);

  fs.writeFileSync(
    path.join(DATA, 'deals.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), headcountFloor: HEADCOUNT_FLOOR, deals }, null, 2)
  );

  const fr = deals.filter((d) => d.register === 'FR');
  const us = deals.filter((d) => d.register === 'US');
  const latestA = deals.filter((d) => d.isLatest && d.seriesA);
  const inWindow = latestA.filter((d) => d.monthsAgo >= 18 && d.monthsAgo < 30);

  console.log(`${deals.length} deals — ${fr.length} Paris, ${us.length} New York`);
  console.log(`  Series A or later        ${deals.filter((d) => d.seriesA).length}`);
  console.log(`    via prior rounds       ${deals.filter((d) => d.seriesATest === 'prior-rounds').length}`);
  console.log(`    via headcount only     ${deals.filter((d) => d.seriesATest === 'headcount').length}`);
  console.log(`    via Form D amount      ${deals.filter((d) => d.seriesATest === 'amount').length}`);
  console.log(`  latest round per company ${latestA.length}`);
  console.log(`  in the 18-30 month band  ${inWindow.length}`);
  console.log(`  US deals with an amount  ${us.filter((d) => d.amountSold).length}/${us.length}`);
}
