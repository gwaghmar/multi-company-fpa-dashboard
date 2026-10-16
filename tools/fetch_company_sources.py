#!/usr/bin/env python3
"""Build companies.json from official SEC Company Facts data.

The output is intentionally standardized. It includes only metrics that can be
mapped consistently across issuers.

Rules (also written up in DATA_PROVENANCE.md, Part D):

* One primary XBRL tag per metric per company (metricTags): the tag that carries
  the company's filed fiscal year-to-date series is chosen once. Candidate tags
  are never pooled or summed.
* Renamed-tag fallback, span level. When an issuer moves a line to a new tag, a
  second candidate tag may supply a filed (start, end) span ONLY when the primary
  tag never filed that span, and ONLY after a bridge check: the two tags share at
  least one filed span and every shared span has the identical first-filed value.
  Each span still comes from exactly one tag. Which spans came from the fallback
  is written to metricTagFallbacks.
* As originally filed. When the same fact was filed more than once (a later
  filing repeats or restates a prior period in its comparative column) the
  earliest filing wins, so both ends of every subtraction share one vintage.
* Income-statement quarters are filed three-month facts. Cash-flow quarters are
  the difference between consecutive filed fiscal YTD facts. Fiscal Q4 is the
  filed annual fact minus the filed nine-month fact (or minus Q1 to Q3).
* Total debt is the balance-sheet carrying value: current debt plus noncurrent
  debt. It is null when the noncurrent piece was not filed.
* Each period is attributed to the filing that first reported it.
"""

from __future__ import annotations

import json
import os
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone


USER_AGENT = os.environ.get("SEC_USER_AGENT") or "findashboard local run (set SEC_USER_AGENT to 'Name email')"
# Optional: read cached Company Facts files (CIK##########.json) from this directory instead of
# calling the SEC API. Used for offline verification only; the scheduled refresh never sets it.
FACTS_DIR = os.environ.get("SEC_COMPANYFACTS_DIR")
OUT = os.path.join(os.path.dirname(os.path.dirname(__file__)), "companies.json")
COMPANIES = {
    "apple": {"name": "Apple", "ticker": "AAPL", "cik": "0000320193"},
    "alphabet": {"name": "Alphabet", "ticker": "GOOGL", "cik": "0001652044"},
    "nvidia": {"name": "NVIDIA", "ticker": "NVDA", "cik": "0001045810"},
    "microsoft": {"name": "Microsoft", "ticker": "MSFT", "cik": "0000789019"},
    "amazon": {"name": "Amazon", "ticker": "AMZN", "cik": "0001018724"},
    "meta": {"name": "Meta", "ticker": "META", "cik": "0001326801"},
    "amd": {"name": "AMD", "ticker": "AMD", "cik": "0000002488"},
    "broadcom": {"name": "Broadcom", "ticker": "AVGO", "cik": "0001730168"},
    "oracle": {"name": "Oracle", "ticker": "ORCL", "cik": "0001341439"},
    "salesforce": {"name": "Salesforce", "ticker": "CRM", "cik": "0001108524"},
    "intel": {"name": "Intel", "ticker": "INTC", "cik": "0000050863"},
}

CONCEPTS = {
    "revenue": ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"],
    "costOfRevenue": ["CostOfRevenue", "CostOfGoodsAndServicesSold"],
    "grossProfit": ["GrossProfit"],
    "operatingIncome": ["OperatingIncomeLoss"],
    "netIncome": ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"],
    "rd": ["ResearchAndDevelopmentExpense"],
    "operatingCashFlow": ["NetCashProvidedByUsedInOperatingActivities"],
    "capex": ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
    "repurchases": ["PaymentsForRepurchaseOfCommonStock"],
    # PaymentsOfOrdinaryDividends: Alphabet's tag for the same "Dividend payments" line from the
    # Q2 2026 10-Q on. It is used only as a bridged fallback (see FALLBACK_METRICS).
    "dividends": ["PaymentsOfDividendsCommonStock", "PaymentsOfDividends", "PaymentsOfOrdinaryDividends"],
    "shareBasedCompensation": ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"],
    "sellingGeneralAdministrative": ["SellingGeneralAndAdministrativeExpense"],
    "depreciationAmortization": [
        "DepreciationDepletionAndAmortization",
        "DepreciationAndAmortization",
        "DepreciationDepletionAndAmortizationPropertyPlantAndEquipment",
        "Depreciation",
    ],
    # Gross interest expense only. Net tags (InterestIncomeExpenseNet and friends) and cash
    # interest paid (InterestPaidNet) are deliberately absent: interest income is never netted.
    "interestExpense": ["InterestExpenseNonoperating", "InterestExpense", "InterestExpenseDebt"],
    "incomeTaxExpense": ["IncomeTaxExpenseBenefit"],
    "acquisitions": ["PaymentsToAcquireBusinessesNetOfCashAcquired", "PaymentsToAcquireBusinessesGross"],
}
# Metrics allowed to take a bridged fallback tag (add_fallback_spans). Kept to the metrics where a
# tag rename was verified against the filed statements; other metrics stay strictly one tag.
FALLBACK_METRICS = {"dividends", "interestExpense"}

# Metrics left unmapped for one company even though a candidate tag exists, with the reason.
UNMAPPED = {
    "meta": {
        "interestExpense": (
            "InterestExpenseDebt is filed only in some 10-Qs (absent from the Q1, Q2 and Q3 2025 "
            "and Q1 2026 10-Qs as filed) and covers debt interest only: FY2025 1,090 vs 1,165 total interest "
            "expense (InterestExpenseNonoperating, 10-K only). No clean quarterly series."
        ),
    },
}

# Income-statement metrics: the filed three-month fact is the quarter.
INCOME_KEYS = [
    "revenue", "costOfRevenue", "grossProfit", "operatingIncome", "netIncome", "rd",
    "sellingGeneralAdministrative", "interestExpense", "incomeTaxExpense",
]
# Cash-flow-statement metrics: filed cumulatively, so the quarter is a difference of YTD facts.
CASH_FLOW_KEYS = [
    "operatingCashFlow", "capex", "repurchases", "dividends", "shareBasedCompensation",
    "depreciationAmortization", "acquisitions",
]

INSTANT_CONCEPTS = {
    "cash": ["CashAndCashEquivalentsAtCarryingValue"],
    "shortTermInvestments": ["ShortTermInvestments", "MarketableSecuritiesCurrent"],
    "accountsReceivable": ["AccountsReceivableNetCurrent"],
    "accountsPayable": ["AccountsPayableCurrent"],
    "currentAssets": ["AssetsCurrent"],
    "currentLiabilities": ["LiabilitiesCurrent"],
    "totalAssets": ["Assets"],
    "totalLiabilities": ["Liabilities"],
    "inventory": ["InventoryNet"],
    "goodwill": ["Goodwill"],
    "propertyPlantEquipment": ["PropertyPlantAndEquipmentNet"],
    "deferredRevenueCurrent": ["ContractWithCustomerLiabilityCurrent"],
    "marketableSecuritiesNoncurrent": ["MarketableSecuritiesNoncurrent"],
}

# Debt is the balance-sheet carrying value, built per period end from these tags.
# DebtCurrent already contains every current piece, so it is never added to the parts.
DEBT_CURRENT_TOTAL = "DebtCurrent"
DEBT_CURRENT_PARTS = ["LongTermDebtCurrent", "CommercialPaper", "ShortTermBorrowings", "NotesPayableCurrent"]
# First filed tag in this order is the noncurrent piece. They are alternative names for the same
# balance-sheet line, never addends.
DEBT_NONCURRENT = [
    "LongTermDebtNoncurrent",
    "LongTermDebtAndCapitalLeaseObligations",
    "LongTermNotesPayable",
    "LongTermNotesAndLoans",
]


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def load_company_facts(cik: str, url: str) -> dict:
    if FACTS_DIR:
        with open(os.path.join(FACTS_DIR, f"CIK{cik}.json"), encoding="utf-8") as handle:
            return json.load(handle)
    return fetch_json(url)


def day(value: str) -> date:
    return date.fromisoformat(value)


def duration(item: dict) -> int:
    return (day(item["end"]) - day(item["start"])).days + 1


def tag_facts(payload: dict, name: str, instant: bool = False, forms: set[str] | None = None) -> list[dict]:
    """10-Q/10-K USD facts for ONE us-gaap tag. Duration facts by default, instants on request.

    Amendments (10-Q/A, 10-K/A) are excluded unless a caller passes `forms` that include them;
    only the restatement pass does.
    """
    output = []
    units = payload.get("facts", {}).get("us-gaap", {}).get(name, {}).get("units", {})
    for item in units.get("USD", []):
        if item.get("form") not in (forms or {"10-Q", "10-K"}) or not item.get("end"):
            continue
        if bool(item.get("start")) == instant:
            continue
        row = dict(item)
        row["concept"] = name
        output.append(row)
    return output


def first_filed(items: list[dict]) -> dict | None:
    """As-originally-filed policy: the earliest filing that reported the fact wins."""
    if not items:
        return None
    return min(items, key=lambda item: (item.get("filed", "9999"), item.get("accn", "")))


def span_for(items: list[dict], start: str, end: str) -> dict | None:
    return first_filed([item for item in items if item["start"] == start and item["end"] == end])


def instant_for(items: list[dict], period_end: str) -> dict | None:
    return first_filed([item for item in items if item["end"] == period_end])


def value_millions(item: dict | None) -> float | None:
    if not item or not isinstance(item.get("val"), (int, float)):
        return None
    return round(item["val"] / 1_000_000, 3)


def fiscal_year_end_month(revenue_facts: list[dict]) -> int:
    """Month in which the issuer's fiscal year ends, taken from its latest filed annual span."""
    annual = [item for item in revenue_facts if item.get("fp") == "FY" and 330 <= duration(item) <= 380]
    if not annual:
        return 12
    return day(max(annual, key=lambda item: item["end"])["end"]).month


def fiscal_label(period_end: str, fy_end_month: int) -> tuple[int, int]:
    """Return (fiscal year, fiscal quarter) for a period end date.

    Derived from the calendar date and the issuer's fiscal year-end month, NOT from
    the SEC Company Facts `fy`/`fp` fields. Those fields describe the filing, not the
    period, and are wrong for some issuers: Oracle's quarter ended 2026-08-31 is
    tagged fy=2026 although Oracle calls it Q1 FY2027, and Salesforce's 10-K for the
    year ended 2026-01-31 is tagged fy=2025 although Salesforce calls it FY2026.
    Convention: the fiscal year is named for the calendar year in which it ends.

    Known edge: 52/53-week issuers whose year-end straddles a month boundary
    (Broadcom ends on the Sunday nearest Oct 31, so late-October and early-November
    year-ends both occur) could mislabel a quarter if the window mixes both. Not the
    case in any current window; the companies.json contiguity test would flag it.
    """
    end = day(period_end)
    fy = end.year if end.month <= fy_end_month else end.year + 1
    quarter = ((end.month - fy_end_month - 1) % 12) // 3 + 1
    return fy, quarter


def build_periods(revenue_facts: list[dict]) -> list[dict]:
    """Fiscal calendar: the quarter and annual date spans the issuer reported revenue for.

    Only the spans (start and end dates) and the first filing that reported each span are
    taken from here, so revenue facts from every candidate tag may be passed in. An issuer
    that renames its revenue tag (Alphabet moved from
    RevenueFromContractWithCustomerExcludingAssessedTax to Revenues in 2025) keeps one
    unbroken calendar. No VALUE is read from the pooled facts: values come from one tag.
    """
    fy_end_month = fiscal_year_end_month(revenue_facts)
    by_span = defaultdict(list)
    for item in revenue_facts:
        by_span[(item["start"], item["end"])].append(item)

    periods = []
    for (start, end), items in by_span.items():
        first = first_filed(items)
        if 70 <= duration(first) <= 110:
            fy, quarter = fiscal_label(end, fy_end_month)
            if quarter == 4:
                # Issuers do not file a standalone Q4 three-month fact; anything that looks
                # like one is a comparative artefact, so Q4 is always derived below.
                continue
            periods.append({
                "start": start, "end": end, "quarter": quarter,
                "fy": fy, "derived": False, "sourceFact": first,
                "fiscalStart": None,
            })

    annual_by_span = defaultdict(list)
    for item in revenue_facts:
        if 330 <= duration(item) <= 380:
            annual_by_span[(item["start"], item["end"])].append(item)

    for (start, end), items in annual_by_span.items():
        fy, _ = fiscal_label(end, fy_end_month)
        q123 = sorted(
            [period for period in periods if period["fy"] == fy and start <= period["start"] and period["end"] < end],
            key=lambda period: period["end"],
        )
        if len(q123) < 3:
            continue
        q123 = q123[-3:]
        periods.append({
            "start": (day(q123[-1]["end"]) + timedelta(days=1)).isoformat(),
            "end": end, "quarter": 4, "fy": fy, "derived": True,
            "sourceFact": first_filed(items), "fiscalStart": start,
        })

    periods.sort(key=lambda period: period["end"])
    for period in periods:
        if period["fiscalStart"] is None:
            same_fy = [candidate for candidate in periods if candidate["fy"] == period["fy"] and candidate["quarter"] <= period["quarter"]]
            period["fiscalStart"] = min(candidate["start"] for candidate in same_fy)
    return periods


def choose_flow_tag(payload: dict, names: list[str], periods: list[dict]) -> tuple[str | None, list[dict]]:
    """Pick ONE tag for a flow metric: the tag that carries the filed fiscal YTD series.

    Score = number of emitted periods with a filed fact spanning fiscal-year start to
    period end under that tag. Ties go to the earlier name in CONCEPTS. A tag that
    is filed only for full fiscal years (no first-quarter, six-month or nine-month fact in
    the window) does not carry the series: it is a once-a-year footnote figure, for example
    PP&E depreciation, and can never yield a quarter. Such a metric is left unmapped, so
    every value is null rather than partial.
    """
    best_name, best_items, best_score = None, [], 0
    for name in names:
        items = tag_facts(payload, name)
        covered = [period for period in periods if span_for(items, period["fiscalStart"], period["end"])]
        if not any(period["quarter"] != 4 for period in covered):
            continue
        if len(covered) > best_score:
            best_name, best_items, best_score = name, items, len(covered)
    return best_name, best_items


def first_filed_by_span(items: list[dict]) -> dict[tuple[str, str], dict]:
    spans: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for item in items:
        spans[(item["start"], item["end"])].append(item)
    return {span: first_filed(rows) for span, rows in spans.items()}


def add_fallback_spans(payload: dict, names: list[str], primary: str | None, items: list[dict]) -> tuple[list[dict], dict | None]:
    """Fill spans the primary tag never filed from a renamed tag, one tag per span.

    A candidate qualifies only if it bridges to the primary: at least one (start, end) span is
    filed under both tags and every such shared span has the identical first-filed value. That
    proves the two tags label the same line. The fallback then supplies only spans absent from
    the primary; a span the primary filed is never replaced. Candidates are tried in CONCEPTS
    order and a later candidate cannot overwrite a span an earlier one supplied.
    """
    if not primary:
        return items, None
    merged = list(items)
    have = first_filed_by_span(items)
    report = None
    for name in names:
        if name == primary:
            continue
        candidate = first_filed_by_span(tag_facts(payload, name))
        shared = [span for span in candidate if span in have and have[span]["concept"] == primary]
        if not shared or any(candidate[span]["val"] != have[span]["val"] for span in shared):
            continue
        new_spans = sorted(span for span in candidate if span not in have)
        if not new_spans:
            continue
        for span in new_spans:
            merged.extend(item for item in tag_facts(payload, name) if (item["start"], item["end"]) == span)
            have[span] = candidate[span]
        report = report or {"tags": [], "bridge": [], "spans": []}
        report["tags"].append(name)
        report["bridge"].extend({
            "tag": name, "start": span[0], "end": span[1], "value": value_millions(candidate[span]),
            "primaryAccession": have[span]["accn"] if have[span]["concept"] == primary else None,
            "fallbackAccession": candidate[span]["accn"],
        } for span in sorted(shared))
        report["spans"].extend({
            "tag": name, "start": span[0], "end": span[1], "value": value_millions(candidate[span]),
            "form": candidate[span].get("form"), "filed": candidate[span].get("filed"),
            "accession": candidate[span].get("accn"),
        } for span in new_spans)
    return merged, report


def choose_instant_tag(payload: dict, names: list[str], periods: list[dict]) -> tuple[str | None, list[dict]]:
    """Pick ONE tag for a balance-sheet metric: the tag filed at the most emitted period ends."""
    best_name, best_items, best_score = None, [], 0
    for name in names:
        items = tag_facts(payload, name, instant=True)
        score = sum(1 for period in periods if instant_for(items, period["end"]))
        if score > best_score:
            best_name, best_items, best_score = name, items, score
    return best_name, best_items


def metric_value(items: list[dict], period: dict, all_periods: list[dict], ytd_first: bool = False) -> tuple[float | None, bool]:
    """Quarterly value for one metric from one tag. Returns (value in USD millions, derived?).

    Income-statement metrics (ytd_first=False) use the filed three-month fact and fall
    back to the difference between consecutive filed fiscal YTD facts.
    Cash-flow metrics (ytd_first=True) use the YTD difference first, because the cash-flow
    statement is filed cumulatively and a three-month cash-flow fact is often a rounded
    narrative figure; the three-month fact is the fallback.
    Fiscal Q4 is never filed on its own: it is the filed annual fact minus the first three
    quarters (income statement) or minus the filed nine-month fact (cash flow).
    """
    direct = value_millions(span_for(items, period["start"], period["end"]))
    if period["quarter"] == 1:
        return direct, False

    fiscal_periods = sorted(
        [candidate for candidate in all_periods if candidate["fy"] == period["fy"] and candidate["quarter"] <= period["quarter"]],
        key=lambda candidate: candidate["quarter"],
    )
    current = span_for(items, period["fiscalStart"], period["end"])
    previous_period = next((candidate for candidate in fiscal_periods if candidate["quarter"] == period["quarter"] - 1), None)
    previous = span_for(items, period["fiscalStart"], previous_period["end"]) if previous_period else None
    difference = round((current["val"] - previous["val"]) / 1_000_000, 3) if current and previous else None

    if period["quarter"] in {2, 3}:
        if ytd_first and difference is not None:
            return difference, difference != direct
        if direct is not None:
            return direct, False
        return difference, difference is not None

    # Fiscal Q4.
    if not current:
        return None, False
    if ytd_first and difference is not None:
        return difference, True
    earlier_values = [
        metric_value(items, candidate, all_periods, ytd_first=ytd_first)[0]
        for candidate in fiscal_periods[:-1]
    ]
    if len(earlier_values) == 3 and all(value is not None for value in earlier_values):
        return round(current["val"] / 1_000_000 - sum(earlier_values), 3), True
    return difference, difference is not None


def fiscal_ytd_value(items: list[dict], period: dict) -> float | None:
    """Return the exact filed fiscal YTD/annual fact for a flow metric.

    The UI uses this value when the selected periods are the current fiscal YTD.
    This avoids small rounding differences caused by summing separately filed
    three-month values when the issuer also filed an exact six- or nine-month fact.
    """
    return value_millions(span_for(items, period["fiscalStart"], period["end"]))


def debt_values(debt_facts: dict[str, list[dict]], period_end: str) -> tuple[float | None, float | None, float | None, bool]:
    """Carrying value of debt at one period end: (current, noncurrent, total, total is a sum?).

    current    = DebtCurrent when filed, otherwise the sum of the filed current pieces
                 (current portion of long-term debt, commercial paper, short-term
                 borrowings, current notes payable). Two pieces with the identical filed
                 amount are one balance-sheet line tagged twice and are counted once.
    noncurrent = the first filed tag in DEBT_NONCURRENT.
    total      = current + noncurrent. Null when the noncurrent piece was not filed, so a
                 current-only figure is never shown as total debt. When no current tag was
                 filed the issuer reported no current debt line and total = noncurrent.
    """
    def at(name: str) -> float | None:
        fact = instant_for(debt_facts[name], period_end)
        return fact["val"] if fact and isinstance(fact.get("val"), (int, float)) else None

    current = at(DEBT_CURRENT_TOTAL)
    if current is None:
        parts = []
        for name in DEBT_CURRENT_PARTS:
            value = at(name)
            if value is not None and value not in parts:
                parts.append(value)
        current = sum(parts) if parts else None
    noncurrent = next((value for value in (at(name) for name in DEBT_NONCURRENT) if value is not None), None)

    def millions(value: float | None) -> float | None:
        return None if value is None else round(value / 1_000_000, 3)

    if noncurrent is None:
        return millions(current), None, None, False
    total = noncurrent + (current or 0)
    return millions(current), millions(noncurrent), millions(total), current is not None


RESTATEMENT_FORMS = {"10-Q", "10-K", "10-Q/A", "10-K/A"}
RESTATEMENT_REL = 0.005
# Change detection looks back over this many fiscal quarters (about three fiscal years), wider than
# the seven quarters shown. It never changes a shown value.
RESTATEMENT_LOOKBACK = 12
VINTAGE = (
    "as originally filed, earliest filing wins; later changes to a prior-period figure are listed "
    "under restatements and are not applied to the values shown"
)


def filing_values(items: list[dict]) -> dict[str, dict]:
    """One fact per filing (accession). The same fact can repeat inside one filing; keep the first.

    A filing that carries two DIFFERENT values for the same span is ambiguous and is dropped.
    """
    by_filing: dict[str, dict] = {}
    conflicted = set()
    for item in sorted(items, key=lambda row: (row.get("filed", ""), row.get("accn", ""))):
        accn = item.get("accn", "")
        if accn in by_filing and by_filing[accn].get("val") != item.get("val"):
            conflicted.add(accn)
        by_filing.setdefault(accn, item)
    return {accn: item for accn, item in by_filing.items() if accn not in conflicted}


def period_label(period: dict, basis: str) -> str:
    fy = str(period["fy"])[-2:]
    if basis == "annual":
        return f"FY{fy}"
    if basis == "ytd":
        return f"{'H1' if period['quarter'] == 2 else '9M'} FY{fy}"
    return f"Q{period['quarter']} FY{fy}"


def restatement_change(first_value: float, latest_value: float) -> tuple[bool, float]:
    """(above threshold?, deltaPct). Threshold: more than 0.5% AND at least 1 ($M)."""
    change = abs(latest_value - first_value)
    base = max(abs(first_value), 1)
    return change / base > RESTATEMENT_REL and change >= 1, round(100 * (latest_value - first_value) / base, 2)


def restatement_kind(latest_form: str, totals: dict[str, list]) -> str:
    """amended: the latest filing is a 10-K/A or 10-Q/A.
    presentation: revenue AND net income for the same span are present in both the first and the latest
    filing and identical in both, so the change moved a line without changing the totals.
    changed: anything else, including totals that could not be read in either filing.
    """
    if (latest_form or "").endswith("/A"):
        return "amended"
    same = all(pair[0] is not None and pair[0] == pair[1] for pair in (totals["revenue"], totals["netIncome"]))
    return "presentation" if same else "changed"


def lookback_periods(all_periods: list[dict], lookback: int = RESTATEMENT_LOOKBACK) -> list[dict]:
    """The latest `lookback` fiscal quarters, stopping at the first break in the calendar.

    A break is a gap between consecutive period ends outside 80-100 days, or a quarter number that
    does not follow the previous one. Older 52/53-week periods can be mislabeled by fiscal_label
    (Apple's quarter ended 2023-04-01 lands in "Q3", its 2023-07-01 quarter in "Q4"), so the lookback
    never reaches past a break: a wrong label is never printed and a missing quarter is never implied.
    """
    window = list(all_periods[-1:])
    for period in reversed(all_periods[:-1]):
        if len(window) >= lookback:
            break
        later = window[0]
        gap = (day(later["end"]) - day(period["end"])).days
        expected = 4 if later["quarter"] == 1 else later["quarter"] - 1
        if not (80 <= gap <= 100 and period["quarter"] == expected):
            break
        window.insert(0, period)
    return window


def restatement_rows(payload: dict, metric_tags: dict, all_periods: list[dict],
                     flow_facts: dict[str, list[dict]] | None = None,
                     lookback: int = RESTATEMENT_LOOKBACK) -> list[dict]:
    """Prior-period figures that a later filing reports differently from the first filing.

    Its own pass over the SEC facts, including 10-K/A and 10-Q/A (the main filter drops amendments),
    over the last `lookback` fiscal quarters (lookback_periods: stops at a calendar break). Only the tag that supplied each span (metricTags, or the
    bridged fallback listed in metricTagFallbacks for a span the primary never filed) and only directly
    filed facts are compared. Each row has a `basis`:

      quarter  the filed three-month fact, fiscal Q1-Q3, income-statement metrics; and the
               first-quarter cash-flow fact (a first-quarter YTD fact is the quarter)
      ytd      the filed six- or nine-month cash-flow fact (fiscal Q2, Q3)
      annual   the filed full-year fact for every flow metric (fiscal Q4 period end)
      instant  the balance-sheet fact at the period end

    Never compared: fiscal Q4 three-month values (always derived), YTD-differenced cash-flow quarters,
    free cash flow, total debt, and gross profit built from revenue minus cost. SEC Company Facts holds
    only facts without dimensions, so segment and member facts never enter.

    Vintage guard: the earliest filing of the fact must be the filing that first reported the period
    (period sourceFact). When the chosen tag first appears only in a later comparative column (a renamed
    tag) that earliest value is not the original figure, and the row is skipped.

    A row is emitted when the latest-filed value differs from the earliest-filed value by more than
    0.5% and by at least 1 ($M). kind: see restatement_kind. Revenue and net income are read from the
    two exact filings being compared (first and latest accession), for the same span basis.
    """
    flow_facts = flow_facts or {}

    def span_tag(key: str, start: str, end: str) -> str | None:
        """Tag that supplied this span: the primary, or the bridged fallback for a span the primary never filed."""
        chosen = [item for item in flow_facts.get(key, []) if item["start"] == start and item["end"] == end]
        return first_filed(chosen)["concept"] if chosen else metric_tags.get(key)

    def span_facts(key: str, start: str, end: str) -> list[dict]:
        name = span_tag(key, start, end)
        if not name:
            return []
        return [item for item in tag_facts(payload, name, forms=RESTATEMENT_FORMS)
                if item["start"] == start and item["end"] == end]

    def total_at(key: str, start: str, end: str, accession: str) -> float | None:
        """Revenue or net income for this span as reported in one filing, from the chosen tag."""
        fact = filing_values(span_facts(key, start, end)).get(accession)
        return value_millions(fact)

    window = lookback_periods(all_periods, lookback)
    rows = []
    for period in window:
        source_accn = (period.get("sourceFact") or {}).get("accn")
        candidates = []  # (metric, basis, start, items)
        if period["quarter"] == 4:
            spans = [("annual", period["fiscalStart"], INCOME_KEYS + CASH_FLOW_KEYS)]
        elif period["quarter"] == 1:
            spans = [("quarter", period["start"], INCOME_KEYS + CASH_FLOW_KEYS)]
        else:
            spans = [("quarter", period["start"], INCOME_KEYS), ("ytd", period["fiscalStart"], CASH_FLOW_KEYS)]
        for basis, start, keys in spans:
            for key in keys:
                if metric_tags.get(key):
                    candidates.append((key, basis, start, span_facts(key, start, period["end"])))
        for key in INSTANT_CONCEPTS:
            if metric_tags.get(key):
                candidates.append((key, "instant", None, [
                    item for item in tag_facts(payload, metric_tags[key], instant=True, forms=RESTATEMENT_FORMS)
                    if item["end"] == period["end"]]))
        for key, basis, start, items in candidates:
            filings = sorted(filing_values(items).values(), key=lambda row: (row.get("filed", ""), row.get("accn", "")))
            if len(filings) < 2:
                continue
            first, latest = filings[0], filings[-1]
            if first.get("accn") != source_accn:
                continue
            first_value, latest_value = value_millions(first), value_millions(latest)
            if first_value is None or latest_value is None:
                continue
            above, delta_pct = restatement_change(first_value, latest_value)
            if not above:
                continue
            # Totals for the same span basis; for a balance-sheet row, the period's own flow span
            # (three-month for Q1-Q3, full year at a fiscal year end).
            total_start = start if start else (period["fiscalStart"] if period["quarter"] == 4 else period["start"])
            totals = {
                total: [total_at(total, total_start, period["end"], first.get("accn")),
                        total_at(total, total_start, period["end"], latest.get("accn"))]
                for total in ("revenue", "netIncome")
            }
            rows.append({
                "metric": key, "label": period_label(period, basis), "periodEnd": period["end"],
                "firstValue": first_value, "firstFiled": first.get("filed"),
                "firstAccession": first.get("accn"), "firstForm": first.get("form"),
                "latestValue": latest_value, "latestFiled": latest.get("filed"),
                "latestAccession": latest.get("accn"), "latestForm": latest.get("form"),
                "deltaPct": delta_pct,
                "kind": restatement_kind(latest.get("form"), totals),
                # Extra fields; the UI may ignore them.
                "basis": basis,
                "periodStart": start,
                "tag": first.get("concept"),
                "totalsChecked": totals,
            })
    rows.sort(key=lambda row: (row["periodEnd"], row["metric"], row["basis"]))
    return rows


def build_company(slug: str, config: dict) -> dict:
    url = f"https://data.sec.gov/api/xbrl/companyfacts/CIK{config['cik']}.json"
    payload = load_company_facts(config["cik"], url)
    # Calendar from every revenue tag (spans and first filing only); values from one tag each.
    all_periods = build_periods([item for name in CONCEPTS["revenue"] for item in tag_facts(payload, name)])
    periods = all_periods[-7:]
    metric_tags = {}
    facts = {}
    fallbacks = {}
    for key, names in CONCEPTS.items():
        if key in UNMAPPED.get(slug, {}):
            metric_tags[key], facts[key] = None, []
            continue
        metric_tags[key], facts[key] = choose_flow_tag(payload, names, periods)
        report = None
        if key in FALLBACK_METRICS:
            facts[key], report = add_fallback_spans(payload, names, metric_tags[key], facts[key])
        if report:
            # Keep only the fallback spans that feed a period in the window (its own span,
            # its fiscal YTD span, or the previous quarter's fiscal YTD span).
            needed = set()
            for period in periods:
                needed.add((period["start"], period["end"]))
                for candidate in all_periods:
                    if candidate["fy"] == period["fy"] and candidate["quarter"] in (period["quarter"], period["quarter"] - 1):
                        needed.add((candidate["fiscalStart"], candidate["end"]))
            report["spans"] = [span for span in report["spans"] if (span["start"], span["end"]) in needed]
            if report["spans"]:
                fallbacks[key] = report
    instant = {}
    for key, names in INSTANT_CONCEPTS.items():
        metric_tags[key], instant[key] = choose_instant_tag(payload, names, periods)
    debt_facts = {
        name: tag_facts(payload, name, instant=True)
        for name in [DEBT_CURRENT_TOTAL, *DEBT_CURRENT_PARTS, *DEBT_NONCURRENT]
    }
    rows = []
    for period in periods:
        metrics = {}
        fiscal_ytd_metrics = {}
        derived_metrics = []
        for key in INCOME_KEYS:
            value, derived = metric_value(facts[key], period, all_periods)
            metrics[key] = value
            fiscal_ytd_metrics[key] = fiscal_ytd_value(facts[key], period)
            if derived:
                derived_metrics.append(key)
        if metrics["grossProfit"] is None and metrics["revenue"] is not None and metrics["costOfRevenue"] is not None:
            metrics["grossProfit"] = round(metrics["revenue"] - metrics["costOfRevenue"], 3)
            derived_metrics.append("grossProfit")
        for key in CASH_FLOW_KEYS:
            value, derived = metric_value(facts[key], period, all_periods, ytd_first=True)
            metrics[key] = value
            fiscal_ytd_metrics[key] = fiscal_ytd_value(facts[key], period)
            if derived:
                derived_metrics.append(key)
        if metrics["operatingCashFlow"] is not None and metrics["capex"] is not None:
            metrics["freeCashFlow"] = round(metrics["operatingCashFlow"] - metrics["capex"], 3)
            derived_metrics.append("freeCashFlow")
        else:
            metrics["freeCashFlow"] = None
        if fiscal_ytd_metrics["operatingCashFlow"] is not None and fiscal_ytd_metrics["capex"] is not None:
            fiscal_ytd_metrics["freeCashFlow"] = round(
                fiscal_ytd_metrics["operatingCashFlow"] - fiscal_ytd_metrics["capex"], 3
            )
        else:
            fiscal_ytd_metrics["freeCashFlow"] = None
        for key in INSTANT_CONCEPTS:
            metrics[key] = value_millions(instant_for(instant[key], period["end"]))
        metrics["debtCurrent"], metrics["debtNoncurrent"], metrics["totalDebt"], debt_is_sum = debt_values(debt_facts, period["end"])
        if debt_is_sum:
            derived_metrics.append("totalDebt")

        # The period is attributed to the filing that first reported it (the 10-Q for that
        # quarter, or the 10-K for a fiscal Q4), not a later filing's comparative column.
        source_fact = period["sourceFact"]
        rows.append({
            "label": f"Q{period['quarter']} FY{str(period['fy'])[-2:]}",
            "periodEnd": period["end"],
            "metrics": metrics,
            "fiscalYtdMetrics": fiscal_ytd_metrics,
            "derivedMetrics": sorted(set(derived_metrics)),
            "source": {
                "form": source_fact.get("form"), "filed": source_fact.get("filed"),
                # Same date as "filed": the source is always the first filing for the period.
                "firstFiled": source_fact.get("filed"),
                "accession": source_fact.get("accn"),
                "url": f"https://www.sec.gov/Archives/edgar/data/{int(config['cik'])}/{source_fact.get('accn', '').replace('-', '')}/",
            },
        })

    return {
        **config,
        "sourceType": "SEC Company Facts",
        "sourceUrl": url,
        "metricTags": metric_tags,
        "metricTagFallbacks": fallbacks,
        "unmappedMetrics": UNMAPPED.get(slug, {}),
        "periods": rows,
        "restatements": restatement_rows(payload, metric_tags, all_periods, facts),
        # Period ends that change detection covered (wider than the seven quarters shown).
        "restatementWindow": [
            {"label": f"Q{period['quarter']} FY{str(period['fy'])[-2:]}", "periodEnd": period["end"]}
            for period in lookback_periods(all_periods)
        ],
    }


def main() -> None:
    output = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "units": "USD millions",
        "vintage": VINTAGE,
        "methodology": (
            "As originally filed, one primary XBRL tag per metric per company; a renamed tag may fill only "
            "spans the primary never filed, after an identical-value bridge check (metricTagFallbacks). "
            "Income-statement quarters are filed "
            "three-month facts; cash-flow quarters are differences between filed fiscal year-to-date facts; "
            "fiscal Q4 is the filed annual fact minus the first three quarters. Total debt is current plus "
            "noncurrent carrying value from the balance sheet. Derived values are listed in derivedMetrics."
        ),
        "companies": {slug: build_company(slug, config) for slug, config in COMPANIES.items()},
    }
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(output, handle, indent=2)
        handle.write("\n")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
