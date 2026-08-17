import { describe, expect, it } from "vitest";
import { deepSeekHarnessEnabled } from "../src/config/deepseek-harness.js";

describe("DeepSeek harness startup configuration", () => {
  it.each([
    [{}, true],
    [{ VSPI_DEEPSEEK_HARNESS: "1" }, true],
    [{ VSPI_DEEPSEEK_HARNESS: "true" }, true],
    [{ VSPI_DEEPSEEK_HARNESS: "0" }, false],
    [{ VSPI_DEEPSEEK_HARNESS: " FALSE " }, false],
    [{ VSPI_DEEPSEEK_HARNESS: "off" }, false],
  ] as const)("resolves %j to %s", (env, expected) => {
    expect(deepSeekHarnessEnabled(env)).toBe(expected);
  });
});
