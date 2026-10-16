import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPath, isAllowedPath } from "./paths.js";
import {
	ALLOW_PATH_EVENT,
	handleAllowPathEvent,
	registerAllowedPath,
	registeredAllowedPaths,
	subscribeAllowPathEvent,
	validExtensionPaths,
	type AllowPathEventBus,
} from "./registry.js";
import { buildBwrapArgs, buildLandlockArgs, buildSeatbeltProfile } from "./os-sandbox.js";
import { extensionPaths, globalUnlockedPaths, HOME, resetState, sandboxState } from "./state.js";

// sandboxDir acts as the sandbox root; outsideDir sits next to it under the
// repo cwd, so checkPath must block it until it is registered. (Not under
// HOME: /var/folders-style tmpdirs are prefix-allowed on macOS, and this
// session's own sandbox blocks writes to HOME.)
let sandboxDir: string;
let outsideDir: string;

beforeEach(() => {
	resetState();
	sandboxDir = mkdtempSync(join(tmpdir(), "sbx-root-"));
	outsideDir = mkdtempSync(join(process.cwd(), "sbx-out-"));
});

afterEach(() => {
	rmSync(sandboxDir, { recursive: true, force: true });
	rmSync(outsideDir, { recursive: true, force: true });
});

describe("registerAllowedPath", () => {
	it("resolves and stores the path", () => {
		const returned = registerAllowedPath(outsideDir);
		expect(returned).toBe(outsideDir);
		expect(registeredAllowedPaths()).toEqual([outsideDir]);
	});

	it("rejects relative paths", () => {
		expect(() => registerAllowedPath("relative/dir")).toThrow(/absolute or tilde/);
	});

	it("is idempotent for the same path", () => {
		registerAllowedPath(outsideDir);
		registerAllowedPath(outsideDir);
		expect(registeredAllowedPaths()).toHaveLength(1);
	});

	it("skips a child under an already-registered parent", () => {
		const child = join(outsideDir, "child");
		mkdirSync(child);
		registerAllowedPath(outsideDir);
		expect(registerAllowedPath(child)).toBe(outsideDir);
		expect(registeredAllowedPaths()).toEqual([outsideDir]);
	});

	it("drops registered children when a parent is registered", () => {
		const child = join(outsideDir, "child");
		mkdirSync(child);
		registerAllowedPath(child);
		registerAllowedPath(outsideDir);
		expect(registeredAllowedPaths()).toEqual([outsideDir]);
	});
});

describe("allow-path event", () => {
	it("registers an absolute path and returns the same path as direct registration", () => {
		const directPath = registerAllowedPath(outsideDir);
		resetState();
		const result = handleAllowPathEvent({ path: outsideDir });
		expect(result).toEqual({ ok: true, path: directPath });
		expect(registeredAllowedPaths()).toEqual([directPath]);
	});

	it("expands a tilde path against HOME", () => {
		const tildePath = "~/";
		const result = handleAllowPathEvent({ path: tildePath });
		expect(result).toEqual({ ok: true, path: HOME });
		expect(registeredAllowedPaths()).toEqual([HOME]);
	});

	it.each([
		["null", null],
		["a non-object payload", "not an object"],
		["a missing path", {}],
		["a non-string path", { path: 42 }],
		["an empty path", { path: "" }],
		["a relative path", { path: "relative/dir" }],
	])("rejects %s without changing the registry", (_label, payload) => {
		const result = handleAllowPathEvent(payload);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toEqual(expect.any(String));
		expect(registeredAllowedPaths()).toEqual([]);
	});

	it("subscribes on the literal event channel and routes results", () => {
		const handlers = new Map<string, (data: unknown) => void>();
		const channels: string[] = [];
		const bus: AllowPathEventBus = {
			on(channel, handler) {
				channels.push(channel);
				handlers.set(channel, handler);
				return () => handlers.delete(channel);
			},
		};
		const registered: string[] = [];
		const rejected: string[] = [];
		subscribeAllowPathEvent(bus, (path) => registered.push(path), (reason) => rejected.push(reason));

		expect(ALLOW_PATH_EVENT).toBe("pi-sandbox:allow-path");
		expect(channels).toEqual(["pi-sandbox:allow-path"]);
		handlers.get("pi-sandbox:allow-path")?.({ path: outsideDir });
		handlers.get("pi-sandbox:allow-path")?.({ path: "relative/dir" });
		expect(registered).toEqual([outsideDir]);
		expect(rejected).toHaveLength(1);
		expect(rejected[0]).toMatch(/absolute or tilde/);
	});

	it("unsubscribes so later events do nothing", () => {
		let handler: ((data: unknown) => void) | undefined;
		const bus: AllowPathEventBus = {
			on(_channel, listener) {
				handler = listener;
				return () => {
					handler = undefined;
				};
			},
		};
		const registered: string[] = [];
		const unsubscribe = subscribeAllowPathEvent(bus, (path) => registered.push(path), () => {});
		handler?.({ path: outsideDir });
		unsubscribe();
		handler?.({ path: outsideDir });
		expect(registered).toEqual([outsideDir]);
	});

	it("notifies on every duplicate event while registry storage stays deduplicated", () => {
		let handler: ((data: unknown) => void) | undefined;
		const bus: AllowPathEventBus = {
			on(_channel, listener) {
				handler = listener;
				return () => {
					handler = undefined;
				};
			},
		};
		const registered: string[] = [];
		subscribeAllowPathEvent(bus, (path) => registered.push(path), () => {});
		handler?.({ path: outsideDir });
		handler?.({ path: outsideDir });
		expect(registered).toEqual([outsideDir, outsideDir]);
		expect(registeredAllowedPaths()).toEqual([outsideDir]);
	});
});

describe("extension paths allow in-process tool access", () => {
	it("blocks an outside dir without registration", () => {
		const file = join(outsideDir, "f.txt");
		writeFileSync(file, "x");
		expect(checkPath(file, sandboxDir).allowed).toBe(false);
	});

	it("allows an outside dir after registration, for read and write", () => {
		registerAllowedPath(outsideDir);
		expect(checkPath(join(outsideDir, "f.txt"), sandboxDir).allowed).toBe(true);
		expect(checkPath(join(outsideDir, "f.txt"), sandboxDir, "read").allowed).toBe(true);
		expect(isAllowedPath(join(outsideDir, "newfile.txt"))).toBe(true);
	});

	it("allows only paths under the registered dir", () => {
		registerAllowedPath(outsideDir);
		expect(isAllowedPath("/etc/passwd")).toBe(false);
	});

	it("allows through a symlink pointing into the registered dir", () => {
		registerAllowedPath(outsideDir);
		const link = join(sandboxDir, "link");
		symlinkSync(outsideDir, link);
		expect(sandboxState.locked).toBe(true);
		expect(checkPath(join(link, "f.txt"), sandboxDir).allowed).toBe(true);
	});
});

describe("resetState", () => {
	it("clears extension paths and global unlocked paths", () => {
		registerAllowedPath(outsideDir);
		globalUnlockedPaths.add("/some/global/path");
		resetState();
		expect(extensionPaths.size).toBe(0);
		expect(globalUnlockedPaths.size).toBe(0);
	});
});

describe("input validation", () => {
	it("rejects ~username tilde forms that expandTilde cannot expand", () => {
		expect(() => registerAllowedPath("~nosuchuser")).toThrow(/absolute or tilde/);
	});
});

describe("symlink swap protections", () => {
	it("drops a registered root that was replaced by a symlink (fail closed)", () => {
		const swapped = mkdtempSync(join(process.cwd(), "sbx-swap-"));
		const other = mkdtempSync(join(process.cwd(), "sbx-other-"));
		try {
			registerAllowedPath(swapped);
			expect(validExtensionPaths()).toEqual([swapped]);
			rmSync(swapped, { recursive: true, force: true });
			symlinkSync(other, swapped);
			expect(validExtensionPaths()).toEqual([]);
			expect(checkPath(join(swapped, "secret.txt"), sandboxDir).allowed).toBe(false);
		} finally {
			rmSync(other, { recursive: true, force: true });
			rmSync(swapped, { recursive: true, force: true, });
		}
	});

	it("blocks a symlink inside a registered root pointing outside it", () => {
		const outside = mkdtempSync(join(process.cwd(), "sbx-escape-"));
		try {
			registerAllowedPath(outsideDir);
			const link = join(outsideDir, "l");
			symlinkSync(outside, link);
			writeFileSync(join(outside, "id_rsa"), "x");
			expect(checkPath(join(link, "id_rsa"), sandboxDir).allowed).toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("os sandbox profiles include extension paths", () => {
	it("flows registered paths into seatbelt, bwrap, and landlock builders", () => {
		registerAllowedPath(outsideDir);
		const input = { sandboxDir: sandboxDir, readWritePaths: [outsideDir] };
		expect(buildSeatbeltProfile(input)).toContain(`(subpath "${outsideDir}")`);
		expect(buildBwrapArgs(input)).toContain("--bind-try");
		expect(buildBwrapArgs(input).join(" ")).toContain(outsideDir);
		expect(buildLandlockArgs(input).join(" ")).toContain(outsideDir);
	});
});
