/**
 * Sandbox extension wiring: session hooks, the OS-sandboxed bash tool,
 * in-process tool_call interception for path-based tools, the slash commands,
 * and the factory-time subscription to the pi-sandbox:allow-path event
 * (handled in registry.ts) so extensions without an import can allow extra
 * directories. Kernel confinement lives in os-sandbox.ts; path decisions for
 * pi's own tools live in paths.ts.
 */

import { type ExtensionAPI, type ExtensionContext, createBashTool, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { allUnlockedPaths, blockedHistory, extensionPaths, recordBlocked, sandboxState, symlinkTargets, unlockedPaths } from "./state.js";
import { isUnderRealPrefix, tryRealpath } from "./fs-utils.js";
import { checkPath, unlockTargetFor } from "./paths.js";
import { subscribeAllowPathEvent, validExtensionPaths } from "./registry.js";
import { collectSymlinkTargets } from "./symlinks.js";
import { extractDeniedHomePaths } from "./denials.js";
import { appendJournalEntry, readJournal, removeJournalPath, type JournalEntry } from "./journal.js";
import { detectOsSandbox, type ProfileInput } from "./os-sandbox.js";
import {
	CONFIG_BASENAME,
	addGlobalUnlockedPath,
	applyConfig,
	currentConfig,
	existingConfigPath,
	loadSandboxConfigFromPath,
	globalConfigPath,
	reloadGlobalConfig,
	saveSandboxConfig,
} from "./config.js";
import { ageMs, buildBanner, displayPath, statusLine } from "./display.js";

/** Load the saved config (if any) and apply it to the live sandbox state. */
function restoreOnSessionStart(ctx: ExtensionContext): { configPath: string | null; cfg: ReturnType<typeof loadSandboxConfigFromPath> } {
	const configPath = existingConfigPath(ctx.cwd);
	const cfg = configPath ? loadSandboxConfigFromPath(configPath) : null;
	if (cfg) {
		applyConfig(cfg);
	}
	return { configPath, cfg };
}

export default function registerSandbox(pi: ExtensionAPI): void {
	// Tracks the most recent session context so factory-time event handlers
	// can refresh UI state without waiting for a new session_start.
	let currentCtx: ExtensionContext | undefined;

	/** Refresh the footer status line with the current sandbox state. */
	function refreshStatus(ctx: ExtensionContext): void {
		if (ctx.hasUI) {
			const line = statusLine();
			ctx.ui.setStatus("sandbox", sandboxState.locked ? line : ctx.ui.theme.fg("error", line));
		}
	}

	/** Assemble the profile inputs for a sandboxed command run. */
	function profileInputFor(cwd: string): ProfileInput {
		return {
			sandboxDir: cwd,
			readWritePaths: [...symlinkTargets, ...allUnlockedPaths(), ...validExtensionPaths()],
		};
	}

	const osSandbox = detectOsSandbox();

	/**
	 * Record a blocked path in the in-memory history and in the persistent
	 * journal (~/.pi/agent/sandbox-blocked.jsonl) so it survives the session.
	 */
	function recordAndJournal(original: string, resolved: string, tool: string): void {
		recordBlocked(original, resolved, tool, tryRealpath);
		const entry: JournalEntry = { path: tryRealpath(resolved), original, tool, timestamp: Date.now() };
		try {
			appendJournalEntry(entry);
		} catch {
			// Journal write failures must not break the block itself.
		}
	}

	// Subscribe to allow-path events from other pi extensions at factory time.
	// All extension factories run before any session_start fires, so this
	// covers every load order. pi's loader unsubscribes automatically on reload
	// via trackEventBusSubscription.
	subscribeAllowPathEvent(pi.events, (_path) => {
		if (currentCtx) {
			refreshStatus(currentCtx);
		}
	}, (reason) => {
		if (currentCtx?.hasUI) {
			currentCtx.ui.notify(`pi-sandbox: allow-path event rejected: ${reason}`, "warning");
		}
	});

	// Override the built-in bash tool so every command runs inside the OS
	// sandbox. Programs stay runnable; only file access is filtered.
	// Symlink targets are allowlisted once at session start (and by
	// /sandbox-save-config). Re-scanning here would let an agent allowlist
	// any path it can name by creating a symlink to it in its own arena.
	const bashTool = createBashTool(process.cwd(), {
		spawnHook: ({ command, cwd, env }) => {
			if (!sandboxState.locked) {
				return { command, cwd, env };
			}
			if (!osSandbox || !osSandbox.available) {
				const what = osSandbox?.kind === "landlock" ? "bubblewrap or Landlock" : "the OS sandbox";
				const why = osSandbox?.unavailableReason ? `: ${osSandbox.unavailableReason}` : "";
				throw new Error(
					`Sandbox blocked: ${what} is not available on this platform${why}. ` +
					"Install it, or disable confinement with /sandbox-unlock.",
				);
			}
			return { command: osSandbox.wrap(command, profileInputFor(cwd)), cwd, env };
		},
	});
	pi.registerTool({
		...bashTool,
		execute: (id, params, signal, onUpdate, _ctx) => bashTool.execute(id, params, signal, onUpdate),
	});

	// Autoload the saved sandbox config on session start, then announce settings.
	pi.on("session_start", async (event, ctx) => {
		currentCtx = ctx;
		const { configPath, cfg } = restoreOnSessionStart(ctx);
		try {
			reloadGlobalConfig();
		} catch (err) {
			ctx.ui.notify(err instanceof Error ? err.message : String(err), "warning");
		}
		for (const target of collectSymlinkTargets(ctx.cwd)) {
			symlinkTargets.add(target);
		}
		refreshStatus(ctx);
		if (event.reason === "startup" && ctx.hasUI) {
			ctx.ui.notify(buildBanner(ctx.cwd, configPath, cfg), "info");
		}
	});

	// /sandbox-unlock - disables all sandbox checks
	pi.registerCommand("sandbox-unlock", {
		description: "Disable sandbox restrictions for this session",
		handler: async (_args, ctx) => {
			sandboxState.locked = false;
			ctx.ui.notify("🔓 Sandbox unlocked — all paths are allowed", "info");
			pi.sendMessage({
				customType: "sandbox-paths",
				content: "The sandbox has been unlocked. All paths are now allowed.",
				display: false,
			}, { deliverAs: "followUp", triggerTurn: true });
			refreshStatus(ctx);
		},
	});

	// /sandbox-lock - re-enables all sandbox checks
	pi.registerCommand("sandbox-lock", {
		description: "Re-enable sandbox restrictions for this session",
		handler: async (_args, ctx) => {
			sandboxState.locked = true;
			ctx.ui.notify("🔒 Sandbox locked — paths outside the sandbox are blocked", "info");
			refreshStatus(ctx);
		},
	});

	// /sandbox-save-config - persist current sandbox state to disk
	pi.registerCommand("sandbox-save-config", {
		description: "Save current sandbox state (lock state, allowlisted symlink targets, unlocked paths) to the sandbox config file",
		handler: async (_args, ctx) => {
			// Re-scan symlink targets first so the saved snapshot is current.
			for (const target of collectSymlinkTargets(ctx.cwd)) {
				symlinkTargets.add(target);
			}
			try {
				const path = saveSandboxConfig(ctx.cwd, currentConfig());
				ctx.ui.notify(`💾 Sandbox config saved to ${path}`, "info");
			} catch (err) {
				ctx.ui.notify(`Failed to save sandbox config: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
			refreshStatus(ctx);
		},
	});

	/**
	 * Add `target` to the unlocked paths. With `global` set, the path is saved
	 * to the global config at once and reloaded; otherwise it is kept for this
	 * session until /sandbox-save-config.
	 * @throws Error when the global config cannot be read or written.
	 */
	function applyUnlock(target: string, global: boolean): void {
		if (global) {
			addGlobalUnlockedPath(target);
			reloadGlobalConfig();
		} else {
			unlockedPaths.add(target);
			symlinkTargets.add(target);
		}
	}

	/**
	 * Unlock the nth most recently blocked path. With `global` set, the path is
	 * saved to the global config at once and reloaded; otherwise it is kept for
	 * this session until /sandbox-save-config.
	 */
	function unlockBlockedPath(args: string, ctx: ExtensionContext, global: boolean): void {
		const command = global ? "/sandbox-unlock-last-path-globally" : "/sandbox-unlock-last-path";
		const arg = args.trim();
		const n = arg.length > 0 ? parseInt(arg, 10) : 1;
		if (!Number.isInteger(n) || n < 1) {
			ctx.ui.notify(`Invalid argument "${arg}": expected a positive integer (1 = last blocked, 2 = second-to-last, ...)`, "error");
			return;
		}
		if (blockedHistory.length === 0) {
			ctx.ui.notify("No blocked paths recorded yet. The sandbox records a path when a path tool is blocked or when bash output shows a denied path under your home directory.", "warning");
			return;
		}
		const idx = blockedHistory.length - n;
		if (idx < 0) {
			ctx.ui.notify(`No blocked path at position ${n} (only ${blockedHistory.length} recorded). Use /sandbox-blocked to list them.`, "warning");
			return;
		}
		const entry = blockedHistory[idx];
		// Directory blocks unlock the directory itself; file blocks unlock
		// the parent directory so the whole subtree becomes reachable.
		const target = unlockTargetFor(entry.path);
		try {
			applyUnlock(target, global);
		} catch (err) {
			ctx.ui.notify(`${command} failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			return;
		}
		const unlockedLine = target === entry.path
			? `🔓 Unlocked${global ? " globally" : ""}: ${displayPath(entry.path)}`
			: `🔓 Unlocked${global ? " globally" : ""}: ${displayPath(target)} (parent directory of ${displayPath(entry.path)})`;
		const persistLine = global
			? `   Saved to ${displayPath(globalConfigPath())}; applies to every project.`
			: "   Run /sandbox-save-config to persist across sessions.";
		ctx.ui.notify(
			`${unlockedLine}\n` +
			`   blocked by ${entry.tool} (${ageMs(entry.timestamp)} ago), source: "${entry.original}"\n` +
			persistLine,
			"info",
		);
		pi.sendMessage({
			customType: "sandbox-paths",
			content:
				`The sandbox has unlocked the path "${displayPath(target)}". ` +
				"Access to this directory and everything under it is now allowed.",
			display: false,
		}, { deliverAs: "followUp", triggerTurn: true });
		refreshStatus(ctx);
	}

	// /sandbox-unlock-last-path - unlock the directory of the most recently blocked path (or nth-to-last)
	pi.registerCommand("sandbox-unlock-last-path", {
		description: "Unlock the directory of the most recently blocked sandbox path, or the nth-to-last when given a number (e.g. /sandbox-unlock-last-path 2). Blocked files unlock their parent directory",
		handler: async (args, ctx) => unlockBlockedPath(args, ctx, false),
	});

	// /sandbox-unlock-last-path-globally - same, but saved to the global config for every project
	pi.registerCommand("sandbox-unlock-last-path-globally", {
		description: "Like /sandbox-unlock-last-path, but saves the unlocked directory to the global sandbox config in ~/.pi/agent so it applies to every project",
		handler: async (args, ctx) => unlockBlockedPath(args, ctx, true),
	});

	// /sandbox-blocked - list recently blocked paths
	pi.registerCommand("sandbox-blocked", {
		description: "List recently blocked sandbox paths (newest last) with their /sandbox-unlock-last-path index",
		handler: async (_args, ctx) => {
			if (blockedHistory.length === 0) {
				ctx.ui.notify("No blocked paths recorded yet.", "info");
				return;
			}
			const lines: string[] = [`Recent blocked paths (${blockedHistory.length}, newest last):`];
			const start = Math.max(0, blockedHistory.length - 20);
			for (let i = blockedHistory.length - 1, pos = 1; i >= start; i--, pos++) {
				const e = blockedHistory[i];
				const tag = [...allUnlockedPaths(), ...extensionPaths].some((p) => isUnderRealPrefix(e.path, p)) ? " [unlocked]" : "";
				lines.push(`  [${pos}] ${displayPath(e.path)}  (${e.tool}, ${ageMs(e.timestamp)} ago, src: "${e.original}")${tag}`);
			}
			lines.push("Use /sandbox-unlock-last-path [n] to allow a path (default n=1, the newest).");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// /sandbox-paths - pick a recently blocked path from the persistent journal and unblock it
	pi.registerCommand("sandbox-paths", {
		description: "Browse the last blocked paths (from ~/.pi/agent/sandbox-blocked.jsonl, newest first) with arrow keys and unblock one globally or locally",
		handler: async (_args, ctx) => {
			const entries = readJournal(100);
			if (entries.length === 0) {
				ctx.ui.notify("No blocked paths in the journal yet (/Users/arivera/.pi/agent/sandbox-blocked.jsonl).", "info");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("/sandbox-paths needs the interactive UI to show the picker", "warning");
				return;
			}

			// Pages of 20, newest page first; index 0 = newest entry.
			const newestFirst = [...entries].reverse();
			const PAGE_SIZE = 20;
			let pageIndex = 0;

			let picked: number | undefined;
			for (;;) {
				const page = newestFirst.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE);
				const options = page.map((e, i) => `[${pageIndex * PAGE_SIZE + i + 1}] ${displayPath(e.path)}  (${e.tool}, ${ageMs(e.timestamp)} ago)`);
				if ((pageIndex + 1) * PAGE_SIZE < newestFirst.length) {
					options.push(`▼ ${Math.min(PAGE_SIZE, newestFirst.length - (pageIndex + 1) * PAGE_SIZE)} older paths`);
				}
				const choice = await ctx.ui.select(`Blocked paths (page ${pageIndex + 1})`, options);
				if (choice === undefined) {
					return;
				}
				const listIndex = options.indexOf(choice);
				if (listIndex === options.length - 1 && listIndex >= PAGE_SIZE) {
					pageIndex++;
					continue;
				}
				picked = pageIndex * PAGE_SIZE + listIndex;
				break;
			}

			const entry = newestFirst[picked];
			const scope = await ctx.ui.select(`Unblock ${displayPath(entry.path)}`, [
				"Locally (this project only)",
				"Globally (every project)",
				"Cancel",
			]);
			if (scope === undefined || scope === "Cancel") {
				return;
			}
			const global = scope === "Globally (every project)";
			const target = unlockTargetFor(entry.path);
			try {
				applyUnlock(target, global);
			} catch (err) {
				ctx.ui.notify(`/sandbox-paths failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}
			try {
				removeJournalPath(target);
			} catch {
				// Journal cleanup is best-effort.
			}
			ctx.ui.notify(
				`🔓 Unlocked${global ? " globally" : ""}: ${displayPath(target)}\n` +
				`   blocked by ${entry.tool}, src: "${entry.original}"`,
				"info",
			);
			pi.sendMessage({
				customType: "sandbox-paths",
				content: `The sandbox has unlocked the path "${displayPath(target)}". Access to this directory and everything under it is now allowed.`,
				display: false,
			}, { deliverAs: "followUp", triggerTurn: true });
			refreshStatus(ctx);
		},
	});

	// The kernel denies bash file access without telling pi, so read the denied
	// paths back out of the command's error output for /sandbox-unlock-last-path.
	pi.on("tool_result", async (event) => {
		if (!sandboxState.locked || event.toolName !== "bash") {
			return undefined;
		}
		const text = event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		for (const path of extractDeniedHomePaths(text)) {
			recordAndJournal(path, path, "bash");
		}
		if (currentCtx) {
			refreshStatus(currentCtx);
		}
		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		// When unlocked, skip all sandbox checks
		if (!sandboxState.locked) {
			return undefined;
		}

		// The sandbox config file is a trust anchor: only slash commands may
		// write it (via the in-process saveSandboxConfig helper, which does not
		// flow through tool_call). Block any tool whose input references it.
		if (JSON.stringify(event.input).includes(CONFIG_BASENAME)) {
			const reason = `Sandbox blocked: ${CONFIG_BASENAME} is managed by slash commands, not tools`;
			if (ctx.hasUI) {
				ctx.ui.notify(reason, "warning");
			}
			return { block: true, reason };
		}

		// The bash tool runs under the OS sandbox via its spawnHook; no text
		// check applies here. These are pi's in-process path tools.
		if (isToolCallEventType("read", event) || isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			const path = event.input.path as string;
			const result = checkPath(path, ctx.cwd, event.toolName === "read" ? "read" : "write");

			if (!result.allowed) {
				recordAndJournal(path, result.resolved ?? path, event.toolName);
				if (ctx.hasUI) {
					ctx.ui.notify(`Sandbox blocked: ${event.toolName} to "${path}"`, "warning");
				}
				refreshStatus(ctx);
				return { block: true, reason: result.reason };
			}
			return undefined;
		}

		if (isToolCallEventType("grep", event) || isToolCallEventType("find", event) || isToolCallEventType("ls", event)) {
			const input = event.input as { path?: string; scope?: string };
			const target = input.path ?? input.scope;
			if (target) {
				const result = checkPath(target, ctx.cwd, "read");
				if (!result.allowed) {
					recordAndJournal(target, result.resolved ?? target, event.toolName);
					if (ctx.hasUI) {
						ctx.ui.notify(`Sandbox blocked: ${event.toolName} path "${target}"`, "warning");
					}
					refreshStatus(ctx);
					return { block: true, reason: result.reason };
				}
			}
			return undefined;
		}

		return undefined;
	});
}
