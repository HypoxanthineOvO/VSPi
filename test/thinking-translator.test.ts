import { describe, expect, it, vi } from "vitest";
import { HttpThinkingTranslator, normalizeTranslationEndpoint } from "../src/translation/thinking-translator.js";

describe("Thinking translation service", () => {
  it("normalizes local hosts and domains while rejecting unsafe URL forms", () => {
    expect(normalizeTranslationEndpoint("127.0.0.1:5000")).toBe("http://127.0.0.1:5000/translate");
    expect(normalizeTranslationEndpoint("https://translate.example.test/api")).toBe(
      "https://translate.example.test/api",
    );
    expect(() => normalizeTranslationEndpoint("file:///etc/passwd")).toThrow(/HTTP/);
    expect(() => normalizeTranslationEndpoint("http://user:secret@localhost:5000")).toThrow(/用户名或密码/);
  });

  it("posts the generic contract and accepts a translatedText response", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ translatedText: "正在检查相关代码。" }, { headers: { "content-length": "48" } }),
    );
    const translator = new HttpThinkingTranslator(request);

    await expect(translator.translate("Inspecting the relevant code.", "localhost:5000")).resolves.toBe(
      "正在检查相关代码。",
    );
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe("http://localhost:5000/translate");
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      text: "Inspecting the relevant code.",
      source: "auto",
      target: "zh-CN",
    });
  });

  it("falls back to the LibreTranslate request contract only for format errors", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("bad format", { status: 422 }))
      .mockResolvedValueOnce(Response.json({ translatedText: "译文" }));
    const translator = new HttpThinkingTranslator(request);

    await expect(translator.translate("source", "http://localhost:5000/translate")).resolves.toBe("译文");
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual({
      q: "source",
      source: "auto",
      target: "zh",
      format: "text",
    });
  });

  it("rejects oversized responses without retrying the request", async () => {
    const request = vi.fn<typeof fetch>(
      async () => new Response("ignored", { headers: { "content-length": String(1024 * 1024 + 1) } }),
    );
    const translator = new HttpThinkingTranslator(request);

    await expect(translator.translate("source", "localhost:5000")).rejects.toThrow(/1 MiB/);
    expect(request).toHaveBeenCalledOnce();
  });
});
