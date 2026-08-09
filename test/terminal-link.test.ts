import { describe, expect, it } from "vitest";
import { isOpenableTerminalUrl } from "../src/ui/terminal-link.js";

describe("terminal Markdown links", () => {
  it("allows web links and rejects executable or malformed targets", () => {
    expect(isOpenableTerminalUrl("https://example.com/docs?q=fullscreen")).toBe(true);
    expect(isOpenableTerminalUrl("http://127.0.0.1:3000/path")).toBe(true);
    expect(isOpenableTerminalUrl("file:///etc/passwd")).toBe(false);
    expect(isOpenableTerminalUrl("javascript:alert(1)")).toBe(false);
    expect(isOpenableTerminalUrl("not a url")).toBe(false);
    expect(isOpenableTerminalUrl(`https://example.com/${"x".repeat(8_192)}`)).toBe(false);
  });
});
