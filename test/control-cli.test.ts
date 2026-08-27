import { describe, expect, it } from "vitest";
import { parseControlArguments } from "../src/cli/control.js";

describe("vspi control CLI arguments", () => {
  it("keeps a stable send idempotency key separate from selector and prompt", () => {
    expect(parseControlArguments("send", ["session-12", "--idempotency-key", "kimi-turn-7", "check", "this"])).toEqual({
      selector: "session-12",
      value: "check this",
      idempotencyKey: "kimi-turn-7",
    });
  });

  it("distinguishes a wait timeout from a session selector", () => {
    expect(parseControlArguments("wait", ["30000"])).toEqual({ value: "30000" });
    expect(parseControlArguments("wait", ["session-12"])).toEqual({ selector: "session-12" });
  });

  it("rejects a missing idempotency key value", () => {
    expect(() => parseControlArguments("send", ["prompt", "--idempotency-key"])).toThrow("--idempotency-key");
  });
});
