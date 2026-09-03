/**
 * Symlink scanning for sandbox symlink mode. When symlink mode is enabled,
 * symlinks inside the sandbox that point outside it are allowlisted by their
 * realpath-resolved targets.
 */

import { readdirSync, realpathSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { markSymlinkScan, sandboxState, symlinkTargets, symlinkTargetsAt } from "./state.js";
import { tryRealpath } from "./fs-utils.js";

/**
 * Directories to skip when walking the sandbox for symlinks. These trees are
 * either huge (node_modules), volatile (.git), or full of symlink forests
 * (pnpm) that would bloat the allow list without helping any real workload.
 */
const SYMLINK_SKIP_DIRS: ReadonlySet<string> = new Set([
	"node_modules",
	".git",
	".venv",
	"dist",
	"build",
	".cache",
	".next",
	"target",
]);

/** Minimum time between automatic symlink-target rescans (throttle). */
export const SYMLINK_REFRESH_MIN_MS = 1000;

/**
 * Resolve which fd binary to use for the symlink scan. On some platforms the
 * Homebrew formula installs as `fdfind`; elsewhere it is `fd`. Try both names
 * at PATH, then common absolute locations. Returns null if none are usable.
 */
export function findFd(): string | null {
	const candidates = [
		"fdfind",
		"fd",
		"/usr/local/bin/fdfind",
		"/opt/homebrew/bin/fdfind",
		"/usr/local/bin/fd",
		"/opt/homebrew/bin/fd",
	];
	for (const cmd of candidates) {
		const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
		if (result.status === 0) {
			return cmd;
		}
	}
	return null;
}

/**
 * Collect every symlink path under `sandboxDir` using fd when available,
 * falling back to a bounded manual walk. Skips heavy/volatile subtrees.
 */
export function findSymlinks(sandboxDir: string): string[] {
	const root = resolve(sandboxDir);
	const fd = findFd();
	if (fd) {
		const args = ["-H", "--no-ignore", "--type", "symlink", "--absolute-path"];
		for (const ex of SYMLINK_SKIP_DIRS) {
			args.push("--exclude", ex);
		}
		args.push(".", root);
		const result = spawnSync(fd, args, {
			encoding: "utf8",
			stdio: "pipe",
			timeout: 15000,
			maxBuffer: 8 * 1024 * 1024,
		});
		if (result.status === 0 && !result.error) {
			return result.stdout
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l.length > 0);
		}
		// fd failed or timed out; fall through to manual walk
	}
	return walkSymlinks(root);
}

/**
 * Manual recursive walk for symlinks, used when fd is unavailable or fails.
 * Does not recurse into symlinked directories (their real targets are recorded
 * as targets, not re-walked). Cycle-safe via a visited set of real paths.
 */
export function walkSymlinks(root: string): string[] {
	const results: string[] = [];
	const visited = new Set<string>();
	const stack: string[] = [resolve(root)];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (dir === undefined) {
			continue;
		}
		const realDir = tryRealpath(dir);
		if (visited.has(realDir)) {
			continue;
		}
		visited.add(realDir);
		let entries: Dirent[] = [];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isSymbolicLink()) {
				results.push(full);
				continue;
			}
			if (entry.isDirectory() && !SYMLINK_SKIP_DIRS.has(entry.name)) {
				stack.push(full);
			}
		}
	}
	return results;
}

/**
 * Scan the sandbox for symlinks and return the realpath-resolved targets that
 * point outside the sandbox. Broken symlinks and in-sandbox targets are
 * skipped. Deduplicated.
 */
export function collectSymlinkTargets(sandboxDir: string): string[] {
	const root = resolve(sandboxDir);
	const realRoot = tryRealpath(root);
	const links = findSymlinks(root);
	const targets: string[] = [];
	for (const link of links) {
		let target: string;
		try {
			target = realpathSync(link);
		} catch {
			continue;
		}
		const rel = relative(realRoot, target);
		// Keep only targets that resolve outside the sandbox (relative path
		// escapes upward). Self-targets and in-sandbox targets are already
		// covered by the normal sandbox check.
		if (rel.startsWith("..")) {
			targets.push(target);
		}
	}
	return [...new Set(targets)];
}

/**
 * Replace the allowlisted symlink targets with a fresh scan of `sandboxDir`.
 * Used by /unlock-sandbox-symlinks and /save-sandbox-config.
 */
export function rescanSymlinkTargets(sandboxDir: string): number {
	const targets = collectSymlinkTargets(sandboxDir);
	symlinkTargets.clear();
	for (const t of targets) {
		symlinkTargets.add(t);
	}
	markSymlinkScan(Date.now());
	return symlinkTargets.size;
}

/**
 * Re-scan symlink targets if the throttle window has elapsed, then re-test
 * `resolved` against the allow list. Used at block points to pick up symlinks
 * created mid-session without polling. Only active in symlink mode. The
 * `isAllowed` callback re-runs the caller's allow check after a refresh.
 */
export function refreshAndRecheck(resolved: string, sandboxDir: string, isAllowed: (p: string) => boolean): boolean {
	if (!sandboxState.symlinkMode) {
		return false;
	}
	const now = Date.now();
	if (symlinkTargetsAt === 0 || now - symlinkTargetsAt >= SYMLINK_REFRESH_MIN_MS) {
		rescanSymlinkTargets(sandboxDir);
	}
	return isAllowed(resolved);
}
