import type { Klient, OAuthFlowSnapshot } from "@moonshot-ai/klient";
import type { ProviderAuthInteraction } from "../backend/types.js";

export async function loginWithOAuth(
	auth: Klient["global"]["auth"],
	providerId: string,
	interaction: ProviderAuthInteraction,
): Promise<void> {
	const controller = new AbortController();
	const signal = interaction.signal
		? AbortSignal.any([controller.signal, interaction.signal])
		: controller.signal;
	let completed = false;
	let currentPrompt: { id: string; controller: AbortController } | undefined;
	let answer: { promptId: string; value: string } | undefined;
	let promptError: unknown;
	let authorization = "";
	const notify = (flow: OAuthFlowSnapshot) => {
		if (flow.auth_url && authorization !== flow.auth_url) {
			authorization = flow.auth_url;
			interaction.notify({ type: "auth_url", url: flow.auth_url, instructions: flow.instructions });
		} else if (flow.user_code && authorization !== flow.verification_uri_complete) {
			authorization = flow.verification_uri_complete;
			interaction.notify({
				type: "device_code", verificationUri: flow.verification_uri_complete,
				userCode: flow.user_code, intervalSeconds: flow.interval, expiresInSeconds: flow.expires_in,
			});
		}
		const prompt = flow.prompt;
		if (!prompt) {
			currentPrompt?.controller.abort();
			currentPrompt = undefined;
			answer = undefined;
			return;
		}
		if (currentPrompt?.id === prompt.id) return;
		currentPrompt?.controller.abort();
		answer = undefined;
		const promptController = new AbortController();
		currentPrompt = { id: prompt.id, controller: promptController };
		const promptSignal = AbortSignal.any([signal, promptController.signal]);
		const pending = interaction.prompt(prompt.options
			? { type: "select", message: prompt.message, options: prompt.options, signal: promptSignal }
			: { type: "secret", message: prompt.message, placeholder: prompt.placeholder, allowEmpty: prompt.allow_empty, signal: promptSignal });
		void pending.then(
			(value) => { if (!promptSignal.aborted) answer = { promptId: prompt.id, value }; },
			(error) => { if (!promptSignal.aborted) promptError = error; },
		);
	};
	try {
		signal.throwIfAborted();
		const started = await abortable(auth.startLogin(providerId), signal);
		if (started.status === "authenticated") {
			completed = true;
			return;
		}
		notify(started);
		const deadline = Date.parse(started.expires_at);
		while (true) {
			signal.throwIfAborted();
			const flow = await abortable(auth.flow(providerId), signal);
			if (flow?.flow_id !== started.flow_id) throw new Error("OAuth 登录已失效，请重新登录");
			if (flow.status === "authenticated") {
				completed = true;
				return;
			}
			if (flow.status !== "pending") throw new Error(flow.error_message ?? `OAuth ${flow.status}`);
			if (Date.now() >= deadline) throw new Error("OAuth 登录已超时，请重新登录");
			if (promptError !== undefined) throw promptError instanceof Error ? promptError : new Error("OAuth input failed", { cause: promptError });
			notify(flow);
			if (answer !== undefined) {
				const submitted = answer;
				answer = undefined;
				try {
					await abortable(auth.submitLogin(providerId, flow.flow_id, submitted.promptId, submitted.value), signal);
				} catch (error) {
					if (!signal.aborted && (await auth.flow(providerId))?.status === "authenticated") {
						completed = true;
						return;
					}
					throw error;
				}
			}
			await delay(Math.min(1_000, Math.max(250, flow.interval * 1_000)), signal);
		}
	} finally {
		currentPrompt?.controller.abort();
		controller.abort();
		if (!completed) await auth.cancelLogin(providerId);
	}
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	let abort: (() => void) | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				abort = () => reject(new Error("Login cancelled"));
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			}),
		]);
	} finally {
		if (abort) signal.removeEventListener("abort", abort);
	}
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer);
			reject(new Error("Login cancelled"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}
