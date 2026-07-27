import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const LEGACY_REFERENCE_TYPE = "vspi.external-session-reference";

/** Prevent v0.3.3/v0.3.4 reference blobs from reaching any provider request. */
export function createExternalImportCompatibilityExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("context", (event) => ({
      messages: event.messages.filter(
        (message) => !(message.role === "custom" && message.customType === LEGACY_REFERENCE_TYPE),
      ),
    }));
  };
}
