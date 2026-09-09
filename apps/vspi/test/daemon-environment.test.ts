import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { connectRuntime, stopRuntime } from "@vsp/vsp-runtime";

import {
	daemonEnvironment,
	prepareDaemonEnvironment,
	parseDaemonHomeDir,
} from "../src/daemon-environment.js";

describe("VSPi daemon environment", () => {
	it.skipIf(!process.env.VSPI_PACKAGE_SMOKE_ENTRY || process.platform === "win32")("uses its own CLI and home for Bash calls in the actual packaged daemon", async () => {
		const entry = process.env.VSPI_PACKAGE_SMOKE_ENTRY!;
		const root = await mkdtemp(join(tmpdir(), "vspi-packaged-cli-"));
		const home = join(root, "home");
		const cwd = join(root, "project");
		const oldBin = join(root, "old-bin");
		const marker = join(root, "old-cli-ran");
		let connection: Awaited<ReturnType<typeof connectRuntime>> | undefined;
		try {
			await mkdir(join(cwd, ".git"), { recursive: true });
			await mkdir(oldBin);
			await writeFile(join(oldBin, "vspi"), `#!/bin/sh\necho old > '${marker}'\nexit 91\n`, { mode: 0o700 });
			await promisify(execFile)(process.execPath, [entry, "daemon", "start"], {
				cwd, timeout: 30_000,
				env: { ...process.env, HOME: join(root, "os-home"), VSPI_HOME: home, PATH: `${oldBin}${delimiter}${process.env.PATH ?? ""}` },
			});
			connection = await connectRuntime(home);
			const session = await connection.klient.global.sessions.create({ workDir: cwd, title: "Packaged CLI identity" });
			const result = await connection.klient.session(session.id).agent("main").runShellCommand({ command: "vspi inspect paths" });
			expect(result.isError).toBe(false);
			expect(JSON.parse(result.stdout)).toMatchObject({ homeDir: home, pid: connection.state.pid });
			expect(await access(marker).then(() => true, () => false)).toBe(false);
		} finally {
			await connection?.close();
			await stopRuntime(home).catch(() => {});
			await rm(root, { recursive: true, force: true });
		}
	}, 45_000);

	it.skipIf(process.platform === "win32")("pins nested vspi calls even when an older executable precedes the normal PATH", async () => {
		const home = await mkdtemp(join(tmpdir(), "vspi-cli-pin-"));
		try {
			const oldBin = join(home, "old-bin");
			await mkdir(oldBin);
			await writeFile(join(oldBin, "vspi"), "#!/bin/sh\necho OLD_VERSION\n", { mode: 0o700 });
			const entry = join(home, "current's entry.mjs");
			await writeFile(entry, "console.log(JSON.stringify({args: process.argv.slice(2), home: process.env.VSPI_HOME}))");
			const source = { ...process.env, PATH: `${oldBin}${delimiter}${process.env.PATH ?? ""}`, VSPI_HOME: home };
			const environment = await prepareDaemonEnvironment(source, { homeDir: home, entryPath: entry, nodePath: process.execPath });
			const { stdout } = await promisify(execFile)("vspi", ["inspect", "argument with spaces", "literal'quote"], { env: environment });
			expect(JSON.parse(stdout)).toEqual({ args: ["inspect", "argument with spaces", "literal'quote"], home });
			const explicitHome = join(home, "other");
			const explicit = await promisify(execFile)("vspi", ["inspect"], { env: { ...environment, VSPI_HOME: explicitHome } });
			expect(JSON.parse(explicit.stdout).home).toBe(explicitHome);
			expect(source.PATH.startsWith(oldBin)).toBe(true);
			expect(environment.VSPI_HOME).toBeUndefined();
		} finally { await rm(home, { recursive: true, force: true }); }
	});
	it("removes VSPI_HOME without mutating the source environment", () => {
		const environment = {
			HOME: "/home/example",
			PATH: "/bin",
			VSPI_HOME: "/tmp/vspi-alpha",
		};

		expect(daemonEnvironment(environment)).toEqual({
			HOME: "/home/example",
			PATH: "/bin",
		});
		expect(environment.VSPI_HOME).toBe("/tmp/vspi-alpha");
	});
});

describe("VSPi daemon arguments", () => {
	it("returns the explicit daemon home", () => {
		expect(
			parseDaemonHomeDir(["serve", "--home-dir", "/tmp/vspi-alpha"]),
		).toBe("/tmp/vspi-alpha");
	});

	it("uses the default home when the hidden argument is absent", () => {
		expect(parseDaemonHomeDir(["status"])).toBeUndefined();
	});

	it("rejects a missing home value", () => {
		expect(() => parseDaemonHomeDir(["serve", "--home-dir"])).toThrow(
			"Missing value for --home-dir",
		);
	});
});
