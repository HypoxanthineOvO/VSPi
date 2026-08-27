import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGrepToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createVspiGrepToolDefinition } from "../src/tools/grep.js";

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "vspi-grep-"));
  await mkdir(join(root, "src"));
  return root;
}

async function execute(root: string, input: Record<string, unknown>, signal?: AbortSignal) {
  return createVspiGrepToolDefinition(root).execute("grep-test", input as never, signal, undefined, undefined as never);
}

function textOf(result: Awaited<ReturnType<typeof execute>>): string {
  const content = result.content.find((item) => item.type === "text");
  return content?.type === "text" ? content.text : "";
}

describe("VSPi grep", () => {
  it("keeps Pi's public definition contract", async () => {
    const root = await workspace();
    const native = createGrepToolDefinition(root);
    const tool = createVspiGrepToolDefinition(root);
    expect(tool).toMatchObject({
      name: native.name,
      label: native.label,
      description: native.description,
      parameters: native.parameters,
    });
  });

  it("supports regex, literal, glob, gitignore, unicode and binary behavior", async () => {
    const root = await workspace();
    await writeFile(join(root, ".gitignore"), "ignored.ts\n");
    await writeFile(join(root, "src", "code.ts"), "alpha.β\nALPHAxβ\n你好 needle\n");
    await writeFile(join(root, "src", "colon:name.ts"), "colon-needle\n");
    await writeFile(join(root, "ignored.ts"), "needle\n");
    await writeFile(join(root, "src", "data.bin"), Buffer.from([0, 110, 101, 101, 100, 108, 101, 0]));

    const regex = await execute(root, { pattern: "alpha.β", path: ".", glob: "*.ts", ignoreCase: true });
    expect(textOf(regex)).toContain("src/code.ts:1: alpha.β");
    expect(textOf(regex)).toContain("src/code.ts:2: ALPHAxβ");
    const literal = await execute(root, { pattern: "alpha.β", path: ".", glob: "*.ts", literal: true });
    expect(textOf(literal)).toContain("src/code.ts:1: alpha.β");
    expect(textOf(literal)).not.toContain("ALPHAxβ");
    const unicode = await execute(root, { pattern: "你好", path: "." });
    expect(textOf(unicode)).toContain("你好 needle");
    expect(textOf(unicode)).not.toContain("ignored.ts");
    const colonPath = await execute(root, { pattern: "colon-needle", path: "src" });
    expect(textOf(colonPath)).toContain("colon:name.ts:1: colon-needle");
    const binary = await execute(root, { pattern: "needle", path: "src/data.bin" });
    expect(textOf(binary)).toBe("No matches found");
  });

  it("gets context from rg and emits explicit match and long-line truncation metadata", async () => {
    const root = await workspace();
    await writeFile(
      join(root, "src", "context.txt"),
      `before\nneedle ${"x".repeat(900)}\nafter\ngap\ngap\nbefore two\nneedle two\nafter two\n`,
    );
    const result = await execute(root, { pattern: "needle", path: "src", context: 1, limit: 1 });
    expect(textOf(result)).toContain("context.txt-1- before");
    expect(textOf(result)).toContain("context.txt:2:");
    expect(textOf(result)).toContain("context.txt-3- after");
    expect(result.details).toMatchObject({ matchLimitReached: 1, linesTruncated: true });
    const groups = await execute(root, { pattern: "needle", path: "src", context: 1, limit: 2 });
    expect(textOf(groups)).toContain("\n--\n");
    expect(textOf(groups)).toContain("context.txt:7: needle two");
  });

  it("enforces its byte budget while streaming", async () => {
    const root = await workspace();
    const rows = Array.from({ length: 300 }, (_, index) => `needle-${index}-${"x".repeat(300)}`).join("\n");
    await writeFile(join(root, "src", "large.txt"), `${rows}\n`);
    const result = await execute(root, { pattern: "needle", path: "src", limit: 1000 });
    expect(result.details?.truncation).toMatchObject({ truncated: true, truncatedBy: "bytes", maxBytes: 50 * 1024 });
    expect(result.details).toMatchObject({
      observedBeforeTermination: { lines: expect.any(Number), bytes: expect.any(Number), complete: false },
    });
    expect(Buffer.byteLength(textOf(result), "utf8")).toBeLessThan(52 * 1024);
  });

  it("rejects cancellation before spawn", async () => {
    const root = await workspace();
    const controller = new AbortController();
    controller.abort();
    await expect(execute(root, { pattern: "needle" }, controller.signal)).rejects.toThrow(/aborted/i);
  });

  it.runIf(process.platform !== "win32")("terminates a running rg process on cancellation", async () => {
    const root = await workspace();
    const bin = join(root, "bin");
    const pidFile = join(root, "rg.pid");
    await mkdir(bin);
    const fakeRg = join(bin, "rg");
    await writeFile(
      fakeRg,
      "#!/bin/sh\nprintf '%s' \"$$\" > \"$VSPI_GREP_TEST_PID\"\ntrap 'exit 0' TERM INT\nwhile :; do :; done\n",
    );
    await chmod(fakeRg, 0o755);

    const oldPath = process.env.PATH;
    const oldPidFile = process.env.VSPI_GREP_TEST_PID;
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    process.env.VSPI_GREP_TEST_PID = pidFile;
    try {
      const controller = new AbortController();
      const running = execute(root, { pattern: "needle" }, controller.signal);
      const pid = Number(await waitForFile(pidFile));
      controller.abort();
      await expect(running).rejects.toThrow(/aborted/i);
      await waitForExit(pid);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldPidFile === undefined) delete process.env.VSPI_GREP_TEST_PID;
      else process.env.VSPI_GREP_TEST_PID = oldPidFile;
    }
  });

  it("surfaces invalid regular expressions", async () => {
    const root = await workspace();
    await expect(execute(root, { pattern: "[" })).rejects.toThrow(/regex parse error|unclosed character class/i);
  });
});

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`rg process ${pid} remained alive after cancellation`);
}
