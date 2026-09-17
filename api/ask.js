// Ask AI endpoint. Dashboard mode retrieves a compact, deterministic evidence set from
// data.json; General mode receives no dashboard data. The API key always stays server-side.
import { readFileSync } from "fs";

const CURATED_DATA = JSON.parse(readFileSync(new URL("../data.json", import.meta.url), "utf8"));
const COMPANY_DATA = JSON.parse(readFileSync(new URL("../companies.json", import.meta.url), "utf8"));
let PUBLIC_CONTEXT = { companies: {}, macro: {} };
try {
  PUBLIC_CONTEXT = JSON.parse(readFileSync(new URL("../company-context.json", import.meta.url), "utf8"));
} catch {
  PUBLIC_CONTEXT = { companies: {}, macro: {} };
}
const QUARTER_COUNT = CURATED_DATA.meta.quarters.length;

const SECTION_KEYWORDS = {
  is: ["revenue", "sales", "margin", "gross", "opex", "operating income", "r&d", "rd", "sg&a", "sga", "net income", "eps", "tax", "cost of sales", "income statement", "earnings"],
  q: ["quarter", "quarterly", "q1", "q2", "q3", "q4", "trend", "yoy", "sequential", "fy25", "fy26", "2025", "2026", "annual", "full year", "history"],
  cat: ["iphone", "mac", "ipad", "wearable", "service", "category", "product", "product mix"],
  geo: ["geography", "region", "americas", "europe", "china", "japan", "asia", "segment"],
  bs: ["balance sheet", "receivable", "payable", "inventory", "asset", "liability", "equity", "dso", "dpo", "working capital", "debt"],
  cf: ["cash flow", "cash", "free cash flow", "fcf", "capex", "depreciation", "operating cash"],
  fx: ["fx", "hedge", "currency", "foreign exchange", "derivative", "hedging"],
  cap: ["buyback", "dividend", "shares outstanding", "capital return", "repurchase"],
  hc: ["headcount", "employee", "rsu", "stock comp", "share-based", "fte", "sbc"],
  env: ["carbon", "emission", "csrd", "environment", "scope 1", "scope 2", "scope 3", "co2", "climate", "renewable", "sustainability"],
  fwd: ["guidance", "outlook", "forecast", "guide", "cfo", "ceo", "forward", "management said", "supply constraint"],
};

const TAB_SECTIONS = {
  home: ["is", "cf", "env"], revenue: ["cat", "geo", "q"], profit: ["is", "geo"],
  balance: ["bs"], fx: ["fx", "cap"], people: ["hc", "is"], outlook: ["q", "fwd", "is"],
  env: ["env"], glass: ["is", "q", "cf"], reports: ["is", "q", "cf", "bs", "cap"],
};

const BROAD_DASHBOARD_TERMS = [
  "apple", "dashboard", "company", "performance", "financial", "filing", "10-q", "10-k",
  "sec", "xbrl", "this figure", "selected figure", "these numbers", "what can you do",
];
const FILING_SEARCH_TERMS = [
  "filing", "10-q", "10-k", "sec", "xbrl", "disclosure", "tag", "maturity", "bond",
  "trading plan", "10b5-1", "commitment", "contractual", "contingency",
];
const STOP_WORDS = new Set([
  "all", "also", "and", "are", "about", "can", "could", "current", "did", "does", "for",
  "from", "had", "has", "have", "how", "into", "more", "most", "not", "please", "selected",
  "show", "than", "that", "the", "their", "these", "this", "those", "was", "were", "what",
  "when", "where", "which", "who", "why", "with", "would", "year", "quarter", "quarters",
  "fy25", "fy26", "2025", "2026", "q1", "q2", "q3", "q4",
]);

const SUM_FIELDS = {
  is: ["totalRev", "totalRevPY", "productsRev", "servicesRev", "totalCos", "productsCos", "servicesCos", "grossMargin", "rd", "sga", "totalOpex", "opIncome", "otherIncome", "pretax", "tax", "netIncome"],
  q: ["revenue", "opIncome"],
  cf: ["opCash", "depAmort", "sbc", "capex", "buybacks", "dividends"],
};

function cleanText(value, max = 2000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function includesAny(text, terms) {
  return terms.some(term => {
    if (term.length > 3) return text.includes(term);
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(text);
  });
}

function matchedSections(question) {
  const text = question.toLowerCase();
  return Object.entries(SECTION_KEYWORDS)
    .filter(([, keywords]) => includesAny(text, keywords))
    .map(([section]) => section);
}

function isDashboardQuestion(question, selectedText = "") {
  if (selectedText) return true;
  const text = question.toLowerCase();
  return matchedSections(text).length > 0 || includesAny(text, BROAD_DASHBOARD_TERMS);
}

function chooseSections(question, tab, selectedText = "") {
  const matched = matchedSections(question);
  if (matched.length) return matched;
  if (selectedText || includesAny(question.toLowerCase(), BROAD_DASHBOARD_TERMS)) {
    return TAB_SECTIONS[tab] || ["is"];
  }
  return [];
}

function normalizeFilters(filters = {}) {
  const rawIndexes = Array.isArray(filters.quarterIndexes) ? filters.quarterIndexes : [];
  const quarterIndexes = [...new Set(rawIndexes
    .map(Number)
    .filter(index => Number.isInteger(index) && index >= 0 && index < QUARTER_COUNT))]
    .sort((a, b) => a - b);
  const validNames = (requested, available) => {
    if (!Array.isArray(requested)) return [...available];
    const allowed = new Set(available);
    return [...new Set(requested.filter(name => allowed.has(name)))];
  };
  return {
    quarterIndexes: quarterIndexes.length ? quarterIndexes : [4, 5, 6],
    categories: validNames(filters.categories, CURATED_DATA.cat.names),
    geographies: validNames(filters.geographies, CURATED_DATA.geo.names),
  };
}

function projectAligned(value, quarterIndexes) {
  if (Array.isArray(value)) return value.length === QUARTER_COUNT ? quarterIndexes.map(index => value[index]) : value;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, projectAligned(child, quarterIndexes)]));
}

function filterNamedMap(map, selectedNames) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return map;
  const selected = new Set(selectedNames);
  return Object.fromEntries(Object.entries(map).filter(([name]) => selected.has(name)));
}

function projectSection(section, filters) {
  const source = CURATED_DATA[section];
  if (source === undefined) return undefined;
  let scoped = source;
  if (section === "cat") {
    scoped = { ...source, names: filters.categories,
      revenue: filterNamedMap(source.revenue, filters.categories),
      revenuePY: filterNamedMap(source.revenuePY, filters.categories) };
  } else if (section === "geo") {
    scoped = { ...source, names: filters.geographies,
      revenue: filterNamedMap(source.revenue, filters.geographies),
      revenuePY: filterNamedMap(source.revenuePY, filters.geographies),
      cos: filterNamedMap(source.cos, filters.geographies),
      sm: filterNamedMap(source.sm, filters.geographies),
      opInc: filterNamedMap(source.opInc, filters.geographies),
      opIncPY: filterNamedMap(source.opIncPY, filters.geographies) };
  }
  return projectAligned(scoped, filters.quarterIndexes);
}

function sumSeries(series, quarterIndexes) {
  if (!Array.isArray(series)) return null;
  let total = 0;
  for (const index of quarterIndexes) {
    if (typeof series[index] !== "number") return null;
    total += series[index];
  }
  return total;
}

function filedDilutedEps(quarterIndexes) {
  const signature = quarterIndexes.join(",");
  if (quarterIndexes.length === 1) return CURATED_DATA.is.epsDiluted[quarterIndexes[0]] ?? null;
  if (signature === "0,1,2") return CURATED_DATA.is.epsDiluted9mo?.fy25 ?? null;
  if (signature === "4,5,6") return CURATED_DATA.is.epsDiluted9mo?.fy26 ?? null;
  if (signature === "0,1,2,3") return CURATED_DATA.is.epsDilutedAnnual?.fy25 ?? null;
  return null;
}

function aggregateNamedSeries(map, names, quarterIndexes) {
  const result = {};
  for (const name of names) {
    const value = sumSeries(map?.[name], quarterIndexes);
    if (value !== null) result[name] = value;
  }
  return result;
}

// Deterministic data tools. The model receives their results instead of the whole database.
function getMetric(section, filters) {
  return { tool: "getMetric", section, values: projectSection(section, filters) };
}

function comparePeriods(section, filters) {
  return { tool: "comparePeriods", section, values: projectSection(section, filters) };
}

function getBreakdown(section, filters) {
  return { tool: "getBreakdown", section, values: projectSection(section, filters) };
}

function calculateKpi(section, filters) {
  const indexes = filters.quarterIndexes;
  if (section === "cat") {
    return { tool: "calculateKpi", section,
      selectedPeriodRevenueByCategory: aggregateNamedSeries(CURATED_DATA.cat.revenue, filters.categories, indexes),
      selectedPeriodPriorYearByCategory: aggregateNamedSeries(CURATED_DATA.cat.revenuePY, filters.categories, indexes) };
  }
  if (section === "geo") {
    return { tool: "calculateKpi", section,
      selectedPeriodRevenueByGeography: aggregateNamedSeries(CURATED_DATA.geo.revenue, filters.geographies, indexes),
      selectedPeriodPriorYearByGeography: aggregateNamedSeries(CURATED_DATA.geo.revenuePY, filters.geographies, indexes) };
  }
  const fields = SUM_FIELDS[section];
  if (!fields) return null;
  const source = CURATED_DATA[section];
  const totals = {};
  for (const field of fields) {
    const value = sumSeries(source?.[field], indexes);
    if (value !== null) totals[field] = value;
  }
  if (section === "is") {
    totals.dilutedEpsFiledForExactSelection = filedDilutedEps(indexes);
    totals.dilutedEpsNote = "Never sum quarterly EPS. Null means Apple did not file EPS for this exact selection.";
    if (totals.totalRevPY !== undefined) totals.totalRevPYNote = "totalRevPY is total net sales for the same quarters one fiscal year earlier, as filed. Use it for every prior-year revenue comparison instead of recalling a figure.";
    if (totals.totalRev) {
      totals.grossMarginPct = Math.round((1000 * totals.grossMargin) / totals.totalRev) / 10;
      totals.operatingMarginPct = Math.round((1000 * totals.opIncome) / totals.totalRev) / 10;
    }
  }
  if (section === "q") {
    const grossMargin = sumSeries(CURATED_DATA.is.grossMargin, indexes);
    if (grossMargin !== null && totals.revenue) totals.grossMarginPct = Math.round((1000 * grossMargin) / totals.revenue) / 10;
  }
  if (section === "cf" && totals.opCash !== undefined && totals.capex !== undefined) totals.freeCashFlow = totals.opCash - totals.capex;
  return { tool: "calculateKpi", section, selectedPeriodTotals: totals };
}

let XBRL_FACTS = [];
try {
  XBRL_FACTS = JSON.parse(readFileSync(new URL("./xbrl-facts.json", import.meta.url), "utf8"));
} catch {
  XBRL_FACTS = [];
}

function searchableTokens(value) {
  return String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").split(/\s+/)
    .filter(token => token.length >= 3 && !STOP_WORDS.has(token));
}

function sanitizeFact(fact) {
  const value = String(fact.value ?? "").trim();
  if (!value || value.length > 240 || /<[^>]+>/.test(value) || /textblock/i.test(fact.concept || "")) return null;
  return { concept: fact.concept, label: fact.label, value, unit: fact.unit, period: fact.period, segment: fact.segment };
}

function searchFiling(question, limit = 6) {
  const queryTokens = [...new Set(searchableTokens(question))];
  if (!queryTokens.length || !XBRL_FACTS.length) return [];
  const ranked = [];
  for (const fact of XBRL_FACTS) {
    const safeFact = sanitizeFact(fact);
    if (!safeFact) continue;
    const haystack = new Set(searchableTokens(`${safeFact.label} ${safeFact.concept} ${safeFact.segment || ""}`));
    const matched = queryTokens.filter(token => haystack.has(token));
    if (!matched.length) continue;
    ranked.push({ fact: safeFact, score: matched.length, specificity: matched.reduce((n, token) => n + token.length, 0) });
  }
  ranked.sort((a, b) => b.score - a.score || b.specificity - a.specificity);
  return ranked.slice(0, limit).map(({ fact }) => fact);
}

function sourceMetadata(quarterIndexes) {
  const sources = [];
  for (const index of quarterIndexes) {
    const label = CURATED_DATA.meta.quarters[index];
    const source = CURATED_DATA.meta.sources[label];
    if (source) sources.push({ label, ...source });
  }
  if (quarterIndexes.includes(3) && CURATED_DATA.meta.sources["FY25 10-K"]) {
    sources.push({ label: "FY25 10-K", ...CURATED_DATA.meta.sources["FY25 10-K"] });
  }
  return sources;
}

function buildDashboardEvidence(question, selectedText, tab, rawFilters) {
  const filters = normalizeFilters(rawFilters);
  const sections = chooseSections(question, tab, selectedText);
  const results = [];
  for (const section of sections) {
    const result = section === "cat" || section === "geo"
      ? getBreakdown(section, filters)
      : filters.quarterIndexes.length > 1 && ["is", "q", "cf"].includes(section)
        ? comparePeriods(section, filters)
        : getMetric(section, filters);
    if (result.values !== undefined) results.push(result);
    const kpi = calculateKpi(section, filters);
    if (kpi) results.push(kpi);
  }
  const filingFacts = includesAny(question.toLowerCase(), FILING_SEARCH_TERMS) ? searchFiling(question) : [];
  if (filingFacts.length) results.push({ tool: "searchFiling", facts: filingFacts });
  return {
    activeTab: tab || "unknown",
    activeFilters: {
      quarters: filters.quarterIndexes.map(index => CURATED_DATA.meta.quarters[index]),
      categories: filters.categories,
      geographies: filters.geographies,
    },
    selectedText: selectedText || undefined,
    units: "Dollar figures are USD millions unless a field or source says otherwise.",
    sources: sourceMetadata(filters.quarterIndexes),
    results,
  };
}

// STYLE_RULES: shared across every system prompt (dashboard, company, general) so the model reads
// the same voice regardless of which evidence it was given. Two things at once: cut the generic
// "AI assistant" padding, and actively permit real markdown structure (## headings, **bold**,
// bullets) for answers that are genuinely multi-part -- the old per-prompt rule banning headings
// entirely just pushed the model into either flattening structured answers into a wall of text, or
// (in practice) using headings anyway and having the client's markdown renderer fail to render them.
// Also standardizes the trailing NEXT:: line the client parses into follow-up suggestion chips.
const STYLE_RULES = [
  "Lead with the answer, then support it. No filler openers (\"Great question\", \"I'd be happy to help\", \"Certainly!\"), no hedging you don't mean, no em dashes or en dashes (write \"Q1 to Q3\" or \"Q1-Q3\" with a plain hyphen).",
  "Every figure you state must be copied exactly from the evidence as given (same rounding, same units). Never restate, re-round, recompute, or recall a filed number from memory. If a comparison figure is not in the evidence, say it is not in the connected data rather than supplying one.",
  "Plain, direct language, like a sharp analyst briefing a colleague, not a customer-service bot.",
  "Markdown is fine and often better: use ## headings and **bold** for a genuinely multi-part answer, plain paragraphs for a simple one. Don't force structure onto a one-fact answer.",
  "End your reply with one line, exactly: NEXT:: <question 1> | <question 2> | <question 3> -- 2 to 3 short, specific follow-up questions grounded in what you just said, not generic. This line is parsed out and never shown verbatim, so always include it, on its own line, nothing after it.",
];

function dashboardSystemPrompt(evidence) {
  return [
    "You are Dashboard AI in an Apple FP&A and CSRD dashboard.",
    "Answer only from the EVIDENCE JSON below. Never invent a number or silently use general knowledge.",
    "The backend already applied the active filters and calculated selected-period totals. Use calculateKpi results for totals instead of adding values yourself.",
    "EPS rule: use dilutedEpsFiledForExactSelection only. Never sum quarterly EPS. If it is null, say Apple did not file EPS for that exact selection.",
    "Briefly name the supporting filing or report from evidence.sources. If evidence does not cover the question, say so plainly -- you can still answer the general-knowledge part of the question, just be clear about which part isn't backed by this dashboard's data.",
    "If evidence.publicContext is present, its management signals are dated official-source excerpts, not verified causal conclusions. Macro values are external planning context, never company guidance.",
    ...STYLE_RULES,
    "EVIDENCE:", JSON.stringify(evidence),
  ].join("\n");
}

function generalSystemPrompt() {
  return [
    "You are the AI assistant embedded in a public-company finance dashboard, currently answering a question outside that dashboard's connected data.",
    "No private dashboard data or active filters were provided for this question. Answer from general knowledge and never imply that the answer came from the dashboard's sourced data.",
    "If the question requires live or current information you cannot verify, state that limitation plainly.",
    ...STYLE_RULES,
  ].join("\n");
}

function investmentNpv(initialInvestment, annualNetBenefit, years, discountRatePct) {
  const rate = discountRatePct / 100;
  let value = -initialInvestment;
  for (let year = 1; year <= years; year += 1) value += annualNetBenefit / ((1 + rate) ** year);
  return value;
}

function investmentIrr(initialInvestment, annualNetBenefit, years) {
  if (initialInvestment <= 0 || annualNetBenefit <= 0 || years < 1) return null;
  const valueAt = rate => {
    let value = -initialInvestment;
    for (let year = 1; year <= years; year += 1) value += annualNetBenefit / ((1 + rate) ** year);
    return value;
  };
  let low = -0.99;
  let high = 10;
  let lowValue = valueAt(low);
  if (lowValue * valueAt(high) > 0) return null;
  for (let step = 0; step < 100; step += 1) {
    const mid = (low + high) / 2;
    const value = valueAt(mid);
    if (lowValue * value <= 0) high = mid;
    else { low = mid; lowValue = value; }
  }
  return ((low + high) / 2) * 100;
}

function companyEvidence(companySlug, filters = {}, tab = "company") {
  const company = COMPANY_DATA.companies?.[companySlug];
  if (!company) return null;
  const requestedIndexes = Array.isArray(filters?.quarterIndexes) ? filters.quarterIndexes.filter(Number.isInteger) : [];
  const selectedPeriods = requestedIndexes.length
    ? requestedIndexes.map(index => company.periods[index]).filter(Boolean)
    : company.periods;
  const rawScenario = tab === "plan" && filters?.scenario ? filters.scenario : null;
  let planningModel = null;
  let investmentDecisionModel = null;
  if (rawScenario && selectedPeriods.length) {
    const basePeriod = selectedPeriods[selectedPeriods.length - 1];
    const revenue = basePeriod.metrics?.revenue;
    const grossProfit = basePeriod.metrics?.grossProfit;
    const operatingIncome = basePeriod.metrics?.operatingIncome;
    const revenueGrowth = Math.max(-50, Math.min(100, Number(rawScenario.revenueGrowth) || 0));
    const grossMarginDelta = Math.max(-20, Math.min(20, Number(rawScenario.grossMarginDelta) || 0));
    const opexGrowth = Math.max(-50, Math.min(100, Number(rawScenario.opexGrowth) || 0));
    if ([revenue, grossProfit, operatingIncome].every(Number.isFinite) && revenue !== 0) {
      const grossMargin = 100 * grossProfit / revenue;
      const operatingExpense = grossProfit - operatingIncome;
      const modeledRevenue = revenue * (1 + revenueGrowth / 100);
      const modeledGrossMargin = Math.max(0, Math.min(100, grossMargin + grossMarginDelta));
      const modeledGrossProfit = modeledRevenue * modeledGrossMargin / 100;
      const modeledOperatingExpense = operatingExpense * (1 + opexGrowth / 100);
      const modeledOperatingIncome = modeledGrossProfit - modeledOperatingExpense;
      planningModel = {
        basis: "MODELED arithmetic from the latest selected filed quarter",
        basePeriod: basePeriod.label,
        assumptions: { scenario: cleanText(rawScenario.scenario, 40) || "custom", revenueGrowthPct: revenueGrowth, grossMarginDeltaPts: grossMarginDelta, operatingExpenseGrowthPct: opexGrowth },
        actual: { revenue, grossProfit, grossMarginPct: grossMargin, operatingExpense, operatingIncome },
        modeledNextQuarter: { revenue: modeledRevenue, grossProfit: modeledGrossProfit, grossMarginPct: modeledGrossMargin, operatingExpense: modeledOperatingExpense, operatingIncome: modeledOperatingIncome, operatingMarginPct: modeledRevenue ? 100 * modeledOperatingIncome / modeledRevenue : null },
      };
    }
  }
  if (rawScenario?.decision) {
    const rawDecision = rawScenario.decision;
    const initialInvestment = Math.max(0, Math.min(1e9, Number(rawDecision.initialInvestment) || 0));
    const annualBenefit = Math.max(0, Math.min(1e9, Number(rawDecision.annualBenefit) || 0));
    const annualRunCost = Math.max(0, Math.min(1e9, Number(rawDecision.annualRunCost) || 0));
    const years = Math.max(1, Math.min(10, Math.round(Number(rawDecision.years) || 1)));
    const discountRatePct = Math.max(0, Math.min(50, Number(rawDecision.discountRate) || 0));
    const annualNetBenefit = annualBenefit - annualRunCost;
    const npv = investmentNpv(initialInvestment, annualNetBenefit, years, discountRatePct);
    const irrPct = investmentIrr(initialInvestment, annualNetBenefit, years);
    const paybackYears = annualNetBenefit > 0 ? initialInvestment / annualNetBenefit : null;
    const roiPct = initialInvestment > 0 ? 100 * ((annualNetBenefit * years) - initialInvestment) / initialInvestment : null;
    investmentDecisionModel = {
      basis: "MODELED pre-tax unlevered investment case from user-visible assumptions",
      assumptions: { initialInvestment, annualBenefit, annualRunCost, years, discountRatePct },
      outputs: { annualNetBenefit, npv, irrPct, paybackYears, roiPct, clearsHurdle: npv > 0 && irrPct != null && irrPct > discountRatePct },
    };
  }
  const availableMetrics = [...new Set(selectedPeriods.flatMap(period =>
    Object.entries(period.metrics || {}).filter(([, value]) => Number.isFinite(value)).map(([key]) => key)
  ))].sort();
  return {
    company: { name: company.name, ticker: company.ticker, cik: company.cik },
    dataFreshness: { generatedAt: COMPANY_DATA.generatedAt, sourceType: company.sourceType, sourceUrl: company.sourceUrl },
    availableMetrics,
    publicContext: publicContextForCompany(companySlug, tab),
    context: {
      tab,
      selectedPeriodLabels: selectedPeriods.map(period => period.label),
      scenario: rawScenario,
    },
    units: COMPANY_DATA.units,
    methodology: COMPANY_DATA.methodology,
    periods: selectedPeriods,
    planningModel,
    investmentDecisionModel,
  };
}

function publicContextForCompany(companySlug, tab = "home") {
  const context = PUBLIC_CONTEXT.companies?.[companySlug];
  if (!context) return null;
  const categoriesByTab = {
    revenue: ["Demand and revenue", "Guidance"],
    variance: ["Demand and revenue", "Margin and cost", "Investment", "Risk and supply"],
    profit: ["Margin and cost", "Investment", "Workforce"],
    balance: ["Investment", "Risk and supply"],
    fx: ["Risk and supply", "Guidance"],
    people: ["Workforce", "Investment"],
    plan: ["Guidance", "Demand and revenue", "Margin and cost", "Investment"],
  };
  const allowed = new Set(categoriesByTab[tab] || []);
  const signals = categoriesByTab[tab]
    ? (context.managementSignals || []).filter(signal => allowed.has(signal.category))
    : (context.managementSignals || []);
  const includeMacro = ["home", "glass", "variance", "plan", "fx", "outlook", "reports"].includes(tab);
  const annualAreasByTab = {
    home: ["Business and segments", "Strategy and investment", "Risk and supply"],
    glass: ["Revenue and demand", "Strategy and investment", "Liquidity and capital", "Risk and supply"],
    revenue: ["Business and segments", "Revenue and demand"],
    variance: ["Revenue and demand", "Strategy and investment", "Liquidity and capital", "Risk and supply"],
    plan: ["Revenue and demand", "Strategy and investment", "Liquidity and capital", "Risk and supply"],
    profit: ["Strategy and investment", "Workforce"],
    balance: ["Liquidity and capital", "Risk and supply"],
    fx: ["Market and FX", "Liquidity and capital"],
    people: ["Workforce", "Strategy and investment"],
    outlook: ["Strategy and investment", "Risk and supply", "Legal and regulatory"],
  };
  const annualReport = context.annualReport;
  const annualAreas = new Set(annualAreasByTab[tab] || []);
  const annualEvidence = annualReport
    ? (annualReport.evidence || []).filter(item => !annualAreas.size || annualAreas.has(item.area)).slice(0, tab === "reports" ? 8 : 5)
    : [];
  return {
    refreshedAt: PUBLIC_CONTEXT.generatedAt,
    methodology: PUBLIC_CONTEXT.methodology,
    irUrl: context.irUrl,
    coverage: context.coverage,
    managementSignals: signals.slice(0, 6),
    recentFilings: (context.recentFilings || []).slice(0, 6),
    sourceDocuments: (context.documents || []).slice(0, 3),
    annualReport: annualReport ? {
      title: annualReport.title,
      sourceType: annualReport.sourceType,
      fiscalYear: annualReport.fiscalYear,
      filed: annualReport.filed,
      url: annualReport.url,
      evidence: annualEvidence,
    } : null,
    macro: includeMacro ? PUBLIC_CONTEXT.macro : undefined,
  };
}

function companySystemPrompt(evidence) {
  return [
    `You are Dashboard AI for ${evidence.company.name} (${evidence.company.ticker}).`,
    "Use only the supplied SEC-sourced evidence. Never invent a missing value, business driver, budget, forecast, product split, or geographic split.",
    "A null value means unavailable. Metrics marked in derivedMetrics are arithmetic derivations from filed annual or year-to-date facts, not estimates.",
    "Use evidence.availableMetrics to understand the connected coverage. Supplemental SEC metrics may include inventory, goodwill, PP&E, deferred revenue, noncurrent marketable securities, SG&A, depreciation and amortization, interest, taxes, acquisitions, and stock compensation when the issuer filed them.",
    "State the data refresh timestamp from evidence.dataFreshness when the user asks how current the connected data is.",
    "evidence.publicContext contains dated official-source excerpts and macro observations. Treat managementSignals as source excerpts, not verified causal explanations. Paraphrase carefully and name the source document and filing date.",
    "evidence.publicContext.annualReport contains tab-scoped excerpts from the latest 10-K. Use them for annual business, strategy, risk, liquidity, workforce, and market-risk context. Name the fiscal year and filing date, and do not treat annual-report context as current-quarter guidance.",
    "Macro observations provide external planning context only. Never present Treasury, BLS, or ECB values as company guidance or as proof of a company-specific cause.",
    "When fiscalYtdMetrics are present for the latest selected period and the selected periods form that fiscal YTD, prefer those exact filed span values over adding rounded quarter values.",
    "Respect the active tab and selected periods in evidence.context. If a requested product, geography, guidance, headcount, FX, or environmental fact is absent, say it is unavailable in the connected source.",
    "If evidence.context.scenario is present, treat it as a user-visible modeled FP&A scenario. evidence.planningModel contains the same deterministic model displayed in the UI. Use its basePeriod, actual values, assumptions, and modeledNextQuarter outputs. Always label outputs modeled, and never present them as company guidance, consensus, or an internal budget.",
    "When evidence.investmentDecisionModel is present, use its deterministic NPV, IRR, payback, ROI, and hurdle result. State that it is an illustrative pre-tax unlevered model and identify missing approval inputs such as tax, depreciation, working capital, timing, ownership, and implementation risk.",
    "Separate what the figures show from causal explanations. If the evidence does not establish a cause, say that operational or management commentary is needed.",
    ...STYLE_RULES,
    `Evidence: ${JSON.stringify(evidence)}`,
  ].join("\n");
}

export const __test = { buildDashboardEvidence, companyEvidence, companySystemPrompt, dashboardSystemPrompt, generalSystemPrompt, isDashboardQuestion, normalizeFilters, publicContextForCompany, searchFiling };

// writeLine: one NDJSON (newline-delimited JSON) frame per event. The client reads the response
// body as a stream and JSON.parses each line -- see askAI()/streamAskAI() in index.html. Plain
// newline-delimited JSON over a normal streamed HTTP response, not SSE, since there's exactly one
// consumer (this app's own client) and no need for SSE's reconnect/event-id machinery.
function writeLine(res, obj) { res.write(JSON.stringify(obj) + "\n"); }

// Abuse guards: this endpoint spends the Anthropic key, so only this app's own pages may call it
// (production domains, this project's preview deployments, localhost) and each IP gets a small
// budget. The bucket map is per serverless instance -- a speed bump, not a hard quota.
const ALLOWED_HOSTS = new Set(["findashboard.vercel.app", "apple-dashboard-eta.vercel.app", "localhost", "127.0.0.1"]);
const PREVIEW_HOST = /^apple-dashboard-[a-z0-9-]+-govindwaghmare93-3021s-projects\.vercel\.app$/;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 20;
const rateBuckets = new Map();

function allowedOrigin(req) {
  const source = req.headers?.origin || req.headers?.referer;
  if (!source) return false;
  try {
    const { hostname } = new URL(source);
    return ALLOWED_HOSTS.has(hostname) || PREVIEW_HOST.test(hostname);
  } catch { return false; }
}

function withinLimit(req) {
  const ip = String(req.headers?.["x-vercel-forwarded-for"] || req.headers?.["x-real-ip"] || "unknown").split(",")[0].trim();
  const now = Date.now();
  if (rateBuckets.size > 5000) for (const [key, bucket] of rateBuckets) if (bucket.resetAt < now) rateBuckets.delete(key);
  const current = rateBuckets.get(ip);
  if (!current || current.resetAt < now) { rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS }); return true; }
  if (current.count >= RATE_MAX) return false;
  current.count += 1;
  return true;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "method_not_allowed" }); return; }
  if (!allowedOrigin(req)) { res.status(403).json({ error: "forbidden" }); return; }
  if (!withinLimit(req)) { res.setHeader("Retry-After", "60"); res.status(429).json({ error: "rate_limited" }); return; }

  const { question: rawQuestion, selectedText: rawSelectedText, tab, filters } = req.body || {};
  const question = cleanText(rawQuestion);
  const selectedText = cleanText(rawSelectedText, 600);
  const selectedCompany = cleanText(req.body?.company, 40) || "apple";
  const selectedCompanyEvidence = selectedCompany !== "apple" || tab === "company" || tab === "plan" || tab === "reports"
    ? companyEvidence(selectedCompany, filters, tab)
    : null;
  if (!question) { res.status(400).json({ error: "missing_question" }); return; }

  // One unified assistant, not a manual Dashboard/General toggle: dashboard evidence is attached
  // whenever the question (or the active tab/company context) is actually dashboard-relevant, and
  // skipped otherwise -- the model still answers, just from general knowledge, instead of the old
  // behavior of rejecting the question locally and telling the user to go flip a switch.
  // knownSecCompany guards the buildDashboardEvidence() fallback below, which is *always* Apple's
  // curated data regardless of which company string was passed in -- without this check, asking a
  // dashboard-flavored question (e.g. "what's the revenue?") while a company with no SEC filings
  // is selected (OpenAI, Anthropic) would silently attach Apple's real financials to the answer.
  const knownSecCompany = Boolean(COMPANY_DATA.companies?.[selectedCompany]);
  const dashboardRelevant = knownSecCompany && (Boolean(selectedCompanyEvidence) || isDashboardQuestion(question, selectedText));
  const mode = dashboardRelevant ? "dashboard" : "general";
  const route = selectedCompanyEvidence ? "company_source" : dashboardRelevant ? "dashboard_tools" : "general";

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(200).json({ error: "no_key" }); return; }

  const evidence = dashboardRelevant
    ? (selectedCompanyEvidence || { ...buildDashboardEvidence(question, selectedText, tab, filters), publicContext: publicContextForCompany(selectedCompany, tab) })
    : null;
  const system = dashboardRelevant ? (selectedCompanyEvidence ? companySystemPrompt(evidence) : dashboardSystemPrompt(evidence)) : generalSystemPrompt();
  const userMessage = selectedText ? `Selected dashboard text: ${selectedText}\n\nQuestion: ${question}` : question;

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  // This status line reports real work already done above (evidence assembly), not a fake
  // "searching..." animation -- there is no live search or tool loop in this pipeline, so the
  // client only ever shows activity that actually happened.
  writeLine(res, {
    type: "status", stage: "evidence", mode,
    detail: selectedCompanyEvidence ? `Reading ${selectedCompanyEvidence.company.name}'s filed evidence...`
      : dashboardRelevant ? "Matching evidence in the connected dashboard data..."
      : "No dashboard match -- answering from general knowledge...",
  });

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01",
        ...(process.env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } : {}),
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: dashboardRelevant ? 560 : 620,
        system,
        messages: [{ role: "user", content: userMessage }],
        stream: true,
      }),
    });
    if (!upstream.ok || !upstream.body) {
      let detail = String(upstream.status);
      try { detail = (await upstream.json())?.error?.message || detail; } catch { /* body wasn't JSON */ }
      writeLine(res, { type: "error", error: "api_error", detail });
      res.end();
      return;
    }
    writeLine(res, { type: "status", stage: "model", mode, detail: "Asking Claude..." });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    const usage = { input_tokens: null, output_tokens: null };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // last element may be a partial line -- keep it for the next chunk
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr || dataStr === "[DONE]") continue;
        let event;
        try { event = JSON.parse(dataStr); } catch { continue; }
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          fullText += event.delta.text;
          // House style bans em and en dashes; the model still emits them in headings and ranges,
          // so normalize deterministically here instead of relying on the prompt alone.
          writeLine(res, { type: "delta", text: event.delta.text.replace(/\s*[\u2014\u2013]\s*/g, " - ") });
        } else if (event.type === "message_start" && event.message?.usage) {
          usage.input_tokens = event.message.usage.input_tokens ?? usage.input_tokens;
        } else if (event.type === "message_delta" && event.usage) {
          usage.output_tokens = event.usage.output_tokens ?? usage.output_tokens;
        }
      }
    }
    if (!fullText) {
      writeLine(res, { type: "error", error: "api_error", detail: "empty answer, try again" });
    } else {
      writeLine(res, { type: "done", meta: { mode, route, systemChars: system.length, usage } });
    }
    res.end();
  } catch (error) {
    writeLine(res, { type: "error", error: "network_error", detail: String(error).slice(0, 200) });
    res.end();
  }
}
