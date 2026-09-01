"use strict";

/* Standardized multi-company layer.
   Apple keeps its richer company-specific views. Every other issuer uses the
   same SEC-backed financial scaffold, with unavailable disclosures shown as
   unavailable rather than inferred. */

function selectedCompany(){
  return COMPANY_DATA?.companies?.[companySlug] || null;
}

function companyPeriods(){
  return selectedCompany()?.periods || [];
}

function parseCompanyPeriodLabel(label){
  const match=/^Q([1-4]) FY(\d{2})$/.exec(label||"");
  return match ? {quarter:+match[1], fy:+match[2]} : null;
}

function currentFiscalYtdIndexes(){
  const periods=companyPeriods();
  if(!periods.length) return [0];
  const latest=parseCompanyPeriodLabel(periods[periods.length-1].label);
  if(!latest) return [periods.length-1];
  const indexes=periods.map((period,index)=>({index,parsed:parseCompanyPeriodLabel(period.label)}))
    .filter(item=>item.parsed?.fy===latest.fy && item.parsed.quarter<=latest.quarter)
    .map(item=>item.index);
  return indexes.length ? indexes : [periods.length-1];
}

function latestCompleteFiscalYearIndexes(){
  const groups=new Map();
  companyPeriods().forEach((period,index)=>{
    const parsed=parseCompanyPeriodLabel(period.label);
    if(!parsed) return;
    if(!groups.has(parsed.fy)) groups.set(parsed.fy,[]);
    groups.get(parsed.fy).push({index,quarter:parsed.quarter});
  });
  return [...groups.entries()].sort((a,b)=>b[0]-a[0])
    .map(([fy,items])=>({fy,items:items.sort((a,b)=>a.quarter-b.quarter)}))
    .find(group=>group.items.length===4 && group.items.every((item,index)=>item.quarter===index+1)) || null;
}

function companyPeriodPresets(){
  const periods=companyPeriods();
  const latest=periods.length-1;
  const complete=latestCompleteFiscalYearIndexes();
  const current=currentFiscalYtdIndexes();
  const latestParsed=parseCompanyPeriodLabel(periods[latest]?.label);
  return {
    latest:[latest],
    all:periods.map((_,index)=>index),
    complete:complete?.items.map(item=>item.index) || [],
    current,
    completeLabel:complete?`FY${String(complete.fy).padStart(2,"0")}`:"Prior fiscal year",
    currentLabel:latestParsed?`FY${String(latestParsed.fy).padStart(2,"0")} YTD`:"Current fiscal YTD"
  };
}

function sameIndexes(set,indexes){
  return set.size===indexes.length && indexes.every(index=>set.has(index));
}

function companyPeriodAt(index){
  return companyPeriods()[index] || null;
}

function companyMetricAt(index,key){
  return companyPeriodAt(index)?.metrics?.[key] ?? null;
}

function selectedCompanyIndexes(){
  return [...state.q].sort((a,b)=>a-b).filter(index=>companyPeriodAt(index));
}

function companyMetricValues(key,indexes){
  return (indexes||selectedCompanyIndexes()).map(index=>companyMetricAt(index,key));
}

function companyMetricTotal(key,indexes){
  const values=companyMetricValues(key,indexes);
  return values.length && values.every(Number.isFinite) ? values.reduce((total,value)=>total+value,0) : null;
}

function companyMoney(value){
  return value==null ? "n/a" : B(value);
}

function companyPercent(value){
  return value==null || !Number.isFinite(value) ? "n/a" : pct(value,1);
}

function companyRatio(numeratorKey,denominatorKey,indexes){
  const numerator=companyMetricTotal(numeratorKey,indexes);
  const denominator=companyMetricTotal(denominatorKey,indexes);
  return numerator==null || !denominator ? null : 100*numerator/denominator;
}

function matchingPriorYearIndexes(indexes){
  const periods=companyPeriods();
  const mapped=(indexes||selectedCompanyIndexes()).map(index=>{
    const parsed=parseCompanyPeriodLabel(periods[index]?.label);
    if(!parsed) return null;
    return periods.findIndex(period=>{
      const candidate=parseCompanyPeriodLabel(period.label);
      return candidate?.quarter===parsed.quarter && candidate.fy===parsed.fy-1;
    });
  });
  return mapped.some(index=>index<0 || index==null) ? null : mapped;
}

function matchingPriorPeriodIndexes(indexes){
  const selected=[...(indexes||selectedCompanyIndexes())].sort((a,b)=>a-b);
  if(!selected.length || !isContiguous(selected)) return null;
  const start=selected[0]-selected.length;
  return start<0 ? null : Array.from({length:selected.length},(_,offset)=>start+offset);
}

function companyComparison(indexes){
  const yoy=matchingPriorYearIndexes(indexes);
  if(yoy) return {indexes:yoy,label:"prior year"};
  const prior=matchingPriorPeriodIndexes(indexes);
  return prior ? {indexes:prior,label:"prior period"} : null;
}

function companyMetricChange(key,indexes){
  const comparison=companyComparison(indexes);
  const currentValue=companyMetricTotal(key,indexes);
  const comparisonValue=comparison?companyMetricTotal(key,comparison.indexes):null;
  if(currentValue==null || comparisonValue==null || comparisonValue===0) return {currentValue,comparisonValue,delta:null,comparison};
  return {currentValue,comparisonValue,delta:100*(currentValue-comparisonValue)/Math.abs(comparisonValue),comparison};
}

function companySourceBadge(){
  const selected=selectedCompanyIndexes();
  const hasDerived=selected.some(index=>(companyPeriodAt(index)?.derivedMetrics||[]).length);
  return `<span class="badge">SEC sourced${hasDerived?" · derived values marked":""}</span>`;
}

function companyDownloadButton(){
  return `<button class="dlbtn" id="dlBtn"><svg class="dl-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2v7.6M4.6 6.6 8 10l3.4-3.4M2.8 12.8h10.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>Download CSV</button>`;
}

function companyHeader(title,subtitle){
  return `<div class="vhead"><h2>${escapeHtml(title)}</h2><span class="sub">${escapeHtml(subtitle||periodSub("$M"))}</span><span class="vhead-right">${companySourceBadge()}${companyDownloadButton()}</span></div>`;
}

function companyContextNote(text){
  const company=selectedCompany();
  return `<div class="note" style="margin-bottom:10px">${escapeHtml(text||`${company.name} standardized financials from SEC Company Facts. Company-specific disclosures are shown only when comparable facts are available.`)}</div>`;
}

function companyUnavailable(title,detail){
  return `<div class="card" style="min-height:150px;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;gap:8px;padding:22px">
    <span class="badge">Not available from standardized source</span>
    <h3 style="font-size:17px">${escapeHtml(title)}</h3>
    <div class="note" style="max-width:720px">${escapeHtml(detail)}</div>
  </div>`;
}

function companyHomeSections(){
  const company=selectedCompany();
  const isApple=companySlug==="apple";
  const dimensionText=isApple?"Period, product, geography, and profitability filters stay synchronized.":"Period filters stay synchronized. Product and geography controls appear only after a comparable governed source is connected.";
  return `
    <section class="home-about" aria-labelledby="howHeading">
      <div class="home-section-head"><h2 id="howHeading">How it works</h2><span>One selected company, one governed context across every tab and AI answer.</span></div>
      <div class="home-about-row">
        <div class="about-stage"><div class="about-label">1 · Select</div><strong>${escapeHtml(company.name)}</strong><span>The company selector updates the full dashboard.</span></div>
        <div class="about-stage"><div class="about-label">2 · Filter</div><strong>${escapeHtml(periodLabel())}</strong><span>${escapeHtml(dimensionText)}</span></div>
        <div class="about-stage"><div class="about-label">3 · Analyze</div><strong>Filed facts + deterministic calculations</strong><span>Revenue, variance, margin, cash, and planning views share the same evidence.</span></div>
        <div class="about-stage"><div class="about-label">4 · Ask</div><strong>Company-aware Dashboard AI</strong><span>Suggestions and answers receive the selected company, tab, period, filters, and modeled scenario.</span></div>
        <div class="about-stage"><div class="about-label">5 · Decide</div><strong>FP&A and strategic-finance output</strong><span>Export sourced actuals or clearly labeled modeled scenarios.</span></div>
      </div>
    </section>
    <section class="home-explore" aria-labelledby="useCaseHeading">
      <div class="home-section-head"><h2 id="useCaseHeading">FP&A and strategic-finance use cases</h2><span>Move from reported actuals to an evidence-backed management conversation.</span></div>
      <div class="home-explore-grid">
        <button class="explore-card" type="button" data-target="variance"><span class="explore-card-head"><span class="explore-icon"><i class="ph ph-scales"></i></span><span class="explore-copy"><span class="explore-title">Monthly and quarterly variance</span><span class="explore-desc">Separate revenue, margin, opex, cash, and timing movements.</span></span><span class="explore-open"><i class="ph ph-caret-right"></i></span></span></button>
        <button class="explore-card" type="button" data-target="plan"><span class="explore-card-head"><span class="explore-icon"><i class="ph ph-sliders-horizontal"></i></span><span class="explore-copy"><span class="explore-title">Forecast and scenario planning</span><span class="explore-desc">Stress revenue growth, gross margin, and operating expense assumptions.</span></span><span class="explore-open"><i class="ph ph-caret-right"></i></span></span></button>
        <button class="explore-card" type="button" data-target="balance"><span class="explore-card-head"><span class="explore-icon"><i class="ph ph-bank"></i></span><span class="explore-copy"><span class="explore-title">Liquidity and capital allocation</span><span class="explore-desc">Review cash, debt, working capital, buybacks, and dividends.</span></span><span class="explore-open"><i class="ph ph-caret-right"></i></span></span></button>
        <button class="explore-card" type="button" data-target="glass"><span class="explore-card-head"><span class="explore-icon"><i class="ph ph-presentation-chart"></i></span><span class="explore-copy"><span class="explore-title">Management reporting</span><span class="explore-desc">Build a concise executive narrative with risks, drivers, and decision points.</span></span><span class="explore-open"><i class="ph ph-caret-right"></i></span></span></button>
      </div>
    </section>
    <section class="home-about" aria-labelledby="aboutHeading">
      <div class="home-section-head"><h2 id="aboutHeading">About this dashboard</h2><span>Source, agentic workflow, model boundaries, and quality controls.</span></div>
      <div class="home-about-row">
        <div class="about-stage"><div class="about-label">Source</div><strong>${escapeHtml(company.name)} public filings</strong><span>SEC EDGAR · 10-Q / 10-K</span></div>
        <div class="about-stage"><div class="about-label">Governed data</div><strong>SEC Company Facts + curated sources</strong><span>Filed and derived values carry source links and labels.</span></div>
        <div class="about-stage"><div class="about-label">Finance engine</div><strong>Deterministic calculations</strong><span>YTD, margins, variance, free cash flow, and scenario math run before AI.</span></div>
        <div class="about-stage"><div class="about-label">Agentic skill</div><strong>Context → tools → checks → answer</strong><span>The skill selects evidence, applies finance rules, checks availability, and explains the result.</span></div>
        <div class="about-stage"><div class="about-label">Output</div><strong>Dashboard + CSV + Ask AI</strong><span>Every surface follows the same company and filter context.</span></div>
        <div class="about-stage"><div class="about-label">Integrity</div><strong>REAL, DERIVED, MODELED, or UNAVAILABLE</strong><span>No missing company fact is silently invented.</span></div>
      </div>
      <details class="home-details" open>
        <summary>Agentic finance stack and source notes</summary>
        <div class="flowwrap">
          <h3>A governed FP&A workflow, from source system to management decision</h3>
          <svg id="flowSvg" class="flow-svg"></svg>
          <div class="fnote">The public-company demo uses ${escapeHtml(company.name)} filings. In an enterprise FP&A deployment, the same governed flow can connect ERP actuals, planning data, HRIS, CRM, and approved management assumptions through scoped tools.</div>
        </div>
        <div class="srcgrid">
          <div class="srccard"><div class="t">Where the data comes from</div><div class="d"><b>${escapeHtml(company.name)} SEC filings</b> provide standardized actuals for ${companyPeriods().length} quarters, from ${escapeHtml(companyPeriods()[0]?.label||"n/a")} through ${escapeHtml(companyPeriods().slice(-1)[0]?.label||"n/a")}. Apple-only product, geography, guidance, and environment sources remain isolated to Apple.</div></div>
          <div class="srccard"><div class="t">What the agentic skill does</div><div class="d">The improved <b>Agent Skill</b> resolves company and fiscal context, chooses deterministic finance tools, refuses unsupported disclosures, checks source and calculation integrity, then produces a concise answer. <a href="./dashboard-builder-skill.zip" download style="color:var(--accent);font-weight:600">Download the skill</a>.</div></div>
          <div class="srccard"><div class="t">How filters propagate</div><div class="d">Company, fiscal period, tab, product, geography, and planning-scenario context flow into charts, tables, exports, and Dashboard AI. Unsupported dimensions are visibly disabled rather than ignored.</div></div>
          <div class="srccard"><div class="t">What is modeled</div><div class="d">Planning & Scenarios is explicitly <b>MODELED</b> from user-visible assumptions. Public filings do not contain an internal budget, annual operating plan, or management forecast.</div></div>
        </div>
      </details>
    </section>`;
}

function wireCompanyHomeSections(){
  document.querySelectorAll("#home .explore-card[data-target]").forEach(card=>card.addEventListener("click",()=>go(card.dataset.target)));
  const details=document.querySelector("#home .home-details");
  if(details) details.addEventListener("toggle",event=>{ if(event.target.open) requestAnimationFrame(drawFlow); });
  requestAnimationFrame(drawFlow);
}

function companyPeriodTable(metricKeys,indexes){
  const keys=metricKeys||["revenue","grossProfit","operatingIncome","netIncome","rd","operatingCashFlow","capex","freeCashFlow"];
  const labels={revenue:"Revenue",grossProfit:"Gross profit",operatingIncome:"Operating income",netIncome:"Net income",rd:"R&D",operatingCashFlow:"Operating cash",capex:"Capex",freeCashFlow:"FCF",cash:"Cash",shortTermInvestments:"Short-term investments",accountsReceivable:"Receivables",accountsPayable:"Payables",currentAssets:"Current assets",currentLiabilities:"Current liabilities",totalAssets:"Total assets",totalLiabilities:"Total liabilities",totalDebt:"Debt",repurchases:"Repurchases",dividends:"Dividends",shareBasedCompensation:"Stock compensation"};
  const rows=(indexes||selectedCompanyIndexes()).map(index=>{
    const period=companyPeriodAt(index);
    return `<tr><td>${escapeHtml(period.label)}</td><td>${escapeHtml(period.periodEnd)}</td>${keys.map(key=>{
      const value=period.metrics?.[key];
      const derived=(period.derivedMetrics||[]).includes(key);
      return `<td>${value==null?"n/a":M(value)}${derived?'<span class="unit">*</span>':""}</td>`;
    }).join("")}<td><a href="${period.source.url}" target="_blank" rel="noopener">${escapeHtml(period.source.form)}</a></td></tr>`;
  }).join("");
  return `<div class="scrollbox"><table><tr><th>Period</th><th>End</th>${keys.map(key=>`<th>${escapeHtml(labels[key]||key)}</th>`).join("")}<th>Source</th></tr>${rows}</table></div>`;
}

function renderPeerHome(v){
  const company=selectedCompany(), indexes=selectedCompanyIndexes(), latest=indexes[indexes.length-1];
  const revenue=companyMetricTotal("revenue",indexes), gross=companyMetricTotal("grossProfit",indexes), op=companyMetricTotal("operatingIncome",indexes), fcf=companyMetricTotal("freeCashFlow",indexes);
  const revenueChange=companyMetricChange("revenue",indexes), gm=companyRatio("grossProfit","revenue",indexes), om=companyRatio("operatingIncome","revenue",indexes);
  v.innerHTML=`${companyHeader(`${company.name} overview`,periodSub("$M"))}
    ${companyContextNote()}
    ${sowhat(`${company.name} generated ${companyMoney(revenue)} of revenue in ${periodLabel(indexes)}${revenueChange.delta==null?"":`, ${sgn(revenueChange.delta)}% versus the ${revenueChange.comparison.label}`}. Operating margin was ${companyPercent(om)}.`)}
    <div class="tiles">
      ${tile("Revenue",companyMoney(revenue),revenueChange.delta==null?periodLabel(indexes):`${sgn(revenueChange.delta)}% vs ${revenueChange.comparison.label}`,revenueChange.delta==null?undefined:revenueChange.delta>=0)}
      ${tile("Gross margin",companyPercent(gm),periodLabel(indexes),"neutral")}
      ${tile("Operating income",companyMoney(op),companyPercent(om)+" margin",op==null?undefined:op>=0)}
      ${tile("Free cash flow",companyMoney(fcf),"operating cash less capex",fcf==null?undefined:fcf>=0)}
    </div>
    <div class="body g2" style="height:48%">
      <div class="card"><h3>Revenue trend <span class="h3-note">filed quarter · $M</span></h3><div class="fill"><svg id="peerHomeRevenue"></svg></div></div>
      <div class="card"><h3>Profit profile <span class="h3-note">operating vs net income · $M</span></h3><div class="fill"><svg id="peerHomeProfit"></svg></div></div>
    </div>
    ${companyHomeSections()}`;
  const periods=companyPeriods();
  chartTable(document.getElementById("peerHomeRevenue"),"bar",{labels:periods.map(period=>companyChartLabel(period)),values:periods.map(period=>period.metrics.revenue),active:latest,fmt:B});
  chartTable(document.getElementById("peerHomeProfit"),"grouped",{cats:periods.map(companyChartLabel),seriesA:periods.map(period=>period.metrics.operatingIncome||0),seriesB:periods.map(period=>period.metrics.netIncome||0),nameA:"Operating income",nameB:"Net income",fmt:B});
  wireCompanyHomeSections();
}

function renderPeerGlass(v){
  const company=selectedCompany(), indexes=selectedCompanyIndexes();
  const revenue=companyMetricChange("revenue",indexes), op=companyMetricChange("operatingIncome",indexes), rd=companyMetricChange("rd",indexes);
  const gm=companyRatio("grossProfit","revenue",indexes), om=companyRatio("operatingIncome","revenue",indexes), fcf=companyMetricTotal("freeCashFlow",indexes);
  v.innerHTML=`${companyHeader(`${company.name} executive summary`,periodSub("$M"))}
    ${companyContextNote("Decision view built from comparable filed financial facts. Product mix, geography, guidance, and environmental detail appear only when the issuer files a comparable source.")}
    ${sowhat(`${company.name} revenue was ${companyMoney(revenue.currentValue)} and operating income was ${companyMoney(op.currentValue)} in ${periodLabel(indexes)}. Gross margin was ${companyPercent(gm)}.`)}
    <div class="tiles">
      ${tile("Revenue",companyMoney(revenue.currentValue),revenue.delta==null?null:`${sgn(revenue.delta)}% vs ${revenue.comparison.label}`,revenue.delta==null?undefined:revenue.delta>=0)}
      ${tile("Gross margin",companyPercent(gm),"filed / derived from filed facts","neutral")}
      ${tile("Operating margin",companyPercent(om),op.delta==null?null:`operating income ${sgn(op.delta)}%`,op.delta==null?undefined:op.delta>=0)}
      ${tile("R&D",companyMoney(rd.currentValue),rd.delta==null?"comparable change unavailable":`${sgn(rd.delta)}% vs ${rd.comparison.label}`,rd.delta==null?undefined:rd.delta<=0)}
      ${tile("Free cash flow",companyMoney(fcf),"operating cash less capex",fcf==null?undefined:fcf>=0)}
    </div>
    <div class="body g12" style="height:47%">
      <div class="card"><h3>Selected-period financials</h3>${companyPeriodTable(["revenue","grossProfit","operatingIncome","netIncome","rd","freeCashFlow"],indexes)}</div>
      ${companyUnavailable("Company-specific planning disclosures","Budgets and internal forecasts are not public filings. Ask AI can summarize the sourced figures, but it will not create or present an invented management plan as fact.")}
    </div>`;
}

function renderPeerRevenue(v){
  const company=selectedCompany(), indexes=selectedCompanyIndexes(), change=companyMetricChange("revenue",indexes);
  const periods=companyPeriods();
  v.innerHTML=`${companyHeader(`${company.name} revenue`,periodSub("$M"))}
    ${companyContextNote("Standardized total revenue from SEC filings. Product and geographic splits are unavailable unless they can be mapped consistently across issuers.")}
    ${sowhat(`${periodLabel(indexes)} revenue was ${companyMoney(change.currentValue)}${change.delta==null?"":`, ${sgn(change.delta)}% versus the ${change.comparison.label}`}.`)}
    <div class="tiles">
      ${tile("Selected-period revenue",companyMoney(change.currentValue),change.delta==null?periodLabel(indexes):`${sgn(change.delta)}% vs ${change.comparison.label}`,change.delta==null?undefined:change.delta>=0)}
      ${tile("Latest selected quarter",companyMoney(companyMetricAt(indexes[indexes.length-1],"revenue")),qLabel(indexes[indexes.length-1]),"neutral")}
      ${tile("Product mix","n/a","not standardized in SEC Company Facts")}
      ${tile("Geographic mix","n/a","not consistently comparable")}
    </div>
    <div class="body g21" style="height:50%">
      <div class="card"><h3>Quarterly revenue trend</h3><div class="note">All available filed quarters. Selected quarters are reflected in the KPIs and table.</div><div class="fill"><svg id="peerRevenueTrend"></svg></div></div>
      <div class="card"><h3>Selected quarters</h3>${companyPeriodTable(["revenue"],indexes)}</div>
    </div>`;
  chartTable(document.getElementById("peerRevenueTrend"),"bar",{labels:periods.map(companyChartLabel),values:periods.map(period=>period.metrics.revenue),active:indexes[indexes.length-1],fmt:B});
}

function companyVarianceData(indexes){
  const comparison=companyComparison(indexes);
  const definitions=[
    ["Revenue","revenue",false],["Gross profit","grossProfit",false],["Operating income","operatingIncome",false],
    ["Net income","netIncome",false],["R&D","rd",true],["Operating cash flow","operatingCashFlow",false],
    ["Capex","capex",true],["Free cash flow","freeCashFlow",false]
  ];
  return definitions.map(([label,key,expense])=>{
    const currentValue=companyMetricTotal(key,indexes);
    const comparisonValue=comparison?companyMetricTotal(key,comparison.indexes):null;
    const delta=currentValue==null||comparisonValue==null||comparisonValue===0?null:100*(currentValue-comparisonValue)/Math.abs(comparisonValue);
    return {label,key,expense,currentValue,comparisonValue,delta};
  });
}

function renderPeerVariance(v){
  const company=selectedCompany(), indexes=selectedCompanyIndexes(), comparison=companyComparison(indexes), rows=companyVarianceData(indexes);
  const chartRows=rows.filter(row=>Number.isFinite(row.delta));
  v.innerHTML=`${companyHeader(`${company.name} variance analysis`,periodSub("$M"))}
    ${companyContextNote("Filed financial variance analysis. The comparison uses the same fiscal quarters one year earlier when available, otherwise the immediately preceding period.")}
    ${sowhat(comparison?`${periodLabel(indexes)} is compared with the ${comparison.label}. ${chartRows.length} comparable financial lines are available.`:"A comparable prior period is not available for this selection.")}
    <div class="body g21" style="height:65%">
      <div class="card"><h3>Variance by financial line</h3>${chartRows.length?'<div class="fill"><svg id="peerVarianceChart"></svg></div>':emptyState("No comparable filed metrics for this selection.")}</div>
      <div class="card"><h3>Variance table</h3><div class="scrollbox"><table><tr><th>Line item</th><th>Current</th><th>${comparison?escapeHtml(comparison.label):"Comparison"}</th><th>Δ %</th></tr>
        ${rows.map(row=>`<tr><td>${escapeHtml(row.label)}</td><td>${row.currentValue==null?"n/a":M(row.currentValue)}</td><td>${row.comparisonValue==null?"n/a":M(row.comparisonValue)}</td><td>${row.delta==null?"n/a":sgn(row.delta)+"%"}</td></tr>`).join("")}</table></div></div>
    </div>`;
  if(chartRows.length) chartTable(document.getElementById("peerVarianceChart"),"diverging",{names:chartRows.map(row=>row.label),values:chartRows.map(row=>row.delta),fmt:value=>sgn(value)+"%"});
}

function renderPeerProfit(v){
  const company=selectedCompany(), indexes=selectedCompanyIndexes(), periods=companyPeriods();
  const revenue=companyMetricTotal("revenue",indexes), gross=companyMetricTotal("grossProfit",indexes), op=companyMetricTotal("operatingIncome",indexes), net=companyMetricTotal("netIncome",indexes), rd=companyMetricTotal("rd",indexes);
  const gm=companyRatio("grossProfit","revenue",indexes), om=companyRatio("operatingIncome","revenue",indexes), nm=companyRatio("netIncome","revenue",indexes), rdPct=companyRatio("rd","revenue",indexes);
  v.innerHTML=`${companyHeader(`${company.name} profitability & opex`,periodSub("$M"))}
    ${companyContextNote("Comparable profitability and R&D facts from SEC filings. SG&A is not shown when it cannot be mapped consistently.")}
    ${sowhat(`${periodLabel(indexes)} gross margin was ${companyPercent(gm)}, operating margin was ${companyPercent(om)}, and R&D was ${companyMoney(rd)}.`)}
    <div class="tiles">
      ${tile("Gross profit",companyMoney(gross),companyPercent(gm)+" margin",gross==null?undefined:gross>=0)}
      ${tile("Operating income",companyMoney(op),companyPercent(om)+" margin",op==null?undefined:op>=0)}
      ${tile("Net income",companyMoney(net),companyPercent(nm)+" margin",net==null?undefined:net>=0)}
      ${tile("R&D",companyMoney(rd),companyPercent(rdPct)+" of revenue","neutral")}
    </div>
    <div class="body g2" style="height:48%">
      <div class="card"><h3>Operating and net income</h3><div class="fill"><svg id="peerProfitIncome"></svg></div></div>
      <div class="card"><h3>R&D trend</h3><div class="fill"><svg id="peerProfitRd"></svg></div></div>
    </div>`;
  chartTable(document.getElementById("peerProfitIncome"),"grouped",{cats:periods.map(companyChartLabel),seriesA:periods.map(period=>period.metrics.operatingIncome||0),seriesB:periods.map(period=>period.metrics.netIncome||0),nameA:"Operating income",nameB:"Net income",fmt:B});
  const rdPeriods=periods.filter(period=>Number.isFinite(period.metrics.rd));
  if(rdPeriods.length) chartTable(document.getElementById("peerProfitRd"),"bar",{labels:rdPeriods.map(companyChartLabel),values:rdPeriods.map(period=>period.metrics.rd),fmt:B});
}

function renderPeerBalance(v){
  const company=selectedCompany(), indexes=selectedCompanyIndexes(), latest=indexes[indexes.length-1];
  const cash=companyMetricAt(latest,"cash"), investments=companyMetricAt(latest,"shortTermInvestments"), debt=companyMetricAt(latest,"totalDebt"), receivables=companyMetricAt(latest,"accountsReceivable"), payables=companyMetricAt(latest,"accountsPayable");
  const currentAssets=companyMetricAt(latest,"currentAssets"), currentLiabilities=companyMetricAt(latest,"currentLiabilities"), currentRatio=currentAssets!=null&&currentLiabilities?currentAssets/currentLiabilities:null;
  v.innerHTML=`${companyHeader(`${company.name} balance sheet · AR/AP`,`${qLabel(latest)} · point in time · $M`)}
    ${companyContextNote("Point-in-time balance-sheet facts from the latest selected filing. Values are never summed across quarters.")}
    ${sowhat(`${qLabel(latest)} cash was ${companyMoney(cash)}, reported debt was ${companyMoney(debt)}, and the current ratio was ${currentRatio==null?"unavailable":currentRatio.toFixed(2)+"x"}.`)}
    <div class="tiles">
      ${tile("Cash & equivalents",companyMoney(cash),qLabel(latest),"neutral")}
      ${tile("Short-term investments",companyMoney(investments),investments==null?"not consistently filed":qLabel(latest),"neutral")}
      ${tile("Total debt",companyMoney(debt),debt==null?"not consistently filed":qLabel(latest),debt==null?undefined:false)}
      ${tile("Accounts receivable",companyMoney(receivables),qLabel(latest),"neutral")}
      ${tile("Accounts payable",companyMoney(payables),qLabel(latest),"neutral")}
      ${tile("Current ratio",currentRatio==null?"n/a":currentRatio.toFixed(2)+"x","current assets / current liabilities","neutral")}
    </div>
    <div class="card" style="height:45%;margin-top:10px"><h3>Balance-sheet facts by selected quarter</h3>${companyPeriodTable(["cash","shortTermInvestments","accountsReceivable","accountsPayable","currentAssets","currentLiabilities","totalAssets","totalLiabilities","totalDebt"],indexes)}</div>`;
}

function renderPeerCapital(v){
  const company=selectedCompany(), indexes=selectedCompanyIndexes(), periods=companyPeriods();
  const repurchases=companyMetricTotal("repurchases",indexes), dividends=companyMetricTotal("dividends",indexes), stockComp=companyMetricTotal("shareBasedCompensation",indexes), latest=indexes[indexes.length-1], debt=companyMetricAt(latest,"totalDebt"), cash=companyMetricAt(latest,"cash");
  const capitalPeriods=periods.filter(period=>Number.isFinite(period.metrics.repurchases)||Number.isFinite(period.metrics.dividends));
  v.innerHTML=`${companyHeader(`${company.name} FX & capital returns`,periodSub("$M"))}
    ${companyContextNote("Capital-return facts are standardized from cash-flow filings. Constant-currency or FX exposure is shown only when a comparable filed metric exists.")}
    ${sowhat(`${periodLabel(indexes)} repurchases were ${companyMoney(repurchases)} and dividends paid were ${companyMoney(dividends)}. Comparable FX disclosure is not available in the standardized source.`)}
    <div class="tiles">
      ${tile("Share repurchases",companyMoney(repurchases),periodLabel(indexes),repurchases==null?undefined:false)}
      ${tile("Dividends paid",companyMoney(dividends),periodLabel(indexes),dividends==null?undefined:false)}
      ${tile("Stock compensation",companyMoney(stockComp),stockComp==null?"not consistently filed":periodLabel(indexes),"neutral")}
      ${tile("Cash",companyMoney(cash),qLabel(latest),"neutral")}
      ${tile("Debt",companyMoney(debt),qLabel(latest),debt==null?undefined:false)}
      ${tile("FX impact","n/a","not standardized across issuers")}
    </div>
    <div class="body g21" style="height:47%">
      <div class="card"><h3>Capital returns trend</h3>${capitalPeriods.length?'<div class="fill"><svg id="peerCapitalChart"></svg></div>':emptyState("No comparable capital-return facts were filed for these periods.")}</div>
      ${companyUnavailable("Comparable FX exposure","SEC Company Facts does not provide a consistent cross-company constant-currency or foreign-exchange exposure metric. This dashboard will not infer one.")}
    </div>`;
  if(capitalPeriods.length) chartTable(document.getElementById("peerCapitalChart"),"grouped",{cats:capitalPeriods.map(companyChartLabel),seriesA:capitalPeriods.map(period=>period.metrics.repurchases||0),seriesB:capitalPeriods.map(period=>period.metrics.dividends||0),nameA:"Repurchases",nameB:"Dividends",fmt:B});
}

function renderPeerPeople(v){
  const company=selectedCompany(), indexes=selectedCompanyIndexes(), periods=companyPeriods().filter(period=>Number.isFinite(period.metrics.rd));
  const rd=companyMetricTotal("rd",indexes), revenue=companyMetricTotal("revenue",indexes), ratio=rd!=null&&revenue?100*rd/revenue:null, change=companyMetricChange("rd",indexes);
  v.innerHTML=`${companyHeader(`${company.name} headcount & R&D`,periodSub("$M"))}
    ${companyContextNote("R&D expense is standardized from SEC filings. Headcount is not consistently tagged in SEC Company Facts and is therefore not estimated.")}
    ${sowhat(`${periodLabel(indexes)} R&D was ${companyMoney(rd)}, or ${companyPercent(ratio)} of revenue${change.delta==null?"":`, ${sgn(change.delta)}% versus the ${change.comparison.label}`}.`)}
    <div class="tiles">
      ${tile("R&D expense",companyMoney(rd),periodLabel(indexes),change.delta==null?undefined:change.delta<=0)}
      ${tile("R&D / revenue",companyPercent(ratio),"selected period","neutral")}
      ${tile("R&D change",change.delta==null?"n/a":sgn(change.delta)+"%",change.comparison?.label||"comparison unavailable",change.delta==null?undefined:change.delta<=0)}
      ${tile("Headcount","n/a","not standardized in SEC Company Facts")}
    </div>
    <div class="body g21" style="height:48%">
      <div class="card"><h3>Quarterly R&D trend</h3>${periods.length?'<div class="fill"><svg id="peerRdTrend"></svg></div>':emptyState("R&D is not consistently filed for this issuer.")}</div>
      ${companyUnavailable("Comparable headcount series","Employee counts are usually disclosed as annual narrative text, not a consistent quarterly Company Facts metric. Add a separately governed filing-text source before showing this series.")}
    </div>`;
  if(periods.length) chartTable(document.getElementById("peerRdTrend"),"bar",{labels:periods.map(companyChartLabel),values:periods.map(period=>period.metrics.rd),fmt:B});
}

function renderPeerOutlook(v){
  const company=selectedCompany(), indexes=selectedCompanyIndexes(), latest=indexes[indexes.length-1], periods=companyPeriods();
  const revenue=companyMetricAt(latest,"revenue"), op=companyMetricAt(latest,"operatingIncome"), gm=companyMetricAt(latest,"grossProfit")!=null&&revenue?100*companyMetricAt(latest,"grossProfit")/revenue:null, om=op!=null&&revenue?100*op/revenue:null;
  const revenueChange=companyMetricChange("revenue",[latest]);
  v.innerHTML=`${companyHeader(`${company.name} outlook`,`${qLabel(latest)} · latest filed quarter`)}
    ${companyContextNote("This view separates reported momentum from management guidance. The standardized SEC source contains filed results, not earnings-call guidance or an internal forecast.")}
    ${sowhat(`${qLabel(latest)} revenue was ${companyMoney(revenue)}${revenueChange.delta==null?"":`, ${sgn(revenueChange.delta)}% year over year`}. Gross margin was ${companyPercent(gm)} and operating margin was ${companyPercent(om)}.`)}
    <div class="tiles">
      ${tile("Latest revenue",companyMoney(revenue),revenueChange.delta==null?qLabel(latest):`${sgn(revenueChange.delta)}% YoY`,revenueChange.delta==null?undefined:revenueChange.delta>=0)}
      ${tile("Gross margin",companyPercent(gm),qLabel(latest),"neutral")}
      ${tile("Operating margin",companyPercent(om),qLabel(latest),op==null?undefined:op>=0)}
      ${tile("Formal guidance","n/a","not available from SEC Company Facts")}
      ${tile("Management quotes","n/a","requires a sourced earnings-call feed")}
    </div>
    <div class="body g21" style="height:48%">
      <div class="card"><h3>Reported revenue trajectory</h3><div class="fill"><svg id="peerOutlookRevenue"></svg></div></div>
      ${companyUnavailable("Guidance and forecast","Ask AI can interpret the filed trend above. It will not invent company guidance, budgets, or forecasts that are absent from the selected evidence.")}
    </div>`;
  chartTable(document.getElementById("peerOutlookRevenue"),"bar",{labels:periods.map(companyChartLabel),values:periods.map(period=>period.metrics.revenue),active:latest,fmt:B});
}

function renderPeerEnvironment(v){
  const company=selectedCompany(), latest=selectedCompanyIndexes().slice(-1)[0];
  v.innerHTML=`${companyHeader(`${company.name} environment`,`${qLabel(latest)} · source availability`)}
    ${companyContextNote("Environmental figures require a separately governed sustainability-report source. They are not part of the standardized SEC financial dataset.")}
    ${sowhat(`${company.name} environmental metrics are not available in this dashboard's current standardized source. No carbon, Scope 1–3, or target figure is being inferred.`)}
    <div class="tiles">
      ${tile("Scope 1","n/a","sustainability source not connected")}
      ${tile("Scope 2","n/a","sustainability source not connected")}
      ${tile("Scope 3","n/a","sustainability source not connected")}
      ${tile("Reduction target","n/a","sustainability source not connected")}
    </div>
    <div class="body g2" style="height:44%">
      ${companyUnavailable("What is needed","A company-specific sustainability report, publication date, reporting boundary, units, and calculation methodology must be ingested and cited before this tab can display figures.")}
      ${companyUnavailable("What Ask AI can do","Ask AI can explain why the data is unavailable and summarize the connected SEC financial evidence. It cannot fill this tab with unsourced environmental estimates.")}
    </div>`;
}

var planningState={scenario:"base",revenueGrowth:8,grossMarginDelta:0,opexGrowth:8};
const PLANNING_PRESETS={
  base:{revenueGrowth:8,grossMarginDelta:0,opexGrowth:8},
  upside:{revenueGrowth:15,grossMarginDelta:1,opexGrowth:10},
  downside:{revenueGrowth:0,grossMarginDelta:-2,opexGrowth:5}
};

function planningModel(){
  const indexes=selectedCompanyIndexes(), baseIndex=indexes[indexes.length-1], period=companyPeriodAt(baseIndex);
  const revenue=period?.metrics?.revenue??null, grossProfit=period?.metrics?.grossProfit??null, operatingIncome=period?.metrics?.operatingIncome??null;
  const grossMargin=revenue&&grossProfit!=null?100*grossProfit/revenue:null;
  const opex=grossProfit!=null&&operatingIncome!=null?grossProfit-operatingIncome:null;
  if(revenue==null||grossMargin==null||opex==null) return {baseIndex,period,available:false};
  const forecastRevenue=revenue*(1+planningState.revenueGrowth/100);
  const forecastGrossMargin=Math.max(0,Math.min(100,grossMargin+planningState.grossMarginDelta));
  const forecastGrossProfit=forecastRevenue*forecastGrossMargin/100;
  const forecastOpex=opex*(1+planningState.opexGrowth/100);
  const forecastOperatingIncome=forecastGrossProfit-forecastOpex;
  return {baseIndex,period,available:true,revenue,grossProfit,operatingIncome,grossMargin,opex,forecastRevenue,forecastGrossMargin,forecastGrossProfit,forecastOpex,forecastOperatingIncome,forecastOperatingMargin:forecastRevenue?100*forecastOperatingIncome/forecastRevenue:null};
}

function renderPlan(v){
  const company=selectedCompany(), model=planningModel();
  v.innerHTML=`${companyHeader(`${company.name} planning & scenarios`,model.period?`${escapeHtml(model.period.label)} actual → modeled next quarter`:"modeled scenario")}
    <div class="note" style="margin-bottom:10px"><span class="badge" style="margin-right:7px">MODELED</span>This tab is an FP&A planning scaffold. It applies visible assumptions to the latest selected filed quarter. It is not ${escapeHtml(company.name)} guidance, an internal budget, or an analyst consensus forecast.</div>
    ${model.available?sowhat(`The ${planningState.scenario} scenario produces ${companyMoney(model.forecastRevenue)} of modeled revenue and ${companyMoney(model.forecastOperatingIncome)} of modeled operating income, at a ${companyPercent(model.forecastOperatingMargin)} operating margin.`):sowhat("The selected company does not have enough comparable revenue, gross-profit, and operating-income facts to build this scenario.")}
    <div class="card" style="margin-bottom:10px;padding:14px">
      <div class="fp-head"><h3 style="margin:0">Scenario assumptions</h3><span class="badge">User-visible inputs</span></div>
      <div class="gp-presets plan-preset-row" role="group" aria-label="Scenario presets" style="margin:9px 0 12px">
        ${["downside","base","upside"].map(name=>`<button type="button" class="gp-preset" data-plan-scenario="${name}" aria-pressed="${planningState.scenario===name}">${name[0].toUpperCase()+name.slice(1)}</button>`).join("")}
      </div>
      <div class="plan-input-grid">
        <label class="cbrow plan-input"><span><b>Revenue growth</b><small style="display:block;color:var(--muted)">vs latest filed quarter</small></span><input id="planRevenueGrowth" type="number" min="-50" max="100" step="0.5" value="${planningState.revenueGrowth}"></label>
        <label class="cbrow plan-input"><span><b>Gross margin change</b><small style="display:block;color:var(--muted)">percentage points</small></span><input id="planGrossMarginDelta" type="number" min="-20" max="20" step="0.5" value="${planningState.grossMarginDelta}"></label>
        <label class="cbrow plan-input"><span><b>Operating expense growth</b><small style="display:block;color:var(--muted)">vs latest filed quarter</small></span><input id="planOpexGrowth" type="number" min="-50" max="100" step="0.5" value="${planningState.opexGrowth}"></label>
      </div>
    </div>
    ${model.available?`<div class="tiles">
      ${tile("Modeled revenue",companyMoney(model.forecastRevenue),`${sgn(planningState.revenueGrowth)}% assumption`,planningState.revenueGrowth>=0)}
      ${tile("Modeled gross margin",companyPercent(model.forecastGrossMargin),`${sgn(planningState.grossMarginDelta)} pts assumption`,planningState.grossMarginDelta>=0)}
      ${tile("Modeled operating expense",companyMoney(model.forecastOpex),`${sgn(planningState.opexGrowth)}% assumption`,planningState.opexGrowth<=0)}
      ${tile("Modeled operating income",companyMoney(model.forecastOperatingIncome),companyPercent(model.forecastOperatingMargin)+" margin",model.forecastOperatingIncome>=0)}
    </div>
    <div class="body g21" style="height:42%">
      <div class="card"><h3>Actual vs modeled next quarter</h3><div class="fill"><svg id="planComparison"></svg></div></div>
      <div class="card"><h3>Scenario bridge</h3><div class="scrollbox"><table>
        <tr><th>Metric</th><th>${escapeHtml(model.period.label)} actual</th><th>Modeled next quarter</th></tr>
        <tr><td>Revenue</td><td>${M(model.revenue)}</td><td>${M(model.forecastRevenue)}</td></tr>
        <tr><td>Gross profit</td><td>${M(model.grossProfit)}</td><td>${M(model.forecastGrossProfit)}</td></tr>
        <tr><td>Operating expense</td><td>${M(model.opex)}</td><td>${M(model.forecastOpex)}</td></tr>
        <tr><td>Operating income</td><td>${M(model.operatingIncome)}</td><td>${M(model.forecastOperatingIncome)}</td></tr>
        <tr><td>Operating margin</td><td>${companyPercent(100*model.operatingIncome/model.revenue)}</td><td>${companyPercent(model.forecastOperatingMargin)}</td></tr>
      </table></div><div class="subnote">All modeled outputs are arithmetic. Change any assumption above to recalculate.</div></div>
    </div>`:companyUnavailable("Scenario unavailable","Revenue, gross profit, and operating income are required to calculate this scenario. Missing values remain unavailable.")}`;
  document.querySelectorAll("[data-plan-scenario]").forEach(button=>button.addEventListener("click",()=>{
    planningState={scenario:button.dataset.planScenario,...PLANNING_PRESETS[button.dataset.planScenario]}; render();
  }));
  [["planRevenueGrowth","revenueGrowth"],["planGrossMarginDelta","grossMarginDelta"],["planOpexGrowth","opexGrowth"]].forEach(([id,key])=>{
    const input=document.getElementById(id); if(input) input.addEventListener("change",()=>{ planningState={...planningState,scenario:"custom",[key]:Number(input.value)||0}; render(); });
  });
  if(model.available) chartTable(document.getElementById("planComparison"),"grouped",{cats:["Revenue","Gross profit","Operating income"],seriesA:[model.forecastRevenue,model.forecastGrossProfit,model.forecastOperatingIncome],seriesB:[model.revenue,model.grossProfit,model.operatingIncome],nameA:"Modeled",nameB:"Actual",fmt:B});
}

function csvPlan(){
  const company=selectedCompany(), model=planningModel();
  const rows=model.available?[
    [company.name,model.period.label,planningState.scenario,"revenue_growth_pct",planningState.revenueGrowth,model.revenue,model.forecastRevenue,"MODELED"],
    [company.name,model.period.label,planningState.scenario,"gross_margin_change_pts",planningState.grossMarginDelta,model.grossMargin,model.forecastGrossMargin,"MODELED"],
    [company.name,model.period.label,planningState.scenario,"opex_growth_pct",planningState.opexGrowth,model.opex,model.forecastOpex,"MODELED"],
    [company.name,model.period.label,planningState.scenario,"operating_income",null,model.operatingIncome,model.forecastOperatingIncome,"MODELED"]
  ]:[];
  downloadCSV(`${companySlug}_planning_scenario_${planningState.scenario}.csv`,`MODELED FP&A scenario based on ${company.name} filed actuals. This is not company guidance or an internal budget.`,["company","base_period","scenario","driver","assumption","actual","modeled","field_basis"],rows);
}

function renderPeerTab(tab,v){
  ({home:renderPeerHome,glass:renderPeerGlass,revenue:renderPeerRevenue,variance:renderPeerVariance,profit:renderPeerProfit,balance:renderPeerBalance,fx:renderPeerCapital,people:renderPeerPeople,outlook:renderPeerOutlook,env:renderPeerEnvironment}[tab]||renderPeerHome)(v);
}

function peerMetricKeysForTab(tab){
  return {
    revenue:["revenue"], variance:["revenue","grossProfit","operatingIncome","netIncome","rd","operatingCashFlow","capex","freeCashFlow"],
    profit:["revenue","grossProfit","operatingIncome","netIncome","rd"], balance:["cash","shortTermInvestments","accountsReceivable","accountsPayable","currentAssets","currentLiabilities","totalAssets","totalLiabilities","totalDebt"],
    fx:["repurchases","dividends","shareBasedCompensation","cash","totalDebt"], people:["revenue","rd"], outlook:["revenue","grossProfit","operatingIncome"], env:[]
  }[tab] || ["revenue","grossProfit","operatingIncome","netIncome","rd","operatingCashFlow","capex","freeCashFlow"];
}

function csvPeerTab(tab){
  const company=selectedCompany(), keys=peerMetricKeysForTab(tab), indexes=selectedCompanyIndexes();
  const rows=indexes.map(index=>{
    const period=companyPeriodAt(index);
    return [company.name,company.ticker,tab,period.label,period.periodEnd,...keys.map(key=>period.metrics?.[key]??null),period.source.form,period.source.filed,period.source.url];
  });
  downloadCSV(`${companySlug}_${tab}_${periodFileTag(indexes)}.csv`, `REAL SEC-sourced company facts for ${company.name}. Derived arithmetic is marked in companies.json; unavailable values remain blank.`,
    ["company","ticker","tab","period","period_end",...keys,"form","filed","source_url"],rows);
}
