// Stage FR-market — every priced round in Île-de-France, from the whole register.
//
// The Paris counterpart to fetch-formd-bulk.cjs, and for the same reason. The
// fund-first route only sees companies that appear on ten fund websites, so the
// Paris list was small and dominated by Kima, whose portfolio page lists close to
// a thousand companies. Starting from every capital change filed in Île-de-France
// sees the market instead, and the Kima skew goes with it.
//
// It is harder than New York. Form D states the amount raised, so a $5m floor
// cleaned that list in one line. The French register never publishes amounts,
// so venture rounds have to be separated from ordinary SMEs by shape: a
// share-issuing company form, a capital step the size of a round, and then — from
// the company registry — real headcount, a young company, and a sector that is
// not a property vehicle, a holding or a high-street business.
//
// Outputs:
//   data/raw/paris-market/YYYY-MM.json  one month of register exports (cache)
//   data/paris-registry.json            company registry facts per SIREN — TRACKED,
//                                       because enriching costs one API call per
//                                       company and the answers barely change
//   data/paris-market.json              the venture-shaped companies and their rounds

const fs = require('fs');
const path = require('path');
const { get } = require('./lib/http.cjs');

const DATA = path.join(__dirname, '..', 'data');
const RAW = path.join(DATA, 'raw', 'paris-market');
const REGISTRY = path.join(DATA, 'paris-registry.json');
const OUT = path.join(DATA, 'paris-market.json');

const EXPORT =
  'https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/annonces-commerciales/exports/json';
const REGISTRY_API = 'https://recherche-entreprises.api.gouv.fr/search';

// --- Scope and thresholds.
const DEPARTMENTS = ['75', '92', '93', '94', '78', '91', '95', '77']; // Île-de-France
const MONTHS_BACK = 66;      // five and a half years: the 1-4 year views plus prior rounds
const REFRESH_LATEST = 2;    // months re-fetched every run; older ones never change
const ROUND_MIN_GROWTH = 0.10;
const ROUND_MAX_GROWTH = 3.00;
const ROUND_MIN_DELTA_EUR = 2000;

// Startups issue shares, so they are SAS or SA. SARL and sociétés civiles cannot
// take venture money in the usual form.
const SHARE_COMPANY = /soci[ée]t[ée] par actions simplifi[ée]e|soci[ée]t[ée] anonyme/i;

// INSEE headcount from 10 employees — the same floor the Series A test uses.
const STAFFED = new Set(['11', '12', '21', '22', '31', '32', '41', '42', '51', '52', '53']);
const FOUNDED_SINCE = 2008;

// Sectors that raise capital in volume and are never venture dealflow. Every
// entry was a real source of noise: property SCIs and holdings above all.
const NOT_VENTURE_NAF = [
  /^68/, // real estate
  /^64\.2/, // holding companies
  /^64\.30/, // funds and trusts
  /^66\.30/, // fund management
  /^70\.10/, // head offices of groups
  /^41|^42|^43/, // construction
  /^45|^46\.1|^47/, // car trade, wholesale agents, retail
  /^49|^50|^51|^52|^53/, // transport and logistics operators
  /^55|^56/, // hotels, restaurants
  /^69/, // legal and accounting practices
  /^86\.2/, // medical practices
  /^01|^02|^03/, // agriculture
  /^35/, // energy production
];

const monthsBack = (n) => {
  const out = [];
  const d = new Date();
  d.setUTCDate(1);
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
};

async function exportMonth(month) {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const where =
    `numerodepartement in (${DEPARTMENTS.map((d) => `"${d}"`).join(',')}) and ` +
    `dateparution>="${month}-01" and dateparution<"${next}-01" and ` +
    // "capital", not "augmentation": Nanterre never uses the word.
    'search(modificationsgenerales,"capital")';
  const url = `${EXPORT}?where=${encodeURIComponent(where)}&select=registre,commercant,dateparution,numerodepartement,listepersonnes`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      // The export host drops connections under load; back off and retry.
    }
    await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
  }
  throw new Error(`register export failed for ${month}`);
}

function parseRow(row) {
  let person = null;
  try {
    const parsed = JSON.parse(row.listepersonnes);
    person = Array.isArray(parsed.personne) ? parsed.personne[0] : parsed.personne;
  } catch {
    return null;
  }
  const siren = (row.registre || []).find((r) => /^\d{9}$/.test(r));
  const capital = Number(person?.capital?.montantCapital);
  if (!siren || !Number.isFinite(capital) || capital <= 0) return null;
  return {
    siren,
    name: person?.denomination || row.commercant || null,
    form: person?.formeJuridique || null,
    date: row.dateparution,
    capital,
    department: row.numerodepartement,
  };
}

// The capital steps that look like a priced round, computed from the company's
// own sequence of published capital figures.
function roundsIn(series) {
  const rounds = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1].capital;
    const cur = series[i].capital;
    const delta = cur - prev;
    const growth = delta / prev;
    if (growth >= ROUND_MIN_GROWTH && growth <= ROUND_MAX_GROWTH && delta >= ROUND_MIN_DELTA_EUR) {
      rounds.push({ date: series[i].date, capitalBefore: prev, capitalAfter: cur, growth });
    }
  }
  return rounds;
}

async function enrich(siren) {
  const body = await get(`${REGISTRY_API}?q=${siren}&per_page=1`, { minGapMs: 160, json: true });
  const c = (body.results || []).find((r) => r.siren === siren);
  if (!c) return { found: false };
  const siege = c.siege || {};
  return {
    found: true,
    legalName: c.nom_complet,
    naf: siege.activite_principale || c.activite_principale || null,
    headcount: c.tranche_effectif_salarie || null,
    founded: c.date_creation || null,
    active: c.etat_administratif === 'A',
    city: siege.libelle_commune || null,
    sizeCategory: c.categorie_entreprise || null,
    officers: (c.dirigeants || [])
      .filter((d) => d.type_dirigeant === 'personne morale')
      .map((d) => ({ name: d.denomination || d.nom, role: d.qualite, auditor: /commissaire aux comptes/i.test(d.qualite || '') }))
      .filter((d) => d.name),
  };
}

// Two kinds of company pass every test above and are still not venture dealflow.
//
// French subsidiaries of foreign groups — Macquarie Capital France, Naver France,
// Eurofins's lab network — are staffed, young as legal entities, and capitalised
// by their parent in steps that look exactly like rounds. Their names end in
// "France" almost without exception.
//
// Group holdcos and large enterprises (INSEE category GE: Suez, Exaion as an EDF
// company) move capital for internal reasons.
//
// NOT used, although it was tested: dropping companies whose chairman is another
// company. It looked like a clean subsidiary test and removed Osivax and
// Resilience, both genuine VC-backed startups, because French founders commonly
// hold their stake through a personal holding company that sits as chairman.
const SUBSIDIARY_NAME = /\bFRANCE\s*(SAS|SA)?\s*(\(.*)?$/i;
const GROUP_NAME = /^(GROUPE|GROUP)\b|\b(GROUPE|GROUP|HOLDING|HOLDINGS)\b/i;

function ventureShaped(facts) {
  if (!facts.found) return { ok: false, why: 'not in the company registry' };
  if (SUBSIDIARY_NAME.test(facts.legalName || '')) return { ok: false, why: 'French subsidiary of a larger group' };
  if (GROUP_NAME.test(facts.legalName || '')) return { ok: false, why: 'group or holding company' };
  if (facts.sizeCategory === 'GE') return { ok: false, why: 'large enterprise (INSEE category GE)' };
  if (!facts.active) return { ok: false, why: 'ceased trading' };
  if (!STAFFED.has(facts.headcount)) return { ok: false, why: `headcount bracket ${facts.headcount || 'not filed'} under 10 staff` };
  const year = Number((facts.founded || '').slice(0, 4));
  if (!year || year < FOUNDED_SINCE) return { ok: false, why: `incorporated ${year || 'unknown'}, before ${FOUNDED_SINCE}` };
  if (facts.naf && NOT_VENTURE_NAF.some((re) => re.test(facts.naf))) return { ok: false, why: `sector ${facts.naf} is not venture` };
  return { ok: true };
}

(async () => {
  // --- 1. Every capital change in Île-de-France, month by month.
  fs.mkdirSync(RAW, { recursive: true });
  const months = monthsBack(MONTHS_BACK);
  const rows = [];
  for (const [i, month] of months.entries()) {
    const file = path.join(RAW, `${month}.json`);
    let data;
    if (fs.existsSync(file) && i >= REFRESH_LATEST) {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
      data = await exportMonth(month);
      fs.writeFileSync(file, JSON.stringify(data));
      process.stdout.write(`${month}:${data.length} `);
    }
    for (const r of data) {
      const p = parseRow(r);
      if (p) rows.push(p);
    }
  }
  console.log(`\n${rows.length} capital figures across ${months.length} months`);

  // --- 2. Share companies, grouped into each company's own capital series.
  const bySiren = new Map();
  for (const r of rows) {
    if (!SHARE_COMPANY.test(r.form || '')) continue;
    const list = bySiren.get(r.siren) || [];
    if (!list.some((x) => x.date === r.date && x.capital === r.capital)) list.push(r);
    bySiren.set(r.siren, list);
  }
  const withRounds = [];
  for (const [siren, series] of bySiren) {
    series.sort((a, b) => a.date.localeCompare(b.date));
    const rounds = roundsIn(series);
    if (rounds.length) withRounds.push({ siren, series, rounds });
  }
  console.log(`${bySiren.size} share companies with capital changes; ${withRounds.length} show a round-sized step`);
  // MEASURE_ONLY=1 stops before the registry calls, to size the job first.
  if (process.env.MEASURE_ONLY === '1') return;

  // --- 3. Registry facts, cached — only companies never seen before cost a call.
  const registry = fs.existsSync(REGISTRY) ? JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) : {};
  const toFetch = withRounds.filter((c) => !registry[c.siren]);
  console.log(`${toFetch.length} companies need registry facts (${withRounds.length - toFetch.length} cached)`);
  let done = 0;
  for (const c of toFetch) {
    try {
      registry[c.siren] = { ...(await enrich(c.siren)), fetchedAt: new Date().toISOString().slice(0, 10) };
    } catch {
      // Leave it uncached; the next run retries.
    }
    if (++done % 200 === 0) {
      process.stdout.write(`  ${done}/${toFetch.length}\r`);
      fs.writeFileSync(REGISTRY, JSON.stringify(registry));
    }
  }
  fs.writeFileSync(REGISTRY, JSON.stringify(registry));

  // --- 4. Keep the venture-shaped ones.
  const reasons = {};
  const companies = [];
  for (const c of withRounds) {
    const facts = registry[c.siren];
    if (!facts) continue;
    const verdict = ventureShaped(facts);
    if (!verdict.ok) {
      const bucket = verdict.why.replace(/\d{2}\.\d{2}[A-Z]?|\d{4}|bracket \w+/g, '#');
      reasons[bucket] = (reasons[bucket] || 0) + 1;
      continue;
    }
    companies.push({
      siren: c.siren,
      name: facts.legalName || c.series[c.series.length - 1].name,
      department: c.series[c.series.length - 1].department,
      city: facts.city,
      naf: facts.naf,
      headcount: facts.headcount,
      founded: facts.founded,
      sizeCategory: facts.sizeCategory,
      officers: facts.officers,
      capital: c.series[c.series.length - 1].capital,
      series: c.series.map((s) => ({ date: s.date, capital: s.capital })),
      rounds: c.rounds,
    });
  }

  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), departments: DEPARTMENTS, companies }, null, 1));

  const totalRounds = companies.reduce((n, c) => n + c.rounds.length, 0);
  console.log(`\n${companies.length} venture-shaped companies, ${totalRounds} rounds kept`);
  console.log('dropped:');
  Object.entries(reasons).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(6)}  ${k}`));
})();
