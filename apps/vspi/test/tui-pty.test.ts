import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../packages/pi-tui/test/virtual-terminal.js";

interface Pty {
	onData(listener: (data: string) => void): { dispose(): void };
	onExit(listener: () => void): { dispose(): void };
	write(data: string | Buffer): void;
	pause(): void;
	resume(): void;
	kill(): void;
}
interface Report {
	sequence: number;
	inputs: number;
	inputMs: number;
	maximumInputMs: number;
	partialSurrogates: number;
	writes: number;
	bytes: number;
	deferred: number;
	pressured: boolean;
	revision: number;
	characters: number;
	hash: string;
	tty: boolean;
}
const require = createRequire(
	new URL("../../../packages/agent-core-v2/package.json", import.meta.url),
);
const pty = require("node-pty") as {
	spawn(
		file: string,
		args: string[],
		options: {
			cwd: string;
			cols: number;
			rows: number;
			env: NodeJS.ProcessEnv;
		},
	): Pty;
};
const root = resolve(import.meta.dirname, "../../..");
const cleanups: (() => Promise<void>)[] = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
	const home = await mkdtemp(join(tmpdir(), "vspi-real-pty-"));
	const reportPath = join(home, "report.json");
	const terminal = new VirtualTerminal(100, 30, 20000);
	let output = "";
	let exited = false;
	const child = pty.spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			"--import",
			"./build/register-raw-text-loader.mjs",
			"./apps/vspi/test/fixtures/tui-pty.ts",
			home,
			reportPath,
		],
		{
			cwd: root,
			cols: 100,
			rows: 30,
			env: {
				...process.env,
				TERM: "xterm-256color",
				VSPI_HOME: home,
				VSPI_FRAME_STATS: "",
			},
		},
	);
	const data = child.onData((chunk) => {
		output += chunk;
		terminal.write(chunk);
	});
	const exit = child.onExit(() => {
		exited = true;
	});
	cleanups.push(async () => {
		try {
			if (!exited) {
				child.resume();
				child.write("\u001B[94~");
				await vi.waitFor(
					() => {
						expect(exited).toBe(true);
					},
					{ timeout: 3000, interval: 25 },
				);
			}
		} finally {
			if (!exited) child.kill();
			data.dispose();
			exit.dispose();
			await rm(home, { recursive: true, force: true });
		}
	});
	const report = async () =>
		JSON.parse(await readFile(reportPath, "utf8")) as Report;
	await vi.waitFor(
		() => {
			expect(output, output.slice(-2000)).toContain("PTY_HISTORY_199");
		},
		{ timeout: 15000, interval: 25 },
	);
	child.write("\u001B[?0u\u001B[?1;2c");
	await new Promise((resolve) => {
		setTimeout(resolve, 300);
	});
	async function checkpoint() {
		const previous = await report();
		child.write("\u001B[90~");
		await vi.waitFor(
			async () => {
				expect((await report()).sequence).toBeGreaterThan(previous.sequence);
			},
			{ timeout: 10000, interval: 20 },
		);
		await terminal.flush();
		return report();
	}
	return { child, terminal, report, checkpoint, output: () => output };
}

describe.runIf(process.platform !== "win32")(
	"real PTY input and native history pressure",
	() => {
		it("keeps stable-size history unique through real dictation, Agent updates, fragmented paste, idle and drain", async () => {
			const f = await fixture();
			const baseline = await f.checkpoint();
			expect(baseline.tty).toBe(true);
			const idleOutput = f.output().length;
			await new Promise((resolve) => {
				setTimeout(resolve, 250);
			});
			expect(f.output().length).toBe(idleOutput);
			f.child.write("\u001B[91~");
			const draft = "草稿".repeat(20000);
			await vi.waitFor(
				async () => {
					expect((await f.report()).hash).toBe(hash(draft));
				},
				{ timeout: 5000, interval: 20 },
			);
			const voice = "语".repeat(600) + "👨‍👩‍👧‍👦";
			expect(voice.length).toBe(611);
			const started = performance.now();
			f.child.write(voice);
			let expected = draft + voice;
			await vi.waitFor(
				async () => {
					expect((await f.checkpoint()).hash).toBe(hash(expected));
				},
				{ timeout: 15000, interval: 25 },
			);
			const dictationMs = performance.now() - started;
			for (let revision = 1; revision <= 8; revision++) {
				f.child.write("\u001B[92~");
				await vi.waitFor(
					() => {
						expect(f.output()).toContain(
							`PTY_STREAM_${String(revision).padStart(3, "0")}`,
						);
					},
					{ timeout: 10000, interval: 20 },
				);
			}
			for (const byte of Buffer.from("🙂")) {
				f.child.write(Buffer.from([byte]));
				await new Promise((resolve) => {
					setTimeout(resolve, 2);
				});
			}
			expected += "🙂";
			f.child.write("x\u007F");
			await vi.waitFor(
				async () => {
					expect((await f.checkpoint()).hash).toBe(hash(expected));
				},
				{ timeout: 10000, interval: 25 },
			);
			const paste = "分片粘贴🙂\n".repeat(150);
			for (const fragment of [
				"\u001B[20",
				"0~",
				paste.slice(0, 1001),
				paste.slice(1001),
				"\u001B[20",
				"1~",
			]) {
				f.child.write(fragment);
				await new Promise((resolve) => {
					setTimeout(resolve, 2);
				});
			}
			expected += paste;
			await vi.waitFor(
				async () => {
					expect((await f.checkpoint()).hash).toBe(hash(expected));
				},
				{ timeout: 10000, interval: 25 },
			);
			f.child.pause();
			f.child.write("\u001B[93~");
			await vi.waitFor(
				async () => {
					expect((await f.report()).pressured).toBe(true);
				},
				{ timeout: 5000, interval: 20 },
			);
			f.child.resume();
			await vi.waitFor(
				() => {
					expect(f.output()).toContain("PTY_DRAIN_RESUMED");
				},
				{ timeout: 10000, interval: 25 },
			);
			const final = await f.checkpoint();
			expect(final.deferred).toBeGreaterThan(0);
			expect(final.hash).toBe(hash(expected));
			expect(final.characters).toBe(expected.length);
			expect(final.partialSurrogates).toBe(0);
			expect(f.output()).not.toMatch(/\u001B\[(?:2|3)J/u);
			await f.terminal.flush();
			const history = f.terminal.getScrollBuffer().join("\n");
			const counts = new Map<string, number>();
			for (const match of history.matchAll(/PTY_HISTORY_\d{3}/gu))
				counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
			expect(counts.size).toBe(200);
			expect([...counts.values()].every((count) => count === 1)).toBe(true);
			const settled = await f.checkpoint();
			const settledOutput = f.output().length;
			await new Promise((resolve) => {
				setTimeout(resolve, 300);
			});
			expect((await f.checkpoint()).writes).toBe(settled.writes);
			expect(f.output().length).toBe(settledOutput);
			if (process.env.VSPI_PRESSURE_REPORT) {
				const { appendFile } = await import("node:fs/promises");
				await appendFile(
					process.env.VSPI_PRESSURE_REPORT,
					`${JSON.stringify({ name: "real-pty-fixed-size", dictationCharacters: voice.length, dictationCodePoints: Array.from(voice).length, dictationMs, inputCallbacks: final.inputs, totalInputMs: final.inputMs, maximumInputMs: final.maximumInputMs, deferredFrames: final.deferred, uniqueHistoryRows: counts.size })}\n`,
				);
			}
		}, 45000);
	},
);
