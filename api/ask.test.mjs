import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import handler, { __test } from "./ask.js";

const filters = {
  quarterIndexes: [4, 5, 6],
  categories: ["iPhone", "Services"],
  geographies: ["Americas", "Europe"],
};

function responseRecorder() {
  return {
    code: 200,
    body: null,
    setHeader() {},
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

test("scope routing does not confuse short substrings with dashboard terms", () => {
  assert.equal(__test.isDashboardQuestion("How do I cook pasta?"), false);
  assert.equal(__test.isDashboardQuestion("What is the tallest building in the world?"), false);
  assert.equal(__test.isDashboardQuestion("How much did R&D increase?"), true);
});

test("dashboard evidence uses structured filters and relevant tools only", () => {
  const evidence = __test.buildDashboardEvidence("What is iPhone revenue?", "", "balance", filters);
  assert.deepEqual(evidence.activeFilters.quarters, ["Q1 FY26", "Q2 FY26", "Q3 FY26"]);
  assert.deepEqual(evidence.activeFilters.categories, ["iPhone", "Services"]);
  assert.deepEqual([...new Set(evidence.results.map(result => result.section))], ["is", "cat"]);
  const categories = evidence.results.find(result => result.tool === "getBreakdown");
  assert.equal(categories.values.revenue.iPhone.length, 3);
  assert.equal(categories.values.revenue.Mac, undefined);
});

test("EPS tool uses Apple's filed exact-period values and never sums arbitrary quarters", () => {
  const filed = __test.buildDashboardEvidence("What is diluted EPS?", "", "profit", filters);
  const filedKpi = filed.results.find(result => result.tool === "calculateKpi" && result.section === "is");
  assert.equal(filedKpi.selectedPeriodTotals.dilutedEpsFiledForExactSelection, 6.88);

  const arbitrary = __test.buildDashboardEvidence("What is diluted EPS?", "", "profit", { ...filters, quarterIndexes: [0, 4] });
  const arbitraryKpi = arbitrary.results.find(result => result.tool === "calculateKpi" && result.section === "is");
  assert.equal(arbitraryKpi.selectedPeriodTotals.dilutedEpsFiledForExactSelection, null);
});

test("filing search is bounded and strips HTML text blocks", () => {
  const facts = __test.searchFiling("What bond maturities were disclosed in the 10-Q?");
  assert.ok(facts.length > 0 && facts.length <= 6);
  assert.equal(facts.some(fact => /<[^>]+>/.test(fact.value) || fact.value.length > 240), false);
});

test("out-of-scope dashboard questions return locally without a model call", async () => {
  let called = false;
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; throw new Error("should not run"); };
  const res = responseRecorder();
  await handler({ method: "POST", body: { mode: "dashboard", question: "How do I cook pasta?" } }, res);
  globalThis.fetch = priorFetch;
  assert.equal(called, false);
  assert.equal(res.body.meta.route, "local_scope");
  assert.equal(res.body.meta.usage.input_tokens, 0);
});

test("general mode sends no dashboard evidence or filters", async () => {
  const priorKey = process.env.ANTHROPIC_API_KEY;
  const priorFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "test";
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ content: [{ type: "text", text: "Answer" }], usage: { input_tokens: 50, output_tokens: 2 } }) };
  };
  const res = responseRecorder();
  await handler({ method: "POST", body: { mode: "general", question: "How do I cook pasta?", filters } }, res);
  globalThis.fetch = priorFetch;
  if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorKey;
  assert.equal(requestBody.max_tokens, 420);
  assert.equal(requestBody.system.includes("EVIDENCE"), false);
  assert.equal(requestBody.system.includes("Q1 FY26"), false);
  assert.equal(res.body.meta.route, "general");
});

test("company mode sends only the selected SEC company source", async () => {
  const priorKey = process.env.ANTHROPIC_API_KEY;
  const priorWorkspace = process.env.ANTHROPIC_WORKSPACE_ID;
  const priorFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "test";
  process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_test";
  let requestBody;
  let requestHeaders;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    requestHeaders = options.headers;
    return { ok: true, json: async () => ({ content: [{ type: "text", text: "Answer" }], usage: {} }) };
  };
  const res = responseRecorder();
  await handler({ method: "POST", body: { mode: "dashboard", tab: "company", company: "alphabet", question: "Summarize the latest quarter." } }, res);
  globalThis.fetch = priorFetch;
  if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorKey;
  if (priorWorkspace === undefined) delete process.env.ANTHROPIC_WORKSPACE_ID; else process.env.ANTHROPIC_WORKSPACE_ID = priorWorkspace;
  assert.equal(res.body.meta.route, "company_source");
  assert.match(requestBody.system, /Dashboard AI for Alphabet \(GOOGL\)/);
  assert.doesNotMatch(requestBody.system, /iPhone/);
  assert.equal(requestHeaders["anthropic-workspace-id"], "wrkspc_test");
});

test("selected peer company follows every dashboard tab into AI evidence", async () => {
  const priorKey = process.env.ANTHROPIC_API_KEY;
  const priorFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "test";
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ content: [{ type: "text", text: "Answer" }], usage: {} }) };
  };
  const res = responseRecorder();
  await handler({ method: "POST", body: { mode: "dashboard", tab: "revenue", company: "nvidia", filters: { quarterIndexes: [5, 6] }, question: "Summarize selected revenue." } }, res);
  globalThis.fetch = priorFetch;
  if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorKey;
  assert.equal(res.body.meta.route, "company_source");
  assert.match(requestBody.system, /Dashboard AI for NVIDIA \(NVDA\)/);
  assert.match(requestBody.system, /"tab":"revenue"/);
  assert.doesNotMatch(requestBody.system, /iPhone/);
});

test("planning AI receives the visible modeled scenario and labels it modeled", async () => {
  const priorKey = process.env.ANTHROPIC_API_KEY;
  const priorFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "test";
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ content: [{ type: "text", text: "Answer" }], usage: {} }) };
  };
  const res = responseRecorder();
  await handler({ method: "POST", body: { mode: "dashboard", tab: "plan", company: "apple", filters: { quarterIndexes: [4, 5, 6], scenario: { scenario: "downside", revenueGrowth: 0, grossMarginDelta: -2, opexGrowth: 5 } }, question: "Explain this scenario." } }, res);
  globalThis.fetch = priorFetch;
  if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorKey;
  assert.equal(res.body.meta.route, "company_source");
  assert.match(requestBody.system, /user-visible modeled FP&A scenario/);
  assert.match(requestBody.system, /"scenario":"downside"/);
  assert.match(requestBody.system, /"basePeriod":"Q3 FY26"/);
  assert.match(requestBody.system, /"modeledNextQuarter"/);
  assert.match(requestBody.system, /"operatingMarginPct"/);
});

test("browser UI exposes both modes and sends structured filters", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /data-ai-mode="dashboard"/);
  assert.match(html, /data-ai-mode="general"/);
  assert.match(html, /quarterIndexes:\[\.\.\.state\.q\]/);
  assert.doesNotMatch(html, /selectionPayload/);
});
