/**
 * Sandbox config persistence. The config file stores lock state, symlink mode,
 * allowlisted symlink targets, and explicitly unlocked paths so a session can
 * restore its sandbox setup. The file is a trust anchor: only slash commands
 * may write it, through the in-process saveSandboxConfig helper.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { markSymlinkScan, sandboxState, symlinkTargets, unlockedPaths } from "./state.js";

/** Serialized sandbox state written by /save-sandbox-config. */
export interface SandboxConfig {
	version: number;
	sandboxLocked: boolean;
	symlinkMode: boolean;
	symlinkTargets: string[];
	unlockedPaths: string[];
	savedAt?: string;
}

/** The config basename, assembled from parts. Tools may not reference this
 * file, so the literal name never appears in code that tools can echo. */
export const CONFIG_BASENAME = ["sandbox", "json"].join(".");

/** Config search order: project-local .pi first, then .agents. */
export function configCandidates(cwd: string): string[] {
	return [join(cwd, ".pi", CONFIG_BASENAME), join(cwd, ".agents", CONFIG_BASENAME)];
}

/** First existing config path, or null when no config file is present. */
export function existingConfigPath(cwd: string): string | null {
	for (const p of configCandidates(cwd)) {
		if (existsSync(p)) {
			return p;
		}
	}
	return null;
}

/**
 * Read and validate a sandbox config file. Returns null on missing/unreadable
 * or malformed JSON so callers fall back to defaults.
 */
export function loadSandboxConfigFromPath(path: string): SandboxConfig | null {
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<SandboxConfig>;
		if (typeof parsed.version !== "number") {
			return null;
		}
		return {
			version: parsed.version,
			sandboxLocked: typeof parsed.sandboxLocked === "boolean" ? parsed.sandboxLocked : true,
			symlinkMode: typeof parsed.symlinkMode === "boolean" ? parsed.symlinkMode : false,
			symlinkTargets: Array.isArray(parsed.symlinkTargets)
				? parsed.symlinkTargets.filter((t): t is string => typeof t === "string")
				: [],
			unlockedPaths: Array.isArray(parsed.unlockedPaths)
				? parsed.unlockedPaths.filter((t): t is string => typeof t === "string")
				: [],
			savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : undefined,
		};
	} catch {
		return null;
	}
}

/**
 * Persist the sandbox config. Prefers the .pi directory, creating it; falls
 * back to the .agents directory if .pi is unusable. Throws if both fail.
 */
export function saveSandboxConfig(cwd: string, cfg: SandboxConfig): string {
	const primary = join(cwd, ".pi", CONFIG_BASENAME);
	try {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(primary, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
		return primary;
	} catch {
		const fallback = join(cwd, ".agents", CONFIG_BASENAME);
		mkdirSync(join(cwd, ".agents"), { recursive: true });
		writeFileSync(fallback, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
		return fallback;
	}
}

/**
 * Apply a loaded config to the live sandbox state. Symlink targets are taken
 * verbatim (they were realpath-resolved at save time); a later refresh-on-block
 * re-scans to pick up filesystem changes.
 */
export function applyConfig(cfg: SandboxConfig): void {
	sandboxState.locked = cfg.sandboxLocked;
	sandboxState.symlinkMode = cfg.symlinkMode;
	symlinkTargets.clear();
	for (const t of cfg.symlinkTargets) {
		symlinkTargets.add(t);
	}
	unlockedPaths.clear();
	for (const p of cfg.unlockedPaths) {
		unlockedPaths.add(p);
	}
	markSymlinkScan(Date.now());
}

/** Build a config snapshot from the current live sandbox state. */
export function currentConfig(): SandboxConfig {
	return {
		version: 1,
		sandboxLocked: sandboxState.locked,
		symlinkMode: sandboxState.symlinkMode,
		symlinkTargets: [...symlinkTargets],
		unlockedPaths: [...unlockedPaths],
		savedAt: new Date().toISOString(),
	};
}
