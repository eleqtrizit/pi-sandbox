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
 * Linux: buildBwrapArgs() is the integration point for bubblewrap.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Paths that stay read-write inside every profile. */
export function baseReadWritePaths(): string[] {
	return [join(homedir(), ".pi"), join(homedir(), ".agents")];
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
	for (const p of [resolve(sandboxDir), ...readWritePaths.map((p) => resolve(p)), ...baseReadWritePaths()]) {
		lines.push(`(allow file-read* (subpath "${sbplEscape(p)}"))`);
		lines.push(`(allow file-write* (subpath "${sbplEscape(p)}"))`);
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
 * Build the bubblewrap argument vector for the same policy. Linux
 * integration point: bind the toolchain read-only, the read-write roots
 * read-write, and set the workspace as cwd.
 *
 * shortcut: not implemented yet; finish bwrap integration on Linux.
 */
export function buildBwrapArgs(input: ProfileInput): string[] {
	void input;
	throw new Error("bubblewrap integration is not implemented yet");
}

export interface OsSandboxRunner {
	/** Platform identifier shown in status and errors. */
	kind: "seatbelt" | "bubblewrap";
	/** True when the OS sandbox binary for this platform is installed. */
	available: boolean;
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
		return {
			kind: "bubblewrap",
			available: existsSync(BWRAP_BIN),
			wrap: (command, input) => {
				const args = buildBwrapArgs(input);
				return ["bwrap", ...args, "/bin/bash", "-c", command].map(shQuote).join(" ");
			},
		};
	}
	return null;
}
