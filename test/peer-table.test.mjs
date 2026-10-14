import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calendarQuarter, daysToFile, buildPeerGrid } from "../peer-core.mjs";

const data = JSON.parse(readFileSync(new URL("../companies.json", import.meta.url), "utf8"));

test("Apple 2026-06-27 maps to CQ2 2026", () => {
  const cq = calendarQuarter("2026-06-27");
  assert.equal(cq.key, "CQ2 2026");
  assert.equal(cq.snappedMonthEnd, "2026-06-30");
  assert.equal(cq.offsetLabel, "");
});

test("NVIDIA 2026-01-25 snaps to January and is +1 mo past CQ4 2025", () => {
  const cq = calendarQuarter("2026-01-25");
  assert.equal(cq.snappedMonthEnd, "2026-01-31");
  assert.equal(cq.key, "CQ4 2025");
  assert.equal(cq.offsetLabel, "+1 mo");
});

test("Broadcom 2026-02-01 snaps back to January", () => {
  const cq = calendarQuarter("2026-02-01");
  assert.equal(cq.snappedMonthEnd, "2026-01-31");
  assert.equal(cq.key, "CQ4 2025");
  assert.equal(cq.offsetLabel, "+1 mo");
});

test("Oracle 2026-08-31 is month August, -1 mo before CQ3 2026", () => {
  const cq = calendarQuarter("2026-08-31");
  assert.equal(cq.snappedMonthEnd, "2026-08-31");
  assert.equal(cq.key, "CQ3 2026");
  assert.equal(cq.offsetLabel, "-1 mo");
});

test("53-week early-January year end snaps to December and CQ4 of the prior year", () => {
  const cq = calendarQuarter("2027-01-02");
  assert.equal(cq.snappedMonthEnd, "2026-12-31");
  assert.equal(cq.key, "CQ4 2026");
  assert.equal(cq.offsetLabel, "");
});

test("calendar quarter ends and invalid input", () => {
  assert.equal(calendarQuarter("2025-03-31").key, "CQ1 2025");
  assert.equal(calendarQuarter("2025-12-31").key, "CQ4 2025");
  assert.equal(calendarQuarter("2025-11-30").key, "CQ4 2025");
  assert.equal(calendarQuarter("2025-05-31").key, "CQ2 2025");
  assert.equal(calendarQuarter("2025-04-30").key, "CQ1 2025");
  assert.equal(calendarQuarter(null), null);
  assert.equal(calendarQuarter("June 2026"), null);
});

test("daysToFile uses firstFiled only", () => {
  const base = { periodEnd: "2026-06-27", source: { filed: "2026-08-01" } };
  assert.equal(daysToFile(base), null);
  assert.equal(daysToFile({ ...base, source: { filed: "2026-08-01", firstFiled: "2026-07-31" } }), 34);
  assert.equal(daysToFile({ periodEnd: "2026-06-27" }), null);
});

test("every companies.json period maps to exactly one calendar quarter", () => {
  for (const [id, company] of Object.entries(data.companies)) {
    for (const period of company.periods) {
      const cq = calendarQuarter(period.periodEnd);
      assert.ok(cq, `${id} ${period.label} ${period.periodEnd} has no calendar quarter`);
      assert.match(cq.key, /^CQ[1-4] \d{4}$/);
    }
  }
});

test("no company has two periods in one calendar quarter", () => {
  const grid = buildPeerGrid(data.companies);
  assert.deepEqual(grid.conflicts, []);
  for (const [id, company] of Object.entries(data.companies)) {
    const values = company.periods.map(p => { const c = calendarQuarter(p.periodEnd); return c.year * 4 + c.quarter; });
    assert.equal(new Set(values).size, values.length, `${id} has a duplicate calendar quarter`);
  }
});

test("grid columns run oldest to newest and cover every company", () => {
  const grid = buildPeerGrid(data.companies);
  const values = grid.columns.map(c => c.year * 4 + c.quarter);
  assert.deepEqual(values, [...values].sort((a, b) => a - b));
  assert.equal(grid.rows.length, Object.keys(data.companies).length);
});
