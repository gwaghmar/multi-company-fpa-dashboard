"use strict";

/* Forecast Ledger tab and Restatement Tracker section.
   Globals used: renderLedger(v), ledgerHomeStrip(). Reads COMPANY_DATA, PUBLIC_CONTEXT and companySlug from
   the page, and LedgerCore (ledger-core.mjs, a deferred module) at render time. forecasts.json is fetched here. */

const LEDGER_STYLE_ID = "ledger-style";
const LEDGER_NO_GUIDANCE_DEFAULT = "No revenue guidance sentence found in the latest SEC 8-K earnings exhibit";
const LEDGER_KIND = {
  amended: "Amended filing",
  presentation: "Re-presented in a later filing (revenue and net income unchanged)",
  changed: "Figure changed in later filing; cause not determinable from XBRL"
};
const LEDGER_METRIC_LABEL = {
  revenue: "Revenue", costOfRevenue: "Cost of revenue", grossProfit: "Gross profit", operatingIncome: "Operating income",
  netIncome: "Net income", rd: "R&D", sellingGeneralAdministrative: "SG&A", operatingCashFlow: "Operating cash flow",
  capex: "Capex", freeCashFlow: "Free cash flow", cash: "Cash", totalDebt: "Total debt",
  repurchases: "Share repurchases", dividends: "Dividends", shareBasedCompensation: "Share-based compensation",
  depreciationAmortization: "Depreciation and amortization", interestExpense: "Interest expense",
  incomeTaxExpense: "Income tax expense", acquisitions: "Acquisitions", shortTermInvestments: "Short-term investments",
  accountsReceivable: "Accounts receivable", accountsPayable: "Accounts payable", currentAssets: "Current assets",
  currentLiabilities: "Current liabilities", totalAssets: "Total assets", totalLiabilities: "Total liabilities",
  inventory: "Inventory", goodwill: "Goodwill", propertyPlantEquipment: "Property, plant and equipment",
  deferredRevenueCurrent: "Deferred revenue (current)", marketableSecuritiesNoncurrent: "Marketable securities (noncurrent)"
};

let LEDGER_DATA = null;      // parsed forecasts.json, or {failed:true}
let LEDGER_LOADING = null;

function ledgerEsc(value){
  return String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function ledgerSafeUrl(url){
  return /^https:\/\//i.test(url||"") ? ledgerEsc(url) : "";
}

function ledgerInjectStyle(){
  if(document.getElementById(LEDGER_STYLE_ID)) return;
  const style=document.createElement("style");
  style.id=LEDGER_STYLE_ID;
  style.textContent=`
.lg-section{flex:0 0 auto; background:var(--surface); border:1px solid var(--ring); border-radius:16px; padding:9px 14px 10px; margin-top:6px; min-width:0}
.lg-section h3{font:650 10.5px/1.3 "Inter",sans-serif; text-transform:uppercase; letter-spacing:.07em; border-top:2px solid var(--ink); padding-top:7px; margin:0 0 4px; color:var(--ink)}
.lg-banner{border:1px solid var(--ring); border-left:3px solid var(--accent); border-radius:10px; background:var(--surface); padding:8px 12px; font-size:12px; line-height:1.5; color:var(--ink2); margin-top:6px}
.lg-banner code,.lg-strip code{font:11px ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--ink)}
.lg-scroll{overflow-x:auto}
.lg-table td,.lg-table th{text-align:left; vertical-align:top}
.lg-table td{line-height:1.45}
.lg-table td.lg-num{white-space:nowrap}
.lg-table tr.lg-sel td:first-child{box-shadow:inset 3px 0 0 var(--accent)}
.lg-tag{display:inline-block; font:600 8.5px/1 "Inter",sans-serif; letter-spacing:.06em; border-radius:99px; padding:2px 6px; margin-left:5px; vertical-align:middle; border:1px solid currentColor}
.lg-real{color:var(--real,var(--up))} .lg-modeled{color:var(--accent)} .lg-unav{color:var(--muted)} .lg-derived{color:var(--ink2)}
.lg-quote{display:block; color:var(--ink); margin:0 0 3px}
.lg-meta,.lg-muted{color:var(--muted); font-size:10.5px}
.lg-inside{color:var(--up); font-weight:650} .lg-outside{color:var(--down); font-weight:650}
.lg-strip{display:flex; flex-wrap:wrap; gap:6px 14px; align-items:baseline; border:1px solid var(--ring); border-radius:12px; background:var(--surface); padding:7px 12px; font-size:12px; color:var(--ink2)}
.lg-strip b{color:var(--ink)} .lg-strip a{color:var(--accent); text-decoration:none; font-weight:600}
.lg-table a{color:var(--accent)}
`;
  document.head.appendChild(style);
}

function ledgerLoad(){
  if(LEDGER_DATA) return Promise.resolve(LEDGER_DATA);
  if(!LEDGER_LOADING){
    LEDGER_LOADING=fetch("./forecasts.json")
      .then(response=>response.ok?response.json():Promise.reject(new Error("forecasts.json unavailable")))
      .then(data=>(Array.isArray(data?.forecasts)?data:{failed:true}))
      .catch(()=>({failed:true}))
      .then(data=>{
        LEDGER_DATA=data;
        document.querySelectorAll("[data-ledger-strip]").forEach(el=>{ el.innerHTML=ledgerStripInner(); });
        return data;
      });
  }
  return LEDGER_LOADING;
}

function ledgerCore(){ return globalThis.LedgerCore || null; }
function ledgerCompanies(){ return (typeof COMPANY_DATA!=="undefined"&&COMPANY_DATA?.companies)||{}; }
function ledgerContext(slug){ return (typeof PUBLIC_CONTEXT!=="undefined"&&PUBLIC_CONTEXT?.companies?.[slug])||null; }
function ledgerTag(kind){ return `<span class="lg-tag lg-${kind.toLowerCase()}">${kind}</span>`; }
function ledgerMoney(value){ return value==null||!Number.isFinite(Number(value))?"n/a":"$"+Math.round(Number(value)).toLocaleString("en-US")+"M"; }
function ledgerSigned(value,suffix,digits){ return value==null?"n/a":(value>0?"+":value<0?"-":"")+Math.abs(value).toFixed(digits==null?1:digits)+suffix; }
function ledgerUnavailable(text){ return `<span class="lg-unav">UNAVAILABLE: ${ledgerEsc(text)}</span>`; }

function ledgerSlugs(){
  const all=Object.entries(ledgerCompanies()).filter(([,company])=>company.periods?.length).map(([slug])=>slug);
  const selected=typeof companySlug!=="undefined"?companySlug:"";
  return all.includes(selected)?[selected,...all.filter(slug=>slug!==selected)]:all;
}

function ledgerGuidanceCell(core,slug,forecast){
  const company=ledgerCompanies()[slug], context=ledgerContext(slug);
  const guidance=forecast ? core.guidanceForForecast(forecast,context,company?.periods||[]) : (context?.guidance||null);
  if(!guidance){
    return forecast ? `<span class="lg-muted">No filed guidance in this call's window</span>` : `<span class="lg-muted">${ledgerEsc(LEDGER_NO_GUIDANCE_DEFAULT)}</span>`;
  }
  const range=core.parseGuidanceRange(guidance.text);
  const link=ledgerSafeUrl(guidance.url);
  const source=`${link?`<a href="${link}" target="_blank" rel="noopener">${ledgerEsc(guidance.sourceTitle||"SEC 8-K exhibit")}</a>`:ledgerEsc(guidance.sourceTitle||"SEC 8-K exhibit")}, filed ${ledgerEsc(guidance.filed)}`;
  const from=range?.derivedFrom?` (from plus or minus ${ledgerEsc(range.derivedFrom)})`:"";
  const derivedTag=range?.derivedFrom?ledgerTag("DERIVED"):"";
  const parsed=range
    ? (range.low===range.high ? `Parsed${from}: ${ledgerMoney(range.low)}` : `Parsed range${from}: ${ledgerMoney(range.low)} to ${ledgerMoney(range.high)}`)+derivedTag
    : "Range not parsed, excerpt shown";
  return `${ledgerTag("REAL")}<span class="lg-quote">&ldquo;${ledgerEsc(guidance.text)}&rdquo;</span><div class="lg-meta">${source}</div><div class="lg-meta">${parsed}</div>`;
}

function ledgerRow(core,slug,forecast,isSelected){
  const company=ledgerCompanies()[slug];
  const period=forecast?company.periods.find(p=>p.periodEnd===forecast.periodEnd):null;
  const cls=isSelected?' class="lg-sel"':"";
  const name=`<td><b>${ledgerEsc(company.name)}</b></td>`;
  const guidanceCell=`<td>${ledgerGuidanceCell(core,slug,forecast)}</td>`;
  if(!forecast){
    const empty='<td class="lg-muted">n/a</td>';
    return `<tr${cls}>${name}<td class="lg-muted">No call locked</td>${empty}${empty}${guidanceCell}${empty}${empty}${empty}</tr>`;
  }
  const call=`${ledgerMoney(forecast.revenue)} revenue<br>${Number.isFinite(Number(forecast.grossMarginPct))?Number(forecast.grossMarginPct):"n/a"}% gross margin<br>${forecast.opex==null?"opex not set":ledgerMoney(forecast.opex)+" opex"}${ledgerTag("MODELED")}${forecast.note?`<div class="lg-meta">${ledgerEsc(forecast.note)}</div>`:""}`;
  let actual, error, inRange;
  if(!period){
    const waiting='<span class="lg-muted">Awaiting filing</span>';
    actual=waiting; error=waiting; inRange=waiting;
  }else{
    const graded=core.gradeForecast(forecast,period);
    const opex=core.actualOpex(period);
    const m=period.metrics||{};
    const gm=m.revenue&&m.grossProfit!=null?100*m.grossProfit/m.revenue:null;
    actual=`${ledgerTag("REAL")}${ledgerMoney(m.revenue)} revenue<br>${gm==null?"n/a":gm.toFixed(1)+"% gross margin"+ledgerTag("DERIVED")}<br>${opex==null?ledgerUnavailable("SG&A not filed under the standard tag"):ledgerMoney(opex)+" opex"+ledgerTag("DERIVED")}`;
    error=`${ledgerSigned(graded.revenueErrPct,"%")} revenue<br>${ledgerSigned(graded.gmErrPts," pts")} gross margin<br>${graded.opexErrPct==null?ledgerUnavailable("SG&A not filed under the standard tag"):ledgerSigned(graded.opexErrPct,"%")+" opex"}`;
    const guidance=core.guidanceForForecast(forecast,ledgerContext(slug),company.periods);
    const range=guidance?core.parseGuidanceRange(guidance.text):null;
    const gg=range?core.gradeGuidance(range,m.revenue):null;
    inRange=!guidance?'<span class="lg-muted">No filed guidance</span>':!gg?'<span class="lg-muted">Range not parsed</span>'
      :`<span class="${gg.inside?"lg-inside":"lg-outside"}">${gg.inside?"Inside":"Outside"}</span><div class="lg-meta">Midpoint ${ledgerSigned(gg.midErrPct,"%")} vs actual</div>`;
  }
  return `<tr${cls}>${name}<td class="lg-num">${ledgerEsc(forecast.label)}<div class="lg-meta">ends ${ledgerEsc(forecast.periodEnd)}</div></td><td>${call}</td><td class="lg-num">${ledgerEsc(forecast.lockedAt)}</td>${guidanceCell}<td>${actual}</td><td>${error}</td><td>${inRange}</td></tr>`;
}

function ledgerCallsSection(core,data){
  const slugs=ledgerSlugs();
  const calls=data.forecasts||[];
  const rows=slugs.map((slug,index)=>{
    const own=calls.filter(f=>f.company===slug).sort((a,b)=>a.periodEnd.localeCompare(b.periodEnd));
    return (own.length?own:[null]).map(f=>ledgerRow(core,slug,f,index===0)).join("");
  }).join("");
  const banner=calls.length?"":`<div class="lg-banner">No forecast calls are on record yet. Each call is dated and locked before the quarter is filed, then graded against the filed actuals. Nothing here is generated; the ledger only shows calls the owner locked.</div>`;
  return `${banner}<section class="lg-section" data-ledger-root>
    <h3>Calls and filed guidance</h3>
    <div class="lg-scroll"><table class="lg-table"><thead><tr><th>Company</th><th>Period</th><th>Call (rev / GM / opex)</th><th>Locked</th><th>Filed guidance</th><th>Actual</th><th>Call error</th><th>Guidance in range</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="subnote">Calls are MODELED and locked by the owner before the quarter is filed. Filed guidance is REAL: the verbatim sentence from the latest SEC 8-K earnings exhibit, with its source and date. Errors are call minus actual. Opex is R&amp;D plus SG&amp;A.</div>
  </section>`;
}

function ledgerDeltaCell(value){ return value==null?"n/a":(value>0?"+":"")+value.toFixed(2)+"%"; }

function ledgerFilingCell(value,form,date,accession,cik){
  const link=accession&&cik?`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${String(accession).replace(/-/g,"")}/`:"";
  const acc=accession?(link?`<a href="${ledgerEsc(link)}" target="_blank" rel="noopener">${ledgerEsc(accession)}</a>`:ledgerEsc(accession)):"n/a";
  return `${ledgerMoney(value)}<div class="lg-meta">${ledgerEsc(form||"form n/a")}, filed ${ledgerEsc(date||"n/a")}</div><div class="lg-meta">${acc}</div>`;
}

function ledgerRestatementSection(){
  const slug=typeof companySlug!=="undefined"?companySlug:"";
  const company=ledgerCompanies()[slug];
  if(!company||!company.periods?.length) return "";
  const vintage=typeof COMPANY_DATA!=="undefined"&&COMPANY_DATA?.vintage;
  const note=vintage?`Figures as shown on this dashboard: ${ledgerEsc(vintage)}.`:"Compares each quarter as first filed with the latest filing that reports it.";
  const list=company.restatements;
  let body;
  if(!Array.isArray(list)) body=`<div class="note" style="margin-top:6px">${ledgerUnavailable("change tracking has not been generated yet.")}</div>`;
  else if(!list.length) body=`<div class="note" style="margin-top:6px">No changed prior-period figures above 0.5% across the seven quarters.</div>`;
  else{
    const rows=list.map(row=>`<tr><td>${ledgerEsc(LEDGER_METRIC_LABEL[row.metric]||row.metric)}</td><td class="lg-num">${ledgerEsc(row.label)}<div class="lg-meta">ends ${ledgerEsc(row.periodEnd)}</div></td>`
      +`<td>${row.firstFiled?ledgerFilingCell(row.firstValue,row.firstForm,row.firstFiled,row.firstAccession,company.cik):ledgerUnavailable("first filing date not available")}</td>`
      +`<td>${ledgerFilingCell(row.latestValue,row.latestForm,row.latestFiled,row.latestAccession,company.cik)}</td>`
      +`<td class="lg-num">${ledgerDeltaCell(row.deltaPct)}</td><td>${ledgerEsc(LEDGER_KIND[row.kind]||"Figure changed in later filing; cause not determinable from XBRL")}</td></tr>`).join("");
    body=`<div class="lg-scroll"><table class="lg-table"><thead><tr><th>Metric</th><th>Period</th><th>As first filed</th><th>As later reported</th><th>Delta %</th><th>Kind</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  return `<section class="lg-section" data-restatement-root><h3>Figures changed in later filings</h3><div class="subnote" style="margin:0 0 4px">${note} ${ledgerEsc(company.name)}, first-filed and later-reported values side by side.</div>${body}</section>`;
}

function ledgerHead(){
  return `<div class="vhead"><h2>Forecast Ledger</h2><span class="sub">Owner calls, filed guidance and actuals for every company</span></div>`;
}

function renderLedger(v){
  ledgerInjectStyle();
  const core=ledgerCore();
  if(!core){
    v.innerHTML=`${ledgerHead()}<div class="note" style="margin-top:10px">${ledgerUnavailable("ledger-core.mjs did not load.")}</div>`;
    return;
  }
  if(!LEDGER_DATA){
    v.innerHTML=`${ledgerHead()}<div class="note" style="margin-top:10px">Loading forecasts.json...</div>`;
    ledgerLoad().then(()=>{ if(v.isConnected&&v.querySelector(".vhead h2")?.textContent==="Forecast Ledger") renderLedger(v); });
    return;
  }
  if(LEDGER_DATA.failed){
    v.innerHTML=`${ledgerHead()}<div class="note" style="margin-top:10px">${ledgerUnavailable("forecasts.json could not be loaded.")}</div>${ledgerRestatementSection()}`;
    return;
  }
  v.innerHTML=`${ledgerHead()}${ledgerCallsSection(core,LEDGER_DATA)}${ledgerRestatementSection()}`;
}

function ledgerStripInner(){
  const core=ledgerCore();
  if(!core||!LEDGER_DATA||LEDGER_DATA.failed) return `<span>Forecast Ledger: <a href="#tab=ledger">open the tab</a></span>`;
  const summary=core.ledgerSummary(LEDGER_DATA.forecasts,ledgerCompanies());
  if(!summary.onRecord) return `<span><a href="#tab=ledger">Forecast Ledger</a>: owner forecasts are locked before each filing and graded against actuals. No calls on record yet.</span>`;
  const next=summary.next;
  const name=next?(ledgerCompanies()[next.company]?.name||next.company):"";
  return `<span>Calls on record: <b>${summary.onRecord}</b>.</span><span>Graded: <b>${summary.graded}</b>.</span>`
    +(next?`<span>Next grading: ${ledgerEsc(name)}, ${ledgerEsc(next.label)} (quarter ends ${ledgerEsc(next.periodEnd)}). <a href="#tab=ledger">Forecast Ledger</a></span>`:`<span>No calls waiting for grading. <a href="#tab=ledger">Forecast Ledger</a></span>`);
}

function ledgerHomeStrip(){
  ledgerInjectStyle();
  ledgerLoad();
  return `<div class="lg-strip" data-ledger-strip>${ledgerStripInner()}</div>`;
}

ledgerLoad();
