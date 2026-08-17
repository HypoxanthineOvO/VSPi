import { writeFileSync } from "node:fs";
import { renderCacheSimulationMarkdown } from "../src/domain/cache-simulation.js";

const output = new URL("../.pipeline/cycles/C17-prompt-cache-deepseek-adaptation/CACHE-SIMULATION.md", import.meta.url);
writeFileSync(output, renderCacheSimulationMarkdown());
process.stdout.write(`${output.pathname}\n`);
