import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import handler, { __test } from "../api/ask.js";

const filters = {
  quarterIndexes: [4, 5, 6],
  categories: ["iPhone", "Services"],
  geographies: ["Americas", "Europe"],
};

// The handler streams NDJSON (one JSON object per line) instead of a single res.json() call now --
// this recorder captures both paths: .json()/.body for the early-exit responses (missing question,
// no API key) that never reach the streaming code, and .write()/.lines for everything that does.
function responseRecorder() {
  return {
    code: 200,
    body: null,
    lines: [],
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    writeHead(code, headers) { this.code = code; Object.assign(this.headers, headers || {}); return this; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
    write(chunk) {
      for (const line of chunk.toString().split("\n")) { if (line) this.lines.push(JSON.parse(line)); }
      return true;
    },
    end() { return this; },
  };
}
function findEvent(res, type) { return res.lines.find(line => line.type === type); }

// Builds a fake Anthropic streaming (SSE) response body good enough for reader.read()/getReader()
// to walk -- exercises the same parsing loop the handler runs against the real API.
function fakeAnthropicStream(text, usage = { input_tokens: 10, output_tokens: 5 }) {
  const encoder = new TextEncoder();
  const events = [
    { type: "message_start", message: { usage: { input_tokens: usage.input_tokens, output_tokens: 0 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: usage.output_tokens } },
  ];
  const chunks = events.map(event => encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
  let i = 0;
  return {
    ok: true,
    body: { getReader: () => ({ async read() { return i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }; } }) },
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

test("every system prompt carries the same style rules, incl. the follow-up trailer", () => {
  const dashboard = __test.dashboardSystemPrompt({ results: [] });
  const company = __test.companySystemPrompt(__test.companyEvidence("apple", { quarterIndexes: [6] }, "profit"));
  const general = __test.generalSystemPrompt();
  for (const prompt of [dashboard, company, general]) {
    assert.match(prompt, /No filler openers/);
    assert.match(prompt, /No .*em dashes/);
    assert.match(prompt, /NEXT:: <question 1> \| <question 2> \| <question 3>/);
    assert.doesNotMatch(prompt, /Do not use headings/);
  }
});

test("out-of-scope questions are answered from general knowledge, not rejected locally", async () => {
  // There's no manual Dashboard/General toggle anymore -- a question that doesn't match the
  // dashboard still gets a real model call, just without dashboard evidence attached.
  const priorKey = process.env.ANTHROPIC_API_KEY;
  const priorFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "test";
  let called = false;
  globalThis.fetch = async () => { called = true; return fakeAnthropicStream("Boil water, add pasta."); };
  const res = responseRecorder();
  await handler({ method: "POST", body: { question: "How do I cook pasta?" } }, res);
  globalThis.fetch = priorFetch;
  if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorKey;
  assert.equal(called, true);
  assert.equal(findEvent(res, "status").mode, "general");
  assert.equal(findEvent(res, "done").meta.route, "general");
});

test("questions unrelated to the dashboard send no evidence or filters", async () => {
  const priorKey = process.env.ANTHROPIC_API_KEY;
  const priorFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "test";
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return fakeAnthropicStream("Answer", { input_tokens: 50, output_tokens: 2 });
  };
  const res = responseRecorder();
  await handler({ method: "POST", body: { question: "How do I cook pasta?", filters } }, res);
  globalThis.fetch = priorFetch;
  if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorKey;
  assert.equal(requestBody.max_tokens, 620);
  assert.equal(requestBody.stream, true);
  assert.equal(requestBody.system.includes("EVIDENCE"), false);
  assert.equal(requestBody.system.includes("Q1 FY26"), false);
  assert.equal(findEvent(res, "done").meta.route, "general");
  assert.equal(findEvent(res, "done").meta.usage.output_tokens, 2);
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
    return fakeAnthropicStream("Answer");
  };
  const res = responseRecorder();
  await handler({ method: "POST", body: { tab: "company", company: "alphabet", question: "Summarize the latest quarter." } }, res);
  globalThis.fetch = priorFetch;
  if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorKey;
  if (priorWorkspace === undefined) delete process.env.ANTHROPIC_WORKSPACE_ID; else process.env.ANTHROPIC_WORKSPACE_ID = priorWorkspace;
  assert.equal(findEvent(res, "done").meta.route, "company_source");
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
    return fakeAnthropicStream("Answer");
  };
  const res = responseRecorder();
  await handler({ method: "POST", body: { tab: "revenue", company: "nvidia", filters: { quarterIndexes: [5, 6] }, question: "Summarize selected revenue." } }, res);
  globalThis.fetch = priorFetch;
  if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorKey;
  assert.equal(findEvent(res, "done").meta.route, "company_source");
  assert.match(requestBody.system, /Dashboard AI for NVIDIA \(NVDA\)/);
  assert.match(requestBody.system, /"tab":"revenue"/);
  assert.doesNotMatch(requestBody.system, /iPhone/);
});

test("company AI evidence exposes refresh metadata and expanded SEC metric coverage", () => {
  const evidence = __test.companyEvidence("nvidia", { quarterIndexes: [5, 6] }, "balance");
  assert.equal(evidence.company.ticker, "NVDA");
  assert.match(evidence.dataFreshness.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(evidence.availableMetrics.includes("inventory"));
  assert.ok(evidence.availableMetrics.includes("incomeTaxExpense"));
  assert.ok(evidence.publicContext.managementSignals.length >= 2);
  assert.equal(evidence.publicContext.coverage.managementCommentary, true);
  const prompt = __test.companySystemPrompt(evidence);
  assert.match(prompt, /Supplemental SEC metrics/);
  assert.match(prompt, /data refresh timestamp/);
  assert.match(prompt, /official-source excerpts/);
});

test("public context is tab-scoped and preserves unavailable boundaries", () => {
  const planning = __test.publicContextForCompany("alphabet", "plan");
  assert.ok(planning.managementSignals.every(signal => ["Guidance", "Demand and revenue", "Margin and cost", "Investment"].includes(signal.category)));
  assert.equal(planning.coverage.internalPlan, false);
  assert.equal(planning.coverage.analystConsensus, false);
  assert.equal(planning.macro.fx.status, "connected");
  assert.ok(planning.annualReport.evidence.every(item => ["Revenue and demand", "Strategy and investment", "Liquidity and capital", "Risk and supply"].includes(item.area)));
  assert.equal(planning.annualReport.sourceType, "SEC 10-K annual report");
  assert.match(__test.companySystemPrompt(__test.companyEvidence("alphabet", { quarterIndexes: [5, 6] }, "plan")), /latest 10-K/);
  const people = __test.publicContextForCompany("nvidia", "people");
  assert.ok(people.managementSignals.every(signal => ["Workforce", "Investment"].includes(signal.category)));
  assert.ok(people.annualReport.evidence.every(item => ["Workforce", "Strategy and investment"].includes(item.area)));
  assert.equal(people.macro, undefined);
});

test("planning AI receives the visible modeled scenario and labels it modeled", async () => {
  const priorKey = process.env.ANTHROPIC_API_KEY;
  const priorFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "test";
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return fakeAnthropicStream("Answer");
  };
  const res = responseRecorder();
  await handler({ method: "POST", body: { tab: "plan", company: "apple", filters: { quarterIndexes: [4, 5, 6], scenario: { scenario: "downside", revenueGrowth: 0, grossMarginDelta: -2, opexGrowth: 5, decision: { initialInvestment: 1000, annualBenefit: 400, annualRunCost: 100, years: 5, discountRate: 10 } } }, question: "Explain this scenario and investment case." } }, res);
  globalThis.fetch = priorFetch;
  if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorKey;
  assert.equal(findEvent(res, "done").meta.route, "company_source");
  assert.match(requestBody.system, /user-visible modeled FP&A scenario/);
  assert.match(requestBody.system, /"scenario":"downside"/);
  assert.match(requestBody.system, /"basePeriod":"Q3 FY26"/);
  assert.match(requestBody.system, /"modeledNextQuarter"/);
  assert.match(requestBody.system, /"operatingMarginPct"/);
  assert.match(requestBody.system, /"investmentDecisionModel"/);
  assert.match(requestBody.system, /"npv":137\.23/);
  assert.match(requestBody.system, /"clearsHurdle":true/);
  assert.match(requestBody.system, /illustrative pre-tax unlevered model/);
});

test("standardized reports use selected company evidence, including Apple", async () => {
  const priorKey = process.env.ANTHROPIC_API_KEY;
  const priorFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "test";
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return fakeAnthropicStream("Answer");
  };
  const res = responseRecorder();
  await handler({ method: "POST", body: { tab: "reports", company: "apple", filters: { quarterIndexes: [4, 5, 6] }, question: "Draft the FP&A performance report." } }, res);
  globalThis.fetch = priorFetch;
  if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorKey;
  assert.equal(findEvent(res, "done").meta.route, "company_source");
  assert.match(requestBody.system, /Dashboard AI for Apple \(AAPL\)/);
  assert.match(requestBody.system, /"tab":"reports"/);
  assert.match(requestBody.system, /fiscalYtdMetrics/);
});

test("NVIDIA exact filed fiscal YTD values reconcile to the six-month filing", () => {
  const companies = JSON.parse(readFileSync(new URL("../companies.json", import.meta.url), "utf8"));
  const latest = companies.companies.nvidia.periods.at(-1);
  assert.equal(latest.label, "Q2 FY27");
  assert.equal(latest.fiscalYtdMetrics.revenue, 177837);
  assert.equal(latest.fiscalYtdMetrics.netIncome, 118010);
  assert.equal(latest.fiscalYtdMetrics.grossProfit, 133299);
  assert.equal(latest.fiscalYtdMetrics.operatingIncome, 117270);
});

test("official public context is auditable and bounded", () => {
  const context = JSON.parse(readFileSync(new URL("../company-context.json", import.meta.url), "utf8"));
  assert.equal(Object.keys(context.companies).length, 11);
  assert.deepEqual(Object.values(context.macro).map(source => source.status), ["connected", "connected", "connected"]);
  for (const company of Object.values(context.companies)) {
    assert.ok(company.irUrl?.startsWith("https://"));
    assert.equal(company.coverage.internalPlan, false);
    assert.equal(company.coverage.analystConsensus, false);
    assert.equal(company.coverage.stockPrices, false);
    assert.equal(company.coverage.annualReport, true);
    assert.equal(company.annualReport.sourceType, "SEC 10-K annual report");
    assert.equal(company.annualReport.evidence.length, 8);
    assert.ok(company.annualReport.url.startsWith("https://www.sec.gov/Archives/edgar/data/"));
    assert.ok(company.annualReport.evidence.every(item => item.fiscalYear && item.filed && item.url));
    for (const signal of company.managementSignals) {
      assert.ok(signal.url.startsWith("https://"));
      assert.ok(signal.filed);
      assert.ok(signal.text.length <= 260);
    }
  }
});

test("browser UI is one unified assistant (no manual mode toggle) and sends structured filters", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const companyUi = readFileSync(new URL("../company-dashboard.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /data-ai-mode=/);
  assert.match(html, /streamText/);
  assert.match(html, /ai-followups/);
  assert.match(html, /quarterIndexes:\[\.\.\.state\.q\]/);
  assert.match(html, /name:"Reports"/);
  assert.match(companyUi, /Print \/ Save PDF/);
  assert.match(companyUi, /From source record to CFO decision/);
  assert.match(companyUi, /Strategic finance decision lab/i);
  assert.match(companyUi, /decisionNpv/);
  assert.match(companyUi, /Latest management signals/);
  assert.match(companyUi, /External planning context/);
  assert.match(companyUi, /View evidence/);
  assert.match(companyUi, /Annual report context/);
  assert.match(companyUi, /Open FY/);
  assert.doesNotMatch(html, /selectionPayload/);
});
