import { describe, expect, it, vi } from "vitest";
import { shutdownInteractiveSession } from "../src/v1/app/startup.js";
import { VspiApp } from "../src/v1/app/vspi-app.js";

describe("VSPi interactive shutdown", () => {
	it("drains input before stopping the TUI and disposing the app", async () => {
		const events: string[] = [];
		let releaseDrain!: () => void;
		const drainInput = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					releaseDrain = () => {
						events.push("drain-complete");
							resolve();
						};
					}),
		);
		const shutdown = shutdownInteractiveSession({
			prepareShutdown: () => events.push("prepare"),
			drainInput,
			tui: {
				pauseRendering: () => events.push("pause"),
				stop: () => events.push("stop"),
			},
			disposeApp: async () => {
				events.push("dispose");
			},
		});

		expect(events).toEqual(["pause", "prepare"]);
		await Promise.resolve();
		expect(events).toEqual(["pause", "prepare"]);
		releaseDrain();
		await shutdown;

		expect(drainInput).toHaveBeenCalledOnce();
		expect(events).toEqual(["pause", "prepare", "drain-complete", "stop", "dispose"]);
	});

	it("prevents app renders once shutdown is requested", () => {
		const requestRender = vi.fn();
		const app = Object.assign(Object.create(VspiApp.prototype), {
			fullscreenRenderRevision: 0,
			renderReady: true,
			shutdownRequested: false,
			tui: { requestRender },
		}) as {
			requestShutdown(): void;
			requestRender(force?: boolean): void;
		};

		app.requestShutdown();
		app.requestRender();

		expect(requestRender).not.toHaveBeenCalled();
	});
});
