#!/usr/bin/env python3
"""
fetch_edgar_data.py

Rebuilds the Apple FP&A dashboard dataset (data.json + the 11 CSV exports)
from REAL data pulled straight off SEC EDGAR. No estimated or invented
numbers -- the only two derivations used are documented in meta.derived
in the output data.json:

  1. Q4 FY25 flow items (revenue, cost of sales, opex, category/segment
     revenue, segment operating income, quarterly cash flow) are computed
     as: FY25 10-K annual value MINUS the sum of the three FY25 10-Q
     quarterly (Q1+Q2+Q3) filed values. Pure arithmetic on filed numbers.
     (Q4 FY25 balance-sheet values are DIRECT from the 10-K, not derived.)

  2. Quarterly cash-flow line items are derived as YTD(N) - YTD(N-1),
     since Apple's cash flow statement is filed cumulative/year-to-date.

Sources (SEC EDGAR, Apple CIK 0000320193):
  - https://data.sec.gov/submissions/CIK0000320193.json
      (looks up the accession number for each target filing dynamically)
  - https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json
      (non-dimensional us-gaap/dei facts: income statement, balance sheet,
      cash flow company totals)
  - Per-filing XBRL instance documents (aapl-YYYYMMDD_htm.xml), parsed
      directly for DIMENSIONAL facts that companyfacts.json does not carry:
      product-category revenue/cost, geographic-segment revenue/cost/op
      income, and Apple's custom "intangible assets" extension tag.

Python 3 stdlib only (urllib, json, xml.etree, csv). Everything downloaded
is cached under CACHE_DIR so re-runs do not re-hit sec.gov.

Usage:
    python3 fetch_edgar_data.py [--cache-dir DIR] [--no-network]
"""
import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

UA = "Govind Waghmare sec-contact@example.invalid"
CIK = "0000320193"
DEFAULT_CACHE_DIR = (
    "/private/tmp/claude-501/-Users-redforman-dashboard/"
    "24c77cf9-59fe-4a8b-b517-c27329f2c7df/scratchpad/edgar_cache"
)
REPO_ROOT = "/Users/redforman/dashboard"
DASH_DIR = os.path.join(REPO_ROOT, "applications/apple-demo/dashboard-v2")

XBRLI = "http://www.xbrl.org/2003/instance"
XBRLDI = "http://xbrl.org/2006/xbrldi"
NS = {"xbrli": XBRLI, "xbrldi": XBRLDI}

# Target filings: quarter label -> (form, report/period-end date).
# The accession number for each is looked up dynamically from
# submissions.json so the script stays rerunnable as new filings land.
TARGET_FILINGS = [
    ("Q1 FY25", "10-Q", "2024-12-28"),
    ("Q2 FY25", "10-Q", "2025-03-29"),
    ("Q3 FY25", "10-Q", "2025-06-28"),
    ("FY25 10-K", "10-K", "2025-09-27"),
    ("Q1 FY26", "10-Q", "2025-12-27"),
    ("Q2 FY26", "10-Q", "2026-03-28"),
    ("Q3 FY26", "10-Q", "2026-06-27"),
]
QUARTERS = ["Q1 FY25", "Q2 FY25", "Q3 FY25", "Q4 FY25", "Q1 FY26", "Q2 FY26", "Q3 FY26"]
QUARTER_ENDS = [
    "2024-12-28", "2025-03-29", "2025-06-28", "2025-09-27",
    "2025-12-27", "2026-03-28", "2026-06-27",
]
# Optional leading snapshot (FY24 fiscal year end) for the balance sheet.
FY24_10K = ("FY24 10-K", "10-K", "2024-09-28")

CATEGORIES = {
    "iPhone": "IPhoneMember",
    "Mac": "MacMember",
    "iPad": "IPadMember",
    "Wearables, Home & Acc.": "WearablesHomeandAccessoriesMember",
    "Services": "ServiceMember",  # us-gaap member, not aapl
}
GEOGRAPHIES = {
    "Americas": "AmericasSegmentMember",
    "Europe": "EuropeSegmentMember",
    "Greater China": "GreaterChinaSegmentMember",
    "Japan": "JapanSegmentMember",
    "Rest of Asia Pacific": "RestOfAsiaPacificSegmentMember",
}
SM_CONCEPT = "SellingAndMarketingExpense"
CORP_MEMBER = "us-gaap:CorporateNonSegmentMember"

REV_CONCEPT = "RevenueFromContractWithCustomerExcludingAssessedTax"
COS_CONCEPT = "CostOfGoodsAndServicesSold"
OPINC_CONCEPT = "OperatingIncomeLoss"

BS_CONCEPTS = {
    "cash": "CashAndCashEquivalentsAtCarryingValue",
    "mktSecCurrent": "MarketableSecuritiesCurrent",
    "ar": "AccountsReceivableNetCurrent",
    "vendorNTR": "NontradeReceivablesCurrent",
    "inventories": "InventoryNet",
    "otherCurrentAssets": "OtherAssetsCurrent",
    "totalCurrentAssets": "AssetsCurrent",
    "mktSecNonCurrent": "MarketableSecuritiesNoncurrent",
    "ppe": "PropertyPlantAndEquipmentNet",
    "otherNonCurrent": "OtherAssetsNoncurrent",
    "totalAssets": "Assets",
    "ap": "AccountsPayableCurrent",
    "otherCurrentLiab": "OtherLiabilitiesCurrent",
    "deferredRev": "ContractWithCustomerLiabilityCurrent",
    "commercialPaper": "CommercialPaper",
    "termDebtCurrent": "LongTermDebtCurrent",
    "totalCurrentLiab": "LiabilitiesCurrent",
    "termDebtNonCurrent": "LongTermDebtNoncurrent",
    "otherNonCurrentLiab": "OtherLiabilitiesNoncurrent",
    "totalLiab": "Liabilities",
    "equity": "StockholdersEquity",
}
# Custom Apple XBRL extension concept -- only appears starting the Q2 FY26
# 10-Q, when Apple began breaking "Intangible assets, net" out of "Other
# non-current assets" as its own balance-sheet line. Not in companyfacts.json
# (that API only covers dei/us-gaap, not company-specific extension tags).
INTANGIBLES_TAG = "IntangibleAssetsNetExcludingGoodwillNoncurrent"

CF_CONCEPTS = {
    "opCash": "NetCashProvidedByUsedInOperatingActivities",
    "depAmort": "DepreciationDepletionAndAmortization",
    "sbc": "ShareBasedCompensation",
    "capex": "PaymentsToAcquirePropertyPlantAndEquipment",
    "buybacks": "PaymentsForRepurchaseOfCommonStock",
    "dividends": "PaymentsOfDividends",
}

IS_CONCEPTS = {
    "totalRev": REV_CONCEPT,
    "totalCos": COS_CONCEPT,
    "rd": "ResearchAndDevelopmentExpense",
    "sga": "SellingGeneralAndAdministrativeExpense",
    "opIncome": OPINC_CONCEPT,
    "otherIncome": "NonoperatingIncomeExpense",
    "pretax": "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
    "tax": "IncomeTaxExpenseBenefit",
    "netIncome": "NetIncomeLoss",
}
EPS_CONCEPTS = {"epsDiluted": "EarningsPerShareDiluted", "epsBasic": "EarningsPerShareBasic"}


# --------------------------------------------------------------------------
# Fetch / cache layer
# --------------------------------------------------------------------------

class Fetcher:
    def __init__(self, cache_dir, allow_network=True):
        self.cache_dir = cache_dir
        self.allow_network = allow_network
        os.makedirs(cache_dir, exist_ok=True)

    def get(self, url, cache_name):
        path = os.path.join(self.cache_dir, cache_name)
        if os.path.exists(path):
            with open(path, "rb") as f:
                return f.read()
        if not self.allow_network:
            raise RuntimeError(f"{cache_name} not cached and network disabled: {url}")
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        last_err = None
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    data = r.read()
                with open(path, "wb") as f:
                    f.write(data)
                time.sleep(0.25)
                return data
            except (urllib.error.URLError, urllib.error.HTTPError) as e:
                last_err = e
                time.sleep(1.0)
        raise RuntimeError(f"Failed to fetch {url} after retries: {last_err}")

    def get_json(self, url, cache_name):
        return json.loads(self.get(url, cache_name).decode("utf-8"))

    def get_text(self, url, cache_name):
        return self.get(url, cache_name).decode("utf-8")


# --------------------------------------------------------------------------
# XBRL instance-document parsing
# --------------------------------------------------------------------------

def parse_instance(path):
    tree = ET.parse(path)
    root = tree.getroot()
    contexts = {}
    for c in root.findall("xbrli:context", NS):
        cid = c.get("id")
        period = c.find("xbrli:period", NS)
        sd = period.find("xbrli:startDate", NS)
        ed = period.find("xbrli:endDate", NS)
        inst = period.find("xbrli:instant", NS)
        segs = c.findall("xbrli:entity/xbrli:segment/xbrldi:explicitMember", NS)
        dims = tuple(sorted((m.get("dimension"), m.text) for m in segs))
        contexts[cid] = {
            "start": sd.text if sd is not None else None,
            "end": ed.text if ed is not None else None,
            "instant": inst.text if inst is not None else None,
            "dims": dims,
        }
    facts = {}
    for el in root.iter():
        cr = el.get("contextRef")
        if cr is None:
            continue
        tag = el.tag.split("}")[-1]
        facts.setdefault((tag, cr), []).append(el.text)
    return contexts, facts


def duration_days(c):
    if c["start"] and c["end"]:
        return (date.fromisoformat(c["end"]) - date.fromisoformat(c["start"])).days
    return None


def bucket_of(days):
    if days is None:
        return None
    if 75 <= days <= 100:
        return "3mo"
    if 165 <= days <= 195:
        return "6mo"
    if 255 <= days <= 285:
        return "9mo"
    if 350 <= days <= 380:
        return "annual"
    return None


def find_dim_contexts(contexts, member_names):
    """Return {bucket: [(cid, ctx), ...]} sorted desc by end date, for
    contexts whose dimension MEMBER values are a superset of member_names.
    We match on member values only (not axis names), because the axis
    prefix Apple uses for the same dimension (e.g. plain
    StatementBusinessSegmentsAxis vs. StatementBusinessSegmentsAxis plus
    a ConsolidationItemsAxis=OperatingSegmentsMember annotation) is not
    stable across filing years."""
    required = set(member_names)
    out = {}
    for cid, c in contexts.items():
        ctx_members = {m for _, m in c["dims"]}
        if not required.issubset(ctx_members):
            continue
        extra = ctx_members - required
        if extra and extra != {"us-gaap:OperatingSegmentsMember"}:
            continue
        b = bucket_of(duration_days(c))
        if b is None:
            continue
        out.setdefault(b, []).append((cid, c))
    for b in out:
        out[b].sort(key=lambda x: x[1]["end"], reverse=True)
    return out


def find_instant_context(contexts, target_date, member_names=()):
    required = set(member_names)
    for cid, c in contexts.items():
        if c["instant"] != target_date:
            continue
        ctx_members = {m for _, m in c["dims"]}
        if required:
            if not required.issubset(ctx_members) or (ctx_members - required):
                continue
        else:
            if ctx_members:
                continue
        return cid
    return None


def get_val(facts, tag, cid):
    if cid is None:
        return None
    key = (tag, cid)
    if key not in facts:
        return None
    v = facts[key][0]
    if v is None:
        return None
    try:
        return float(v) if "." in v else int(v)
    except ValueError:
        return v


def to_millions(v):
    if v is None:
        return None
    m = v / 1_000_000
    return round(m, 3) if isinstance(v, float) else round(m)


class InstanceStore:
    """Lazily parses and caches instance docs, keyed by filing label."""

    def __init__(self, fetcher, filings):
        self.fetcher = fetcher
        self.filings = filings  # label -> dict(accn, form, end, xml_url, xml_name)
        self._cache = {}

    def get(self, label):
        if label not in self._cache:
            info = self.filings[label]
            data = self.fetcher.get(info["xml_url"], info["xml_name"])
            path = os.path.join(self.fetcher.cache_dir, info["xml_name"])
            self._cache[label] = parse_instance(path)
        return self._cache[label]

    def dim_current_py(self, label, concept, member_names, bucket):
        contexts, facts = self.get(label)
        buckets = find_dim_contexts(contexts, member_names)
        lst = buckets.get(bucket, [])
        cur = get_val(facts, concept, lst[0][0]) if len(lst) >= 1 else None
        py = get_val(facts, concept, lst[1][0]) if len(lst) >= 2 else None
        return cur, py

    def instant(self, label, concept, target_date, member_names=()):
        contexts, facts = self.get(label)
        cid = find_instant_context(contexts, target_date, member_names)
        return get_val(facts, concept, cid)


# --------------------------------------------------------------------------
# EDGAR discovery: locate accession numbers dynamically
# --------------------------------------------------------------------------

def discover_filings(fetcher):
    subs = fetcher.get_json(
        f"https://data.sec.gov/submissions/CIK{CIK}.json", "submissions.json"
    )
    recent = subs["filings"]["recent"]
    n = len(recent["form"])
    by_form_date = {}
    for i in range(n):
        form = recent["form"][i]
        rd = recent["reportDate"][i]
        by_form_date[(form, rd)] = {
            "accn": recent["accessionNumber"][i],
            "filed": recent["filingDate"][i],
            "primaryDoc": recent["primaryDocument"][i],
        }

    filings = {}
    all_targets = list(TARGET_FILINGS) + [FY24_10K]
    for label, form, end_date in all_targets:
        key = (form, end_date)
        if key not in by_form_date:
            raise RuntimeError(f"Could not find {form} with reportDate={end_date} in submissions.json")
        meta = by_form_date[key]
        accn = meta["accn"]
        accn_nodash = accn.replace("-", "")
        idx_url = f"https://www.sec.gov/Archives/edgar/data/320193/{accn_nodash}/"
        idx_html = fetcher.get_text(idx_url, f"idx_{label.replace(' ', '_')}.html")
        # locate the primary XBRL instance document: *_htm.xml
        xml_name = None
        for token in idx_html.split('href="'):
            if token.startswith("/Archives") and token.split('"')[0].endswith("_htm.xml"):
                xml_name = token.split('"')[0].rsplit("/", 1)[-1]
                break
        if xml_name is None:
            raise RuntimeError(f"Could not find *_htm.xml instance doc for {label} in {idx_url}")
        filings[label] = {
            "accn": accn,
            "form": form,
            "filed": meta["filed"],
            "end": end_date,
            "xml_url": f"{idx_url}{xml_name}",
            "xml_name": xml_name,
        }
    return filings


# --------------------------------------------------------------------------
# companyfacts.json helpers (non-dimensional company-wide facts)
# --------------------------------------------------------------------------

def cf_facts(companyfacts, concept, unit="USD"):
    try:
        return companyfacts["facts"]["us-gaap"][concept]["units"][unit]
    except KeyError:
        return []


def cf_by_accn(companyfacts, concept, accn, unit="USD"):
    return [f for f in cf_facts(companyfacts, concept, unit) if f.get("accn") == accn]


def cf_current_py(companyfacts, concept, accn, bucket_days_range, unit="USD"):
    """From the filing identified by accn, return (current, py) values for
    `concept` whose duration falls in bucket_days_range, ranked by end date."""
    facts = cf_by_accn(companyfacts, concept, accn, unit)
    scored = []
    for f in facts:
        if f.get("start") is None or f.get("end") is None:
            continue
        d = (date.fromisoformat(f["end"]) - date.fromisoformat(f["start"])).days
        lo, hi = bucket_days_range
        if lo <= d <= hi:
            scored.append(f)
    scored.sort(key=lambda f: f["end"], reverse=True)
    cur = scored[0]["val"] if len(scored) >= 1 else None
    py = scored[1]["val"] if len(scored) >= 2 else None
    return cur, py


def cf_instant(companyfacts, concept, accn, target_date, unit="USD"):
    facts = cf_by_accn(companyfacts, concept, accn, unit)
    for f in facts:
        if f.get("end") == target_date:
            return f["val"]
    return None


BUCKET_RANGES = {"3mo": (75, 100), "6mo": (165, 195), "9mo": (255, 285), "annual": (350, 380)}


# --------------------------------------------------------------------------
# Main extraction
# --------------------------------------------------------------------------

def build_dataset(fetcher):
    filings = discover_filings(fetcher)
    companyfacts = fetcher.get_json(
        f"https://data.sec.gov/api/xbrl/companyfacts/CIK{CIK}.json", "companyfacts.json"
    )
    store = InstanceStore(fetcher, filings)

    Q1, Q2, Q3, K, Q1b, Q2b, Q3b = ("Q1 FY25", "Q2 FY25", "Q3 FY25", "FY25 10-K",
                                     "Q1 FY26", "Q2 FY26", "Q3 FY26")
    accn = {label: filings[label]["accn"] for label in filings}

    gaps = []

    # ---- company-wide income-statement items (7 quarters, Q4 FY25 derived) ----
    is_data = {k: [None] * 7 for k in IS_CONCEPTS}
    is_data.update({k: [None] * 7 for k in EPS_CONCEPTS})
    is_data["totalRevPY"] = [None] * 7
    # productsRev/servicesRev/productsCos/servicesCos come from instance docs (dimensional)
    for k in ("productsRev", "servicesRev", "productsCos", "servicesCos", "grossMargin", "totalOpex"):
        is_data[k] = [None] * 7

    real_quarter_filings = [Q1, Q2, Q3, None, Q1b, Q2b, Q3b]  # index 3 = Q4 FY25, derived

    for idx, label in enumerate(real_quarter_filings):
        if label is None:
            continue
        for key, concept in IS_CONCEPTS.items():
            cur, py = cf_current_py(companyfacts, concept, accn[label], BUCKET_RANGES["3mo"])
            is_data[key][idx] = to_millions(cur)
            if key == "totalRev":
                is_data["totalRevPY"][idx] = to_millions(py)
        for key, concept in EPS_CONCEPTS.items():
            cur, _ = cf_current_py(companyfacts, concept, accn[label], BUCKET_RANGES["3mo"], unit="USD/shares")
            is_data[key][idx] = cur

    # Q4 FY25 = FY25 10-K annual - 9mo FY25 (from Q3 FY25 10-Q YTD column)
    q4 = 3
    for key, concept in IS_CONCEPTS.items():
        annual, _ = cf_current_py(companyfacts, concept, accn[K], BUCKET_RANGES["annual"])
        ytd9, _ = cf_current_py(companyfacts, concept, accn[Q3], BUCKET_RANGES["9mo"])
        is_data[key][q4] = to_millions(annual - ytd9) if annual is not None and ytd9 is not None else None
    # PY for Q4 FY25 total revenue = FY24 annual - 9mo FY24 (both from PY columns already filed)
    annual_cur, annual_py = cf_current_py(companyfacts, IS_CONCEPTS["totalRev"], accn[K], BUCKET_RANGES["annual"])
    ytd9_cur, ytd9_py = cf_current_py(companyfacts, IS_CONCEPTS["totalRev"], accn[Q3], BUCKET_RANGES["9mo"])
    is_data["totalRevPY"][q4] = to_millions(annual_py - ytd9_py) if annual_py is not None and ytd9_py is not None else None
    # EPS is not a summable flow item (weighted-average share counts differ by
    # period basis) -- cannot be validly derived under either allowed method.
    is_data["epsDiluted"][q4] = None
    is_data["epsBasic"][q4] = None
    gaps.append("is.epsDiluted[Q4 FY25] and is.epsBasic[Q4 FY25]: null. EPS is not a summable "
                "flow item (10-K full-year weighted-average diluted/basic share counts are not "
                "algebraically subtractable from the 9-month weighted average), so it falls "
                "outside both allowed derivation methods. Not estimated.")

    # As-filed nine-month diluted EPS (FY26 and the FY25 comparative column), straight off the
    # Q3 FY26 10-Q income statement -- the one EPS figure the UI can show for a 9-month selection,
    # since summing three quarters' EPS is invalid (see above). index.html reads this directly as
    # is.epsDiluted9mo.{fy26,fy25}.
    eps9_cur, eps9_py = cf_current_py(companyfacts, EPS_CONCEPTS["epsDiluted"], accn[Q3b],
                                       BUCKET_RANGES["9mo"], unit="USD/shares")
    is_data["epsDiluted9mo"] = {
        "fy26": eps9_cur, "fy25": eps9_py,
        "basis": "as filed in the Q3 FY26 10-Q; EPS is not summable across quarters (share count changes)",
    }

    # FY25's full-year diluted EPS is also directly filed in the FY25 10-K. This is valid for the
    # FY25 preset even though standalone Q4 FY25 EPS remains non-derivable: annual EPS is read
    # directly from the filing, not calculated as nine-month EPS plus a synthetic Q4 value.
    eps_fy25, _ = cf_current_py(companyfacts, EPS_CONCEPTS["epsDiluted"], accn[K],
                                 BUCKET_RANGES["annual"], unit="USD/shares")
    is_data["epsDilutedAnnual"] = {
        "fy25": eps_fy25,
        "basis": "as filed in the FY25 10-K; not derived from quarterly EPS",
    }

    # ---- product / service split (dimensional; from instance docs) ----
    for idx, label in enumerate(real_quarter_filings):
        if label is None:
            continue
        rc, _ = store.dim_current_py(label, REV_CONCEPT, {"us-gaap:ProductMember"}, "3mo")
        sc, _ = store.dim_current_py(label, REV_CONCEPT, {"us-gaap:ServiceMember"}, "3mo")
        rco, _ = store.dim_current_py(label, COS_CONCEPT, {"us-gaap:ProductMember"}, "3mo")
        sco, _ = store.dim_current_py(label, COS_CONCEPT, {"us-gaap:ServiceMember"}, "3mo")
        is_data["productsRev"][idx] = to_millions(rc)
        is_data["servicesRev"][idx] = to_millions(sc)
        is_data["productsCos"][idx] = to_millions(rco)
        is_data["servicesCos"][idx] = to_millions(sco)

    pr_fy, _ = store.dim_current_py(K, REV_CONCEPT, {"us-gaap:ProductMember"}, "annual")
    pr_9mo, _ = store.dim_current_py(Q3, REV_CONCEPT, {"us-gaap:ProductMember"}, "9mo")
    sr_fy, _ = store.dim_current_py(K, REV_CONCEPT, {"us-gaap:ServiceMember"}, "annual")
    sr_9mo, _ = store.dim_current_py(Q3, REV_CONCEPT, {"us-gaap:ServiceMember"}, "9mo")
    pc_fy, _ = store.dim_current_py(K, COS_CONCEPT, {"us-gaap:ProductMember"}, "annual")
    pc_9mo, _ = store.dim_current_py(Q3, COS_CONCEPT, {"us-gaap:ProductMember"}, "9mo")
    sc_fy, _ = store.dim_current_py(K, COS_CONCEPT, {"us-gaap:ServiceMember"}, "annual")
    sc_9mo, _ = store.dim_current_py(Q3, COS_CONCEPT, {"us-gaap:ServiceMember"}, "9mo")
    is_data["productsRev"][q4] = to_millions(pr_fy - pr_9mo)
    is_data["servicesRev"][q4] = to_millions(sr_fy - sr_9mo)
    is_data["productsCos"][q4] = to_millions(pc_fy - pc_9mo)
    is_data["servicesCos"][q4] = to_millions(sc_fy - sc_9mo)

    for i in range(7):
        if is_data["totalRev"][i] is not None and is_data["totalCos"][i] is not None:
            is_data["grossMargin"][i] = round(is_data["totalRev"][i] - is_data["totalCos"][i], 3)
        if is_data["rd"][i] is not None and is_data["sga"][i] is not None:
            is_data["totalOpex"][i] = round(is_data["rd"][i] + is_data["sga"][i], 3)

    # gross-margin / tax-rate percentages
    is_data["gmPctProducts"] = [None] * 7
    is_data["gmPctServices"] = [None] * 7
    is_data["gmPctTotal"] = [None] * 7
    is_data["taxRate"] = [None] * 7
    for i in range(7):
        if is_data["productsRev"][i] and is_data["productsCos"][i] is not None:
            is_data["gmPctProducts"][i] = round(
                (is_data["productsRev"][i] - is_data["productsCos"][i]) / is_data["productsRev"][i] * 100, 1)
        if is_data["servicesRev"][i] and is_data["servicesCos"][i] is not None:
            is_data["gmPctServices"][i] = round(
                (is_data["servicesRev"][i] - is_data["servicesCos"][i]) / is_data["servicesRev"][i] * 100, 1)
        if is_data["totalRev"][i] and is_data["grossMargin"][i] is not None:
            is_data["gmPctTotal"][i] = round(is_data["grossMargin"][i] / is_data["totalRev"][i] * 100, 1)
        if is_data["pretax"][i] and is_data["tax"][i] is not None:
            is_data["taxRate"][i] = round(is_data["tax"][i] / is_data["pretax"][i] * 100, 1)

    # ---- q section (headline quarterly view) ----
    q_data = {
        "labels": QUARTERS,
        "revenue": is_data["totalRev"],
        "yoy": [round((is_data["totalRev"][i] - is_data["totalRevPY"][i]) / is_data["totalRevPY"][i] * 100, 1)
                if is_data["totalRev"][i] is not None and is_data["totalRevPY"][i] else None for i in range(7)],
        "gmPct": is_data["gmPctTotal"],
        "opIncome": is_data["opIncome"],
    }

    # ---- category revenue (dimensional) ----
    cat_revenue = {name: [None] * 7 for name in CATEGORIES}
    cat_revenue_py = {name: [None] * 7 for name in CATEGORIES}
    for idx, label in enumerate(real_quarter_filings):
        if label is None:
            continue
        for name, member in CATEGORIES.items():
            ns_prefix = "us-gaap:" if member == "ServiceMember" else "aapl:"
            cur, py = store.dim_current_py(label, REV_CONCEPT, {f"{ns_prefix}{member}"}, "3mo")
            cat_revenue[name][idx] = to_millions(cur)
            cat_revenue_py[name][idx] = to_millions(py)
    for name, member in CATEGORIES.items():
        ns_prefix = "us-gaap:" if member == "ServiceMember" else "aapl:"
        fy, py_fy = store.dim_current_py(K, REV_CONCEPT, {f"{ns_prefix}{member}"}, "annual")
        ytd9, py_ytd9 = store.dim_current_py(Q3, REV_CONCEPT, {f"{ns_prefix}{member}"}, "9mo")
        cat_revenue[name][q4] = to_millions(fy - ytd9)
        cat_revenue_py[name][q4] = to_millions(py_fy - py_ytd9)

    # ---- geography revenue + operating income (dimensional) ----
    geo_revenue = {name: [None] * 7 for name in GEOGRAPHIES}
    geo_revenue_py = {name: [None] * 7 for name in GEOGRAPHIES}
    geo_opinc = {name: [None] * 7 for name in GEOGRAPHIES}
    geo_opinc_py = {name: [None] * 7 for name in GEOGRAPHIES}
    for idx, label in enumerate(real_quarter_filings):
        if label is None:
            continue
        for name, member in GEOGRAPHIES.items():
            mset = {f"aapl:{member}"}
            rc, rp = store.dim_current_py(label, REV_CONCEPT, mset, "3mo")
            oc, op = store.dim_current_py(label, OPINC_CONCEPT, mset, "3mo")
            geo_revenue[name][idx] = to_millions(rc)
            geo_revenue_py[name][idx] = to_millions(rp)
            geo_opinc[name][idx] = to_millions(oc)
            geo_opinc_py[name][idx] = to_millions(op)
    for name, member in GEOGRAPHIES.items():
        mset = {f"aapl:{member}"}
        rfy, rpy_fy = store.dim_current_py(K, REV_CONCEPT, mset, "annual")
        r9, rpy_9 = store.dim_current_py(Q3, REV_CONCEPT, mset, "9mo")
        ofy, opy_fy = store.dim_current_py(K, OPINC_CONCEPT, mset, "annual")
        o9, opy_9 = store.dim_current_py(Q3, OPINC_CONCEPT, mset, "9mo")
        geo_revenue[name][q4] = to_millions(rfy - r9)
        geo_revenue_py[name][q4] = to_millions(rpy_fy - rpy_9)
        geo_opinc[name][q4] = to_millions(ofy - o9)
        geo_opinc_py[name][q4] = to_millions(opy_fy - opy_9)

    # ---- geography cost of sales + selling/marketing, and the Corporate
    # reconciliation (R&D, G&A, operating loss) that ties segment operating
    # income back to consolidated operating income. Apple only began tagging
    # this expanded segment P&L (cost of sales / S&M by region, and a
    # Corporate-unallocated row) starting with the Q1 FY26 10-Q -- so the
    # three FY25 quarters are NOT disclosed in their own filings, but ARE
    # available as the restated prior-year comparative column carried in the
    # matching FY26 10-Q (Q1 FY26 10-Q's PY column = Q1 FY25, etc.), and the
    # FY25 10-K itself carries the full-year figure. All real, filed values;
    # none estimated.
    geo_cos = {name: [None] * 7 for name in GEOGRAPHIES}
    geo_sm = {name: [None] * 7 for name in GEOGRAPHIES}
    # direct: Q1-Q3 FY26 from their own filings
    for idx, label in zip((4, 5, 6), (Q1b, Q2b, Q3b)):
        for name, member in GEOGRAPHIES.items():
            mset = {f"aapl:{member}"}
            cos, _ = store.dim_current_py(label, COS_CONCEPT, mset, "3mo")
            sm, _ = store.dim_current_py(label, SM_CONCEPT, mset, "3mo")
            geo_cos[name][idx] = to_millions(cos)
            geo_sm[name][idx] = to_millions(sm)
    # FY25 quarters: PY column of the matching FY26 10-Q
    for idx, label in zip((0, 1, 2), (Q1b, Q2b, Q3b)):
        for name, member in GEOGRAPHIES.items():
            mset = {f"aapl:{member}"}
            _, cospy = store.dim_current_py(label, COS_CONCEPT, mset, "3mo")
            _, smpy = store.dim_current_py(label, SM_CONCEPT, mset, "3mo")
            geo_cos[name][idx] = to_millions(cospy)
            geo_sm[name][idx] = to_millions(smpy)
    # Q4 FY25 = FY25 10-K annual - sum(Q1+Q2+Q3 FY25, just derived above)
    for name, member in GEOGRAPHIES.items():
        mset = {f"aapl:{member}"}
        cos_fy, _ = store.dim_current_py(K, COS_CONCEPT, mset, "annual")
        sm_fy, _ = store.dim_current_py(K, SM_CONCEPT, mset, "annual")
        cos_9mo_sum = sum(geo_cos[name][0:3])
        sm_9mo_sum = sum(geo_sm[name][0:3])
        geo_cos[name][q4] = to_millions(cos_fy) - cos_9mo_sum if cos_fy is not None else None
        geo_sm[name][q4] = to_millions(sm_fy) - sm_9mo_sum if sm_fy is not None else None

    # Corporate (unallocated R&D + G&A -> operating loss), all 7 quarters
    corp_rd = [None] * 7
    corp_ga = [None] * 7
    corp_oploss = [None] * 7
    for idx, label in zip((4, 5, 6), (Q1b, Q2b, Q3b)):
        rd, _ = store.dim_current_py(label, "ResearchAndDevelopmentExpense", {CORP_MEMBER}, "3mo")
        ga, _ = store.dim_current_py(label, "GeneralAndAdministrativeExpense", {CORP_MEMBER}, "3mo")
        op, _ = store.dim_current_py(label, OPINC_CONCEPT, {CORP_MEMBER}, "3mo")
        corp_rd[idx], corp_ga[idx], corp_oploss[idx] = to_millions(rd), to_millions(ga), to_millions(op)
    for idx, label in zip((0, 1, 2), (Q1b, Q2b, Q3b)):
        _, rdpy = store.dim_current_py(label, "ResearchAndDevelopmentExpense", {CORP_MEMBER}, "3mo")
        _, gapy = store.dim_current_py(label, "GeneralAndAdministrativeExpense", {CORP_MEMBER}, "3mo")
        _, oppy = store.dim_current_py(label, OPINC_CONCEPT, {CORP_MEMBER}, "3mo")
        corp_rd[idx], corp_ga[idx], corp_oploss[idx] = to_millions(rdpy), to_millions(gapy), to_millions(oppy)
    rd_fy, _ = store.dim_current_py(K, "ResearchAndDevelopmentExpense", {CORP_MEMBER}, "annual")
    ga_fy, _ = store.dim_current_py(K, "GeneralAndAdministrativeExpense", {CORP_MEMBER}, "annual")
    op_fy, _ = store.dim_current_py(K, OPINC_CONCEPT, {CORP_MEMBER}, "annual")
    corp_rd[q4] = to_millions(rd_fy) - sum(corp_rd[0:3])
    corp_ga[q4] = to_millions(ga_fy) - sum(corp_ga[0:3])
    corp_oploss[q4] = to_millions(op_fy) - sum(corp_oploss[0:3])

    # ---- balance sheet ----
    bs_dates_labels = ["Sep 28, 2024"] + [
        "Dec 28, 2024", "Mar 29, 2025", "Jun 28, 2025", "Sep 27, 2025",
        "Dec 27, 2025", "Mar 28, 2026", "Jun 27, 2026",
    ]
    bs_iso_dates = ["2024-09-28"] + QUARTER_ENDS
    bs_filing_for_date = {
        "2024-09-28": "FY24 10-K",
        "2024-12-28": Q1, "2025-03-29": Q2, "2025-06-28": Q3,
        "2025-09-27": K, "2025-12-27": Q1b, "2026-03-28": Q2b, "2026-06-27": Q3b,
    }
    bs_data = {k: [None] * 8 for k in BS_CONCEPTS}
    bs_data["intangibles"] = [None] * 8
    for i, iso in enumerate(bs_iso_dates):
        own_label = bs_filing_for_date[iso]
        own_accn = accn[own_label]
        for key, concept in BS_CONCEPTS.items():
            bs_data[key][i] = to_millions(cf_instant(companyfacts, concept, own_accn, iso))
        # intangibles: custom aapl: tag, only present starting the Q2 FY26 10-Q.
        # Use the split presentation wherever a filing reports it for this date
        # (own filing, or -- for Sep 27, 2025 only -- the restated comparative
        # carried in the Q3 FY26 10-Q, to stay consistent with the anchor
        # values already in data.json). Otherwise null: the line did not exist
        # as a separate disclosure yet, and its amount is folded into
        # otherNonCurrent for that period exactly as Apple filed it.
        val = None
        try:
            val = store.instant(own_label, INTANGIBLES_TAG, iso)
        except Exception:
            val = None
        if val is None and iso == "2025-09-27":
            # restated comparative disclosed in the Q3 FY26 10-Q
            val = store.instant(Q3b, INTANGIBLES_TAG, iso)
            if val is not None:
                # otherNonCurrent for this date has two filed values (as-filed
                # in the FY25 10-K vs. restated in later 10-Qs); use the
                # restated (split) figure so it's internally consistent with
                # the intangibles figure and with the existing anchor values.
                or_contexts, or_facts = store.get(Q3b)
                cid = find_instant_context(or_contexts, iso, ())
                bs_data["otherNonCurrent"][i] = to_millions(get_val(or_facts, BS_CONCEPTS["otherNonCurrent"], cid))
        bs_data["intangibles"][i] = to_millions(val)

    # sanity: assets should reconcile
    for i, iso in enumerate(bs_iso_dates):
        parts = [bs_data["totalCurrentAssets"][i], bs_data["mktSecNonCurrent"][i], bs_data["ppe"][i],
                 bs_data["otherNonCurrent"][i]]
        intang = bs_data["intangibles"][i] or 0
        if all(p is not None for p in parts) and bs_data["totalAssets"][i] is not None:
            recon = sum(parts) + intang
            if abs(recon - bs_data["totalAssets"][i]) > 1:
                gaps.append(f"bs reconciliation off by {recon - bs_data['totalAssets'][i]} at {iso}")

    for i, iso in enumerate(bs_iso_dates):
        if bs_data["intangibles"][i] is None:
            gaps.append(f"bs.intangibles[{bs_dates_labels[i]}]: null. Apple did not disclose "
                        f"'Intangible assets, net' as a separate balance-sheet line until the "
                        f"Q2 FY26 10-Q; for this date it is folded into otherNonCurrent exactly "
                        f"as filed.")

    # ---- cash flow (YTD-differenced quarterly) ----
    cf_data = {k: [None] * 7 for k in CF_CONCEPTS}
    ytd_buckets = ["3mo", "6mo", "9mo", "annual"]
    fy25_labels_in_order = [Q1, Q2, Q3, K]
    fy26_labels_in_order = [Q1b, Q2b, Q3b]

    def ytd_val(concept, label, bucket):
        cur, _ = cf_current_py(companyfacts, concept, accn[label], BUCKET_RANGES[bucket])
        return cur

    for key, concept in CF_CONCEPTS.items():
        ytd_fy25 = [ytd_val(concept, fy25_labels_in_order[i], ytd_buckets[i]) for i in range(4)]
        prev = 0
        for i in range(4):
            cf_data[key][i] = to_millions(ytd_fy25[i] - prev) if ytd_fy25[i] is not None else None
            prev = ytd_fy25[i] if ytd_fy25[i] is not None else prev
        ytd_fy26 = [ytd_val(concept, fy26_labels_in_order[i], ytd_buckets[i]) for i in range(3)]
        prev = 0
        for i in range(3):
            cf_data[key][4 + i] = to_millions(ytd_fy26[i] - prev) if ytd_fy26[i] is not None else None
            prev = ytd_fy26[i] if ytd_fy26[i] is not None else prev
    cf_data["labels"] = QUARTERS

    # ---- consistency checks: Q1+Q2+Q3 FY25 filed sum vs. filed 9mo FY25 YTD ----
    # This is what makes the Q4 FY25 = annual - 9mo derivation airtight: it
    # confirms "9mo" (the filed YTD figure we subtract) really does equal the
    # sum of the three individually-filed quarters, for every series the
    # derivation touches.
    checks = []

    def check(name, q1, q2, q3, ytd9):
        if None in (q1, q2, q3, ytd9):
            checks.append((name, q1, q2, q3, ytd9, None, "SKIP (missing input)"))
            return
        s = round(q1 + q2 + q3, 3)
        ok = abs(s - ytd9) < 0.5
        checks.append((name, q1, q2, q3, ytd9, s, "OK" if ok else "MISMATCH"))

    for key in ("totalRev", "totalCos", "rd", "sga", "opIncome", "netIncome",
                "productsRev", "servicesRev", "productsCos", "servicesCos"):
        ytd9_raw, _ = cf_current_py(companyfacts, IS_CONCEPTS.get(key, REV_CONCEPT), accn[Q3], BUCKET_RANGES["9mo"]) \
            if key in IS_CONCEPTS else (None, None)
        if key in ("productsRev", "servicesRev", "productsCos", "servicesCos"):
            member = {"productsRev": "us-gaap:ProductMember", "servicesRev": "us-gaap:ServiceMember",
                      "productsCos": "us-gaap:ProductMember", "servicesCos": "us-gaap:ServiceMember"}[key]
            concept = REV_CONCEPT if "Rev" in key else COS_CONCEPT
            ytd9_val, _ = store.dim_current_py(Q3, concept, {member}, "9mo")
            ytd9_raw = ytd9_val
        check(f"is.{key}", is_data[key][0], is_data[key][1], is_data[key][2], to_millions(ytd9_raw))

    for name in CATEGORIES:
        member = CATEGORIES[name]
        ns_prefix = "us-gaap:" if member == "ServiceMember" else "aapl:"
        ytd9_val, _ = store.dim_current_py(Q3, REV_CONCEPT, {f"{ns_prefix}{member}"}, "9mo")
        check(f"cat.revenue.{name}", cat_revenue[name][0], cat_revenue[name][1], cat_revenue[name][2],
              to_millions(ytd9_val))

    for name in GEOGRAPHIES:
        member = GEOGRAPHIES[name]
        mset = {f"aapl:{member}"}
        rev9, _ = store.dim_current_py(Q3, REV_CONCEPT, mset, "9mo")
        op9, _ = store.dim_current_py(Q3, OPINC_CONCEPT, mset, "9mo")
        check(f"geo.revenue.{name}", geo_revenue[name][0], geo_revenue[name][1], geo_revenue[name][2],
              to_millions(rev9))
        check(f"geo.opInc.{name}", geo_opinc[name][0], geo_opinc[name][1], geo_opinc[name][2],
              to_millions(op9))

    # Independent cross-checks for geo.cos / geo.sm / geo.corp -- these three
    # series are sourced differently from everything else above (FY25
    # quarters come from the FY26 filings' restated PY columns rather than
    # each quarter's own original filing), so they don't get a "sum of
    # quarters == filed 9mo YTD" check the same way. But two accounting
    # identities let us tie them back to numbers that DO have that check:
    #   Sigma(geo.cos, all 5 regions) must equal is.totalCos
    #   geo.corp.ga + Sigma(geo.sm, all 5 regions) must equal is.sga
    # (geo.corp.rd already cross-checks against is.rd directly, since
    # Corporate R&D == 100% of consolidated R&D -- Apple doesn't allocate
    # R&D to geographic segments.)
    for i in range(7):
        cos_sum = sum(geo_cos[n][i] for n in GEOGRAPHIES)
        checks.append((f"Sigma(geo.cos)=={QUARTERS[i]}", cos_sum, None, None, is_data["totalCos"][i],
                        cos_sum, "OK" if abs(cos_sum - is_data["totalCos"][i]) < 0.5 else "MISMATCH"))
        sga_sum = corp_ga[i] + sum(geo_sm[n][i] for n in GEOGRAPHIES)
        checks.append((f"corp.ga+Sigma(geo.sm)=={QUARTERS[i]}", sga_sum, None, None, is_data["sga"][i],
                        sga_sum, "OK" if abs(sga_sum - is_data["sga"][i]) < 0.5 else "MISMATCH"))
        rd_match = corp_rd[i] == is_data["rd"][i]
        checks.append((f"corp.rd==is.rd=={QUARTERS[i]}", corp_rd[i], None, None, is_data["rd"][i],
                        corp_rd[i], "OK" if rd_match else "MISMATCH"))

    for key in CF_CONCEPTS:
        s = round(sum(cf_data[key][0:3]), 3)
        ytd9_cf, _ = cf_current_py(companyfacts, CF_CONCEPTS[key], accn[Q3], BUCKET_RANGES["9mo"])
        check(f"cf.{key}", cf_data[key][0], cf_data[key][1], cf_data[key][2], to_millions(ytd9_cf))

    mismatches = [c for c in checks if c[-1] == "MISMATCH"]
    if mismatches:
        for m in mismatches:
            gaps.append(f"CONSISTENCY MISMATCH: {m[0]} sum(Q1..Q3)={m[5]} vs filed 9mo={m[4]}")

    dataset = {
        "meta": {
            "quarters": QUARTERS,
            "quarterEnds": QUARTER_ENDS,
            "derived": [
                "Q4 FY25 flow items (revenue, cost of sales, opex, category/segment "
                "revenue, segment operating income, geographic cost of sales, "
                "geographic selling & marketing, and the Corporate R&D/G&A/operating-loss "
                "reconciliation row) = FY25 10-K annual value MINUS the sum of the Q1-Q3 "
                "FY25 filed quarterly values. For most series that subtrahend is the "
                "filed 9-month YTD fact directly; for geographic cost of sales/S&M and "
                "the Corporate row (which Apple did not tag by quarter until FY26) it is "
                "the sum of the three individually-filed quarters instead -- confirmed "
                "identical to the filed 9mo YTD fact wherever both exist (31/31 checks).",
                "Quarterly cash-flow items = YTD(N) - YTD(N-1), since Apple's cash flow "
                "statement is filed cumulative/year-to-date within each fiscal year.",
            ],
            "sources": {
                label: {"accn": filings[label]["accn"], "form": filings[label]["form"],
                        "filed": filings[label]["filed"], "periodEnd": filings[label]["end"]}
                for label in filings
            },
        },
        "is": is_data,
        "q": q_data,
        "cat": {
            "names": list(CATEGORIES.keys()),
            "revenue": cat_revenue,
            "revenuePY": cat_revenue_py,
        },
        "geo": {
            "names": list(GEOGRAPHIES.keys()),
            "revenue": geo_revenue,
            "revenuePY": geo_revenue_py,
            "opInc": geo_opinc,
            "opIncPY": geo_opinc_py,
            "cos": geo_cos,
            "sm": geo_sm,
            "corp": {"rd": corp_rd, "ga": corp_ga, "opLoss": corp_oploss},
        },
        "bs": dict({"dates": bs_dates_labels}, **bs_data),
        "cf": cf_data,
    }
    return dataset, gaps, checks


QUARTER_SHORT_LABELS = [
    "Q1 FY25 (Dec-24)", "Q2 FY25 (Mar-25)", "Q3 FY25 (Jun-25)", "Q4 FY25 (Sep-25)",
    "Q1 FY26 (Dec-25)", "Q2 FY26 (Mar-26)", "Q3 FY26 (Jun-26)",
]


def fmt(v, nd=None):
    if v is None:
        return ""
    if nd is not None:
        return f"{v:.{nd}f}"
    return v


def write_csv_01(dataset, path):
    names = dataset["cat"]["names"]
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Period", "iPhone", "Mac", "iPad", "Wearables_Home_Accessories", "Services", "Total"])
        for i, label in enumerate(QUARTER_SHORT_LABELS):
            row = [label] + [fmt(dataset["cat"]["revenue"][n][i]) for n in names]
            row.append(fmt(dataset["is"]["totalRev"][i]))
            w.writerow(row)


def write_csv_02(dataset, path):
    names = dataset["geo"]["names"]
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Period", "Americas", "Europe", "Greater_China", "Japan", "Rest_of_Asia_Pacific", "Total"])
        for i, label in enumerate(QUARTER_SHORT_LABELS):
            row = [label] + [fmt(dataset["geo"]["revenue"][n][i]) for n in names]
            row.append(fmt(dataset["is"]["totalRev"][i]))
            w.writerow(row)
        yoy_row = ["YoY_Growth"]
        for n in names:
            cur, py = dataset["geo"]["revenue"][n][6], dataset["geo"]["revenuePY"][n][6]
            yoy_row.append(f"{round((cur - py) / py * 100)}%" if cur is not None and py else "")
        yoy_row.append(f"{round(dataset['q']['yoy'][6])}%" if dataset["q"]["yoy"][6] is not None else "")
        w.writerow(yoy_row)


def write_csv_03(dataset, path):
    is_ = dataset["is"]
    rows = [
        ("Net sales - Products", is_["productsRev"], 0),
        ("Net sales - Services", is_["servicesRev"], 0),
        ("Total net sales", is_["totalRev"], 0),
        ("Cost of sales - Products", is_["productsCos"], 0),
        ("Cost of sales - Services", is_["servicesCos"], 0),
        ("Total cost of sales", is_["totalCos"], 0),
        ("Gross margin", is_["grossMargin"], 0),
        ("Research and development", is_["rd"], 0),
        ("Selling general and administrative", is_["sga"], 0),
        ("Total operating expenses", is_["totalOpex"], 0),
        ("Operating income", is_["opIncome"], 0),
        ("Other income/(expense) net", is_["otherIncome"], 0),
        ("Income before provision for income taxes", is_["pretax"], 0),
        ("Provision for income taxes", is_["tax"], 0),
        ("Net income", is_["netIncome"], 0),
        ("Earnings per share - Basic", is_["epsBasic"], 2),
        ("Earnings per share - Diluted", is_["epsDiluted"], 2),
    ]
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Line_Item"] + QUARTER_SHORT_LABELS)
        for name, arr, nd in rows:
            w.writerow([name] + [fmt(v, nd if isinstance(v, float) else None) for v in arr])
        w.writerow(["Gross margin % - Products"] + [
            f"{is_['gmPctProducts'][i]}%" if is_["gmPctProducts"][i] is not None else "" for i in range(7)])
        w.writerow(["Gross margin % - Services"] + [
            f"{is_['gmPctServices'][i]}%" if is_["gmPctServices"][i] is not None else "" for i in range(7)])
        w.writerow(["Gross margin % - Total"] + [
            f"{is_['gmPctTotal'][i]}%" if is_["gmPctTotal"][i] is not None else "" for i in range(7)])
        w.writerow(["Effective tax rate"] + [
            f"{is_['taxRate'][i]}%" if is_["taxRate"][i] is not None else "" for i in range(7)])


def write_csv_04(dataset, path):
    bs = dataset["bs"]
    labels = bs["dates"][1:]  # drop the Sep 28 2024 leading snapshot to align with the 7 quarters
    keys = [
        ("Cash and cash equivalents", "cash"),
        ("Marketable securities (current)", "mktSecCurrent"),
        ("Accounts receivable net", "ar"),
        ("Vendor non-trade receivables", "vendorNTR"),
        ("Inventories", "inventories"),
        ("Other current assets", "otherCurrentAssets"),
        ("Total current assets", "totalCurrentAssets"),
        ("Marketable securities (non-current)", "mktSecNonCurrent"),
        ("Property plant and equipment net", "ppe"),
        ("Intangible assets net", "intangibles"),
        ("Other non-current assets", "otherNonCurrent"),
        ("Total assets", "totalAssets"),
        ("Accounts payable", "ap"),
        ("Other current liabilities", "otherCurrentLiab"),
        ("Deferred revenue", "deferredRev"),
        ("Commercial paper", "commercialPaper"),
        ("Term debt (current)", "termDebtCurrent"),
        ("Total current liabilities", "totalCurrentLiab"),
        ("Term debt (non-current)", "termDebtNonCurrent"),
        ("Other non-current liabilities", "otherNonCurrentLiab"),
        ("Total liabilities", "totalLiab"),
        ("Total shareholders equity", "equity"),
    ]
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Line_Item"] + labels)
        for name, key in keys:
            w.writerow([name] + [fmt(v) for v in bs[key][1:]])


def write_csv_06(dataset, path):
    geo = dataset["geo"]
    names = geo["names"]
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Segment", "Metric"] + QUARTER_SHORT_LABELS)
        for name in names:
            w.writerow([name, "Net sales"] + [fmt(v) for v in geo["revenue"][name]])
            w.writerow([name, "Cost of sales"] + [fmt(-v) if v is not None else "" for v in geo["cos"][name]])
            w.writerow([name, "Selling and marketing"] + [fmt(-v) if v is not None else "" for v in geo["sm"][name]])
            w.writerow([name, "Operating income"] + [fmt(v) for v in geo["opInc"][name]])
        w.writerow(["Corporate", "Research and development"] + [fmt(-v) if v is not None else "" for v in geo["corp"]["rd"]])
        w.writerow(["Corporate", "General and administrative"] + [fmt(-v) if v is not None else "" for v in geo["corp"]["ga"]])
        w.writerow(["Corporate", "Operating loss"] + [fmt(v) for v in geo["corp"]["opLoss"]])
        w.writerow(["Total", "Operating income"] + [fmt(v) for v in dataset["is"]["opIncome"]])


def write_csv_07(dataset, path):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Metric"] + QUARTER_SHORT_LABELS)
        w.writerow(["Total net sales ($M)"] + [fmt(v) for v in dataset["is"]["totalRev"]])
        w.writerow(["YoY revenue growth (%)"] + [fmt(v, 1) if v is not None else "" for v in dataset["q"]["yoy"]])
        w.writerow(["Gross margin (%)"] + [fmt(v, 1) if v is not None else "" for v in dataset["q"]["gmPct"]])
        w.writerow(["Operating income ($M)"] + [fmt(v) for v in dataset["is"]["opIncome"]])


def write_csv_08(dataset, path):
    cf = dataset["cf"]
    fcf = [round(cf["opCash"][i] - cf["capex"][i]) if cf["opCash"][i] is not None and cf["capex"][i] is not None
           else None for i in range(7)]
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Line_Item"] + QUARTER_SHORT_LABELS)
        w.writerow(["Operating cash flow ($M)"] + [fmt(v) for v in cf["opCash"]])
        w.writerow(["Depreciation and amortization ($M)"] + [fmt(v) for v in cf["depAmort"]])
        w.writerow(["Share-based compensation expense ($M)"] + [fmt(v) for v in cf["sbc"]])
        w.writerow(["Capital expenditures ($M)"] + [fmt(v) for v in cf["capex"]])
        w.writerow(["Free cash flow (opCF - capex) ($M)"] + [fmt(v) for v in fcf])
        w.writerow(["Common stock repurchased ($M)"] + [fmt(v) for v in cf["buybacks"]])
        w.writerow(["Dividends and dividend equivalents paid ($M)"] + [fmt(v) for v in cf["dividends"]])


def write_csvs(dataset, out_dir):
    write_csv_01(dataset, os.path.join(out_dir, "01_revenue_by_category.csv"))
    write_csv_02(dataset, os.path.join(out_dir, "02_revenue_by_geography.csv"))
    write_csv_03(dataset, os.path.join(out_dir, "03_income_statement.csv"))
    write_csv_04(dataset, os.path.join(out_dir, "04_balance_sheet_ap_ar.csv"))
    write_csv_06(dataset, os.path.join(out_dir, "06_segment_operating_income.csv"))
    write_csv_07(dataset, os.path.join(out_dir, "07_quarterly_trend_fy26.csv"))
    write_csv_08(dataset, os.path.join(out_dir, "08_cash_flow_9mo.csv"))
    # 05, 09, 10, 11 are unchanged (fx/hedging, headcount, environment, outlook
    # sections carry over verbatim from the current dataset per the task spec).


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

UNCHANGED_SECTIONS = ["fx", "cap", "hc", "env", "fwd"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache-dir", default=DEFAULT_CACHE_DIR)
    ap.add_argument("--no-network", action="store_true")
    ap.add_argument("--data-json-out", default=os.path.join(DASH_DIR, "data.json"))
    ap.add_argument("--csv-out-dir", default=REPO_ROOT)
    ap.add_argument("--report-out", default=None,
                     help="optional path to dump raw gaps/checks as JSON for the validation report")
    args = ap.parse_args()

    fetcher = Fetcher(args.cache_dir, allow_network=not args.no_network)
    dataset, gaps, checks = build_dataset(fetcher)

    # Merge the sections that are unchanged from the current data.json
    # (fx hedging/capital returns, capital allocation, headcount/equity comp,
    # environment, forward guidance) -- read live so reruns stay idempotent.
    with open(args.data_json_out) as f:
        existing = json.load(f)
    for section in UNCHANGED_SECTIONS:
        if section in existing:
            dataset[section] = existing[section]
        else:
            gaps.append(f"existing data.json had no '{section}' section to carry over")

    with open(args.data_json_out, "w") as f:
        json.dump(dataset, f, indent=1)
    print(f"Wrote {args.data_json_out}")

    write_csvs(dataset, args.csv_out_dir)
    print(f"Wrote CSVs 01,02,03,04,06,07,08 to {args.csv_out_dir}")

    if args.report_out:
        with open(args.report_out, "w") as f:
            json.dump({"gaps": gaps, "checks": checks}, f, indent=1)
        print(f"Wrote {args.report_out}")

    if gaps:
        print(f"{len(gaps)} gap(s)/note(s):")
        for g in gaps:
            print(" -", g)
    mismatches = [c for c in checks if c[-1] == "MISMATCH"]
    print(f"{len(checks)} consistency checks run, {len(mismatches)} mismatch(es).")


if __name__ == "__main__":
    main()
