# Funds App

Which companies in ten Paris venture portfolios are showing signs of raising
again — read from the official French commercial register, which records capital
and board changes whether or not anyone announces them.

Live: https://nicolassporrer-cmd.github.io/Funds-App/

## The point

Crunchbase, Dealroom and PitchBook are announcement-driven: a round enters them
when someone tells them. BODACC is filing-driven: the capital increase is
registered because the law requires it. The gap between those two is what this
app is for — bridges, extensions, internal rounds and quiet recaps that never get
a press release, and which are precisely the companies that raise properly next.

The main view ranks companies by a **raise signal** built from what the register
shows right now, not by how overdue they are. Every component of the score is
shipped with the company and shown on the page, because a ranking you cannot
argue with is a ranking you should not trust.

| Signal | Weight | What it is |
| --- | --- | --- |
| Cycle position | 40 | Where the company sits against its own measured raising cycle |
| Bridge | 22 | A capital increase since the last round of 2–10% — too big for options, too small for a priced round |
| Governance change | 16 | A board or officer change in the last 18 months; an incoming investor's seat looks like this |
| Statutory auditor | 8 | A *commissaire aux comptes* on the books, usual at institutional rounds |
| Investor as officer | 6 | An investment vehicle sitting as a corporate officer (Qonto lists Valar Global Principals Fund III) |
| Headcount | 8 | Large enough to be burning capital on a schedule |
| Still filing | 10 | Recent register activity, so the signal concerns a live company |

Tuned for **recall**: a company approaching its cycle appears with no other
evidence, so the bottom of the list is leads, not conclusions.

## What it does and does not know

The register is a legal publication, not a funding database. That shapes
everything:

| Question | Answer |
| --- | --- |
| Which companies does a fund hold? | From the fund's own portfolio page or sitemap |
| When did a company last raise? | From BODACC — dated, official |
| How much did they raise? | **Not available.** See below |
| Seed / Series A / B? | **Not available** — not a legal concept. Stage is shown as evidence (headcount, capital, prior rounds, last filed accounts) instead of a label |
| Which investor joined that round? | **Not available.** What is available: corporate officers, which sometimes includes an investment vehicle, plus which funds list the company |
| Who is the cap table? | **Not available.** No shareholder register is public for a French SAS |
| Who is the contact at the fund? | **Not in any open source** — that is what `data/contacts.json` is for |

**Why no amounts.** In a French SAS the money lands almost entirely in the
*prime d'émission* (share premium), which is never published. Only the nominal
share capital moves, and that step bears no fixed relationship to the cheque. The
app dates rounds. It never sizes them, and it never estimates a size.

**The noise problem.** French companies register capital increases constantly.
Ledger's last four were +13.7k, +4.6k and +3.9k euros against a 1.6M base —
employees exercising BSPCE, published in exactly the same form as a Series C. A
"capital went up" rule fires every few weeks on every company. The pipeline keeps
an increase only when it is at least 10% of existing capital *and* at least
2,000 EUR, or when it comes bundled with governance changes. Both thresholds are
named constants at the top of `scripts/classify-rounds.cjs`.

## Pipeline

Every stage writes a file the next one reads. Run them in order, or `npm run refresh`.

| Step | Script | Writes | Tracked |
| --- | --- | --- | --- |
| 1 | `fetch-portfolios.cjs` | `data/portfolios.json` | no |
| 1b | `enrich-companies.cjs` | (fills in `portfolios.json`) | no |
| 2 | `resolve-sirens.cjs` | `data/siren-map.json` | **yes** |
| 3 | `fetch-events.cjs` | `data/events.json` | no |
| 4 | `classify-rounds.cjs` | `data/rounds.json` | no |
| 4b | `score-prospects.cjs` | `data/prospects.json` | no |
| 5 | `build-payload.cjs` | `data/payload.json` | **yes** |
| — | `build-site.cjs` | `dist/index.html` | no |

`data/contacts.json` is yours: hand-entered fund contacts, read but never written
by the pipeline. No open dataset maps a partner to a portfolio company, so the
page marks these values as curated and keeps them visually apart from sourced
data.

`data/funds.json` is the hand-curated fund list and is never rewritten by the
pipeline. `data/siren-map.json` is tracked because it costs ~2,000 API calls to
rebuild and holds manual corrections: set `"manual": true` on an entry and the
pipeline will never overwrite it.

## Sources

All keyless, no account, no quota:

- **Fund portfolio pages** — each fund's own site. Six extractor shapes cover the
  ten funds (`scripts/lib/adapters.cjs`); prefer a fund's sitemap when it has one,
  because rendered portfolio pages lazy-load and under-report.
- **`recherche-entreprises.api.gouv.fr`** — company name to SIREN. Matches are
  scored (exact name, Île-de-France, active, tech NAF); anything below medium
  confidence is dropped rather than guessed.
- **BODACC via DILA open data** — official register announcements with the share
  capital after each change.

## Local development

Node is at `C:\Program Files\nodejs` and is not on PATH for spawned shells:

```bash
export PATH="/c/Program Files/nodejs:$PATH"
```

Re-running an adapter without re-hitting a fund's website:

```bash
USE_CACHE=1 node scripts/fetch-portfolios.cjs
```

## Adding a fund

Add an entry to `data/funds.json` with `portfolioUrl`, an `extractor`, and its
`options`. Check the fund's `sitemap.xml` first — if it lists company pages, use
the `sitemap` extractor and set `sourceUrl`. If the page yields fewer than five
companies the run reports that fund as FAILED rather than shipping an empty
portfolio, because a fund that suddenly holds nothing is indistinguishable from a
broken scraper.
