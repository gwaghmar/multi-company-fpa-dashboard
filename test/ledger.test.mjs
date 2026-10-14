import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { forecastHash, gradeForecast, parseGuidanceRange, gradeGuidance, guidanceForForecast, ledgerSummary } from "../ledger-core.mjs";

const read = name => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));
const ledger = read("forecasts.json");
const companies = read("companies.json").companies;
const today = new Date().toISOString().slice(0, 10);

test("ledger file has the expected shape", () => {
  assert.equal(ledger.schemaVersion, 1);
  assert.equal(ledger.units, "USD millions");
  assert.ok(Array.isArray(ledger.forecasts));
});

test("every recorded call is well formed and unaltered", () => {
  const ids = new Set();
  let previousLock = "";
  for (const f of ledger.forecasts) {
    assert.ok(!ids.has(f.id), `duplicate id ${f.id}`);
    ids.add(f.id);
    assert.equal(f.id, `${f.company}-${f.periodEnd}`);
    assert.equal(forecastHash(f), f.hash, `hash mismatch for ${f.id}`);
    assert.ok(f.lockedAt >= previousLock, `${f.id} is out of lockedAt order`);
    previousLock = f.lockedAt;
    const period = companies[f.company]?.periods.find(p => p.periodEnd === f.periodEnd);
    if (period?.source?.firstFiled) assert.ok(f.lockedAt < period.source.firstFiled, `${f.id} was locked on or after its first filing`);
    else assert.ok(f.lockedAt <= today, `${f.id} is locked in the future`);
    if (period) assert.equal(f.label, period.label, `${f.id} label does not match companies.json`);
  }
});

test("hash is plain sha256 of the pipe-joined fields", () => {
  const entry = { id: "x-2099-01-01", company: "x", label: "Q1 FY99", periodEnd: "2099-01-01", revenue: 1, grossMarginPct: 40.5, opex: null, lockedAt: "2026-01-01" };
  const expected = createHash("sha256").update("x-2099-01-01|x|Q1 FY99|2099-01-01|1|40.5|null|2026-01-01").digest("hex");
  assert.equal(forecastHash(entry), expected);
  const long = { ...entry, label: "é".repeat(100) };
  assert.equal(forecastHash(long), createHash("sha256").update(["x-2099-01-01", "x", long.label, "2099-01-01", 1, 40.5, "null", "2026-01-01"].join("|")).digest("hex"));
});

test("parseGuidanceRange accepts the three shapes", () => {
  const unit = "USD millions";
  assert.deepEqual(parseGuidanceRange("We expect third quarter 2026 total revenue to be in the range of $61-64 billion."), { low: 61000, high: 64000, unit });
  assert.deepEqual(parseGuidanceRange("Forecasting third-quarter 2026 revenue of $15.8 billion to $16.8 billion; expecting third-quarter EPS attributable to Intel of $0.31 and non-GAAP EPS attributable to Intel of $0.38."), { low: 15800, high: 16800, unit });
  assert.deepEqual(parseGuidanceRange("Fourth quarter fiscal year 2026 revenue guidance of approximately $34.8 billion, an increase of 93 percent from the prior year period."), { low: 34800, high: 34800, unit });
  assert.deepEqual(parseGuidanceRange("Revenue of $900 million to $950 million."), { low: 900, high: 950, unit });
  assert.deepEqual(parseGuidanceRange("Revenue of $900-950 million."), { low: 900, high: 950, unit });
});

test("parseGuidanceRange accepts the between-and and plus-or-minus shapes", () => {
  const unit = "USD millions";
  assert.deepEqual(parseGuidanceRange("Net sales are expected to be between $197.0 billion and $202.0 billion, or to grow between 9% and 12% compared with third quarter 2025."), { low: 197000, high: 202000, unit });
  assert.deepEqual(parseGuidanceRange("Revenue is expected to be $108.0 billion, plus or minus 2%."), { low: 105840, high: 110160, unit, derivedFrom: "2%" });
  assert.deepEqual(parseGuidanceRange("For the third quarter of 2026, AMD expects revenue to be approximately $13 billion, plus or minus $300 million."), { low: 12700, high: 13300, unit, derivedFrom: "$300 million" });
});

test("parseGuidanceRange rejects everything else", () => {
  const rejects = [
    "compared to our forward-looking guidance provided on April 29, 2026",
    "This guidance anticipates an unfavorable impact of approximately 80 basis points from foreign exchange rates.",
    "Q3 2026 Outlook Revenue ~$13B +/- $300M Non-GAAP gross margin ~55%",
    "we now expect total revenue to be at least $90 billion",
    "For fiscal year 2027, we now expect total revenue to be at least $90 billion, and non-GAAP EPS to be at $8.10.",
    "Revenue of $64-61 billion.",
    "",
    null
  ];
  for (const text of rejects) assert.equal(parseGuidanceRange(text), null, String(text));
});

test("gradeGuidance and gradeForecast", () => {
  const range = { low: 61000, high: 64000, unit: "USD millions" };
  assert.deepEqual(gradeGuidance(range, 63000), { inside: true, midErrPct: 100 * (62500 - 63000) / 63000 });
  assert.equal(gradeGuidance(range, 65000).inside, false);
  assert.equal(gradeGuidance(null, 65000), null);
  const period = { metrics: { revenue: 1000, grossProfit: 450, rd: 100, sellingGeneralAdministrative: 50 } };
  const graded = gradeForecast({ revenue: 1100, grossMarginPct: 47, opex: 120 }, period);
  assert.ok(Math.abs(graded.revenueErrPct - 10) < 1e-9);
  assert.ok(Math.abs(graded.gmErrPts - 2) < 1e-9);
  assert.ok(Math.abs(graded.opexErrPct - (-20)) < 1e-9);
  const noSga = gradeForecast({ revenue: 1100, grossMarginPct: 47, opex: 120 }, { metrics: { revenue: 1000, grossProfit: 450, rd: 100 } });
  assert.equal(noSga.opexErrPct, null);
});

test("guidanceForForecast uses the (previous periodEnd, periodEnd] window", () => {
  const periods = [{ periodEnd: "2026-03-31" }, { periodEnd: "2026-06-30" }];
  const context = { guidance: { text: "x", filed: "2026-07-29", url: "u", sourceTitle: "t" } };
  assert.equal(guidanceForForecast({ periodEnd: "2026-09-30" }, context, periods), context.guidance);
  assert.equal(guidanceForForecast({ periodEnd: "2026-12-31" }, context, periods), context.guidance);
  assert.equal(guidanceForForecast({ periodEnd: "2026-06-30" }, context, periods), null);
  assert.equal(guidanceForForecast({ periodEnd: "2026-09-30" }, { guidance: null }, periods), null);
});

test("ledgerSummary works with an empty ledger and with calls", () => {
  assert.deepEqual(ledgerSummary([], companies), { onRecord: 0, graded: 0, next: null });
  const calls = [
    { company: "apple", label: "Q4 FY26", periodEnd: "2099-09-26" },
    { company: "apple", label: "Old", periodEnd: companies.apple.periods[0].periodEnd }
  ];
  assert.deepEqual(ledgerSummary(calls, companies), { onRecord: 2, graded: 1, next: { company: "apple", label: "Q4 FY26", periodEnd: "2099-09-26" } });
});

test("add_forecast.mjs works on a temporary copy and enforces its rules", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  const file = join(dir, "forecasts.json");
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, units: "USD millions", forecasts: [] }));
  const run = (...args) => spawnSync("node", ["tools/add_forecast.mjs", ...args, "--file", file], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" });
  const ok = run("apple", "Q4 FY99", "2099-09-26", "--revenue", "1000", "--gm", "40", "--opex", "100", "--note", "test");
  assert.equal(ok.status, 0, ok.stderr);
  const saved = JSON.parse(readFileSync(file, "utf8")).forecasts;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, "apple-2099-09-26");
  assert.equal(forecastHash(saved[0]), saved[0].hash);
  assert.notEqual(run("apple", "Q4 FY99", "2099-09-26", "--revenue", "1000", "--gm", "40", "--opex", "100").status, 0, "duplicate id");
  assert.notEqual(run("apple", "Old", companies.apple.periods[0].periodEnd, "--revenue", "1000", "--gm", "40", "--opex", "100").status, 0, "backfill");
  assert.notEqual(run("nope", "Q1", "2099-01-01", "--revenue", "1", "--gm", "40", "--opex", "1").status, 0, "unknown company");
});

test("stored guidance in company-context.json is verbatim-shaped or null", () => {
  const context = read("company-context.json").companies;
  for (const [slug, company] of Object.entries(context)) {
    if (!("guidance" in company)) continue;
    const g = company.guidance;
    if (g === null) continue;
    assert.deepEqual(Object.keys(g).sort(), ["filed", "sourceTitle", "text", "url"], slug);
    assert.match(g.filed, /^\d{4}-\d{2}-\d{2}$/, slug);
    assert.match(g.url, /^https:\/\/www\.sec\.gov\//, slug);
  }
});
