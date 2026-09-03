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

/** Master toggle: when false, all path checks are skipped. */
export const sandboxState = {
	locked: true,
	/** Opt-in symlink mode: compare lexically instead of resolving symlinks. */
	symlinkMode: false,
};

/**
 * Real filesystem paths reachable via symlinks inside the sandbox. Populated
 * when symlink mode is enabled and refreshed on block. Entries are already
 * realpath-resolved, so lookups need no extra syscalls. Mode-gated: only
 * consulted while `sandboxState.symlinkMode` is true, so locking symlinks back
 * instantly re-tightens the sandbox.
 */
export const symlinkTargets: Set<string> = new Set();

/** Timestamp (ms) of the last symlink-target scan; 0 means never scanned. */
export let symlinkTargetsAt = 0;

/** Record the timestamp of the last symlink-target scan. */
export function markSymlinkScan(now: number): void {
	symlinkTargetsAt = now;
}

/** One recorded sandbox block, kept for the /unlock-last-path workflow. */
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
 * once: a repeat block moves the existing entry to the end so /unlock-last-path
 * always surfaces the most recently denied unique path.
 */
export const blockedHistory: BlockedEntry[] = [];

/**
 * Paths explicitly unlocked by the user via /unlock-last-path. Treated as
 * prefix-allowed (like PREFIX_ALLOWED_PATHS) in isAllowedPath, and persisted
 * alongside the rest of the sandbox state by /save-sandbox-config.
 */
export const unlockedPaths: Set<string> = new Set();

/**
 * Record a blocked path attempt for the /unlock-last-path workflow. The
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
	sandboxState.symlinkMode = false;
	symlinkTargets.clear();
	markSymlinkScan(0);
	blockedHistory.length = 0;
	unlockedPaths.clear();
}
