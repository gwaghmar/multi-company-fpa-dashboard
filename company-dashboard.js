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

function selectedIndexesAreFiscalYtd(indexes){
  const selected=[...(indexes||selectedCompanyIndexes())].sort((a,b)=>a-b);
  const periods=companyPeriods();
  if(!selected.length) return false;
  const last=parseCompanyPeriodLabel(periods[selected[selected.length-1]]?.label);
  if(!last) return false;
  const expected=periods.map((period,index)=>({index,parsed:parseCompanyPeriodLabel(period.label)}))
    .filter(item=>item.parsed?.fy===last.fy && item.parsed.quarter<=last.quarter)
    .map(item=>item.index);
  return sameIndexes(new Set(selected),expected);
}

function companyMetricTotal(key,indexes){
  const selected=[...(indexes||selectedCompanyIndexes())].sort((a,b)=>a-b);
  if(selectedIndexesAreFiscalYtd(selected)){
    const exact=companyPeriodAt(selected[selected.length-1])?.fiscalYtdMetrics?.[key];
    if(Number.isFinite(exact)) return exact;
  }
  const values=companyMetricValues(key,selected);
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

function selectedPublicContext(){
  return PUBLIC_CONTEXT?.companies?.[companySlug]||null;
}

function publicContextDate(value){
  if(!value) return "date unavailable";
  const date=new Date(`${String(value).slice(0,10)}T12:00:00Z`);
  return Number.isNaN(date.getTime())?String(value):date.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric",timeZone:"UTC"});
}

function publicContextLink(url,label){
  return url?`<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label)} <i class="ph ph-arrow-up-right" aria-hidden="true"></i></a>`:"";
}

function managementSignalsHTML(options={}){
  const context=selectedPublicContext();
  const categories=new Set(options.categories||[]);
  const signals=(context?.managementSignals||[]).filter(signal=>!categories.size||categories.has(signal.category)).slice(0,options.limit||3);
  if(!signals.length) return `<section class="evidence-strip evidence-empty"><div><span class="section-kicker">Official source context</span><h2>${escapeHtml(options.title||"Latest management signals")}</h2></div><p>No relevant management excerpt is available from the connected SEC documents. The dashboard will not infer one.</p></section>`;
  const links=[...(context?.documents||[]).slice(0,2).map(document=>publicContextLink(document.url,`${document.sourceType} · ${publicContextDate(document.filed)}`)),publicContextLink(context?.irUrl,`${selectedCompany().name} investor relations`)].filter(Boolean);
  return `<section class="evidence-strip" aria-label="Official source context">
    <div class="evidence-strip-head"><div><span class="section-kicker">Official source context</span><h2>${escapeHtml(options.title||"Latest management signals")}</h2></div><span>Source excerpts, not causal conclusions</span></div>
    <div class="evidence-grid">${signals.map(signal=>`<article class="evidence-signal"><span>${escapeHtml(signal.category)}</span><p>${escapeHtml(signal.text)}</p><small>${publicContextLink(signal.url,`${signal.sourceType} · ${publicContextDate(signal.filed)}`)}</small></article>`).join("")}</div>
    <details class="evidence-details"><summary>View evidence</summary><div>${links.join("")}</div></details>
  </section>`;
}

const ANNUAL_AREAS_BY_TAB={
  home:["Business and segments","Strategy and investment","Risk and supply"],
  glass:["Revenue and demand","Strategy and investment","Liquidity and capital","Risk and supply"],
  revenue:["Business and segments","Revenue and demand"],
  variance:["Revenue and demand","Strategy and investment","Liquidity and capital","Risk and supply"],
  plan:["Revenue and demand","Strategy and investment","Liquidity and capital","Risk and supply"],
  profit:["Strategy and investment","Workforce"],
  balance:["Liquidity and capital","Risk and supply"],
  fx:["Market and FX","Liquidity and capital"],
  people:["Workforce","Strategy and investment"],
  outlook:["Strategy and investment","Risk and supply","Legal and regulatory"]
};

function annualReportHTML(options={}){
  const annual=selectedPublicContext()?.annualReport;
  if(!annual?.evidence?.length) return "";
  const areas=new Set(options.areas||ANNUAL_AREAS_BY_TAB[options.tab||current]||[]);
  const evidence=annual.evidence.filter(item=>!areas.size||areas.has(item.area)).slice(0,options.limit||4);
  if(!evidence.length) return "";
  return `<details class="annual-context"${options.open?" open":""}>
    <summary><span><b>Annual report context</b><small>FY${escapeHtml(annual.fiscalYear)} 10-K · filed ${publicContextDate(annual.filed)} · ${annual.evidence.length} evidence areas</small></span><i class="ph ph-caret-down" aria-hidden="true"></i></summary>
    <div class="annual-evidence-grid">${evidence.map(item=>`<article><span>${escapeHtml(item.area)}</span><p>${escapeHtml(item.text)}</p></article>`).join("")}</div>
    <div class="annual-context-foot"><span>Annual context, not current-quarter guidance or proof of causality.</span>${publicContextLink(annual.url,`Open FY${annual.fiscalYear} 10-K`)}</div>
  </details>`;
}

function macroContextHTML(title="External planning context"){
  const macro=PUBLIC_CONTEXT?.macro||{};
  const treasury=macro.treasury||{}, labor=macro.labor||{}, fx=macro.fx||{};
  const cells=[
    ["10Y Treasury",treasury.tenYear?`${treasury.tenYear}%`:"n/a",treasury.date,treasury.source,treasury.sourceUrl],
    ["CPI, year over year",Number.isFinite(labor.cpi?.yearOverYearPct)?`${labor.cpi.yearOverYearPct.toFixed(2)}%`:"n/a",labor.cpi?.period,labor.source,labor.sourceUrl],
    ["Unemployment",Number.isFinite(labor.unemployment?.ratePct)?`${labor.unemployment.ratePct.toFixed(1)}%`:"n/a",labor.unemployment?.period,labor.source,labor.sourceUrl],
    ["EUR / USD",Number.isFinite(fx.ratesPerEuro?.USD)?fx.ratesPerEuro.USD.toFixed(4):"n/a",fx.asOf,fx.source,fx.sourceUrl]
  ];
  return `<section class="macro-strip" aria-label="${escapeHtml(title)}"><div class="evidence-strip-head"><div><span class="section-kicker">Official macro sources</span><h2>${escapeHtml(title)}</h2></div><span>Context only, not company guidance</span></div><div class="macro-grid">${cells.map(([label,value,date,source,url])=>`<div class="macro-cell"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${publicContextLink(url,`${source||"Source"} · ${publicContextDate(date)}`)}</small></div>`).join("")}</div></section>`;
}

function reportPublicSourceAppendix(){
  const context=selectedPublicContext();
  if(!context) return "";
  const annual=context.annualReport?[{title:context.annualReport.title,sourceType:"SEC 10-K annual report",filed:context.annualReport.filed,url:context.annualReport.url}]:[];
  const rows=[...annual,...(context.documents||[]).slice(0,3),...(context.recentFilings||[]).slice(0,3).map(item=>({title:item.description||item.form,sourceType:`SEC ${item.form}`,filed:item.filed,url:item.url}))];
  return `<section class="report-public-sources"><h3>Management and public context</h3><table class="report-table"><thead><tr><th>Source</th><th>Date</th><th>Type</th><th>Evidence</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${escapeHtml(row.title||"Official source")}</td><td>${escapeHtml(row.filed||"n/a")}</td><td>${escapeHtml(row.sourceType||"SEC filing")}</td><td>${publicContextLink(row.url,"Open")}</td></tr>`).join("")}</tbody></table><p class="report-note">Official-source excerpts provide context. They do not establish the cause of a financial variance. Internal plan, consensus and market prices remain unavailable.</p></section>`;
}

function companySourceBadge(){
  const selected=selectedCompanyIndexes();
  const hasDerived=selected.some(index=>(companyPeriodAt(index)?.derivedMetrics||[]).length);
  const exactYtd=selectedIndexesAreFiscalYtd(selected)&&Object.values(companyPeriodAt(selected[selected.length-1])?.fiscalYtdMetrics||{}).some(Number.isFinite);
  const context=selectedPublicContext();
  const commentary=context?.coverage?.managementCommentary?" · commentary":"";
  const annual=context?.coverage?.annualReport?" · 10-K":"";
  return `<span class="badge">SEC sourced${exactYtd?" · exact filed YTD":hasDerived?" · derived values marked":""}${commentary}${annual}</span>`;
}

function companyDownloadButton(){
  return `<button class="dlbtn" id="dlBtn"><svg class="dl-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2v7.6M4.6 6.6 8 10l3.4-3.4M2.8 12.8h10.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>Download CSV</button>`;
}

function companyHeader(title,subtitle,opts){
  const download=opts?.download!==false;
  return `<div class="vhead"><h2>${escapeHtml(title)}</h2><span class="sub">${escapeHtml(subtitle||periodSub("$M"))}</span><span class="vhead-right">${companySourceBadge()}${download?companyDownloadButton():""}</span></div>`;
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

const COMPANY_PLANNING_SPINES={
  apple:[["Demand","Product and services mix"],["Revenue","Units, price and geography"],["Margin","Mix, memory and supply"],["Investment","R&D, people and capex"],["Cash","Working capital and returns"],["Review","Forecast, risks and actions"]],
  alphabet:[["Demand","Search, YouTube and Cloud"],["Revenue","Ads, subscriptions and usage"],["Margin","Traffic costs and infrastructure"],["Investment","AI capex and headcount"],["Cash","Liquidity and buybacks"],["Review","Forecast, risks and actions"]],
  nvidia:[["Demand","Market-platform signals"],["Revenue","Platform mix and supply"],["Margin","Product mix and capacity"],["Investment","R&D, people and capex"],["Cash","Inventory and capital returns"],["Review","Forecast, risks and actions"]],
  microsoft:[["Demand","Cloud usage and seats"],["Revenue","Azure, productivity and devices"],["Margin","Cloud mix and datacenters"],["Investment","AI capex and headcount"],["Cash","FCF and capital returns"],["Review","Forecast, risks and actions"]],
  amazon:[["Demand","Units, sellers and cloud usage"],["Revenue","Stores, ads and AWS"],["Margin","Fulfillment and infrastructure"],["Investment","Labor, logistics and capex"],["Cash","Working capital and FCF"],["Review","Forecast, risks and actions"]],
  meta:[["Demand","Engagement and ad demand"],["Revenue","Price, impressions and regions"],["Margin","Infrastructure and content"],["Investment","AI capex and Reality Labs"],["Cash","FCF and capital returns"],["Review","Forecast, risks and actions"]],
  amd:[["Demand","Data center, client and gaming"],["Revenue","Volume, price and mix"],["Margin","Product mix and supply"],["Investment","R&D and capacity"],["Cash","Inventory and FCF"],["Review","Forecast, risks and actions"]],
  broadcom:[["Demand","Semiconductor and software"],["Revenue","Bookings, renewals and mix"],["Margin","Product and software mix"],["Investment","R&D and integration"],["Cash","Debt and capital returns"],["Review","Forecast, risks and actions"]],
  oracle:[["Demand","Cloud consumption and backlog"],["Revenue","Cloud, support and license"],["Margin","Datacenter and sales capacity"],["Investment","Capex and headcount"],["Cash","Debt and capital returns"],["Review","Forecast, risks and actions"]],
  salesforce:[["Demand","Seats, usage and renewals"],["Revenue","Subscriptions and services"],["Margin","Sales capacity and efficiency"],["Investment","R&D and headcount"],["Cash","FCF and capital returns"],["Review","Forecast, risks and actions"]],
  intel:[["Demand","Client, data center and foundry"],["Revenue","Volume, price and mix"],["Margin","Utilization and product costs"],["Investment","R&D and fab capex"],["Cash","Inventory, debt and FCF"],["Review","Forecast, risks and actions"]]
};

function companySourceCoverage(){
  const context=selectedPublicContext(), commentary=Boolean(context?.coverage?.managementCommentary), workforce=(context?.managementSignals||[]).some(signal=>signal.category==="Workforce");
  return [
    ["Financial actuals","Connected","SEC filings and XBRL","connected"],
    ["Annual report context",context?.coverage?.annualReport?"Connected":"Not available",context?.annualReport?`FY${context.annualReport.fiscalYear} 10-K · 8 evidence areas`:"No latest 10-K evidence extracted",context?.coverage?.annualReport?"connected":"missing"],
    ["Guidance and management commentary",commentary?"Connected":"Not available",commentary?"Official SEC-filed earnings materials":"No relevant excerpt found in connected SEC documents",commentary?"connected":"missing"],
    ["Workforce narrative",workforce?"Partial":"Not available",workforce?"Short official-source excerpt; no internal workforce plan":"No comparable workforce excerpt found",workforce?"partial":"missing"],
    ["Sustainability",companySlug==="apple"?"Connected":"Not connected",companySlug==="apple"?"Environmental Progress Report":"Requires a governed sustainability report",companySlug==="apple"?"connected":"missing"],
    ["Market performance","Not connected","Requires a licensed price and benchmark feed","missing"]
  ];
}

const FPNA_ARCHITECTURE=[
  {label:"01 · Systems of record",icon:"ph-database",items:["ERP / general ledger","CRM and commercial","HRIS and workforce","Billing and operations"]},
  {label:"02 · Finance control layer",icon:"ph-shield-check",items:["Period and entity mappings","Chart of accounts","Master data governance","Reconciliation controls"]},
  {label:"03 · Planning engine",icon:"ph-sliders-horizontal",items:["Driver-based revenue","Workforce and opex","Capex, cash and liquidity","Scenarios and sensitivities"]},
  {label:"04 · Decision workflow",icon:"ph-git-pull-request",items:["Business-partner review","Challenge and approvals","Version and assumption log","Risks, actions and owners"]},
  {label:"05 · Finance outputs",icon:"ph-presentation-chart",items:["Management reporting","Board and strategy packs","Investor relations","Plan writeback"]}
];

const FPNA_CADENCE=[
  ["Close & certify","Controller + finance","Reconciled actuals"],
  ["Diagnose","FP&A","Variance drivers"],
  ["Reforecast","FP&A + functions","Latest estimate"],
  ["Partner review","Business leaders","Risks and opportunities"],
  ["CFO challenge","CFO staff","Trade-offs and decisions"],
  ["Communicate","Finance + IR","Management, board and market narrative"]
];

function companyFinanceArchitecture(){
  const company=selectedCompany(), spine=COMPANY_PLANNING_SPINES[companySlug]||COMPANY_PLANNING_SPINES.apple;
  return `<section class="finance-architecture" aria-labelledby="architectureHeading">
    <div class="home-section-head"><div><span class="section-kicker">Typical enterprise FP&amp;A system</span><h2 id="architectureHeading">From source record to CFO decision</h2></div><span>Illustrative reference architecture, not ${escapeHtml(company.name)}’s disclosed internal stack.</span></div>
    <div class="architecture-scroll-hint">Swipe to follow the finance system <i class="ph ph-arrow-right" aria-hidden="true"></i></div>
    <ol class="architecture-flow" tabindex="0" aria-label="Typical enterprise FP&A system stages">
      ${FPNA_ARCHITECTURE.map((stage,index)=>`<li><div class="architecture-stage-head"><i class="ph ${stage.icon}" aria-hidden="true"></i><span>${stage.label}</span></div><ul>${stage.items.map(item=>`<li>${escapeHtml(item)}</li>`).join("")}</ul>${index<FPNA_ARCHITECTURE.length-1?'<i class="ph ph-arrow-right architecture-arrow" aria-hidden="true"></i>':""}</li>`).join("")}
    </ol>
    <div class="architecture-rails">
      <div><span>COMPANY DRIVER MODEL</span><strong>${spine.slice(0,4).map(([title])=>escapeHtml(title)).join(" · ")}</strong></div>
      <div><span>CONTROLLED AI LAYER</span><strong>Explain · detect · draft · challenge</strong><small>AI never replaces reconciliations, approved assumptions, or deterministic calculations.</small></div>
    </div>
    <div class="architecture-source-note">Reference pattern informed by <a href="https://docs.oracle.com/en/cloud/saas/enterprise-performance-management-common/diepm/integration_create_overview_104x7403ef13_106x7403fada.html" target="_blank" rel="noopener">Oracle EPM</a>, <a href="https://help.sap.com/docs/SAP_S4HANA_ON-PREMISE/48f4b4785b8e45938ac44a67be8032d9/f900a12c7abf4c91957478cd6f6e48e8.html" target="_blank" rel="noopener">SAP Financial Planning</a>, and <a href="https://learn.microsoft.com/en-us/dynamics365/release-plan/2026wave1/enterprise-resource-planning/dynamics365-finance/explore-forecast-to-plan-planning-scenarios-power-bi" target="_blank" rel="noopener">Microsoft FP&amp;A planning</a>.</div>
  </section>`;
}

function companyOperatingCadence(){
  return `<section class="operating-cadence" aria-labelledby="cadenceHeading">
    <div class="home-section-head"><div><span class="section-kicker">Illustrative operating cadence</span><h2 id="cadenceHeading">How finance turns actuals into action</h2></div><span>Sequence and timing vary by company.</span></div>
    <ol class="cadence-flow">${FPNA_CADENCE.map(([phase,owner,output],index)=>`<li><span>${String(index+1).padStart(2,"0")}</span><strong>${phase}</strong><small>${owner}</small><b>${output}</b></li>`).join("")}</ol>
  </section>`;
}

function companyHomeSections(){
  const company=selectedCompany();
  const spine=COMPANY_PLANNING_SPINES[companySlug]||COMPANY_PLANNING_SPINES.apple;
  const coverage=companySourceCoverage();
  return `
    <section class="home-operating-grid" aria-label="Planning workflow and source coverage">
      <div class="home-workflow-card">
        <div class="home-section-head"><div><span class="section-kicker">Illustrative operating model</span><h2>${escapeHtml(company.name)} planning spine</h2></div><span>Tailored to public business drivers, not presented as the company’s internal process.</span></div>
        <ol class="planning-spine">
          ${spine.map(([title,detail],index)=>`<li><span class="spine-index">${String(index+1).padStart(2,"0")}</span><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></li>`).join("")}
        </ol>
        <div class="workflow-boundary"><b>Typical enterprise flow:</b> source systems → governed finance model → planning and scenarios → review and approvals → management reporting.</div>
      </div>
      <aside class="home-coverage-card" aria-labelledby="coverageHeading">
        <div class="home-section-head"><div><span class="section-kicker">Evidence boundary</span><h2 id="coverageHeading">Source coverage</h2></div><span>${escapeHtml(periodLabel())}</span></div>
        <div class="coverage-list">
          ${coverage.map(([name,status,detail,state])=>`<div class="coverage-row"><span class="coverage-dot" data-state="${state}"></span><span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(detail)}</small></span><b data-state="${state}">${escapeHtml(status)}</b></div>`).join("")}
        </div>
      </aside>
    </section>
    <section class="home-reports" aria-labelledby="reportsHeading">
      <div class="home-section-head"><div><span class="section-kicker">Decision-ready output</span><h2 id="reportsHeading">Standardized report center</h2></div><span>Fixed structures, company-aware evidence, and explicit unavailable sections.</span></div>
      <div class="report-card-grid">
        <button class="report-card" type="button" data-report="fpa"><span class="report-code">FP&amp;A / 01</span><strong>Performance Pack</strong><span>Actuals, variance, margin, opex, liquidity, risks and actions.</span><em>Open report <i class="ph ph-arrow-right"></i></em></button>
        <button class="report-card" type="button" data-report="strategy"><span class="report-code">STRATEGY / 02</span><strong>Decision Pack</strong><span>Scenario economics, investment choices, sensitivities and capital implications.</span><em>Open report <i class="ph ph-arrow-right"></i></em></button>
        <button class="report-card" type="button" data-report="ir"><span class="report-code">IR / 03</span><strong>Earnings Pack</strong><span>Reported performance, guidance, investor questions and source appendix.</span><em>Open report <i class="ph ph-arrow-right"></i></em></button>
      </div>
    </section>
    ${companyFinanceArchitecture()}
    ${companyOperatingCadence()}
    <details class="home-details">
      <summary>Data, AI and methodology</summary>
      <div class="srcgrid">
        <div class="srccard"><div class="t">Governed source layer</div><div class="d"><b>${escapeHtml(company.name)} SEC filings</b> provide ${companyPeriods().length} standardized quarters from ${escapeHtml(companyPeriods()[0]?.label||"n/a")} through ${escapeHtml(companyPeriods().slice(-1)[0]?.label||"n/a")}. Exact filed fiscal YTD facts override rounded quarter sums when available.</div></div>
        <div class="srccard"><div class="t">Planning and reporting layer</div><div class="d">Actuals, plan versions, scenario assumptions, owners, approvals, and management reports should share one finance semantic model. Public filings do not contain an internal budget or annual operating plan.</div></div>
        <div class="srccard"><div class="t">AI enrichment layer</div><div class="d">Dashboard AI receives company, period, tab, source evidence, and modeled assumptions. It can explain and draft narrative, but deterministic calculations remain authoritative.</div></div>
        <div class="srccard"><div class="t">Integrity controls</div><div class="d">Every field remains <b>FILED, DERIVED, MODELED, or UNAVAILABLE</b>. Missing guidance, headcount, FX, environmental, and market data is never silently filled. <a href="./dashboard-builder-skill.zip" download>Download the agent skill</a>.</div></div>
      </div>
    </details>`;
}

function wireCompanyHomeSections(){
  document.querySelectorAll("#home .report-card[data-report]").forEach(card=>card.addEventListener("click",()=>{
    reportState=card.dataset.report;
    go("reports");
  }));
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

function companyExecutiveOverview(){
  const indexes=selectedCompanyIndexes(), company=selectedCompany();
  const revenue=companyMetricChange("revenue",indexes), op=companyMetricChange("operatingIncome",indexes), rd=companyMetricChange("rd",indexes);
  const gm=companyRatio("grossProfit","revenue",indexes), om=companyRatio("operatingIncome","revenue",indexes);
  const observed=[
    ["Revenue",revenue.delta==null?"Comparison unavailable":`${sgn(revenue.delta)}% vs ${revenue.comparison.label}`],
    ["Gross margin",companyPercent(gm)],
    ["Operating margin",companyPercent(om)]
  ];
  const commentaryConnected=Boolean(selectedPublicContext()?.coverage?.managementCommentary);
  const watch=[
    commentaryConnected?"Official management excerpts are connected with source and date.":"No relevant management excerpt was found in the connected SEC documents.",
    rd.delta==null?"A comparable R&D movement is unavailable.":`R&D moved ${sgn(rd.delta)}% versus the ${rd.comparison.label}.`
  ];
  return `<aside class="executive-overview" aria-labelledby="executiveOverviewHeading">
    <div class="executive-overview-head"><div><span class="section-kicker">Management pulse</span><h2 id="executiveOverviewHeading">Executive overview</h2></div><span>${escapeHtml(company.ticker)}</span></div>
    <div class="overview-signal-list">${observed.map(([name,value])=>`<div><span>${escapeHtml(name)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}</div>
    <div class="overview-watch"><span>Watch next</span>${watch.map(item=>`<p>${escapeHtml(item)}</p>`).join("")}</div>
    <div class="market-context"><span><i class="ph ph-chart-line-up"></i> Market context</span><strong>Not connected</strong><small>Add a licensed stock and benchmark feed before showing return performance.</small></div>
  </aside>`;
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
    <div class="home-primary-grid">
      <div class="card home-primary-chart"><h3>Revenue trajectory <span class="h3-note">seven filed quarters · $M</span></h3><div class="fill"><svg id="peerHomeRevenue"></svg></div></div>
      ${companyExecutiveOverview()}
    </div>
    ${managementSignalsHTML({limit:3})}
    ${companyHomeSections()}`;
  const periods=companyPeriods();
  chartTable(document.getElementById("peerHomeRevenue"),"bar",{labels:periods.map(period=>companyChartLabel(period)),values:periods.map(period=>period.metrics.revenue),active:latest,fmt:B});
  wireCompanyHomeSections();
}

function renderPeerGlass(v){
  const company=selectedCompany(), indexes=selectedCompanyIndexes();
  const revenue=companyMetricChange("revenue",indexes), op=companyMetricChange("operatingIncome",indexes), rd=companyMetricChange("rd",indexes);
  const gm=companyRatio("grossProfit","revenue",indexes), om=companyRatio("operatingIncome","revenue",indexes), fcf=companyMetricTotal("freeCashFlow",indexes);
  v.innerHTML=`${companyHeader(`${company.name} executive review`,periodSub("$M"))}
    ${companyContextNote("Decision view built from comparable filed financial facts. Product mix, geography, guidance, and environmental detail appear only when the issuer files a comparable source.")}
    ${sowhat(`${company.name} revenue was ${companyMoney(revenue.currentValue)} and operating income was ${companyMoney(op.currentValue)} in ${periodLabel(indexes)}. Gross margin was ${companyPercent(gm)}.`)}
    <div class="tiles">
      ${tile("Revenue",companyMoney(revenue.currentValue),revenue.delta==null?null:`${sgn(revenue.delta)}% vs ${revenue.comparison.label}`,revenue.delta==null?undefined:revenue.delta>=0)}
      ${tile("Gross margin",companyPercent(gm),"filed / derived from filed facts","neutral")}
      ${tile("Operating margin",companyPercent(om),op.delta==null?null:`operating income ${sgn(op.delta)}%`,op.delta==null?undefined:op.delta>=0)}
      ${tile("R&D",companyMoney(rd.currentValue),rd.delta==null?"comparable change unavailable":`${sgn(rd.delta)}% vs ${rd.comparison.label}`,rd.delta==null?undefined:rd.delta<=0)}
      ${tile("Free cash flow",companyMoney(fcf),"operating cash less capex",fcf==null?undefined:fcf>=0)}
    </div>
    ${managementSignalsHTML({title:"Management context for executive review",limit:3})}
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
  const movers=[...chartRows].sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta)).slice(0,3);
  v.innerHTML=`${companyHeader(`${company.name} variance analysis`,periodSub("$M"))}
    ${companyContextNote("Filed financial variance analysis. Prior-year actuals are connected. Approved plan and latest forecast remain unavailable until a governed planning source is connected.")}
    ${sowhat(comparison?`${periodLabel(indexes)} is compared with the ${comparison.label}. ${chartRows.length} comparable financial lines are available.`:"A comparable prior period is not available for this selection.")}
    <div class="comparison-state-grid">
      <div data-state="connected"><span>Actual vs prior year</span><strong>${comparison?"Connected":"Unavailable"}</strong><small>SEC filed actuals</small></div>
      <div data-state="missing"><span>Actual vs approved plan</span><strong>Not connected</strong><small>Requires a governed planning version</small></div>
      <div data-state="missing"><span>Actual vs latest forecast</span><strong>Not connected</strong><small>Requires forecast version and timestamp</small></div>
    </div>
    ${managementSignalsHTML({title:"Signals to test against the variance",limit:3,categories:["Demand and revenue","Margin and cost","Investment","Risk and supply"]})}
    <div class="body g21" style="height:52%">
      <div class="card"><h3>Variance by financial line</h3>${chartRows.length?'<div class="fill"><svg id="peerVarianceChart"></svg></div>':emptyState("No comparable filed metrics for this selection.")}</div>
      <div class="card management-followup"><h3>Management follow-up</h3>${movers.length?`<ol>${movers.map(row=>`<li><span>${escapeHtml(row.label)}</span><strong>${sgn(row.delta)}%</strong><small>${row.expense?"Validate investment level, timing and return.":"Confirm operating driver, sustainability and forecast impact."}</small></li>`).join("")}</ol>`:emptyState("No comparable movement is available.")}<div class="action-boundary">Owners, actions and status remain unavailable until a workflow source is connected.</div></div>
    </div>
    <details class="variance-detail"><summary>View detailed variance table</summary><div class="scrollbox"><table><tr><th>Line item</th><th>Current</th><th>${comparison?escapeHtml(comparison.label):"Comparison"}</th><th>Δ %</th></tr>
      ${rows.map(row=>`<tr><td>${escapeHtml(row.label)}</td><td>${row.currentValue==null?"n/a":M(row.currentValue)}</td><td>${row.comparisonValue==null?"n/a":M(row.comparisonValue)}</td><td>${row.delta==null?"n/a":sgn(row.delta)+"%"}</td></tr>`).join("")}</table></div></details>`;
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
  v.innerHTML=`${companyHeader(`${company.name} liquidity & working capital`,`${qLabel(latest)} · point in time · $M`)}
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
  v.innerHTML=`${companyHeader(`${company.name} treasury & capital allocation`,periodSub("$M"))}
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
    ${macroContextHTML("Rates and FX context")}
    <div class="body g21" style="height:47%">
      <div class="card"><h3>Capital returns trend</h3>${capitalPeriods.length?'<div class="fill"><svg id="peerCapitalChart"></svg></div>':emptyState("No comparable capital-return facts were filed for these periods.")}</div>
      ${companyUnavailable("Comparable FX exposure","SEC Company Facts does not provide a consistent cross-company constant-currency or foreign-exchange exposure metric. This dashboard will not infer one.")}
    </div>`;
  if(capitalPeriods.length) chartTable(document.getElementById("peerCapitalChart"),"grouped",{cats:capitalPeriods.map(companyChartLabel),seriesA:capitalPeriods.map(period=>period.metrics.repurchases||0),seriesB:capitalPeriods.map(period=>period.metrics.dividends||0),nameA:"Repurchases",nameB:"Dividends",fmt:B});
}

function renderPeerPeople(v){
  const company=selectedCompany(), indexes=selectedCompanyIndexes(), periods=companyPeriods().filter(period=>Number.isFinite(period.metrics.rd));
  const rd=companyMetricTotal("rd",indexes), revenue=companyMetricTotal("revenue",indexes), ratio=rd!=null&&revenue?100*rd/revenue:null, change=companyMetricChange("rd",indexes);
  v.innerHTML=`${companyHeader(`${company.name} workforce & investment`,periodSub("$M"))}
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
  v.innerHTML=`${companyHeader(`${company.name} outlook & investor relations`,`${qLabel(latest)} · latest filed quarter`)}
    ${companyContextNote("This view separates reported momentum from official management commentary. Internal forecasts and analyst consensus remain unavailable.")}
    ${sowhat(`${qLabel(latest)} revenue was ${companyMoney(revenue)}${revenueChange.delta==null?"":`, ${sgn(revenueChange.delta)}% year over year`}. Gross margin was ${companyPercent(gm)} and operating margin was ${companyPercent(om)}.`)}
    <div class="tiles">
      ${tile("Latest revenue",companyMoney(revenue),revenueChange.delta==null?qLabel(latest):`${sgn(revenueChange.delta)}% YoY`,revenueChange.delta==null?undefined:revenueChange.delta>=0)}
      ${tile("Gross margin",companyPercent(gm),qLabel(latest),"neutral")}
      ${tile("Operating margin",companyPercent(om),qLabel(latest),op==null?undefined:op>=0)}
      ${tile("Management context",selectedPublicContext()?.coverage?.managementCommentary?"Connected":"n/a",selectedPublicContext()?.coverage?.managementCommentary?"official SEC-filed materials":"no relevant excerpt found")}
      ${tile("Internal forecast","n/a","not publicly available")}
    </div>
    ${managementSignalsHTML({title:"Latest outlook signals",limit:3,categories:["Guidance","Demand and revenue","Margin and cost","Investment","Risk and supply"]})}
    <div class="body g21" style="height:48%">
      <div class="card"><h3>Reported revenue trajectory</h3><div class="fill"><svg id="peerOutlookRevenue"></svg></div></div>
      ${companyUnavailable("Guidance and forecast","Ask AI can interpret the filed trend above. It will not invent company guidance, budgets, or forecasts that are absent from the selected evidence.")}
    </div>`;
  chartTable(document.getElementById("peerOutlookRevenue"),"bar",{labels:periods.map(companyChartLabel),values:periods.map(period=>period.metrics.revenue),active:latest,fmt:B});
}

// ENV_ORDER / envMetricLabel / envValueText: shared between the peer Environment tab renderer and
// its CSV export, so the tile list and the CSV rows can never drift out of sync with each other.
const ENV_ORDER=["scope1","scope2MarketBased","scope2LocationBased","scope3","scope3Category1","scope3Category6",
  "totalFootprint","totalFootprintLocationBased","scope3ShareOfTotal","renewableEnergyPct"];
function envMetricLabel(key){
  return {
    scope1:"Scope 1 (direct)", scope2MarketBased:"Scope 2 (market-based)", scope2LocationBased:"Scope 2 (location-based)",
    scope3:"Scope 3 (value chain)", scope3Category1:"Scope 3 – Purchased goods & services", scope3Category6:"Scope 3 – Business travel",
    totalFootprint:"Total footprint", totalFootprintLocationBased:"Total footprint (location-based)",
    scope3ShareOfTotal:"Scope 3 share of total", renewableEnergyPct:"Renewable / carbon-free energy"
  }[key]||key;
}
function envValueText(field){
  if(field.unit==="%") return pct(field.value,1);
  const v=field.value;
  return (Math.abs(v)>=1e6?(v/1e6).toFixed(2)+"M":v.toLocaleString("en-US"))+UNIT_TCO2E;
}

function renderPeerEnvironment(v){
  const company=selectedCompany(), latest=selectedCompanyIndexes().slice(-1)[0];
  const env=(ENV_CONTEXT.companies||{})[companySlug];
  if(!env){
    v.innerHTML=`${companyHeader(`${company.name} environment`,`${qLabel(latest)} · source availability`,{download:false})}
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
    return;
  }
  const tilesHTML=ENV_ORDER.filter(k=>env[k]).map(k=>{
    const f=env[k];
    const detail=[f.basis,f.note||(f.dominantCategory?`largest: ${f.dominantCategory}${f.dominantCategoryShare?` (${f.dominantCategoryShare}%)`:""}`:"")].filter(Boolean).join(" · ");
    return tile(envMetricLabel(k),envValueText(f),detail);
  }).join("");
  v.innerHTML=`${companyHeader(`${company.name} environment`,`${env.periodLabel} · company-published sustainability report`)}
    ${companyContextNote(`Sourced from ${company.name}'s ${env.reportTitle}${env.publishDate?` (published ${env.publishDate})`:""}. Curated by hand -- not part of the automated daily SEC refresh, since sustainability reports are published annually by each company, not continuously. REAL = directly stated by the company; DERIVED = simple arithmetic on REAL figures.`)}
    <div class="tiles">${tilesHTML}</div>
    <div class="body g2" style="flex:0 0 auto; height:150px">
      <div class="card"><h3>Reduction / net-zero target</h3><div class="note">${escapeHtml(env.target?.text||"Not stated in the company's report.")}</div></div>
      <div class="card"><h3>Source</h3><div class="note"><a href="${escapeHtml(env.reportUrl)}" target="_blank" rel="noopener">${escapeHtml(env.reportTitle)}</a>${env.publishDate?`, published ${escapeHtml(env.publishDate)}`:""}. Covers ${escapeHtml(env.periodLabel)}.</div></div>
    </div>
    ${env.unavailableNote?`<div class="body" style="flex:0 0 auto; height:150px; grid-template-columns:1fr">${companyUnavailable("What's not shown",env.unavailableNote)}</div>`:""}`;
}
function csvPeerEnv(){
  const company=selectedCompany(), env=(ENV_CONTEXT.companies||{})[companySlug];
  if(!env) return;
  const rows=ENV_ORDER.filter(k=>env[k]).map(k=>{
    const f=env[k];
    return [company.name,envMetricLabel(k),f.value,f.unit,f.basis,env.periodLabel,env.reportTitle,env.reportUrl];
  });
  if(env.target) rows.push([company.name,"Reduction/net-zero target",env.target.text,"",env.target.basis,env.periodLabel,env.reportTitle,env.reportUrl]);
  downloadCSV(`${companySlug}_environment_${env.periodLabel.replace(/[^A-Za-z0-9]+/g,"_")}.csv`,
    `Manually curated from ${company.name}'s own official sustainability report. Not part of the automated SEC refresh -- see environment-context.json and DATA_PROVENANCE.md.`,
    ["company","metric","value","unit","field_basis","period","source_report","source_url"],rows);
}

var planningState={scenario:"base",revenueGrowth:8,grossMarginDelta:0,opexGrowth:8};
var decisionState=null;
var reportState="fpa";
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

function decisionRound(value){
  const step=value>=10000?500:value>=2000?100:50;
  return Math.max(step,Math.round(value/step)*step);
}

function decisionDefaults(){
  const indexes=selectedCompanyIndexes(), latest=indexes[indexes.length-1];
  const revenue=companyMetricAt(latest,"revenue")||10000;
  return {initialInvestment:decisionRound(revenue*.05),annualBenefit:decisionRound(revenue*.03),annualRunCost:decisionRound(revenue*.008),years:5,discountRate:10};
}

function ensureDecisionState(){
  if(!decisionState) decisionState=decisionDefaults();
  return decisionState;
}

function decisionNpv(initialInvestment,annualNetBenefit,years,discountRate){
  const rate=discountRate/100;
  let value=-initialInvestment;
  for(let year=1;year<=years;year++) value+=annualNetBenefit/Math.pow(1+rate,year);
  return value;
}

function decisionIrr(initialInvestment,annualNetBenefit,years){
  if(initialInvestment<=0||annualNetBenefit<=0||years<1) return null;
  const valueAt=rate=>{
    let value=-initialInvestment;
    for(let year=1;year<=years;year++) value+=annualNetBenefit/Math.pow(1+rate,year);
    return value;
  };
  let low=-.99, high=10, lowValue=valueAt(low), highValue=valueAt(high);
  if(lowValue*highValue>0) return null;
  for(let step=0;step<100;step++){
    const mid=(low+high)/2, value=valueAt(mid);
    if(value===0) return mid*100;
    if(lowValue*value<=0){ high=mid; highValue=value; }
    else { low=mid; lowValue=value; }
  }
  return ((low+high)/2)*100;
}

function decisionModel(){
  const assumptions=ensureDecisionState();
  const initialInvestment=Math.max(0,Number(assumptions.initialInvestment)||0);
  const annualBenefit=Math.max(0,Number(assumptions.annualBenefit)||0);
  const annualRunCost=Math.max(0,Number(assumptions.annualRunCost)||0);
  const years=Math.max(1,Math.min(10,Math.round(Number(assumptions.years)||1)));
  const discountRate=Math.max(0,Math.min(50,Number(assumptions.discountRate)||0));
  const annualNetBenefit=annualBenefit-annualRunCost;
  const npv=decisionNpv(initialInvestment,annualNetBenefit,years,discountRate);
  const irr=decisionIrr(initialInvestment,annualNetBenefit,years);
  const payback=annualNetBenefit>0?initialInvestment/annualNetBenefit:null;
  const roi=initialInvestment>0?100*((annualNetBenefit*years)-initialInvestment)/initialInvestment:null;
  return {initialInvestment,annualBenefit,annualRunCost,annualNetBenefit,years,discountRate,npv,irr,payback,roi,attractive:npv>0&&irr!=null&&irr>discountRate};
}

function decisionSensitivity(model){
  const rates=[Math.max(0,model.discountRate-2),model.discountRate,Math.min(50,model.discountRate+2)];
  const benefits=[.8,1,1.2];
  return {rates,benefits,values:benefits.map(multiplier=>rates.map(rate=>decisionNpv(model.initialInvestment,model.annualNetBenefit*multiplier,model.years,rate)))};
}

function decisionLabHTML(){
  const company=selectedCompany(), model=decisionModel(), sensitivity=decisionSensitivity(model);
  const payback=model.payback==null?"n/a":model.payback>model.years?`>${model.years} yrs`:`${model.payback.toFixed(1)} yrs`;
  const recommendation=model.attractive?"Clears the modeled hurdle":"Does not clear the modeled hurdle";
  return `<section class="decision-lab" aria-labelledby="decisionLabHeading">
    <div class="decision-lab-head"><div><span class="section-kicker">Strategic finance decision lab</span><h2 id="decisionLabHeading">Investment case and sensitivity</h2><p>Illustrative, pre-tax and unlevered. Inputs are scaled from ${escapeHtml(company.name)}’s latest filed quarterly revenue and remain fully editable.</p></div><span class="badge">MODELED</span></div>
    <div class="decision-layout">
      <div class="decision-inputs" role="group" aria-label="Investment case assumptions">
        <label><span>Initial investment <small>$M</small></span><input id="decisionInvestment" type="number" min="0" step="50" value="${model.initialInvestment}"></label>
        <label><span>Annual gross benefit <small>$M</small></span><input id="decisionBenefit" type="number" min="0" step="50" value="${model.annualBenefit}"></label>
        <label><span>Annual run cost <small>$M</small></span><input id="decisionRunCost" type="number" min="0" step="25" value="${model.annualRunCost}"></label>
        <label><span>Useful life <small>years</small></span><input id="decisionYears" type="number" min="1" max="10" step="1" value="${model.years}"></label>
        <label><span>Discount rate <small>%</small></span><input id="decisionDiscountRate" type="number" min="0" max="50" step="0.5" value="${model.discountRate}"></label>
      </div>
      <div class="decision-result" data-attractive="${model.attractive}"><span>DECISION SIGNAL</span><strong>${recommendation}</strong><p>${model.attractive?"Modeled value creation remains positive at the selected hurdle rate.":"Revisit benefit realization, timing, cost or investment scope before approval."}</p><button type="button" id="decisionReport">Open Strategic Finance Pack <i class="ph ph-arrow-right"></i></button></div>
      <div class="decision-kpis" role="list" aria-label="Investment case results">
        <div role="listitem"><span>NPV</span><strong>${companyMoney(model.npv)}</strong><small>${model.discountRate.toFixed(1)}% hurdle</small></div>
        <div role="listitem"><span>IRR</span><strong>${model.irr==null?"n/a":companyPercent(model.irr)}</strong><small>Modeled project return</small></div>
        <div role="listitem"><span>Payback</span><strong>${payback}</strong><small>Undiscounted</small></div>
        <div role="listitem"><span>Five-year ROI</span><strong>${model.roi==null?"n/a":companyPercent(model.roi)}</strong><small>Net benefit less investment</small></div>
      </div>
    </div>
    <div class="decision-sensitivity"><div><h3>NPV sensitivity <span>$M</span></h3><p>Annual net benefit versus discount rate</p></div><div class="scrollbox"><table><thead><tr><th>Net benefit</th>${sensitivity.rates.map(rate=>`<th>${rate.toFixed(1)}%</th>`).join("")}</tr></thead><tbody>${sensitivity.values.map((row,rowIndex)=>`<tr><th>${Math.round(sensitivity.benefits[rowIndex]*100)}%</th>${row.map(value=>`<td data-value="${value>=0?"positive":"negative"}">${companyMoney(value)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div>
    <div class="decision-boundary"><b>Decision discipline:</b> validate benefit ownership, timing, tax, depreciation, working capital, implementation risk and terminal value before using this as an approval model.</div>
  </section>`;
}

function renderPlan(v){
  const company=selectedCompany(), model=planningModel();
  v.innerHTML=`${companyHeader(`${company.name} planning & scenarios`,model.period?`${escapeHtml(model.period.label)} actual → modeled next quarter`:"modeled scenario")}
    <div class="note" style="margin-bottom:10px"><span class="badge" style="margin-right:7px">MODELED</span>This tab is an FP&A planning scaffold. It applies visible assumptions to the latest selected filed quarter. It is not ${escapeHtml(company.name)} guidance, an internal budget, or an analyst consensus forecast.</div>
    ${model.available?sowhat(`The ${planningState.scenario} scenario produces ${companyMoney(model.forecastRevenue)} of modeled revenue and ${companyMoney(model.forecastOperatingIncome)} of modeled operating income, at a ${companyPercent(model.forecastOperatingMargin)} operating margin.`):sowhat("The selected company does not have enough comparable revenue, gross-profit, and operating-income facts to build this scenario.")}
    ${macroContextHTML()}
    <div class="card planning-assumptions" style="margin-bottom:10px;padding:14px">
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
    </div>`:companyUnavailable("Scenario unavailable","Revenue, gross profit, and operating income are required to calculate this scenario. Missing values remain unavailable.")}
    ${decisionLabHTML()}`;
  document.querySelectorAll("[data-plan-scenario]").forEach(button=>button.addEventListener("click",()=>{
    planningState={scenario:button.dataset.planScenario,...PLANNING_PRESETS[button.dataset.planScenario]}; render();
  }));
  [["planRevenueGrowth","revenueGrowth"],["planGrossMarginDelta","grossMarginDelta"],["planOpexGrowth","opexGrowth"]].forEach(([id,key])=>{
    const input=document.getElementById(id); if(input) input.addEventListener("change",()=>{ planningState={...planningState,scenario:"custom",[key]:Number(input.value)||0}; render(); });
  });
  [["decisionInvestment","initialInvestment"],["decisionBenefit","annualBenefit"],["decisionRunCost","annualRunCost"],["decisionYears","years"],["decisionDiscountRate","discountRate"]].forEach(([id,key])=>{
    const input=document.getElementById(id); if(input) input.addEventListener("change",()=>{ decisionState={...ensureDecisionState(),[key]:Number(input.value)||0}; render(); });
  });
  const decisionReport=document.getElementById("decisionReport");
  if(decisionReport) decisionReport.addEventListener("click",()=>{ reportState="strategy"; go("reports"); });
  if(model.available) chartTable(document.getElementById("planComparison"),"grouped",{cats:["Revenue","Gross profit","Operating income"],seriesA:[model.forecastRevenue,model.forecastGrossProfit,model.forecastOperatingIncome],seriesB:[model.revenue,model.grossProfit,model.operatingIncome],nameA:"Modeled",nameB:"Actual",fmt:B});
}

function csvPlan(){
  const company=selectedCompany(), model=planningModel(), decision=decisionModel();
  const rows=model.available?[
    [company.name,model.period.label,planningState.scenario,"revenue_growth_pct",planningState.revenueGrowth,model.revenue,model.forecastRevenue,"MODELED"],
    [company.name,model.period.label,planningState.scenario,"gross_margin_change_pts",planningState.grossMarginDelta,model.grossMargin,model.forecastGrossMargin,"MODELED"],
    [company.name,model.period.label,planningState.scenario,"opex_growth_pct",planningState.opexGrowth,model.opex,model.forecastOpex,"MODELED"],
    [company.name,model.period.label,planningState.scenario,"operating_income",null,model.operatingIncome,model.forecastOperatingIncome,"MODELED"]
  ]:[];
  rows.push(
    [company.name,model.period?.label||periodLabel(),"decision_lab","initial_investment",decision.initialInvestment,null,decision.npv,"MODELED"],
    [company.name,model.period?.label||periodLabel(),"decision_lab","annual_gross_benefit",decision.annualBenefit,null,decision.irr,"MODELED"],
    [company.name,model.period?.label||periodLabel(),"decision_lab","annual_run_cost",decision.annualRunCost,null,decision.payback,"MODELED"],
    [company.name,model.period?.label||periodLabel(),"decision_lab","discount_rate_pct",decision.discountRate,null,decision.roi,"MODELED"]
  );
  downloadCSV(`${companySlug}_planning_scenario_${planningState.scenario}.csv`,`MODELED FP&A scenario based on ${company.name} filed actuals. This is not company guidance or an internal budget.`,["company","base_period","scenario","driver","assumption","actual","modeled","field_basis"],rows);
}

const REPORT_DEFINITIONS={
  fpa:{label:"FP&A Performance Pack",code:"FP&A / 01",purpose:"Performance, variance, liquidity, risks and actions"},
  strategy:{label:"Strategic Finance Decision Pack",code:"STRATEGY / 02",purpose:"Scenario economics, sensitivities and capital implications"},
  ir:{label:"Investor Relations Earnings Pack",code:"IR / 03",purpose:"Reported performance, guidance and investor questions"}
};

function reportMetricRows(indexes){
  const comparison=companyComparison(indexes);
  return [
    ["Revenue","revenue"],["Gross profit","grossProfit"],["Operating income","operatingIncome"],
    ["Net income","netIncome"],["R&D","rd"],["Free cash flow","freeCashFlow"]
  ].map(([label,key])=>{
    const actual=companyMetricTotal(key,indexes), prior=comparison?companyMetricTotal(key,comparison.indexes):null;
    const delta=actual==null||prior==null||prior===0?null:100*(actual-prior)/Math.abs(prior);
    return {label,key,actual,prior,delta,comparison};
  });
}

function reportSourceAppendix(indexes){
  return `<table class="report-table"><thead><tr><th>Period</th><th>Filed</th><th>Form</th><th>Evidence</th></tr></thead><tbody>${indexes.map(index=>{
    const period=companyPeriodAt(index);
    return `<tr><td>${escapeHtml(period.label)}</td><td>${escapeHtml(period.source.filed||"n/a")}</td><td>${escapeHtml(period.source.form||"n/a")}</td><td><a href="${period.source.url}" target="_blank" rel="noopener">SEC filing</a></td></tr>`;
  }).join("")}</tbody></table>`;
}

function reportUnavailable(label,detail){
  return `<div class="report-callout unavailable"><span>UNAVAILABLE</span><strong>${escapeHtml(label)}</strong><p>${escapeHtml(detail)}</p></div>`;
}

function fpaReportBody(indexes,rows){
  const company=selectedCompany(), revenue=rows[0], op=rows[2], fcf=rows[5];
  return `<div class="report-columns">
    <section><h3>Executive assessment</h3><p>${escapeHtml(company.name)} reported ${companyMoney(revenue.actual)} of revenue in ${periodLabel(indexes)}${revenue.delta==null?"":`, ${sgn(revenue.delta)}% versus the ${revenue.comparison.label}`}. Operating income was ${companyMoney(op.actual)} and free cash flow was ${companyMoney(fcf.actual)}.</p></section>
    <section><h3>Management focus</h3><ul><li>Confirm the operating drivers behind the largest filed movements.</li><li>Review margin, investment and cash implications together.</li><li>Assign owners and actions after plan and forecast data is connected.</li></ul></section>
  </div>
  <section tabindex="0"><h3>Actual performance</h3><table class="report-table"><thead><tr><th>Metric</th><th>Actual</th><th>${escapeHtml(rows[0].comparison?.label||"Comparison")}</th><th>Change</th><th>Basis</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${escapeHtml(row.label)}</td><td>${companyMoney(row.actual)}</td><td>${companyMoney(row.prior)}</td><td>${row.delta==null?"n/a":sgn(row.delta)+"%"}</td><td>${selectedIndexesAreFiscalYtd(indexes)?"Exact filed YTD where available":"Filed quarter totals"}</td></tr>`).join("")}</tbody></table></section>
  <div class="report-columns">${reportUnavailable("Plan and latest forecast","Public filings do not contain the approved operating plan or latest internal forecast.")}${reportUnavailable("Owners and actions","A governed workflow source is required before names, due dates, or approval status can be shown.")}</div>`;
}

function strategyReportBody(indexes,rows){
  const company=selectedCompany(), model=planningModel(), decision=decisionModel(), latest=indexes[indexes.length-1];
  const cash=companyMetricAt(latest,"cash"), debt=companyMetricAt(latest,"totalDebt"), repurchases=companyMetricTotal("repurchases",indexes);
  return `<div class="report-columns">
    <section><h3>Decision frame</h3><p>Evaluate how changes in growth, gross margin and operating investment affect ${escapeHtml(company.name)} operating income and liquidity. This is a public-data decision scaffold, not the company’s internal strategic plan.</p></section>
    <section><h3>Capital position</h3><dl class="report-facts"><div><dt>Cash</dt><dd>${companyMoney(cash)}</dd></div><div><dt>Debt</dt><dd>${companyMoney(debt)}</dd></div><div><dt>Repurchases</dt><dd>${companyMoney(repurchases)}</dd></div></dl></section>
  </div>
  ${model.available?`<section tabindex="0"><h3>${escapeHtml(planningState.scenario)} scenario sensitivity <span>MODELED</span></h3><table class="report-table"><thead><tr><th>Driver</th><th>Actual baseline</th><th>Assumption</th><th>Modeled next quarter</th></tr></thead><tbody>
    <tr><td>Revenue</td><td>${companyMoney(model.revenue)}</td><td>${sgn(planningState.revenueGrowth)}%</td><td>${companyMoney(model.forecastRevenue)}</td></tr>
    <tr><td>Gross margin</td><td>${companyPercent(model.grossMargin)}</td><td>${sgn(planningState.grossMarginDelta)} pts</td><td>${companyPercent(model.forecastGrossMargin)}</td></tr>
    <tr><td>Operating expense</td><td>${companyMoney(model.opex)}</td><td>${sgn(planningState.opexGrowth)}%</td><td>${companyMoney(model.forecastOpex)}</td></tr>
    <tr><td>Operating income</td><td>${companyMoney(model.operatingIncome)}</td><td>Calculated</td><td>${companyMoney(model.forecastOperatingIncome)}</td></tr>
  </tbody></table><p class="report-note">All scenario values are deterministic arithmetic from the latest selected filed quarter.</p></section>`:reportUnavailable("Scenario economics","Comparable revenue, gross-profit and operating-income facts are required.")}
  <section tabindex="0"><h3>Investment decision case <span>MODELED</span></h3><table class="report-table"><thead><tr><th>Investment</th><th>Annual net benefit</th><th>NPV</th><th>IRR</th><th>Payback</th><th>Hurdle result</th></tr></thead><tbody><tr><td>${companyMoney(decision.initialInvestment)}</td><td>${companyMoney(decision.annualNetBenefit)}</td><td>${companyMoney(decision.npv)}</td><td>${decision.irr==null?"n/a":companyPercent(decision.irr)}</td><td>${decision.payback==null?"n/a":decision.payback.toFixed(1)+" yrs"}</td><td>${decision.attractive?"Clears":"Does not clear"}</td></tr></tbody></table><p class="report-note">Illustrative pre-tax, unlevered model. Tax, depreciation, working capital, implementation timing and terminal value are not included.</p></section>
  <div class="report-columns">${reportUnavailable("Long-range plan","A 12 to 18-month approved forecast source is not connected.")}${reportUnavailable("Investment approval workflow","Business-case owners, thresholds and approval status are not public filing data.")}</div>`;
}

function irReportBody(indexes,rows){
  const company=selectedCompany(), latest=indexes[indexes.length-1];
  const latestRevenue=companyMetricAt(latest,"revenue"), latestGross=companyMetricAt(latest,"grossProfit"), latestOp=companyMetricAt(latest,"operatingIncome"), latestNet=companyMetricAt(latest,"netIncome");
  const latestChange=companyMetricChange("revenue",[latest]);
  const hasIr=Boolean(selectedPublicContext()?.coverage?.managementCommentary);
  return `<div class="report-columns">
    <section><h3>Quarterly message</h3><p>${escapeHtml(company.name)} reported ${companyMoney(latestRevenue)} of revenue in ${qLabel(latest)}${latestChange.delta==null?"":`, ${sgn(latestChange.delta)}% year over year`}. Gross margin was ${latestRevenue&&latestGross!=null?companyPercent(100*latestGross/latestRevenue):"n/a"}.</p></section>
    <section><h3>Reported earnings</h3><dl class="report-facts"><div><dt>Revenue</dt><dd>${companyMoney(latestRevenue)}</dd></div><div><dt>Operating income</dt><dd>${companyMoney(latestOp)}</dd></div><div><dt>Net income</dt><dd>${companyMoney(latestNet)}</dd></div></dl></section>
  </div>
  <section><h3>Investor question set</h3><ol><li>What changed in revenue growth and business mix?</li><li>Which factors affected gross margin and operating leverage?</li><li>How is investment translating into future growth and cash generation?</li><li>What guidance, supply, demand, regulatory or capital risks matter next?</li></ol></section>
  <div class="report-columns">
    ${hasIr?`<div class="report-callout connected"><span>CONNECTED</span><strong>Management commentary</strong><p>Official SEC-filed earnings materials are available with source dates. Guidance appears only when an explicit relevant excerpt was found.</p></div>`:reportUnavailable("Guidance and management commentary","No relevant excerpt was found in the connected SEC documents.")}
    ${reportUnavailable("Stock and benchmark performance","A licensed market-data feed is required before showing price performance or earnings-day reaction.")}
  </div>`;
}

function renderReports(v){
  const company=selectedCompany(), indexes=selectedCompanyIndexes(), rows=reportMetricRows(indexes), definition=REPORT_DEFINITIONS[reportState]||REPORT_DEFINITIONS.fpa;
  const body=reportState==="strategy"?strategyReportBody(indexes,rows):reportState==="ir"?irReportBody(indexes,rows):fpaReportBody(indexes,rows);
  v.innerHTML=`${companyHeader(`${company.name} standardized reports`,`${periodLabel(indexes)} · ${definition.purpose}`)}
    <div class="report-toolbar" role="group" aria-label="Report type">
      ${Object.entries(REPORT_DEFINITIONS).map(([key,item])=>`<button type="button" data-report-switch="${key}" aria-pressed="${reportState===key}"><span>${item.code}</span>${item.label}</button>`).join("")}
      <button type="button" class="report-print" id="reportPrint"><i class="ph ph-printer"></i> Print / Save PDF</button>
      <button type="button" class="report-ai" id="reportAi"><i class="ph ph-sparkle"></i> Draft narrative with AI</button>
    </div>
    <article class="report-sheet" aria-labelledby="reportTitle">
      <header><div><span>${definition.code}</span><h1 id="reportTitle">${escapeHtml(definition.label)}</h1><p>${escapeHtml(company.name)} · ${escapeHtml(periodLabel(indexes))}</p></div><div class="report-status"><span>Evidence status</span><strong>FILED + DERIVED</strong><small>Modeled and unavailable sections are marked.</small></div></header>
      ${body}
      ${managementSignalsHTML({title:"Official management context",limit:3})}
      ${annualReportHTML({tab:"reports",limit:8})}
      <section class="report-sources"><h3>Source appendix</h3>${reportSourceAppendix(indexes)}</section>
      ${reportPublicSourceAppendix()}
      <footer>Prepared from governed public-company evidence. This report does not represent ${escapeHtml(company.name)} internal planning, guidance, or management approval.</footer>
    </article>`;
  document.querySelectorAll("[data-report-switch]").forEach(button=>button.addEventListener("click",()=>{reportState=button.dataset.reportSwitch;render();}));
  document.getElementById("reportPrint").addEventListener("click",()=>window.print());
  document.getElementById("reportAi").addEventListener("click",()=>{
    aiInput.value=`Draft the ${definition.label} narrative for ${company.name} using only the selected dashboard evidence. Separate filed results, modeled outputs, and unavailable information.`;
    openAI("dashboard");
  });
}

function csvReports(){
  const company=selectedCompany(), indexes=selectedCompanyIndexes(), rows=reportMetricRows(indexes);
  downloadCSV(`${companySlug}_${reportState}_report_${periodFileTag(indexes)}.csv`,`Governed source data for the ${REPORT_DEFINITIONS[reportState].label}.`,["company","report","period","metric","actual","comparison","change_pct","field_basis"],rows.map(row=>[company.name,reportState,periodLabel(indexes),row.label,row.actual,row.prior,row.delta,"FILED_OR_DERIVED"]));
}

function renderPeerTab(tab,v){
  ({home:renderPeerHome,glass:renderPeerGlass,revenue:renderPeerRevenue,variance:renderPeerVariance,profit:renderPeerProfit,balance:renderPeerBalance,fx:renderPeerCapital,people:renderPeerPeople,outlook:renderPeerOutlook,env:renderPeerEnvironment,reports:renderReports}[tab]||renderPeerHome)(v);
}

function peerMetricKeysForTab(tab){
  return {
    revenue:["revenue"], variance:["revenue","grossProfit","operatingIncome","netIncome","rd","operatingCashFlow","capex","freeCashFlow"],
    profit:["revenue","grossProfit","operatingIncome","netIncome","rd"], balance:["cash","shortTermInvestments","accountsReceivable","accountsPayable","currentAssets","currentLiabilities","totalAssets","totalLiabilities","totalDebt"],
    fx:["repurchases","dividends","shareBasedCompensation","cash","totalDebt"], people:["revenue","rd"], outlook:["revenue","grossProfit","operatingIncome"], env:[], reports:["revenue","grossProfit","operatingIncome","netIncome","rd","freeCashFlow"]
  }[tab] || ["revenue","grossProfit","operatingIncome","netIncome","rd","operatingCashFlow","capex","freeCashFlow"];
}

function csvPeerTab(tab){
  if(tab==="env") return csvPeerEnv();
  const company=selectedCompany(), keys=peerMetricKeysForTab(tab), indexes=selectedCompanyIndexes();
  const rows=indexes.map(index=>{
    const period=companyPeriodAt(index);
    return [company.name,company.ticker,tab,period.label,period.periodEnd,...keys.map(key=>period.metrics?.[key]??null),period.source.form,period.source.filed,period.source.url];
  });
  downloadCSV(`${companySlug}_${tab}_${periodFileTag(indexes)}.csv`, `REAL SEC-sourced company facts for ${company.name}. Derived arithmetic is marked in companies.json; unavailable values remain blank.`,
    ["company","ticker","tab","period","period_end",...keys,"form","filed","source_url"],rows);
}
