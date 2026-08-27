// Stage 2 — turn a portfolio company name into a SIREN.
//
// This is the join that makes everything downstream possible: BODACC is keyed on
// SIREN, never on a trade name. It is also the stage most likely to be quietly
// wrong, because plenty of unrelated French companies share a startup's name —
// searching "Alan" returns a car dealership in Mougins created in 2006 before it
// returns the health insurer. A wrong SIREN does not error; it produces a
// complete, plausible, entirely fictional funding history.
//
// So every match is scored, and only high/medium confidence matches are used.
// Anything weaker is recorded as unresolved rather than guessed.
//
// Output: data/siren-map.json — TRACKED, because it costs ~2,000 API calls to
// rebuild and carries manual corrections that must survive a refresh.

const fs = require('fs');
const path = require('path');
const { get } = require('./lib/http.cjs');

const DATA = path.join(__dirname, '..', 'data');
const MAP_PATH = path.join(DATA, 'siren-map.json');
const API = 'https://recherche-entreprises.api.gouv.fr/search';

// Île-de-France. A Paris fund's French holdings are overwhelmingly here, so this
// separates the real match from the same-named plumber in Alpes-de-Haute-Provence.
const IDF = new Set(['75', '77', '78', '91', '92', '93', '94', '95']);

// Tech-ish NAF divisions: software, information services, publishing, R&D,
// telecoms, head offices (holding structures are common for startups).
const TECH_NAF = /^(58|59|61|62|63|70|71|72|73|74|82|86)/;

// NAF codes that a VC-backed company essentially never carries, and that the
// same-name noise almost always does. 68.20B is the killer: every French family
// holds property through an SCI, so "ALAN" matches an SCI in Seine-Saint-Denis
// before it matches the health insurer.
const SHELL_NAF = /^(6820|6810|6831|56|55|4932|4939|4711|4781|9609|8130|0111)/;

// INSEE employee brackets. This is the single strongest corroborator available:
// a company a Paris fund has backed employs people, and the same-named SCI or
// kebab shop does not. "NN" means the field was never filled in, which for an
// operating company of any size is itself telling.
const HEADCOUNT_POINTS = {
  NN: -1, '00': -1, '01': 0, '02': 1, '03': 1,
  11: 2, 12: 2, 21: 3, 22: 3, 31: 3, 32: 3, 41: 3, 42: 3, 51: 3, 52: 3, 53: 3,
};

const LEGAL_FORMS = /\b(SAS|SASU|SARL|SA|EURL|SCI|SNC|GROUPE|HOLDING|FRANCE|TECHNOLOGIES?|LABS?)\b/g;

function normalise(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining accents
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const stripForms = (n) => normalise(n).replace(LEGAL_FORMS, ' ').replace(/\s+/g, ' ').trim();

// Score one API candidate against the name we searched for.
function score(candidate, wanted) {
  const siege = candidate.siege || {};
  const names = [candidate.nom_complet, candidate.nom_raison_sociale, candidate.sigle]
    .filter(Boolean)
    .map(normalise);
  const bare = names.map(stripForms);

  let points = 0;
  const why = [];

  // A startup's trade name is often a prefix of its legal name — Alan trades as
  // "Alan" and is registered as "ALAN INSURANCE" — so a prefix match has to score
  // close to an exact one, or the exact-matching shell company wins.
  if (names.includes(wanted)) { points += 4; why.push('exact name'); }
  else if (bare.includes(stripForms(wanted))) { points += 3; why.push('name minus legal form'); }
  else if (names.some((n) => n.startsWith(wanted + ' '))) { points += 2; why.push('name prefix'); }
  else return { points: -1, why: ['name does not match'] };

  const headcount = candidate.tranche_effectif_salarie || 'NN';
  const headcountPoints = HEADCOUNT_POINTS[headcount] ?? 0;
  points += headcountPoints;
  why.push(headcountPoints > 0 ? `has employees (bracket ${headcount})` : 'no declared employees');

  if (IDF.has(siege.departement)) { points += 2; why.push('Île-de-France'); }
  else if (siege.departement) { points += 0; why.push(`dept ${siege.departement}`); }

  if (candidate.etat_administratif === 'A' || siege.etat_administratif === 'A') {
    points += 1; why.push('active');
  } else { points -= 2; why.push('ceased'); }

  const naf = siege.activite_principale || '';
  if (SHELL_NAF.test(naf.replace('.', ''))) { points -= 4; why.push(`shell-shaped NAF ${naf}`); }
  else if (TECH_NAF.test(naf)) { points += 1; why.push('tech NAF'); }

  // NOTE: this is siege.date_creation — when the CURRENT head-office establishment
  // was registered, which moves when the company moves. It is NOT the founding
  // year and must never be displayed as one. It is only a weak plausibility hint.
  const year = Number((siege.date_creation || '').slice(0, 4));
  if (year >= 2000) { points += 1; why.push(`siege since ${year}`); }
  else if (year) { points -= 1; why.push(`siege since ${year}`); }

  return { points, why };
}

// Recalibrated when headcount and the shell-NAF penalty were added; the old
// 7/5 cut-offs let an SCI through as 'high'. Bump SCORER_VERSION on any change
// here so the cache re-resolves instead of serving verdicts from the old rules.
const SCORER_VERSION = 3;
const confidenceOf = (points) => (points >= 8 ? 'high' : points >= 6 ? 'medium' : 'low');

// Employee brackets from 3 staff upward, as the API expects them.
const STAFFED = '02,03,11,12,21,22,31,32,41,42,51,52,53';

async function resolve(name) {
  const wanted = normalise(name);
  const q = encodeURIComponent(name);

  // Two passes, because the API ranks by its own relevance and a startup name is
  // often also a common French first name. "Alan" matches 10,000 companies and
  // ALAN INSURANCE — the health insurer, 10-19 staff, Paris — is not in the top
  // 25 of the plain query. Asking the API for companies that actually employ
  // someone puts it on the first page.
  //
  // The unfiltered pass still runs: a genuinely early-stage holding may have no
  // declared headcount, and dropping it would lose real matches.
  const [staffed, plain] = await Promise.all([
    get(`${API}?q=${q}&tranche_effectif_salarie=${STAFFED}&per_page=10&page=1`, { minGapMs: 160, json: true }).catch(() => ({ results: [] })),
    get(`${API}?q=${q}&per_page=10&page=1`, { minGapMs: 160, json: true }).catch(() => ({ results: [] })),
  ]);

  const seen = new Set();
  const candidates = [...(staffed.results || []), ...(plain.results || [])].filter((c) => {
    if (seen.has(c.siren)) return false;
    seen.add(c.siren);
    return true;
  });
  if (!candidates.length) return { status: 'not-found' };

  const ranked = candidates
    .map((c) => ({ c, ...score(c, wanted) }))
    .filter((r) => r.points >= 0)
    .sort((a, b) => b.points - a.points);

  if (!ranked.length) return { status: 'no-name-match', candidates: candidates.length };

  const best = ranked[0];
  const confidence = confidenceOf(best.points);
  // Two candidates scoring the same means we cannot tell them apart. Saying so is
  // the whole point of this stage.
  const tied = ranked.filter((r) => r.points === best.points).length > 1;

  return {
    status: tied && confidence !== 'high' ? 'ambiguous' : 'resolved',
    siren: best.c.siren,
    legalName: best.c.nom_complet,
    department: best.c.siege?.departement || null,
    naf: best.c.siege?.activite_principale || null,
    siegeSince: best.c.siege?.date_creation || null, // head-office registration, NOT founding date
    active: (best.c.etat_administratif || best.c.siege?.etat_administratif) === 'A',
    confidence,
    scorerVersion: SCORER_VERSION,
    score: best.points,
    reasons: best.why,
    alternatives: ranked.slice(1, 3).map((r) => `${r.c.siren} ${r.c.nom_complet} (${r.points})`),
  };
}

// Exported so the scorer can be exercised on known names without a full run.
module.exports = { resolve, normalise, score };

if (require.main === module) (async () => {
  const { funds } = JSON.parse(fs.readFileSync(path.join(DATA, 'portfolios.json'), 'utf8'));
  const existing = fs.existsSync(MAP_PATH)
    ? JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'))
    : { note: 'name -> SIREN cache. Hand-edit an entry and set "manual": true to pin it; the pipeline never overwrites those.', companies: {} };

  const names = new Map();
  for (const fund of funds) {
    for (const company of fund.companies) {
      const key = normalise(company.name);
      if (!names.has(key)) names.set(key, { name: company.name, funds: [], website: company.website, blurb: company.blurb });
      const entry = names.get(key);
      entry.funds.push(fund.id);
      entry.website = entry.website || company.website;
      entry.blurb = entry.blurb || company.blurb;
    }
  }

  console.log(`${names.size} distinct companies to resolve`);
  const tally = {};
  let done = 0;

  for (const [key, info] of names) {
    const prior = existing.companies[key];
    if (prior?.manual) { tally.manual = (tally.manual || 0) + 1; continue; }
    // Re-resolving a settled name every day buys nothing: SIRENs do not change.
    if (prior && prior.scorerVersion === SCORER_VERSION && prior.status === 'resolved' && prior.confidence !== 'low') {
      prior.funds = info.funds;
      tally.cached = (tally.cached || 0) + 1;
      continue;
    }

    let result;
    try {
      result = await resolve(info.name);
    } catch (err) {
      result = { status: 'error', error: err.message };
    }
    existing.companies[key] = { name: info.name, funds: info.funds, website: info.website || null, blurb: info.blurb || null, ...result };
    tally[result.status] = (tally[result.status] || 0) + 1;

    if (++done % 100 === 0) process.stdout.write(`  ${done} resolved\r`);
  }

  fs.writeFileSync(MAP_PATH, JSON.stringify(existing, null, 2) + '\n');

  const all = Object.values(existing.companies);
  const usable = all.filter((c) => c.status === 'resolved' && c.confidence !== 'low');
  console.log(`\nStatus: ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`Usable SIRENs: ${usable.length}/${all.length}`);
  console.log(`  high confidence   ${usable.filter((c) => c.confidence === 'high').length}`);
  console.log(`  medium confidence ${usable.filter((c) => c.confidence === 'medium').length}`);
  console.log('Unresolved names are mostly non-French holdings, which is expected, not a failure.');
})();
