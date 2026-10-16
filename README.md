# Multi-company FP&A + Strategic Finance Dashboard

Single-page public-company finance dashboard with global company switching,
deterministic calculations, FP&A scenarios, sourced Ask AI, and explicit data
availability boundaries.

Live: https://findashboard.vercel.app

The company selector covers Apple, Alphabet, NVIDIA, Microsoft, Amazon, Meta,
AMD, Broadcom, Oracle, Salesforce, and Intel. Every company includes seven
standardized SEC quarters. Apple also includes richer product, geography,
guidance, headcount, and environmental sources.

Every tab uses the selected company's fiscal calendar. Period presets include
current fiscal YTD, latest quarter, latest complete fiscal year, and all available
quarters. CSV exports preserve the company, period, source, and field basis.

## Tabs
- **Home** — company-aware KPIs, How It Works, FP&A use cases, source notes, and the agentic finance stack
- **Company Overview** — standardized SEC facts and source links by quarter
- **Executive Summary** — management view of performance, risks, and unavailable disclosures
- **Revenue** — standardized quarterly revenue for every company; Apple adds product and geography detail
- **Variance Analysis** — current vs prior-year or prior-period financial bridge with charts and table
- **Planning & Scenarios** — visible revenue, gross-margin, and opex assumptions applied to the latest filed baseline; always labeled MODELED
- **Profitability & Opex** — standardized margins and R&D; Apple adds segment and geography detail
- **Balance Sheet · AR/AP** — standardized liquidity, debt, receivables, and payables; Apple adds working-capital cycles
- **FX & Capital Returns** — standardized buybacks, dividends, cash, and debt; Apple adds FX detail
- **Headcount & R&D** — standardized R&D; unavailable headcount remains explicit outside Apple
- **Outlook** — reported momentum for every company; Apple adds sourced earnings-call commentary
- **Environment (CSRD)** — Apple sourced detail; other companies show the sustainability source needed rather than estimated data

## Forecast Ledger

The **Forecast Ledger** tab holds the owner's own calls (revenue, gross margin, opex for a
quarter that has not been filed yet), next to the verbatim revenue guidance each company
published in its latest SEC 8-K earnings exhibit, and the filed actuals once they exist.
`forecasts.json` ships empty. Nothing in it is generated: only a call you lock with the helper appears.

```bash
node tools/add_forecast.mjs apple "Q4 FY26" 2026-09-26 --revenue 112000 --gm 47.0 --opex 19500 [--note "..."]
```

The helper sets `lockedAt` to today, computes the hash, appends the entry, refuses a duplicate id, and
refuses any `periodEnd` at or before the company's latest period in `companies.json` (no backfilling).
It warns when the company does not file `sellingGeneralAdministrative` under the standard tag, because
opex then cannot be graded. Entry shape (numbers are USD millions; the values below are a format example only):

```json
{"id":"apple-2026-09-26","company":"apple","label":"Q4 FY26","periodEnd":"2026-09-26",
 "revenue":112000,"grossMarginPct":47.0,"opex":19500,"note":"","lockedAt":"2026-10-14",
 "hash":"<sha256 of id|company|label|periodEnd|revenue|grossMarginPct|opex|lockedAt>"}
```

How it is enforced: `npm test` (part of the daily workflow) rechecks every entry: unique ids, hash
recomputes, sorted by `lockedAt`, label matches `companies.json`, and `lockedAt` is before the period's first
filing (`source.firstFiled`) when that is known, otherwise not in the future. Git history is the audit trail.
`lockedAt` is self-reported: the hash and git history show that an entry did not change after it was
committed, not when it was first written.

Filed guidance comes from `guidance` in `company-context.json` (built by `tools/fetch_public_context.py`
from "SEC 8-K exhibit" documents only): one verbatim sentence with its source link and date, or `null`.
The dashboard parses a range at render time only for these shapes: `$61-64 billion`,
`$15.8 billion to $16.8 billion`, `between $X and $Y`, `plus or minus N%` and `plus or minus $N`
(the last two are tagged DERIVED because the range is computed from the tolerance), plus
`approximately $34.8 billion`; anything else shows the excerpt with "Range not parsed".
Annual guidance is not graded.

**Forecast accuracy** shows once any call is graded: calls graded, mean absolute revenue error, bias (mean signed
revenue error, labeled "runs high" or "runs low"), mean absolute gross margin error in points, and mean absolute
opex error where SG&A is filed under the standard tag. With no graded calls it shows one quiet line instead.

**Management guidance vs actual** grades every sentence in `guidanceHistory` (per company, in `company-context.json`,
accumulated by the daily refresh). Guidance filed on date D targets the first period in `companies.json` whose
`periodEnd` is after D. If that quarter is not filed yet the row says "Awaiting filing"; once filed it shows the guided
range (REAL, with the excerpt and link), actual revenue (REAL), inside or outside, and midpoint error. Ranges the
parser does not recognise show "Range not parsed, excerpt shown". A sentence filed more than 135 days before the
first stored quarter ends is not tied to any quarter (that quarter has left the window).

The same tab has a **Figures changed in later filings** section for the selected company. It reads
`restatements` from `companies.json` when the fetcher provides it and says UNAVAILABLE until then.

## Sources and evidence states

The multi-company layer uses official SEC Company Facts and links every period to
its 10-Q or 10-K. Apple-specific tabs also use Apple filings, earnings-call
commentary, and the Environmental Progress Report. Values are presented as REAL,
DERIVED, MODELED, or UNAVAILABLE. See `DATA_PROVENANCE.md`.

## Ask AI
`api/ask.js` is a Vercel serverless function that calls Claude server-side. The
browser never sees the key. Dashboard AI receives the selected company, fiscal
period, tab, supported filters, source evidence, and visible scenario assumptions.
General AI receives no dashboard evidence. Missing company data remains unavailable.

For every company, Dashboard AI also receives the connected refresh timestamp,
all standardized SEC metrics available for the selected periods, and tab-scoped
official management excerpts from recent SEC-filed earnings materials. Planning
and Treasury also receive U.S. Treasury, BLS, and ECB macro context. Every company
also receives a separately ingested latest 10-K with tab-scoped annual business,
strategy, risk, liquidity, workforce, market-risk, and legal context. Coverage includes
core statements plus inventory, goodwill, PP&E, deferred revenue, noncurrent
marketable securities, SG&A, depreciation and amortization, interest, taxes,
acquisitions, and stock compensation when filed by the issuer.

## Automated refresh

`.github/workflows/refresh-company-data.yml` runs daily at 10:17 UTC and can also
be started manually. It rebuilds `companies.json` from official SEC Company Facts,
refreshes `company-context.json` from SEC filings, U.S. Treasury, BLS, and ECB,
runs the AI evidence tests, commits the verified datasets, and deploys the clean
repository contents to the existing Vercel project. The repository must contain a
`VERCEL_TOKEN` Actions secret with deploy access to `findashboard`.

To enable it on any deployment:
1. In the Vercel project → Settings → Environment Variables, add `ANTHROPIC_API_KEY` with a real Anthropic API key.
2. Redeploy. Without the key, the UI degrades gracefully with a message telling the visitor it isn't configured yet.

## Running locally / deploying
```bash
# from the repo root
python3 -m http.server 4173
# then open http://localhost:4173/ (Ask AI still needs the Vercel function)
```

Deploys are automatic: the Vercel project `findashboard` is Git-integrated with
this repository, so every push to `main` builds and promotes to
https://findashboard.vercel.app (alias: apple-dashboard-eta.vercel.app). There is no
separate `vercel --prod` step. `.github/workflows/refresh-company-data.yml` reruns the
SEC fetchers daily, runs `npm test`, and commits refreshed `companies.json` /
`company-context.json`, which triggers the same deploy.

Opening Claude Code in this repo directory (`claude` in your terminal) gives it full context on this dashboard — you can ask it to keep iterating on layout, data, or the Ask AI logic directly.
