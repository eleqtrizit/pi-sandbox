import { describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandTilde, isUnderPrefix, isUnderRealPrefix, relativeSafe, tryRealpath } from "./fs-utils.js";
import { HOME } from "./state.js";

describe("tryRealpath", () => {
	it("returns the resolved path for an existing path", () => {
		const dir = mkdtempSync(join(tmpdir(), "fsu-"));
		try {
			// tmpdir may itself be reached through a symlink (/var/folders), so
			// compare against realpathSync rather than the unresolved absolute path.
			expect(tryRealpath(dir)).toBe(realpathSync(dir));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to the input for a nonexistent path", () => {
		expect(tryRealpath("/definitely/not/here")).toBe("/definitely/not/here");
	});
});

describe("expandTilde", () => {
	it("expands a bare tilde to HOME", () => {
		expect(expandTilde("~")).toBe(HOME);
	});

	it("expands ~/<path> to HOME/<path>", () => {
		expect(expandTilde("~/docs")).toBe(`${HOME}/docs`);
	});

	it("leaves absolute and relative paths untouched", () => {
		expect(expandTilde("/usr/bin")).toBe("/usr/bin");
		expect(expandTilde("src/foo.ts")).toBe("src/foo.ts");
	});
});

describe("isUnderPrefix", () => {
	it("matches paths under the prefix", () => {
		expect(isUnderPrefix("/a/b/c", "/a")).toBe(true);
		expect(isUnderPrefix("/a/b", "/a/b")).toBe(true);
	});

	it("does not match sibling or unrelated paths", () => {
		expect(isUnderPrefix("/other", "/a")).toBe(false);
	});

	it("does not match a sibling that shares a string prefix", () => {
		expect(isUnderPrefix("/a/bc", "/a/b")).toBe(false);
	});
});

describe("isUnderRealPrefix", () => {
	it("resolves symlinked prefixes before comparing", () => {
		const real = mkdtempSync(join(tmpdir(), "fsu-real-"));
		const link = `${real}/../fsu-link-${Date.now()}`;
		symlinkSync(real, link);
		try {
			writeFileSync(join(real, "file.txt"), "x");
			// Compare using the realpath'd candidate, mirroring how isAllowedPath
			// checks the normalized form.
			const candidate = realpathSync(join(real, "file.txt"));
			expect(isUnderRealPrefix(candidate, link)).toBe(true);
		} finally {
			rmSync(link, { force: true });
			rmSync(real, { recursive: true, force: true });
		}
	});
});

describe("relativeSafe", () => {
	it("returns a relative path when inside cwd", () => {
		expect(relativeSafe("/a", "/a/b/c.json")).toBe("b/c.json");
	});

	it("returns absolute when outside cwd", () => {
		expect(relativeSafe("/a", "/b/c")).toBe("/b/c");
	});
});
