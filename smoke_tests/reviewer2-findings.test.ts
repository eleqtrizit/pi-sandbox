import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBanner, displayPath, statusLine } from "../src/sandbox/display.js";
import { buildBwrapArgs, buildLandlockArgs, buildSeatbeltProfile } from "../src/sandbox/os-sandbox.js";
import { checkPath, isAllowedPath } from "../src/sandbox/paths.js";
import { registerAllowedPath, registeredAllowedPaths } from "../src/sandbox/registry.js";
import { HOME, allUnlockedPaths, extensionPaths, globalUnlockedPaths, resetState, symlinkTargets } from "../src/sandbox/state.js";

describe("Reviewer2 smoke tests (post-fix)", () => {
	let workDir: string;

	beforeEach(() => {
		globalUnlockedPaths.clear();
		resetState();
		workDir = realpathSync(mkdtempSync(join(process.cwd(), ".sbx-r2-")));
	});

	afterEach(() => {
		rmSync(workDir, { recursive: true, force: true });
		globalUnlockedPaths.clear();
		resetState();
	});

	it("1. Fixed: resetState() clears globalUnlockedPaths", () => {
		globalUnlockedPaths.add("/Users/some/global/path");
		resetState();
		expect(globalUnlockedPaths.size).toBe(0);
		expect(allUnlockedPaths()).not.toContain("/Users/some/global/path");
	});

	it("2. Fixed: missing-leaf child under a symlinked ancestor is canonicalized, and a later parent registration drops it", () => {
		const targetDir = join(workDir, "real-target");
		mkdirSync(targetDir, { recursive: true });
		const linkPath = join(workDir, "symlink-dir");
		symlinkSync(targetDir, linkPath);

		// Non-existent child under the symlink is stored on the real spine.
		const nonExistentChild = join(linkPath, "nonexistent-sub");
		const storedChild = registerAllowedPath(nonExistentChild);
		expect(storedChild).toBe(join(targetDir, "nonexistent-sub"));

		// Registering the existing parent now covers and drops the child.
		const storedParent = registerAllowedPath(linkPath);
		expect(storedParent).toBe(targetDir);
		expect(registeredAllowedPaths()).toEqual([targetDir]);
	});

	it("3. Fixed: non-existent paths under symlinked parents store the canonical path, and the OS profile emits it", () => {
		const targetDir = join(workDir, "real-parent");
		mkdirSync(targetDir, { recursive: true });
		const linkDir = join(workDir, "link-parent");
		symlinkSync(targetDir, linkDir);

		const futureDir = join(linkDir, "future-dir");
		const registered = registerAllowedPath(futureDir);
		expect(registered).toBe(join(targetDir, "future-dir"));

		mkdirSync(futureDir, { recursive: true });
		const profile = buildSeatbeltProfile({
			sandboxDir: join(workDir, "sandbox"),
			readWritePaths: [...extensionPaths],
		});
		expect(profile).toContain(join(targetDir, "future-dir"));
		expect(profile).not.toContain(futureDir);
	});

	it("4. Fixed: '~username' forms throw; root and HOME remain trusted-API registrations", () => {
		expect(() => registerAllowedPath("~foo/bar")).toThrow(/absolute or tilde/);

		resetState();
		const r1 = registerAllowedPath("/");
		expect(r1).toBe("/");
		expect(isAllowedPath(join(HOME, ".ssh/id_rsa"))).toBe(true);

		resetState();
		const r2 = registerAllowedPath("~");
		expect(r2).toBe(HOME);
		expect(isAllowedPath(join(HOME, ".ssh/id_rsa"))).toBe(true);
	});

	it("5. Fixed: statusLine() and buildBanner() report extension paths", () => {
		const extraDir = join(workDir, "ext-allowed");
		mkdirSync(extraDir, { recursive: true });
		registerAllowedPath(extraDir);

		expect(statusLine()).toBe("🛡 sandbox enabled.");
		const banner = buildBanner(workDir, null, null);
		expect(banner).toContain("Extension paths (1):");
		expect(banner).toContain(displayPath(extraDir));
	});

	it("6. OS sandbox (Seatbelt/bwrap/Landlock) includes extensionPaths", () => {
		const sandbox = join(workDir, "sb");
		const extDir = join(workDir, "ext");
		mkdirSync(sandbox, { recursive: true });
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "data.txt"), "ext-ok");

		registerAllowedPath(extDir);
		const readWritePaths = [...symlinkTargets, ...allUnlockedPaths(), ...extensionPaths];

		const profile = buildSeatbeltProfile({ sandboxDir: sandbox, readWritePaths });
		expect(profile).toContain(`(allow file-read* (subpath "${extDir}"))`);
		expect(profile).toContain(`(allow file-write* (subpath "${extDir}"))`);

		const bwrap = buildBwrapArgs({ sandboxDir: sandbox, readWritePaths });
		expect(bwrap).toContain(extDir);

		const ll = buildLandlockArgs({ sandboxDir: sandbox, readWritePaths });
		expect(ll).toContain(extDir);
	});
});
