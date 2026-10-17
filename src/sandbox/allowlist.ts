/**
 * The single list of paths the sandbox allows by default. Every layer reads
 * from here: the Seatbelt profile, the bubblewrap and Landlock argument
 * builders, the in-process path checks, and the startup banner. Add or remove
 * a default path in this file only.
 *
 * Secrets like ~/.gnupg and ~/.aws are deliberately not listed; ~/.ssh is
 * read-only because git remotes over ssh need it.
 */

import { join, resolve } from "node:path";
import { HOME } from "./state.js";

/** A path under $HOME that stays reachable, and whether writes are allowed. */
export interface HomeAllowEntry {
	/** Absolute path. */
	path: string;
	/** True for read-write access, false for read-only. */
	writable: boolean;
	/** Why the path is allowed; shown in docs, not at runtime. */
	reason: string;
}

/**
 * Paths under $HOME that stay reachable inside the sandbox.
 * @param home - Home directory the entries hang off; defaults to the real one.
 */
export function homeAllowlist(home: string = HOME): HomeAllowEntry[] {
	const entry = (rel: string, writable: boolean, reason: string): HomeAllowEntry => ({
		path: join(home, rel),
		writable,
		reason,
	});
	return [
		entry(".pi", true, "pi configuration and sessions"),
		entry(".agents", true, "agent skills and configuration"),
		entry(".cache", true, "package manager and build caches"),
		entry(".npm", true, "npm cache"),
		entry(join("Library", "Caches"), true, "macOS application caches"),
		entry(join("Library", "Logs"), true, "macOS application logs"),
		entry(".nvm", true, "node version manager installations"),
		entry(".pyenv", true, "python version manager installations"),
		entry(".bun", true, "bun runtime and package cache"),
		entry(".deno", true, "deno runtime and cache"),
		entry(join(".cargo", "registry"), true, "cargo crate cache for builds"),
		entry(".rustup", true, "rust toolchain installations"),
		entry(".pnpm-store", true, "pnpm content-addressable store"),
		entry(join("Library", "Preferences"), false, "macOS app configuration plists"),
		entry(join("Library", "Application Support"), false, "macOS app-managed data"),
		entry(".gitconfig", false, "git identity"),
	entry(".ssh", false, "ssh keys and known_hosts so git push works"),
		entry(join(".config", "git"), false, "git configuration"),
		entry(".volta", false, "node toolchain shims"),
		entry(join(".local", "bin"), false, "user-installed executables"),
		entry(join(".local", "share", "uv"), false, "uv-managed Python interpreters that venvs link to"),
		entry(join(".cargo", "bin"), false, "rust toolchain binaries"),
	];
}

/** Home paths with the requested access level (`true` = read-write, `false` = read-only). */
export function homePaths(writable: boolean, home: string = HOME): string[] {
	return homeAllowlist(home)
		.filter((e) => e.writable === writable)
		.map((e) => e.path);
}

/** Standard device files safe to reference from any sandbox (in-process tools only). */
export const EXACT_ALLOWED_PATHS: ReadonlySet<string> = new Set(
	[
		"/dev/null",
		"/dev/zero",
		"/dev/stdout",
		"/dev/stderr",
		"/dev/stdin",
		"/dev/tty",
		"/dev/random",
		"/dev/urandom",
		"/dev/full",
	].map((p) => resolve(p)),
);

/**
 * Pseudo-filesystem trees and scratch directories (in-process tools only; the
 * OS layers leave everything outside $HOME open). `/var/folders` is the macOS
 * per-user temp area, symlinked to /private/var/folders.
 */
export const PREFIX_ALLOWED_PATHS: readonly string[] = ["/dev/fd", "/proc/self/fd", "/tmp", "/var/folders"].map((p) =>
	resolve(p),
);
