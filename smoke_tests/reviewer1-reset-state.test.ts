import { afterEach, expect, it } from "vitest";
import { checkPath } from "../src/sandbox/paths.js";
import { HOME, globalUnlockedPaths, resetState } from "../src/sandbox/state.js";

afterEach(() => {
	globalUnlockedPaths.clear();
	resetState();
});

it("resetState clears global grants so they cannot leak across tests", () => {
	globalUnlockedPaths.clear();
	resetState();
	const sandbox = `${HOME}/.reviewer1-sandbox`;
	expect(checkPath(HOME, sandbox).allowed).toBe(false);
	globalUnlockedPaths.add(HOME);
	resetState();
	// Fixed: resetState clears globalUnlockedPaths alongside extensionPaths.
	expect(globalUnlockedPaths.has(HOME)).toBe(false);
	expect(checkPath(HOME, sandbox).allowed).toBe(false);
});
