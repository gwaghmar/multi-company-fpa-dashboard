# Design QA: Home tile styling, finance default, and real-data microcharts

source visual truth: `/var/folders/rn/xc1zhg3n0fngv6954jy_rd9h0000gn/T/codex-clipboard-a48af3a9-acb2-49c1-8b2e-5b6b3b36e2be.png`
implementation screenshot: `/Users/redforman/dashboard/applications/apple-demo/dashboard-v2/design-qa-home.png`
implementation URL: `http://127.0.0.1:4173/#tab=home&q=6&cat=all&geo=all&pgeo=all`
viewport: 1280 x 720 CSS pixels, desktop Home state, light theme, latest filed quarter filter
source pixels: 2254 x 894
implementation pixels: 1280 x 720
density normalization: the supplied reference is a cropped tile-region raster, so comparison used the shared KPI and Explore regions rather than a full-frame pixel match; implementation is a browser capture

## Comparison evidence

The implementation was captured from the running local page and compared against the supplied cropped tile reference. The KPI tiles now use distinct restrained accent colors, icon badges, uppercase labels, stronger values, green comparison rows, and neutral baselines. Explore cards now use color-coded surfaces, icon circles, right-side chevrons, filled real-data mini charts or bars, and compact metric badges. The default is the latest filed quarter, Q3 FY26, while the period filter still supports FY26 9mo and full-year views. The implementation is intentionally data-driven, so KPI values and labels come from the existing dashboard dataset.

Focused regions checked: top navigation and hero, KPI cards, Explore the dashboard grid, and responsive Home at 390 x 844.

## Interaction checks

- Explore Revenue card selected the real Revenue tab.
- Open Executive Summary selected the real Exec Summary tab.
- Home cards remained keyboard-semantic buttons in the DOM.
- Phosphor icon stylesheet loaded for the new tile icon treatment.
- Mobile layout at 390 x 844 kept the hero, KPI cards, Explore cards, and horizontal tab navigation usable.
- Browser console warnings and errors: none observed.

## Required fidelity surfaces

- Fonts and typography: Inter and Inter Tight are reused from the existing dashboard. The hero heading, uppercase KPI labels, and card hierarchy match the mock closely. Small metadata is intentionally lighter and smaller than the primary values.
- Spacing and layout rhythm: icon circles, chart baselines, badges, and chevrons follow the mock's compact card rhythm. The six KPI cards remain readable at 1280 x 720, with Carbon Footprint wrapping its label instead of clipping.
- Colors and tokens: existing light-theme tokens are reused. Each KPI and Explore card has a restrained accent family so the grid is easier to scan without turning into a rainbow. Green remains semantic for positive comparisons.
- Image quality and asset fidelity: the target contains no required photographic or illustrative assets. Phosphor supplies the UI icons, and mini charts are rendered from the existing real dashboard arrays.
- Copy and content: the Explore subtitle now matches the reference intent. Dynamic values remain sourced from the existing data model, and unsupported comparisons are not invented.

## Findings

No actionable P0, P1, or P2 findings remain.

Residual P3 polish: the reference uses slightly more decorative chart detail in a few cards. The implementation uses actual quarter arrays, native SVG titles for hover values, and keeps FX as grouped buyback and dividend data. This does not block comprehension or navigation.

## Comparison history

Initial tile styling was reviewed at desktop and mobile sizes. One P2 issue was found in the first pass where card title and description spans ran together. The title and description were changed to block-level layout, then the desktop capture was repeated. A later pass replaced decorative-only mini lines with real quarter data, points, filled areas, bars, grouped capital-return bars, and hover titles. The finance review then changed the default from FY26 9mo to the latest filed quarter, Q3 FY26, while preserving three-quarter context in Home mini charts. No P0, P1, or P2 findings remain. The interaction and responsive checks passed on the final capture.

## Finance default policy

- Home: latest filed quarter, Q3 FY26. Mini charts retain the latest three-quarter context.
- Exec Summary: latest filed quarter, with nine-month and event context labeled separately.
- Revenue: latest filed quarter, with prior-year quarter comparison. Use FY26 YTD for mix over the full year-to-date period.
- Profitability & Opex: latest filed quarter for margin and expense drivers.
- Balance Sheet · AR/AP: latest quarter-end snapshot. Balance-sheet balances are never summed across quarters.
- FX & Capital Returns: latest quarter for current disclosures, with FY26 YTD for cumulative buybacks, dividends, and capital returned.
- Headcount & R&D: latest quarter for R&D, with FY26 YTD for the RSU and share-based-compensation rollforwards.
- Outlook: Q3 FY26 earnings-call context. The guidance is not changed by the period filter.
- Environment (CSRD): CY2025 annual disclosure. The fiscal-quarter filter does not change the annual footprint.

The Filters panel exposes Latest quarter, FY25, FY26, and All quarters presets. The saved landing default is Latest quarter.

## Implementation checklist

- [x] Replace documentation-style Home hero with FY26 overview hero.
- [x] Add Executive Summary and Dashboard AI actions.
- [x] Add six KPI cards near the top.
- [x] Add eight clickable tab explanation cards.
- [x] Keep existing tab routing and dashboard data.
- [x] Move technical stack and source notes behind an About disclosure.
- [x] Verify desktop and mobile rendering.
- [x] Verify primary navigation interactions and console output.
- [x] Replace decorative-only mini charts with real data-driven visuals and hover values.
- [x] Make the default period the latest filed quarter and label it clearly in the hero.
- [x] Add restrained color families and filled chart areas to KPI and Explore cards.

final result: passed
