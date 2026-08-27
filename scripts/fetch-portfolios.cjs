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
const { extract, pagedSlugs } = require('./lib/adapters.cjs');

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

      // A fund's portfolio page is a history, not an inventory: Partech tags 63
      // of its 271 companies "Alumni". Where the fund publishes that distinction
      // on separate archive pages, fold it back in here.
      let kept = companies;
      if (fund.statusPages) {
        for (const source of fund.statusPages) {
          const slugs = await pagedSlugs(get, source.url, source.prefix);
          let applied = 0;
          for (const company of companies) {
            if (company.slug && slugs.has(company.slug)) {
              company.holding = source.holding;
              applied++;
            }
          }
          console.log(`\n  ${source.holding}: ${slugs.size} listed, ${applied} matched`);
        }

        // Elaia files press releases and blog posts under the same WordPress
        // post type as its companies, so its sitemap yields 231 "companies" —
        // including "Mirakl Raises 300m..." and four copies of "Testing Mosaic
        // For Elaia". The status taxonomy only ever tags real holdings, so on a
        // fund that publishes one, an untagged entry is not a company.
        if (fund.requireStatus) {
          const before = kept.length;
          kept = companies.filter((c) => c.holding && c.holding !== 'unknown');
          console.log(`  requireStatus: dropped ${before - kept.length} untagged entries (press posts, tests)`);
        }
        process.stdout.write(`${''.padEnd(13)}`);
      }
      const companiesOut = kept;

      if (companiesOut.length < MIN_EXPECTED) {
        failures.push(`${fund.id}: extractor "${fund.extractor}" found ${companiesOut.length} companies in ${html.length} bytes`);
        console.log(`FAILED  ${companiesOut.length} companies (page was ${html.length} bytes)`);
        continue;
      }
      results.push({ ...fund, companies: companiesOut, fetchedAt: new Date().toISOString() });
      console.log(`ok      ${companiesOut.length} companies`);
    } catch (err) {
      failures.push(`${fund.id}: ${err.message}`);
      console.log(`ERROR   ${err.message}`);
    }
  }

  const total = results.reduce((n, f) => n + f.companies.length, 0);
  const unique = new Set(results.flatMap((f) => f.companies.map((c) => c.name.toLowerCase()))).size;
  const holdings = results
    .flatMap((f) => f.companies)
    .reduce((acc, c) => ({ ...acc, [c.holding || 'unknown']: (acc[c.holding || 'unknown'] || 0) + 1 }), {});

  fs.writeFileSync(
    path.join(DATA, 'portfolios.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), funds: results, failures }, null, 2)
  );

  console.log(`\n${results.length}/${funds.length} funds, ${total} holdings, ${unique} distinct companies`);
  console.log(
    `Holding status as published by the funds: ` +
      Object.entries(holdings).map(([k, v]) => `${k}=${v}`).join(' ')
  );
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
