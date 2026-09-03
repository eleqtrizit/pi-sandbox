/**
 * Human-facing rendering for the sandbox: status line and startup banner.
 */

import { HOME, blockedHistory, sandboxState, symlinkTargets, unlockedPaths } from "./state.js";
import { relativeSafe } from "./fs-utils.js";
import type { SandboxConfig } from "./config.js";

/** Render a path with the home directory collapsed to ~ for display. */
export function displayPath(p: string): string {
	if (p === HOME) {
		return "~";
	}
	if (p.startsWith(`${HOME}/`)) {
		return `~${p.slice(HOME.length)}`;
	}
	return p;
}

/** Human-readable elapsed time since a timestamp, for blocked-path display. */
export function ageMs(ts: number): string {
	const ms = Date.now() - ts;
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	return `${Math.round(ms / 3_600_000)}h`;
}

/** One-line sandbox summary for the footer status line. */
export function statusLine(): string {
	const targets = sandboxState.symlinkMode ? symlinkTargets.size : 0;
	return `🛡 sandbox: ${sandboxState.locked ? "locked" : "unlocked"} | symlinks: ${sandboxState.symlinkMode ? `on (${targets})` : "off"} | unlocked: ${unlockedPaths.size} | blocked: ${blockedHistory.length}`;
}

/**
 * Build the startup banner. Always lists the always-allowed paths so the user
 * can see exactly what the sandbox permits, plus any allowlisted symlink
 * targets when symlink mode is on. The always-allowed lists mirror the ones in
 * paths.ts; keep them in sync.
 */
export function buildBanner(cwd: string, configPath: string | null, cfg: SandboxConfig | null): string {
	const lines: string[] = [];
	if (!configPath) {
		lines.push("🛡 Sandbox: no config file — using defaults");
	} else if (cfg) {
		lines.push(`🛡 Sandbox config loaded from ${relativeSafe(cwd, configPath)}`);
	} else {
		lines.push(`🛡 Sandbox config at ${relativeSafe(cwd, configPath)} unreadable — using defaults`);
	}
	lines.push(`   ${statusLine()}`);
	lines.push("   Always-allowed paths:");
	for (const p of [`${HOME}/.pi`, `${HOME}/.agents`]) {
		lines.push(`     ${displayPath(p)}`);
	}
	lines.push("     exact: /dev/null  /dev/zero  /dev/stdout  /dev/stderr  /dev/stdin  /dev/tty  /dev/random  /dev/urandom  /dev/full");
	lines.push("     prefix: /dev/fd  /proc/self/fd  /tmp  /var/folders");
	if (sandboxState.symlinkMode) {
		if (symlinkTargets.size === 0) {
			lines.push("   Symlink targets: (none allowlisted)");
		} else {
			lines.push(`   Symlink targets (${symlinkTargets.size}):`);
			for (const t of symlinkTargets) {
				lines.push(`     ${displayPath(t)}`);
			}
		}
	}
	if (unlockedPaths.size === 0) {
		lines.push("   Unlocked paths: (none)");
	} else {
		lines.push(`   Unlocked paths (${unlockedPaths.size}):`);
		for (const p of unlockedPaths) {
			lines.push(`     ${displayPath(p)}`);
		}
	}
	return lines.join("\n");
}
