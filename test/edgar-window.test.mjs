import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// tools/fetch_edgar_data.py derives Apple's 7-quarter window from EDGAR's
// filing list instead of a hardcoded list. Its --self-test runs offline
// (no SEC calls, writes nothing) and asserts, among others, that adding the
// FY26 10-K (period end 2026-09-26) slides the window from Q1 FY25..Q3 FY26
// to Q2 FY25..Q4 FY26, and that carried non-XBRL sections get null (never a
// guessed value) for a quarter they have no source for.
test("EDGAR fetcher derives the quarter window from filings (offline self-test)", () => {
  const script = fileURLToPath(new URL("../tools/fetch_edgar_data.py", import.meta.url));
  let r = spawnSync("python3", [script, "--self-test"], { encoding: "utf8" });
  if (r.error && r.error.code === "ENOENT") r = spawnSync("python", [script, "--self-test"], { encoding: "utf8" });
  assert.equal(r.error, undefined, `could not run python: ${r.error}`);
  assert.equal(r.status, 0, `self-test failed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /self-test OK/);
});
