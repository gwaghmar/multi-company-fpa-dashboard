#!/usr/bin/env python3
"""Build compact public-company narrative and macro context from free official sources.

Sources are deliberately bounded:
- SEC submissions, 10-Q/10-K narrative, and earnings-related 8-K exhibits
- Official company investor-relations landing pages (links only)
- U.S. Treasury yield curve, BLS CPI/unemployment, and ECB reference FX rates

The output stores short source excerpts, links, dates, and explicit source types.
It does not infer management causes, analyst consensus, stock prices, or internal plans.
"""

from __future__ import annotations

import csv
import html
import io
import json
import os
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from html.parser import HTMLParser


ROOT = os.path.dirname(os.path.dirname(__file__))
COMPANIES_PATH = os.path.join(ROOT, "companies.json")
OUT = os.path.join(ROOT, "company-context.json")
USER_AGENT = os.environ.get("SEC_USER_AGENT") or "findashboard local run (set SEC_USER_AGENT to 'Name email')"

IR_URLS = {
    "apple": "https://investor.apple.com/",
    "alphabet": "https://abc.xyz/investor/",
    "nvidia": "https://investor.nvidia.com/",
    "microsoft": "https://www.microsoft.com/en-us/Investor/",
    "amazon": "https://ir.aboutamazon.com/",
    "meta": "https://investor.atmeta.com/",
    "amd": "https://ir.amd.com/",
    "broadcom": "https://investors.broadcom.com/",
    "oracle": "https://investor.oracle.com/",
    "salesforce": "https://investor.salesforce.com/",
    "intel": "https://www.intc.com/",
}

SIGNAL_KEYWORDS = {
    "Guidance": ["guidance", "financial outlook", "we expect revenue", "we expect third", "expects revenue", "forecasting"],
    "Demand and revenue": ["revenue", "demand", "sales", "bookings", "backlog", "consumption"],
    "Margin and cost": ["gross margin", "operating margin", "profitability", "cost", "expense"],
    "Investment": ["capital expenditure", "capex", "investment", "infrastructure", "research and development"],
    "Workforce": ["headcount", "workforce", "employees increased", "employees decreased", "employee count", "number of employees", "hiring"],
    "Risk and supply": ["risk", "uncertainty", "supply", "constraint", "regulatory"],
}

ANNUAL_REPORT_KEYWORDS = {
    "Business and segments": ["our business", "reportable segment", "operating segment", "products and services", "business model"],
    "Revenue and demand": ["net sales", "revenue", "customer demand", "bookings", "backlog", "subscriptions"],
    "Strategy and investment": ["our strategy", "strategic", "capital expenditures", "research and development", "infrastructure investment"],
    "Liquidity and capital": ["liquidity", "capital resources", "cash flows", "share repurchase", "commercial paper", "long-term debt"],
    "Workforce": ["human capital", "workforce", "employees", "headcount", "talent"],
    "Risk and supply": ["competition", "supply chain", "regulatory", "cybersecurity", "macroeconomic", "geopolitical"],
    "Market and FX": ["foreign currency", "foreign exchange", "interest rate risk", "market risk", "currency risk"],
    "Legal and regulatory": ["legal proceedings", "litigation", "antitrust", "regulatory investigation", "government inquiry"],
}

ANNUAL_AREA_POSITIVE = {
    "Business and segments": ["we offer", "we develop", "our products", "our services", "operating segment", "reportable segment"],
    "Revenue and demand": ["revenue increased", "revenue decreased", "net sales increased", "net sales decreased", "revenue was", "backlog"],
    "Strategy and investment": ["our strategy", "capital expenditures", "research and development", "strategic focus"],
    "Liquidity and capital": ["our liquidity", "capital requirements", "cash and cash equivalents", "share repurchase", "capital resources"],
    "Workforce": ["human capital", "our employees", "we had", "headcount"],
    "Risk and supply": ["supply chain", "competition", "cybersecurity", "macroeconomic", "geopolitical"],
    "Market and FX": ["foreign currency", "foreign exchange", "interest rate risk", "market risk"],
    "Legal and regulatory": ["legal proceedings", "litigation", "antitrust", "regulatory"],
}

ANNUAL_AREA_NEGATIVE = {
    "Business and segments": ["litigation", "regulatory", "penalties", "investigation", "risk factor", "adversely", "interruptions", "shortage", "laws and regulations", "accounting standard", "does not meet expectations", "lack the capacity", "decline in use", "exercise of these rights", "item 7", "included elsewhere"],
    "Revenue and demand": ["adversely affect", "adversely impact", "we face risks", "revenue recognition", "reclassified", "portion of total net sales", "cash provided by operating activities", "note:", "legal and regulatory requirements", "enforcement actions", "required to pay fines"],
    "Strategy and investment": ["tax act", "tax provision", "immediate expensing", "financing cash flows consist"],
    "Liquidity and capital": ["impairment", "non-marketable", "valuation method", "not meant to be considered", "off-balance sheet arrangements"],
    "Workforce": ["suppliers and staffing", "independent contractors", "vendors and temporary", "cloud human capital management", "employee headcount includes"],
    "Legal and regulatory": ["information security controls"],
}

BOILERPLATE = [
    "forward-looking statements",
    "risks and uncertainties",
    "management and investors benefit",
    "ability to attract and retain",
    "no obligation to update",
    "actual results may differ",
    "supplemental information",
    "except for number of employees",
    "this press release may contain",
    "are recognized when control",
    "quantitative and qualitative disclosures",
    "revenues, traffic acquisition costs",
    "number of employees",
    "item 1 financial statements",
    "item 2 management's discussion",
    "non-gaap financial measures",
    "this presentation also contains",
    "important risk factors",
    "detailed discussion of these factors",
    "segment reporting (topic 280)",
    "improvements to reportable segment disclosures",
    "included elsewhere in this annual report",
    "more information on these risks",
    "other potential factors that could affect",
    "could affect the company's business, reputation",
]


GUIDANCE_MONEY = re.compile(r"\$\s?\d[\d,.]*\s*(?:-|to|\u2013)?\s*\$?\s?\d*[\d,.]*\s*(?:billion|million)", re.I)
GUIDANCE_REVENUE = re.compile(r"\b(?:revenue|revenues|net sales)\b", re.I)
GUIDANCE_FORWARD = re.compile(r"\b(?:expect|expects|expected|expecting|forecast|forecasting|forecasted|guidance|outlook)\b", re.I)
GUIDANCE_QUARTER = re.compile(r"\bquarter\b|\bQ[1-4]\b", re.I)


class TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "svg"}:
            self.skip += 1
        elif tag in {"p", "div", "tr", "li", "br", "h1", "h2", "h3"}:
            self.parts.append(" ")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "svg"} and self.skip:
            self.skip -= 1
        elif tag in {"p", "div", "tr", "li", "h1", "h2", "h3"}:
            self.parts.append(". ")

    def handle_data(self, data: str) -> None:
        if not self.skip:
            self.parts.append(data)


class LinkExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        href = dict(attrs).get("href")
        if href:
            self.links.append(href)


def fetch(url: str, *, body: bytes | None = None, content_type: str | None = None) -> bytes:
    headers = {"User-Agent": USER_AGENT, "Accept-Encoding": "identity"}
    if content_type:
        headers["Content-Type"] = content_type
    request = urllib.request.Request(url, data=body, headers=headers)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(1 + attempt)
    raise RuntimeError("unreachable")


def fetch_json(url: str, **kwargs) -> dict:
    return json.loads(fetch(url, **kwargs))


def html_text(raw: bytes) -> str:
    parser = TextExtractor()
    parser.feed(raw.decode("utf-8", errors="ignore"))
    text = html.unescape("".join(parser.parts))
    return re.sub(r"\s+", " ", text).strip()


def short_excerpt(sentence: str, limit: int = 24) -> str:
    words = sentence.split()
    clipped = " ".join(words[:limit]).strip(" .;:-")
    return clipped + ("…" if len(words) > limit else ".")


def extract_signals(text: str, source: dict) -> list[dict]:
    sentences = re.split(r"(?<=[.!?])\s+", text)
    output = []
    for category, keywords in SIGNAL_KEYWORDS.items():
        for sentence in sentences:
            clean = re.sub(r"\s+", " ", sentence).strip()
            lower = clean.lower()
            words = clean.split()
            if not 9 <= len(words) <= 75 or len(clean) > 620 or "http://fasb.org" in lower or not any(term in lower for term in keywords):
                continue
            if any(phrase in lower for phrase in BOILERPLATE):
                continue
            if sum(character.isalpha() for character in clean) / max(1, len(clean)) < 0.58:
                continue
            output.append({
                "category": category,
                "text": short_excerpt(clean),
                "sourceTitle": source["title"],
                "sourceType": source["sourceType"],
                "filed": source["filed"],
                "url": source["url"],
            })
            break
    return output


def extract_guidance(text: str, source: dict) -> list[dict]:
    """Verbatim 8-K exhibit sentences that state a forward revenue figure. No numbers are parsed here;
    the dashboard parses at render time and shows the sentence either way."""
    output = []
    for order, sentence in enumerate(re.split(r"(?<=[.!?])\s+", text)):
        clean = re.sub(r"\s+", " ", sentence).strip()
        clean = re.sub(r"^[\u2022\u25aa\u25cf\-\s]+", "", clean)
        clean = re.sub(r"\.\s*\.$", ".", clean)
        if not 6 <= len(clean.split()) <= 90 or len(clean) > 700:
            continue
        if not (GUIDANCE_MONEY.search(clean) and GUIDANCE_REVENUE.search(clean) and GUIDANCE_FORWARD.search(clean)):
            continue
        quoted = clean[0] in "\u201c\"'"
        output.append({
            "rank": (0 if GUIDANCE_QUARTER.search(clean) else 1, 1 if quoted else 0, order),
            "text": clean,
            "filed": source["filed"],
            "url": source["url"],
            "sourceTitle": source["title"],
        })
    return output


def extract_annual_report_context(text: str, source: dict) -> list[dict]:
    """Select compact, auditable annual-report excerpts across finance-relevant areas."""
    sentences = re.split(r"(?<=[.!?])\s+", text)
    output = []
    used = set()
    for area, keywords in ANNUAL_REPORT_KEYWORDS.items():
        candidates = []
        for sentence in sentences:
            clean = re.sub(r"\s+", " ", sentence).strip()
            lower = clean.lower()
            words = clean.split()
            matches = sum(term in lower for term in keywords)
            if not matches or not 12 <= len(words) <= 80 or len(clean) > 680 or "http://fasb.org" in lower:
                continue
            if any(phrase in lower for phrase in BOILERPLATE):
                continue
            if sum(character.isalpha() for character in clean) / max(1, len(clean)) < 0.62:
                continue
            score = matches * 5
            score += 3 * sum(term in lower for term in ANNUAL_AREA_POSITIVE.get(area, []))
            score -= 12 * sum(term in lower for term in ANNUAL_AREA_NEGATIVE.get(area, []))
            score += 2 if 18 <= len(words) <= 52 else 0
            score += 1 if re.search(r"\b(increased|decreased|grew|invest|operate|serve|provide|generate|manage|expect)\w*\b", lower) else 0
            score += 1 if re.search(r"\b\d[\d,.%$]*\b", clean) else 0
            score -= 3 if lower.startswith(("item ", "table ", "the following table", "see note")) else 0
            candidates.append((score, clean))
        candidates.sort(key=lambda item: (-item[0], len(item[1])))
        selected = next((clean for score, clean in candidates if score >= 4 and clean not in used), None)
        if not selected:
            continue
        used.add(selected)
        output.append({
            "area": area,
            "text": short_excerpt(selected, 32),
            "sourceTitle": source["title"],
            "sourceType": source["sourceType"],
            "fiscalYear": source["fiscalYear"],
            "filed": source["filed"],
            "url": source["url"],
        })
    return output


def recent_rows(payload: dict) -> list[dict]:
    recent = payload.get("filings", {}).get("recent", {})
    keys = ["form", "filingDate", "reportDate", "accessionNumber", "primaryDocument", "primaryDocDescription", "items"]
    count = len(recent.get("form", []))
    return [{key: (recent.get(key, [""] * count)[index] or "") for key in keys} for index in range(count)]


def filing_base(cik: str, accession: str) -> str:
    return f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession.replace('-', '')}/"


def build_document(row: dict, url: str, title: str, source_type: str) -> dict:
    source = {"title": title, "sourceType": source_type, "filed": row["filingDate"], "url": url}
    text = html_text(fetch(url))
    guidance = extract_guidance(text, source) if source_type == "SEC 8-K exhibit" else []
    return {**source, "signals": extract_signals(text, source), "guidanceCandidates": guidance}


def build_annual_report(row: dict, url: str) -> dict:
    fiscal_year = (row.get("reportDate") or row["filingDate"])[:4]
    source = {
        "title": f"FY{fiscal_year} annual report",
        "sourceType": "SEC 10-K annual report",
        "fiscalYear": fiscal_year,
        "filed": row["filingDate"],
        "url": url,
    }
    text = html_text(fetch(url))
    return {**source, "evidence": extract_annual_report_context(text, source)}


def company_context(slug: str, company: dict) -> dict:
    cik = company["cik"]
    submissions_url = f"https://data.sec.gov/submissions/CIK{cik}.json"
    submissions = fetch_json(submissions_url)
    rows = recent_rows(submissions)
    relevant = [row for row in rows if row["form"] in {"10-Q", "10-K", "8-K"}]
    filings = [{
        "form": row["form"],
        "filed": row["filingDate"],
        "description": row["primaryDocDescription"] or row["form"],
        "url": filing_base(cik, row["accessionNumber"]) + row["primaryDocument"],
    } for row in relevant[:8]]

    documents: list[dict] = []
    earnings_8k = next((row for row in relevant if row["form"] == "8-K" and "2.02" in row["items"]), None)
    if earnings_8k:
        base = filing_base(cik, earnings_8k["accessionNumber"])
        primary_url = base + earnings_8k["primaryDocument"]
        parser = LinkExtractor()
        parser.feed(fetch(primary_url).decode("utf-8", errors="ignore"))
        exhibit_links = []
        for href in parser.links:
            clean = href.split("#", 1)[0]
            if clean.lower().endswith((".htm", ".html")) and clean != earnings_8k["primaryDocument"] and clean not in exhibit_links:
                exhibit_links.append(clean)
        exhibit_links.sort(key=lambda link: ("comment" not in link.lower(), "pr" not in link.lower(), link))
        for href in exhibit_links[:2]:
            lower = href.lower()
            title = "CFO commentary" if "comment" in lower else "Earnings release exhibit"
            try:
                documents.append(build_document(earnings_8k, urllib.parse.urljoin(base, href), title, "SEC 8-K exhibit"))
            except Exception as error:
                documents.append({"title": title, "sourceType": "SEC 8-K exhibit", "filed": earnings_8k["filingDate"], "url": urllib.parse.urljoin(base, href), "signals": [], "error": str(error)[:120]})

    latest_periodic = next((row for row in relevant if row["form"] in {"10-Q", "10-K"}), None)
    if latest_periodic:
        url = filing_base(cik, latest_periodic["accessionNumber"]) + latest_periodic["primaryDocument"]
        try:
            documents.append(build_document(latest_periodic, url, f"Latest {latest_periodic['form']} narrative", "SEC filing narrative"))
        except Exception as error:
            documents.append({"title": f"Latest {latest_periodic['form']} narrative", "sourceType": "SEC filing narrative", "filed": latest_periodic["filingDate"], "url": url, "signals": [], "error": str(error)[:120]})

    latest_annual = next((row for row in relevant if row["form"] == "10-K"), None)
    annual_report = None
    if latest_annual:
        annual_url = filing_base(cik, latest_annual["accessionNumber"]) + latest_annual["primaryDocument"]
        try:
            annual_report = build_annual_report(latest_annual, annual_url)
        except Exception as error:
            annual_report = {
                "title": "Latest annual report", "sourceType": "SEC 10-K annual report",
                "fiscalYear": (latest_annual.get("reportDate") or latest_annual["filingDate"])[:4],
                "filed": latest_annual["filingDate"], "url": annual_url, "evidence": [], "error": str(error)[:120],
            }

    # One verbatim guidance sentence per company: quarterly beats annual, narrative beats a quoted
    # remark, then earliest in the exhibit. Null when no 8-K exhibit states a forward revenue figure.
    candidates = [(item["rank"], index, item) for index, document in enumerate(documents) for item in document.get("guidanceCandidates", [])]
    guidance = None
    if candidates:
        best = min(candidates, key=lambda entry: (entry[0][0], entry[0][1], entry[1], entry[0][2]))[2]
        guidance = {key: best[key] for key in ("text", "filed", "url", "sourceTitle")}

    signals = []
    seen_categories = set()
    for document in documents:
        for signal in document.get("signals", []):
            if signal["category"] not in seen_categories:
                signals.append(signal)
                seen_categories.add(signal["category"])

    return {
        "name": company["name"],
        "ticker": company["ticker"],
        "irUrl": IR_URLS.get(slug),
        "submissionsUrl": submissions_url,
        "recentFilings": filings,
        "documents": [{key: value for key, value in document.items() if key not in {"signals", "guidanceCandidates"}} for document in documents],
        "managementSignals": signals[:6],
        "guidance": guidance,
        "annualReport": annual_report,
        "coverage": {
            "secFilings": bool(filings),
            "managementCommentary": bool(signals),
            "annualReport": bool(annual_report and annual_report.get("evidence")),
            "investorRelationsLink": bool(IR_URLS.get(slug)),
            "internalPlan": False,
            "analystConsensus": False,
            "stockPrices": False,
        },
    }


def treasury_context() -> dict:
    year = datetime.now(timezone.utc).year
    url = f"https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value={year}"
    root = ET.fromstring(fetch(url))
    ns = {"a": "http://www.w3.org/2005/Atom", "m": "http://schemas.microsoft.com/ado/2007/08/dataservices/metadata", "d": "http://schemas.microsoft.com/ado/2007/08/dataservices"}
    rows = []
    for entry in root.findall("a:entry", ns):
        properties = entry.find("a:content/m:properties", ns)
        if properties is None:
            continue
        value = lambda name: properties.findtext(f"d:{name}", default="", namespaces=ns)
        rows.append({"date": value("NEW_DATE")[:10], "threeMonth": value("BC_3MONTH"), "twoYear": value("BC_2YEAR"), "tenYear": value("BC_10YEAR"), "thirtyYear": value("BC_30YEAR")})
    latest = max(rows, key=lambda row: row["date"])
    return {**latest, "unit": "%", "source": "U.S. Treasury", "sourceUrl": url}


def bls_context() -> dict:
    year = datetime.now(timezone.utc).year
    url = "https://api.bls.gov/publicAPI/v2/timeseries/data/"
    payload = json.dumps({"seriesid": ["CUUR0000SA0", "LNS14000000"], "startyear": str(year - 1), "endyear": str(year)}).encode()
    response = fetch_json(url, body=payload, content_type="application/json")
    series = {item["seriesID"]: item["data"] for item in response.get("Results", {}).get("series", [])}
    cpi_rows = [row for row in series.get("CUUR0000SA0", []) if row.get("period") != "M13"]
    unemployment_rows = [row for row in series.get("LNS14000000", []) if row.get("period") != "M13"]
    latest_cpi = cpi_rows[0]
    prior_cpi = next((row for row in cpi_rows if row["period"] == latest_cpi["period"] and int(row["year"]) == int(latest_cpi["year"]) - 1), None)
    cpi_yoy = None if not prior_cpi else round(100 * (float(latest_cpi["value"]) / float(prior_cpi["value"]) - 1), 2)
    latest_unemployment = unemployment_rows[0]
    return {
        "cpi": {"period": f"{latest_cpi['year']}-{latest_cpi['period'][1:]}", "index": float(latest_cpi["value"]), "yearOverYearPct": cpi_yoy},
        "unemployment": {"period": f"{latest_unemployment['year']}-{latest_unemployment['period'][1:]}", "ratePct": float(latest_unemployment["value"])},
        "source": "U.S. Bureau of Labor Statistics",
        "sourceUrl": "https://www.bls.gov/developers/",
    }


def ecb_context() -> dict:
    currencies = "USD+GBP+JPY+CNY"
    url = f"https://data-api.ecb.europa.eu/service/data/EXR/D.{currencies}.EUR.SP00.A?format=csvdata&lastNObservations=1"
    rows = list(csv.DictReader(io.StringIO(fetch(url).decode("utf-8"))))
    return {
        "asOf": max(row["TIME_PERIOD"] for row in rows),
        "ratesPerEuro": {row["CURRENCY"]: float(row["OBS_VALUE"]) for row in rows},
        "source": "European Central Bank",
        "sourceUrl": url,
    }


def safe_source(name: str, builder) -> dict:
    try:
        return {"status": "connected", **builder()}
    except Exception as error:
        return {"status": "unavailable", "source": name, "error": str(error)[:160]}


def load_previous_output() -> dict:
    try:
        with open(OUT, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def merge_guidance_history(previous: dict | None, current: dict | None) -> list[dict]:
    """Every distinct guidance entry seen so far, deduped by (url, text), sorted by filed date.

    Carried forward from the previous company-context.json (its guidanceHistory plus its latest
    guidance, so a file written before this field existed seeds itself) and extended with today's.
    """
    entries = list((previous or {}).get("guidanceHistory") or [])
    for item in ((previous or {}).get("guidance"), current):
        if item:
            entries.append(item)
    seen: set[tuple[str, str]] = set()
    merged: list[dict] = []
    for item in entries:
        if not isinstance(item, dict) or not item.get("text"):
            continue
        key = (str(item.get("url") or ""), str(item["text"]))
        if key in seen:
            continue
        seen.add(key)
        merged.append({field: item.get(field) for field in ("text", "filed", "url", "sourceTitle")})
    merged.sort(key=lambda item: (str(item.get("filed") or ""), str(item.get("url") or ""), item["text"]))
    return merged


def main() -> None:
    previous = load_previous_output()
    previous_companies = previous.get("companies") or {}
    with open(COMPANIES_PATH, encoding="utf-8") as handle:
        companies = json.load(handle)["companies"]
    output = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "methodology": "Official public sources only. Management signals are short source excerpts, not AI-generated causal conclusions. Internal plans, consensus and stock prices remain unavailable.",
        "macro": {
            "treasury": safe_source("U.S. Treasury", treasury_context),
            "labor": safe_source("U.S. Bureau of Labor Statistics", bls_context),
            "fx": safe_source("European Central Bank", ecb_context),
        },
        "companies": {},
    }
    for slug, company in companies.items():
        try:
            output["companies"][slug] = company_context(slug, company)
        except Exception as error:
            output["companies"][slug] = {
                "name": company["name"], "ticker": company["ticker"], "irUrl": IR_URLS.get(slug),
                "managementSignals": [], "guidance": None, "recentFilings": [], "documents": [], "annualReport": None,
                "coverage": {"secFilings": False, "managementCommentary": False, "annualReport": False, "investorRelationsLink": bool(IR_URLS.get(slug)), "internalPlan": False, "analystConsensus": False, "stockPrices": False},
                "error": str(error)[:160],
            }
        entry = output["companies"][slug]
        entry["guidanceHistory"] = merge_guidance_history(previous_companies.get(slug), entry.get("guidance"))
        time.sleep(0.12)
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(output, handle, indent=2)
        handle.write("\n")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
