# Data provenance

This file has four parts. Part A covers Apple's richer `data.json` dataset.
Part B covers three Apple flat-file exports. Part C covers per-tab exports.
Part D covers the global multi-company source and the modeled FP&A scenario.

## Part A. `data.json` — 7-quarter time series, Q1 FY25 – Q3 FY26

Rebuilt from live SEC EDGAR data by `tools/fetch_edgar_data.py`. Every figure
traces to one of eight Apple filings, listed below with accession numbers.
Company-wide income statement, balance sheet, and cash flow totals come from
each filing's `companyfacts.json` (`us-gaap` facts, filtered by accession).
Product-category revenue/cost, geography revenue/cost/S&M/operating income,
the Corporate segment-reconciliation row, and the "Intangible assets, net"
balance-sheet line come from each filing's own XBRL instance document
(`aapl-YYYYMMDD_htm.xml`), because `companyfacts.json` only carries `dei`/`us-gaap`
facts and excludes both dimensional facts and Apple's `aapl:`-namespace
extension concepts.

### Filings used

| Label | Form | Accession | Filed | Period end |
|---|---|---|---|---|
| Q1 FY25 | 10-Q | 0000320193-25-000008 | 2025-01-31 | 2024-12-28 |
| Q2 FY25 | 10-Q | 0000320193-25-000057 | 2025-05-02 | 2025-03-29 |
| Q3 FY25 | 10-Q | 0000320193-25-000073 | 2025-08-01 | 2025-06-28 |
| FY25 10-K | 10-K | 0000320193-25-000079 | 2025-10-31 | 2025-09-27 |
| Q1 FY26 | 10-Q | 0000320193-26-000006 | 2026-01-30 | 2025-12-27 |
| Q2 FY26 | 10-Q | 0000320193-26-000013 | 2026-05-01 | 2026-03-28 |
| Q3 FY26 | 10-Q | 0000320193-26-000020 | 2026-07-31 | 2026-06-27 |
| FY24 10-K (bonus 8th balance-sheet snapshot) | 10-K | 0000320193-24-000123 | 2024-11-01 | 2024-09-28 |

### Per-line-item sourcing

- **Company-wide income statement, balance sheet, and cash flow totals**
  (`data.json`'s `is`, `bs`, `cf` sections) — `companyfacts.json`, `us-gaap`
  facts only, filtered by the accession of the matching filing.
- **Category revenue (`cat`), geography revenue/cost/S&M/operating income
  (`geo`), and the Corporate reconciliation row (`geo.corp`)** — parsed
  directly from each filing's XBRL instance document. These are dimensional
  facts and Apple-extension tags that `companyfacts.json` does not carry.

### Derivation 1: Q4 FY25 flow figures

Apple's FY25 10-K reports annual totals but not a standalone Q4 figure.
Q4 FY25 = FY25 10-K annual value minus the sum of the three filed FY25
quarterly values (Q1 + Q2 + Q3). For most series that subtrahend is the
filed 9-month YTD fact straight from the Q3 FY25 10-Q; the pipeline checks
that Q1+Q2+Q3 equals that filed 9-month figure before trusting the
subtraction (31/31 checks passed).

Worked example, total net sales, in $M:

```
FY25 10-K annual net sales:        416,161
minus 9mo FY25 (Q3 10-Q YTD):     -313,695
= Q4 FY25 net sales:                102,466
```

The same method applies to cost of sales, opex, operating income, tax, net
income, category and geographic revenue, segment operating income,
geographic cost of sales/S&M, and the Corporate R&D/G&A/operating-loss row.

For geographic cost of sales/S&M and the Corporate row specifically, Apple
did not tag those by quarter until the Q1 FY26 10-Q, so the "9mo FY25"
subtrahend is the sum of the three individually-filed FY25 quarters (see
next section) rather than a single filed YTD fact. This was cross-checked
independently: Σ(geo.cos) = `is.totalCos` and `corp.ga + Σ(geo.sm)` =
`is.sga` in every quarter, including this derived Q4 FY25.

### Derivation 2: quarterly cash flow

Apple's cash flow statement is filed cumulative, year-to-date within each
fiscal year, not discretely by quarter. Each quarter's cash-flow line =
YTD(quarter N) − YTD(quarter N−1). Verified against `hc.sbcQ3`/`hc.sbcQ3py`
already in `data.json`: the derived Q3 FY26 share-based comp (10,523 − 7,122
= 3,401) and Q3 FY25 (9,680 − 6,512 = 3,168) match those fields exactly.

### FY25 Corporate-row sourcing (restated comparative columns)

The Corporate reconciliation row (R&D/G&A/operating-loss allocated to
"Corporate" rather than to a geographic segment) is not disclosed anywhere
in Apple's own FY25 10-Qs — Apple only began tagging this row in the
segment note starting with the Q1 FY26 10-Q. Its Q1-Q3 FY25 values come
from the restated prior-year comparative column each FY26 10-Q carries
(e.g. the Q1 FY26 10-Q's PY column is Q1 FY25). These are still 100% filed,
real numbers, just sourced from a later filing's comparative column rather
than the original FY25 filing. Confirmed internally consistent: Corporate
R&D exactly equals consolidated R&D in every quarter, and segment operating
income plus Corporate operating loss reconciles to consolidated operating
income exactly in all 7 quarters.

### Intangibles disclosure-timing nulls

`bs.intangibles` is null for Sep 28 2024, Dec 28 2024, Mar 29 2025, Jun 28
2025, and Dec 27 2025 (5 of 8 balance-sheet dates). Apple did not disclose
"Intangible assets, net" as its own balance-sheet line until the Q2 FY26
10-Q (filed 2026-05-01). For those earlier dates the amount is real but
wasn't broken out — it's folded into `otherNonCurrent` exactly as Apple
filed it. `is.epsDiluted` and `is.epsBasic` are also null for Q4 FY25 only:
EPS is not a summable flow item, so it falls outside both derivation
methods above and was left null rather than estimated.

A related presentation note: `otherNonCurrent` for Sep 27, 2025 has two
different filed values across EDGAR — 83,727M as originally filed in the
FY25 10-K, vs. 72,634M as restated in every subsequent 10-Q's comparative
column once Apple broke "Intangible assets, net" (11,093M) out as its own
line (83,727 − 11,093 = 72,634, same underlying number). `data.json` uses
the restated split (72,634 / 11,093) for that date, to stay consistent with
the intangibles line.

### Rebuild pipeline

`tools/fetch_edgar_data.py` pulls the filings above live from SEC EDGAR
(`User-Agent: Govind Waghmare sec-contact@example.invalid`, cached under
`edgar_cache/`), runs 52 automated consistency checks (0 mismatches), and
writes `data.json` plus the repo-root CSVs `01_revenue_by_category.csv`,
`02_revenue_by_geography.csv`, `03_income_statement.csv`,
`04_balance_sheet_ap_ar.csv`, `06_segment_operating_income.csv`,
`07_quarterly_trend_fy26.csv`, and `08_cash_flow_9mo.csv`, all regenerated
to the full 7-quarter series. Files `05_fx_hedging_capital_returns.csv`,
`09_headcount_equity_comp.csv`, `10_environment_csrd.csv`, and
`11_outlook_guidance_quotes.csv` are unchanged — the underlying `fx`, `cap`,
`hc`, `env`, and `fwd` sections of `data.json` are still single-quarter
(Q3 FY26) and were carried over as-is.

## Part B. Q3 FY26 flat CSV exports

Three files, three different levels of granularity, all traceable back to
Apple's Q3 FY2026 Form 10-Q (period ended June 27, 2026), SEC EDGAR
accession `0000320193-26-000020`, filed July 31, 2026.

## 1. `apple_q3fy26_xbrl_facts.csv` — 818 rows, 100% real

Every tagged fact from the actual XBRL instance document Apple filed with the SEC.
Pulled directly from `sec.gov/Archives/edgar/data/320193/000032019326000020/`, not
retyped or summarized. Includes segment-level detail, individual outstanding bond
series, and Rule 10b5-1 trading-plan disclosures. Nothing in this file is estimated,
modeled, or invented.

## 2. `apple_q3fy26_curated_summary.csv` — 299 rows, 100% real

The same ~150 headline figures that power the dashboard's tabs (income statement,
balance sheet, cash flow, FX, headcount, environment, outlook), reshaped into one
flat table. Cross-checked against file 1: every spot-checked figure matches the
filed XBRL value exactly. Real, just curated down to what's dashboard-relevant.

## 3. `apple_q3fy26_synthetic_daily_revenue.csv` — 2,275 rows, MODELED

Apple does not publish daily or transaction-level sales. This file does not exist
in any Apple filing. It's a modeled allocation: Q3 FY26 revenue spread across
product category x geography x each of the 91 days in the quarter, built so that:

- Every product category's total across all 91 days = the real, filed quarterly
  category total (file 2).
- Every geography's total across all 91 days = the real, filed quarterly
  geography total (file 2).
- `gross_margin_pct` on each row is real (Apple's filed Products vs. Services
  margin), applied per row based on category.
- The specific category x geography x day split (which cell gets how much revenue
  on which day) is not disclosed by Apple anywhere. It's built with a standard
  biproportional allocation (each cell's daily total = quarter total x that
  category's real share x that geography's real share) plus mild day-of-week
  variation, so it reconciles exactly on both dimensions rather than being
  arbitrary.

Every row's `field_basis` column states plainly which fields are real vs. modeled.
This file exists to show transaction-level *shape and scale*, the kind of grain a
real SAP system produces underneath quarterly aggregates, not to claim Apple
disclosed anything beyond the two real totals it's reconciled to.

## Part C. Per-tab "Download CSV" feature

The dashboard is gaining a "Download CSV" control on each tab, generated
in-browser (no server round-trip). Each download is a synthetic,
transaction-level allocation of that tab's real filed totals, following the
same honesty convention as `apple_q3fy26_synthetic_daily_revenue.csv` above:

- The allocation (by day, by transaction, or by whatever grain suits the
  tab) is modeled. It is not disclosed by Apple at that grain anywhere.
- The totals it reconciles to are real and filed. Summing the generated
  rows back up reproduces the corresponding filed figure in `data.json`
  exactly, for every category/dimension involved.
- Every generated file carries a `# MODELED` header comment at the top, and
  a `field_basis` column on every row stating which fields are real
  (reconciled to a filed total) vs. modeled (the specific allocation).

Nothing in this feature invents a number Apple hasn't disclosed at the
aggregate level; it only invents *how that aggregate splits* below the
grain Apple actually reports.

## EPS aggregation note

Diluted EPS is not summable across quarters (the diluted share count changes every
quarter as buybacks retire shares). The dashboard and Ask AI therefore use the
**as-filed period EPS** for aggregates: FY25 full year = $7.46 from Apple's FY25
Form 10-K (accession 0000320193-25-000079), plus 9mo FY26 = $6.88 and 9mo FY25 =
$5.62 from the Q3 FY26 10-Q (accession 0000320193-26-000020). These are stored at
`is.epsDilutedAnnual` and `is.epsDiluted9mo` in `data.json`. Summing the three
quarterly figures gives $6.87 for 9mo FY26, one cent off the filed value. Standalone
Q4 FY25 EPS is still not shown because it cannot be derived (see the nulls section
above); that does not prevent the directly filed FY25 annual figure from being used.

## Part D. Multi-company source and Planning & Scenarios

`company-context.json` is rebuilt by `tools/fetch_public_context.py` from recent
SEC submissions, 10-Q/10-K narrative, SEC-filed earnings exhibits, U.S. Treasury
yield-curve data, the BLS public API, and ECB reference FX rates. The management
items are short source excerpts with dates and links. They are context, not proof
of causality. Internal plans, analyst consensus, and stock prices remain explicitly
unavailable.

`companies.json` is rebuilt from the SEC Company Facts API by
`tools/fetch_company_sources.py`. It currently contains seven standardized fiscal
quarters for Apple, Alphabet, NVIDIA, Microsoft, Amazon, Meta, AMD, Broadcom,
Oracle, Salesforce, and Intel.

The standardized source includes filed or arithmetically derived quarterly revenue,
gross profit, operating income, net income, R&D, operating cash flow, capex, free
cash flow, repurchases, dividends, and share-based compensation where available.
It also includes point-in-time cash, investments, receivables, payables, assets,
liabilities, and debt where a comparable US-GAAP fact is filed. Every period carries
the filing form, filing date, accession, and SEC source URL. Derived values are
listed in each period's `derivedMetrics` array.

The selected company is global application state. It controls the fiscal-quarter
labels, period presets, every tab, CSV output, source note, Ask AI suggestions, and
the evidence sent to Dashboard AI. Period defaults are semantic: current fiscal YTD
for flow views and the latest selected quarter for point-in-time views.

Product mix, geography, management guidance, headcount, FX exposure, and
environmental disclosures are not consistently available in SEC Company Facts.
For non-Apple companies, unsupported tabs or fields are shown as UNAVAILABLE and
name the additional source needed. They never fall back to Apple data.

Planning & Scenarios is explicitly MODELED. It applies visible revenue-growth,
gross-margin, and operating-expense assumptions to the latest selected filed
quarter. The output is arithmetic for FP&A exploration, not company guidance,
analyst consensus, an approved budget, or an internal annual operating plan.
