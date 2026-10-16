import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBanner, statusLine } from "./display.js";
import { registerAllowedPath } from "./registry.js";
import { extensionPaths, resetState } from "./state.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

describe("statusLine", () => {
	it("reports the extension path count", () => {
		resetState();
		expect(statusLine()).toContain("extension: 0");
		registerAllowedPath(makeTempDir("sbx-display-"));
		expect(statusLine()).toContain("extension: 1");
		resetState();
		expect(extensionPaths.size).toBe(0);
	});
});

describe("buildBanner", () => {
	it("lists extension paths", () => {
		resetState();
		const dir = makeTempDir("sbx-display-");
		registerAllowedPath(dir);
		const banner = buildBanner(tmpdir(), null, null);
		expect(banner).toContain("Extension paths (1):");
		expect(banner).toContain(dir);
		resetState();
	});
});
