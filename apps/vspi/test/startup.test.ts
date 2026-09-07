import { describe, expect, it, vi } from "vitest";
import { shutdownInteractiveSession } from "../src/v1/app/startup.js";
import { VspiApp } from "../src/v1/app/vspi-app.js";
import { resolveCommand } from "../src/v1/domain/commands.js";

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

	it("detaches by default without cancelling active work", async () => {
		const cancel = vi.fn(async () => undefined);
		const disposeBackend = vi.fn(async () => undefined);
		const disposeAttachments = vi.fn(async () => undefined);
		const app = createDisposableApp({
			cancel,
			disposeBackend,
			disposeAttachments,
		});

		await app.dispose();

		expect(cancel).not.toHaveBeenCalled();
		expect(disposeAttachments).toHaveBeenCalledOnce();
		expect(disposeBackend).toHaveBeenCalledOnce();
	});

	it("cancels active work only for explicit cancel-and-exit", async () => {
		const cancel = vi.fn(async () => undefined);
		const app = createDisposableApp({ cancel });

		await app.dispose("cancel");

		expect(cancel).toHaveBeenCalledOnce();
	});

	it("routes quit and cancel-and-exit to distinct shutdown modes", async () => {
		const onExit = vi.fn();
		const app = Object.assign(Object.create(VspiApp.prototype), {
			planPanelExplicit: false,
			options: { onExit },
		}) as {
			executeEnabledAction(
				action: NonNullable<ReturnType<typeof resolveCommand>>,
				raw: string,
			): Promise<void>;
		};
		const quit = resolveCommand("/quit");
		const cancelAndExit = resolveCommand("/cancel-and-exit");
		if (!quit || !cancelAndExit) throw new Error("Exit commands must resolve");

		await app.executeEnabledAction(quit, quit.label);
		await app.executeEnabledAction(cancelAndExit, cancelAndExit.label);

		expect(onExit).toHaveBeenNthCalledWith(1, "detach");
		expect(onExit).toHaveBeenNthCalledWith(2, "cancel");
	});
});

function createDisposableApp(options: {
	cancel: () => Promise<void>;
	disposeBackend?: () => Promise<void>;
	disposeAttachments?: () => Promise<void>;
}): VspiApp & { dispose(mode?: "detach" | "cancel"): Promise<void> } {
	return Object.assign(Object.create(VspiApp.prototype), {
		disposing: false,
		renderReady: true,
		yoloAcknowledgementBroker: { cancel: vi.fn() },
		queuedPresentations: new Map(),
		queuedAnimationTick: 0,
		disposeAgentConversation: vi.fn(),
		thinkingTranslationRevision: 0,
		cancelPendingQuestion: vi.fn(),
		cancelPendingApproval: vi.fn(),
		activityActive: () => true,
		options: {
			settings: { summarizeSessionTitleOnExit: false },
			attachments: { dispose: options.disposeAttachments ?? vi.fn() },
		},
		backend: {
			cancel: options.cancel,
			dispose: options.disposeBackend ?? vi.fn(),
		},
	});
}
