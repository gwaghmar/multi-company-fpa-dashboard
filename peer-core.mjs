// Pure logic for the Peer Calendar tab. Exports for node tests and also assigns globalThis.PeerCore
// so the classic script peer-table.js can read it at render time.
//
// Alignment rule (documented in the on-page legend):
//   1. Snap the period end to a month: day <= 15 snaps back to the prior month end (52/53-week
//      filers whose year ends in the first days of a month), otherwise the period end's own month.
//   2. Assign the fiscal quarter to the NEAREST calendar quarter end. A quarter ending in the month
//      after a calendar quarter end (Jan, Apr, Jul, Oct) goes to the quarter that just closed
//      ("+1 mo"); one ending the month before a calendar quarter end (Feb, May, Aug, Nov) goes to
//      the quarter about to close ("-1 mo"). A three-month quarter assigned this way always has at
//      least two of its three months inside the calendar quarter, and a company with consecutive
//      fiscal quarters always lands in consecutive calendar quarters, so no two collide or skip.

const pad = n => String(n).padStart(2, "0");

function parseISO(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!m) return null;
  const year = +m[1], month = +m[2], day = +m[3];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function monthEndISO(year, month) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad(month)}-${pad(last)}`;
}

export function calendarQuarter(periodEnd) {
  const p = parseISO(periodEnd);
  if (!p) return null;
  let year = p.year, month = p.month;
  if (p.day <= 15) {
    month -= 1;
    if (month === 0) { month = 12; year -= 1; }
  }
  const snappedMonthEnd = monthEndISO(year, month);
  const rem = month % 3;
  let qYear = year, quarter, offsetMonths;
  if (rem === 0) { quarter = month / 3; offsetMonths = 0; }
  else if (rem === 1) {
    offsetMonths = 1;
    if (month === 1) { qYear = year - 1; quarter = 4; } else quarter = (month - 1) / 3;
  } else { offsetMonths = -1; quarter = (month + 1) / 3; }
  const offsetLabel = offsetMonths === 0 ? "" : `${offsetMonths > 0 ? "+" : "-"}${Math.abs(offsetMonths)} mo`;
  return {
    year: qYear, quarter, key: `CQ${quarter} ${qYear}`, snappedMonthEnd,
    quarterEnd: monthEndISO(qYear, quarter * 3), offsetMonths, offsetLabel
  };
}

// Days between period end and the FIRST filing. Only source.firstFiled counts; source.filed is
// often a later filing's date and is never used as a fallback.
export function daysToFile(period) {
  const end = parseISO(period?.periodEnd), filed = parseISO(period?.source?.firstFiled);
  if (!end || !filed) return null;
  const days = Math.round((Date.UTC(filed.year, filed.month - 1, filed.day) - Date.UTC(end.year, end.month - 1, end.day)) / 86400000);
  return days >= 0 ? days : null;
}

export function cqSortValue(cq) { return cq.year * 4 + cq.quarter; }

// buildPeerGrid: companies = companies.json `companies` map. Returns the union of calendar quarters
// (oldest first) and one row per company. Cells hold the period; metric handling stays in the renderer.
// If a company ever puts two periods in one calendar quarter the later one is kept and the clash is
// listed in `conflicts` (the tests assert there are none).
export function buildPeerGrid(companies) {
  const columns = new Map(), rows = [], conflicts = [];
  for (const [id, company] of Object.entries(companies || {})) {
    const cells = {};
    for (const period of company.periods || []) {
      const cq = calendarQuarter(period.periodEnd);
      if (!cq) continue;
      columns.set(cq.key, cq);
      if (cells[cq.key]) conflicts.push({ company: id, key: cq.key, periods: [cells[cq.key].period.label, period.label] });
      if (!cells[cq.key] || period.periodEnd > cells[cq.key].period.periodEnd) cells[cq.key] = { period, cq };
    }
    rows.push({ id, name: company.name, ticker: company.ticker, cells, periods: company.periods || [] });
  }
  const cols = [...columns.values()].sort((a, b) => cqSortValue(a) - cqSortValue(b));
  return { columns: cols, rows, conflicts };
}

export const PEER_METRICS = [
  ["revenue", "Revenue"], ["grossProfit", "Gross profit"], ["operatingIncome", "Operating income"],
  ["netIncome", "Net income"], ["rd", "R&D"], ["operatingCashFlow", "Operating cash flow"],
  ["freeCashFlow", "Free cash flow"], ["cash", "Cash"], ["totalDebt", "Total debt"]
];

const api = { calendarQuarter, daysToFile, buildPeerGrid, cqSortValue, PEER_METRICS };
globalThis.PeerCore = api;
export default api;
