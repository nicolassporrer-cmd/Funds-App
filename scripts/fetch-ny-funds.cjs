// Stage 8 — the New York fund universe, from Form D.
//
// Every fund raising money in the US files Form D and declares what kind of fund
// it is, so the venture and private-equity firms based in New York can be
// enumerated directly, with the amount each vehicle raised and when it closed.
// That is the sourced half of "do they have dry powder": when money came in.
//
// The other half — how many deals a firm has done — is NOT filed by anyone. No
// SEC document names a company's investors. What both sides do file is people: a
// fund lists its partners, and a company lists its directors, so a partner who
// takes a board seat appears on both. That link is real and verifiable — Eric
// Hippeau to Lerer Hippeau to Opentrons — but it catches only about an eighth of
// New York rounds, so every count here is a floor and is labelled as one.
//
// Output: data/ny-funds.json — TRACKED.

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const RAW = path.join(DATA, 'raw', 'formd-bulk');
const OUT = path.join(DATA, 'ny-funds.json');

// Kept firms: institutional scale, not the long tail of one-off SPVs. At this
// floor the list is 116 firms — a working list rather than a 5,000-row directory.
const MIN_RAISED = 50_000_000;
const MIN_VEHICLES = 2;
const COMPANY_MIN_ROUND = 5_000_000;
const FUND_TYPES = /venture capital fund|private equity fund/i;

// Form D has no "growth" type — a firm files as Venture Capital or Private
// Equity — so growth investors have to be recovered from the private-equity
// side without dragging in buyout, property, credit and infrastructure houses.
//
// Asset classes that are never tech, by name.
const NOT_TECH = /REAL ESTATE|REALTY|PROPERT|INFRASTRUCTURE|CREDIT|LENDING|MEZZANINE|ENERGY|POWER|RENEWABLE|SOLAR|MINERAL|TIMBER|AGRICULT|ROYALT|INSURANCE|SECONDAR|STRATEGIC PARTNERS|MUNICIPAL|MORTGAGE|DEBT|DISTRESS|BUYOUT|RESIDENTIAL|HOTEL|LOGISTICS|AVIATION|SHIPPING/;

// And a private-equity house earns its place only by actually showing up in a
// tech round: without this the list opened with Apollo, Blackstone Real Estate,
// KKR Infrastructure and Stonepeak, none of which Nicolas would call a tech fund.
const keepFirm = (f) =>
  !NOT_TECH.test(f.key) &&
  f.vehicles >= MIN_VEHICLES &&
  f.raised >= MIN_RAISED &&
  (f.type === 'Venture' || f.linkedDeals > 0);

const readTsv = (file) => {
  const [head, ...rows] = fs.readFileSync(file, 'utf8').split('\n');
  const cols = head.split('\t').map((s) => s.trim());
  return rows.filter(Boolean).map((r) => {
    const cells = r.split('\t');
    return Object.fromEntries(cols.map((c, i) => [c, (cells[i] || '').trim()]));
  });
};

const findFile = (dir, name) => {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === name) return p;
    }
  }
  return null;
};

const truthy = (v) => /^(true|y|yes)$/i.test(String(v || '').trim());

// A round only counts as a tech round on the same terms the deal log uses.
const NOT_VENTURE_ROUND = /Real Estate|REITS|Investing|Oil and Gas|Other Energy|Coal|Electric Utilities|Lodging|Restaurants|Pooled Investment Fund/i;
const SPV_NAME = /\b(L\.?P\.?|LLC|L\.L\.C\.|TRUST|FUND|RECAP|PARENT|ACQUISITION|PROPERTIES|REALTY|CAPITAL PARTNERS|INVESTOR HOLDINGS)\b/i;
const iso = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

// A firm raises Fund I, Fund II, an annex, a co-invest vehicle and a parallel
// Cayman feeder, all separately. Strip the series markers so they collapse into
// one firm; keep the brand words, because "Thrive" and "Thrive Capital Partners"
// are merged afterwards by the prefix rule instead.
const SERIES_WORD = /^(I{1,3}|IV|VI{0,3}|IX|XI{0,3}|XI[VX]|XV I{0,3}|X{1,3}|[0-9]+|[A-Z]|SPV|ANNEX|SELECT|OPPORTUNITY|OPPORTUNITIES|PARALLEL|MASTER|FEEDER|QP|CLASS|SERIES|INSTITUTIONAL|OFFSHORE|ONSHORE|CAYMAN|DELAWARE|CO|COINVEST|COINVESTMENT|COINVESTORS|INVESTORS|AIV|LP|LLC|LTD|INC|CORP|TRUST|HOLDINGS?)$/;

function firmKey(entityName) {
  let words = String(entityName)
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ');
  while (words.length > 1 && SERIES_WORD.test(words[words.length - 1])) words.pop();
  return words.join(' ');
}

function collect() {
  const firms = new Map();
  const peopleToFirm = new Map();
  const companyRounds = [];

  for (const quarter of fs.readdirSync(RAW)) {
    const dir = path.join(RAW, quarter);
    if (!fs.statSync(dir).isDirectory()) continue;
    const issuersFile = findFile(dir, 'ISSUERS.tsv');
    const offeringFile = findFile(dir, 'OFFERING.tsv');
    if (!issuersFile || !offeringFile) continue;

    const offering = new Map(readTsv(offeringFile).map((r) => [r.ACCESSIONNUMBER, r]));
    const related = new Map();
    const relatedFile = findFile(dir, 'RELATEDPERSONS.tsv');
    if (relatedFile) {
      for (const r of readTsv(relatedFile)) {
        const name = [r.FIRSTNAME, r.LASTNAME].filter(Boolean).join(' ').toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
        if (name.length < 7) continue; // a bare "JOHN" or "LI" matches too much
        (related.get(r.ACCESSIONNUMBER) || related.set(r.ACCESSIONNUMBER, []).get(r.ACCESSIONNUMBER)).push(name);
      }
    }

    for (const issuer of readTsv(issuersFile)) {
      if (issuer.IS_PRIMARYISSUER_FLAG !== 'YES' || issuer.STATEORCOUNTRY !== 'NY') continue;
      const o = offering.get(issuer.ACCESSIONNUMBER);
      if (!o) continue;
      const pooled = truthy(o.ISPOOLEDINVESTMENTFUNDTYPE) || o.INDUSTRYGROUPTYPE === 'Pooled Investment Fund';
      const people = related.get(issuer.ACCESSIONNUMBER) || [];
      const amount = Number(o.TOTALAMOUNTSOLD) || 0;
      const date = iso(o.SALE_DATE);

      if (pooled) {
        if (!FUND_TYPES.test(o.INVESTMENTFUNDTYPE || '')) continue;
        const key = firmKey(issuer.ENTITYNAME);
        if (!key) continue;
        const firm = firms.get(key) || { key, vehicles: new Map(), people: new Set(), types: {} };
        // One vehicle can file twice (an amendment); keep the larger figure.
        const prior = firm.vehicles.get(issuer.CIK);
        if (!prior || amount > prior.amountSold) {
          firm.vehicles.set(issuer.CIK, { name: issuer.ENTITYNAME, amountSold: amount, date: date || prior?.date || null, type: o.INVESTMENTFUNDTYPE });
        }
        firm.types[o.INVESTMENTFUNDTYPE] = (firm.types[o.INVESTMENTFUNDTYPE] || 0) + 1;
        people.forEach((p) => firm.people.add(p));
        firms.set(key, firm);
      } else if (
        !truthy(o.ISAMENDMENT) && truthy(o.ISEQUITYTYPE) && amount >= COMPANY_MIN_ROUND && date &&
        // The same venture shape the deal log uses. Without it the linking side
        // was full of property vehicles, and Blackstone Private Equity Strategies
        // reached the top of this list on the strength of "KPR Pointe Plaza
        // Investor LLC" — a real-estate SPV, not a tech round.
        issuer.ENTITYTYPE === 'Corporation' &&
        !NOT_VENTURE_ROUND.test(o.INDUSTRYGROUPTYPE || '') &&
        !SPV_NAME.test(issuer.ENTITYNAME)
      ) {
        companyRounds.push({ company: issuer.ENTITYNAME, date, amount, people, cik: String(Number(issuer.CIK)) });
      }
    }
  }

  // "THRIVE" and "THRIVE CAPITAL PARTNERS" are the same house filing under two
  // naming habits. Fold the longer key into the shorter one when it starts with it.
  const keys = [...firms.keys()].sort((a, b) => a.length - b.length);
  for (const long of [...keys].reverse()) {
    const parent = keys.find((k) => k !== long && k.length < long.length && long.startsWith(k + ' '));
    if (!parent || !firms.has(long) || !firms.has(parent)) continue;
    const from = firms.get(long);
    const into = firms.get(parent);
    from.vehicles.forEach((v, cik) => { if (!into.vehicles.has(cik)) into.vehicles.set(cik, v); });
    from.people.forEach((p) => into.people.add(p));
    Object.entries(from.types).forEach(([t, n]) => { into.types[t] = (into.types[t] || 0) + n; });
    firms.delete(long);
  }

  for (const [key, firm] of firms) for (const p of firm.people) {
    // A partner at two firms would otherwise credit both; keep the first and
    // record nothing rather than guess.
    if (peopleToFirm.has(p)) peopleToFirm.set(p, null);
    else peopleToFirm.set(p, key);
  }

  return { firms, peopleToFirm, companyRounds };
}

(() => {
  const { firms, peopleToFirm, companyRounds } = collect();

  const linked = new Map();
  let linkedRounds = 0;
  for (const round of companyRounds) {
    const hit = round.people.map((p) => peopleToFirm.get(p)).find(Boolean);
    if (!hit) continue;
    linkedRounds++;
    (linked.get(hit) || linked.set(hit, []).get(hit)).push(round);
  }

  const out = [];
  for (const [key, firm] of firms) {
    const vehicles = [...firm.vehicles.values()].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const raised = vehicles.reduce((n, v) => n + v.amountSold, 0);
    const deals = (linked.get(key) || []).sort((a, b) => b.date.localeCompare(a.date));
    const candidate = {
      key,
      name: vehicles[0]?.name || key,
      vehicles: vehicles.length,
      raised,
      raised2026: vehicles.filter((v) => v.date >= '2026-01-01').reduce((n, v) => n + v.amountSold, 0),
      lastClose: vehicles.find((v) => v.date)?.date || null,
      type: (firm.types['Venture Capital Fund'] || 0) >= (firm.types['Private Equity Fund'] || 0) ? 'Venture' : 'Private equity',
      partners: firm.people.size,
      topVehicles: vehicles.slice(0, 4).map((v) => ({ name: v.name, amountSold: v.amountSold, date: v.date })),
      linkedDeals: deals.length,
      linkedDeals2026: deals.filter((d) => d.date >= '2026-01-01').length,
      recentDeals: deals.slice(0, 8).map((d) => ({ company: d.company, date: d.date, amount: d.amount })),
    };
    if (keepFirm(candidate)) out.push(candidate);
  }
  out.sort((a, b) => b.raised - a.raised);

  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        rules: { state: 'NY', types: 'Venture Capital Fund or Private Equity Fund', minRaised: MIN_RAISED, minVehicles: MIN_VEHICLES },
        firms: out,
      },
      null,
      1
    )
  );

  console.log(`${firms.size} NY venture/PE firms found, ${out.length} above the size floor`);
  console.log(`company rounds >= $5m: ${companyRounds.length}, of which ${linkedRounds} link to one of these firms through a shared person (${Math.round((100 * linkedRounds) / companyRounds.length)}%)`);
  console.log(`firms with a 2026 close: ${out.filter((f) => f.raised2026 > 0).length} | with a 2026 linked deal: ${out.filter((f) => f.linkedDeals2026 > 0).length}`);
  console.log('\nlargest by capital raised:');
  out.slice(0, 12).forEach((f) =>
    console.log(
      `  ${f.key.slice(0, 30).padEnd(32)}$${(f.raised / 1e9).toFixed(2)}bn`.padEnd(45) +
        `${String(f.vehicles).padStart(3)} vehicles  last ${f.lastClose || '—'}  ${String(f.linkedDeals).padStart(3)} linked deals (${f.linkedDeals2026} in 2026)`
    )
  );
})();
