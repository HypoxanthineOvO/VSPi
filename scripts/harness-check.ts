import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { checkHarnessSources, type HarnessSource } from "../src/prompts/harness-check.js";

const path = resolve("Docs/harness/sources.json");
const run = promisify(execFile);
const report = await checkHarnessSources({
  manifestPath: path,
  resolveUpstreamRef: async (source: HarnessSource) => {
    const { stdout } = await run("git", ["ls-remote", `${source.sourceUrl}.git`, "HEAD"], {
      timeout: 2_500,
      maxBuffer: 1_000_000,
    });
    const ref = stdout.trim().split(/\s+/, 1)[0];
    if (!ref || !/^[a-f0-9]{40}$/.test(ref)) throw new Error("upstream HEAD did not return a commit SHA");
    return ref;
  },
});
process.stdout.write(
  `Harness sources: ${report.checked}\nUpstream changes: ${report.changes.length}\nDiagnostics: ${report.diagnostics.length}\nNo files changed.\n`,
);
for (const change of report.changes) {
  process.stdout.write(`${change.family}: ${change.currentRef} -> ${change.upstreamRef}\n`);
}
for (const diagnostic of report.diagnostics) process.stdout.write(`warning: ${diagnostic}\n`);
