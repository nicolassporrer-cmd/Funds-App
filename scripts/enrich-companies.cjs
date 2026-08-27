// Stage 1b — fetch each company's page on its fund's site.
//
// Seven of the ten funds publish nothing about a company on the portfolio index
// itself: no description, no website, no deal lead. All of that sits on the
// company's own page, which we already know the URL of because the index gave us
// the slug. Partech, Alven and Kima describe their companies inline, so they are
// skipped here.
//
// This is the expensive stage — roughly one request per company — so responses
// are cached on disk and a company already enriched is not re-fetched. Set
// REFRESH_ENRICHMENT=1 to force it.
//
// Output: rewrites data/portfolios.json in place with blurb / website / dealLead
// filled in where the fund published them.

const fs = require('fs');
const path = require('path');
const { get } = require('./lib/http.cjs');
const { textOf } = require('./lib/adapters.cjs');

const DATA = path.join(__dirname, '..', 'data');
const PORTFOLIOS = path.join(DATA, 'portfolios.json');

// A fund's own boilerplate, which otherwise gets scraped as every company's
// description.
const BOILERPLATE = /^(portfolio|companies|back to|all companies|next|previous|share|home)$/i;

function metaDescription(html) {
  const patterns = [
    /<meta[^>]+property="og:description"[^>]+content="([^"]{25,400})"/i,
    /<meta[^>]+name="description"[^>]+content="([^"]{25,400})"/i,
    /<meta[^>]+content="([^"]{25,400})"[^>]+name="description"/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const text = textOf(m[1]);
      if (text && !BOILERPLATE.test(text)) return text.slice(0, 400);
    }
  }
  return null;
}

// The company's own site, as linked from the fund's page. Skip the fund's own
// domain and the usual social links.
function outboundSite(html, fundHost) {
  const skip = new RegExp(`(${fundHost}|linkedin|twitter|x\\.com|facebook|instagram|youtube|crunchbase|google|mailto)`, 'i');
  for (const m of html.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"/gi)) {
    const url = m[1];
    if (!skip.test(url)) return url.split('?')[0];
  }
  return null;
}

// A deal lead, where the fund names one on the company page. Funds label this
// inconsistently, so match the label and take the name that follows it.
const LEAD_LABELS = /(deal\s*(?:team|lead)|investment\s*(?:team|lead|manager)|board\s*member|led\s*by|responsable|partner\s*in\s*charge)\s*[:\-–]?\s*([A-ZÉÈÀÂÎÔÛÇ][\wÀ-ÿ'’-]+(?:\s+[A-ZÉÈÀÂÎÔÛÇ][\wÀ-ÿ'’-]+){0,2})/;

function dealLead(html) {
  const text = textOf(html);
  const m = text.match(LEAD_LABELS);
  if (!m) return null;
  const name = m[2].trim();
  // Two or three capitalised words is a person; one word is usually a heading
  // that happened to follow the label.
  return name.split(/\s+/).length >= 2 ? name : null;
}

(async () => {
  const portfolios = JSON.parse(fs.readFileSync(PORTFOLIOS, 'utf8'));
  const force = process.env.REFRESH_ENRICHMENT === '1';
  let fetched = 0;
  let gainedBlurb = 0;
  let gainedSite = 0;
  let gainedLead = 0;
  let skipped = 0;

  for (const fund of portfolios.funds) {
    // Only funds whose companies have their own page, i.e. we captured a slug.
    const targets = fund.companies.filter(
      (c) => c.slug && (force || !c.blurb || !c.website)
    );
    if (!targets.length) {
      skipped += fund.companies.length;
      continue;
    }

    const base = new URL(fund.portfolioUrl);
    const prefix = fund.options?.prefix || '/portfolio';
    process.stdout.write(`${fund.id.padEnd(12)} ${targets.length} pages `);

    for (const company of targets) {
      const url = `${base.origin}${prefix}/${company.slug}/`;
      try {
        const html = await get(url, {
          minGapMs: 700, // gentler than the index: this is many requests to one host
          cacheKey: `company-${fund.id}-${company.slug}.html`,
        });
        fetched++;
        const blurb = metaDescription(html);
        const site = outboundSite(html, base.host.replace(/^www\./, ''));
        const lead = dealLead(html);
        if (blurb && !company.blurb) { company.blurb = blurb; gainedBlurb++; }
        if (site && !company.website) { company.website = site; gainedSite++; }
        if (lead) { company.dealLead = lead; gainedLead++; }
      } catch {
        // A dead company page is normal — funds do not always keep them — and is
        // not worth failing a refresh over.
      }
    }
    console.log(`done`);
  }

  // Drop the fund's own tagline.
  //
  // When a company page carries no og:description of its own, the CMS falls back
  // to the site-wide one, so ISAI's "Your VC should work for you, not the other
  // way around" was landing on Pelico and wecasa as their business description.
  // A description that repeats across a fund's companies is the fund talking
  // about itself, and a wrong description is worse than none.
  let boilerplate = 0;
  for (const fund of portfolios.funds) {
    const seen = new Map();
    for (const company of fund.companies) {
      if (!company.blurb) continue;
      const key = company.blurb.toLowerCase().slice(0, 120);
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    const repeated = new Set([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k));
    for (const company of fund.companies) {
      if (company.blurb && repeated.has(company.blurb.toLowerCase().slice(0, 120))) {
        company.blurb = null;
        boilerplate++;
      }
    }
  }
  if (boilerplate) console.log(`dropped ${boilerplate} descriptions that were the fund's own boilerplate`);

  fs.writeFileSync(PORTFOLIOS, JSON.stringify(portfolios, null, 2));

  const all = portfolios.funds.flatMap((f) => f.companies);
  console.log(`\nfetched ${fetched} company pages (${skipped} skipped: fund describes them inline)`);
  console.log(`  descriptions gained ${gainedBlurb} -> ${all.filter((c) => c.blurb).length}/${all.length} have one`);
  console.log(`  websites gained     ${gainedSite} -> ${all.filter((c) => c.website).length}/${all.length}`);
  console.log(`  deal leads found    ${gainedLead} -> ${all.filter((c) => c.dealLead).length}/${all.length}`);
  if (!gainedLead) {
    console.log('  (no fund in this set names a deal lead on its company pages — the curated');
    console.log('   contacts in data/contacts.json are the only source for that column)');
  }
})();
