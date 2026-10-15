import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOME, resetState } from "./state.js";
import {
	buildBwrapArgs,
	buildLandlockArgs,
	buildSeatbeltProfile,
	metadataPaths,
	detectOsSandbox,
	ensureProfileFile,
	existingRealPaths,
	homeReadOnlyPaths,
	homeReadWritePaths,
	outsideHomeRoots,
	probeBwrap,
	probeLandlock,
	sbplEscape,
	shQuote,
	wrapWithSeatbelt,
} from "./os-sandbox.js";

const SEATBELT = existsSync("/usr/bin/sandbox-exec");
const LINUX = process.platform === "linux";
const BWRAP = LINUX && probeBwrap().available;
const LANDLOCK = LINUX && probeLandlock().available;

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

	it("re-allows toolchains read-only and caches read-write for parity with Linux", () => {
		const profile = buildSeatbeltProfile({ sandboxDir: "/ws/x", readWritePaths: [] });
		for (const p of homeReadWritePaths()) {
			expect(profile).toContain(`(allow file-read* (subpath "${p}"))`);
			expect(profile).toContain(`(allow file-write* (subpath "${p}"))`);
		}
		for (const p of homeReadOnlyPaths()) {
			expect(profile).toContain(`(allow file-read* (subpath "${p}"))`);
		}
	});
});

describe("metadataPaths", () => {
	it("returns the home directory itself plus ancestors of allowed roots", () => {
		const home = "/Users/u";
		const paths = metadataPaths(["/Users/u/repos/proj"], home);
		expect(paths).toContain(home);
		expect(paths).toContain("/Users/u/repos/proj");
		expect(paths).toContain("/Users/u/repos");
		expect(paths).not.toContain("/Users/u/repos/proj/sub");
	});

	it("includes nothing beside home when the root is outside home", () => {
		const paths = metadataPaths(["/workspace"], "/Users/u");
		expect(paths).toEqual(["/Users/u"]);
	});
});

describe("buildSeatbeltProfile ancestor metadata", () => {
	it("allows stat of the ancestor chain, keeping content reads denied", () => {
		const profile = buildSeatbeltProfile({
			sandboxDir: "/Users/u/repos/proj",
			readWritePaths: [],
		});
		expect(profile).toContain('(allow file-read-metadata (literal "/Users/u"))');
		expect(profile).toContain('(allow file-read-metadata (literal "/Users/u/repos"))');
		expect(profile).toContain('(allow file-read-metadata (literal "/Users/u/repos/proj"))');
		// No data-level read of the ancestors creeps in.
		expect(profile).not.toContain('(allow file-read* (literal "/Users/u/repos"))');
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

describe("existingRealPaths", () => {
	it("drops missing paths, realpaths, dedupes, and sorts parents first", () => {
		const parent = mkdtempSync(join(tmpdir(), "sb-real-"));
		const child = join(parent, "child");
		mkdirSync(child);
		try {
			const out = existingRealPaths([child, parent, join(parent, "missing"), parent]);
			expect(out).toEqual([parent, child]);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});
});

describe("buildBwrapArgs", () => {
	it("unshares pids, mounts a fresh /proc, and tmpfs-overlays the home dir before any bind", () => {
		const sandbox = mkdtempSync(join(tmpdir(), "sb-args-"));
		try {
			const args = buildBwrapArgs({ sandboxDir: sandbox, readWritePaths: [] });
			const tmpfsAt = args.indexOf("--tmpfs");
			expect(tmpfsAt).toBeGreaterThan(-1);
			expect(args[tmpfsAt + 1]).toBe(homedir());
			expect(args).toContain("--unshare-pid");
			expect(args.indexOf("--proc")).toBeGreaterThan(args.indexOf("--dev-bind"));
			expect(args.indexOf("--tmpfs")).toBeGreaterThan(args.indexOf("--dev-bind"));
			expect(args.indexOf("--tmpfs")).toBeLessThan(args.indexOf("--bind-try"));
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	});

	it("binds the sandbox dir and extra roots read-write, parents before children, deduped", () => {
		const parent = mkdtempSync(join(tmpdir(), "sb-binds-"));
		const child = join(parent, "child");
		mkdirSync(child);
		try {
			const args = buildBwrapArgs({ sandboxDir: child, readWritePaths: [parent, parent] });
			const binds = args.filter((_, i) => args[i - 1] === "--bind-try");
			expect(binds).toContain(parent);
			expect(binds).toContain(child);
			expect(binds.indexOf(parent)).toBeLessThan(binds.indexOf(child));
			expect(binds.filter((p) => p === parent)).toHaveLength(1);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("re-exposes toolchains under $HOME read-only and ends with --chdir to the sandbox dir", () => {
		const sandbox = mkdtempSync(join(tmpdir(), "sb-chdir-"));
		try {
			const args = buildBwrapArgs({ sandboxDir: sandbox, readWritePaths: [] });
			const rw = args.filter((_, i) => args[i - 1] === "--bind-try");
			for (const p of homeReadOnlyPaths()) {
				if (!existsSync(p)) continue;
				if (rw.includes(p)) continue; // an rw root wins over a ro bind
				expect(args.join(" ")).toContain(`--ro-bind-try ${p} ${p}`);
			}
			expect(args[args.length - 2]).toBe("--chdir");
			expect(args[args.length - 1]).toBe(sandbox);
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	});
});

describe("outsideHomeRoots", () => {
	it("lists every sibling on the path to home, never home or its ancestors", () => {
		const roots = outsideHomeRoots("/home/user");
		expect(roots).not.toContain("/");
		expect(roots).not.toContain("/home");
		expect(roots).not.toContain("/home/user");
		expect(roots.every((r) => r.split("/").length <= 3)).toBe(true);
		if (existsSync("/usr")) expect(roots).toContain("/usr");
	});
});

describe("buildLandlockArgs", () => {
	it("grants the sandbox dir read-write and toolchains read-only, never all of $HOME", () => {
		const sandbox = mkdtempSync(join(tmpdir(), "sb-ll-"));
		try {
			const args = buildLandlockArgs({ sandboxDir: sandbox, readWritePaths: [] });
			const rw = args.filter((_, i) => args[i - 1] === "--rw");
			const ro = args.filter((_, i) => args[i - 1] === "--ro");
			expect(rw).toContain(sandbox);
			expect(rw).not.toContain(homedir());
			expect(rw).not.toContain("/");
			for (const p of existingRealPaths(homeReadOnlyPaths())) {
				if (!rw.includes(p)) expect(ro).toContain(p);
			}
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	});
});

describe.skipIf(!LINUX)("linux wrap", () => {
	it("wraps with the selected backend and quotes the command", () => {
		const sandbox = mkdtempSync(join(tmpdir(), "sb-wrap-"));
		try {
			const runner = detectOsSandbox();
			const wrapped = runner!.wrap("echo 'hi'", { sandboxDir: sandbox, readWritePaths: [] });
			const prefix = runner!.kind === "bubblewrap" ? "'/usr/bin/bwrap' '--die-with-parent'" : "'/usr/bin/python3' '";
			expect(wrapped.startsWith(prefix)).toBe(true);
			expect(wrapped.endsWith(`'/bin/bash' '-c' ${shQuote("echo 'hi'")}`)).toBe(true);
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	});
});

describe("detectOsSandbox", () => {
	it("reports the platform runner", () => {
		const runner = detectOsSandbox();
		if (process.platform === "darwin") {
			expect(runner?.kind).toBe("seatbelt");
			expect(runner?.available).toBe(SEATBELT);
		} else if (process.platform === "linux") {
			expect(runner?.kind).toBe(BWRAP ? "bubblewrap" : "landlock");
			expect(runner?.available).toBe(BWRAP || LANDLOCK);
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

/** Live kernel check on Linux, through whichever backend is selected (bwrap or Landlock). */
describe.skipIf(!BWRAP && !LANDLOCK)("linux enforcement", () => {
	it("blocks reads outside the sandbox and allows reads and writes inside it", () => {
		const sandbox = mkdtempSync(join(HOME, ".bwrap-sb-"));
		const outside = mkdtempSync(join(HOME, ".bwrap-out-"));
		writeFileSync(join(sandbox, "inside.txt"), "inside-ok");
		writeFileSync(join(outside, "secret.txt"), "outside-secret");
		try {
			const runner = detectOsSandbox();
			const run = (cmd: string): { out: string; code: number } => {
				try {
					const out = execSync(runner!.wrap(cmd, { sandboxDir: sandbox, readWritePaths: [] }), {
						encoding: "utf8",
						stdio: "pipe",
						cwd: sandbox,
					});
					return { out, code: 0 };
				} catch (e) {
					const err = e as { stdout?: string; status?: number };
					return { out: err.stdout ?? "", code: err.status ?? 1 };
				}
			};
			expect(run("cat inside.txt").out.trim()).toBe("inside-ok");
			expect(run("echo write-ok > wrote.txt && cat wrote.txt").out.trim()).toBe("write-ok");
			// Literal path, variable path, glob, nested shell, interpreter:
			// the kernel must refuse all of them.
			expect(run(`cat ${join(outside, "secret.txt")}`).code).not.toBe(0);
			expect(run(`P=${outside}; cat "$P/secret.txt"`).code).not.toBe(0);
			expect(run("cat ../*/secret.txt").code).not.toBe(0);
			expect(run(`echo "cat ${join(outside, "secret.txt")}" | sh`).code).not.toBe(0);
			expect(run(`python3 -c "print(open('${join(outside, "secret.txt")}').read())"`).code).not.toBe(0);
			// /proc/1/root must not reach the real home (bwrap: pids unshared; Landlock: / not granted).
			expect(run(`cat /proc/1/root${join(outside, "secret.txt")}`).code).not.toBe(0);
			// Normal CLIs keep working: node comes from the toolchain roots or /.
			expect(run("node --version").code).toBe(0);
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
