# Funds App — working notes

Read `README.md` first for what the app is. This file is the stuff that costs
time to rediscover.

## The rule that matters most here

**Never display a value that was not sourced, and never a value that means
something other than its label.** This app is one bad join away from producing a
complete, plausible, entirely fictional funding history for a real company.

Two live examples already in the code:

- Searching `Alan` on the entreprises API returns a **car dealership in Mougins**
  before the health insurer. The scorer in `resolve-sirens.cjs` exists for this.
  Verify a change to it against known names (Qonto 819489626, Alan 908901333,
  Ledger 529991119, Dataiku 791012081) before trusting a full run.
- `siege.date_creation` is when the **current head office** was registered, not
  when the company was founded — Qonto reads 2026. It is stored as `siegeSince`
  precisely so it can never be rendered as a founding year.

## Traps in the sources

- **BODACC `registre` holds the SIREN both spaced and unspaced.** Query with its
  own `search()`/quoted form, not a raw equality on digits, or half the rows vanish.
- **`listepersonnes` and `modificationsgenerales` are JSON encoded inside a
  string field.** They must be parsed, and they are sometimes absent.
- **Most capital increases are not rounds.** See the README. This is the single
  biggest source of false alerts.
- **Fund portfolio pages under-report.** Daphni renders 15 of its 74 companies,
  Elaia 6 of 231. Always check `sitemap.xml` before writing a page scraper.
- **Framer sites (Alven) have no DOM to scrape** — the content is a serialised JS
  array. The `framer-pairs` extractor matches the name/tagline pairing, which is
  what keeps it from picking up arbitrary capitalised strings.
- **Around 40% of holdings are not French** and will never resolve to a SIREN.
  That is expected. Report it as coverage, never as an error.

## Machine facts (this laptop)

- Clone to `C:\dev\<name>`, never inside OneDrive.
- Node lives at `C:\Program Files\nodejs` and is **not on PATH** for spawned
  shells: `export PATH="/c/Program Files/nodejs:$PATH"`.
- Node is Windows-native and **cannot resolve Git Bash paths like `/tmp`**. Pass
  it real Windows paths.
- Heredocs in the Bash tool eat backslashes — write `.cjs` files with the file
  writer, not `cat <<EOF`, or every regex escape is silently corrupted.
- No `gh` CLI, no Python. Use the GitHub REST API over curl.
- Pipeline scripts are `.cjs` and `package.json` has no `"type": "module"`, so
  plain `require` works. If Vite is ever added, that changes and every script
  must keep the `.cjs` extension in its `require()` calls.

## Conventions

- Each pipeline stage exports its core function and guards the runner with
  `if (require.main === module)`, so the logic can be exercised on a handful of
  names without a full run.
- A stage that produces suspiciously little **fails loudly** rather than writing a
  thin file. `fetch-portfolios.cjs` treats <5 companies as a broken adapter;
  `deploy.yml` refuses to publish a payload under 100 companies.
- Thresholds are named constants at the top of the file that uses them, never
  inline numbers.
