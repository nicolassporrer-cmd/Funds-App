# Funds App — Project Context

## What this is
Ranks companies in ten Paris VC portfolios by how likely they are to be raising
in the coming months, read from the French commercial register — which records
capital and board changes whether or not anyone announces them. For Nicolas,
for origination.

Built on:
- **Data layer** — committed JSON in `data/`. No database, no server.
- **Pipeline** — plain Node `.cjs` scripts, keyless open data (BODACC, recherche-entreprises.api.gouv.fr, fund websites)
- **Frontend** — one static HTML file with the payload inlined, built by `scripts/build-site.cjs`. No framework, no build step.

**Deployment URL:** https://nicolassporrer-cmd.github.io/Funds-App/

---

## Working with Nicolas

- Keep responses concise — no verbose summaries or narration of what you just did
- He is not an engineer but reads results closely and asks precise questions — give the real number and the honest limitation, never a reassuring summary
- QA checklists after deploying must be **numbered prescriptive steps organized by Part** (Part 1: Feature works, Part 2: Data layer, Part 3: Edge cases, Part 4: Regressions) — never bullet circles

---

## Files in this repo

| File | Purpose |
|------|---------|
| `CLAUDE.md` | This file — project bible |
| `BACKLOG.md` | Prioritized feature backlog |
| `JOURNAL.md` | Append-only build log — why the app is the way it is (rebuild spec) |
| `.claude/commands/plan.md` | `/plan` slash command |
| `.claude/commands/feature.md` | `/feature` slash command |
| `.claude/commands/qa.md` | `/qa` slash command |
| `.claude/commands/sync.md` | `/sync` slash command |
| `.claude/commands/improve-prompt.md` | `/improve-prompt` slash command |
| `plans/` | Agreed design per feature — tracked, part of the rebuild spec |
| `scripts/*.cjs` | The pipeline, one file per stage — see README |
| `data/funds.json` | Hand-curated fund list; the pipeline never rewrites it |
| `data/contacts.json` | Hand-curated fund contacts; read-only to the pipeline |

---

## Development workflow

**Design before building** — complete all requirements discussion and get explicit agreement before writing any files. This includes tooling and workflow changes.

**Mockup first** — if UI changes are involved, use the Preview tool during `/plan` to render mockups. Iterate until all states (default, loading, empty, error, edge cases) are agreed before writing code. Iterate on the mock many times; deploy once for QA sign-off.

**Lifecycle:** `/plan` → `/feature` → `/qa` → `/sync`

- `/feature` automatically calls `/qa` after deploying — do not skip
- `/sync` is the session closer: commits, pushes, updates docs. Run after any session that touched tracked files

**Branch rules:**
- Feature work: create `feature/<slug>` before any changes; never work directly on `main`
- Config/doc updates (CLAUDE.md, BACKLOG.md, etc.): work directly on `main`
- After QA passes: `/sync` merges to `main`, pushes, deletes the branch
- Merge conflict: stop, explain what's conflicting, show both versions, ask how to resolve

---

## Building conventions

1. **No gold-plating.** Don't add features, refactor, or introduce abstractions beyond what the task requires. Three similar lines beats a premature abstraction.
2. **No unnecessary error handling.** Only validate at system boundaries (user input, external APIs). Trust internal code and framework guarantees.
3. **No explanatory comments.** Only add a comment when the *why* is non-obvious — a hidden constraint, a subtle invariant, a platform workaround. Well-named identifiers are self-documenting.
4. **Extend, never replace.** New fields, columns, and endpoints must be additive. Never remove or rename something that existing data or callers depend on.
5. **Normalize at the boundary.** Convert external data (API responses, Sheet values, file contents) to your internal format at the point of entry. Downstream code never deals with the source format.
6. **Optimistic update + undo.** For write actions, update the UI immediately. Keep the item visible in a faded/muted state until the write confirms. Provide an undo path.
7. **Graceful degradation.** Missing data renders a sensible empty/default state, not a broken component. Check before accessing; never assume a field exists.
8. **No hardcoded credentials.** Secrets go in `.env` (gitignored), environment variables, or a secrets manager. Never commit them.
9. **Abstract platform constraints.** Work around platform limitations in one place and document the reason in Known Gotchas — don't scatter workarounds across the codebase.

---

## Data integrity rules

1. **Upsert, never overwrite.** All writes use upsert-by-key: add new rows, update existing rows in-place, delete only rows whose keys are explicitly absent from the incoming data. Never clear and rewrite a collection unconditionally.
2. **Empty array = no-op.** Sending `[]` for a list field must leave all existing rows untouched. Only a non-empty array triggers the upsert.
3. **Blank payload value ≠ clear.** Blank or missing fields in an incoming payload must never overwrite existing non-blank values in the data store.
4. **Idempotent writes.** Running the same import twice produces the same result. Server-side dedup (by natural key) prevents duplicates without error — a re-run is always safe.
5. **Flag-and-skip deduplication.** Items that look like duplicates get a `possible_duplicate: true` flag and are skipped at import time — not silently dropped. The import summary lists all skipped items.
6. **Dry-run on destructive scripts.** Any script that deletes rows, clears a collection, or rewrites data in bulk must support a `--dry-run` flag that previews changes without committing them.

---

## Deployment

Push to `main`. `.github/workflows/deploy.yml` builds and publishes to GitHub Pages.
`daily-refresh.yml` re-runs the pipeline at 06:40 UTC and calls deploy itself — a
push made with GITHUB_TOKEN does not trigger other workflows.

```bash
npm run refresh && npm run build
```

After deploying: tell the user what to do (e.g., "Hit Ctrl+Shift+R to see changes.") and share a numbered QA checklist covering the changed behavior.

**What deploy does:**
1. Checks out `ref: main` (never the triggering SHA, or a refresh publishes stale data)
2. Runs `scripts/build-site.cjs`
3. Fails the run if the payload holds under 100 companies, then uploads `dist/`

---

## Data layer

See the pipeline table in README.md. Every stage writes a file the next one reads;
`data/payload.json` is the only file the site loads.

---

## API

None — the site is static. The pipeline consumes three external sources, all keyless:

| Source | Used for |
|--------|----------|
| `bodacc-datadila.opendatasoft.com` | register announcements, dated, with share capital |
| `recherche-entreprises.api.gouv.fr` | name → SIREN, officers, filed accounts, headcount |
| fund websites | portfolio membership, descriptions, holding status |

---

## Known gotchas

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

- **Don't let a background agent delegate a bounded data-fetch task to further sub-agents.** Dispatching a general-purpose background agent for a well-defined, bounded pull (e.g., "fetch all X from API Y") risks a runaway sub-agent chain if the agent misreads its own tool-call results, wrongly concludes there's a platform bug, and spawns further agents to "verify." Those sub-agents often can't be force-killed by anyone except their direct parent — `TaskStop` can fail with an ownership restriction, leaving `SendMessage` (asking it to stop) as the only lever, with no guaranteed hard stop. Fix: do bounded, well-understood API pulls directly in the main session rather than delegating them. Reserve background agents for genuinely independent work where a single agent completes its own task without needing to spawn children — e.g., "scan this Slack workspace for a date range" or "scan this inbox," not "resolve this entire relational data tree across N interlinked API calls."
  - **If delegation is still the right call** (the task is large but genuinely bounded and independent), explicitly forbid nested spawning in the prompt: *"Do NOT spawn any sub-agents or delegate any part of this to another agent — do all the work yourself directly. If you're ever unsure whether a result looks right, just note the uncertainty in your final reply — do not launch a 'verification' sub-agent."* Confirmed effective in practice after a second occurrence of the exact runaway-chain failure above — the agent that received this instruction completed a large bounded task cleanly, while a sibling agent given the same class of task without it tried to spawn a nested agent instead of doing the work.
- **Never batch two read calls to the same MCP server in one message — their results can clobber each other.** When two reads to the same MCP server are issued in a single assistant turn, both tool results may come back identical (typically whichever query resolved last), silently returning the wrong data for one of them. This is not limited to two calls of the *same* tool — two *different* read tools on the same server (e.g. a "search" and a "get-by-id") can collide too. Fix: sequence reads to the same server one message at a time. Reads to *different* servers, or a read against a non-MCP tool, can still run in parallel safely.
- **For very high-volume gather work, delegate to parallel sub-agents that each write structured JSON to disk, then assemble with a script.** When a task requires ingesting far more source material than fits comfortably in one context (many documents/transcripts, a multi-day multi-source scan), reading it all inline guarantees a mid-task context compaction and the silent quality loss that comes with it. Instead: give every worker a shared spec file + a shared context file (both on disk), have each write its *full* extraction to its own `scratchpad/*.json` and return only a short summary, then merge all the JSON files into the final artifact with a deterministic script (normalization tables, dedup, ID assignment, stat computation). This is more compaction-safe than inline reading because the structured outputs persist on disk independent of the orchestrator's context. Caveat: the orchestrator never personally reads the raw source, so any "re-read the source yourself before finalizing" gate is satisfied by the on-disk extractions, not raw-file reads — disclose that trade-off. Pair this with the no-nested-spawning instruction above.
- **A tool installed mid-session stays invisible until Claude Code is restarted.** Installing Node, `gh`, or anything else that registers itself on PATH updates the *system* PATH, but the running Claude Code process keeps the environment it inherited at launch — so every shell it spawns still reports `command not found`, no matter how many new shells are opened inside the session. The install is fine; the session is stale. Fix: quit and reopen Claude Code after installing a tool. To confirm the install really did land before restarting, check the binary directly (`Test-Path "C:\Program Files\nodejs\node.exe"`) rather than trusting `node --version`, and if a command genuinely must run before the restart, invoke it by absolute path.
