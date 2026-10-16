// Runs the test suite (`node --test`) and writes status.json for the header trust strip.
// Usage: node tools/write_status.mjs
// Counts come from node's own summary lines; if they cannot be read, nothing is written and the script fails.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = spawnSync(process.execPath, ["--test"], { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
const output = `${run.stdout || ""}\n${run.stderr || ""}`;
const count = name => {
  const match = new RegExp(`^\\S*\\s*${name}\\s+(\\d+)\\s*$`, "m").exec(output);
  return match ? Number(match[1]) : null;
};
const tests = count("tests"), passed = count("pass"), failed = count("fail"), skipped = count("skipped");
if ([tests, passed, failed, skipped].some(value => value === null)) {
  console.error("Could not read the node --test summary; status.json not written.");
  process.exit(1);
}
const status = { tests, passed, failed, skipped, checkedAt: new Date().toISOString() };
writeFileSync(new URL("../status.json", import.meta.url), JSON.stringify(status) + "\n");
console.log(`status.json: ${passed}/${tests} passed, ${failed} failed, ${skipped} skipped`);
process.exit(run.status === 0 && failed === 0 ? 0 : 1);
