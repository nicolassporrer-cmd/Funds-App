// Builds dist/index.html — one self-contained page with the payload inlined.
//
// No framework and no build step: the data is a static JSON blob, the page is
// read-only, and GitHub Pages serves it as a file. Anything more would be
// machinery around a document.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const payload = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'payload.json'), 'utf8'));

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const generated = new Date(payload.generatedAt).toLocaleDateString('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric',
});

const CSS = `
:root {
  --paper: #f5f2ea;
  --paper-2: #ece7db;
  --ink: #1a1712;
  --ink-soft: #565044;
  --rule: #c9c0ad;
  --rule-strong: #1a1712;
  --overdue: #a3301a;
  --duesoon: #8a6212;
  --recent: #3f5d4e;
  --quiet: #7d7768;
}
:root:not([data-theme="light"]) {
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #14120e;
    --paper-2: #1c1915;
    --ink: #ece6d9;
    --ink-soft: #a49c8b;
    --rule: #3a352c;
    --rule-strong: #6b6354;
    --overdue: #e0704f;
    --duesoon: #c9a227;
    --recent: #7fae93;
    --quiet: #7d7668;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --paper: #14120e;
  --paper-2: #1c1915;
  --ink: #ece6d9;
  --ink-soft: #a49c8b;
  --rule: #3a352c;
  --rule-strong: #6b6354;
  --overdue: #e0704f;
  --duesoon: #c9a227;
  --recent: #7fae93;
  --quiet: #7d7668;
  color-scheme: dark;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  font-size: 16px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}
.sheet { max-width: 1180px; margin: 0 auto; padding: 0 24px 80px; }

/* --- masthead: a bulletin, not a dashboard header */
.masthead { border-bottom: 3px double var(--rule-strong); padding: 34px 0 12px; }
.masthead h1 {
  margin: 0;
  font-size: clamp(28px, 5vw, 46px);
  font-weight: 400;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.masthead .sub {
  margin: 6px 0 14px;
  font-size: 14px;
  color: var(--ink-soft);
  max-width: 62ch;
}
.dateline {
  display: flex; flex-wrap: wrap; gap: 6px 22px;
  font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  font-size: 11px; letter-spacing: 0.09em; text-transform: uppercase; color: var(--quiet);
  padding-bottom: 8px;
}

/* --- section headings */
h2 {
  font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase;
  font-weight: 400; color: var(--ink-soft);
  margin: 40px 0 10px; padding-bottom: 6px;
  border-bottom: 1px solid var(--rule);
}

/* --- tally: figures set as running text, not as tiles */
.tally {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 13px; line-height: 2; margin: 14px 0 0;
}
.tally b { font-weight: 600; font-size: 17px; }
.tally .sep { color: var(--rule); margin: 0 10px; }

table { width: 100%; border-collapse: collapse; font-size: 14px; }
th {
  text-align: left; font-weight: 400; font-size: 10px; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--quiet);
  border-bottom: 1px solid var(--rule-strong); padding: 0 10px 5px 0; white-space: nowrap;
}
td { padding: 7px 10px 7px 0; border-bottom: 1px solid var(--rule); vertical-align: baseline; }
.num {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap;
}
.right { text-align: right; }

/* --- status: a printed stamp, one colour each, no pills */
.stamp {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; white-space: nowrap;
}
.s-overdue  { color: var(--overdue); font-weight: 700; }
.s-due-soon { color: var(--duesoon); }
.s-recent   { color: var(--recent); }
.s-no-signal{ color: var(--quiet); }
.s-unverified { color: var(--quiet); font-style: italic; }

.co { cursor: pointer; }
.co:hover td { background: var(--paper-2); }
.co .nm { font-size: 16px; }
.co .fundlist { font-size: 12px; color: var(--ink-soft); }
.marker { color: var(--quiet); font-family: ui-monospace, monospace; font-size: 11px; }

/* --- expanded register history */
.detail td { background: var(--paper-2); padding: 14px 18px 18px; border-bottom: 1px solid var(--rule); }
.detail .why { font-size: 14px; margin: 0 0 12px; max-width: 78ch; }
.ledger { width: 100%; font-size: 13px; }
.ledger td { background: none; border-bottom: 1px dotted var(--rule); padding: 4px 12px 4px 0; }
.ledger .v-round-candidate { color: var(--overdue); font-weight: 600; }
.ledger .v-employee-equity, .ledger .v-structural, .ledger .v-increase-unsized,
.ledger .v-capital-decrease, .ledger .v-capital-restructure, .ledger .v-structural-with-capital { color: var(--quiet); }
.meta { font-size: 12px; color: var(--ink-soft); margin-top: 12px; }
.meta a { color: inherit; }

/* --- filters: text switches, not buttons */
.filters { display: flex; flex-wrap: wrap; gap: 4px 20px; align-items: baseline; margin: 16px 0 4px; }
.filters button {
  background: none; border: 0; padding: 2px 0; cursor: pointer; color: var(--ink-soft);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
  border-bottom: 2px solid transparent;
}
.filters button[aria-pressed="true"] { color: var(--ink); border-bottom-color: var(--rule-strong); }
.filters input {
  background: none; border: 0; border-bottom: 1px solid var(--rule); color: var(--ink);
  font-family: inherit; font-size: 14px; padding: 3px 0; min-width: 200px;
}
.filters input:focus { outline: none; border-bottom-color: var(--rule-strong); }

/* --- caveats read as a footnote block, because that is what they are */
.caveats { margin-top: 46px; border-top: 3px double var(--rule-strong); padding-top: 16px; }
.caveats ol { margin: 0; padding-left: 1.3em; }
.caveats li { font-size: 13px; color: var(--ink-soft); margin-bottom: 9px; max-width: 88ch; }
.empty { padding: 30px 0; color: var(--quiet); font-size: 14px; }

@media (max-width: 700px) {
  .sheet { padding: 0 14px 60px; }
  .hide-s { display: none; }
  table { font-size: 13px; }
}
`;

const SCRIPT = `
const DATA = window.__FUNDS__;
const $ = (s) => document.querySelector(s);
const state = { status: 'overdue', fund: 'all', q: '' };

const LABEL = { overdue: 'Overdue', 'due-soon': 'Due soon', recent: 'Recently raised', 'no-signal': 'No signal', unverified: 'Unverified SIREN', all: 'All' };
const fundName = (id) => (DATA.funds.find((f) => f.id === id) || {}).name || id;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const eur = (n) => (n == null ? '—' : Math.round(n).toLocaleString('fr-FR') + ' €');

function visible() {
  const q = state.q.trim().toLowerCase();
  return DATA.companies
    .filter((c) => state.status === 'all' || c.status === state.status)
    .filter((c) => state.fund === 'all' || c.funds.includes(state.fund))
    .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.legalName || '').toLowerCase().includes(q) || c.siren.includes(q))
    .sort((a, b) => {
      // Longest overdue first — that is the whole point of the page.
      if (a.monthsSince == null) return 1;
      if (b.monthsSince == null) return -1;
      return (b.monthsSince - b.cycleMonths) - (a.monthsSince - a.cycleMonths);
    });
}

function render() {
  const rows = visible();
  $('#count').textContent = rows.length + (rows.length === 1 ? ' company' : ' companies');
  const body = rows.map((c) => \`
    <tr class="co" data-key="\${esc(c.key)}">
      <td><span class="nm">\${esc(c.name)}</span><br><span class="fundlist">\${c.funds.map(fundName).map(esc).join(' · ')}</span></td>
      <td class="stamp s-\${c.status}">\${LABEL[c.status]}</td>
      <td class="num">\${c.lastRound || '—'}</td>
      <td class="num right">\${c.monthsSince == null ? '—' : Math.round(c.monthsSince)}</td>
      <td class="num right hide-s">\${c.cycleMonths}\${c.cycleMeasured ? '' : '<span class="marker"> approx</span>'}</td>
      <td class="num right hide-s">\${c.roundCount}</td>
      <td class="num hide-s">\${esc(c.siren)}\${c.confidence === 'medium' ? '<span class="marker"> ?</span>' : ''}</td>
    </tr>\`).join('');
  $('#rows').innerHTML = body || '<tr><td colspan="7" class="empty">No company matches this filter.</td></tr>';
}

function detailRow(c) {
  const events = [...c.events].reverse().map((e) => \`
    <tr>
      <td class="num">\${e.date}</td>
      <td class="v-\${e.verdict}">\${e.verdict.replace(/-/g, ' ')}</td>
      <td>\${esc(e.basis || '')}</td>
      <td class="num right">\${eur(e.capital)}</td>
    </tr>\`).join('');
  return \`<tr class="detail"><td colspan="7">
    <p class="why">\${esc(c.why)}</p>
    \${c.blurb ? '<p class="why">' + esc(c.blurb) + '</p>' : ''}
    \${events ? '<table class="ledger"><tbody>' + events + '</tbody></table>' : '<p class="why">No capital events published in the register.</p>'}
    <p class="meta">
      \${esc(c.legalName || c.name)} · SIREN \${esc(c.siren)}\${c.department ? ' · dept ' + esc(c.department) : ''}
      \${c.capital != null ? ' · current capital ' + eur(c.capital) : ''}
      \${c.confidence === 'medium' ? ' · <b>SIREN match is medium confidence — verify before acting</b>' : ''}
      · <a href="https://annuaire-entreprises.data.gouv.fr/entreprise/\${esc(c.siren)}" target="_blank" rel="noopener">official record</a>
    </p>
  </td></tr>\`;
}

document.addEventListener('click', (ev) => {
  const row = ev.target.closest('.co');
  if (row) {
    const open = row.nextElementSibling && row.nextElementSibling.classList.contains('detail');
    document.querySelectorAll('.detail').forEach((d) => d.remove());
    if (!open) {
      const c = DATA.companies.find((x) => x.key === row.dataset.key);
      row.insertAdjacentHTML('afterend', detailRow(c));
    }
    return;
  }
  const btn = ev.target.closest('.filters button');
  if (!btn) return;
  state[btn.dataset.dim] = btn.dataset.value;
  document.querySelectorAll('.filters button[data-dim="' + btn.dataset.dim + '"]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.value === state[btn.dataset.dim]))
  );
  render();
});

$('#q').addEventListener('input', (e) => { state.q = e.target.value; render(); });
render();
`;

const statusFilters = ['overdue', 'due-soon', 'recent', 'no-signal', 'unverified', 'all']
  .map((s) => {
    const label = { overdue: 'Overdue', 'due-soon': 'Due soon', recent: 'Recent', 'no-signal': 'No signal', unverified: 'Unverified', all: 'All' }[s];
    const n = s === 'all' ? payload.companies.length : payload.companies.filter((c) => c.status === s).length;
    return `<button data-dim="status" data-value="${s}" aria-pressed="${s === 'overdue'}">${label} (${n})</button>`;
  })
  .join('');

const fundFilters =
  `<button data-dim="fund" data-value="all" aria-pressed="true">All funds</button>` +
  payload.funds.map((f) => `<button data-dim="fund" data-value="${esc(f.id)}" aria-pressed="false">${esc(f.name)}</button>`).join('');

const fundRows = payload.funds
  .sort((a, b) => b.overdue - a.overdue)
  .map(
    (f) => `<tr>
      <td><a href="${esc(f.portfolioUrl)}" target="_blank" rel="noopener" style="color:inherit">${esc(f.name)}</a></td>
      <td class="hide-s" style="color:var(--ink-soft);font-size:13px">${esc(f.type)}</td>
      <td class="num right">${f.listed}</td>
      <td class="num right">${f.tracked}</td>
      <td class="num right s-overdue">${f.overdue}</td>
      <td class="num right s-due-soon">${f.dueSoon}</td>
    </tr>`
  )
  .join('');

const html = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Funds App — Paris VC portfolios and who is due to raise</title>
<meta name="description" content="Portfolio holdings of ${payload.totals.funds} Paris venture funds, with every capital event dated from the French commercial register.">
<style>${CSS}</style>
<div class="sheet">
  <header class="masthead">
    <h1>Funds App</h1>
    <p class="sub">Portfolio holdings of ${payload.totals.funds} Paris venture and growth funds, with every capital event dated from the official French commercial register — and which companies are overdue for their next round.</p>
    <div class="dateline">
      <span>${esc(generated)}</span>
      <span>${payload.totals.tracked} companies tracked</span>
      <span>${payload.totals.roundCandidates} round candidates</span>
      <span>Sources: BODACC · annuaire des entreprises</span>
    </div>
  </header>

  <p class="tally">
    <b class="s-overdue">${payload.totals.overdue}</b> overdue<span class="sep">|</span>
    <b class="s-due-soon">${payload.totals.dueSoon}</b> due soon<span class="sep">|</span>
    <b class="s-recent">${payload.totals.recent}</b> raised recently<span class="sep">|</span>
    <b class="s-no-signal">${payload.totals.noSignal}</b> no signal
  </p>

  <h2>The funds</h2>
  <table>
    <thead><tr><th>Fund</th><th class="hide-s">Stage</th><th class="right">Listed</th><th class="right">Tracked</th><th class="right">Overdue</th><th class="right">Due soon</th></tr></thead>
    <tbody>${fundRows}</tbody>
  </table>

  <h2>Companies — <span id="count"></span></h2>
  <div class="filters">${statusFilters}</div>
  <div class="filters">${fundFilters}</div>
  <div class="filters"><input id="q" type="search" placeholder="Search name or SIREN" aria-label="Search"></div>
  <table>
    <thead><tr>
      <th>Company</th><th>Status</th><th>Last capital event</th><th class="right">Months</th>
      <th class="right hide-s">Cycle</th><th class="right hide-s">Events</th><th class="hide-s">SIREN</th>
    </tr></thead>
    <tbody id="rows"></tbody>
  </table>

  <section class="caveats">
    <h2 style="border:0;margin-bottom:4px">What this data cannot tell you</h2>
    <ol>${payload.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ol>
  </section>
</div>
<script>window.__FUNDS__ = ${JSON.stringify(payload)};</script>
<script>${SCRIPT}</script>
`;

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dist', 'index.html'), html);
console.log(`dist/index.html: ${(fs.statSync(path.join(ROOT, 'dist', 'index.html')).size / 1024).toFixed(0)} KB`);
