/**
 * Mutable sandbox state shared by the sandbox modules.
 *
 * The sandbox is a per-process singleton, so the state lives here as exported
 * bindings. Slash commands mutate it through small helpers; the check functions
 * read it directly. Everything loaded from the sandbox config file funnels
 * through `applyConfig` in config.ts so there is exactly one place that
 * restores state.
 */

import { homedir } from "node:os";

/** Home directory, resolved once at module load. */
export const HOME = homedir();

/** Master toggle: when false, all sandbox checks are skipped. */
export const sandboxState = {
	locked: true,
};

/**
 * Real filesystem paths reachable via symlinks inside the sandbox, such as
 * ./common -> ../common. Entries are already realpath-resolved, so lookups
 * need no extra syscalls. Used by the in-process tool checks and by the OS
 * profile builder.
 */
export const symlinkTargets: Set<string> = new Set();

/** Timestamp (ms) of the last symlink-target scan; 0 means never scanned. */
export let symlinkTargetsAt = 0;

/** Record the timestamp of the last symlink-target scan. */
export function markSymlinkScan(now: number): void {
	symlinkTargetsAt = now;
}

/** One recorded sandbox block, kept for the /sandbox-unlock-last-path workflow. */
export interface BlockedEntry {
	/** Realpath-resolved path that was denied. */
	path: string;
	/** Path as it appeared in the tool input, for human display. */
	original: string;
	/** Tool that issued the blocked call. */
	tool: string;
	/** Epoch milliseconds when the block happened. */
	timestamp: number;
}

/** Ring-buffer size for recent blocked paths. */
export const BLOCKED_HISTORY_MAX = 50;

/**
 * Ring buffer of recent blocked paths, newest last. Each path is kept at most
 * once: a repeat block moves the existing entry to the end so /sandbox-unlock-last-path
 * always surfaces the most recently denied unique path.
 */
export const blockedHistory: BlockedEntry[] = [];

/**
 * Paths explicitly unlocked by the user via /sandbox-unlock-last-path. Treated as
 * prefix-allowed (like PREFIX_ALLOWED_PATHS) in isAllowedPath, and persisted
 * alongside the rest of the sandbox state by /sandbox-save-config.
 */
export const unlockedPaths: Set<string> = new Set();

/**
 * Paths unlocked for every project by /sandbox-unlock-last-path-globally. Loaded from
 * the global config file and kept apart from `unlockedPaths` so that
 * /sandbox-save-config never copies them into a project config.
 */
export const globalUnlockedPaths: Set<string> = new Set();

/**
 * Extra directories registered by other extensions via registerAllowedPath
 * (src/sandbox/registry.ts). Realpath-resolved prefix-allowed roots, treated
 * like unlockedPaths but never persisted to the sandbox config: extensions
 * re-register on every load, so the registry is rebuilt per session.
 *
 * pi loads every extension through jiti with moduleCache: false, so each
 * extension importing this module gets its own copy of the Set. Storing the
 * Set on globalThis under a Symbol.for key makes all copies share one
 * registry, in any load order.
 */
const EXTENSION_PATHS_KEY = Symbol.for("pi-sandbox.extensionPaths");
type GlobalWithPaths = typeof globalThis & { [EXTENSION_PATHS_KEY]?: Set<string> };
export const extensionPaths: Set<string> = ((globalThis as GlobalWithPaths)[EXTENSION_PATHS_KEY] ??= new Set());

/** Every unlocked path in effect: project-local plus global. */
export function allUnlockedPaths(): string[] {
	return [...new Set([...unlockedPaths, ...globalUnlockedPaths])];
}

/**
 * Record a blocked path attempt for the /sandbox-unlock-last-path workflow. The
 * resolved path is realpath'd so the stored form matches the realpath'd
 * candidates that isAllowedPath checks. Each path is kept at most once: a
 * repeat block moves the existing entry to the end (most recent).
 */
export function recordBlocked(original: string, resolved: string, tool: string, realpath: (p: string) => string): void {
	const path = realpath(resolved);
	const existing = blockedHistory.findIndex((entry) => entry.path === path);
	if (existing !== -1) {
		blockedHistory.splice(existing, 1);
	}
	blockedHistory.push({ path, original, tool, timestamp: Date.now() });
	if (blockedHistory.length > BLOCKED_HISTORY_MAX) {
		blockedHistory.shift();
	}
}

/**
 * Reset all mutable state to defaults. Used by tests so each test file starts
 * from a clean sandbox without cross-test leakage.
 */
export function resetState(): void {
	sandboxState.locked = true;
	symlinkTargets.clear();
	markSymlinkScan(0);
	blockedHistory.length = 0;
	unlockedPaths.clear();
	globalUnlockedPaths.clear();
	extensionPaths.clear();
}
