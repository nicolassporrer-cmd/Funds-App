// Portfolio extractors.
//
// Every fund publishes its portfolio differently, but the pages fall into three
// shapes, so these are generic extractors configured per fund in data/funds.json
// rather than ten bespoke scrapers. A fund that fits none of them gets a new
// extractor here, not a copy of an existing one.
//
// None of these can invent a company: if a page changes and an extractor stops
// matching, it returns an empty list and fetch-portfolios.cjs fails loudly for
// that fund. Silently shipping a shrunken portfolio would look exactly like a
// fund that exited half its companies.

// Tags become a space, never nothing: "<span>Back</span><span>Market</span>"
// must not collapse into "BackMarket".
function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleize(slug) {
  return slug
    .replace(/-\d+$/, '') // "360-learning-2" -> drop the duplicate-slug suffix
    .split('-')
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

// Words that appear as headings or link text on every VC site and are never
// portfolio companies.
const NOISE = new Set([
  'about', 'about us', 'team', 'news', 'contact', 'careers', 'jobs', 'portfolio',
  'companies', 'our portfolio', 'read more', 'learn more', 'see more', 'all',
  'home', 'blog', 'insights', 'press', 'legal', 'privacy', 'cookies', 'menu',
  'newsletter', 'follow us', 'get in touch', 'load more', 'filter', 'search',
  'exits', 'our team', 'our companies', 'view', 'discover', 'apply',
]);

const isNoise = (name) =>
  !name || name.length < 2 || name.length > 60 || NOISE.has(name.toLowerCase());

// --- Extractor 1: Next.js sites embed the whole portfolio as JSON in the page.
// Partech ships all 271 companies this way even though only 30 render at first.
function nextData(html, { arrayKey = null, nameField = 'name' } = {}) {
  const m = html.match(/id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  let root;
  try {
    root = JSON.parse(m[1]);
  } catch {
    return [];
  }

  let best = [];
  (function walk(node, depth) {
    if (depth > 8 || !node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value) && value.length > 3 && value[0] && typeof value[0] === 'object') {
        const looksRight = arrayKey ? key === arrayKey : nameField in value[0];
        if (looksRight && value.length > best.length) best = value;
      } else {
        walk(value, depth + 1);
      }
    }
  })(root, 0);

  return best
    .map((c) => ({
      name: String(c[nameField] ?? '').trim(),
      website: c.external_link || c.website || c.url || null,
      blurb:
        (c.short_text || c.description || '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300) || null,
    }))
    .filter((c) => !isNoise(c.name));
}

// --- Extractor 2: each company links to its own detail page.
function slugLinks(html, { prefix }) {
  if (!prefix) throw new Error('slug-links needs options.prefix');
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    '<a\\s[^>]*href="[^"]*' + escaped + '/([a-z0-9][a-z0-9-]{1,60})/?"[^>]*>([\\s\\S]{0,400}?)</a>',
    'gi'
  );
  const out = new Map();
  for (const match of html.matchAll(re)) {
    const slug = match[1];
    const label = textOf(match[2]);
    // Anchor text wins when it exists — "Back Market" beats a titleized slug —
    // but image-only cards have none, so the slug is the fallback, not the rule.
    const name = isNoise(label) ? titleize(slug) : label;
    if (!isNoise(name) && !out.has(slug)) {
      out.set(slug, { name, slug, website: null, blurb: null });
    }
  }
  return [...out.values()];
}

// --- Extractor 3: names sit in headings inside a card grid.
function headings(html, { levels = 'h2|h3|h4|h5' } = {}) {
  const re = new RegExp('<(' + levels + ')[^>]*>([\\s\\S]{0,200}?)</\\1>', 'gi');
  const out = new Map();
  for (const match of html.matchAll(re)) {
    const name = textOf(match[2]);
    if (!isNoise(name) && !out.has(name.toLowerCase())) {
      out.set(name.toLowerCase(), { name, website: null, blurb: null });
    }
  }
  return [...out.values()];
}

// --- Extractor 4: Framer sites (Alven) serialise the page into a JS array, so
// the names sit in the source as `"Qonto",{"type":81,"value":202},"tagline"`.
// The name/tagline pairing is what makes this safe: a stray capitalised string
// elsewhere on the page will not be followed by that exact type-value marker.
function framerPairs(html) {
  const re = /,"([A-Z][A-Za-z0-9 .&'’+-]{1,40})",\{"type":\d+,"value":\d+\},"([^"]{5,140})"/g;
  const out = new Map();
  for (const match of html.matchAll(re)) {
    const name = match[1].trim();
    if (!isNoise(name) && !out.has(name.toLowerCase())) {
      out.set(name.toLowerCase(), { name, website: null, blurb: match[2].trim() });
    }
  }
  return [...out.values()];
}

// --- Extractor 5: logo grids (ISAI) carry the company name only in the alt text
// of each logo image. Alt text is also the accessible name, so it is maintained.
function imgAlt(html, { minLength = 2 } = {}) {
  const out = new Map();
  for (const match of html.matchAll(/<img\s[^>]*alt="([^"]{2,60})"/gi)) {
    const name = textOf(match[1]);
    if (!isNoise(name) && name.length >= minLength && !out.has(name.toLowerCase())) {
      out.set(name.toLowerCase(), { name, website: null, blurb: null });
    }
  }
  return [...out.values()];
}

// --- Extractor 6: the sitemap.
//
// This is the best source when a fund offers it. A portfolio page lazy-loads,
// paginates and filters — Daphni renders 15 of its companies, Elaia 6 — but the
// sitemap lists every published company page with no JavaScript involved. Use it
// whenever the fund has one; fall back to scraping the rendered page only when
// it does not. The trade-off is that names come from URL slugs, so casing is
// approximate ("Ami Labs" for "AMI Labs") until SIREN resolution confirms them.
function sitemap(xml, { prefix }) {
  if (!prefix) throw new Error('sitemap needs options.prefix');
  const out = new Map();
  for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const url = match[1].trim();
    const idx = url.indexOf(prefix + '/');
    if (idx === -1) continue;
    const slug = url.slice(idx + prefix.length + 1).replace(/\/$/, '');
    if (!slug || slug.includes('/')) continue; // index page or a deeper path
    const name = titleize(slug);
    if (!isNoise(name) && !out.has(slug)) {
      out.set(slug, { name, slug, website: null, blurb: null });
    }
  }
  return [...out.values()];
}

const EXTRACTORS = {
  'next-data': nextData,
  'slug-links': slugLinks,
  headings,
  'framer-pairs': framerPairs,
  'img-alt': imgAlt,
  sitemap,
};

function extract(fund, html) {
  const fn = EXTRACTORS[fund.extractor];
  if (!fn) throw new Error(`${fund.id}: unknown extractor "${fund.extractor}"`);
  return fn(html, fund.options || {});
}

module.exports = { extract, textOf, titleize, isNoise, EXTRACTORS };
