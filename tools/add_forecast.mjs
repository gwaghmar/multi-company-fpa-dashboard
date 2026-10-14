#!/usr/bin/env node
// Lock one forecast call into forecasts.json.
// Usage: node tools/add_forecast.mjs apple "Q4 FY26" 2026-09-26 --revenue 112000 --gm 47.0 --opex 19500 [--note "..."]
// Test option: --file <path> writes to another forecasts file instead of the real one.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { forecastHash } from "../ledger-core.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const USAGE = 'Usage: node tools/add_forecast.mjs <company> "<label>" <periodEnd YYYY-MM-DD> --revenue <USD millions> --gm <gross margin %> --opex <USD millions> [--note "..."]';

function fail(message) {
  console.error(`Refused: ${message}`);
  process.exit(1);
}

const positional = [];
const options = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    options[args[i].slice(2)] = args[i + 1];
    i++;
  } else {
    positional.push(args[i]);
  }
}
if (positional.length !== 3) fail(`expected company, label and periodEnd.\n${USAGE}`);
const [company, label, periodEnd] = positional;

const number = (name, required) => {
  if (options[name] === undefined) return required ? fail(`--${name} is required.\n${USAGE}`) : null;
  const value = Number(options[name]);
  if (!Number.isFinite(value)) fail(`--${name} must be a number, got "${options[name]}".`);
  return value;
};

if (!/^\d{4}-\d{2}-\d{2}$/.test(periodEnd) || Number.isNaN(Date.parse(periodEnd))) fail(`periodEnd must be YYYY-MM-DD, got "${periodEnd}".`);
if (!label.trim()) fail("label is empty.");

const companies = JSON.parse(readFileSync(join(ROOT, "companies.json"), "utf8")).companies;
const entryCompany = companies[company];
if (!entryCompany || !entryCompany.periods?.length) fail(`unknown company "${company}". Known: ${Object.keys(companies).join(", ")}.`);

const latest = entryCompany.periods.map(period => period.periodEnd).sort().pop();
if (periodEnd <= latest) fail(`${company} already has a filed period ending ${latest}. Calls are never backfilled; periodEnd must be after ${latest}.`);

const sgaFiled = entryCompany.periods.some(period => period.metrics?.sellingGeneralAdministrative != null);
const revenue = number("revenue", true);
const grossMarginPct = number("gm", true);
const opex = number("opex", sgaFiled);
if (revenue <= 0) fail("--revenue must be positive.");
if (grossMarginPct <= 0 || grossMarginPct >= 100) fail("--gm must be a percentage between 0 and 100.");
if (!sgaFiled) {
  console.warn(`Warning: ${company} does not file sellingGeneralAdministrative under the standard tag, so opex cannot be graded${opex === null ? "; opex stored as null" : ""}.`);
}

const file = options.file ? resolve(options.file) : join(ROOT, "forecasts.json");
const ledger = JSON.parse(readFileSync(file, "utf8"));
const id = `${company}-${periodEnd}`;
if (ledger.forecasts.some(entry => entry.id === id)) fail(`${id} is already on record. Calls are never edited.`);

const now = new Date();
const lockedAt = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const entry = { id, company, label: label.trim(), periodEnd, revenue, grossMarginPct, opex, note: options.note || "", lockedAt };
entry.hash = forecastHash(entry);

ledger.forecasts.push(entry);
ledger.forecasts.sort((a, b) => a.lockedAt.localeCompare(b.lockedAt));
writeFileSync(file, JSON.stringify(ledger, null, 2) + "\n");
console.log(`Locked ${id} on ${lockedAt} in ${file}\nhash ${entry.hash}`);
