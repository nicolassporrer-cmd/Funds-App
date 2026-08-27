// Stage 4 — separate real fundraising from register noise, then judge who is due.
//
// The problem this stage exists to solve: French companies register capital
// increases constantly, and most of them are not rounds. Ledger's last four were
// +13.7k, +4.6k and +3.9k euros against a 1.6M capital base — employees
// exercising BSPCE, published exactly like a Series C. A rule as naive as
// "capital went up, therefore they raised" fires on every company every few
// weeks and tells you nothing.
//
// The discriminator is the SIZE of the jump relative to the existing capital,
// because a new investor subscribing shares moves the nominal base by a step
// change, while option exercises trickle.
//
// This is a heuristic and it is labelled as one everywhere it surfaces. It can
// be wrong in both directions, so the raw event list is kept alongside the
// verdict and the thresholds live here, named, for tuning against known rounds.
//
// Output: data/rounds.json (gitignored intermediate)

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');

// --- Tunable thresholds. Change these here, not inline.
const ROUND_MIN_GROWTH = 0.10;   // capital must grow >=10% to look like a round
const ROUND_MIN_ABSOLUTE = 2000; // ...and by >=2,000 EUR nominal, to drop rounding noise
const BRIDGE_MIN_GROWTH = 0.02;  // 2-10% reads as a bridge, below that as option exercises
const DEFAULT_CYCLE_MONTHS = 20; // typical gap between rounds when we cannot measure one
const DUE_SOON_WINDOW = 3;       // months either side of the expected date

// A company that has filed NOTHING with the register — not accounts, not an
// address change — for this long is not a fundraising prospect. It has been
// acquired, wound down, or listed. Without this the alert list is topped by
// Etsy, Criteo and Sketchfab at 200+ months "overdue", which is technically true
// and completely useless: the funds still list them on their portfolio pages
// years after the exit, and the register stops moving once a company is gone.
const DORMANT_MONTHS = 48;

// Phrases BODACC uses. Matching the register's own words beats guessing from
// numbers alone, and catches the case where capital data is missing.
const SAYS_INCREASE = /capital\s*\(augmentation\)|augmentation de capital/;
const SAYS_DECREASE = /capital\s*\(diminution\)|r[ée]duction de capital/;
// Governance changes. Worth surfacing next to a capital move — an investor
// taking a board seat looks like this — but NOT sufficient on their own to call
// something a round; see the note further down.
const STRUCTURAL = /(d[ée]nomination|forme juridique|administration|objet social)/;

const monthsBetween = (a, b) =>
  (new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24 * 30.44);

function classify(events) {
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));
  const out = [];
  let previousCapital = null;

  for (const event of sorted) {
    const increase = SAYS_INCREASE.test(event.descriptif || '');
    const decrease = SAYS_DECREASE.test(event.descriptif || '');
    const structuralChanges = (event.descriptif || '').match(STRUCTURAL)?.length || 0;

    let growth = null;
    let delta = null;
    if (event.capital !== null && previousCapital !== null && previousCapital > 0) {
      delta = event.capital - previousCapital;
      growth = delta / previousCapital;
    }

    let verdict = 'other';
    let basis = null;

    if (increase && delta !== null && delta < 0) {
      // The register says "augmentation" but the capital fell. This happens on a
      // redenomination — Dataiku's nominal capital dropped 99.3% in one 2025
      // announcement — and it is never a round. Trust the arithmetic over the
      // wording, and never format a fall as a rise.
      verdict = 'capital-restructure';
      basis = `capital ${(growth * 100).toFixed(1)}% (${Math.round(delta).toLocaleString('fr-FR')} EUR) — a fall, so a redenomination or reduction, not a raise`;
    } else if (increase && delta !== null) {
      if (growth >= ROUND_MIN_GROWTH && delta >= ROUND_MIN_ABSOLUTE) {
        verdict = 'round-candidate';
        basis = `capital +${Math.round(growth * 100)}% (+${Math.round(delta).toLocaleString('fr-FR')} EUR nominal)`;
      } else if (growth >= BRIDGE_MIN_GROWTH) {
        // Between the option-exercise trickle and a priced round. This band is
        // the app's strongest forward signal, so it gets its own verdict rather
        // than being lumped in with employee equity — the same event must not be
        // called a bridge in one place and option exercises in another.
        verdict = 'bridge';
        basis = `capital +${(growth * 100).toFixed(1)}% (+${Math.round(delta).toLocaleString('fr-FR')} EUR nominal) — bridge-sized: too large for option exercises, too small for a priced round`;
      } else {
        verdict = 'employee-equity';
        basis = `capital +${(growth * 100).toFixed(1)}% — too small for a round, reads as option exercises`;
      }
    } else if (increase && delta === null) {
      // First announcement we hold for this company, or no capital figure
      // published. We know something happened; we cannot size it.
      verdict = 'increase-unsized';
      basis = 'capital increase with no prior figure to compare against';
    } else if (decrease) {
      verdict = 'capital-decrease';
      basis = 'capital reduced';
    } else if (structuralChanges >= 2) {
      verdict = 'structural';
      basis = event.descriptif;
    }

    // A capital increase bundled with governance changes CAN mean an investor
    // taking a board seat — but it just as often means a restructuring. Qonto's
    // April 2026 announcement changed denomination, legal form and administration
    // alongside a 0.2% capital bump; promoting that to a round reset its clock and
    // hid a company that might genuinely be due.
    //
    // So this is surfaced, never promoted. A false round is the worse error: it
    // silences the alert this whole app exists to raise.
    if ((verdict === 'employee-equity' || verdict === 'bridge') && structuralChanges >= 2) {
      verdict = 'structural-with-capital';
      basis = `${event.descriptif} — capital moved ${(growth * 100).toFixed(1)}%, too little to read as a round on its own`;
    }

    if (event.capital !== null) previousCapital = event.capital;
    out.push({ ...event, verdict, basis, growth, delta });
  }

  return out;
}

// How often has this company actually raised? Measured when we have two or more
// candidates; otherwise the portfolio-wide default, flagged as a default.
function cycleFor(rounds) {
  if (rounds.length < 2) return { months: DEFAULT_CYCLE_MONTHS, measured: false };
  const gaps = [];
  for (let i = 1; i < rounds.length; i++) gaps.push(monthsBetween(rounds[i - 1].date, rounds[i].date));
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return { months: Math.max(6, Math.round(median)), measured: true, samples: gaps.length };
}

function assess(company, today) {
  const events = classify(company.events);
  const rounds = events.filter((e) => e.verdict === 'round-candidate');
  const cycle = cycleFor(rounds);
  const last = rounds[rounds.length - 1] || null;

  if (!last) {
    return {
      ...company,
      events,
      rounds,
      cycle,
      lastRound: null,
      monthsSince: null,
      status: company.sirenUnverified ? 'unverified' : 'no-signal',
      why: company.sirenUnverified
        ? 'This SIREN has no announcements at all in the register, so the name almost certainly matched the wrong company. Excluded from the alerts rather than shown as a company that has not raised.'
        : 'No capital increase large enough to read as a round in the published register.',
    };
  }

  const monthsSince = monthsBetween(last.date, today);
  const overdueBy = monthsSince - cycle.months;

  // Any announcement counts here, not just capital ones — filing accounts is
  // enough to show the company is still alive.
  const lastAnyEvent = events[events.length - 1]?.date || last.date;
  const monthsQuiet = monthsBetween(lastAnyEvent, today);

  let status;
  let why;
  if (monthsQuiet > DORMANT_MONTHS) {
    status = 'dormant';
    why = `Nothing filed with the register for ${Math.round(monthsQuiet)} months. Almost certainly acquired, wound down or listed — the fund's portfolio page just has not been updated. Not a fundraising prospect.`;
  } else if (overdueBy > DUE_SOON_WINDOW) {
    status = 'overdue';
    why = `${Math.round(monthsSince)} months since the last capital increase large enough to read as a round, against a ${cycle.months}-month ${cycle.measured ? 'measured' : 'assumed'} cycle.`;
  } else if (overdueBy > -DUE_SOON_WINDOW) {
    status = 'due-soon';
    why = `${Math.round(monthsSince)} months since the last apparent round, and this company's ${cycle.measured ? 'measured' : 'assumed'} cycle is ${cycle.months} months.`;
  } else {
    status = 'recent';
    why = `Last apparent round ${Math.round(monthsSince)} months ago; next one is not expected for roughly ${Math.round(-overdueBy)} months.`;
  }

  return { ...company, events, rounds, cycle, lastRound: last.date, monthsSince: Math.round(monthsSince * 10) / 10, status, why };
}

if (require.main === module) {
  const { companies } = JSON.parse(fs.readFileSync(path.join(DATA, 'events.json'), 'utf8'));
  const today = new Date().toISOString().slice(0, 10);

  const assessed = Object.entries(companies).map(([key, company]) => ({ key, ...assess(company, today) }));

  const counts = assessed.reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] || 0) + 1 }), {});
  const roundCount = assessed.reduce((n, c) => n + c.rounds.length, 0);
  const noise = assessed.reduce((n, c) => n + c.events.filter((e) => e.verdict === 'employee-equity').length, 0);

  fs.writeFileSync(
    path.join(DATA, 'rounds.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        thresholds: { ROUND_MIN_GROWTH, ROUND_MIN_ABSOLUTE, DEFAULT_CYCLE_MONTHS, DUE_SOON_WINDOW },
        companies: assessed,
      },
      null,
      2
    )
  );

  console.log(`${assessed.length} companies assessed`);
  console.log(`${roundCount} round candidates kept, ${noise} small increases rejected as employee equity`);
  console.log(Object.entries(counts).map(([k, v]) => `  ${k.padEnd(10)} ${v}`).join('\n'));
}

module.exports = { classify, assess, cycleFor };
