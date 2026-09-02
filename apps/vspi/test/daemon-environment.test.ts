import { describe, expect, it } from "vitest";

import {
	daemonEnvironment,
	parseDaemonHomeDir,
} from "../src/daemon-environment.js";

describe("VSPi daemon environment", () => {
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
