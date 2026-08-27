# Funds App — Build Journal

Append-only record of how this app got built. **Newest entry at the top. Never edit or delete a past entry** — if something turned out wrong, add a new entry saying so.

## What this file is for

`CLAUDE.md` says what the app **is now**. This file says **why it is that way**, so the app can be rebuilt clean from scratch without re-walking any dead end.

Together they are the rebuild spec:
- `CLAUDE.md` → the target (stack, schema, API, deploy)
- `JOURNAL.md` → the traps (what we tried, what broke, what we rejected and why)
- `plans/<slug>.md` → the agreed design for each feature, as of the day it was built

A future rebuild reads `CLAUDE.md` to know what to build, then skims this file to know what not to try.

## How to write an entry

Written by `/sync` at the end of every session that changed behaviour. One entry per shipped change. Keep **Rejected** and **Gotchas** honest and specific — they are the two fields that make a rebuild cheaper, and the two most often left vague.

---

## Entries

## 2026-08-27 (later) — core feature changed: from "who is overdue" to "who is about to raise"

"Overdue" was the weak version of this app: last-round date minus a cycle is
arithmetic anyone can do from a PitchBook export. The register's actual edge is
that it records capital and board changes **whether or not anyone announces
them**, which is where bridges, extensions and internal rounds live.

The main view is now a raise-signal score, every component shipped and shown so
the ranking can be argued with:

| Signal | Weight | Live count |
| --- | --- | --- |
| Cycle position | 40 | — |
| Bridge (2–10% capital rise since last round) | 22 | 168 |
| Governance change in 18 months | 16 | 302 |
| Statutory auditor on the books | 8 | — |
| Investment vehicle as corporate officer | 6 | 339 |

89 companies score 60+, 171 moderate. Top of the list: Shippeo, BeReal,
360learning, Le Collectionist, Pubstack — all real, all plausible.

### Things the data disproved along the way

- **`dirigeants` carries more than expected.** I had told Nicolas investor
  identity was unavailable. It is partly available: Qonto lists VALAR GLOBAL
  PRINCIPALS FUND III LP as a corporate officer, Shippeo lists PARTECH PARTNERS.
  Board representation, not a cap table — no shareholder register is public for
  an SAS — and labelled that way everywhere.
- **BODACC does not label auditor appointments or statute changes.** The only
  categories it publishes are capital, administration, address, denomination,
  legal form, representative, activity. So the forward signal is `administration`
  (~2,400 occurrences), not the auditor events I had assumed.
- **Elaia's sitemap is not a portfolio.** It files press releases and blog posts
  under the same WordPress type as companies, so 231 "companies" included
  "Mirakl Raises 300m…" and four copies of "Testing Mosaic For Elaia". Its status
  taxonomy only tags real holdings, so untagged entries are now dropped: 130 real
  companies, 57 exited, 74 current.
- **Fund taglines were being scraped as company descriptions.** Where a company
  page has no og:description the CMS serves the site-wide one, so ISAI's "Your VC
  should work for you, not the other way around" landed on Pelico and wecasa as
  their business model. Any description repeating across a fund's companies is
  now dropped — 112 of them.
- **A cached SIREN entry kept a stale description** after that fix, because the
  cache only refreshed identity fields. Everything sourced from the fund's own
  page is now refreshed every run; only the SIREN lookup is cached.
- **One event was getting two contradictory labels** — "reads as a bridge" in the
  signal, "too small for a round, reads as option exercises" in the register
  history. Bridges now have their own verdict in the classifier and the score
  trusts it rather than re-deriving the band.

### Still unvalidated

The score reflects judgement about what precedes a raise, not a measured result.
Shippeo shows 3% capital bumps in 2022 and 2023 as well as 2026 — those may be
option-pool increases rather than bridges, which would mean the 2% floor is too
low. See BACKLOG: the press-coverage test is the way to settle it.

## 2026-08-27 — Day one: spine built, ten Paris funds live

Started the app. The question that decided the whole design was asked before any
code: **where does round timing actually come from?**

Tested the free sources live rather than assuming:

- `recherche-entreprises.api.gouv.fr` — works, keyless, name → SIREN.
- **BODACC via DILA** — works, keyless, 395k+ announcements, queryable by SIREN,
  and each carries the share capital after the change. Ledger returned 56
  announcements, Qonto 35.

That established what is knowable. It also immediately exposed the trap: Ledger's
last four capital increases were **+13.7k, +4.6k, +3.9k EUR** against a 1.6M
base. Those are BSPCE exercises, not rounds. Any naive "capital rose" alert fires
constantly and is worthless. The classifier is built around that fact.

Confirmed the hard limit and wrote it into the UI rather than working around it:
**round amounts are not published**, because the money sits in the prime
d'émission. The app dates rounds and refuses to size them.

### Portfolio extraction

First pass got 7/10 funds and 1,554 holdings. Three failed and two badly
under-reported. The fix was not better HTML parsing — it was noticing that
**rendered portfolio pages lazy-load while sitemaps do not**:

| Fund | First attempt | After |
| --- | --- | --- |
| Daphni | 15 | 74 (sitemap) |
| Elaia | 6 | 231 (sitemap) |
| Serena | 404 | 112 (sitemap) |
| Alven | 0 | 30 (Framer serialised array) |
| ISAI | 0 | 121 (logo `alt` text) |

Final: **10/10 funds, 2,101 holdings, 1,937 distinct companies.**

### SIREN resolution

1,082 of 1,934 names resolved to a usable SIREN (920 high confidence, 162
medium). The rest are overwhelmingly non-French holdings — Partech and Kima
invest globally — which is coverage, not failure.

The scorer was tested against known traps before the full run. Searching `Alan`
returns a car dealership in Mougins ahead of the health insurer; scoring on
Île-de-France + active + tech NAF picks the right one. `Back Market` scored low
and was correctly dropped rather than matched to the German GmbH. `Stripe`
returned no French match, correctly.

Caught one mislabel: `siege.date_creation` is when the current head office was
registered, not the founding year — Qonto reads 2026. Renamed to `siegeSince` so
it can never be rendered as a founding date.

### Notes

- Bash-tool heredocs silently ate backslashes and corrupted every regex escape in
  the first `adapters.cjs`. Wrote `.cjs` files with the file writer after that.
- No secrets needed anywhere in this app — every source is keyless open data.
