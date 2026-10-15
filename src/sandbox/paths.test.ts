import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, resetState, sandboxState, unlockedPaths } from "./state.js";
import { checkPath, isInsideSandbox, unlockTargetFor } from "./paths.js";

let sandboxDir: string;

beforeEach(() => {
	resetState();
	// Place the sandbox under HOME so no always-allowed prefix (/tmp,
	// /var/folders) covers paths that escape it via ../ traversal.
	sandboxDir = mkdtempSync(join(HOME, ".sandbox-path-tests-"));
	mkdirSync(join(sandboxDir, "sub"), { recursive: true });
	writeFileSync(join(sandboxDir, "file.txt"), "hi");
});

afterEach(() => {
	rmSync(sandboxDir, { recursive: true, force: true });
	resetState();
});

describe("checkPath", () => {
	it("allows paths inside the sandbox", () => {
		expect(checkPath(join(sandboxDir, "file.txt"), sandboxDir)).toEqual({ allowed: true });
	});

	it("allows relative paths that resolve inside the sandbox", () => {
		const result = checkPath("sub/file.txt", sandboxDir);
		expect(result.allowed).toBe(true);
	});

	it("blocks absolute paths outside the sandbox", () => {
		const result = checkPath(HOME, sandboxDir);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("outside the sandbox directory");
		expect(result.resolved).toBe(HOME);
	});

	it("blocks tilde paths outside the sandbox", () => {
		const result = checkPath(`${HOME}/Documents`, sandboxDir);
		expect(result.allowed).toBe(false);
	});

	it("allows paths under the always-allowed ~/.pi prefix", () => {
		expect(checkPath(`${HOME}/.pi/settings.json`, sandboxDir).allowed).toBe(true);
	});

	it("allows reads but not writes under read-only home entries", () => {
		const p = `${HOME}/.local/share/uv/python/bin/python3`;
		expect(checkPath(p, sandboxDir, "read").allowed).toBe(true);
		expect(checkPath(p, sandboxDir, "write").allowed).toBe(false);
		expect(checkPath(p, sandboxDir).allowed).toBe(false);
	});

	it("allows paths under the always-allowed ~/.agents prefix", () => {
		expect(checkPath(`${HOME}/.agents/skills`, sandboxDir).allowed).toBe(true);
	});

	it("allows /tmp paths via the prefix allow list", () => {
		expect(checkPath(`/tmp/some-cache-file`, sandboxDir).allowed).toBe(true);
	});

	it("allows an explicitly unlocked path", () => {
		unlockedPaths.add(HOME);
		expect(checkPath(HOME, sandboxDir).allowed).toBe(true);
	});

	it("blocks traversal that escapes via .. segments", () => {
		const result = checkPath("../elsewhere", sandboxDir);
		expect(result.allowed).toBe(false);
	});
});

describe("isInsideSandbox", () => {
	it("returns true inside, false outside", () => {
		expect(isInsideSandbox(join(sandboxDir, "x"), sandboxDir)).toBe(true);
		expect(isInsideSandbox(HOME, sandboxDir)).toBe(false);
	});

	it("returns the parent directory for a blocked file", () => {
		expect(unlockTargetFor(join(sandboxDir, "file.txt"))).toBe(sandboxDir);
	});

	it("returns the parent directory for a path that no longer exists", () => {
		expect(unlockTargetFor(join(sandboxDir, "sub", "missing.txt"))).toBe(join(sandboxDir, "sub"));
	});

	it("lets checkPath reach a file after unlocking its parent directory", () => {
		const fileName = join(HOME, `.sandbox-unlock-probe-${Date.now()}`);
		writeFileSync(fileName, "x");
		try {
			unlockedPaths.add(unlockTargetFor(fileName));
			expect(checkPath(fileName, sandboxDir).allowed).toBe(true);
		} finally {
			rmSync(fileName, { force: true });
		}
	});
});


