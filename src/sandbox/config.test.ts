import { beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allUnlockedPaths, globalUnlockedPaths, resetState, sandboxState, symlinkTargets, unlockedPaths } from "./state.js";
import {
	CONFIG_BASENAME,
	addGlobalUnlockedPath,
	applyConfig,
	configCandidates,
	currentConfig,
	existingConfigPath,
	globalConfigPath,
	loadGlobalUnlockedPaths,
	loadSandboxConfigFromPath,
	reloadGlobalConfig,
	saveSandboxConfig,
} from "./config.js";

const configName = CONFIG_BASENAME;

beforeEach(() => resetState());

describe("existingConfigPath / configCandidates", () => {
	it("prefers the .pi location and falls back to .agents", () => {
		const cwd = mkdtempSync(join(tmpdir(), "cfg-home-"));
		try {
			expect(existingConfigPath(cwd)).toBeNull();
			expect(configCandidates(cwd)).toEqual([join(cwd, ".pi", configName), join(cwd, ".agents", configName)]);
			mkdirSync(join(cwd, ".agents"), { recursive: true });
			writeFileSync(join(cwd, ".agents", configName), "{}");
			expect(existingConfigPath(cwd)).toBe(join(cwd, ".agents", configName));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("saveSandboxConfig / loadSandboxConfigFromPath", () => {
	it("round-trips a config through the .pi location", () => {
		const cwd = mkdtempSync(join(tmpdir(), "cfg-roundtrip-"));
		try {
			const cfg = {
				version: 1,
				sandboxLocked: false,
				symlinkTargets: ["/a", "/b"],
				unlockedPaths: ["/c"],
				savedAt: "2024-01-01T00:00:00.000Z",
			};
			const path = saveSandboxConfig(cwd, cfg);
			expect(path).toBe(join(cwd, ".pi", configName));
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(cfg);
			expect(loadSandboxConfigFromPath(path)).toEqual(cfg);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("falls back to .agents when .pi cannot be created", () => {
		const cwd = mkdtempSync(join(tmpdir(), "cfg-fallback-"));
		try {
			// A file where the .pi directory belongs forces the fallback path.
			writeFileSync(join(cwd, ".pi"), "not a directory");
			const path = saveSandboxConfig(cwd, {
				version: 1,
				sandboxLocked: true,
				symlinkTargets: [],
				unlockedPaths: [],
			});
			expect(path).toBe(join(cwd, ".agents", configName));
			expect(loadSandboxConfigFromPath(path)?.sandboxLocked).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("returns null for malformed JSON and missing files", () => {
		const cwd = mkdtempSync(join(tmpdir(), "cfg-malformed-"));
		try {
			const bad = join(cwd, "bad.json");
			writeFileSync(bad, "{not json");
			expect(loadSandboxConfigFromPath(bad)).toBeNull();
			expect(loadSandboxConfigFromPath(join(cwd, "missing.json"))).toBeNull();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("returns null when version is not a number", () => {
		const cwd = mkdtempSync(join(tmpdir(), "cfg-version-"));
		try {
			const path = join(cwd, configName);
			writeFileSync(path, JSON.stringify({ sandboxLocked: true }));
			expect(loadSandboxConfigFromPath(path)).toBeNull();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("coerces invalid field types to defaults", () => {
		const cwd = mkdtempSync(join(tmpdir(), "cfg-coerce-"));
		try {
			const path = join(cwd, configName);
			writeFileSync(path, JSON.stringify({
				version: 1,
				sandboxLocked: "yes",
				symlinkTargets: [1, "/ok"],
				unlockedPaths: null,
			}));
			expect(loadSandboxConfigFromPath(path)).toEqual({
				version: 1,
				sandboxLocked: true,
				symlinkTargets: ["/ok"],
				unlockedPaths: [],
				savedAt: undefined,
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("applyConfig / currentConfig", () => {
	it("applies a config to live state and snapshots it back", () => {
		applyConfig({
			version: 1,
			sandboxLocked: false,
			symlinkTargets: ["/target"],
			unlockedPaths: ["/unlocked"],
		});
		expect(sandboxState.locked).toBe(false);
		expect([...symlinkTargets]).toEqual(["/target"]);
		expect([...unlockedPaths]).toEqual(["/unlocked"]);

		const snap = currentConfig();
		expect(snap.sandboxLocked).toBe(false);
		expect(snap.symlinkTargets).toEqual(["/target"]);
		expect(snap.unlockedPaths).toEqual(["/unlocked"]);
		expect(snap.savedAt).toBeDefined();
	});
});

describe("global config", () => {
	it("lives under ~/.pi/agent", () => {
		expect(globalConfigPath("/h")).toBe(join("/h", ".pi", "agent", configName));
	});

	it("loads an empty list when the file is missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "cfg-global-"));
		try {
			expect(loadGlobalUnlockedPaths(join(dir, "nope.json"))).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("creates the directory, saves immediately, and dedupes", () => {
		const dir = mkdtempSync(join(tmpdir(), "cfg-global-"));
		const path = join(dir, "nested", "agent", configName);
		try {
			addGlobalUnlockedPath("/a", path);
			addGlobalUnlockedPath("/b", path);
			addGlobalUnlockedPath("/a", path);
			expect(loadGlobalUnlockedPaths(path)).toEqual(["/a", "/b"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stores only unlocked paths, not lock state or symlink targets", () => {
		const dir = mkdtempSync(join(tmpdir(), "cfg-global-"));
		const path = join(dir, configName);
		try {
			addGlobalUnlockedPath("/a", path);
			const raw = JSON.parse(readFileSync(path, "utf8"));
			expect(Object.keys(raw).sort()).toEqual(["savedAt", "unlockedPaths", "version"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses to overwrite an unreadable file", () => {
		const dir = mkdtempSync(join(tmpdir(), "cfg-global-"));
		const path = join(dir, configName);
		try {
			writeFileSync(path, "not json");
			expect(() => addGlobalUnlockedPath("/a", path)).toThrow(/unreadable/);
			expect(readFileSync(path, "utf8")).toBe("not json");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reloads into global state without touching project unlocked paths", () => {
		const dir = mkdtempSync(join(tmpdir(), "cfg-global-"));
		const path = join(dir, configName);
		try {
			unlockedPaths.add("/local");
			addGlobalUnlockedPath("/g1", path);
			reloadGlobalConfig(path);
			addGlobalUnlockedPath("/g2", path);
			reloadGlobalConfig(path);
			expect([...globalUnlockedPaths]).toEqual(["/g1", "/g2"]);
			expect(allUnlockedPaths().sort()).toEqual(["/g1", "/g2", "/local"]);
			// A project snapshot never absorbs the global paths.
			expect(currentConfig().unlockedPaths).toEqual(["/local"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
