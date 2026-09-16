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
