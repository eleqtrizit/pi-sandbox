import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	BLOCKED_HISTORY_MAX,
	blockedHistory,
	extensionPaths,
	markSymlinkScan,
	recordBlocked,
	resetState,
	sandboxState,
	symlinkTargets,
	unlockedPaths,
} from "./state.js";

const identity = (p: string) => p;

beforeEach(() => resetState());

describe("recordBlocked", () => {
	it("appends a new entry", () => {
		recordBlocked("/a", "/a", "read", identity);
		expect(blockedHistory).toHaveLength(1);
		expect(blockedHistory[0]).toMatchObject({ path: "/a", original: "/a", tool: "read" });
	});

	it("moves a repeat block to the end instead of duplicating", () => {
		recordBlocked("/a", "/a", "read", identity);
		recordBlocked("/b", "/b", "bash", identity);
		recordBlocked("/a", "/a", "read", identity);
		expect(blockedHistory.map((e) => e.path)).toEqual(["/b", "/a"]);
	});

	it("evicts the oldest entry when the buffer is full", () => {
		for (let i = 0; i < BLOCKED_HISTORY_MAX + 1; i++) {
			recordBlocked(`/p/${i}`, `/p/${i}`, "read", identity);
		}
		expect(blockedHistory).toHaveLength(BLOCKED_HISTORY_MAX);
		expect(blockedHistory[0].path).toBe("/p/1");
	});

	it("matches repeats after realpath resolution", () => {
		recordBlocked("/link/a", "/real/a", "read", identity);
		recordBlocked("/real/a", "/real/a", "read", identity);
		expect(blockedHistory).toHaveLength(1);
		expect(blockedHistory[0].path).toBe("/real/a");
	});
});

describe("resetState", () => {
	it("restores all mutable state to defaults", () => {
		sandboxState.locked = false;
		symlinkTargets.add("/elsewhere");
		unlockedPaths.add("/unlocked");
		markSymlinkScan(1234);
		recordBlocked("/a", "/a", "read", identity);

		resetState();

		expect(sandboxState.locked).toBe(true);
		expect(symlinkTargets.size).toBe(0);
		expect(unlockedPaths.size).toBe(0);
		expect(blockedHistory).toHaveLength(0);
	});
});

describe("extensionPaths sharing", () => {
	it("shares one Set across fresh module copies, as with jiti moduleCache: false", async () => {
		extensionPaths.add("/shared/dir");

		vi.resetModules();
		const copy2 = await import("./state.js");

		expect(copy2.extensionPaths).toBe(extensionPaths);
		expect(copy2.extensionPaths.has("/shared/dir")).toBe(true);
	});
});
