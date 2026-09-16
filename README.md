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
`VERCEL_TOKEN` Actions secret with deploy access to `apple-dashboard`.

To enable it on any deployment:
1. In the Vercel project → Settings → Environment Variables, add `ANTHROPIC_API_KEY` with a real Anthropic API key.
2. Redeploy. Without the key, the UI degrades gracefully with a message telling the visitor it isn't configured yet.

## Running locally / redeploying from your Mac
```bash
# from the repo root
cd applications/apple-demo/dashboard-v2

# serve the files over HTTP so data.json and companies.json can load
python3 -m http.server 4173
# then open http://localhost:4173/ (Ask AI still needs the Vercel function)

# to deploy your own copy via Vercel CLI
npx vercel link   # connect this folder to the existing "apple-dashboard" project
npx vercel --prod
```

Opening Claude Code in this repo directory (`claude` in your terminal) gives it full context on this dashboard — you can ask it to keep iterating on layout, data, or the Ask AI logic directly.
