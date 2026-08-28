import { describe, expect, it } from "vitest";
import {
  formatLocalDate,
  formatLocalTime,
  formatLocalTimestamp,
  resolveLocalEnvironment,
} from "../src/domain/local-time.js";
import { environmentContext } from "../src/prompts/pi-prompt-profile-extension.js";

describe("local time boundaries", () => {
  it("renders persisted UTC timestamps in the selected local timezone", () => {
    expect(formatLocalTimestamp("2026-08-27T04:15:10.672Z", "Asia/Shanghai")).toBe("2026-08-27 12:15");
    expect(formatLocalTime("2026-08-27T04:15:10.672Z", "Asia/Shanghai")).toBe("12:15:10");
    expect(formatLocalDate("2026-08-26T18:00:00.000Z", "Asia/Shanghai")).toBe("08/27");
  });

  it("keeps invalid persisted timestamps out of the display", () => {
    expect(formatLocalDate("not-a-date", "Asia/Shanghai")).toBeUndefined();
    expect(formatLocalTime("not-a-date", "Asia/Shanghai")).toBeUndefined();
    expect(formatLocalTimestamp("not-a-date", "Asia/Shanghai")).toBeUndefined();
  });

  it("derives the prompt date at the local midnight boundary", () => {
    expect(resolveLocalEnvironment(new Date("2026-08-26T18:00:00.000Z"), "Asia/Shanghai")).toEqual({
      currentDate: "2026-08-27",
      timezone: "Asia/Shanghai",
    });
  });

  it("emits only the stable IANA timezone and excludes date and clock time", () => {
    const context = environmentContext({ currentDate: "2026-08-27", timezone: "Asia/Shanghai" });
    expect(context).toBe(`<environment_context>
  <timezone>Asia/Shanghai</timezone>
</environment_context>`);
    expect(context).not.toContain("current_date");
    expect(context).not.toMatch(/\d{2}:\d{2}/);
  });

  it("adds the current display model without making the prompt depend on the date", () => {
    expect(environmentContext({ currentDate: "2026-08-27", timezone: "Asia/Shanghai" }, "GLM 5.3 Flash")).toBe(
      `<environment_context>\n  <timezone>Asia/Shanghai</timezone>\n  <current_model>GLM 5.3 Flash</current_model>\n</environment_context>`,
    );
    expect(environmentContext({ currentDate: "2026-08-28", timezone: "Asia/Shanghai" }, "GLM 5.3 Flash")).toBe(
      environmentContext({ currentDate: "2026-08-27", timezone: "Asia/Shanghai" }, "GLM 5.3 Flash"),
    );
  });
});
