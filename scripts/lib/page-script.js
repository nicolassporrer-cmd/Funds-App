// Client-side behaviour for dist/index.html, kept as a plain script file so the
// markup and the behaviour can be read separately. build-site.cjs inlines it
// verbatim; it is never require()d, because it is browser code.
//
// Three views, routed on the hash so any of them can be linked:
//   #/            the raise list — companies showing signals of raising soon
//   #/funds       the funds, and how much of each portfolio is live
//   #/fund/<id>   one fund's portfolio in full

const DATA = window.__FUNDS__;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const eur = (n) => (n == null ? '—' : Math.round(n).toLocaleString('fr-FR') + ' €');
const dash = (v) => (v ? esc(v) : '<span class="dash">—</span>');
const year = (d) => (d ? d.slice(0, 4) : null);
// Cut on a word boundary: slicing mid-word looks like corrupted data rather than
// a shortened description.
const clip = (text, max) => {
  if (!text) return null;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return cut.slice(0, cut.lastIndexOf(' ')) + '…';
};

const LABEL = {
  overdue: 'Overdue', 'due-soon': 'Due soon', recent: 'Recently raised', 'no-signal': 'No signal',
  dormant: 'Dormant', exited: 'Exited', unverified: 'Unverified SIREN', untracked: 'Not in French register',
};
const fundOf = (id) => DATA.funds.find((f) => f.id === id) || { id, name: id };

// "Live" means nobody has said otherwise: the fund has not tagged it exited, the
// register still shows activity, and the SIREN we matched is real.
const GONE = ['exited', 'dormant', 'unverified'];
const isLive = (c) => !GONE.includes(c.status);

const SIGNAL_ICON = { bridge: '◆', governance: '●', auditor: '▲', investor: '■', cycle: '○', size: '·', alive: '·' };

const state = { minScore: 20, q: '', fund: 'all', sort: 'score', fundQ: '', fundSort: 'lastRound', includeGone: false,
  window: 'two', region: 'all', seriesAOnly: true, dealQ: '' };

// ---------- routing
function route() {
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/fund\/([a-z0-9-]+)/i);
  const fund = m ? DATA.funds.find((f) => f.id === m[1]) : null;
  document.querySelectorAll('.nav a').forEach((a) => {
    a.setAttribute('aria-current', String(a.getAttribute('href') === (fund ? '#/funds' : hash)));
  });
  if (fund) renderFund(fund);
  else if (hash.startsWith('#/funds')) renderFunds();
  else if (hash.startsWith('#/signals')) renderRaising();
  else renderDeals();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);


// ---------- the deal log: the landing view
//
// One row per round, grouped by the quarter it happened in, because the date is
// the whole signal. Paris rounds come from BODACC, New York rounds from SEC
// Form D — and only the US register publishes an amount, so the money column is
// empty for every French row by nature rather than by omission.
const WINDOWS = [
  { id: 'two', label: 'Around 2 years ago', lo: 18, hi: 30 },
  { id: 'oneTwo', label: '1 to 2 years', lo: 12, hi: 24 },
  { id: 'twoThree', label: '2 to 3 years', lo: 24, hi: 36 },
  { id: 'wide', label: 'Everything 1-4 years', lo: 12, hi: 48 },
  { id: 'all', label: 'Every deal on record', lo: 0, hi: 1e6 },
];

const usd = (n) => {
  if (n == null) return null;
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'bn';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'm';
  return '$' + Math.round(n / 1000) + 'k';
};
const quarterOf = (d) => d.slice(0, 4) + ' Q' + (Math.floor(Number(d.slice(5, 7)) - 1) / 3 + 1 | 0);
const dueFlag = (m) =>
  m >= 30 ? ['f-later', 'Past due'] : m >= 21 ? ['f-due', 'Due now'] : m >= 15 ? ['f-soon', 'Due soon'] : ['f-later', 'Early'];

function dealRows() {
  const w = WINDOWS.find((x) => x.id === state.window);
  const q = state.dealQ.trim().toLowerCase();
  return DATA.deals
    .filter((d) => d.isLatest)
    .filter((d) => !state.seriesAOnly || d.seriesA)
    .filter((d) => state.region === 'all' || d.region === state.region)
    .filter((d) => state.fund === 'all' || d.funds.includes(state.fund))
    .filter((d) => d.monthsAgo >= w.lo && d.monthsAgo < w.hi)
    .filter((d) => !q || d.company.toLowerCase().includes(q) || (d.blurb || '').toLowerCase().includes(q))
    .sort((a, b) => b.date.localeCompare(a.date));
}

function renderDeals() {
  const funds = DATA.funds;
  $('#view').innerHTML = `
    <p class="note" style="margin-top:20px">
      One row per fundraising round, newest first, grouped by the quarter it happened in.
      A round about two years old is a company approaching its next raise &mdash; the date is the
      whole flag, and it is an official filing rather than an estimate.
      Paris rounds come from the French commercial register; New York rounds from SEC Form D,
      which is the only one of the two that publishes an amount.
    </p>
    <div class="filters" id="dealWindows">
      ${WINDOWS.map((w) => `<button data-dim="window" data-value="${w.id}" aria-pressed="${state.window === w.id}">${w.label}</button>`).join('')}
    </div>
    <div class="filters">
      <button data-dim="region" data-value="all" aria-pressed="${state.region === 'all'}">Both cities</button>
      <button data-dim="region" data-value="Paris" aria-pressed="${state.region === 'Paris'}">Paris</button>
      <button data-dim="region" data-value="New York" aria-pressed="${state.region === 'New York'}">New York</button>
      <button data-dim="seriesAOnly" data-value="toggle" aria-pressed="${state.seriesAOnly}">
        ${state.seriesAOnly ? 'Series A or later only' : 'Including first rounds'}
      </button>
      <select id="dealFund" aria-label="Filter by fund">
        <option value="all">All funds</option>
        ${funds.map((f) => `<option value="${f.id}"${state.fund === f.id ? ' selected' : ''}>${esc(f.name)} &middot; ${esc(f.region)}</option>`).join('')}
      </select>
      <input id="dq" type="search" placeholder="Search company or business" aria-label="Search deals" value="${esc(state.dealQ)}">
    </div>
    <p class="tally" id="dealTally"></p>
    <div id="dealLog"></div>`;

  renderDealRows();
  $('#dq').addEventListener('input', (e) => { state.dealQ = e.target.value; renderDealRows(); });
  $('#dealFund').addEventListener('change', (e) => { state.fund = e.target.value; renderDealRows(); });
}

function renderDealRows() {
  const rows = dealRows();
  const paris = rows.filter((d) => d.region === 'Paris').length;
  const withAmount = rows.filter((d) => d.amountSold);
  const raised = withAmount.reduce((s, d) => s + d.amountSold, 0);

  $('#dealTally').innerHTML =
    `<b>${rows.length}</b> rounds<span class="sep">|</span>` +
    `<b>${paris}</b> Paris<span class="sep">|</span>` +
    `<b>${rows.length - paris}</b> New York<span class="sep">|</span>` +
    `<b class="f-due">${rows.filter((d) => d.monthsAgo >= 21 && d.monthsAgo < 30).length}</b> in the 21&ndash;30 month band` +
    (withAmount.length ? `<span class="sep">|</span><b>${usd(raised)}</b> across the ${withAmount.length} with a published amount` : '');

  const byQ = {};
  rows.forEach((d) => { (byQ[quarterOf(d.date)] = byQ[quarterOf(d.date)] || []).push(d); });

  $('#dealLog').innerHTML = Object.keys(byQ).sort().reverse().map((q) => {
    const items = byQ[q];
    const avg = Math.round(items.reduce((s, d) => s + d.monthsAgo, 0) / items.length);
    return `<section><div class="quarter"><h2>${q}</h2>` +
      `<span class="age">${avg} months ago</span>` +
      `<span class="n">${items.length} round${items.length > 1 ? 's' : ''}</span></div>` +
      items.map((d) => {
        const [cls, label] = dueFlag(d.monthsAgo);
        return `<article class="deal co" data-deal="${esc(d.id)}">
          <span class="date">${d.date.slice(5)}<span class="reg reg-${d.register}">${d.register === 'FR' ? 'Paris' : 'NY'}</span></span>
          <span><span class="co-name">${esc(d.company)}</span>
            <span class="sub">${d.funds.map((f) => esc(fundOf(f).name)).join(' · ')}</span></span>
          <span class="does">${d.blurb ? esc(clip(d.blurb, 120)) : '<span class="dash">no description published</span>'}</span>
          <span class="amount">${d.amountSold ? esc(usd(d.amountSold)) : '<span class="dash" title="The French register never publishes round amounts">&mdash;</span>'}</span>
          <span class="flag ${cls}">${label}${d.bridgeSince ? '<br><span class="mark">bridge since</span>' : ''}</span>
        </article>`;
      }).join('') + '</section>';
  }).join('') || '<p class="empty">No rounds in this window.</p>';
}

function dealDetail(d) {
  const amount = d.amountSold
    ? `<b>${usd(d.amountSold)} sold</b>${d.amountOffered && d.amountOffered !== d.amountSold ? ' of ' + usd(d.amountOffered) + ' offered' : ''} <span class="marker">(SEC Form D)</span>`
    : 'Not published. <span class="marker">In a French SAS the money goes into the prime d’émission, which the register never prints — only nominal capital moves.</span>';
  return `<div class="detail-inline">
    <div class="cols">
      <div>
        <h3>The round</h3>
        <p class="why">${d.date} · ${Math.round(d.monthsAgo)} months ago · ${esc(d.region)}</p>
        <p class="why">Amount: ${amount}</p>
        <p class="why">Series A or later: <b>${d.seriesA ? 'yes' : 'no'}</b> — ${esc(d.seriesAWhy)}</p>
        ${d.bridgeSince ? '<p class="why">A smaller capital increase has been registered since, which reads as a bridge from existing investors.</p>' : ''}
      </div>
      <div>
        <h3>The company</h3>
        <p class="why">${d.blurb ? esc(d.blurb) : '<span class="dash">No description published by the fund.</span>'}</p>
        <p class="meta" style="border:0;padding:0">
          ${esc(d.company)}
          ${d.founded ? ' · incorporated ' + esc(d.founded) : ''}
          ${d.city ? ' · ' + esc(d.city) : ''}${d.country ? ', ' + esc(d.country) : ''}
          ${d.headcount ? ' · INSEE headcount bracket ' + esc(d.headcount) : ''}
          ${d.capitalAfter != null ? ' · capital after ' + eur(d.capitalAfter) : ''}
          · ${d.register === 'FR' ? 'SIREN ' + esc(d.identifier) : 'CIK ' + esc(d.identifier)}
          · <a href="${d.register === 'FR'
            ? 'https://annuaire-entreprises.data.gouv.fr/entreprise/' + esc(d.identifier)
            : 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=' + esc(d.identifier) + '&type=D'}"
            target="_blank" rel="noopener">official filing</a>
          ${d.website ? ' · <a href="' + esc(d.website) + '" target="_blank" rel="noopener">website</a>' : ''}
        </p>
      </div>
    </div>
  </div>`;
}

// ---------- the raise list
function raisingRows() {
  const q = state.q.trim().toLowerCase();
  return DATA.companies
    .filter((c) => c.tracked && isLive(c))
    .filter((c) => c.score >= state.minScore)
    .filter((c) => state.fund === 'all' || c.funds.includes(state.fund))
    .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.blurb || '').toLowerCase().includes(q))
    .sort((a, b) => {
      if (state.sort === 'due') return (a.dueInMonths ?? 999) - (b.dueInMonths ?? 999);
      if (state.sort === 'lastRound') return (b.lastRound || '').localeCompare(a.lastRound || '');
      return b.score - a.score || (b.lastRound || '').localeCompare(a.lastRound || '');
    });
}

function scoreBar(score) {
  const band = score >= 60 ? 'strong' : score >= 40 ? 'moderate' : 'weak';
  return '<span class="score score-' + band + '">' + score + '</span>';
}

function signalChips(c) {
  const chips = c.signals
    .filter((s) => s.weight > 0 && s.kind !== 'alive' && s.kind !== 'size')
    .map((s) => '<span class="chip chip-' + s.kind + '" title="' + esc(s.text) + '">' + (SIGNAL_ICON[s.kind] || '·') + ' ' + s.kind + '</span>');
  return chips.join(' ') || '<span class="dash">—</span>';
}

function renderRaising() {
  const live = DATA.companies.filter((c) => c.tracked && isLive(c));
  const bands = {
    strong: live.filter((c) => c.score >= 60).length,
    moderate: live.filter((c) => c.score >= 40 && c.score < 60).length,
    weak: live.filter((c) => c.score >= 20 && c.score < 40).length,
  };

  $('#view').innerHTML = `
    <p class="tally">
      <b class="score-strong">${bands.strong}</b> strong signal<span class="sep">|</span>
      <b class="score-moderate">${bands.moderate}</b> moderate<span class="sep">|</span>
      <b class="score-weak">${bands.weak}</b> weak<span class="sep">|</span>
      <b>${live.filter((c) => c.hasBridge).length}</b> took a bridge<span class="sep">|</span>
      <b>${live.filter((c) => c.investorOfficers.length).length}</b> with an investor on the board
    </p>
    <p class="note">
      Ranked by what the register is showing now, not by how overdue a company is. The score is the
      sum of the signals on each row — hover any chip for the evidence behind it, or open a row for
      all of it. Tuned for recall: a company approaching its cycle appears here even with nothing
      else on it, so treat the bottom of the list as leads rather than conclusions.
    </p>
    <div class="filters">
      <button data-dim="minScore" data-value="60" aria-pressed="${state.minScore === 60}">Strong only</button>
      <button data-dim="minScore" data-value="40" aria-pressed="${state.minScore === 40}">Moderate and up</button>
      <button data-dim="minScore" data-value="20" aria-pressed="${state.minScore === 20}">Everything with a signal</button>
      <button data-dim="minScore" data-value="0" aria-pressed="${state.minScore === 0}">All live companies</button>
    </div>
    <div class="filters">
      <button data-dim="sort" data-value="score" aria-pressed="${state.sort === 'score'}">By signal</button>
      <button data-dim="sort" data-value="due" aria-pressed="${state.sort === 'due'}">By due date</button>
      <button data-dim="sort" data-value="lastRound" aria-pressed="${state.sort === 'lastRound'}">By last round</button>
      <select id="fundPick" aria-label="Filter by fund">
        <option value="all">All funds</option>
        ${DATA.funds.map((f) => '<option value="' + f.id + '"' + (state.fund === f.id ? ' selected' : '') + '>' + esc(f.name) + '</option>').join('')}
      </select>
      <input id="q" type="search" placeholder="Search name or business" aria-label="Search" value="${esc(state.q)}">
    </div>
    <table>
      <thead><tr>
        <th class="right">Signal</th><th>Company</th><th class="hide-s">What it does</th>
        <th>Signals</th><th>Last round</th><th class="right hide-s">Due in</th><th class="hide-s">Contact</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <p class="count" id="count"></p>`;

  renderRaisingRows();
  $('#q').addEventListener('input', (e) => { state.q = e.target.value; renderRaisingRows(); });
  $('#fundPick').addEventListener('change', (e) => { state.fund = e.target.value; renderRaisingRows(); });
}

function renderRaisingRows() {
  const rows = raisingRows();
  $('#count').textContent = rows.length + (rows.length === 1 ? ' company' : ' companies') + ' shown';
  $('#rows').innerHTML = rows.map((c) => `
    <tr class="co" data-key="${esc(c.key)}">
      <td class="right">${scoreBar(c.score)}</td>
      <td><span class="nm">${esc(c.name)}</span><br><span class="fundlist">${c.funds.map((id) => esc(fundOf(id).name)).join(' · ')}</span></td>
      <td class="does hide-s">${c.blurb ? esc(clip(c.blurb, 140)) : '<span class="dash">—</span>'}</td>
      <td>${signalChips(c)}</td>
      <td class="num">${c.lastRound || '<span class="dash">—</span>'}</td>
      <td class="num right hide-s">${c.dueInMonths == null ? '<span class="dash">—</span>' : (c.dueInMonths > 0 ? Math.round(c.dueInMonths) + ' mo' : '<span class="overdue-now">now</span>')}</td>
      <td class="hide-s contact">${c.contact ? esc(c.contact.who) + '<br><span class="marker">' + esc(c.contact.origin) + '</span>' : '<span class="dash">—</span>'}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="empty">Nothing at this signal level.</td></tr>';
}

// ---------- shared: the expanded company record
function detailRow(c, colspan) {
  const signals = c.signals.filter((s) => s.weight > 0).map((s) => `
    <li><b>${esc(s.kind)}</b> <span class="marker">+${s.weight}</span> — ${esc(s.text)}</li>`).join('');

  const events = [...c.events].reverse().map((e) => `
    <tr>
      <td class="num">${e.date}</td>
      <td class="v-${e.verdict}">${e.verdict.replace(/-/g, ' ')}</td>
      <td>${esc(e.basis || '')}</td>
      <td class="num right">${eur(e.capital)}</td>
    </tr>`).join('');

  const heldBy = c.funds.map((id) => {
    const status = (c.holdings || {})[id];
    return esc(fundOf(id).name) + (status && status !== 'unknown' ? ' (' + status + ')' : '');
  }).join(' · ');

  const stage = c.stage.map((s) => `<tr><td>${esc(s.label)}</td><td class="num">${esc(s.value)}</td><td class="marker">${esc(s.source)}</td></tr>`).join('');

  return `<tr class="detail"><td colspan="${colspan}">
    <div class="cols">
      <div>
        <h3>Why it is on this list</h3>
        ${signals ? '<ul class="signals">' + signals + '</ul>' : '<p class="why">No positive signals — listed only because you asked to see all live companies.</p>'}
        <h3>What it does</h3>
        <p class="why">${c.blurb ? esc(c.blurb) : '<span class="dash">No description published by the fund.</span>'}</p>
        <h3>Investors</h3>
        <p class="why">
          Listed by: ${heldBy}.
          ${c.investorOfficers.length
            ? '<br>On the board as a corporate officer: <b>' + c.investorOfficers.map((o) => esc(o.name) + (o.role ? ' (' + esc(o.role) + ')' : '')).join(', ') + '</b>.'
            : ''}
          ${c.auditors.length ? '<br>Statutory auditor: ' + c.auditors.map(esc).join(', ') + '.' : ''}
          <br><span class="marker">Board representation and fund websites — not a shareholder register. None is public for a French SAS.</span>
        </p>
        <h3>Contact</h3>
        <p class="why">${c.contact
          ? '<b>' + esc(c.contact.who) + '</b> <span class="marker">(' + esc(c.contact.origin) + ')</span>'
          : '<span class="dash">None recorded.</span> <span class="marker">Add one in data/contacts.json — no open source maps a partner to a company.</span>'}</p>
      </div>
      <div>
        <h3>Stage evidence</h3>
        ${stage ? '<table class="ledger"><tbody>' + stage + '</tbody></table>' : '<p class="why"><span class="dash">Nothing filed that would indicate stage.</span></p>'}
        <h3>Register history</h3>
        ${events ? '<table class="ledger"><tbody>' + events + '</tbody></table>' : '<p class="why"><span class="dash">No capital events published.</span></p>'}
      </div>
    </div>
    <p class="meta">
      ${c.legalName ? esc(c.legalName) : esc(c.name)}
      ${c.siren ? ' · SIREN ' + esc(c.siren) : ''}
      ${c.founded ? ' · incorporated ' + esc(c.founded) : ''}
      ${c.city ? ' · ' + esc(c.city) : ''}${c.country ? ', ' + esc(c.country) : ''}
      ${c.capital != null ? ' · capital ' + eur(c.capital) : ''}
      ${c.confidence === 'medium' ? ' · <b>SIREN match is medium confidence — verify before acting</b>' : ''}
      ${c.siren ? ' · <a href="https://annuaire-entreprises.data.gouv.fr/entreprise/' + esc(c.siren) + '" target="_blank" rel="noopener">official record</a>' : ''}
      ${c.website ? ' · <a href="' + esc(c.website) + '" target="_blank" rel="noopener">website</a>' : ''}
    </p>
  </td></tr>`;
}

// ---------- the funds
function renderFunds() {
  const rows = [...DATA.funds].sort((a, b) => b.raising - a.raising).map((f) => `
    <tr>
      <td><a class="fundname" href="#/fund/${f.id}">${esc(f.name)}</a></td>
      <td class="hide-s" style="color:var(--ink-soft);font-size:13px">${esc(f.type)}</td>
      <td class="num right">${f.listed}</td>
      <td class="num right hide-s">${f.listedCurrent || '<span class="marker">n/d</span>'}</td>
      <td class="num right hide-s">${f.listedExited || '<span class="marker">n/d</span>'}</td>
      <td class="num right">${f.live}</td>
      <td class="num right score-strong">${f.raising}</td>
    </tr>`).join('');

  $('#view').innerHTML = `
    <h2>The funds</h2>
    <p class="note">
      “Listed” is every company on the fund’s own portfolio page — for most funds that is everything
      they have <em>ever</em> backed, not what they hold today. Only Partech and Elaia publish the
      distinction; elsewhere the column reads <span class="marker">n/d</span> and “Live” falls back
      to the register: still filing, no known exit. Click a fund for its portfolio in full.
    </p>
    <table>
      <thead><tr>
        <th>Fund</th><th class="hide-s">Stage</th><th class="right">Listed</th>
        <th class="right hide-s">Current</th><th class="right hide-s">Exited</th>
        <th class="right">Live</th><th class="right">Raising signal</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ---------- one fund
function fundRows(fund) {
  const q = state.fundQ.trim().toLowerCase();
  return DATA.companies
    .filter((c) => c.funds.includes(fund.id))
    .filter((c) => state.includeGone || isLive(c))
    .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.blurb || '').toLowerCase().includes(q) || (c.country || '').toLowerCase().includes(q))
    .sort((a, b) => {
      if (state.fundSort === 'name') return a.name.localeCompare(b.name);
      if (state.fundSort === 'founded') return (b.founded || '').localeCompare(a.founded || '');
      if (state.fundSort === 'score') return b.score - a.score;
      return (b.lastRound || '').localeCompare(a.lastRound || '');
    });
}

function renderFund(fund) {
  const mine = DATA.companies.filter((c) => c.funds.includes(fund.id));

  $('#view').innerHTML = `
    <a class="backlink" href="#/funds">← all funds</a>
    <h2 style="margin-top:18px">${esc(fund.name)} — ${esc(fund.type)}, ${esc(fund.city)}</h2>
    <p class="tally">
      <b>${fund.listed}</b> listed on their site<span class="sep">|</span>
      <b>${fund.live}</b> look live<span class="sep">|</span>
      <b class="score-strong">${fund.raising}</b> showing a raise signal
    </p>
    <p class="note">
      Source: <a href="${esc(fund.portfolioUrl)}" target="_blank" rel="noopener" style="color:inherit">${esc(fund.portfolioUrl)}</a>.
      ${fund.listedCurrent
        ? 'This fund publishes which companies it still holds: ' + fund.listedCurrent + ' current, ' + fund.listedExited + ' exited.'
        : 'This fund does not publish which companies it still holds, so “live” here means the register still shows activity and no exit is known.'}
      ${fund.untracked ? ' ' + fund.untracked + ' of its companies have no French registry entry — mostly headquartered abroad — so they carry no round dates.' : ''}
    </p>
    <div class="filters">
      <button data-dim="fundSort" data-value="score" aria-pressed="${state.fundSort === 'score'}">By raise signal</button>
      <button data-dim="fundSort" data-value="lastRound" aria-pressed="${state.fundSort === 'lastRound'}">By last round</button>
      <button data-dim="fundSort" data-value="founded" aria-pressed="${state.fundSort === 'founded'}">By founding date</button>
      <button data-dim="fundSort" data-value="name" aria-pressed="${state.fundSort === 'name'}">A–Z</button>
      <button data-dim="includeGone" data-value="toggle" aria-pressed="${state.includeGone}">
        ${state.includeGone ? 'Showing exits and dormant' : 'Live portfolio only'}
      </button>
      <input id="fq" type="search" placeholder="Search this portfolio" aria-label="Search portfolio" value="${esc(state.fundQ)}">
    </div>
    <table>
      <thead><tr>
        <th class="right">Signal</th><th>Company</th><th>What it does</th><th class="hide-s">Country</th>
        <th class="right hide-s">Founded</th><th>Last round</th><th>Status</th>
      </tr></thead>
      <tbody id="frows"></tbody>
    </table>
    <p class="count" id="fcount"></p>`;

  renderFundRows(fund);
  $('#fq').addEventListener('input', (e) => { state.fundQ = e.target.value; renderFundRows(fund); });
}

function renderFundRows(fund) {
  const rows = fundRows(fund);
  $('#fcount').textContent = rows.length + ' of ' + DATA.companies.filter((c) => c.funds.includes(fund.id)).length + ' shown';
  $('#frows').innerHTML = rows.map((c) => `
    <tr class="co" data-key="${esc(c.key)}">
      <td class="right">${c.tracked ? scoreBar(c.score) : '<span class="dash">—</span>'}</td>
      <td><span class="nm">${esc(c.name)}</span></td>
      <td class="does">${c.blurb ? esc(clip(c.blurb, 130)) : '<span class="dash">—</span>'}</td>
      <td class="hide-s" style="font-size:13px">${dash(c.country)}</td>
      <td class="num right hide-s">${year(c.founded) || '<span class="dash">—</span>'}</td>
      <td class="num">${c.lastRound || '<span class="dash">—</span>'}</td>
      <td class="stamp s-${c.status}">${LABEL[c.status] || c.status}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="empty">Nothing matches.</td></tr>';
}

// ---------- interaction
document.addEventListener('click', (ev) => {
  const dealRow = ev.target.closest('.deal[data-deal]');
  if (dealRow) {
    const open = dealRow.nextElementSibling && dealRow.nextElementSibling.classList.contains('detail-inline');
    document.querySelectorAll('.detail-inline').forEach((d) => d.remove());
    if (!open) {
      const d = DATA.deals.find((x) => x.id === dealRow.dataset.deal);
      dealRow.insertAdjacentHTML('afterend', dealDetail(d));
    }
    return;
  }
  const row = ev.target.closest('.co');
  if (row) {
    const open = row.nextElementSibling && row.nextElementSibling.classList.contains('detail');
    document.querySelectorAll('.detail').forEach((d) => d.remove());
    if (!open) {
      const c = DATA.companies.find((x) => x.key === row.dataset.key);
      row.insertAdjacentHTML('afterend', detailRow(c, row.children.length));
    }
    return;
  }
  const btn = ev.target.closest('.filters button');
  if (!btn) return;
  if (btn.dataset.dim === 'includeGone') state.includeGone = !state.includeGone;
  else if (btn.dataset.dim === 'seriesAOnly') state.seriesAOnly = !state.seriesAOnly;
  else if (btn.dataset.dim === 'minScore') state.minScore = Number(btn.dataset.value);
  else state[btn.dataset.dim] = btn.dataset.value;
  route();
});

route();
