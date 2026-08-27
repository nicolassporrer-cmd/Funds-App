# Journal

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
