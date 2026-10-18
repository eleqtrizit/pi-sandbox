import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBanner, statusLine } from "./display.js";
import { registerAllowedPath } from "./registry.js";
import { blockedHistory, resetState, sandboxState } from "./state.js";

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
	it("shows enabled with no blocked suffix when nothing is blocked", () => {
		resetState();
		expect(statusLine()).toBe("🛡 sandbox enabled.");
	});

	it("shows the last blocked path when one is recorded", () => {
		resetState();
		blockedHistory.push({
			path: "/home/u/proj/secret",
			original: "~/proj/secret",
			tool: "read",
			timestamp: Date.now(),
		});
		expect(statusLine()).toBe("🛡 sandbox enabled. /home/u/proj/secret blocked");
		resetState();
	});

	it("shows DISABLED when unlocked", () => {
		resetState();
		sandboxState.locked = false;
		expect(statusLine()).toBe("🛡 sandbox DISABLED");
		resetState();
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
