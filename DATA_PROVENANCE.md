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

The latest 10-K is ingested separately for every company even when a newer 10-Q
exists. `annualReport.evidence` stores compact excerpts across business and segments,
revenue and demand, strategy and investment, liquidity and capital, workforce, risk
and supply, market and FX, and legal and regulatory areas. Ask AI receives only the
areas relevant to the active tab. These excerpts are annual context, not current
guidance, internal planning data, or deterministic causal explanations.

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

### Rules `tools/fetch_company_sources.py` applies (set 2026-10-13)

**1. One XBRL tag per metric per company.** Each metric has a short list of
candidate US-GAAP tags. The candidates are never pooled. For each company the
script picks the one tag that carries the filed fiscal year-to-date series (the
tag with a filed fiscal-year-start to period-end fact for the most periods in the
seven-quarter window; ties go to the first tag in the list). Every quarter, every
`fiscalYtdMetrics` value, and every Q4 derivation for that metric then uses that
tag only. The chosen tag for every metric is written to `metricTags` on each
company in `companies.json`. Why: sibling tags are different numbers. Meta files
both `DepreciationDepletionAndAmortization` (cash-flow statement) and `Depreciation`
(a rounded note figure); Alphabet and Meta file both `ShareBasedCompensation`
(cash-flow statement) and a rounded `AllocatedShareBasedCompensationExpense`.
Mixing them inside one series produced quarters that did not add up to the filed
annual figure.

A tag that is filed only for full fiscal years (no first-quarter, six-month, or
nine-month fact in the window) does not carry the series and is not used. The
metric is then null for that company in both `metrics` and `fiscalYtdMetrics`.
Example: AMD files `Depreciation` once a year (PP&E depreciation only, 521 for
FY25), so AMD `depreciationAmortization` is null, not a partial figure.

**2. As originally filed.** When the same fact was filed more than once (a later
10-Q or 10-K repeats or restates a prior period in its comparative column), the
earliest filing wins. This applies to the whole file: quarters, YTD values, and
balance-sheet values. Why: a cash-flow quarter is a subtraction of two YTD facts,
and both ends must come from the same vintage. Alphabet restated its six-month
2025 repurchases from 28,706 to 28,306 in the 10-Q filed 2026-07-23, but no
restated nine-month figure exists yet, so "latest restated" cannot be applied to
both ends. As originally filed gives Q2 FY25 13,638 and Q3 FY25 11,504, which sum
with Q1 to the originally filed nine-month 40,210. Side effects to know about:

- A prior period that an issuer later reclassified keeps its original value. AMD's
  accounts payable at 2024-12-28 is 1,990 as filed in the FY24 10-K; the FY25 10-K
  re-presents it as 2,466. AMD FY24 SG&A is 2,783 as filed (later 2,735).
- When an issuer renames a tag, the older periods under the new tag exist only in
  later comparative columns, so the earliest filing of the chosen tag is used.
  Alphabet moved revenue from `RevenueFromContractWithCustomerExcludingAssessedTax`
  to `Revenues` in its Q2 2025 10-Q. The values are identical in both tags.

**3. How a quarter is built.**

- Income-statement metrics (revenue, cost of revenue, gross profit, operating
  income, net income, R&D, SG&A, interest expense, income tax): the filed
  three-month fact. Fallback: the difference between two filed fiscal YTD facts.
- Cash-flow metrics (operating cash flow, capex, repurchases, dividends,
  share-based compensation, depreciation and amortization, acquisitions): the
  difference between consecutive filed fiscal YTD facts, because the cash-flow
  statement is filed cumulatively. A three-month cash-flow fact is used only when
  no YTD pair exists, because such facts are often rounded narrative figures
  (NVIDIA tagged a rounded 6,000 for Q2 FY27 dividends; the statement difference is
  6,290 minus 243 = 6,047). Cash-flow quarters therefore always sum exactly to the
  filed YTD value.
- Fiscal Q4 is never filed on its own. It is the filed annual fact minus the
  first three quarters (income statement) or minus the filed nine-month fact (cash
  flow). It is listed in `derivedMetrics`.
- Gross profit is revenue minus cost of revenue when the issuer files no
  `GrossProfit` tag. Free cash flow is operating cash flow minus capex.

**4. Debt is balance-sheet carrying value.** `totalDebt` = `debtCurrent` +
`debtNoncurrent`, each read at the period end:

- `debtCurrent` = `DebtCurrent` when filed. Otherwise the sum of the filed current
  pieces: `LongTermDebtCurrent`, `CommercialPaper`, `ShortTermBorrowings`,
  `NotesPayableCurrent`. The pieces are never added to `DebtCurrent`, which already
  contains them. Two pieces with the identical filed amount are one balance-sheet
  line tagged twice and count once (AMD tagged its 874 current portion as both
  `LongTermDebtCurrent` and `ShortTermBorrowings` in the FY25 10-K; the balance
  sheet has one line).
- `debtNoncurrent` = the first filed of `LongTermDebtNoncurrent`,
  `LongTermDebtAndCapitalLeaseObligations`, `LongTermNotesPayable`,
  `LongTermNotesAndLoans`. These are alternative names for one line, never added.
- If the noncurrent piece is not filed, `totalDebt` is null. A current-only figure
  is never shown as total debt. If no current tag is filed, the issuer reported no
  current debt line and `totalDebt` equals the noncurrent piece (Meta; NVIDIA and
  AMD in some quarters).
- `LongTermDebt` and `DebtLongtermAndShorttermCombinedAmount` are NOT used. They are
  note-table figures and are often principal or rounded, not carrying value: Apple's
  `LongTermDebt` is rounded to the nearest 100 and excludes commercial paper,
  Amazon's is face value (58,000 against a carrying 57,791 at 2024-12-31), and
  Broadcom's combined amount is principal (68,757 against carrying 66,579 at
  2025-02-02). Where the combined amount is carrying value it matches the sum
  exactly (Oracle 92,568 and 129,541 at its fiscal year ends; AMD except the
  quarter with commercial paper).
- Finance-lease liabilities are not included, except where an issuer's own
  balance-sheet debt line includes them (Broadcom).

**5. Source attribution.** Each period's `source` is the filing that first reported
that period: the 10-Q for the quarter, or the 10-K for a fiscal Q4. A later filing
that repeats the period as a comparative column is never cited. `source.filed` and
`source.firstFiled` hold the same date.

**Known limits.**

- Alphabet, Microsoft, Broadcom, Oracle, and Intel file no single total D&A tag.
  Their `depreciationAmortization` is the `Depreciation` tag from the cash-flow
  statement and excludes amortization of intangibles (large for Broadcom).
  `metricTags` shows which tag was used.
- Alphabet moved dividends from `PaymentsOfDividends` to
  `PaymentsOfOrdinaryDividends` in its Q2 2026 10-Q. Under the one-tag rule Q2 FY26
  dividends are null until the new tag carries the series.
- Fiscal YTD values in `fiscalYtdMetrics` are valid only for a selection that is
  exactly fiscal quarters 1 to n of one fiscal year. `api/ask.js` nulls them for any
  other selection so a single quarter is never answered with a YTD or full-year
  figure.

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

## Environment / CSRD (`environment-context.json`)

Apple's Environment tab uses Apple's own curated data in `data.json` (see above).
Every other company's Environment tab reads `environment-context.json`, which holds
each company's Scope 1/2/3 emissions, total footprint, renewable-energy share, and
stated reduction/net-zero target, manually curated one company at a time from that
company's own most-recently-published official sustainability/ESG report.

This file is deliberately **not** part of the daily automated refresh
(`.github/workflows/refresh-company-data.yml` only regenerates `companies.json` and
`company-context.json` from the SEC Company Facts API). There is no free,
structured, continuously-refreshing source for corporate environmental data: the
SEC's climate disclosure rule is being rescinded as of 2026, the EU's CSRD filings
won't appear on ESAP before 2028, and CDP's detailed disclosures are no longer
public. The only real source for any of these figures -- including Apple's -- is
each company's own report, published once a year on its own schedule. Refreshing
this file means re-curating it by hand when a company publishes a new report, not
running a script.

Every figure in `environment-context.json` is labeled REAL (directly stated by the
company) or DERIVED (simple arithmetic on REAL figures, e.g. a percentage share).
Fields are omitted rather than estimated wherever the underlying research could not
confirm a figure against the company's own primary source, or where independent
lookups returned conflicting numbers for the same reporting period -- the dashboard
renders an explicit `unavailableNote` in that case instead of a guessed value. Each
company entry cites its source report's title, URL, and publish date.

## Private companies (`private-companies.json`)

OpenAI and Anthropic are both private: neither files with the SEC, so none of the
standardized quarterly pipeline (`companies.json`, the 11-tab company view) applies
to them. They appear as their own selectable companies in the dropdown, under a
"Private -- no SEC filings" group, but every tab renders the same single curated
snapshot from `private-companies.json` instead of a per-tab, per-quarter view --
there is no quarterly filing history to break it out by.

Each company's `facts` array uses a two-tier basis, distinct from the REAL/DERIVED/
MODELED tiers used everywhere else in this dashboard, because neither company makes
audited filings public:

- **REAL** -- the company's own on-the-record statement (an official blog post,
  press release, executive statement, or a filed-but-confidential document where
  only the fact of filing, not its contents, is public).
- **REPORTED** -- reported by press or disclosed only to investors, not confirmed
  by the company itself. Shown only when multiple independent outlets agree; single-
  source or contradicted figures are excluded rather than shown as REPORTED.

This file is manually curated and **not** part of the automated daily SEC refresh --
these numbers move on each company's own disclosure schedule (funding rounds,
blog posts, investor updates), not a fetchable API. It needs to be re-curated by
hand when either company makes a new statement.
