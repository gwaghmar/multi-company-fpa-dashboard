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
