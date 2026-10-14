// Peer Calendar tab: every company on one row, one column per CALENDAR quarter.
// Pure alignment logic lives in peer-core.mjs (module, deferred), so PeerCore is read at render time.
let peerCalendarMetric="revenue";

function peerCalendarUnavailable(v,detail){
  v.innerHTML=`<div class="vhead"><h2>Peer Calendar</h2><span class="sub">UNAVAILABLE</span></div>
    <div class="note" style="margin-top:10px">UNAVAILABLE: ${escapeHtml(detail)}</div>`;
}

function peerCalendarCell(cell,metric){
  if(!cell) return `<td class="pc-empty">not in window</td>`;
  const {period,cq}=cell, value=period.metrics?.[metric];
  const derived=(period.derivedMetrics||[]).includes(metric)&&value!=null;
  const main=value==null?`<span class="pc-empty">n/a</span>`:`${B(value)}${derived?DERIVED_MARK:""}`;
  return `<td>${main}<span class="pc-sub">${escapeHtml(period.label)} · ${escapeHtml(period.periodEnd)}${cq.offsetLabel?` · ${escapeHtml(cq.offsetLabel)}`:""}</span></td>`;
}

function peerCalendarData(){
  const core=globalThis.PeerCore;
  if(!core||typeof COMPANY_DATA==="undefined"||!COMPANY_DATA?.companies) return null;
  const sec={};
  Object.entries(COMPANY_DATA.companies).forEach(([id,company])=>{ if(company.periods?.length) sec[id]=company; });
  return {core,grid:core.buildPeerGrid(sec)};
}

function renderPeerCalendar(v){
  const data=peerCalendarData();
  if(!data) return peerCalendarUnavailable(v,"the peer calendar logic (peer-core.mjs) did not load.");
  const {core,grid}=data;
  const metrics=core.PEER_METRICS, label=(metrics.find(m=>m[0]===peerCalendarMetric)||metrics[0])[1];
  const head=grid.columns.map(cq=>`<th>${escapeHtml(cq.key)}</th>`).join("");
  const body=grid.rows.map(row=>{
    const latest=row.periods.length? row.periods.reduce((a,b)=>b.periodEnd>a.periodEnd?b:a) : null;
    const days=latest?core.daysToFile(latest):null;
    const daysCell=days==null?`<td class="pc-empty" title="Needs the first SEC filing date for this period; a later filing date is not used">UNAVAILABLE</td>`:`<td>${days}<span class="pc-sub">${escapeHtml(latest.label)}</span></td>`;
    return `<tr${row.id===companySlug?' class="pc-sel"':""}><td><strong>${escapeHtml(row.name)}</strong><span class="pc-sub">${escapeHtml(row.ticker||"")}</span></td>${grid.columns.map(cq=>peerCalendarCell(row.cells[cq.key],peerCalendarMetric)).join("")}${daysCell}</tr>`;
  }).join("");
  const anyDerived=grid.rows.some(row=>Object.values(row.cells).some(c=>(c.period.derivedMetrics||[]).includes(peerCalendarMetric)&&c.period.metrics?.[peerCalendarMetric]!=null));
  v.innerHTML=`<div class="vhead"><h2>Peer Calendar</h2><span class="sub">${escapeHtml(label)} by calendar quarter · $B</span></div>
    <div class="report-toolbar" role="group" aria-label="Metric">
      ${metrics.map(([key,name])=>`<button type="button" data-peer-metric="${key}" aria-pressed="${key===peerCalendarMetric}">${escapeHtml(name)}</button>`).join("")}
    </div>
    <div class="card pc-card"><div class="scrollbox pc-scroll"><table class="pc-table"><tr><th>Company</th>${head}<th>Days to file (latest)<sup class="derived-mark" title="Derived: days from period end to the first SEC filing that reported the period">*</sup></th></tr>${body}</table></div>
      ${anyDerived?'<div class="subnote">* derived from filed annual or YTD facts</div>':""}
      <div class="subnote">* Days to file is derived: days from period end to the first SEC filing that reported the period. UNAVAILABLE means the first filing date has not been generated yet.</div></div>
    <div class="note pc-legend"><strong>How quarters are aligned.</strong> Each fiscal quarter is placed in the nearest calendar quarter (CQ) by its end date. A period end on day 15 or earlier counts as the prior month end, so 52/53-week year ends in early January or early February land in the month that just closed.
      <br>Fiscal quarters that end in Jan, Apr, Jul or Oct sit one month after a calendar quarter end and are tagged "+1 mo"; those ending in Feb, May, Aug or Nov sit one month before it and are tagged "-1 mo". Each company then has exactly one period per calendar quarter.
      <br>Examples: Apple 2026-06-27 is CQ2 2026. NVIDIA 2026-01-25 is a January quarter end, shown in CQ4 2025 as +1 mo. Broadcom 2026-02-01 snaps back to January, CQ4 2025, +1 mo. Oracle 2026-08-31 is an August quarter end, shown in CQ3 2026 as -1 mo. An Intel 53-week year ending 2027-01-02 snaps to December and shows in CQ4 2026.</div>`;
  v.querySelectorAll("[data-peer-metric]").forEach(button=>button.addEventListener("click",()=>{peerCalendarMetric=button.dataset.peerMetric;render();}));
}
