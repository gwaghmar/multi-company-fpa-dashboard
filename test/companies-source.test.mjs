import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const source = JSON.parse(readFileSync(new URL("../companies.json", import.meta.url), "utf8"));
const KINDS = new Set(["amended", "presentation", "changed"]);

test("companies.json declares its vintage", () => {
  assert.equal(typeof source.vintage, "string");
  assert.match(source.vintage, /as originally filed/i);
});

test("every company has seven periods with strictly increasing period ends", () => {
  for (const [slug, company] of Object.entries(source.companies)) {
    assert.equal(company.periods.length, 7, slug);
    for (let i = 1; i < company.periods.length; i += 1) {
      assert.ok(company.periods[i].periodEnd > company.periods[i - 1].periodEnd, `${slug} ${company.periods[i].label}`);
    }
  }
});

test("every period was first filed after its period end", () => {
  for (const [slug, company] of Object.entries(source.companies)) {
    for (const period of company.periods) {
      assert.ok(period.source.firstFiled, `${slug} ${period.label} has no firstFiled`);
      assert.ok(period.source.firstFiled > period.periodEnd, `${slug} ${period.label}`);
    }
  }
});

const ROW_KEYS = [
  "basis", "deltaPct", "firstAccession", "firstFiled", "firstForm", "firstValue", "kind", "label", "latestAccession",
  "latestFiled", "latestForm", "latestValue", "metric", "periodEnd", "periodStart", "tag", "totalsChecked"
].sort();
const BASES = new Set(["quarter", "ytd", "annual", "instant"]);
const FLOW_METRICS = new Set([
  "revenue", "costOfRevenue", "grossProfit", "operatingIncome", "netIncome", "rd", "sellingGeneralAdministrative",
  "interestExpense", "incomeTaxExpense", "operatingCashFlow", "capex", "repurchases", "dividends",
  "shareBasedCompensation", "depreciationAmortization", "acquisitions"
]);
const CASH_FLOW_METRICS = new Set([
  "operatingCashFlow", "capex", "repurchases", "dividends", "shareBasedCompensation", "depreciationAmortization", "acquisitions"
]);

test("restatement rows have the full shape, sit inside the lookback window, and are sorted", () => {
  for (const [slug, company] of Object.entries(source.companies)) {
    assert.ok(Array.isArray(company.restatements), `${slug} has no restatements list`);
    const window = company.restatementWindow;
    assert.ok(Array.isArray(window) && window.length >= 7 && window.length <= 12, `${slug} restatementWindow`);
    const windowEnds = new Set(window.map(row => row.periodEnd));
    // The lookback always covers the seven quarters shown.
    for (const period of company.periods) assert.ok(windowEnds.has(period.periodEnd), `${slug} ${period.label} not in lookback`);
    let previous = "";
    for (const row of company.restatements) {
      const id = `${slug} ${row.metric} ${row.basis} ${row.periodEnd}`;
      assert.deepEqual(Object.keys(row).sort(), ROW_KEYS, `${id} row keys`);
      assert.ok(BASES.has(row.basis), `${id} basis`);
      assert.ok(windowEnds.has(row.periodEnd), `${id} is outside the lookback window`);
      assert.ok(row.firstAccession && row.latestAccession, `${id} lacks an accession`);
      assert.notEqual(row.firstAccession, row.latestAccession, id);
      assert.ok(row.firstFiled <= row.latestFiled, id);
      assert.ok(row.firstFiled > row.periodEnd, `${id} first filed before the period ended`);
      assert.ok(typeof row.firstValue === "number" && typeof row.latestValue === "number", id);
      assert.match(row.tag, /^[A-Za-z]+$/, `${id} tag`);
      // Basis rules: what is never compared.
      if (row.basis === "instant") assert.ok(!FLOW_METRICS.has(row.metric) && row.periodStart === null, id);
      else assert.ok(FLOW_METRICS.has(row.metric) && row.periodStart < row.periodEnd, id);
      if (row.basis === "quarter") {
        assert.match(row.label, /^Q[123] FY\d\d$/, `${id} a fiscal Q4 quarter is always derived and never compared`);
        if (CASH_FLOW_METRICS.has(row.metric)) assert.match(row.label, /^Q1 /, `${id} differenced cash-flow quarter`);
      }
      if (row.basis === "ytd") assert.ok(CASH_FLOW_METRICS.has(row.metric) && /^(H1|9M) FY\d\d$/.test(row.label), id);
      if (row.basis === "annual") assert.match(row.label, /^FY\d\d$/, id);
      assert.ok(!["freeCashFlow", "totalDebt", "debtCurrent", "debtNoncurrent"].includes(row.metric), `${id} derived metric`);
      const key = `${row.periodEnd}|${row.metric}`;
      assert.ok(key >= previous, `${slug} restatements are not sorted`);
      previous = key;
    }
  }
});

test("restatement deltaPct and threshold match the first and latest values", () => {
  for (const [slug, company] of Object.entries(source.companies)) {
    for (const row of company.restatements) {
      const id = `${slug} ${row.metric} ${row.periodEnd}`;
      const base = Math.max(Math.abs(row.firstValue), 1);
      const change = row.latestValue - row.firstValue;
      // deltaPct = 100 * (latest - first) / max(|first|, 1), rounded to two decimals.
      assert.ok(Math.abs(row.deltaPct - (100 * change) / base) <= 0.005 + 1e-9, `${id} deltaPct ${row.deltaPct}`);
      assert.ok(Math.abs(row.deltaPct * 100 - Math.round(row.deltaPct * 100)) < 1e-6, `${id} deltaPct has more than two decimals`);
      assert.ok(Math.abs(change) / base > 0.005 && Math.abs(change) >= 1, `${id} is below the threshold`);
    }
  }
});

test("restatement kind follows the rules: amended for /A, presentation only when totals are unchanged", () => {
  for (const [slug, company] of Object.entries(source.companies)) {
    for (const row of company.restatements) {
      const id = `${slug} ${row.metric} ${row.periodEnd}`;
      assert.ok(KINDS.has(row.kind), `${id} kind ${row.kind}`);
      const totals = row.totalsChecked;
      const unchanged = ["revenue", "netIncome"].every(name =>
        Array.isArray(totals[name]) && typeof totals[name][0] === "number" && totals[name][0] === totals[name][1]);
      if (row.latestForm.endsWith("/A")) assert.equal(row.kind, "amended", id);
      else assert.equal(row.kind, unchanged ? "presentation" : "changed", id);
    }
  }
});

test("values shown are as first filed: a restated figure never leaks into the seven periods", () => {
  for (const [slug, company] of Object.entries(source.companies)) {
    for (const row of company.restatements) {
      const shown = company.periods.find(period => period.periodEnd === row.periodEnd);
      if (!shown) continue;
      const id = `${slug} ${row.metric} ${row.basis} ${shown.label}`;
      if (row.basis === "quarter" || row.basis === "instant") assert.equal(shown.metrics[row.metric], row.firstValue, id);
      else assert.equal(shown.fiscalYtdMetrics[row.metric], row.firstValue, id);
    }
  }
});

// Pinned restatement rows, each checked against both filings' statements on EDGAR (2026-10-16).
// Rows can leave the lookback as new quarters are filed; a pin only applies while its period is covered.
test("restatement spot checks match the filings", () => {
  const pins = [
    // Alphabet cash-flow statement, "Repurchases of stock", six months ended 2025-06-30.
    ["alphabet", "repurchases", "2025-06-30", "ytd", 28706, "0001652044-25-000062", 28306, "0001652044-26-000071", "presentation"],
    // Meta cash-flow statement, "Purchases of property and equipment", FY2023.
    ["meta", "capex", "2023-12-31", "annual", 27266, "0001326801-24-000012", 27045, "0001628280-26-003942", "presentation"],
    // AMD income statement, "Marketing, general and administrative", three months ended 2024-03-30.
    ["amd", "sellingGeneralAdministrative", "2024-03-30", "quarter", 620, "0000002488-24-000056", 607, "0000002488-25-000047", "presentation"],
  ];
  for (const [slug, metric, end, basis, firstValue, firstAccession, latestValue, latestAccession, kind] of pins) {
    const company = source.companies[slug];
    if (!company.restatementWindow.some(row => row.periodEnd === end)) continue;
    const row = company.restatements.find(item => item.metric === metric && item.periodEnd === end && item.basis === basis);
    assert.ok(row, `${slug} ${metric} ${end} missing`);
    assert.deepEqual([row.firstValue, row.firstAccession, row.kind], [firstValue, firstAccession, kind], `${slug} ${metric} ${end}`);
    // A still later filing may report the period again; the pinned later filing is checked while it is the latest.
    if (row.latestAccession === latestAccession) assert.equal(row.latestValue, latestValue, `${slug} ${metric} ${end}`);
  }
});

const PY_CASES = String.raw`
import json, sys
sys.path.insert(0, "tools")
import fetch_company_sources as f

M = 1_000_000
facts = {}
def add(tag, start, end, val, accn, filed, form="10-Q"):
    row = {"end": end, "val": val * M, "accn": accn, "filed": filed, "form": form, "fy": 0, "fp": "Q1"}
    if start:
        row["start"] = start
    facts.setdefault(tag, {"units": {"USD": []}})["units"]["USD"].append(row)

Q1, Q2, Q3, FY = ("2024-01-01", "2024-03-31"), ("2024-04-01", "2024-06-30"), ("2024-07-01", "2024-09-30"), ("2024-01-01", "2024-12-31")
H1 = ("2024-01-01", "2024-06-30")
A1, A2, A3, AK = "A-24-1", "A-24-2", "A-24-3", "A-25-K"
B1, B2 = "B-25-1", "B-25-2"
# The period calendar: Q1-Q3 from three 10-Qs, FY from the 10-K.
for span, accn, filed in ((Q1, A1, "2024-04-30"), (Q2, A2, "2024-07-30"), (Q3, A3, "2024-10-30")):
    add("Revenues", *span, 100, accn, filed); add("NetIncomeLoss", *span, 10, accn, filed)
add("Revenues", *FY, 400, AK, "2025-02-01", "10-K"); add("NetIncomeLoss", *FY, 40, AK, "2025-02-01", "10-K")
# Q1 re-presented in next year's Q1 10-Q, totals unchanged: SG&A moves 20 -> 25.
add("Revenues", *Q1, 100, B1, "2025-04-30"); add("NetIncomeLoss", *Q1, 10, B1, "2025-04-30")
add("SellingGeneralAndAdministrativeExpense", *Q1, 20, A1, "2024-04-30")
add("SellingGeneralAndAdministrativeExpense", *Q1, 25, B1, "2025-04-30")
# Q2: net income also changes in the later filing -> changed.
add("Revenues", *Q2, 100, B2, "2025-07-30"); add("NetIncomeLoss", *Q2, 12, B2, "2025-07-30")
add("SellingGeneralAndAdministrativeExpense", *Q2, 30, A2, "2024-07-30")
add("SellingGeneralAndAdministrativeExpense", *Q2, 33, B2, "2025-07-30")
# Q3: an amended 10-Q -> amended.
add("SellingGeneralAndAdministrativeExpense", *Q3, 40, A3, "2024-10-30")
add("SellingGeneralAndAdministrativeExpense", *Q3, 44, "A-24-3A", "2024-12-01", "10-Q/A")
# A three-month Q4 fact filed twice with different values: derived quarter, never compared.
add("SellingGeneralAndAdministrativeExpense", "2024-10-01", "2024-12-31", 50, AK, "2025-02-01", "10-K")
add("SellingGeneralAndAdministrativeExpense", "2024-10-01", "2024-12-31", 70, "A-26-K", "2026-02-01", "10-K")
# R&D Q1: two different values inside ONE filing, then a third filing agreeing with the first -> no row.
add("ResearchAndDevelopmentExpense", *Q1, 60, A1, "2024-04-30")
add("ResearchAndDevelopmentExpense", *Q1, 90, A1, "2024-04-30")
add("ResearchAndDevelopmentExpense", *Q1, 60, B1, "2025-04-30")
# Cost of revenue Q1: first filed only in a later comparative column (renamed tag) -> vintage guard skips it.
add("CostOfRevenue", *Q1, 50, B1, "2025-04-30")
add("CostOfRevenue", *Q1, 55, "C-26-1", "2026-04-30")
# Capex: H1 YTD restated in the later 10-Q (ytd basis) and the FY figure in a 10-K/A.
add("PaymentsToAcquirePropertyPlantAndEquipment", *Q1, 5, A1, "2024-04-30")
add("PaymentsToAcquirePropertyPlantAndEquipment", *H1, 11, A2, "2024-07-30")
add("PaymentsToAcquirePropertyPlantAndEquipment", *H1, 13, B2, "2025-07-30")
add("PaymentsToAcquirePropertyPlantAndEquipment", *FY, 30, AK, "2025-02-01", "10-K")
add("PaymentsToAcquirePropertyPlantAndEquipment", *FY, 33, "A-25-KA", "2025-05-01", "10-K/A")
# Payables at the year end, re-presented in the next 10-K that also repeats FY totals unchanged.
add("AccountsPayableCurrent", None, "2024-12-31", 80, AK, "2025-02-01", "10-K")
add("AccountsPayableCurrent", None, "2024-12-31", 90, "A-26-K", "2026-02-01", "10-K")
add("Revenues", *FY, 400, "A-26-K", "2026-02-01", "10-K"); add("NetIncomeLoss", *FY, 40, "A-26-K", "2026-02-01", "10-K")

payload = {"facts": {"us-gaap": facts}}
periods = f.build_periods(f.tag_facts(payload, "Revenues"))
tags = {"revenue": "Revenues", "netIncome": "NetIncomeLoss", "sellingGeneralAdministrative": "SellingGeneralAndAdministrativeExpense",
        "rd": "ResearchAndDevelopmentExpense", "costOfRevenue": "CostOfRevenue",
        "capex": "PaymentsToAcquirePropertyPlantAndEquipment", "accountsPayable": "AccountsPayableCurrent"}
print(json.dumps({"rows": f.restatement_rows(payload, tags, periods),
                  "window": [p["end"] for p in f.lookback_periods(periods)]}))
`;

test("restatement rules on a synthetic filing history (kind, noise exclusion, vintage guard)", t => {
  const run = spawnSync("python3", ["-c", PY_CASES], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  if (run.error) return t.skip("python3 not available");
  assert.equal(run.status, 0, run.stderr);
  const { rows, window } = JSON.parse(run.stdout);
  assert.deepEqual(window, ["2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31"]);
  const got = rows.map(row => [row.metric, row.basis, row.label, row.firstValue, row.latestValue, row.deltaPct, row.kind]);
  assert.deepEqual(got, [
    ["sellingGeneralAdministrative", "quarter", "Q1 FY24", 20, 25, 25, "presentation"],
    ["capex", "ytd", "H1 FY24", 11, 13, 18.18, "changed"],          // H1 totals are not filed in either filing
    ["netIncome", "quarter", "Q2 FY24", 10, 12, 20, "changed"],     // a total itself changed
    ["sellingGeneralAdministrative", "quarter", "Q2 FY24", 30, 33, 10, "changed"],
    ["sellingGeneralAdministrative", "quarter", "Q3 FY24", 40, 44, 10, "amended"],
    ["accountsPayable", "instant", "Q4 FY24", 80, 90, 12.5, "presentation"],
    ["capex", "annual", "FY24", 30, 33, 10, "amended"],
  ]);
  // Not present: Q4 three-month SG&A (derived quarter), R&D (conflicting values inside one filing),
  // cost of revenue (earliest value is a later comparative column, not the original filing).
  for (const metric of ["rd", "costOfRevenue"]) assert.ok(!rows.some(row => row.metric === metric), metric);
  assert.ok(!rows.some(row => row.basis === "quarter" && row.label.startsWith("Q4")));
});

test("Apple quarter labels in data.json match companies.json", () => {
  const data = JSON.parse(readFileSync(new URL("../data.json", import.meta.url), "utf8"));
  const norm = label => String(label).replace(/\s+/g, " ").trim();
  const fromData = data.meta.quarters.map(norm);
  const fromCompanies = source.companies.apple.periods.map(period => norm(period.label));
  assert.deepEqual(fromData, fromCompanies, "data.json must be rebuilt with tools/fetch_edgar_data.py before publishing");
});

const period = (slug, label) => source.companies[slug].periods.find(row => row.label === label);
const INTEREST_MAPPED = ["alphabet", "nvidia", "microsoft", "amazon", "amd", "broadcom", "oracle", "salesforce", "intel"];
const INTEREST_TAGS = new Set(["InterestExpenseNonoperating", "InterestExpense", "InterestExpenseDebt"]);

test("interest expense is mapped to a gross interest expense tag, never a net or cash-paid tag", () => {
  for (const [slug, company] of Object.entries(source.companies)) {
    const tag = company.metricTags.interestExpense;
    if (INTEREST_MAPPED.includes(slug)) {
      assert.ok(INTEREST_TAGS.has(tag), `${slug} interestExpense tag ${tag}`);
    } else {
      assert.equal(tag, null, `${slug} should be unmapped`);
      for (const row of company.periods) assert.equal(row.metrics.interestExpense, null, `${slug} ${row.label}`);
    }
    for (const [metric, name] of Object.entries(company.metricTags)) {
      if (name) assert.doesNotMatch(name, /InterestIncomeExpense|InterestPaid/, `${slug} ${metric} uses a netted or cash-paid tag`);
    }
  }
  assert.match(source.companies.meta.unmappedMetrics.interestExpense, /\S/, "Meta exclusion must carry a reason");
});

test("metricTagFallbacks only fill spans after an identical-value bridge, for allowed metrics only", () => {
  for (const [slug, company] of Object.entries(source.companies)) {
    for (const [metric, report] of Object.entries(company.metricTagFallbacks || {})) {
      assert.ok(["dividends", "interestExpense"].includes(metric), `${slug} ${metric} is not an allowed fallback metric`);
      assert.ok(company.metricTags[metric], `${slug} ${metric} fallback without a primary tag`);
      assert.ok(report.bridge.length > 0, `${slug} ${metric} has no bridge span`);
      for (const bridge of report.bridge) assert.ok(bridge.primaryAccession && bridge.fallbackAccession, `${slug} ${metric} bridge lacks accessions`);
      const bridged = new Set(report.bridge.map(row => `${row.start}|${row.end}`));
      for (const span of report.spans) {
        assert.ok(report.tags.includes(span.tag) && span.tag !== company.metricTags[metric], `${slug} ${metric} span tag ${span.tag}`);
        assert.ok(!bridged.has(`${span.start}|${span.end}`), `${slug} ${metric} fallback replaced a span the primary filed`);
        assert.ok(span.accession && typeof span.value === "number", `${slug} ${metric} span lacks a filed value`);
        // A filled span ending at a window period end must surface as a non-null value there.
        const row = company.periods.find(candidate => candidate.periodEnd === span.end);
        if (row) assert.notEqual(row.fiscalYtdMetrics[metric], null, `${slug} ${metric} ${row.label}`);
      }
    }
  }
});

// Pinned filed values. These rotate out of the seven-quarter window as new quarters are filed;
// update them (from SEC filings, never by hand) when that happens.
test("Alphabet Q2 FY26 dividends come from the renamed tag", () => {
  const alphabet = source.companies.alphabet;
  assert.equal(alphabet.metricTags.dividends, "PaymentsOfDividends");
  assert.deepEqual(alphabet.metricTagFallbacks.dividends.tags, ["PaymentsOfOrdinaryDividends"]);
  const q2 = period("alphabet", "Q2 FY26");
  if (!q2) return;
  assert.equal(q2.fiscalYtdMetrics.dividends, 5231);
  assert.equal(q2.metrics.dividends, 2689); // 5,231 H1 2026 minus 2,542 Q1 2026
  assert.ok(q2.derivedMetrics.includes("dividends"));
});

test("interest expense spot checks match the filings", () => {
  const checks = [
    ["alphabet", "Q2 FY26", 1278, false], // 10-Q 0001652044-26-000071
    ["oracle", "Q1 FY27", 1428, false], // 10-Q 0001193125-26-389274
    ["broadcom", "Q4 FY25", 761, true], // 3,210 FY25 (10-K, fallback tag) minus 2,449 nine months
    ["salesforce", "Q1 FY27", 317, false], // 10-Q 0001108524-26-000127, fallback tag
  ];
  for (const [slug, label, value, derived] of checks) {
    const row = period(slug, label);
    if (!row) continue;
    assert.equal(row.metrics.interestExpense, value, `${slug} ${label}`);
    assert.equal(row.derivedMetrics.includes("interestExpense"), derived, `${slug} ${label} derived flag`);
  }
});
