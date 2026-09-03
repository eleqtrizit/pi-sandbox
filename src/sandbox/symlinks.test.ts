import { beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME, resetState, symlinkTargets } from "./state.js";
import { collectSymlinkTargets, walkSymlinks } from "./symlinks.js";

beforeEach(() => resetState());

describe("walkSymlinks", () => {
	it("finds symlinks and skips configured heavy directories", () => {
		const root = mkdtempSync(join(tmpdir(), "symlink-walk-"));
		mkdirSync(join(root, "nested"), { recursive: true });
		mkdirSync(join(root, "node_modules"), { recursive: true });
		const outside = HOME;
		symlinkSync(outside, join(root, "out-link"));
		symlinkSync(outside, join(root, "node_modules", "skipped-link"));
		try {
			const links = walkSymlinks(root);
			expect(links).toContain(join(root, "out-link"));
			expect(links).not.toContain(join(root, "node_modules", "skipped-link"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("is cycle-safe when a symlink points back at the root", () => {
		const root = mkdtempSync(join(tmpdir(), "symlink-cycle-"));
		symlinkSync(root, join(root, "self"));
		try {
			expect(() => walkSymlinks(root)).not.toThrow();
			expect(walkSymlinks(root)).toContain(join(root, "self"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("collectSymlinkTargets", () => {
	it("returns realpath-resolved targets that point outside the sandbox", () => {
		const root = mkdtempSync(join(tmpdir(), "symlink-collect-"));
		mkdirSync(join(root, "sibling"), { recursive: true });
		symlinkSync(HOME, join(root, "out"));
		symlinkSync(join(root, "sibling"), join(root, "inside"));
		symlinkSync("/definitely/broken", join(root, "broken"));
		try {
			const targets = collectSymlinkTargets(root);
			expect(targets).toContain(HOME);
			expect(targets).toHaveLength(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns an empty list when there are no escapes", () => {
		const root = mkdtempSync(join(tmpdir(), "symlink-clean-"));
		mkdirSync(join(root, "other"), { recursive: true });
		symlinkSync(join(root, "other"), join(root, "link"));
		try {
			expect(collectSymlinkTargets(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
