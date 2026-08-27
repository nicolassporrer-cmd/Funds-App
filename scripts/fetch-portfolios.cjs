// Stage 1 — read each fund's public portfolio page and list the companies it holds.
//
// Output: data/portfolios.json (gitignored intermediate)
//
// A fund whose page yields zero companies is reported as FAILED, not as a fund
// with an empty portfolio. Scrapers rot silently when a site is redesigned, and
// an empty result here would otherwise propagate as "this fund exited everything".

const fs = require('fs');
const path = require('path');
const { get } = require('./lib/http.cjs');
const { extract } = require('./lib/adapters.cjs');

const DATA = path.join(__dirname, '..', 'data');
const { funds } = JSON.parse(fs.readFileSync(path.join(DATA, 'funds.json'), 'utf8'));

// Below this, assume the page changed rather than that the fund is tiny. Kima is
// the smallest plausible real portfolio and still holds hundreds of names.
const MIN_EXPECTED = 5;

(async () => {
  const results = [];
  const failures = [];

  for (const fund of funds) {
    process.stdout.write(`${fund.id.padEnd(12)} `);
    try {
      // Prefer sourceUrl when the fund has one: it points at a sitemap or JSON
      // endpoint that lists the whole portfolio, while portfolioUrl is the human
      // page that lazy-loads only the first screenful.
      const html = await get(fund.sourceUrl || fund.portfolioUrl, {
        minGapMs: 1500, // one fund page every 1.5s — we are a guest on their site
        cacheKey: `portfolio-${fund.id}.html`,
      });
      const companies = extract(fund, html);
      if (companies.length < MIN_EXPECTED) {
        failures.push(`${fund.id}: extractor "${fund.extractor}" found ${companies.length} companies in ${html.length} bytes`);
        console.log(`FAILED  ${companies.length} companies (page was ${html.length} bytes)`);
        continue;
      }
      results.push({ ...fund, companies, fetchedAt: new Date().toISOString() });
      console.log(`ok      ${companies.length} companies`);
    } catch (err) {
      failures.push(`${fund.id}: ${err.message}`);
      console.log(`ERROR   ${err.message}`);
    }
  }

  const total = results.reduce((n, f) => n + f.companies.length, 0);
  const unique = new Set(results.flatMap((f) => f.companies.map((c) => c.name.toLowerCase()))).size;

  fs.writeFileSync(
    path.join(DATA, 'portfolios.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), funds: results, failures }, null, 2)
  );

  console.log(`\n${results.length}/${funds.length} funds, ${total} holdings, ${unique} distinct companies`);
  if (failures.length) {
    console.log(`\n${failures.length} fund(s) need an adapter fix:`);
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  // Exit non-zero only if EVERY fund failed — one broken site should not block a
  // refresh of the other nine.
  if (!results.length) {
    console.error('\nNo fund produced any companies. Refusing to write an empty dataset.');
    process.exit(1);
  }
})();
