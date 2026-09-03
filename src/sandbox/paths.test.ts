import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, resetState, sandboxState, unlockedPaths } from "./state.js";
import { checkBashCommand, checkPath, checkPathToken, isCommentToken, isInsideSandbox, tokenizeCommand } from "./paths.js";

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

	it("compares lexically in symlink mode", () => {
		sandboxState.symlinkMode = true;
		const linkDir = `${sandboxDir}/link-out`;
		symlinkSync(HOME, linkDir);
		try {
			// Lexical compare sees the link as inside, realpath compare would not.
			expect(isInsideSandbox(join(linkDir, "file.txt"), sandboxDir)).toBe(true);
		} finally {
			rmSync(linkDir, { force: true });
		}
	});
});

describe("tokenizeCommand", () => {
	it("splits on whitespace", () => {
		expect(tokenizeCommand("ls -la /tmp/x")).toEqual(["ls", "-la", "/tmp/x"]);
	});

	it("keeps quoted strings together", () => {
		expect(tokenizeCommand('echo "a b"')).toEqual(["echo", "a b"]);
		expect(tokenizeCommand("echo 'a b'")).toEqual(["echo", "a b"]);
	});

	it("keeps escaped quotes inside double quotes", () => {
		expect(tokenizeCommand('echo "say \\"hi\\""')).toEqual(["echo", 'say "hi"']);
	});
});

describe("isCommentToken", () => {
	it("recognizes comment markers", () => {
		expect(isCommentToken("//code")).toBe(true);
		expect(isCommentToken("/* doc")).toBe(true);
	});

	it("does not treat ordinary paths as comments", () => {
		expect(isCommentToken("/usr/bin")).toBe(false);
	});
});

describe("checkPathToken", () => {
	it("ignores non-path tokens", () => {
		expect(checkPathToken("grep", sandboxDir)).toEqual({ allowed: true });
	});

	it("allows comment-looking tokens", () => {
		expect(checkPathToken("//example", sandboxDir).allowed).toBe(true);
	});

	it("allows path tokens that do not exist on disk", () => {
		expect(checkPathToken("/no/such/path", sandboxDir).allowed).toBe(true);
	});

	it("blocks existing paths outside the sandbox", () => {
		const result = checkPathToken(HOME, sandboxDir);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("outside the sandbox directory");
	});

	it("allows existing paths inside the sandbox", () => {
		expect(checkPathToken(join(sandboxDir, "file.txt"), sandboxDir).allowed).toBe(true);
	});

	it("allows ~/.pi paths that exist", () => {
		expect(checkPathToken(`${HOME}/.pi`, sandboxDir).allowed).toBe(true);
	});
});

describe("checkBashCommand", () => {
	it("allows empty and comment-only commands", () => {
		expect(checkBashCommand("", sandboxDir).allowed).toBe(true);
		expect(checkBashCommand("# just a comment", sandboxDir).allowed).toBe(true);
	});

	it("allows commands with no path-like tokens", () => {
		expect(checkBashCommand("npm test --silent", sandboxDir).allowed).toBe(true);
	});

	it("allows cd into the sandbox", () => {
		expect(checkBashCommand("cd sub && ls", sandboxDir).allowed).toBe(true);
	});

	it("blocks cd to an absolute path outside the sandbox", () => {
		const result = checkBashCommand(`cd ${HOME} && ls`, sandboxDir);
		expect(result.allowed).toBe(false);
		expect(result.original).toBe(`cd ${HOME}`);
	});

	it("blocks existing absolute path references outside the sandbox", () => {
		const result = checkBashCommand(`cat ${HOME}/.zshrc`, sandboxDir);
		expect(result.allowed).toBe(false);
		expect(result.original).toBe(`${HOME}/.zshrc`);
	});

	it("checks each segment of && chains independently", () => {
		expect(checkBashCommand(`cd sub && cat ${HOME}/.zshrc`, sandboxDir).allowed).toBe(false);
	});

	it("skips environment variable assignments", () => {
		expect(checkBashCommand(`FOO=bar npm run build`, sandboxDir).allowed).toBe(true);
	});

	it("allows nonexistent path-like tokens such as regex patterns", () => {
		expect(checkBashCommand("rg /definitely/not/here/", sandboxDir).allowed).toBe(true);
	});
});
