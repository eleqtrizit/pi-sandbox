import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOME, resetState } from "./state.js";
import {
	buildBwrapArgs,
	buildSeatbeltProfile,
	detectOsSandbox,
	ensureProfileFile,
	sbplEscape,
	shQuote,
	wrapWithSeatbelt,
} from "./os-sandbox.js";

const SEATBELT = existsSync("/usr/bin/sandbox-exec");

describe("sbplEscape", () => {
	it("escapes backslashes and double quotes for profile literals", () => {
		expect(sbplEscape('/a"b\\c')).toBe('/a\\"b\\\\c');
	});
});

describe("shQuote", () => {
	it("single-quotes and escapes embedded quotes", () => {
		expect(shQuote("it's ok")).toBe("'it'\\''s ok'");
		expect(shQuote("a b")).toBe("'a b'");
	});
});

describe("buildSeatbeltProfile", () => {
	it("denies the home directory and re-allows the sandbox and extra roots", () => {
		const profile = buildSeatbeltProfile({
			sandboxDir: "/ws/proj",
			readWritePaths: ["/ws/shared", "/unlocked/x"],
		});
		expect(profile).toContain(`(deny file-read* file-write* (subpath "${homedir()}"))`);
		expect(profile).toContain('(allow file-read* (subpath "/ws/proj"))');
		expect(profile).toContain('(allow file-write* (subpath "/ws/proj"))');
		expect(profile).toContain('(allow file-read* (subpath "/ws/shared"))');
		expect(profile).toContain('(allow file-write* (subpath "/unlocked/x"))');
		expect(profile).toContain(`(allow file-read* (subpath "${join(homedir(), ".pi")}"))`);
	});

	it("escapes hostile path characters", () => {
		const profile = buildSeatbeltProfile({ sandboxDir: '/ws/a"b', readWritePaths: [] });
		expect(profile).toContain('(subpath "/ws/a\\"b")');
	});
});

describe("ensureProfileFile", () => {
	it("writes the profile and reuses a matching file", () => {
		const text = buildSeatbeltProfile({ sandboxDir: "/ws/x", readWritePaths: [] });
		const a = ensureProfileFile(text);
		const b = ensureProfileFile(text);
		expect(a).toBe(b);
		expect(existsSync(a)).toBe(true);
	});
});

describe("wrapWithSeatbelt", () => {
	it("runs the command under sandbox-exec with the profile", () => {
		const text = buildSeatbeltProfile({ sandboxDir: "/ws/x", readWritePaths: [] });
		const wrapped = wrapWithSeatbelt("echo hi", text);
		expect(wrapped).toMatch(/^sandbox-exec -f '.*\.sb' \/bin\/bash -c 'echo hi'$/);
	});
});

describe("buildBwrapArgs", () => {
	it("throws with a clear message until Linux integration lands", () => {
		expect(() => buildBwrapArgs({ sandboxDir: "/ws", readWritePaths: [] })).toThrow(/not implemented/);
	});
});

describe("detectOsSandbox", () => {
	it("reports the platform runner", () => {
		const runner = detectOsSandbox();
		if (process.platform === "darwin") {
			expect(runner?.kind).toBe("seatbelt");
			expect(runner?.available).toBe(SEATBELT);
		} else if (process.platform === "linux") {
			expect(runner?.kind).toBe("bubblewrap");
		} else {
			expect(runner).toBeNull();
		}
	});
});

/** Live kernel check: run only where sandbox-exec exists. */
describe.skipIf(!SEATBELT || process.platform !== "darwin")("seatbelt enforcement", () => {
	it("blocks reads outside the sandbox and allows reads inside it", () => {
		resetState();
		const sandbox = mkdtempSync(join(HOME, ".osisb-test-"));
		try {
			writeFileSync(join(sandbox, "inside.txt"), "inside-ok");
			const outside = mkdtempSync(join(HOME, ".osisb-outside-"));
			writeFileSync(join(outside, "secret.txt"), "outside-secret");
			try {
				const profile = buildSeatbeltProfile({ sandboxDir: sandbox, readWritePaths: [] });
				const run = (cmd: string): { out: string; code: number } => {
					try {
						const out = execSync(wrapWithSeatbelt(cmd, profile), { encoding: "utf8", stdio: "pipe", cwd: sandbox });
						return { out, code: 0 };
					} catch (e) {
						const err = e as { stdout?: string; status?: number };
						return { out: err.stdout ?? "", code: err.status ?? 1 };
					}
				};
				expect(run("cat inside.txt").out.trim()).toBe("inside-ok");
				// Literal path, variable path, glob, nested shell, interpreter:
				// the kernel must refuse all of them.
				expect(run(`cat ${join(outside, "secret.txt")}`).code).not.toBe(0);
				expect(run(`P=${outside}; cat "$P/secret.txt"`).code).not.toBe(0);
				expect(run("cat ../*/secret.txt").code).not.toBe(0);
				expect(run(`echo "cat ${join(outside, "secret.txt")}" | sh`).code).not.toBe(0);
				expect(run(`python3 -c "print(open('${join(outside, "secret.txt")}').read())"`).code).not.toBe(0);
			} finally {
				rmSync(outside, { recursive: true, force: true });
			}
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	});
});
