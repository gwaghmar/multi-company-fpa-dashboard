#!/usr/bin/env python3
"""Build companies.json from official SEC Company Facts data.

The output is intentionally standardized. It includes only metrics that can be
mapped consistently across issuers. Quarterly values are filed three-month
facts when available; fiscal Q4 and cumulative cash-flow quarters are derived
from filed annual/YTD facts and labelled as derived.
"""

from __future__ import annotations

import json
import os
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone


USER_AGENT = "Govind Waghmare sec-contact@example.invalid"
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
    "netIncome": ["NetIncomeLossAvailableToCommonStockholdersBasic", "NetIncomeLoss", "ProfitLoss"],
    "rd": ["ResearchAndDevelopmentExpense"],
    "operatingCashFlow": ["NetCashProvidedByUsedInOperatingActivities"],
    "capex": ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
    "repurchases": ["PaymentsForRepurchaseOfCommonStock"],
    "dividends": ["PaymentsOfDividendsCommonStock", "PaymentsOfDividends"],
    "shareBasedCompensation": ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"],
}

INSTANT_CONCEPTS = {
    "cash": ["CashAndCashEquivalentsAtCarryingValue"],
    "shortTermInvestments": ["ShortTermInvestments", "MarketableSecuritiesCurrent"],
    "accountsReceivable": ["AccountsReceivableNetCurrent"],
    "accountsPayable": ["AccountsPayableCurrent"],
    "currentAssets": ["AssetsCurrent"],
    "currentLiabilities": ["LiabilitiesCurrent"],
    "totalAssets": ["Assets"],
    "totalLiabilities": ["Liabilities"],
    "debtCurrent": ["LongTermDebtCurrent", "ShortTermBorrowings"],
    "debtNoncurrent": ["LongTermDebtNoncurrent"],
    "totalDebtReported": ["LongTermDebt"],
}


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def day(value: str) -> date:
    return date.fromisoformat(value)


def duration(item: dict) -> int:
    return (day(item["end"]) - day(item["start"])).days + 1


def concept_facts(payload: dict, names: list[str]) -> list[dict]:
    output = []
    gaap = payload.get("facts", {}).get("us-gaap", {})
    for priority, name in enumerate(names):
        for item in gaap.get(name, {}).get("units", {}).get("USD", []):
            if item.get("form") not in {"10-Q", "10-K"} or not item.get("start") or not item.get("end"):
                continue
            row = dict(item)
            row["concept"] = name
            row["priority"] = priority
            output.append(row)
    return output


def instant_facts(payload: dict, names: list[str]) -> list[dict]:
    output = []
    gaap = payload.get("facts", {}).get("us-gaap", {})
    for priority, name in enumerate(names):
        for item in gaap.get(name, {}).get("units", {}).get("USD", []):
            if item.get("form") not in {"10-Q", "10-K"} or not item.get("end"):
                continue
            row = dict(item)
            row["concept"] = name
            row["priority"] = priority
            output.append(row)
    return output


def latest(items: list[dict]) -> dict | None:
    if not items:
        return None
    return max(items, key=lambda item: (item.get("filed", ""), -item.get("priority", 99)))


def earliest(items: list[dict]) -> dict | None:
    if not items:
        return None
    return min(items, key=lambda item: (item.get("filed", "9999"), item.get("priority", 99)))


def exact_for(items: list[dict], start: str, end: str) -> dict | None:
    return latest([item for item in items if item["start"] == start and item["end"] == end])


def span_for(items: list[dict], start: str, end: str) -> dict | None:
    return latest([item for item in items if item["start"] == start and item["end"] == end])


def value_millions(item: dict | None) -> float | None:
    if not item or not isinstance(item.get("val"), (int, float)):
        return None
    return round(item["val"] / 1_000_000, 3)


def instant_value(items: list[dict], period_end: str) -> float | None:
    return value_millions(latest([item for item in items if item["end"] == period_end]))


def build_periods(revenue_facts: list[dict]) -> list[dict]:
    by_span = defaultdict(list)
    for item in revenue_facts:
        by_span[(item["start"], item["end"])].append(item)

    periods = []
    for (start, end), items in by_span.items():
        first = earliest(items)
        if 70 <= duration(first) <= 110 and first.get("fp") in {"Q1", "Q2", "Q3"}:
            current = latest(items)
            periods.append({
                "start": start, "end": end, "quarter": int(first["fp"][1]),
                "fy": int(first["fy"]), "derived": False, "revenueFact": current,
                "fiscalStart": None,
            })

    annual_by_span = defaultdict(list)
    for item in revenue_facts:
        if item.get("fp") == "FY" and 330 <= duration(item) <= 380:
            annual_by_span[(item["start"], item["end"])].append(item)

    for (start, end), items in annual_by_span.items():
        first = earliest(items)
        fy = int(first["fy"])
        q123 = sorted(
            [period for period in periods if period["fy"] == fy and start <= period["start"] and period["end"] < end],
            key=lambda period: period["end"],
        )
        if len(q123) < 3:
            continue
        q123 = q123[-3:]
        current = latest(items)
        periods.append({
            "start": (day(q123[-1]["end"]) + timedelta(days=1)).isoformat(),
            "end": end, "quarter": 4, "fy": fy, "derived": True,
            "annualFact": current, "q123": q123, "fiscalStart": start,
        })

    periods.sort(key=lambda period: period["end"])
    for period in periods:
        if period["fiscalStart"] is None:
            same_fy = [candidate for candidate in periods if candidate["fy"] == period["fy"] and candidate["quarter"] <= period["quarter"]]
            period["fiscalStart"] = min(candidate["start"] for candidate in same_fy)
    return periods


def metric_value(items: list[dict], period: dict, all_periods: list[dict], cumulative: bool = False) -> tuple[float | None, bool]:
    direct = exact_for(items, period["start"], period["end"])
    if direct:
        return value_millions(direct), False

    fiscal_periods = sorted(
        [candidate for candidate in all_periods if candidate["fy"] == period["fy"] and candidate["quarter"] <= period["quarter"]],
        key=lambda candidate: candidate["quarter"],
    )
    fiscal_start = period["fiscalStart"]
    if cumulative and period["quarter"] in {2, 3}:
        current = span_for(items, fiscal_start, period["end"])
        previous_period = fiscal_periods[-2]
        previous = span_for(items, fiscal_start, previous_period["end"])
        if current and previous:
            return round((current["val"] - previous["val"]) / 1_000_000, 3), True

    if period["quarter"] == 4:
        annual = span_for(items, fiscal_start, period["end"])
        earlier_values = []
        for candidate in fiscal_periods[:-1]:
            value, _ = metric_value(items, candidate, all_periods, cumulative=cumulative)
            if value is None:
                return None, True
            earlier_values.append(value)
        if annual and len(earlier_values) == 3:
            return round(annual["val"] / 1_000_000 - sum(earlier_values), 3), True
    return None, False


def build_company(slug: str, config: dict) -> dict:
    url = f"https://data.sec.gov/api/xbrl/companyfacts/CIK{config['cik']}.json"
    payload = fetch_json(url)
    facts = {key: concept_facts(payload, names) for key, names in CONCEPTS.items()}
    instant = {key: instant_facts(payload, names) for key, names in INSTANT_CONCEPTS.items()}
    all_periods = build_periods(facts["revenue"])
    periods = all_periods[-7:]
    rows = []
    for period in periods:
        metrics = {}
        derived_metrics = []
        for key in ["revenue", "costOfRevenue", "grossProfit", "operatingIncome", "netIncome", "rd"]:
            value, derived = metric_value(facts[key], period, all_periods)
            metrics[key] = value
            if derived:
                derived_metrics.append(key)
        if metrics["grossProfit"] is None and metrics["revenue"] is not None and metrics["costOfRevenue"] is not None:
            metrics["grossProfit"] = round(metrics["revenue"] - metrics["costOfRevenue"], 3)
            derived_metrics.append("grossProfit")
        for key in ["operatingCashFlow", "capex", "repurchases", "dividends", "shareBasedCompensation"]:
            value, derived = metric_value(facts[key], period, all_periods, cumulative=True)
            metrics[key] = value
            if derived:
                derived_metrics.append(key)
        if metrics["operatingCashFlow"] is not None and metrics["capex"] is not None:
            metrics["freeCashFlow"] = round(metrics["operatingCashFlow"] - metrics["capex"], 3)
            derived_metrics.append("freeCashFlow")
        else:
            metrics["freeCashFlow"] = None
        for key in INSTANT_CONCEPTS:
            metrics[key] = instant_value(instant[key], period["end"])
        if metrics["totalDebtReported"] is not None:
            metrics["totalDebt"] = metrics["totalDebtReported"]
        elif metrics["debtCurrent"] is not None or metrics["debtNoncurrent"] is not None:
            metrics["totalDebt"] = round((metrics["debtCurrent"] or 0) + (metrics["debtNoncurrent"] or 0), 3)
            derived_metrics.append("totalDebt")
        else:
            metrics["totalDebt"] = None

        source_fact = period.get("revenueFact") or period.get("annualFact")
        rows.append({
            "label": f"Q{period['quarter']} FY{str(period['fy'])[-2:]}",
            "periodEnd": period["end"],
            "metrics": metrics,
            "derivedMetrics": sorted(set(derived_metrics)),
            "source": {
                "form": source_fact.get("form"), "filed": source_fact.get("filed"),
                "accession": source_fact.get("accn"),
                "url": f"https://www.sec.gov/Archives/edgar/data/{int(config['cik'])}/{source_fact.get('accn', '').replace('-', '')}/",
            },
        })

    return {
        **config,
        "sourceType": "SEC Company Facts",
        "sourceUrl": url,
        "periods": rows,
    }


def main() -> None:
    output = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "units": "USD millions",
        "methodology": "Filed three-month facts where available; fiscal Q4 and cumulative cash-flow quarters are arithmetic derivations from filed annual/YTD facts.",
        "companies": {slug: build_company(slug, config) for slug, config in COMPANIES.items()},
    }
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(output, handle, indent=2)
        handle.write("\n")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
