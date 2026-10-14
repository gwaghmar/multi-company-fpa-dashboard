// Forecast Ledger logic. Pure functions, no DOM and no fetch, so node tests and the browser share them.
// Loaded in the page with <script type="module" src="./ledger-core.mjs">; renderers read
// globalThis.LedgerCore at render time because module scripts are deferred.

const UNIT = "USD millions";

// SHA-256 in plain JS so the same code runs in node and in the browser (no node:crypto import).
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return Array.from(h, word => word.toString(16).padStart(8, "0")).join("");
}

// sha256 of id|company|label|periodEnd|revenue|grossMarginPct|opex|lockedAt (numbers as String(n), null as "null").
export function forecastHash(entry) {
  const fields = [entry.id, entry.company, entry.label, entry.periodEnd, entry.revenue, entry.grossMarginPct, entry.opex, entry.lockedAt];
  return sha256Hex(fields.map(String).join("|"));
}

const isNumber = value => typeof value === "number" && Number.isFinite(value);
const pct = (forecast, actual) => (isNumber(forecast) && isNumber(actual) && actual !== 0 ? 100 * (forecast - actual) / Math.abs(actual) : null);

// Actual opex is R&D plus SG&A; null unless both are filed under the standard tags.
export function actualOpex(period) {
  const metrics = period?.metrics || {};
  return isNumber(metrics.rd) && isNumber(metrics.sellingGeneralAdministrative) ? metrics.rd + metrics.sellingGeneralAdministrative : null;
}

// Signed errors, call minus actual. revenue and opex in percent of actual, gross margin in percentage points.
export function gradeForecast(f, period) {
  const metrics = period?.metrics || {};
  const revenue = metrics.revenue;
  const actualGm = isNumber(metrics.grossProfit) && isNumber(revenue) && revenue !== 0 ? 100 * metrics.grossProfit / revenue : null;
  const opex = actualOpex(period);
  return {
    revenueErrPct: pct(f.revenue, revenue),
    gmErrPts: isNumber(f.grossMarginPct) && actualGm !== null ? f.grossMarginPct - actualGm : null,
    opexErrPct: pct(f.opex, opex)
  };
}

const MULTIPLIER = { billion: 1000, million: 1 };
const NUMBER = "(\\d[\\d,]*(?:\\.\\d+)?)";
const SHAPES = [
  // $61-64 billion
  { re: new RegExp(`\\$\\s?${NUMBER}\\s*(?:-|\\u2013|to)\\s*\\$?\\s?${NUMBER}\\s*(billion|million)\\b`, "i"), units: 1, read: m => [m[1], m[2], m[3], m[3]] },
  // $15.8 billion to $16.8 billion
  { re: new RegExp(`\\$\\s?${NUMBER}\\s*(billion|million)\\s+to\\s+\\$\\s?${NUMBER}\\s*(billion|million)\\b`, "i"), units: 2, read: m => [m[1], m[3], m[2], m[4]] },
  // approximately $34.8 billion
  { re: new RegExp(`\\bapproximately\\s+\\$\\s?${NUMBER}\\s*(billion|million)\\b`, "i"), units: 1, read: m => [m[1], m[2], null, null] },
  // between $197.0 billion and $202.0 billion
  { re: new RegExp(`\\bbetween\\s+\\$\\s?${NUMBER}\\s*(billion|million)\\s+and\\s+\\$\\s?${NUMBER}\\s*(billion|million)\\b`, "i"), units: 2, read: m => [m[1], m[3], m[2], m[4]] }
];
// A point estimate with a stated tolerance. The tolerance is either a percent or a second dollar amount.
const PLUS_MINUS = "(?:plus or minus|\\+/-)";
const TOLERANCES = [
  // $108.0 billion, plus or minus 2%
  { re: new RegExp(`\\$\\s?${NUMBER}\\s*(billion|million),?\\s+${PLUS_MINUS}\\s*${NUMBER}\\s*(?:%|percent)`, "i"), units: 1,
    read: m => ({ point: toMillions(m[1], m[2]), spread: null, pct: Number(m[3]), label: `${m[3]}%` }) },
  // approximately $13 billion, plus or minus $300 million
  { re: new RegExp(`\\$\\s?${NUMBER}\\s*(billion|million),?\\s+${PLUS_MINUS}\\s*\\$\\s?${NUMBER}\\s*(billion|million)\\b`, "i"), units: 2,
    read: m => ({ point: toMillions(m[1], m[2]), spread: toMillions(m[3], m[4]), pct: null, label: `$${m[3]} ${m[4].toLowerCase()}` }) }
];

const toMillions = (digits, unit) => Number((Number(digits.replace(/,/g, "")) * MULTIPLIER[unit.toLowerCase()]).toFixed(6));

// Only the shapes above parse. Any other dollar-denominated amount left over in the sentence
// (for example "plus or minus $300 million") makes it ambiguous, so it is rejected and the excerpt is shown unparsed.
export function parseGuidanceRange(text) {
  if (typeof text !== "string") return null;
  const amounts = (text.match(/\d\s*(?:billion|million)\b/gi) || []).length;
  // Tolerance shapes come back with derivedFrom set, so the UI can say the range was computed, not quoted.
  for (const shape of TOLERANCES) {
    const match = shape.re.exec(text);
    if (!match || shape.units !== amounts) continue;
    const { point, spread, pct, label } = shape.read(match);
    const delta = spread !== null ? spread : point * pct / 100;
    const low = Number((point - delta).toFixed(6)), high = Number((point + delta).toFixed(6));
    if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0) return null;
    return { low, high, unit: UNIT, derivedFrom: label };
  }
  for (const shape of SHAPES) {
    const match = shape.re.exec(text);
    if (!match || shape.units !== amounts) continue;
    const [lowDigits, highDigits, lowUnit, highUnit] = shape.read(match);
    let low, high;
    if (shape.units === 1 && lowUnit === null) {
      low = high = toMillions(lowDigits, highDigits);
    } else if (shape.units === 1) {
      low = toMillions(lowDigits, lowUnit);
      high = toMillions(highDigits, lowUnit);
    } else {
      low = toMillions(lowDigits, lowUnit);
      high = toMillions(highDigits, highUnit);
    }
    if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) return null;
    return { low, high, unit: UNIT };
  }
  return null;
}

// midErrPct is the midpoint minus actual, in percent of actual.
export function gradeGuidance(range, actualRevenue) {
  if (!range || !isNumber(actualRevenue) || actualRevenue === 0) return null;
  const mid = (range.low + range.high) / 2;
  return { inside: actualRevenue >= range.low && actualRevenue <= range.high, midErrPct: 100 * (mid - actualRevenue) / Math.abs(actualRevenue) };
}

// A guidance excerpt filed on date D belongs to the forecast whose window (previous periodEnd, forecast periodEnd] holds D.
export function guidanceForForecast(forecast, contextCompany, periods) {
  const guidance = contextCompany?.guidance;
  if (!guidance || !guidance.text || !guidance.filed || !forecast?.periodEnd) return null;
  const earlier = (periods || []).map(period => period.periodEnd).filter(end => end && end < forecast.periodEnd).sort();
  const previousEnd = earlier.length ? earlier[earlier.length - 1] : "";
  return guidance.filed > previousEnd && guidance.filed <= forecast.periodEnd ? guidance : null;
}

// onRecord: all calls. graded: calls whose period is now filed. next: earliest ungraded call, or null.
export function ledgerSummary(forecasts, companies) {
  const list = Array.isArray(forecasts) ? forecasts : [];
  const filed = f => (companies?.[f.company]?.periods || []).find(period => period.periodEnd === f.periodEnd) || null;
  const open = list.filter(f => !filed(f)).sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  return {
    onRecord: list.length,
    graded: list.length - open.length,
    next: open.length ? { company: open[0].company, label: open[0].label, periodEnd: open[0].periodEnd } : null
  };
}

export const LedgerCore = { gradeForecast, actualOpex, parseGuidanceRange, gradeGuidance, guidanceForForecast, forecastHash, ledgerSummary };
globalThis.LedgerCore = LedgerCore;
