// Stage 7 — what each fund has been doing lately.
//
// Four things, from four sources, none of them a guess:
//
//   Deals      rounds in the deal log attributed to the fund, by quarter.
//   Fund raises the fund's OWN vehicles filing Form D with the SEC. A fund
//              raising Fund XIII from its LPs files exactly like a company
//              raising a round, and states the amount. This is the closest
//              sourced thing to dry powder there is.
//   Portfolio  insolvencies, deregistrations and business transfers recorded
//   trouble    against its French portfolio companies in BODACC.
//   Press      Google News headlines for the firm, with publisher and date.
//
// DRY POWDER IS NOT PUBLISHED ANYWHERE. Uncalled capital is private between a
// fund and its LPs. This stage never computes one: it shows when a fund last
// closed a vehicle and how fast it has been deploying, and leaves the reading to
// whoever looks at it.
//
// Output: data/fund-activity.json — TRACKED.

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const RAW_FORMD = path.join(DATA, 'raw', 'formd-bulk');
const OUT = path.join(DATA, 'fund-activity.json');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));

const NEWS_RECHECK_HOURS = 20;
const NEWS_ITEMS = 6;
const QUARTERS_SHOWN = 12;

const truthy = (v) => /^(true|y|yes)$/i.test(String(v || '').trim());
const quarterOf = (d) => `${d.slice(0, 4)} Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;

function readTsv(file) {
  const [head, ...rows] = fs.readFileSync(file, 'utf8').split('\n');
  const cols = head.split('\t').map((s) => s.trim());
  return rows.filter(Boolean).map((r) => {
    const cells = r.split('\t');
    return Object.fromEntries(cols.map((c, i) => [c, (cells[i] || '').trim()]));
  });
}

// A fund's vehicles are named after the firm: "Insight Partners XIII, L.P.",
// "RRE Ventures VIII, L.P.", "Partech Venture FPCI".
//
// Matching on the firm name alone is not safe. "Serena Ventures" is Serena
// Williams' fund in Washington DC, nothing to do with Serena in Paris, and it
// files Form D too. So a Paris firm's vehicle must also be filed from France.
function vehicleMatcher(fund) {
  const alias = fund.vehicleAlias ? new RegExp(fund.vehicleAlias, 'i') : new RegExp('^' + fund.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return (issuer) => {
    if (!alias.test(issuer.ENTITYNAME || '')) return false;
    if (fund.region === 'Paris') return /FRANCE/i.test(issuer.STATEORCOUNTRYDESCRIPTION || '') || issuer.STATEORCOUNTRY === 'I0';
    return true;
  };
}

function fundVehicles(funds) {
  const matchers = funds.map((f) => [f, vehicleMatcher(f)]);
  const found = new Map(funds.map((f) => [f.id, new Map()]));
  if (!fs.existsSync(RAW_FORMD)) return found;

  for (const quarter of fs.readdirSync(RAW_FORMD)) {
    const dir = path.join(RAW_FORMD, quarter);
    if (!fs.statSync(dir).isDirectory()) continue;
    const find = (name) => {
      const stack = [dir];
      while (stack.length) {
        const d = stack.pop();
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) stack.push(p);
          else if (e.name === name) return p;
        }
      }
      return null;
    };
    const issuersFile = find('ISSUERS.tsv');
    const offeringFile = find('OFFERING.tsv');
    if (!issuersFile || !offeringFile) continue;

    const offering = new Map(readTsv(offeringFile).map((r) => [r.ACCESSIONNUMBER, r]));
    // Many fund vehicles state no date of first sale — they have filed but drawn
    // nothing yet. Bessemer's vehicles look exactly like this, and requiring a
    // sale date dropped every one of them. The filing date always exists.
    const submissionFile = find('FORMDSUBMISSION.tsv');
    // SEC writes filing dates as "29-MAR-2022" here, while every other date in
    // this project is ISO. Mixing the two sorted "29-MAR-2022" above "2026-01-21".
    const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
    const isoDate = (s) => {
      const m = /^(\d{2})-([A-Z]{3})-(\d{4})$/.exec(String(s || '').toUpperCase());
      return m && MONTHS[m[2]] ? `${m[3]}-${MONTHS[m[2]]}-${m[1]}` : (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
    };
    const filedOn = submissionFile
      ? new Map(readTsv(submissionFile).map((r) => [r.ACCESSIONNUMBER, isoDate(r.FILING_DATE)]))
      : new Map();
    for (const issuer of readTsv(issuersFile)) {
      if (issuer.IS_PRIMARYISSUER_FLAG !== 'YES') continue;
      const o = offering.get(issuer.ACCESSIONNUMBER);
      if (!o) continue;
      // Only the fund vehicles themselves, which declare as pooled investment funds.
      if (!truthy(o.ISPOOLEDINVESTMENTFUNDTYPE) && o.INDUSTRYGROUPTYPE !== 'Pooled Investment Fund') continue;
      for (const [fund, matches] of matchers) {
        if (!matches(issuer)) continue;
        const key = issuer.CIK;
        const prior = found.get(fund.id).get(key);
        const sold = Number(o.TOTALAMOUNTSOLD) || 0;
        const filed = filedOn.get(issuer.ACCESSIONNUMBER) || null;
        const date = /^\d{4}-\d{2}-\d{2}$/.test(o.SALE_DATE) ? o.SALE_DATE : filed;
        // An amendment restates the same vehicle; keep the largest figure and the
        // earliest first-sale date.
        if (!prior || sold > prior.amountSold) {
          found.get(fund.id).set(key, {
            vehicle: issuer.ENTITYNAME,
            cik: String(Number(issuer.CIK)),
            amountSold: sold,
            amountOffered: Number(o.TOTALOFFERINGAMOUNT) || null,
            date: date || prior?.date || null,
            // A vehicle that has filed but sold nothing yet is a fund still
            // raising — worth showing, and not the same as an unknown amount.
            stillRaising: sold === 0,
            country: issuer.STATEORCOUNTRYDESCRIPTION || null,
          });
        }
      }
    }
  }
  return found;
}

async function news(fund, cached) {
  const fresh = cached && (Date.now() - new Date(cached.checkedAt)) / 36e5 < NEWS_RECHECK_HOURS;
  if (fresh) return cached;
  // The firm name alone is ambiguous for "Primary", "Serena", "Kima", so the
  // query carries a qualifier unless the fund gives its own.
  const query = fund.newsQuery || `"${fund.name}" (venture OR "venture capital" OR fund OR invests)`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Funds-App)' } });
    if (!res.ok) throw new Error(String(res.status));
    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, NEWS_ITEMS).map((m) => {
      const b = m[1];
      const pick = (tag) => ((b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || '').trim();
      const title = pick('title').replace(/<!\[CDATA\[|\]\]>/g, '');
      const published = pick('pubDate');
      return {
        // Google appends " - Publisher" to every headline; the publisher is
        // already its own field.
        title: title.replace(/\s+-\s+[^-]{2,40}$/, ''),
        source: pick('source').replace(/<!\[CDATA\[|\]\]>/g, ''),
        date: published ? new Date(published).toISOString().slice(0, 10) : null,
        link: pick('link'),
      };
    });
    return { items: items.filter((i) => i.title), checkedAt: new Date().toISOString(), query };
  } catch (err) {
    return cached || { items: [], checkedAt: new Date().toISOString(), error: err.message, query };
  }
}

(async () => {
  const { funds } = read('funds.json');
  const deals = read('deals.json').deals;
  const sirenMap = read('siren-map.json').companies;
  let events = { companies: {} };
  try { events = read('events.json'); } catch {}

  const vehicles = fundVehicles(funds);
  const previous = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { funds: {} };

  // Register events that mean a portfolio company is in trouble or has changed
  // hands. A share sale is NOT published in France, so an acquisition often
  // leaves no trace here at all — these are the cases that do.
  const TROUBLE = {
    'Procédures collectives': 'insolvency proceedings',
    'Radiations': 'struck off the register',
    'Ventes et cessions': 'business or assets transferred',
    'Procédures de conciliation': 'conciliation proceedings',
  };

  const out = {};
  for (const fund of funds) {
    const mine = deals.filter((d) => d.funds.includes(fund.id));
    const byQuarter = {};
    for (const d of mine) byQuarter[quarterOf(d.date)] = (byQuarter[quarterOf(d.date)] || 0) + 1;
    // A continuous run of quarters, zeros included. Listing only the quarters
    // with deals in them hides the quiet stretches, which are the whole point of
    // looking at a fund's pace.
    const quarters = [];
    const now = new Date();
    for (let i = QUARTERS_SHOWN - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i * 3, 1));
      const q = `${d.getUTCFullYear()} Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
      quarters.push({ quarter: q, deals: byQuarter[q] || 0 });
    }
    const dates = mine.map((d) => d.date).sort();

    const trouble = [];
    for (const [key, meta] of Object.entries(sirenMap)) {
      if (!meta.funds?.includes(fund.id)) continue;
      for (const ev of events.companies[key]?.events || []) {
        const label = TROUBLE[ev.family];
        if (label) trouble.push({ company: meta.name, date: ev.date, what: label });
      }
    }
    trouble.sort((a, b) => b.date.localeCompare(a.date));

    const raises = [...vehicles.get(fund.id).values()].filter((v) => v.date).sort((a, b) => b.date.localeCompare(a.date));

    out[fund.id] = {
      name: fund.name,
      region: fund.region,
      deals: { total: mine.length, byQuarter: quarters, firstDeal: dates[0] || null, lastDeal: dates[dates.length - 1] || null },
      raises,
      raisesNote:
        fund.region === 'Paris'
          ? 'French funds only file with the SEC when they take US investors, so an empty list here means no US-facing vehicle, not no fundraising.'
          : null,
      trouble: trouble.slice(0, 12),
      troubleTotal: trouble.length,
      news: await news(fund, previous.funds?.[fund.id]?.news),
    };
  }

  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), funds: out }, null, 1));

  console.log(`${funds.length} funds`);
  for (const f of funds) {
    const a = out[f.id];
    console.log(
      `  ${f.name.slice(0, 26).padEnd(28)}${String(a.deals.total).padStart(4)} deals, last ${a.deals.lastDeal || '—'}` +
        ` | ${a.raises.length} vehicle${a.raises.length === 1 ? '' : 's'}` +
        (a.raises[0] ? ` (latest ${a.raises[0].date}, $${(a.raises[0].amountSold / 1e6).toFixed(0)}m)` : '') +
        ` | ${a.troubleTotal} register events | ${a.news.items.length} headlines`
    );
  }
})();
