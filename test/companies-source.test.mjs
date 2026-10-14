import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

test("restatement rows are complete, ordered and above the threshold", () => {
  for (const [slug, company] of Object.entries(source.companies)) {
    assert.ok(Array.isArray(company.restatements), `${slug} has no restatements list`);
    const windowEnds = new Set(company.periods.map(period => period.periodEnd));
    let previous = "";
    for (const row of company.restatements) {
      const id = `${slug} ${row.metric} ${row.periodEnd}`;
      assert.ok(row.firstAccession && row.latestAccession, `${id} lacks an accession`);
      assert.notEqual(row.firstAccession, row.latestAccession, id);
      assert.ok(row.firstFiled <= row.latestFiled, id);
      assert.ok(windowEnds.has(row.periodEnd), `${id} is outside the seven-quarter window`);
      const change = Math.abs(row.latestValue - row.firstValue);
      assert.ok(change / Math.max(Math.abs(row.firstValue), 1) > 0.005 && change >= 1, `${id} is below the threshold`);
      assert.ok(KINDS.has(row.kind), `${id} kind ${row.kind}`);
      if (row.kind === "amended") assert.ok(row.latestForm.endsWith("/A"), id);
      const key = `${row.periodEnd}|${row.metric}`;
      assert.ok(key >= previous, `${slug} restatements are not sorted`);
      previous = key;
    }
  }
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
