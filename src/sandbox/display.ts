/**
 * Human-facing rendering for the sandbox: status line and startup banner.
 */

import { HOME, allUnlockedPaths, blockedHistory, extensionPaths, sandboxState, symlinkTargets } from "./state.js";
import { EXACT_ALLOWED_PATHS, PREFIX_ALLOWED_PATHS, homeAllowlist } from "./allowlist.js";
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
	return `🛡 sandbox: ${sandboxState.locked ? "locked" : "unlocked"} | symlink targets: ${symlinkTargets.size} | unlocked: ${allUnlockedPaths().length} | extension: ${extensionPaths.size} | blocked: ${blockedHistory.length}`;
}

/**
 * Build the startup banner. Always lists the always-allowed paths so the user
 * can see exactly what the sandbox permits, plus allowlisted symlink targets.
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
	for (const { path, writable } of homeAllowlist()) {
		lines.push(`     ${displayPath(path)} (${writable ? "read-write" : "read-only"})`);
	}
	lines.push(`     exact: ${[...EXACT_ALLOWED_PATHS].join("  ")}`);
	lines.push(`     prefix: ${PREFIX_ALLOWED_PATHS.join("  ")}`);
	if (symlinkTargets.size === 0) {
		lines.push("   Symlink targets: (none)");
	} else {
		lines.push(`   Symlink targets (${symlinkTargets.size}):`);
		for (const t of symlinkTargets) {
			lines.push(`     ${displayPath(t)}`);
		}
	}
	const unlocked = allUnlockedPaths();
	if (unlocked.length === 0) {
		lines.push("   Unlocked paths: (none)");
	} else {
		lines.push(`   Unlocked paths (${unlocked.length}):`);
		for (const p of unlocked) {
			lines.push(`     ${displayPath(p)}`);
		}
	}
	if (extensionPaths.size === 0) {
		lines.push("   Extension paths: (none)");
	} else {
		lines.push(`   Extension paths (${extensionPaths.size}):`);
		for (const p of extensionPaths) {
			lines.push(`     ${displayPath(p)}`);
		}
	}
	return lines.join("\n");
}
