/**
 * Path checks for pi's in-process tools (read, write, edit, grep, find, ls).
 * Bash is confined at the OS level by os-sandbox.ts; these checks cover the
 * tools that run inside pi's own process. Pure decision logic over paths.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { HOME, symlinkTargets, unlockedPaths } from "./state.js";
import { expandTilde, isUnderPrefix, isUnderRealPrefix, realpathThroughExisting, tryRealpath } from "./fs-utils.js";

/**
 * Paths that are always allowed, regardless of sandbox boundaries. These are
 * resolved at module load time.
 */
const ALLOWED_PATHS: string[] = [
	resolve(`${HOME}/.pi`),
	resolve(`${HOME}/.agents`),
];

/**
 * Standard device and pseudo-filesystem paths safe to reference from any sandbox.
 * Resolved at module load time.
 */
const EXACT_ALLOWED_PATHS: ReadonlySet<string> = new Set([
	resolve("/dev/null"),
	resolve("/dev/zero"),
	resolve("/dev/stdout"),
	resolve("/dev/stderr"),
	resolve("/dev/stdin"),
	resolve("/dev/tty"),
	resolve("/dev/random"),
	resolve("/dev/urandom"),
	resolve("/dev/full"),
]);

/**
 * Path prefixes for innocuous pseudo-filesystem trees (e.g. fd redirects)
 * and scratch/temp directories: the shared /tmp and the macOS per-user
 * /var/folders (symlinked to /private/var/folders, resolved via realpath).
 */
const PREFIX_ALLOWED_PATHS: string[] = [
	resolve("/dev/fd"),
	resolve("/proc/self/fd"),
	resolve("/tmp"),
	resolve("/var/folders"),
];

/**
 * Check if a resolved path is under any of the always-allowed paths.
 * Checks both the original path and its realpath'd (symlink-resolved) form, so
 * that:
 *   - Symlinks inside ALLOWED_PATHS are allowed because the original path is
 *     under the allowed root.
 *   - Symlinks pointing into ALLOWED_PATHS are allowed because the realpath'd
 *     path is under the allowed root.
 */
export function isAllowedPath(resolvedPath: string): boolean {
	const resolved = resolve(resolvedPath);
	const normalized = realpathThroughExisting(resolved);

	// Check both the original path and the realpath'd version
	const candidates = [resolved];
	if (normalized !== resolved) {
		candidates.push(normalized);
	}

	const matchesAllowed = (candidate: string): boolean => {
		if (EXACT_ALLOWED_PATHS.has(candidate)) {
			return true;
		}

		if (PREFIX_ALLOWED_PATHS.some((allowed) => isUnderRealPrefix(candidate, allowed))) {
			return true;
		}

		if (ALLOWED_PATHS.some((allowed) => isUnderRealPrefix(candidate, allowed))) {
			return true;
		}

		// Paths explicitly unlocked by the user via /unlock-last-path.
		if ([...unlockedPaths].some((allowed) => isUnderRealPrefix(candidate, allowed))) {
			return true;
		}

		// Allow paths under the real targets of sandbox symlinks
		// (e.g. ./common -> ../common). Targets are realpath-resolved.
		for (const prefix of symlinkTargets) {
			if (isUnderPrefix(candidate, prefix)) {
				return true;
			}
		}

		return false;
	};

	return candidates.some(matchesAllowed);
}

/**
 * Check if a resolved path is inside the sandbox directory, resolving
 * symlinks via realpath before comparing.
 */
export function isInsideSandbox(resolvedPath: string, sandboxDir: string): boolean {
	const realResolved = realpathThroughExisting(resolvedPath);
	const realSandbox = tryRealpath(resolve(sandboxDir));
	const rel = relative(realSandbox, realResolved);
	return !rel.startsWith("..");
}

/** Verdict from a sandbox path check. */
export interface PathCheckResult {
	/** True when the path may be used. */
	allowed: boolean;
	/** Human-readable block reason; present only when not allowed. */
	reason?: string;
	/** The fully resolved path that was examined. */
	resolved?: string;
}

/**
 * Normalize a path and check it against the sandbox.
 * Always-allowed paths bypass the sandbox check. Symlinks are resolved via
 * realpath before comparison, so symlinked paths match against resolved
 * sandbox dirs. Relative paths resolve against the sandbox root.
 */
export function checkPath(path: string, sandboxDir: string): PathCheckResult {
	const realSandboxDir = tryRealpath(resolve(sandboxDir));
	const resolved = resolve(realSandboxDir, expandTilde(path));
	if (isAllowedPath(resolved)) {
		return { allowed: true };
	}
	if (!isInsideSandbox(resolved, realSandboxDir)) {
		const displaySandbox = tryRealpath(resolve(sandboxDir));
		return {
			allowed: false,
			reason: `Sandbox blocked: path "${path}" resolves to "${resolved}" which is outside the sandbox directory "${displaySandbox}"`,
			resolved,
		};
	}
	return { allowed: true };
}

/**
 * Resolve the path that /unlock-last-path unlocks for a blocked path.
 * Blocked directories unlock themselves; blocked files unlock their parent
 * directory so the whole subtree becomes reachable. A path that no longer
 * exists (a blocked write to a new file) unlocks its parent too.
 */
export function unlockTargetFor(path: string): string {
	try {
		if (statSync(path).isDirectory()) {
			return path;
		}
	} catch {
		// Missing path: the parent directory is the meaningful unlock target.
	}
	return dirname(path);
}

