/**
 * Reviewer3 post-fix regression: registered roots are canonicalized at
 * registration and re-validated on every check and every bash spawn
 * (validExtensionPaths). A root swapped for a symlink after registration, a
 * symlink created inside a registered root, and a not-yet-existing root
 * created as a symlink are all denied (fail closed). The two "pre-existing"
 * probes document the out-of-scope P1 on origin/main: symlinks in default
 * writable prefixes (/tmp, ~/.pi) still bypass checkPath via the lexical
 * candidate; that fix is separate from this branch.
 *
 * All fixtures live under the repo cwd (under $HOME, outside every default
 * allow prefix). "secretDir" stands in for ~/.ssh; no real secret is touched.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBwrapArgs, buildLandlockArgs, buildSeatbeltProfile } from "../src/sandbox/os-sandbox.js";
import { checkPath } from "../src/sandbox/paths.js";
import { registerAllowedPath, validExtensionPaths } from "../src/sandbox/registry.js";
import { HOME, extensionPaths, globalUnlockedPaths, resetState, symlinkTargets } from "../src/sandbox/state.js";

let root: string;
let sandboxDir: string;
let secretDir: string;
let secretFile: string;

beforeEach(() => {
	globalUnlockedPaths.clear();
	resetState();
	root = realpathSync(mkdtempSync(join(process.cwd(), ".r3-")));
	sandboxDir = join(root, "project");
	secretDir = join(root, "fake-ssh");
	mkdirSync(sandboxDir);
	mkdirSync(secretDir);
	secretFile = join(secretDir, "id_rsa");
	writeFileSync(secretFile, "PRIVATE KEY");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	globalUnlockedPaths.clear();
	resetState();
});

/** Agent step: replace a directory it can write with a symlink (bash rm + ln -s). */
function swapForSymlink(dir: string, target: string): void {
	rmSync(dir, { recursive: true, force: true });
	symlinkSync(target, dir);
}

describe("Reviewer3: registered path symlink swap (post-fix)", () => {
	it("in-process tools are denied through a swapped registered directory", () => {
		const registered = join(sandboxDir, "ext-data");
		mkdirSync(registered);
		registerAllowedPath(registered);
		expect(checkPath(secretFile, sandboxDir, "read").allowed).toBe(false);

		swapForSymlink(registered, secretDir);

		// Registry still holds the original string; revalidation drops it.
		expect([...extensionPaths]).toEqual([registered]);
		expect(validExtensionPaths()).toEqual([]);
		expect(checkPath(secretFile, sandboxDir, "read").allowed).toBe(false);
		expect(checkPath(secretFile, sandboxDir, "write").allowed).toBe(false);
	});

	it("a symlink created inside a registered dir cannot expose its target", () => {
		const registered = join(root, "shared-dir");
		mkdirSync(registered);
		registerAllowedPath(registered);
		expect(checkPath(secretFile, sandboxDir, "read").allowed).toBe(false);

		symlinkSync(secretDir, join(registered, "l"));
		const viaLink = join(registered, "l", "id_rsa");
		expect(checkPath(viaLink, sandboxDir, "read").allowed).toBe(false);
		expect(checkPath(viaLink, sandboxDir, "write").allowed).toBe(false);
	});

	it("a not-yet-existing registered path created as a symlink by the agent is denied", () => {
		const registered = join(sandboxDir, "future-cache");
		registerAllowedPath(registered);
		expect(checkPath(secretFile, sandboxDir, "read").allowed).toBe(false);

		symlinkSync(secretDir, registered);
		expect(validExtensionPaths()).toEqual([]);
		expect(checkPath(secretFile, sandboxDir, "read").allowed).toBe(false);
	});

	it("Linux bwrap and Landlock argv drop a swapped root (fail closed)", () => {
		const registered = join(sandboxDir, "ext-data");
		mkdirSync(registered);
		registerAllowedPath(registered);
		swapForSymlink(registered, secretDir);
		const input = { sandboxDir, readWritePaths: validExtensionPaths() };

		const bwrap = buildBwrapArgs(input);
		expect(bwrap).not.toContain(registered);
		expect(bwrap).not.toContain(secretDir);
		const landlock = buildLandlockArgs(input);
		expect(landlock).not.toContain(registered);
		expect(buildSeatbeltProfile(input)).not.toContain(`"${secretDir}"`);
	});

	it("pre-existing (out of scope, origin/main): a symlink in the default writable ~/.pi prefix still exposes its target", () => {
		const link = join(HOME, ".pi", `.r3-probe-link-${process.pid}`);
		try {
			expect(checkPath(secretFile, sandboxDir, "read").allowed).toBe(false);
			symlinkSync(secretDir, link);
			expect(checkPath(join(link, "id_rsa"), sandboxDir, "read").allowed).toBe(true);
		} finally {
			rmSync(link, { force: true });
		}
	});

	it("pre-existing (out of scope, origin/main): a symlink in /tmp still exposes its target", () => {
		const link = join(realpathSync("/tmp"), `.r3-probe-link-${process.pid}`); // /private/tmp on macOS
		try {
			symlinkSync(secretDir, link);
			expect(checkPath(join(link, "id_rsa"), sandboxDir, "read").allowed).toBe(true);
			expect(checkPath(join(link, "id_rsa"), sandboxDir, "write").allowed).toBe(true);
		} finally {
			rmSync(link, { force: true });
		}
	});

	it("control: a symlink inside the sandbox dir itself is blocked (realpath containment)", () => {
		symlinkSync(secretDir, join(sandboxDir, "l"));
		expect(checkPath(join(sandboxDir, "l", "id_rsa"), sandboxDir, "read").allowed).toBe(false);
	});

	it("control: session-start symlink targets are compared lexically and do not follow a swap", () => {
		const target = join(sandboxDir, "linked");
		mkdirSync(target);
		symlinkTargets.add(target);
		swapForSymlink(target, secretDir);
		expect(checkPath(secretFile, sandboxDir, "read").allowed).toBe(false);
	});
});

describe("Reviewer3: ~user registration input (post-fix)", () => {
	it("'~foo' is rejected by the absolute-or-tilde guard", () => {
		resetState();
		expect(() => registerAllowedPath("~r3nouser")).toThrow(/absolute or tilde/);
		resetState();
	});
});

/**
 * Re-review: realpathThroughExisting uses existsSync, which follows the link.
 * A dangling symlink therefore looks "missing" and stays lexical, so the
 * candidate never reaches the outside target. The in-process write tool then
 * creates the file at the link target (fs.writeFile follows symlinks).
 * Root cause shared by the registered root (this branch) and the sandbox dir
 * itself (isInsideSandbox, also present on origin/main a88d8a9).
 */
describe("Reviewer3 re-review: dangling symlink write escape", () => {
	it("registered root: write through a dangling link creates a file outside", () => {
		const registered = join(root, "shared-dir");
		mkdirSync(registered);
		registerAllowedPath(registered);
		const target = join(secretDir, "new-launch-agent.plist");
		expect(checkPath(target, sandboxDir, "write").allowed).toBe(false);

		symlinkSync(target, join(registered, "l"));
		expect(checkPath(join(registered, "l"), sandboxDir, "write").allowed).toBe(true);
		writeFileSync(join(registered, "l"), "pwn");
		expect(readFileSync(target, "utf8")).toBe("pwn");
	});

	it("pre-existing (origin/main): sandbox dir has the same dangling-link escape", () => {
		const target = join(secretDir, "new-launch-agent.plist");
		expect(checkPath(target, sandboxDir, "write").allowed).toBe(false);
		symlinkSync(target, join(sandboxDir, "l"));
		expect(checkPath(join(sandboxDir, "l"), sandboxDir, "write").allowed).toBe(true);
	});
});
