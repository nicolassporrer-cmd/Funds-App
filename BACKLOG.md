# Backlog

## Known limitations to close

- **Alven yields 30 companies, not its full portfolio.** The Framer page ships
  only the first screenful into the serialised array; the rest loads on scroll.
  Look for a Framer CMS endpoint, or fall back to their sitemap.
- **Round detection has never been scored against ground truth.** Pick 20 Paris
  rounds with known dates (from press coverage) and measure how many the
  10% / 2,000 EUR thresholds catch, and how many employee-equity rejections were
  actually rounds. Tune `ROUND_MIN_GROWTH` from that, not from intuition.
- **Medium-confidence SIREN matches are shown with a `?` but never audited.**
  162 of 1,082. Spot-check 20 and either tighten the scorer or accept them.
- **`no-signal` companies are invisible in the alert flow.** Some are foreign
  subsidiaries, some file abroad, some genuinely never registered an increase.
  Separate those cases instead of lumping them.
- **Exits are not detected.** A fund's portfolio page keeps acquired companies
  for years. BODACC publishes "Ventes et cessions" — use it to mark exits rather
  than alerting that an acquired company is overdue to raise.

## Next features

- **Per-fund view.** A fund's page: holdings, the cadence it invests at, which of
  its companies are due.
- **Email or push when a company crosses into `overdue`.** The daily refresh
  already knows the diff; nothing surfaces it.
- **Widen beyond Paris** once the ten adapters are stable — Lyon, Marseille,
  then London/Berlin funds with French holdings.
- **Company detail: capital curve over time.** The data is already in
  `events.json`; it just is not plotted. Validate any palette with the dataviz
  validator, do not eyeball it.
- **Track fund vintages / fund size** from AMF filings, so "who is due" can be
  weighed against "who has dry powder".

## Deliberately not doing

- **Estimating round size from the capital delta.** The relationship between
  nominal capital and the cheque is not fixed. A number here would look
  authoritative and be wrong, which is worse than a dash.
- **Paying for Crunchbase / Dealroom** before the free spine proves useful.
