import { readFile } from "node:fs/promises";

export interface HarnessSource {
  family: string;
  sourceUrl: string;
  ref: { type: "commit" | "tag"; value: string };
  licensePolicy: string;
  applicableModels: string[];
  extractionPath: string;
  rewriteRationale: string;
  evaluation: { status: "unreviewed" | "reviewed" | "verified"; notes: string };
  lastReviewed: string;
}

export async function checkHarnessSources(options: {
  manifestPath: string;
  resolveUpstreamRef(source: HarnessSource): Promise<string>;
}): Promise<{
  checked: number;
  changes: Array<{ family: string; currentRef: string; upstreamRef: string; sourceUrl: string }>;
  diagnostics: string[];
}> {
  const manifest = JSON.parse(await readFile(options.manifestPath, "utf8")) as {
    schemaVersion?: unknown;
    source?: unknown;
    sources?: unknown;
  };
  if (manifest.schemaVersion !== 1 || manifest.source !== "vspi.harness-sources" || !Array.isArray(manifest.sources)) {
    throw new Error("Harness manifest schemaVersion/source/sources is invalid");
  }
  const sources = manifest.sources.map(validateSource);
  const changes: Array<{ family: string; currentRef: string; upstreamRef: string; sourceUrl: string }> = [];
  const diagnostics: string[] = [];
  const results = await Promise.all(
    sources.map(async (source) => {
      try {
        const upstreamRef = await options.resolveUpstreamRef(structuredClone(source));
        return upstreamRef === source.ref.value
          ? {}
          : {
              change: {
                family: source.family,
                currentRef: source.ref.value,
                upstreamRef,
                sourceUrl: source.sourceUrl,
              },
            };
      } catch (error) {
        return {
          diagnostic: `${source.family}: ${error instanceof Error ? error.message : "upstream check failed"}`,
        };
      }
    }),
  );
  for (const result of results) {
    if (result.change) changes.push(result.change);
    if (result.diagnostic) diagnostics.push(result.diagnostic);
  }
  return { checked: sources.length, changes, diagnostics };
}

function validateSource(value: unknown, index: number): HarnessSource {
  if (!value || typeof value !== "object") throw new Error(`Harness source ${index} is invalid`);
  const source = value as Partial<HarnessSource>;
  if (
    typeof source.family !== "string" ||
    typeof source.sourceUrl !== "string" ||
    !source.ref ||
    (source.ref.type !== "commit" && source.ref.type !== "tag") ||
    typeof source.ref.value !== "string"
  ) {
    throw new Error(`Harness source ${index} identity/ref is invalid`);
  }
  return structuredClone(source as HarnessSource);
}
