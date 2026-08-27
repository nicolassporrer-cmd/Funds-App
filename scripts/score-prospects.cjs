// Stage 4b — score how likely each company is to be raising in the coming months.
//
// This is the core of the app. It replaces "how overdue is this company", which
// is arithmetic anyone can do from a spreadsheet, with "what is the register
// showing right now that suggests a raise is coming".
//
// Every component is published separately with the company so the ranking can be
// argued with. A score with no visible reasons is a number to distrust.
//
// Tuned for RECALL: a company approaching its cycle appears even with no other
// signal. Corroborating evidence moves it up the list rather than being the
// price of admission.
//
// Output: data/prospects.json (gitignored intermediate)

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');

// --- Weights. Every one of these is a judgement, so they live together, named.
const W = {
  cycleDue: 40,        // approaching or past the company's own raising cycle
  bridge: 22,          // a between-rounds capital increase too small to be a round
  governance: 16,      // board or officer change, how an incoming investor appears
  auditorAppointed: 8, // a statutory auditor on the books; usual at institutional rounds
  investorOnBoard: 6,  // an investment vehicle sitting as a corporate officer
  growing: 8,          // headcount bracket consistent with a company that needs capital
  recentlyActive: 10,  // still filing, so the signal is about a live company
};

// A capital increase between rounds in this band reads as a bridge: far above
// the trickle of option exercises, far below a priced round. Bridges are the
// strongest forward signal in this dataset — a company that just took one from
// its existing investors is usually raising properly within the year.
const BRIDGE_MIN_GROWTH = 0.02;
const BRIDGE_MAX_GROWTH = 0.10;

const MONTHS_AHEAD = 6; // "coming months" — how far forward the list looks
const monthsBetween = (a, b) => (new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24 * 30.44);

// Headcount brackets from 10 staff up. Below that a company rarely has the
// burn that forces a round on a schedule.
const GROWING = new Set(['11', '12', '21', '22', '31', '32', '41', '42', '51', '52', '53']);

function scoreCompany(company, meta, today) {
  const signals = [];
  let score = 0;

  const events = company.events || [];
  const rounds = events.filter((e) => e.verdict === 'round-candidate');
  const last = rounds[rounds.length - 1] || null;
  const cycle = company.cycle?.months || 20;

  // --- 1. Where the company sits in its own raising cycle.
  let monthsSince = null;
  if (last) {
    monthsSince = monthsBetween(last.date, today);
    // Peaks as the company reaches its cycle and stays high after; decays once
    // it is so far past that the company has probably stopped raising instead.
    const ratio = monthsSince / cycle;
    let cyclePoints = 0;
    if (ratio >= 0.7 && ratio <= 2.5) cyclePoints = W.cycleDue * Math.min(1, ratio / 1.1);
    else if (ratio > 2.5) cyclePoints = W.cycleDue * 0.25;
    score += cyclePoints;
    if (cyclePoints > 0) {
      const due = Math.round((cycle - monthsSince) * 10) / 10;
      signals.push({
        kind: 'cycle',
        weight: Math.round(cyclePoints),
        text:
          due > 0
            ? `Last round ${Math.round(monthsSince)} months ago; on its ${company.cycle?.measured ? 'own measured' : 'assumed'} ${cycle}-month cycle it is due in about ${Math.round(due)} months.`
            : `Last round ${Math.round(monthsSince)} months ago, ${Math.abs(Math.round(due))} months past its ${company.cycle?.measured ? 'measured' : 'assumed'} ${cycle}-month cycle.`,
      });
    }
  } else {
    signals.push({ kind: 'cycle', weight: 0, text: 'No prior round found in the register, so there is no cycle to measure against.' });
  }

  // --- 2. A bridge since the last round.
  const sinceLast = last ? events.filter((e) => e.date > last.date) : events;
  // classify-rounds.cjs already labelled these; trust its verdict rather than
  // re-deriving the band here, so the two never disagree about one event.
  const bridges = sinceLast.filter((e) => e.verdict === 'bridge');
  const bridge = bridges[bridges.length - 1];
  if (bridge) {
    score += W.bridge;
    signals.push({
      kind: 'bridge',
      weight: W.bridge,
      date: bridge.date,
      text: `Capital rose ${(bridge.growth * 100).toFixed(1)}% on ${bridge.date} — too small for a priced round, too large for option exercises. Reads as a bridge from existing investors.`,
    });
  }

  // --- 3. Governance change, which is how a new investor's board seat surfaces.
  const governance = sinceLast
    .filter((e) => /administration|repr[ée]sentant|forme juridique/.test(e.descriptif || e.basis || ''))
    .filter((e) => monthsBetween(e.date, today) <= 18);
  const lastGovernance = governance[governance.length - 1];
  if (lastGovernance) {
    score += W.governance;
    signals.push({
      kind: 'governance',
      weight: W.governance,
      date: lastGovernance.date,
      text: `Board or officer change registered on ${lastGovernance.date}. An incoming investor taking a seat appears exactly like this.`,
    });
  }

  // --- 4. Corroboration from the officer list.
  const officers = meta.officers || [];
  const auditors = officers.filter((o) => o.auditor);
  const investors = officers.filter((o) => !o.auditor);
  if (auditors.length) {
    score += W.auditorAppointed;
    signals.push({
      kind: 'auditor',
      weight: W.auditorAppointed,
      text: `Statutory auditor on the books (${auditors[0].name}). French companies appoint one at size thresholds, and investors normally require one at an institutional round.`,
    });
  }
  if (investors.length) {
    score += W.investorOnBoard;
    signals.push({
      kind: 'investor',
      weight: W.investorOnBoard,
      text: `An investment vehicle sits as a corporate officer: ${investors.map((o) => o.name).join(', ')}.`,
    });
  }

  // --- 5. Size, and whether the company is still filing at all.
  if (GROWING.has(meta.headcount)) {
    score += W.growing;
    signals.push({ kind: 'size', weight: W.growing, text: `Declared headcount bracket ${meta.headcount} — large enough to be burning capital on a schedule.` });
  }
  const lastAny = events[events.length - 1]?.date || null;
  const monthsQuiet = lastAny ? monthsBetween(lastAny, today) : null;
  if (monthsQuiet !== null && monthsQuiet <= 18) {
    score += W.recentlyActive;
    signals.push({ kind: 'alive', weight: W.recentlyActive, text: `Still filing — most recent register entry ${lastAny}.` });
  }

  const max = Object.values(W).reduce((a, b) => a + b, 0);
  return {
    score: Math.round((score / max) * 100),
    signals: signals.sort((a, b) => b.weight - a.weight),
    monthsSince: monthsSince === null ? null : Math.round(monthsSince * 10) / 10,
    dueInMonths: monthsSince === null ? null : Math.round((cycle - monthsSince) * 10) / 10,
    hasBridge: Boolean(bridge),
    hasGovernance: Boolean(lastGovernance),
    auditors: auditors.map((o) => o.name),
    investorOfficers: investors.map((o) => ({ name: o.name, role: o.role })),
  };
}

if (require.main === module) {
  const rounds = JSON.parse(fs.readFileSync(path.join(DATA, 'rounds.json'), 'utf8'));
  const sirenMap = JSON.parse(fs.readFileSync(path.join(DATA, 'siren-map.json'), 'utf8'));
  const today = new Date().toISOString().slice(0, 10);

  const scored = rounds.companies.map((c) => {
    const meta = sirenMap.companies[c.key] || {};
    return { key: c.key, status: c.status, ...scoreCompany(c, meta, today) };
  });

  // Ranked for recall: everything with any cycle position at all is listed, and
  // the score decides the order rather than the membership.
  const live = scored.filter((c) => !['dormant', 'unverified', 'exited'].includes(c.status));
  const bands = live.reduce((acc, c) => {
    const band = c.score >= 60 ? 'strong' : c.score >= 40 ? 'moderate' : c.score >= 20 ? 'weak' : 'none';
    return { ...acc, [band]: (acc[band] || 0) + 1 };
  }, {});

  fs.writeFileSync(
    path.join(DATA, 'prospects.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), weights: W, monthsAhead: MONTHS_AHEAD, companies: scored }, null, 2)
  );

  console.log(`${scored.length} companies scored, ${live.length} live`);
  console.log(`  strong (60+)   ${bands.strong || 0}`);
  console.log(`  moderate (40+) ${bands.moderate || 0}`);
  console.log(`  weak (20+)     ${bands.weak || 0}`);
  console.log(`  no signal      ${bands.none || 0}`);
  console.log(`  with a bridge  ${live.filter((c) => c.hasBridge).length}`);
  console.log(`  with recent governance change ${live.filter((c) => c.hasGovernance).length}`);
  console.log(`  with an investor as corporate officer ${live.filter((c) => c.investorOfficers.length).length}`);
}

module.exports = { scoreCompany, W };
