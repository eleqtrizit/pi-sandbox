import { beforeEach, describe, expect, it } from "vitest";
import {
	BLOCKED_HISTORY_MAX,
	blockedHistory,
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
		sandboxState.symlinkMode = true;
		symlinkTargets.add("/elsewhere");
		unlockedPaths.add("/unlocked");
		markSymlinkScan(1234);
		recordBlocked("/a", "/a", "read", identity);

		resetState();

		expect(sandboxState.locked).toBe(true);
		expect(sandboxState.symlinkMode).toBe(false);
		expect(symlinkTargets.size).toBe(0);
		expect(unlockedPaths.size).toBe(0);
		expect(blockedHistory).toHaveLength(0);
	});
});
