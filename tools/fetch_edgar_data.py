#!/usr/bin/env python3
"""
fetch_edgar_data.py

Rebuilds the Apple FP&A dashboard dataset (data.json + the 11 CSV exports)
from REAL data pulled straight off SEC EDGAR. No estimated or invented
numbers -- the only two derivations used are documented in meta.derived
in the output data.json:

  1. Q4 flow items (revenue, cost of sales, opex, category/segment
     revenue, segment operating income, quarterly cash flow) are computed
     as: that fiscal year's 10-K annual value MINUS the sum of its three
     10-Q quarterly (Q1+Q2+Q3) filed values. Pure arithmetic on filed numbers.
     (Q4 balance-sheet values are DIRECT from the 10-K, not derived.)

  2. Quarterly cash-flow line items are derived as YTD(N) - YTD(N-1),
     since Apple's cash flow statement is filed cumulative/year-to-date.

Quarter window: NOT hardcoded. select_window() reads Apple's 10-Q/10-K list
from submissions.json and takes the latest 7 filed fiscal quarters (a Q4
counts once its 10-K is filed). So when Apple files its FY26 10-K the window
slides from Q1 FY25..Q3 FY26 to Q2 FY25..Q4 FY26 with no code edit. Sections
not built from XBRL (fx, cap, hc, env, fwd) are carried over verbatim from
the existing data.json -- never extended with guessed values.

Sources (SEC EDGAR, Apple CIK 0000320193):
  - https://data.sec.gov/submissions/CIK0000320193.json
      (picks the quarter window and the accession number of each filing)
  - https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json
      (non-dimensional us-gaap/dei facts: income statement, balance sheet,
      cash flow company totals)
  - Per-filing XBRL instance documents (aapl-YYYYMMDD_htm.xml), parsed
      directly for DIMENSIONAL facts that companyfacts.json does not carry:
      product-category revenue/cost, geographic-segment revenue/cost/op
      income, and Apple's custom "intangible assets" extension tag.

Python 3 stdlib only (urllib, json, xml.etree, csv). Everything downloaded
is cached under CACHE_DIR so re-runs do not re-hit sec.gov. Note the cache
includes submissions.json: point --cache-dir at a fresh directory (the CI
runner always starts empty) to see newly filed quarters.

Usage:
    python3 fetch_edgar_data.py [--cache-dir DIR] [--no-network] [--no-csv]
    python3 fetch_edgar_data.py --self-test   # offline window-selection tests
"""
import argparse
import csv
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, timedelta

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

UA = os.environ.get("SEC_USER_AGENT") or "findashboard local run (set SEC_USER_AGENT to 'Name email')"
CIK = "0000320193"
DEFAULT_CACHE_DIR = os.path.join(tempfile.gettempdir(), "edgar_cache")
# Repo root = parent of tools/. data.json lives at the repo root.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DASH_DIR = REPO_ROOT

XBRLI = "http://www.xbrl.org/2003/instance"
XBRLDI = "http://xbrl.org/2006/xbrldi"
NS = {"xbrli": XBRLI, "xbrldi": XBRLDI}

# The quarter window is NOT hardcoded. It is derived from Apple's 10-Q/10-K
# filings in submissions.json: the latest WINDOW_SIZE fiscal quarters that
# have been filed (a Q4 counts as filed once the 10-K is out, since Q4 is
# derived as 10-K annual minus the Q3 10-Q's 9-month YTD). See select_window().
# Filing labels: "Q1 FY25" (10-Q), "FY25 10-K" (10-K). Quarter labels:
# "Q1 FY25" .. "Q4 FY25".
WINDOW_SIZE = 7
DEFAULT_FY_END_MONTH = 9  # Apple's fiscal year ends the last Saturday of September

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

def fy_short(fy):
    return f"FY{fy % 100:02d}"


def quarter_label(fq):
    fy, q = fq
    return f"Q{q} {fy_short(fy)}"


def filing_label(fq):
    """Label of the filing that reports fiscal quarter fq: the 10-Q for Q1-Q3,
    the 10-K for Q4."""
    fy, q = fq
    return f"{fy_short(fy)} 10-K" if q == 4 else quarter_label(fq)


def prev_quarter(fq):
    fy, q = fq
    return (fy, q - 1) if q > 1 else (fy - 1, 4)


def _effective(report_date):
    # Apple's 52/53-week quarters end on a Saturday near month end, sometimes
    # spilling a day or two into the next month (e.g. Q3 FY23 ended Jul 1, 2023).
    # Shifting back two weeks puts every period end in its "nominal" month.
    return date.fromisoformat(report_date) - timedelta(days=14)


def classify_filing(form, report_date, fy_end_month):
    """(fiscal_year, quarter) for a 10-Q/10-K period end, or None if the date
    does not fit the fiscal calendar (or the form doesn't match the quarter)."""
    e = _effective(report_date)
    months_after = (e.month - fy_end_month) % 12
    if months_after not in (0, 3, 6, 9):
        return None
    q = 4 if months_after == 0 else months_after // 3
    if (form == "10-K") != (q == 4):
        return None
    fy = e.year + (1 if e.month > fy_end_month else 0)
    return fy, q


def select_window(rows, n=WINDOW_SIZE):
    """Pick the latest n filed fiscal quarters from submissions rows.

    rows: iterable of dicts with at least form, reportDate (plus accn/filed/
    primaryDoc for real runs). Only original 10-Q/10-K forms count (amendments
    are ignored). A Q4 is available only when both the 10-K and that year's Q3
    10-Q are filed (Q4 = annual - 9-month YTD).

    Returns dict:
      quarters  [(fy, q)] oldest->newest, length n
      labels    ["Q1 FY25", ...]
      ends      period-end dates (Q4 = 10-K reportDate)
      ext       every quarter from Q1 of the first window FY through the window
                end (window plus leading same-FY quarters needed for YTD maths)
      leading   (fy, q) of the period end just before the window (the
                balance sheet's opening snapshot)
      filings   {filing label: row}, every filing the build needs, in
                chronological order with the leading filing last if it is not
                otherwise needed
    """
    rows = [r for r in rows if r.get("form") in ("10-Q", "10-K") and r.get("reportDate")]
    k_months = [_effective(r["reportDate"]).month for r in rows if r["form"] == "10-K"]
    fy_end_month = max(set(k_months), key=k_months.count) if k_months else DEFAULT_FY_END_MONTH

    by_fq = {}
    for r in rows:
        fq = classify_filing(r["form"], r["reportDate"], fy_end_month)
        if fq is not None:
            by_fq[fq] = r  # same overwrite semantics as the old (form, reportDate) map

    def available(fq):
        if fq[1] == 4:
            return fq in by_fq and (fq[0], 3) in by_fq
        return fq in by_fq

    avail = sorted(fq for fq in by_fq if available(fq))
    if not avail:
        raise RuntimeError("No 10-Q/10-K filings found in submissions.json")
    quarters = [avail[-1]]
    while len(quarters) < n:
        p = prev_quarter(quarters[0])
        if not available(p):
            raise RuntimeError(f"Window needs {quarter_label(p)} but its filing is not in submissions.json "
                               f"(window so far: {[quarter_label(x) for x in quarters]})")
        quarters.insert(0, p)
    leading = prev_quarter(quarters[0])
    if leading not in by_fq:
        raise RuntimeError(f"Balance-sheet opening snapshot needs the {filing_label(leading)} filing, "
                           f"not found in submissions.json")

    ext = []
    fq = (quarters[0][0], 1)
    while fq <= quarters[-1]:
        ext.append(fq)
        fy, q = fq
        fq = (fy, q + 1) if q < 4 else (fy + 1, 1)
    for fq in ext:
        if fq not in by_fq:
            raise RuntimeError(f"{filing_label(fq)} needed for year-to-date maths but not in submissions.json")

    filings = {}
    for fq in ext:  # Q4's own filing is the 10-K; its Q3 10-Q is already in ext
        filings[filing_label(fq)] = by_fq[fq]
    if filing_label(leading) not in filings:
        filings[filing_label(leading)] = by_fq[leading]

    return {
        "quarters": quarters,
        "labels": [quarter_label(fq) for fq in quarters],
        "ends": [by_fq[fq]["reportDate"] for fq in quarters],
        "ext": ext,
        "leading": leading,
        "leading_end": by_fq[leading]["reportDate"],
        "filings": filings,
    }


def submissions_rows(subs):
    recent = subs["filings"]["recent"]
    return [{
        "form": recent["form"][i],
        "reportDate": recent["reportDate"][i],
        "accn": recent["accessionNumber"][i],
        "filed": recent["filingDate"][i],
        "primaryDoc": recent["primaryDocument"][i],
    } for i in range(len(recent["form"]))]


def discover_filings(fetcher, as_of=None):
    subs = fetcher.get_json(
        f"https://data.sec.gov/submissions/CIK{CIK}.json", "submissions.json"
    )
    rows = submissions_rows(subs)
    if as_of:  # simulate an earlier day: ignore filings made after as_of
        rows = [r for r in rows if r["filed"] <= as_of]
    window = select_window(rows)

    filings = {}
    for label, meta in window["filings"].items():
        form, end_date = meta["form"], meta["reportDate"]
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
    return window, filings


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

_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def fmt_date_label(iso):
    d = date.fromisoformat(iso)
    return f"{_MONTHS[d.month - 1]} {d.day}, {d.year}"


def build_dataset(fetcher, as_of=None):
    window, filings = discover_filings(fetcher, as_of)
    companyfacts = fetcher.get_json(
        f"https://data.sec.gov/api/xbrl/companyfacts/CIK{CIK}.json", "companyfacts.json"
    )
    store = InstanceStore(fetcher, filings)
    accn = {label: filings[label]["accn"] for label in filings}

    # Output window (N quarters) and the extended grid EXT it is sliced from.
    # EXT starts at Q1 of the window's first fiscal year so that YTD
    # differencing and "Q4 = annual - (Q1+Q2+Q3)" always have their inputs,
    # even when the window starts mid-year.
    W = window["quarters"]
    QUARTERS = window["labels"]
    QUARTER_ENDS = window["ends"]
    N = len(W)
    EXT = window["ext"]
    NE = len(EXT)
    ei = {fq: i for i, fq in enumerate(EXT)}
    off = ei[W[0]]
    win_idx = [ei[fq] for fq in W]

    def win(arr):
        return arr[off:off + N]

    q4_fys = [fy for fy, q in EXT if q == 4]          # fiscal years whose Q4 is derived
    filed_q = [fq for fq in EXT if fq[1] < 4]         # quarters read directly off their own 10-Q

    def q3_of(fy):
        return filing_label((fy, 3))

    def k_of(fy):
        return filing_label((fy, 4))

    def sub(a, b):
        return a - b if a is not None and b is not None else None

    gaps = []

    # ---- company-wide income-statement items (Q4s derived) ----
    is_data = {k: [None] * NE for k in IS_CONCEPTS}
    is_data.update({k: [None] * NE for k in EPS_CONCEPTS})
    is_data["totalRevPY"] = [None] * NE
    # productsRev/servicesRev/productsCos/servicesCos come from instance docs (dimensional)
    for k in ("productsRev", "servicesRev", "productsCos", "servicesCos", "grossMargin", "totalOpex"):
        is_data[k] = [None] * NE

    for fq in filed_q:
        idx, label = ei[fq], filing_label(fq)
        for key, concept in IS_CONCEPTS.items():
            cur, py = cf_current_py(companyfacts, concept, accn[label], BUCKET_RANGES["3mo"])
            is_data[key][idx] = to_millions(cur)
            if key == "totalRev":
                is_data["totalRevPY"][idx] = to_millions(py)
        for key, concept in EPS_CONCEPTS.items():
            cur, _ = cf_current_py(companyfacts, concept, accn[label], BUCKET_RANGES["3mo"], unit="USD/shares")
            is_data[key][idx] = cur

    # Q4 FYxx = FYxx 10-K annual - 9mo FYxx (from that year's Q3 10-Q YTD column)
    for fy in q4_fys:
        q4, K, Q3 = ei[(fy, 4)], k_of(fy), q3_of(fy)
        for key, concept in IS_CONCEPTS.items():
            annual, _ = cf_current_py(companyfacts, concept, accn[K], BUCKET_RANGES["annual"])
            ytd9, _ = cf_current_py(companyfacts, concept, accn[Q3], BUCKET_RANGES["9mo"])
            is_data[key][q4] = to_millions(annual - ytd9) if annual is not None and ytd9 is not None else None
        # PY for Q4 total revenue = prior-year annual - prior-year 9mo (both from PY columns already filed)
        annual_cur, annual_py = cf_current_py(companyfacts, IS_CONCEPTS["totalRev"], accn[K], BUCKET_RANGES["annual"])
        ytd9_cur, ytd9_py = cf_current_py(companyfacts, IS_CONCEPTS["totalRev"], accn[Q3], BUCKET_RANGES["9mo"])
        is_data["totalRevPY"][q4] = to_millions(annual_py - ytd9_py) if annual_py is not None and ytd9_py is not None else None
        # EPS is not a summable flow item (weighted-average share counts differ by
        # period basis) -- cannot be validly derived under either allowed method.
        is_data["epsDiluted"][q4] = None
        is_data["epsBasic"][q4] = None
        ql = quarter_label((fy, 4))
        gaps.append(f"is.epsDiluted[{ql}] and is.epsBasic[{ql}]: null. EPS is not a summable "
                    "flow item (10-K full-year weighted-average diluted/basic share counts are not "
                    "algebraically subtractable from the 9-month weighted average), so it falls "
                    "outside both allowed derivation methods. Not estimated.")

    # As-filed nine-month diluted EPS (current FY and the PY comparative column), straight off the
    # latest Q3 10-Q in the window -- the one EPS figure the UI can show for a 9-month selection,
    # since summing three quarters' EPS is invalid (see above). Keys are "fyNN".
    q3_fy = max(fy for fy, q in W if q == 3)
    eps9_cur, eps9_py = cf_current_py(companyfacts, EPS_CONCEPTS["epsDiluted"], accn[q3_of(q3_fy)],
                                       BUCKET_RANGES["9mo"], unit="USD/shares")
    is_data["epsDiluted9mo"] = {
        fy_short(q3_fy).lower(): eps9_cur, fy_short(q3_fy - 1).lower(): eps9_py,
        "basis": f"as filed in the {q3_of(q3_fy)} 10-Q; EPS is not summable across quarters (share count changes)",
    }

    # Full-year diluted EPS is directly filed in each 10-K whose Q4 is in the window. Valid for a
    # full-year preset even though standalone Q4 EPS is non-derivable: annual EPS is read
    # directly from the filing, not calculated as nine-month EPS plus a synthetic Q4 value.
    eps_annual = {}
    for fy in q4_fys:
        v, _ = cf_current_py(companyfacts, EPS_CONCEPTS["epsDiluted"], accn[k_of(fy)],
                             BUCKET_RANGES["annual"], unit="USD/shares")
        eps_annual[fy_short(fy).lower()] = v
    eps_annual["basis"] = (
        f"as filed in the {k_of(q4_fys[0])}; not derived from quarterly EPS" if len(q4_fys) == 1 else
        f"as filed in the {' and '.join(fy_short(fy) for fy in q4_fys)} 10-Ks; not derived from quarterly EPS")
    is_data["epsDilutedAnnual"] = eps_annual

    # ---- product / service split (dimensional; from instance docs) ----
    for fq in filed_q:
        idx, label = ei[fq], filing_label(fq)
        rc, _ = store.dim_current_py(label, REV_CONCEPT, {"us-gaap:ProductMember"}, "3mo")
        sc, _ = store.dim_current_py(label, REV_CONCEPT, {"us-gaap:ServiceMember"}, "3mo")
        rco, _ = store.dim_current_py(label, COS_CONCEPT, {"us-gaap:ProductMember"}, "3mo")
        sco, _ = store.dim_current_py(label, COS_CONCEPT, {"us-gaap:ServiceMember"}, "3mo")
        is_data["productsRev"][idx] = to_millions(rc)
        is_data["servicesRev"][idx] = to_millions(sc)
        is_data["productsCos"][idx] = to_millions(rco)
        is_data["servicesCos"][idx] = to_millions(sco)

    for fy in q4_fys:
        q4, K, Q3 = ei[(fy, 4)], k_of(fy), q3_of(fy)
        for key, concept, member in (("productsRev", REV_CONCEPT, "us-gaap:ProductMember"),
                                     ("servicesRev", REV_CONCEPT, "us-gaap:ServiceMember"),
                                     ("productsCos", COS_CONCEPT, "us-gaap:ProductMember"),
                                     ("servicesCos", COS_CONCEPT, "us-gaap:ServiceMember")):
            v_fy, _ = store.dim_current_py(K, concept, {member}, "annual")
            v_9mo, _ = store.dim_current_py(Q3, concept, {member}, "9mo")
            is_data[key][q4] = to_millions(sub(v_fy, v_9mo))

    for i in range(NE):
        if is_data["totalRev"][i] is not None and is_data["totalCos"][i] is not None:
            is_data["grossMargin"][i] = round(is_data["totalRev"][i] - is_data["totalCos"][i], 3)
        if is_data["rd"][i] is not None and is_data["sga"][i] is not None:
            is_data["totalOpex"][i] = round(is_data["rd"][i] + is_data["sga"][i], 3)

    # gross-margin / tax-rate percentages
    is_data["gmPctProducts"] = [None] * NE
    is_data["gmPctServices"] = [None] * NE
    is_data["gmPctTotal"] = [None] * NE
    is_data["taxRate"] = [None] * NE
    for i in range(NE):
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

    # ---- category revenue (dimensional) ----
    def cat_mset(name):
        member = CATEGORIES[name]
        ns_prefix = "us-gaap:" if member == "ServiceMember" else "aapl:"
        return {f"{ns_prefix}{member}"}

    cat_revenue = {name: [None] * NE for name in CATEGORIES}
    cat_revenue_py = {name: [None] * NE for name in CATEGORIES}
    for fq in filed_q:
        idx, label = ei[fq], filing_label(fq)
        for name in CATEGORIES:
            cur, py = store.dim_current_py(label, REV_CONCEPT, cat_mset(name), "3mo")
            cat_revenue[name][idx] = to_millions(cur)
            cat_revenue_py[name][idx] = to_millions(py)
    for fy in q4_fys:
        q4, K, Q3 = ei[(fy, 4)], k_of(fy), q3_of(fy)
        for name in CATEGORIES:
            fyv, py_fy = store.dim_current_py(K, REV_CONCEPT, cat_mset(name), "annual")
            ytd9, py_ytd9 = store.dim_current_py(Q3, REV_CONCEPT, cat_mset(name), "9mo")
            cat_revenue[name][q4] = to_millions(sub(fyv, ytd9))
            cat_revenue_py[name][q4] = to_millions(sub(py_fy, py_ytd9))

    # ---- geography revenue + operating income (dimensional) ----
    geo_revenue = {name: [None] * NE for name in GEOGRAPHIES}
    geo_revenue_py = {name: [None] * NE for name in GEOGRAPHIES}
    geo_opinc = {name: [None] * NE for name in GEOGRAPHIES}
    geo_opinc_py = {name: [None] * NE for name in GEOGRAPHIES}
    for fq in filed_q:
        idx, label = ei[fq], filing_label(fq)
        for name, member in GEOGRAPHIES.items():
            mset = {f"aapl:{member}"}
            rc, rp = store.dim_current_py(label, REV_CONCEPT, mset, "3mo")
            oc, op = store.dim_current_py(label, OPINC_CONCEPT, mset, "3mo")
            geo_revenue[name][idx] = to_millions(rc)
            geo_revenue_py[name][idx] = to_millions(rp)
            geo_opinc[name][idx] = to_millions(oc)
            geo_opinc_py[name][idx] = to_millions(op)
    for fy in q4_fys:
        q4, K, Q3 = ei[(fy, 4)], k_of(fy), q3_of(fy)
        for name, member in GEOGRAPHIES.items():
            mset = {f"aapl:{member}"}
            rfy, rpy_fy = store.dim_current_py(K, REV_CONCEPT, mset, "annual")
            r9, rpy_9 = store.dim_current_py(Q3, REV_CONCEPT, mset, "9mo")
            ofy, opy_fy = store.dim_current_py(K, OPINC_CONCEPT, mset, "annual")
            o9, opy_9 = store.dim_current_py(Q3, OPINC_CONCEPT, mset, "9mo")
            geo_revenue[name][q4] = to_millions(sub(rfy, r9))
            geo_revenue_py[name][q4] = to_millions(sub(rpy_fy, rpy_9))
            geo_opinc[name][q4] = to_millions(sub(ofy, o9))
            geo_opinc_py[name][q4] = to_millions(sub(opy_fy, opy_9))

    # ---- geography cost of sales + selling/marketing, and the Corporate
    # reconciliation (R&D, G&A, operating loss) that ties segment operating
    # income back to consolidated operating income. Apple only began tagging
    # this expanded segment P&L (cost of sales / S&M by region, and a
    # Corporate-unallocated row) starting with the Q1 FY26 10-Q -- so FY25
    # quarters are NOT disclosed in their own filings, but ARE available as
    # the restated prior-year comparative column carried in the matching
    # 10-Q one year later (Q1 FY26 10-Q's PY column = Q1 FY25, etc.), and the
    # 10-K itself carries the full-year figure. Rule per Q1-Q3 quarter: own
    # filing's current column; if not tagged there, the next-year filing's PY
    # column (when that filing is in the build); otherwise null + gap.
    # Q4 = 10-K annual - sum(Q1+Q2+Q3 of the same fiscal year). All real,
    # filed values; none estimated.
    def seg_quarter(fq, concept, mset):
        cur, _ = store.dim_current_py(filing_label(fq), concept, mset, "3mo")
        if cur is None:
            nxt = filing_label((fq[0] + 1, fq[1]))
            if nxt in filings:
                _, cur = store.dim_current_py(nxt, concept, mset, "3mo")
        return to_millions(cur)

    def seg_series(concept, mset):
        arr = [None] * NE
        for fq in filed_q:
            arr[ei[fq]] = seg_quarter(fq, concept, mset)
        for fy in q4_fys:
            v_fy, _ = store.dim_current_py(k_of(fy), concept, mset, "annual")
            parts = [arr[ei[(fy, q)]] for q in (1, 2, 3)]
            arr[ei[(fy, 4)]] = (to_millions(v_fy) - sum(parts)
                                if v_fy is not None and None not in parts else None)
        return arr

    geo_cos = {name: seg_series(COS_CONCEPT, {f"aapl:{m}"}) for name, m in GEOGRAPHIES.items()}
    geo_sm = {name: seg_series(SM_CONCEPT, {f"aapl:{m}"}) for name, m in GEOGRAPHIES.items()}
    corp_rd = seg_series("ResearchAndDevelopmentExpense", {CORP_MEMBER})
    corp_ga = seg_series("GeneralAndAdministrativeExpense", {CORP_MEMBER})
    corp_oploss = seg_series(OPINC_CONCEPT, {CORP_MEMBER})

    seg_arrays = [(f"geo.cos.{n}", geo_cos[n]) for n in GEOGRAPHIES] + \
                 [(f"geo.sm.{n}", geo_sm[n]) for n in GEOGRAPHIES] + \
                 [("geo.corp.rd", corp_rd), ("geo.corp.ga", corp_ga), ("geo.corp.opLoss", corp_oploss)]
    for name, arr in seg_arrays:
        missing = [QUARTERS[j] for j, i in enumerate(win_idx) if arr[i] is None]
        if missing:
            gaps.append(f"{name}{missing}: null. Not tagged in the quarter's own filing and no "
                        f"next-year restated comparative (or 10-K annual) available. Not estimated.")

    # ---- balance sheet ----
    bs_fq = [window["leading"]] + list(W)
    bs_iso_dates = [window["leading_end"]] + QUARTER_ENDS
    bs_dates_labels = [fmt_date_label(d) for d in bs_iso_dates]
    NB = len(bs_iso_dates)
    bs_data = {k: [None] * NB for k in BS_CONCEPTS}
    bs_data["intangibles"] = [None] * NB
    for i, (fq, iso) in enumerate(zip(bs_fq, bs_iso_dates)):
        own_label = filing_label(fq)
        own_accn = accn[own_label]
        for key, concept in BS_CONCEPTS.items():
            bs_data[key][i] = to_millions(cf_instant(companyfacts, concept, own_accn, iso))
        # intangibles: custom aapl: tag, only present starting the Q2 FY26 10-Q.
        # Use the split presentation wherever a filing reports it for this date:
        # own filing, or -- for a fiscal-year-end date only -- the restated
        # comparative carried in the LATEST later filing in this build (e.g.
        # Sep 27, 2025 from the Q3 FY26 10-Q). Otherwise null: the line did not
        # exist as a separate disclosure yet, and its amount is folded into
        # otherNonCurrent for that period exactly as Apple filed it.
        val = None
        try:
            val = store.instant(own_label, INTANGIBLES_TAG, iso)
        except Exception:
            val = None
        if val is None and fq[1] == 4:
            later = sorted((l for l in filings if filings[l]["end"] > iso),
                           key=lambda l: filings[l]["end"], reverse=True)
            for lab in later:
                v = store.instant(lab, INTANGIBLES_TAG, iso)
                if v is None:
                    continue
                val = v
                # otherNonCurrent for this date has two filed values (as-filed
                # in the 10-K vs. restated in later filings); use the restated
                # (split) figure from the same filing so it's internally
                # consistent with the intangibles figure.
                or_contexts, or_facts = store.get(lab)
                cid = find_instant_context(or_contexts, iso, ())
                bs_data["otherNonCurrent"][i] = to_millions(get_val(or_facts, BS_CONCEPTS["otherNonCurrent"], cid))
                break
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

    # ---- cash flow (YTD-differenced quarterly, per fiscal year) ----
    cf_data = {k: [None] * NE for k in CF_CONCEPTS}
    ytd_buckets = ["3mo", "6mo", "9mo", "annual"]

    def ytd_val(concept, label, bucket):
        cur, _ = cf_current_py(companyfacts, concept, accn[label], BUCKET_RANGES[bucket])
        return cur

    ext_fys = sorted({fy for fy, _ in EXT})
    for key, concept in CF_CONCEPTS.items():
        for fy in ext_fys:
            prev = 0
            for q in (1, 2, 3, 4):
                if (fy, q) not in ei:
                    break
                ytd = ytd_val(concept, filing_label((fy, q)), ytd_buckets[q - 1])
                cf_data[key][ei[(fy, q)]] = to_millions(ytd - prev) if ytd is not None else None
                prev = ytd if ytd is not None else prev

    # ---- consistency checks: Q1+Q2+Q3 filed sum vs. filed 9mo YTD, for every
    # fiscal year whose Q4 is derived ----
    # This is what makes the Q4 = annual - 9mo derivation airtight: it
    # confirms "9mo" (the filed YTD figure we subtract) really does equal the
    # sum of the three individually-filed quarters, for every series the
    # derivation touches.
    checks = []
    nine_month_checks = []

    def check(name, q1, q2, q3, ytd9):
        if None in (q1, q2, q3, ytd9):
            row = (name, q1, q2, q3, ytd9, None, "SKIP (missing input)")
        else:
            s = round(q1 + q2 + q3, 3)
            ok = abs(s - ytd9) < 0.5
            row = (name, q1, q2, q3, ytd9, s, "OK" if ok else "MISMATCH")
        checks.append(row)
        nine_month_checks.append(row)

    for fy in q4_fys:
        Q3 = q3_of(fy)
        sfx = "" if len(q4_fys) == 1 else f" {fy_short(fy)}"
        i1, i2, i3 = ei[(fy, 1)], ei[(fy, 2)], ei[(fy, 3)]

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
            check(f"is.{key}{sfx}", is_data[key][i1], is_data[key][i2], is_data[key][i3], to_millions(ytd9_raw))

        for name in CATEGORIES:
            ytd9_val, _ = store.dim_current_py(Q3, REV_CONCEPT, cat_mset(name), "9mo")
            check(f"cat.revenue.{name}{sfx}", cat_revenue[name][i1], cat_revenue[name][i2], cat_revenue[name][i3],
                  to_millions(ytd9_val))

        for name in GEOGRAPHIES:
            member = GEOGRAPHIES[name]
            mset = {f"aapl:{member}"}
            rev9, _ = store.dim_current_py(Q3, REV_CONCEPT, mset, "9mo")
            op9, _ = store.dim_current_py(Q3, OPINC_CONCEPT, mset, "9mo")
            check(f"geo.revenue.{name}{sfx}", geo_revenue[name][i1], geo_revenue[name][i2], geo_revenue[name][i3],
                  to_millions(rev9))
            check(f"geo.opInc.{name}{sfx}", geo_opinc[name][i1], geo_opinc[name][i2], geo_opinc[name][i3],
                  to_millions(op9))


    # Independent cross-checks for geo.cos / geo.sm / geo.corp -- these three
    # series are sourced differently from everything else above (pre-FY26
    # quarters come from the next-year filings' restated PY columns rather
    # than each quarter's own original filing), so they don't get a "sum of
    # quarters == filed 9mo YTD" check the same way. But two accounting
    # identities let us tie them back to numbers that DO have that check:
    #   Sigma(geo.cos, all 5 regions) must equal is.totalCos
    #   geo.corp.ga + Sigma(geo.sm, all 5 regions) must equal is.sga
    # (geo.corp.rd already cross-checks against is.rd directly, since
    # Corporate R&D == 100% of consolidated R&D -- Apple doesn't allocate
    # R&D to geographic segments.)
    def identity(name, lhs_parts, rhs):
        if rhs is None or any(p is None for p in lhs_parts):
            checks.append((name, None, None, None, rhs, None, "SKIP (missing input)"))
            return None
        return sum(lhs_parts)

    for j, i in enumerate(win_idx):
        ql = QUARTERS[j]
        cos_sum = identity(f"Sigma(geo.cos)=={ql}", [geo_cos[n][i] for n in GEOGRAPHIES], is_data["totalCos"][i])
        if cos_sum is not None:
            checks.append((f"Sigma(geo.cos)=={ql}", cos_sum, None, None, is_data["totalCos"][i],
                           cos_sum, "OK" if abs(cos_sum - is_data["totalCos"][i]) < 0.5 else "MISMATCH"))
        sga_sum = identity(f"corp.ga+Sigma(geo.sm)=={ql}", [corp_ga[i]] + [geo_sm[n][i] for n in GEOGRAPHIES],
                           is_data["sga"][i])
        if sga_sum is not None:
            checks.append((f"corp.ga+Sigma(geo.sm)=={ql}", sga_sum, None, None, is_data["sga"][i],
                           sga_sum, "OK" if abs(sga_sum - is_data["sga"][i]) < 0.5 else "MISMATCH"))
        if corp_rd[i] is None or is_data["rd"][i] is None:
            checks.append((f"corp.rd==is.rd=={ql}", corp_rd[i], None, None, is_data["rd"][i],
                           None, "SKIP (missing input)"))
        else:
            rd_match = corp_rd[i] == is_data["rd"][i]
            checks.append((f"corp.rd==is.rd=={ql}", corp_rd[i], None, None, is_data["rd"][i],
                           corp_rd[i], "OK" if rd_match else "MISMATCH"))

    for fy in q4_fys:  # cash-flow 9mo checks (kept after the identities, as originally ordered)
        Q3 = q3_of(fy)
        sfx = "" if len(q4_fys) == 1 else f" {fy_short(fy)}"
        i1, i2, i3 = ei[(fy, 1)], ei[(fy, 2)], ei[(fy, 3)]
        for key in CF_CONCEPTS:
            ytd9_cf, _ = cf_current_py(companyfacts, CF_CONCEPTS[key], accn[Q3], BUCKET_RANGES["9mo"])
            check(f"cf.{key}{sfx}", cf_data[key][i1], cf_data[key][i2], cf_data[key][i3], to_millions(ytd9_cf))

    mismatches = [c for c in checks if c[-1] == "MISMATCH"]
    if mismatches:
        for m in mismatches:
            gaps.append(f"CONSISTENCY MISMATCH: {m[0]} sum(Q1..Q3)={m[5]} vs filed 9mo={m[4]}")

    nine_ok = sum(1 for c in nine_month_checks if c[-1] == "OK")
    q4_labels = " and ".join(quarter_label((fy, 4)) for fy in q4_fys)
    if len(q4_fys) == 1:
        k_phrase, fy_phrase = k_of(q4_fys[0]), fy_short(q4_fys[0])
    else:
        k_phrase, fy_phrase = "same-fiscal-year 10-K", "same-fiscal-year"
    derived_q4 = (
        f"{q4_labels} flow items (revenue, cost of sales, opex, category/segment "
        "revenue, segment operating income, geographic cost of sales, "
        "geographic selling & marketing, and the Corporate R&D/G&A/operating-loss "
        f"reconciliation row) = {k_phrase} annual value MINUS the sum of the Q1-Q3 "
        f"{fy_phrase} filed quarterly values. For most series that subtrahend is the "
        "filed 9-month YTD fact directly; for geographic cost of sales/S&M and "
        "the Corporate row (which Apple did not tag by quarter until FY26) it is "
        "the sum of the three individually-filed quarters instead -- confirmed "
        "identical to the filed 9mo YTD fact wherever both exist "
        f"({nine_ok}/{len(nine_month_checks)} checks).")

    # ---- slice the extended grid down to the output window ----
    is_out = {k: (win(v) if isinstance(v, list) else v) for k, v in is_data.items()}
    q_data = {
        "labels": QUARTERS,
        "revenue": is_out["totalRev"],
        "yoy": [round((is_out["totalRev"][i] - is_out["totalRevPY"][i]) / is_out["totalRevPY"][i] * 100, 1)
                if is_out["totalRev"][i] is not None and is_out["totalRevPY"][i] else None for i in range(N)],
        "gmPct": is_out["gmPctTotal"],
        "opIncome": is_out["opIncome"],
    }
    cf_out = {k: win(v) for k, v in cf_data.items()}
    cf_out["labels"] = QUARTERS

    dataset = {
        "meta": {
            "quarters": QUARTERS,
            "quarterEnds": QUARTER_ENDS,
            "derived": [
                derived_q4,
                "Quarterly cash-flow items = YTD(N) - YTD(N-1), since Apple's cash flow "
                "statement is filed cumulative/year-to-date within each fiscal year.",
            ],
            "sources": {
                label: {"accn": filings[label]["accn"], "form": filings[label]["form"],
                        "filed": filings[label]["filed"], "periodEnd": filings[label]["end"]}
                for label in filings
            },
        },
        "is": is_out,
        "q": q_data,
        "cat": {
            "names": list(CATEGORIES.keys()),
            "revenue": {n: win(v) for n, v in cat_revenue.items()},
            "revenuePY": {n: win(v) for n, v in cat_revenue_py.items()},
        },
        "geo": {
            "names": list(GEOGRAPHIES.keys()),
            "revenue": {n: win(v) for n, v in geo_revenue.items()},
            "revenuePY": {n: win(v) for n, v in geo_revenue_py.items()},
            "opInc": {n: win(v) for n, v in geo_opinc.items()},
            "opIncPY": {n: win(v) for n, v in geo_opinc_py.items()},
            "cos": {n: win(v) for n, v in geo_cos.items()},
            "sm": {n: win(v) for n, v in geo_sm.items()},
            "corp": {"rd": win(corp_rd), "ga": win(corp_ga), "opLoss": win(corp_oploss)},
        },
        "bs": dict({"dates": bs_dates_labels}, **bs_data),
        "cf": cf_out,
    }
    return dataset, gaps, checks


def quarter_short_labels(dataset):
    """e.g. "Q1 FY25 (Dec-24)" for the CSV headers."""
    out = []
    for label, end in zip(dataset["meta"]["quarters"], dataset["meta"]["quarterEnds"]):
        d = _effective(end)  # nominal month (a Jul 1 period end reads as Jun)
        out.append(f"{label} ({_MONTHS[d.month - 1]}-{d.year % 100:02d})")
    return out


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
        for i, label in enumerate(quarter_short_labels(dataset)):
            row = [label] + [fmt(dataset["cat"]["revenue"][n][i]) for n in names]
            row.append(fmt(dataset["is"]["totalRev"][i]))
            w.writerow(row)


def write_csv_02(dataset, path):
    names = dataset["geo"]["names"]
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Period", "Americas", "Europe", "Greater_China", "Japan", "Rest_of_Asia_Pacific", "Total"])
        for i, label in enumerate(quarter_short_labels(dataset)):
            row = [label] + [fmt(dataset["geo"]["revenue"][n][i]) for n in names]
            row.append(fmt(dataset["is"]["totalRev"][i]))
            w.writerow(row)
        yoy_row = ["YoY_Growth"]
        for n in names:
            cur, py = dataset["geo"]["revenue"][n][-1], dataset["geo"]["revenuePY"][n][-1]
            yoy_row.append(f"{round((cur - py) / py * 100)}%" if cur is not None and py else "")
        yoy_row.append(f"{round(dataset['q']['yoy'][-1])}%" if dataset["q"]["yoy"][-1] is not None else "")
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
        w.writerow(["Line_Item"] + quarter_short_labels(dataset))
        for name, arr, nd in rows:
            w.writerow([name] + [fmt(v, nd if isinstance(v, float) else None) for v in arr])
        w.writerow(["Gross margin % - Products"] + [
            f"{is_['gmPctProducts'][i]}%" if is_["gmPctProducts"][i] is not None else "" for i in range(len(is_["totalRev"]))])
        w.writerow(["Gross margin % - Services"] + [
            f"{is_['gmPctServices'][i]}%" if is_["gmPctServices"][i] is not None else "" for i in range(len(is_["totalRev"]))])
        w.writerow(["Gross margin % - Total"] + [
            f"{is_['gmPctTotal'][i]}%" if is_["gmPctTotal"][i] is not None else "" for i in range(len(is_["totalRev"]))])
        w.writerow(["Effective tax rate"] + [
            f"{is_['taxRate'][i]}%" if is_["taxRate"][i] is not None else "" for i in range(len(is_["totalRev"]))])


def write_csv_04(dataset, path):
    bs = dataset["bs"]
    labels = bs["dates"][1:]  # drop the leading opening snapshot to align with the window quarters
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
        w.writerow(["Segment", "Metric"] + quarter_short_labels(dataset))
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
        w.writerow(["Metric"] + quarter_short_labels(dataset))
        w.writerow(["Total net sales ($M)"] + [fmt(v) for v in dataset["is"]["totalRev"]])
        w.writerow(["YoY revenue growth (%)"] + [fmt(v, 1) if v is not None else "" for v in dataset["q"]["yoy"]])
        w.writerow(["Gross margin (%)"] + [fmt(v, 1) if v is not None else "" for v in dataset["q"]["gmPct"]])
        w.writerow(["Operating income ($M)"] + [fmt(v) for v in dataset["is"]["opIncome"]])


def write_csv_08(dataset, path):
    cf = dataset["cf"]
    fcf = [round(cf["opCash"][i] - cf["capex"][i]) if cf["opCash"][i] is not None and cf["capex"][i] is not None
           else None for i in range(len(cf["opCash"]))]
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Line_Item"] + quarter_short_labels(dataset))
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


def carry_forward(existing, dataset, gaps):
    """Copy the non-XBRL sections from the existing data.json unchanged.

    These are hand-curated or come from non-XBRL sources, so they cannot be
    refreshed here and keep their own source labels (e.g. "Q3 FY26"). If the
    quarter window moved and one of them holds a per-quarter array aligned to
    the OLD window, it is realigned by quarter label: quarters still in the
    window keep their value, new quarters get null and a gap entry. Nothing is
    ever extended with a guessed value."""
    old_q = (existing.get("meta") or {}).get("quarters") or []
    new_q = dataset["meta"]["quarters"]
    moved = bool(old_q) and old_q != new_q

    def realign(node, path):
        if isinstance(node, dict):
            return {k: realign(v, f"{path}.{k}") for k, v in node.items()}
        if moved and isinstance(node, list) and len(node) == len(old_q) and len(old_q) >= 4:
            by_label = dict(zip(old_q, node))
            out = [by_label.get(q) for q in new_q]
            new_missing = [q for q in new_q if q not in by_label]
            gaps.append(f"{path}: per-quarter array realigned from {old_q[0]}..{old_q[-1]} to "
                        f"{new_q[0]}..{new_q[-1]}; {new_missing} set to null (no automatic source). "
                        f"Dropped {[q for q in old_q if q not in new_q]}.")
            return out
        return node

    for section in UNCHANGED_SECTIONS:
        if section in existing:
            dataset[section] = realign(existing[section], section)
        else:
            gaps.append(f"existing data.json had no '{section}' section to carry over")
    if moved:
        gaps.append(f"quarter window moved {old_q[0]}..{old_q[-1]} -> {new_q[0]}..{new_q[-1]}. "
                    f"Carried sections {UNCHANGED_SECTIONS} were copied unchanged and still describe "
                    f"the periods named in their own labels (e.g. cap.buybackQ3, hc.sbcQ3, fwd guidance); "
                    f"they need a manual refresh from the new filing / call.")


def self_test():
    """Offline checks of the window logic against Apple's real 10-Q/10-K
    period-end dates (dates only -- no financial values)."""
    real = [  # (form, reportDate) from submissions.json, Oct 2026
        ("10-Q", "2026-06-27"), ("10-Q", "2026-03-28"), ("10-Q", "2025-12-27"), ("10-K", "2025-09-27"),
        ("10-Q", "2025-06-28"), ("10-Q", "2025-03-29"), ("10-Q", "2024-12-28"), ("10-K", "2024-09-28"),
        ("10-Q", "2024-06-29"), ("10-Q", "2024-03-30"), ("10-Q", "2023-12-30"), ("10-K", "2023-09-30"),
        ("10-Q", "2023-07-01"), ("10-Q", "2023-04-01"), ("10-Q", "2022-12-31"), ("10-K", "2022-09-24"),
        ("10-Q", "2022-06-25"), ("10-Q", "2022-03-26"), ("10-Q", "2021-12-25"), ("10-K", "2021-09-25"),
        ("10-Q", "2016-12-31"), ("10-K", "2016-09-24"),
    ]
    rows = [{"form": f, "reportDate": d} for f, d in real]
    noise = [{"form": "4", "reportDate": "2026-08-01"}, {"form": "10-Q/A", "reportDate": "2026-09-26"},
             {"form": "8-K", "reportDate": "2026-07-30"}]
    failures = []

    def expect(name, got, want):
        if got != want:
            failures.append(f"{name}: got {got!r}, want {want!r}")

    # fiscal calendar, including the 53-week / month-spill dates
    for (f, d), want in [(("10-Q", "2023-07-01"), (2023, 3)), (("10-Q", "2023-04-01"), (2023, 2)),
                         (("10-Q", "2022-12-31"), (2023, 1)), (("10-K", "2023-09-30"), (2023, 4)),
                         (("10-K", "2022-09-24"), (2022, 4)), (("10-Q", "2016-12-31"), (2017, 1)),
                         (("10-Q", "2025-12-27"), (2026, 1)), (("10-K", "2025-09-27"), (2025, 4))]:
        expect(f"classify {f} {d}", classify_filing(f, d, 9), want)

    # today: Q3 FY26 10-Q is the latest filing
    w = select_window(rows + noise)
    expect("today labels", w["labels"],
           ["Q1 FY25", "Q2 FY25", "Q3 FY25", "Q4 FY25", "Q1 FY26", "Q2 FY26", "Q3 FY26"])
    expect("today ends", w["ends"], ["2024-12-28", "2025-03-29", "2025-06-28", "2025-09-27",
                                     "2025-12-27", "2026-03-28", "2026-06-27"])
    expect("today leading", (w["leading"], w["leading_end"]), ((2024, 4), "2024-09-28"))
    expect("today filings", list(w["filings"]),
           ["Q1 FY25", "Q2 FY25", "Q3 FY25", "FY25 10-K", "Q1 FY26", "Q2 FY26", "Q3 FY26", "FY24 10-K"])

    # slide: Apple files the FY26 10-K (period end Sep 26, 2026)
    w = select_window([{"form": "10-K", "reportDate": "2026-09-26"}] + rows + noise)
    expect("slide labels", w["labels"],
           ["Q2 FY25", "Q3 FY25", "Q4 FY25", "Q1 FY26", "Q2 FY26", "Q3 FY26", "Q4 FY26"])
    expect("slide ends", w["ends"], ["2025-03-29", "2025-06-28", "2025-09-27", "2025-12-27",
                                     "2026-03-28", "2026-06-27", "2026-09-26"])
    expect("slide leading", (w["leading"], w["leading_end"]), ((2025, 1), "2024-12-28"))
    expect("slide ext", [quarter_label(fq) for fq in w["ext"]],
           ["Q1 FY25", "Q2 FY25", "Q3 FY25", "Q4 FY25", "Q1 FY26", "Q2 FY26", "Q3 FY26", "Q4 FY26"])
    expect("slide filings", list(w["filings"]),
           ["Q1 FY25", "Q2 FY25", "Q3 FY25", "FY25 10-K", "Q1 FY26", "Q2 FY26", "Q3 FY26", "FY26 10-K"])

    # then the Q1 FY27 10-Q (Dec 26, 2026): window Q3 FY25..Q1 FY27
    w = select_window([{"form": "10-Q", "reportDate": "2026-12-26"},
                       {"form": "10-K", "reportDate": "2026-09-26"}] + rows)
    expect("Q1 FY27 labels", w["labels"],
           ["Q3 FY25", "Q4 FY25", "Q1 FY26", "Q2 FY26", "Q3 FY26", "Q4 FY26", "Q1 FY27"])

    # an amended 10-K alone must not move the window
    w = select_window([{"form": "10-K/A", "reportDate": "2026-09-26"}] + rows)
    expect("10-K/A ignored", w["labels"][-1], "Q3 FY26")

    # a hole in the filings fails loudly instead of building a short window
    try:
        select_window([r for r in rows if r["reportDate"] != "2025-03-29"])
        failures.append("missing Q2 FY25 10-Q: expected RuntimeError")
    except RuntimeError:
        pass

    # carry_forward: unchanged sections copied as-is; a per-quarter array is
    # realigned with null for the new quarter, and that gap is recorded
    old_q = ["Q1 FY25", "Q2 FY25", "Q3 FY25", "Q4 FY25", "Q1 FY26", "Q2 FY26", "Q3 FY26"]
    new_q = old_q[1:] + ["Q4 FY26"]
    existing = {"meta": {"quarters": old_q},
                "fx": {"hedgeDesignated": [1, 2]}, "cap": {"buybackQ3": 5}, "env": {"x": 1}, "fwd": {"y": "z"},
                "hc": {"perQ": [10, 11, 12, 13, 14, 15, 16], "fte": 1}}
    ds = {"meta": {"quarters": new_q}}
    g = []
    carry_forward(existing, ds, g)
    expect("carry fx", ds["fx"], {"hedgeDesignated": [1, 2]})
    expect("carry hc.perQ", ds["hc"]["perQ"], [11, 12, 13, 14, 15, 16, None])
    expect("carry hc.fte", ds["hc"]["fte"], 1)
    expect("carry gap", any(x.startswith("hc.perQ:") and "Q4 FY26" in x for x in g), True)

    if failures:
        print("SELF-TEST FAILED:")
        for f in failures:
            print(" -", f)
        return 1
    print("self-test OK")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache-dir", default=DEFAULT_CACHE_DIR)
    ap.add_argument("--no-network", action="store_true")
    ap.add_argument("--data-json-out", default=os.path.join(DASH_DIR, "data.json"))
    ap.add_argument("--existing-in", default=None,
                     help="data.json to carry the non-XBRL sections from (default: --data-json-out)")
    ap.add_argument("--csv-out-dir", default=REPO_ROOT)
    ap.add_argument("--no-csv", action="store_true",
                     help="write data.json only (the 01-08 CSV exports are not tracked in this repo)")
    ap.add_argument("--report-out", default=None,
                     help="optional path to dump raw gaps/checks as JSON for the validation report")
    ap.add_argument("--as-of", default=None, metavar="YYYY-MM-DD",
                     help="simulate an earlier day: ignore filings filed after this date")
    ap.add_argument("--self-test", action="store_true",
                     help="run the offline window-selection tests and exit (no network, writes nothing)")
    args = ap.parse_args()

    if args.self_test:
        sys.exit(self_test())

    fetcher = Fetcher(args.cache_dir, allow_network=not args.no_network)
    dataset, gaps, checks = build_dataset(fetcher, args.as_of)

    # Merge the sections that are unchanged from the current data.json
    # (fx hedging/capital returns, capital allocation, headcount/equity comp,
    # environment, forward guidance) -- read live so reruns stay idempotent.
    with open(args.existing_in or args.data_json_out) as f:
        existing = json.load(f)
    carry_forward(existing, dataset, gaps)

    # Compact + trailing newline: byte-identical to the committed data.json format.
    with open(args.data_json_out, "w") as f:
        f.write(json.dumps(dataset, separators=(",", ":")) + "\n")
    print(f"Wrote {args.data_json_out} ({dataset['meta']['quarters'][0]}..{dataset['meta']['quarters'][-1]})")

    if not args.no_csv:
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
