/**
 * OS-level command sandboxing.
 *
 * The kernel enforces the access rules, so paths built at runtime (shell
 * variables, globs, nested shells, interpreters, arena scripts) are confined
 * exactly like literal paths. This replaces the old bash text scanner.
 *
 * macOS: launchd Seatbelt via /usr/bin/sandbox-exec. All programs stay
 * runnable (no process-exec restrictions); only file access is filtered.
 *
 * Linux: bubblewrap (/usr/bin/bwrap). The host root is bind-mounted, then a
 * tmpfs over $HOME hides the real home; allowed roots are bound back in, and
 * toolchain/cache paths under $HOME stay readable or writable so CLIs keep
 * working. PIDs are unshared so /proc/<pid>/root cannot reach the real home.
 * The probe (probeBwrap) decides availability with a real bwrap run, because
 * AppArmor can restrict unprivileged user namespaces even when bwrap exists.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { tryRealpath } from "./fs-utils.js";

/** Paths that stay read-write inside every profile. */
export function baseReadWritePaths(): string[] {
	return [join(homedir(), ".pi"), join(homedir(), ".agents")];
}

/**
 * Toolchain and config paths under $HOME that stay readable so normal CLIs
 * keep working (node/npm via volta, cargo, user-local bins, git config).
 * Secrets like ~/.ssh, ~/.gnupg and ~/.aws are deliberately not listed.
 */
export function homeReadOnlyPaths(): string[] {
	const home = homedir();
	return [
		join(home, ".gitconfig"),
		join(home, ".config", "git"),
		join(home, ".volta"),
		join(home, ".local", "bin"),
		join(home, ".cargo", "bin"),
	];
}

/**
 * Cache and scratch paths under $HOME that stay read-write so package
 * managers and build tools keep working inside the sandbox.
 */
export function homeReadWritePaths(): string[] {
	const home = homedir();
	return [join(home, ".cache"), join(home, ".npm")];
}

/**
 * Directories that keep file-read-metadata (stat/lstat) permission although
 * file-read-data stays denied: the home directory itself plus every ancestor
 * of an allowed root down from it. Tools that resolve paths in userspace by
 * lstat-ing each component (node's module loader, npm, some shims) fail with
 * EPERM without this, even for files inside allowed roots. Metadata-only
 * keeps directory listings unreadable: readdir needs file-read-data.
 */
export function metadataPaths(roots: string[], home: string = homedir()): string[] {
	const out = new Set<string>([home, resolve(home)]);
	for (const root of roots) {
		let dir = resolve(root);
		while (dir.startsWith(`${resolve(home)}/`) && dir !== resolve(home)) {
			out.add(dir);
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return [...out];
}

/**
 * Resolve paths through realpath, drop ones that do not exist (bwrap cannot
 * bind from a missing source), dedupe, and sort parents before children so
 * nested binds stack correctly.
 */
export function existingRealPaths(paths: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const p of paths) {
		if (!existsSync(p)) continue;
		const real = tryRealpath(resolve(p));
		if (!seen.has(real)) {
			seen.add(real);
			out.push(real);
		}
	}
	return out.sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/** Test whether `path` equals or lies under one of `roots`. */
export function isUnderAny(path: string, roots: string[]): boolean {
	return roots.some((r) => path === r || path.startsWith(`${r}/`));
}

/** Escape a path for a Seatbelt profile string literal. */
export function sbplEscape(p: string): string {
	return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Single-quote a string for a POSIX shell command line. */
export function shQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Inputs for profile generation. All paths are absolute or resolved here. */
export interface ProfileInput {
	/** Directory the session is confined to. */
	sandboxDir: string;
	/** Extra read-write roots: symlink targets, unlocked paths. */
	readWritePaths: string[];
}

/**
 * Build a Seatbelt profile: default-allow (programs and network unchanged),
 * deny all file access under the home directory, then re-allow the sandbox
 * directory, symlink targets, unlocked paths, and the pi config roots.
 * Everything outside the home directory keeps macOS default access.
 */
export function buildSeatbeltProfile({ sandboxDir, readWritePaths }: ProfileInput): string {
	const lines = [
		"(version 1)",
		"(allow default)",
		`(deny file-read* file-write* (subpath "${sbplEscape(homedir())}"))`,
	];
	const rwRoots = [resolve(sandboxDir), ...readWritePaths.map((p) => resolve(p)), ...baseReadWritePaths(), ...homeReadWritePaths()];
	for (const p of rwRoots) {
		lines.push(`(allow file-read* (subpath "${sbplEscape(p)}"))`);
		lines.push(`(allow file-write* (subpath "${sbplEscape(p)}"))`);
	}
	// stat/lstat on the ancestor chain of every allowed root, so programs
	// that resolve paths component-by-component (node, npm) keep working.
	// Metadata only: listing those directories still needs file-read-data,
	// which stays denied.
	for (const p of metadataPaths(rwRoots)) {
		lines.push(`(allow file-read-metadata (literal "${sbplEscape(p)}"))`);
	}
	// Toolchains under the home directory stay readable (read-only).
	for (const p of homeReadOnlyPaths()) {
		lines.push(`(allow file-read* (subpath "${sbplEscape(p)}"))`);
	}
	// Read-only identity/config files commands commonly need.
	for (const p of [join(homedir(), ".gitconfig")]) {
		lines.push(`(allow file-read* (literal "${sbplEscape(p)}"))`);
	}
	return `${lines.join("\n")}\n`;
}

/** Write the profile text to a stable temp path keyed by content hash. */
export function ensureProfileFile(profileText: string): string {
	const dir = join(tmpdir(), "pi-sandbox-profiles");
	mkdirSync(dir, { recursive: true });
	const hash = createHash("sha256").update(profileText).digest("hex").slice(0, 16);
	const file = join(dir, `${hash}.sb`);
	if (!existsSync(file) || readFileSync(file, "utf8") !== profileText) {
		writeFileSync(file, profileText, "utf8");
	}
	return file;
}

/** Wrap a command so the kernel sandbox executes it. Exported for tests. */
export function wrapWithSeatbelt(command: string, profileText: string): string {
	const profile = shQuote(ensureProfileFile(profileText));
	return `sandbox-exec -f ${profile} /bin/bash -c ${shQuote(command)}`;
}

/**
 * Build the bubblewrap argument vector for the same policy as the Seatbelt
 * profile: the whole root stays visible read-write (programs, /tmp, /etc are
 * untouched), a tmpfs over $HOME hides the real home directory, and the
 * allowed roots are bound back in. `--unshare-pid` + a fresh /proc stop the
 * /proc/<pid>/root escape into the real home.
 *
 * shortcut: a session cwd that is itself a symlink breaks the spawn cwd inside
 * the namespace; pi normally starts in a real directory, upgrade if that changes.
 */
export function buildBwrapArgs({ sandboxDir, readWritePaths }: ProfileInput): string[] {
	const rw = existingRealPaths([
		resolve(sandboxDir),
		...readWritePaths,
		...baseReadWritePaths(),
		...homeReadWritePaths(),
	]);
	const args = [
		"--die-with-parent",
		"--new-session",
		"--unshare-pid",
		"--dev-bind", "/", "/",
		"--proc", "/proc",
		"--tmpfs", homedir(),
	];
	// Bind order matters: the tmpfs above hides $HOME, these re-expose the
	// allowed roots, sorted parents-first so nested binds stack correctly.
	for (const p of rw) {
		args.push("--bind-try", p, p);
	}
	for (const p of existingRealPaths(homeReadOnlyPaths())) {
		if (!isUnderAny(p, rw)) {
			args.push("--ro-bind-try", p, p);
		}
	}
	args.push("--chdir", resolve(sandboxDir));
	return args;
}

let bwrapProbe: { available: boolean; reason?: string } | null = null;

/**
 * Probe bubblewrap with a real run, not just existence: Ubuntu 24.04+ AppArmor
 * can restrict unprivileged user namespaces so bwrap exists but always fails
 * with EPERM. The result is cached because it cannot change within a session.
 */
export function probeBwrap(): { available: boolean; reason?: string } {
	if (bwrapProbe === null) {
		if (!existsSync(BWRAP_BIN)) {
			bwrapProbe = { available: false, reason: `${BWRAP_BIN} is not installed` };
		} else {
			const r = spawnSync(BWRAP_BIN, ["--ro-bind", "/", "/", "/bin/true"], { timeout: 5000, encoding: "utf8" });
			bwrapProbe = r.status === 0
				? { available: true }
				: {
					available: false,
					reason: `${r.error?.message ?? r.stderr?.trim() ?? `exit ${r.status}`}`.trim(),
				};
		}
	}
	return bwrapProbe;
}

/**
 * Every filesystem entry outside `home`: at each level from `/` down to the
 * home directory, all siblings of the path component leading to home.
 * Landlock is allow-only, so "everything except $HOME" must be spelled out.
 * The root itself is never granted, which also blocks /proc/<pid>/root.
 */
export function outsideHomeRoots(home: string = tryRealpath(homedir())): string[] {
	const roots: string[] = [];
	let dir = "/";
	for (const part of home.split("/").filter(Boolean)) {
		let names: string[] = [];
		try {
			names = readdirSync(dir);
		} catch {
			// Unreadable level: grant nothing there (fail closed).
		}
		roots.push(...names.filter((n) => n !== part).map((n) => join(dir, n)));
		dir = join(dir, part);
	}
	return roots;
}

/** Build the landlock.py argument vector (before `--`) for the sandbox policy. */
export function buildLandlockArgs({ sandboxDir, readWritePaths }: ProfileInput): string[] {
	const rw = existingRealPaths([
		resolve(sandboxDir),
		...readWritePaths,
		...baseReadWritePaths(),
		...homeReadWritePaths(),
	]);
	const ro = existingRealPaths(homeReadOnlyPaths()).filter((p) => !isUnderAny(p, rw));
	return [
		...[...outsideHomeRoots(), ...rw].flatMap((p) => ["--rw", p]),
		...ro.flatMap((p) => ["--ro", p]),
	];
}

const LANDLOCK_HELPER = join(__dirname, "landlock.py");
const PYTHON_BIN = "/usr/bin/python3";

let landlockProbe: { available: boolean; reason?: string } | null = null;

/** Probe Landlock support through the helper once; cached for the session. */
export function probeLandlock(): { available: boolean; reason?: string } {
	if (landlockProbe === null) {
		if (!existsSync(PYTHON_BIN)) {
			landlockProbe = { available: false, reason: `${PYTHON_BIN} is not installed` };
		} else {
			const r = spawnSync(PYTHON_BIN, [LANDLOCK_HELPER, "--probe"], { timeout: 5000, encoding: "utf8" });
			landlockProbe = r.status === 0
				? { available: true }
				: { available: false, reason: `${r.error?.message ?? r.stderr?.trim() ?? `exit ${r.status}`}`.trim() };
		}
	}
	return landlockProbe;
}

export interface OsSandboxRunner {
	/** Platform identifier shown in status and errors. */
	kind: "seatbelt" | "bubblewrap" | "landlock";
	/** True when the OS sandbox binary for this platform is installed. */
	available: boolean;
	/** Why the sandbox is unavailable, when `available` is false. */
	unavailableReason?: string;
	/** Wrap a shell command for kernel-enforced confinement. */
	wrap: (command: string, input: ProfileInput) => string;
}

const SEATBELT_BIN = "/usr/bin/sandbox-exec";
const BWRAP_BIN = "/usr/bin/bwrap";

/**
 * Detect the OS sandbox for this platform. Returns a runner when the
 * platform tool exists; `kind` is still reported (with available: false)
 * so callers can explain what is missing.
 */
export function detectOsSandbox(): OsSandboxRunner | null {
	if (process.platform === "darwin") {
		return {
			kind: "seatbelt",
			available: existsSync(SEATBELT_BIN),
			wrap: (command, input) => wrapWithSeatbelt(command, buildSeatbeltProfile(input)),
		};
	}
	if (process.platform === "linux") {
		const bwrap = probeBwrap();
		if (bwrap.available) {
			return {
				kind: "bubblewrap",
				available: true,
				wrap: (command, input) =>
					[BWRAP_BIN, ...buildBwrapArgs(input), "/bin/bash", "-c", command].map(shQuote).join(" "),
			};
		}
		// bwrap needs user namespaces, which AppArmor may block; Landlock does not.
		const landlock = probeLandlock();
		return {
			kind: "landlock",
			available: landlock.available,
			unavailableReason: landlock.available ? undefined : `bwrap: ${bwrap.reason}; landlock: ${landlock.reason}`,
			wrap: (command, input) =>
				[PYTHON_BIN, LANDLOCK_HELPER, ...buildLandlockArgs(input), "--", "/bin/bash", "-c", command]
					.map(shQuote)
					.join(" "),
		};
	}
	return null;
}
