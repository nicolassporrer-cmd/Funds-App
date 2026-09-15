// Stage 3b — pull every Form D filing for each resolved US company.
//
// Form D is the US counterpart to a BODACC capital increase: a notice a company
// must file with the SEC within 15 days of first sale in an exempt private
// offering. It is dated, official, and filed whether or not anyone announces the
// round — the same property that makes the French register useful.
//
// It is also RICHER than the French register in one important way: it states the
// amount. `totalAmountSold` is what the company actually raised in the offering.
// The French register never publishes this, so a US row can carry a figure a
// Paris row never can, and the page must not imply the two are comparable.
//
// Output: data/formd.json (gitignored intermediate)

const fs = require('fs');
const path = require('path');
const { get } = require('./lib/http.cjs');

const DATA = path.join(__dirname, '..', 'data');

const UA = process.env.SEC_USER_AGENT;
if (!UA || !UA.includes('@')) {
  console.error('SEC_USER_AGENT must be set to "AppName you@example.com" — SEC returns 403 without it.');
  console.error('Expected form: Funds-App you@example.com');
  process.exit(1);
}

const secGet = (url, opts = {}) => get(url, { minGapMs: 130, headers: { 'User-Agent': UA }, ...opts });

const tag = (xml, name) => {
  const m = xml.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'));
  return m ? m[1].trim() : null;
};

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

// One Form D's primary document.
async function parseFiling(cik, accession) {
  const acc = accession.replace(/-/g, '');
  const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc}/primary_doc.xml`;
  const xml = await secGet(url);

  const offering = tag(xml, 'offeringData') || xml;
  const totalOffering = num(tag(offering, 'totalOfferingAmount'));
  const totalSold = num(tag(offering, 'totalAmountSold'));

  // dateOfFirstSale is wrapped: <dateOfFirstSale><value>2026-06-01</value>...
  const firstSaleBlock = tag(offering, 'dateOfFirstSale') || '';
  const firstSale = (firstSaleBlock.match(/\d{4}-\d{2}-\d{2}/) || [])[0] || null;

  // "Decline to Disclose" is the usual answer, so this is a bonus, never relied on.
  const revenueRange = tag(offering, 'revenueRange');

  return {
    accession,
    totalOffering,
    totalSold,
    firstSale,
    revenueRange: revenueRange && !/decline/i.test(revenueRange) ? revenueRange : null,
    industry: tag(offering, 'industryGroupType'),
    // An amendment revises an earlier notice for the same offering rather than
    // announcing a new one; merging them is what stops one round counting twice.
    isAmendment: /<submissionType>D\/A<\/submissionType>/.test(xml),
  };
}

async function filingsFor(cik) {
  const padded = String(cik).padStart(10, '0');
  const json = await secGet(`https://data.sec.gov/submissions/CIK${padded}.json`, { json: true });
  const recent = json.filings?.recent || {};
  const out = [];
  for (let i = 0; i < (recent.form || []).length; i++) {
    if (recent.form[i] !== 'D' && recent.form[i] !== 'D/A') continue;
    out.push({ form: recent.form[i], filedAt: recent.filingDate[i], accession: recent.accessionNumber[i] });
  }
  return out.sort((a, b) => a.filedAt.localeCompare(b.filedAt));
}

// A company files D, then often D/A amendments as the round closes. Each new
// offering gets its own original D. Group so that one round is one row: an
// amendment updates the amount of the offering it belongs to rather than adding
// a round, and offerings are matched on their date of first sale.
function toRounds(filings) {
  const rounds = new Map();
  for (const f of filings) {
    const key = f.firstSale || f.filedAt;
    const existing = rounds.get(key);
    if (!existing) {
      rounds.set(key, {
        date: f.firstSale || f.filedAt,
        filedAt: f.filedAt,
        amountSold: f.totalSold,
        amountOffered: f.totalOffering,
        industry: f.industry,
        revenueRange: f.revenueRange,
        amendments: f.isAmendment ? 1 : 0,
      });
      continue;
    }
    // Later filings for the same offering supersede earlier figures.
    if (f.totalSold != null) existing.amountSold = f.totalSold;
    if (f.totalOffering != null) existing.amountOffered = f.totalOffering;
    existing.filedAt = f.filedAt;
    if (f.isAmendment) existing.amendments++;
  }
  return [...rounds.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function roundsFor(cik) {
  const filings = await filingsFor(cik);
  const parsed = [];
  for (const f of filings) {
    try {
      parsed.push({ ...f, ...(await parseFiling(cik, f.accession)) });
    } catch {
      // A filing whose primary_doc.xml is missing is old (pre-2009 paper era)
      // or malformed. Keep the date, drop the detail, rather than lose the round.
      parsed.push({ ...f, totalSold: null, totalOffering: null, firstSale: null, isAmendment: f.form === 'D/A' });
    }
  }
  return toRounds(parsed);
}

module.exports = { roundsFor, toRounds };

if (require.main === module) {
  (async () => {
    const map = JSON.parse(fs.readFileSync(path.join(DATA, 'cik-map.json'), 'utf8'));
    const targets = Object.entries(map.companies).filter(
      ([, c]) => c.cik && c.status === 'resolved' && c.confidence !== 'low'
    );

    console.log(`${targets.length} US companies with a usable CIK`);
    const out = {};
    const errors = [];
    let done = 0;
    let withAmount = 0;
    let fundVehicles = 0;

    for (const [key, company] of targets) {
      try {
        const rounds = await roundsFor(company.cik);
        // Investment funds file Form D too — when they raise their own fund from
        // their LPs. "Velocity" matched "Velocity Capital Investors Fund I LP",
        // and 48 of the first 185 rounds fetched were fund closings rather than
        // company rounds. The filing declares this itself in industryGroupType,
        // which beats guessing from the name.
        const pooled = rounds.filter((r) => r.industry === 'Pooled Investment Fund').length;
        const isFundVehicle = rounds.length > 0 && pooled >= rounds.length / 2;
        // No Form D at all is the US equivalent of a SIREN with no BODACC entries:
        // strong evidence the name matched the wrong company.
        out[key] = {
          name: company.name,
          cik: company.cik,
          state: company.state,
          funds: company.funds,
          cikUnverified: rounds.length === 0,
          isFundVehicle,
          rounds,
        };
        if (isFundVehicle) fundVehicles++;
        else if (rounds.some((r) => r.amountSold)) withAmount++;
      } catch (err) {
        errors.push(`${company.name} (${company.cik}): ${err.message}`);
      }
      if (++done % 25 === 0) process.stdout.write(`  ${done}/${targets.length}\r`);
    }

    fs.writeFileSync(
      path.join(DATA, 'formd.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), companies: out, errors }, null, 2)
    );

    const totalRounds = Object.values(out).reduce((n, c) => n + c.rounds.length, 0);
    console.log(`\n${Object.keys(out).length} companies, ${totalRounds} Form D rounds`);
    console.log(`${withAmount} companies have at least one published amount`);
    console.log(`${fundVehicles} matched an investment fund rather than a company — excluded from the deal log`);
    console.log(`${Object.values(out).filter((c) => c.cikUnverified).length} CIKs returned no Form D — flagged unverified`);
    if (errors.length) console.log(`${errors.length} lookups failed:\n  ${errors.slice(0, 5).join('\n  ')}`);
  })();
}
