import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "../src/policy/execution-policy.js";
import { createInteractiveApprovalBroker } from "../src/policy/startup-runtime.js";

const REQUEST: ApprovalRequest = {
  action: { kind: "network", category: "ssh", target: "ssh build-host" },
  category: "ssh",
  policy: "Standard",
  requiredPolicy: "YOLO",
};

describe("M1 interactive approval broker", () => {
  it("denies when no UI handler is attached", async () => {
    const broker = createInteractiveApprovalBroker();
    await expect(broker.request(REQUEST)).resolves.toEqual({
      type: "deny",
      reason: "Approval UI is unavailable",
    });
  });

  it("delegates structured requests and preserves all response variants", async () => {
    const broker = createInteractiveApprovalBroker();
    const handler = vi.fn(async () => ({ type: "allow-session" as const, category: "ssh" as const }));
    broker.setHandler(handler);
    await expect(broker.request(REQUEST)).resolves.toEqual({ type: "allow-session", category: "ssh" });
    expect(handler).toHaveBeenCalledWith(REQUEST, undefined);
  });

  it("can detach a closing UI without retaining ambient approval authority", async () => {
    const broker = createInteractiveApprovalBroker();
    broker.setHandler(async () => ({ type: "allow-once" }));
    expect(await broker.request(REQUEST)).toEqual({ type: "allow-once" });
    broker.setHandler(undefined);
    expect(await broker.request(REQUEST)).toMatchObject({ type: "deny" });
  });
});
