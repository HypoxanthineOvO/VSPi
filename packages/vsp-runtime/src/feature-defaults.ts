import type { ConfigEffectiveOverlay } from "@moonshot-ai/agent-core-v2/app/config/config";
import { registerConfigOverlay } from "@moonshot-ai/agent-core-v2/app/config/configOverlayContributions";

export const VSP_EXPERIMENTAL_DEFAULTS = {
	wait_for: true,
	persistence_minidb_readmodel: true,
	"secondary-model": true,
	subagent_fork: true,
	"tool-select": true,
	tower: true,
	"remote-control": true,
	auto_session_title: true,
} as const;

const vspFeatureDefaultsOverlay: ConfigEffectiveOverlay = {
	apply(effective, _getEnv, validate) {
		const existing = record(effective["experimental"]);
		effective["experimental"] = validate("experimental", {
			...VSP_EXPERIMENTAL_DEFAULTS,
			...existing,
		});
		effective["builtinProductSkills"] = validate("builtinProductSkills", false);
		effective["defaultPermissionMode"] = validate(
			"defaultPermissionMode",
			effective["defaultPermissionMode"] ?? "auto",
		);
		return ["experimental", "builtinProductSkills", "defaultPermissionMode"];
	},
};

registerConfigOverlay(vspFeatureDefaultsOverlay);

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
