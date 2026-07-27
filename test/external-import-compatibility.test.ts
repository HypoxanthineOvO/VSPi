import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createExternalImportCompatibilityExtension } from "../src/sessions/import-compatibility.js";

describe("legacy external import compatibility", () => {
  it("removes v0.3.3/v0.3.4 reference blobs before provider requests", async () => {
    let contextHandler: ((event: { messages: unknown[] }) => unknown) | undefined;
    const pi = {
      on(event: string, handler: (event: { messages: unknown[] }) => unknown) {
        if (event === "context") contextHandler = handler;
      },
    };
    (createExternalImportCompatibilityExtension() as ExtensionFactory)(pi as never);
    expect(contextHandler).toBeTypeOf("function");

    const legacy = {
      role: "custom",
      customType: "vspi.external-session-reference",
      content: "x".repeat(30_000_000),
    };
    const user = { role: "user", content: [{ type: "text", text: "continue" }] };
    const result = (await contextHandler?.({ messages: [legacy, user] })) as { messages: unknown[] };

    expect(result.messages).toEqual([user]);
  });
});
