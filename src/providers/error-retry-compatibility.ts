import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";

const TRANSIENT_PROVIDER_ERRORS = new Set(["stream_read_error", "upstream_error: Upstream request failed"]);
type MessageEndReplacement = { message: AgentSession["messages"][number] };

/**
 * Some OpenAI-compatible gateways omit the HTTP status from transient failures. Pi's bounded
 * retry classifier cannot recognize those generic messages, so retain the original detail while
 * supplying the missing 503 signal before Pi makes its retry decision.
 */
export function normalizeTransientProviderError(errorMessage: string | undefined): string | undefined {
  const normalized = errorMessage?.trim();
  if (!normalized || !TRANSIENT_PROVIDER_ERRORS.has(normalized)) return errorMessage;
  return `503: ${normalized}`;
}

export function createProviderErrorRetryCompatibilityExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("message_end", (event): MessageEndReplacement | undefined => {
      const message = event.message;
      if (message.role !== "assistant" || message.stopReason !== "error") return undefined;
      const errorMessage = normalizeTransientProviderError(message.errorMessage);
      if (errorMessage === undefined || errorMessage === message.errorMessage) return undefined;
      return { message: { ...message, errorMessage } };
    });
  };
}
