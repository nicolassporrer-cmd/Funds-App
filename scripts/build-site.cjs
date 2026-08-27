// Builds dist/index.html — one self-contained page with the payload inlined.
//
// No framework and no build step: the data is a static JSON blob, the page is
// read-only, and GitHub Pages serves it as a file. Anything more would be
// machinery around a document.
//
// The behaviour lives in lib/page-script.js so markup and logic stay separable.

const fs = require('fs');
const path = require('path');

// Read as text, not require()d: it is browser code, and its template literals
// would fight any attempt to wrap it in one.
const SCRIPT = fs.readFileSync(path.join(__dirname, 'lib', 'page-script.js'), 'utf8');

const ROOT = path.join(__dirname, '..');
const payload = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'payload.json'), 'utf8'));

// Company names and blurbs come off other people's websites, so everything that
// reaches the page is escaped, and the inlined payload has its "<" replaced so a
// blurb containing "</script>" cannot close the tag it lives in.
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
  --strong: #a3301a;
  --moderate: #8a6212;
  --weak: #6d6a5c;
  --recent: #3f5d4e;
  --quiet: #7d7768;
}
:root:not([data-theme="light"]) { color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #14120e;
    --paper-2: #1c1915;
    --ink: #ece6d9;
    --ink-soft: #a49c8b;
    --rule: #3a352c;
    --rule-strong: #6b6354;
    --strong: #e0704f;
    --moderate: #c9a227;
    --weak: #918a78;
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
  --strong: #e0704f;
  --moderate: #c9a227;
  --weak: #918a78;
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
.sheet { max-width: 1240px; margin: 0 auto; padding: 0 24px 80px; }

.masthead { border-bottom: 3px double var(--rule-strong); padding: 32px 0 0; }
.masthead h1 {
  margin: 0;
  font-size: clamp(25px, 4.6vw, 42px);
  font-weight: 400; letter-spacing: 0.14em; text-transform: uppercase;
}
.masthead .sub { margin: 6px 0 12px; font-size: 14px; color: var(--ink-soft); max-width: 68ch; }
.dateline {
  display: flex; flex-wrap: wrap; gap: 6px 22px;
  font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  font-size: 11px; letter-spacing: 0.09em; text-transform: uppercase; color: var(--quiet);
}
.nav { display: flex; gap: 24px; margin: 16px 0 0; }
.nav a {
  color: var(--ink-soft); text-decoration: none; padding-bottom: 8px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase;
  border-bottom: 3px solid transparent; margin-bottom: -3px;
}
.nav a[aria-current="true"] { color: var(--ink); border-bottom-color: var(--rule-strong); }
.backlink {
  display: inline-block; margin: 22px 0 0; color: var(--ink-soft);
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; text-decoration: none;
  border-bottom: 1px solid var(--rule);
}
.backlink:hover { color: var(--ink); }

h2 {
  font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase;
  font-weight: 400; color: var(--ink-soft);
  margin: 36px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--rule);
}
h3 {
  font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
  font-weight: 400; color: var(--quiet); margin: 16px 0 6px;
}
.note { font-size: 13px; color: var(--ink-soft); max-width: 86ch; margin: 10px 0 16px; }
.count { font-size: 12px; color: var(--quiet); margin-top: 10px; font-family: ui-monospace, monospace; }

.tally { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px; line-height: 2; margin: 18px 0 0; }
.tally b { font-weight: 600; font-size: 17px; }
.tally .sep { color: var(--rule); margin: 0 10px; }

table { width: 100%; border-collapse: collapse; font-size: 14px; }
th {
  text-align: left; font-weight: 400; font-size: 10px; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--quiet);
  border-bottom: 1px solid var(--rule-strong); padding: 0 10px 5px 0; white-space: nowrap;
}
td { padding: 8px 10px 8px 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
.num { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.right { text-align: right; }
.dash { color: var(--quiet); }
.overdue-now { color: var(--strong); font-weight: 700; }

/* --- the score, set as a figure rather than a progress bar */
.score {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums;
}
.score-strong { color: var(--strong); }
.score-moderate { color: var(--moderate); }
.score-weak { color: var(--weak); }

/* --- signal chips: a mark and a word, no pills or badges */
.chip {
  display: inline-block; margin: 0 8px 2px 0; cursor: help;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  border-bottom: 1px dotted var(--rule);
}
.chip-bridge { color: var(--strong); font-weight: 700; }
.chip-governance { color: var(--moderate); }
.chip-auditor, .chip-investor { color: var(--recent); }
.chip-cycle { color: var(--ink-soft); }

.stamp {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; white-space: nowrap;
}
.s-overdue { color: var(--strong); font-weight: 700; }
.s-due-soon { color: var(--moderate); }
.s-recent { color: var(--recent); }
.s-no-signal, .s-dormant, .s-exited, .s-untracked { color: var(--quiet); }
.s-unverified { color: var(--quiet); font-style: italic; }

.fundname { color: inherit; text-decoration: none; border-bottom: 1px solid var(--rule); }
.fundname:hover { border-bottom-color: var(--rule-strong); }

.co { cursor: pointer; }
.co:hover td { background: var(--paper-2); }
.co .nm { font-size: 16px; }
.co .fundlist { font-size: 12px; color: var(--ink-soft); }
.does { font-size: 13px; color: var(--ink-soft); max-width: 40ch; }
.contact { font-size: 13px; }
.marker { color: var(--quiet); font-family: ui-monospace, monospace; font-size: 11px; }

/* --- expanded company record */
.detail td { background: var(--paper-2); padding: 8px 18px 20px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 40px; }
.detail .why { font-size: 14px; margin: 0 0 8px; max-width: 70ch; }
.signals { margin: 0; padding-left: 1.1em; font-size: 13.5px; }
.signals li { margin-bottom: 7px; max-width: 68ch; }
.ledger { width: 100%; font-size: 13px; }
.ledger td { background: none; border-bottom: 1px dotted var(--rule); padding: 4px 12px 4px 0; }
.ledger .v-round-candidate { color: var(--strong); font-weight: 600; }
.ledger .v-bridge { color: var(--moderate); font-weight: 600; }
.ledger .v-employee-equity, .ledger .v-structural, .ledger .v-increase-unsized,
.ledger .v-capital-decrease, .ledger .v-capital-restructure, .ledger .v-structural-with-capital { color: var(--quiet); }
.meta { font-size: 12px; color: var(--ink-soft); margin-top: 16px; border-top: 1px solid var(--rule); padding-top: 10px; }
.meta a { color: inherit; }

.filters { display: flex; flex-wrap: wrap; gap: 4px 20px; align-items: baseline; margin: 14px 0 4px; }
.filters button {
  background: none; border: 0; padding: 2px 0; cursor: pointer; color: var(--ink-soft);
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
  border-bottom: 2px solid transparent;
}
.filters button[aria-pressed="true"] { color: var(--ink); border-bottom-color: var(--rule-strong); }
.filters input, .filters select {
  background: none; border: 0; border-bottom: 1px solid var(--rule); color: var(--ink);
  font-family: inherit; font-size: 14px; padding: 3px 0;
}
.filters input { min-width: 210px; }
.filters input:focus, .filters select:focus { outline: none; border-bottom-color: var(--rule-strong); }

.caveats { margin-top: 46px; border-top: 3px double var(--rule-strong); padding-top: 16px; }
.caveats ol { margin: 0; padding-left: 1.3em; }
.caveats li { font-size: 13px; color: var(--ink-soft); margin-bottom: 9px; max-width: 92ch; }
.empty { padding: 30px 0; color: var(--quiet); font-size: 14px; }

@media (max-width: 860px) {
  .cols { grid-template-columns: 1fr; }
}
@media (max-width: 760px) {
  .sheet { padding: 0 14px 60px; }
  .hide-s { display: none; }
  table { font-size: 13px; }
}
`;

const html = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Funds App — which Paris portfolio companies are about to raise</title>
<meta name="description" content="Companies in ${payload.totals.funds} Paris VC portfolios showing signs of raising again, dated from the French commercial register.">
<style>${CSS}</style>
<div class="sheet">
  <header class="masthead">
    <h1><a href="#/" style="color:inherit;text-decoration:none">Funds App</a></h1>
    <p class="sub">Which companies in ${payload.totals.funds} Paris venture portfolios are showing signs of raising again — read from the official French commercial register, which records capital and board changes whether or not anyone announces them.</p>
    <div class="dateline">
      <span>${esc(generated)}</span>
      <span>${payload.totals.companies} companies</span>
      <span>${payload.totals.tracked} with register history</span>
      <span>${payload.totals.roundCandidates} rounds dated</span>
    </div>
    <nav class="nav">
      <a href="#/">Raising soon</a>
      <a href="#/funds">The funds</a>
    </nav>
  </header>

  <main id="view"></main>

  <section class="caveats">
    <h2 style="border:0;margin-bottom:4px">What this data cannot tell you</h2>
    <ol>${payload.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ol>
  </section>
</div>
<script>window.__FUNDS__ = ${JSON.stringify(payload).replace(/</g, '\\u003c')};</script>
<script>${SCRIPT}</script>
`;

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dist', 'index.html'), html);
console.log(`dist/index.html: ${(fs.statSync(path.join(ROOT, 'dist', 'index.html')).size / 1024).toFixed(0)} KB`);
