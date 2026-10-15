/**
 * Path checks for pi's in-process tools (read, write, edit, grep, find, ls).
 * Bash is confined at the OS level by os-sandbox.ts; these checks cover the
 * tools that run inside pi's own process. Pure decision logic over paths.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { EXACT_ALLOWED_PATHS, PREFIX_ALLOWED_PATHS, homeAllowlist } from "./allowlist.js";
import { allUnlockedPaths, symlinkTargets } from "./state.js";
import { expandTilde, isUnderPrefix, isUnderRealPrefix, realpathThroughExisting, tryRealpath } from "./fs-utils.js";

/** What a tool does with a path: read-only home entries allow only "read". */
export type PathAccess = "read" | "write";

/**
 * Check if a resolved path is under any of the always-allowed paths.
 * Checks both the original path and its realpath'd (symlink-resolved) form, so
 * that:
 *   - Symlinks inside the allowlist are allowed because the original path is
 *     under the allowed root.
 *   - Symlinks pointing into the allowlist are allowed because the realpath'd
 *     path is under the allowed root.
 */
export function isAllowedPath(resolvedPath: string, access: PathAccess = "write"): boolean {
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

		// Read-only home entries (toolchains) never satisfy a write.
		const homeEntries = homeAllowlist().filter((entry) => entry.writable || access === "read");
		if (homeEntries.some((entry) => isUnderRealPrefix(candidate, entry.path))) {
			return true;
		}

		// Paths explicitly unlocked by the user via /unlock-last-path.
		if (allUnlockedPaths().some((allowed) => isUnderRealPrefix(candidate, allowed))) {
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
 * sandbox dirs. Relative paths resolve against the sandbox root. `access`
 * defaults to "write", the stricter mode.
 */
export function checkPath(path: string, sandboxDir: string, access: PathAccess = "write"): PathCheckResult {
	const realSandboxDir = tryRealpath(resolve(sandboxDir));
	const resolved = resolve(realSandboxDir, expandTilde(path));
	if (isAllowedPath(resolved, access)) {
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

