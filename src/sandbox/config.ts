/**
 * Sandbox config persistence. The config file stores lock state, allowlisted
 * symlink targets, and explicitly unlocked paths so a session can restore its
 * sandbox setup. The file is a trust anchor: only slash commands
 * may write it, through the in-process saveSandboxConfig helper.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOME, globalUnlockedPaths, markSymlinkScan, sandboxState, symlinkTargets, unlockedPaths } from "./state.js";

/** Serialized sandbox state written by /sandbox-save-config. */
export interface SandboxConfig {
	version: number;
	sandboxLocked: boolean;
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
 * Apply a loaded config to the live sandbox state. Symlink targets are
 * realpath-resolved at save time and taken verbatim here.
 */
export function applyConfig(cfg: SandboxConfig): void {
	sandboxState.locked = cfg.sandboxLocked;
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
		symlinkTargets: [...symlinkTargets],
		unlockedPaths: [...unlockedPaths],
		savedAt: new Date().toISOString(),
	};
}

/** Global config path: ~/.pi/agent/<basename>. Shared by every project. */
export function globalConfigPath(home: string = HOME): string {
	return join(home, ".pi", "agent", CONFIG_BASENAME);
}

/**
 * Read the global unlocked paths. A missing file yields an empty list.
 * @throws Error when the file exists but cannot be parsed, so a hand-edited
 *   file is never silently overwritten.
 */
export function loadGlobalUnlockedPaths(path: string = globalConfigPath()): string[] {
	if (!existsSync(path)) {
		return [];
	}
	const cfg = loadSandboxConfigFromPath(path);
	if (!cfg) {
		throw new Error(`Global sandbox config at ${path} is unreadable; fix or delete it`);
	}
	return cfg.unlockedPaths;
}

/**
 * Add `target` to the global config file and save it immediately. Only
 * `unlockedPaths` is stored; lock state and symlink targets stay per project.
 * @throws Error when the existing file is unreadable or cannot be written.
 */
export function addGlobalUnlockedPath(target: string, path: string = globalConfigPath()): void {
	const paths = [...new Set([...loadGlobalUnlockedPaths(path), target])];
	const cfg: Pick<SandboxConfig, "version" | "unlockedPaths" | "savedAt"> = {
		version: 1,
		unlockedPaths: paths,
		savedAt: new Date().toISOString(),
	};
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

/**
 * Replace the live global unlocked paths with the file's contents.
 * @throws Error when the file exists but is unreadable.
 */
export function reloadGlobalConfig(path: string = globalConfigPath()): void {
	const paths = loadGlobalUnlockedPaths(path);
	globalUnlockedPaths.clear();
	for (const p of paths) {
		globalUnlockedPaths.add(p);
	}
}
