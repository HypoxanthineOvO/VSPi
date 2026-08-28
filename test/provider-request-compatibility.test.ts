import { describe, expect, it, vi } from "vitest";
import {
  createProviderErrorRetryCompatibilityExtension,
  normalizeTransientProviderError,
} from "../src/providers/error-retry-compatibility.js";
import {
  createProviderRequestCompatibilityExtension,
  normalizeKimiInstructionRoles,
  sanitizeOpenAiToolSchemaBounds,
} from "../src/providers/request-compatibility.js";

describe("provider request compatibility", () => {
  it("downgrades Kimi developer instructions to the supported system role", () => {
    const payload = {
      model: "k3",
      messages: [
        { role: "developer", content: "coding policy" },
        { role: "user", content: "hello" },
      ],
    };
    expect(normalizeKimiInstructionRoles(payload)).toEqual({
      ...payload,
      messages: [
        { role: "system", content: "coding policy" },
        { role: "user", content: "hello" },
      ],
    });
    expect(normalizeKimiInstructionRoles({ ...payload, messages: [{ role: "system", content: "ok" }] })).toEqual({
      ...payload,
      messages: [{ role: "system", content: "ok" }],
    });
  });

  it("adds a retryable status only to known transient gateway errors", () => {
    expect(normalizeTransientProviderError("stream_read_error")).toBe("503: stream_read_error");
    expect(normalizeTransientProviderError(" upstream_error: Upstream request failed ")).toBe(
      "503: upstream_error: Upstream request failed",
    );
    expect(normalizeTransientProviderError("503: stream_read_error")).toBe("503: stream_read_error");
    expect(normalizeTransientProviderError("OpenAI API error (400): invalid_request_error")).toBe(
      "OpenAI API error (400): invalid_request_error",
    );
    expect(normalizeTransientProviderError("Request aborted")).toBe("Request aborted");
  });

  it("normalizes transient assistant failures before Pi classifies retries", async () => {
    let handler: ((event: { message: unknown }) => unknown) | undefined;
    createProviderErrorRetryCompatibilityExtension()({
      on: vi.fn((event, registered) => {
        if (event === "message_end") handler = registered;
      }),
    } as never);
    const message = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "stream_read_error",
    };

    expect(await handler?.({ message })).toEqual({
      message: { ...message, errorMessage: "503: stream_read_error" },
    });
    expect(
      await handler?.({ message: { ...message, stopReason: "aborted", errorMessage: "Request aborted" } }),
    ).toBeUndefined();
  });

  it("removes only repetition bounds from OpenAI function parameter schemas", () => {
    const payload = {
      model: "local-model",
      tools: [
        {
          type: "function",
          function: {
            name: "plan_update",
            parameters: {
              type: "object",
              properties: {
                title: { type: "string", minLength: 1, maxLength: 2_000 },
                items: {
                  type: "array",
                  minItems: 1,
                  maxItems: 500,
                  items: { type: "string", minLength: 1, maxLength: 500 },
                },
                count: { type: "integer", minimum: 1, maximum: 500 },
              },
              required: ["title", "items"],
              additionalProperties: false,
            },
          },
        },
      ],
    };

    const sanitized = sanitizeOpenAiToolSchemaBounds(payload);
    expect(sanitized).not.toBe(payload);
    expect(JSON.stringify(sanitized)).not.toMatch(/minLength|maxLength|minItems|maxItems/);
    expect(sanitized).toMatchObject({
      tools: [
        {
          function: {
            parameters: {
              properties: { count: { minimum: 1, maximum: 500 } },
              required: ["title", "items"],
              additionalProperties: false,
            },
          },
        },
      ],
    });
    expect(payload.tools[0]?.function.parameters.properties.title.maxLength).toBe(2_000);
  });

  it("keeps payload identity when no OpenAI function schema needs sanitizing", () => {
    const payload = { tools: [{ type: "custom", name: "shell" }] };
    expect(sanitizeOpenAiToolSchemaBounds(payload)).toBe(payload);
  });

  it("applies only to explicitly non-strict OpenAI Completions models", async () => {
    let handler: ((event: { payload: unknown }, context: { model?: unknown }) => unknown) | undefined;
    const on = vi.fn((event, registered) => {
      if (event === "before_provider_request") handler = registered;
    });
    createProviderRequestCompatibilityExtension()({ on } as never);
    const payload = {
      tools: [
        {
          type: "function",
          function: { name: "question", parameters: { type: "string", maxLength: 2_000 } },
        },
      ],
    };

    expect(handler).toBeTypeOf("function");
    expect(
      await handler?.({ payload }, { model: { api: "openai-completions", compat: { supportsStrictMode: false } } }),
    ).not.toBe(payload);
    expect(
      await handler?.({ payload }, { model: { api: "openai-completions", compat: { supportsStrictMode: true } } }),
    ).toBeUndefined();
    expect(await handler?.({ payload }, { model: { api: "openai-responses" } })).toBeUndefined();
  });

  it("normalizes developer roles only for VSPLab Kimi models", async () => {
    let handler: ((event: { payload: unknown }, context: { model?: unknown }) => unknown) | undefined;
    createProviderRequestCompatibilityExtension()({
      on: vi.fn((event, registered) => {
        if (event === "before_provider_request") handler = registered;
      }),
    } as never);
    const payload = { messages: [{ role: "developer", content: "policy" }] };

    expect(
      await handler?.({ payload }, { model: { provider: "vsplab", id: "k3", api: "openai-completions" } }),
    ).toEqual({
      messages: [{ role: "system", content: "policy" }],
    });
    expect(
      await handler?.({ payload }, { model: { provider: "vsplab-open", id: "k3-256k", api: "openai-completions" } }),
    ).toBeUndefined();
    expect(
      await handler?.({ payload }, { model: { provider: "vsplab", id: "gpt-5.6-sol", api: "openai-responses" } }),
    ).toBeUndefined();
    expect(
      await handler?.({ payload }, { model: { provider: "kimi-coding", id: "k3", api: "openai-completions" } }),
    ).toBeUndefined();
  });
});
