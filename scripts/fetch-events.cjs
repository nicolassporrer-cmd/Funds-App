// Stage 3 — pull every registered corporate event for each resolved company.
//
// Source: BODACC (Bulletin officiel des annonces civiles et commerciales), the
// official French register publication, exposed as open data by DILA. No key, no
// quota, complete back to 2008.
//
// What it gives us: for every announcement, the date and the company's share
// capital AFTER the change. What it does not give us: the amount raised. In a
// French SAS the investment lands overwhelmingly in the *prime d'émission*
// (share premium), which is never published — only the nominal capital moves.
// So this pipeline can say WHEN with confidence and must never claim HOW MUCH.
//
// Output: data/events.json (gitignored intermediate)

const fs = require('fs');
const path = require('path');
const { get } = require('./lib/http.cjs');

const DATA = path.join(__dirname, '..', 'data');
const BODACC =
  'https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/annonces-commerciales/records';

const FIELDS = ['dateparution', 'familleavis_lib', 'typeavis_lib', 'modificationsgenerales', 'listepersonnes', 'tribunal'];

// BODACC's `registre` field holds the SIREN both spaced and unspaced, so an
// equality test on the raw digits misses half the rows. Its own search() handles
// the tokenisation.
const queryFor = (siren) =>
  `${BODACC}?where=${encodeURIComponent(`registre="${siren}"`)}` +
  `&select=${FIELDS.join(',')}&order_by=${encodeURIComponent('dateparution asc')}&limit=100`;

function parseJsonField(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// The announcement's own words for what changed, e.g.
// "modification survenue sur le capital (augmentation)".
function describe(record) {
  const mods = parseJsonField(record.modificationsgenerales);
  return (mods?.descriptif || '').toLowerCase();
}

function capitalOf(record) {
  const people = parseJsonField(record.listepersonnes);
  const person = people?.personne;
  const entry = Array.isArray(person) ? person[0] : person;
  const amount = Number(entry?.capital?.montantCapital);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, currency: entry?.capital?.devise || 'EUR', legalForm: entry?.formeJuridique || null };
}

async function eventsFor(siren) {
  const body = await get(queryFor(siren), { minGapMs: 300, json: true });
  return (body.results || []).map((record) => {
    const capital = capitalOf(record);
    return {
      date: record.dateparution,
      family: record.familleavis_lib || null,
      kind: record.typeavis_lib || null,
      descriptif: describe(record) || null,
      capital: capital?.amount ?? null,
      currency: capital?.currency ?? null,
      legalForm: capital?.legalForm ?? null,
      court: record.tribunal || null,
    };
  });
}

if (require.main === module) {
  (async () => {
    const map = JSON.parse(fs.readFileSync(path.join(DATA, 'siren-map.json'), 'utf8'));
    const targets = Object.entries(map.companies).filter(
      ([, c]) => c.siren && c.status === 'resolved' && c.confidence !== 'low'
    );

    console.log(`${targets.length} companies with a usable SIREN`);
    const out = {};
    let done = 0;
    let withCapital = 0;
    const errors = [];

    let unverified = 0;
    for (const [key, company] of targets) {
      try {
        const events = await eventsFor(company.siren);
        // An operating French company registered for years always has SOME
        // register activity — accounts filed, an address changed, something.
        // Zero announcements means the SIREN is almost certainly the wrong
        // entity: a dormant namesake that scored well on name and location.
        // Malt matched "Maison Arts Loisirs de Toulouse" this way. Flag it here
        // rather than letting it surface as a company with "no signal", which
        // reads as a real company that simply has not raised.
        const suspect = events.length === 0;
        if (suspect) unverified++;
        out[key] = {
          name: company.name,
          siren: company.siren,
          funds: company.funds,
          sirenUnverified: suspect,
          events,
        };
        if (events.some((e) => e.capital !== null)) withCapital++;
      } catch (err) {
        errors.push(`${company.name} (${company.siren}): ${err.message}`);
      }
      if (++done % 50 === 0) process.stdout.write(`  ${done}/${targets.length}\r`);
    }

    fs.writeFileSync(
      path.join(DATA, 'events.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), companies: out, errors }, null, 2)
    );

    const totalEvents = Object.values(out).reduce((n, c) => n + c.events.length, 0);
    console.log(`\n${Object.keys(out).length} companies, ${totalEvents} announcements`);
    console.log(`${withCapital} companies have at least one published capital figure`);
    console.log(`${unverified} SIRENs returned zero announcements — flagged unverified, almost certainly the wrong entity`);
    if (errors.length) console.log(`${errors.length} lookups failed:\n  ${errors.slice(0, 5).join('\n  ')}`);
  })();
}

module.exports = { eventsFor };
