import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBanner, followUpContent, notifyChoiceLabel, statusLine, summarizePaths } from "./display.js";
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

describe("summarizePaths", () => {
	it("joins paths unchanged when the list fits", () => {
		expect(summarizePaths(["~\/a", "~\/b"], 60)).toBe("~\/a, ~\/b");
	});

	it("truncates a long list to the max width with an ellipsis", () => {
		const summary = summarizePaths(["~\/a", "~\/b", "~\/c"], 10);
		expect(summary.length).toBe(10);
		expect(summary.endsWith("…")).toBe(true);
	});

	it("returns a bare ellipsis when even one path cannot fit", () => {
		expect(summarizePaths(["~\/a"], 1)).toBe("…");
	});
});

describe("notifyChoiceLabel", () => {
	it("labels pure unlocks", () => {
		expect(notifyChoiceLabel(["~/a"], [])).toBe("Tell the agent: ~/a have been unlocked");
	});

	it("labels re-locks", () => {
		expect(notifyChoiceLabel([], ["~/a", "~/b"])).toBe("Tell the agent: ~/a, ~/b have been locked again");
	});

	it("labels a combined change without double-telling the verbs", () => {
		expect(notifyChoiceLabel(["~/a"], ["~/b"])).toBe("Tell the agent: unlocked ~/a, locked ~/b");
	});
});

describe("followUpContent", () => {
	it("describes unlocks with full paths", () => {
		expect(followUpContent(["~/a", "~/b"], [])).toBe(
			"The sandbox has unlocked the following directories; everything under them is now allowed: ~/a, ~/b",
		);
	});

	it("describes re-locks with full paths", () => {
		expect(followUpContent([], ["~/a"])).toBe(
			"The sandbox has locked the following directories again; access under them is now blocked: ~/a",
		);
	});

	it("describes both changes in one message", () => {
		expect(followUpContent(["~/a"], ["~/b"])).toBe(
			"The sandbox has unlocked the following directories; everything under them is now allowed: ~/a\n" +
				"The sandbox has locked the following directories again; access under them is now blocked: ~/b",
		);
	});
});
