/**
 * Sandbox extension wiring: session hooks, tool_call interception, and the
 * slash commands. Pure path logic lives in paths.ts / symlinks.ts; this module
 * only translates events and user commands into sandbox decisions.
 */

import { type ExtensionAPI, type ExtensionContext, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { blockedHistory, recordBlocked, sandboxState, unlockedPaths } from "./state.js";
import { tryRealpath } from "./fs-utils.js";
import { checkBashCommand, checkPath } from "./paths.js";
import { rescanSymlinkTargets } from "./symlinks.js";
import {
	CONFIG_BASENAME,
	applyConfig,
	currentConfig,
	existingConfigPath,
	loadSandboxConfigFromPath,
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
	/** Refresh the footer status line with the current sandbox state. */
	function refreshStatus(ctx: ExtensionContext): void {
		if (ctx.hasUI) {
			ctx.ui.setStatus("sandbox", statusLine());
		}
	}

	// Autoload the saved sandbox config on session start, then announce settings.
	pi.on("session_start", async (event, ctx) => {
		const { configPath, cfg } = restoreOnSessionStart(ctx);
		refreshStatus(ctx);
		if (event.reason === "startup" && ctx.hasUI) {
			ctx.ui.notify(buildBanner(ctx.cwd, configPath, cfg), "info");
		}
	});

	// /unlock-sandbox - disables all sandbox checks
	pi.registerCommand("unlock-sandbox", {
		description: "Disable sandbox restrictions for this session",
		handler: async (_args, ctx) => {
			sandboxState.locked = false;
			ctx.ui.notify("🔓 Sandbox unlocked — all paths are allowed", "info");
			pi.sendMessage({
				customType: "sandbox-paths",
				content: "The sandbox has been unlocked. All paths are now allowed.",
				display: false,
			});
			refreshStatus(ctx);
		},
	});

	// /lock-sandbox - re-enables all sandbox checks
	pi.registerCommand("lock-sandbox", {
		description: "Re-enable sandbox restrictions for this session",
		handler: async (_args, ctx) => {
			sandboxState.locked = true;
			ctx.ui.notify("🔒 Sandbox locked — paths outside sandbox directory are blocked", "info");
			refreshStatus(ctx);
		},
	});

	// /unlock-sandbox-symlinks - allows symlinks inside the sandbox to resolve outside it
	pi.registerCommand("unlock-sandbox-symlinks", {
		description: "Allow symlinks inside the sandbox to resolve outside it (keeps all other checks active)",
		handler: async (_args, ctx) => {
			sandboxState.symlinkMode = true;
			const count = rescanSymlinkTargets(ctx.cwd);
			ctx.ui.notify(
				`🔓 Sandbox symlink mode enabled: ${count} symlink target${count === 1 ? "" : "s"} allowlisted`,
				"info",
			);
			refreshStatus(ctx);
		},
	});

	// /lock-sandbox-symlinks - disables symlink mode
	pi.registerCommand("lock-sandbox-symlinks", {
		description: "Disable symlink mode (re-enable realpath checks)",
		handler: async (_args, ctx) => {
			sandboxState.symlinkMode = false;
			rescanSymlinkTargets(ctx.cwd);
			ctx.ui.notify("🔒 Sandbox symlink mode disabled: symlinks resolving outside the sandbox are blocked", "info");
			refreshStatus(ctx);
		},
	});

	// /save-sandbox-config - persist current sandbox state to disk
	pi.registerCommand("save-sandbox-config", {
		description: "Save current sandbox state (lock, symlink mode, allowlisted targets) to the sandbox config file",
		handler: async (_args, ctx) => {
			// Re-scan symlink targets first so the saved snapshot is current.
			if (sandboxState.symlinkMode) {
				rescanSymlinkTargets(ctx.cwd);
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

	// /unlock-last-path - allow the most recently blocked path (or nth-to-last)
	pi.registerCommand("unlock-last-path", {
		description: "Allow the most recently blocked sandbox path, or the nth-to-last when given a number (e.g. /unlock-last-path 2)",
		handler: async (args, ctx) => {
			const arg = args.trim();
			const n = arg.length > 0 ? parseInt(arg, 10) : 1;
			if (!Number.isInteger(n) || n < 1) {
				ctx.ui.notify(`Invalid argument "${arg}": expected a positive integer (1 = last blocked, 2 = second-to-last, ...)`, "error");
				return;
			}
			if (blockedHistory.length === 0) {
				ctx.ui.notify("No blocked paths recorded yet. The sandbox records a path each time it blocks a tool.", "warning");
				return;
			}
			const idx = blockedHistory.length - n;
			if (idx < 0) {
				ctx.ui.notify(`No blocked path at position ${n} (only ${blockedHistory.length} recorded). Use /sandbox-blocked to list them.`, "warning");
				return;
			}
			const entry = blockedHistory[idx];
			unlockedPaths.add(entry.path);
			ctx.ui.notify(
				`🔓 Unblocked: ${displayPath(entry.path)}\n` +
				`   blocked by ${entry.tool} (${ageMs(entry.timestamp)} ago), source: "${entry.original}"\n` +
				`   Run /save-sandbox-config to persist across sessions.`,
				"info",
			);
			pi.sendMessage({
				customType: "sandbox-paths",
				content:
					`The sandbox has unlocked the path "${displayPath(entry.path)}". ` +
					"Access to this path is now allowed.",
				display: false,
			});
			refreshStatus(ctx);
		},
	});

	// /sandbox-blocked - list recently blocked paths
	pi.registerCommand("sandbox-blocked", {
		description: "List recently blocked sandbox paths (newest last) with their /unlock-last-path index",
		handler: async (_args, ctx) => {
			if (blockedHistory.length === 0) {
				ctx.ui.notify("No blocked paths recorded yet.", "info");
				return;
			}
			const lines: string[] = [`Recent blocked paths (${blockedHistory.length}, newest last):`];
			const start = Math.max(0, blockedHistory.length - 20);
			for (let i = blockedHistory.length - 1, pos = 1; i >= start; i--, pos++) {
				const e = blockedHistory[i];
				const tag = unlockedPaths.has(e.path) ? " [unlocked]" : "";
				lines.push(`  [${pos}] ${displayPath(e.path)}  (${e.tool}, ${ageMs(e.timestamp)} ago, src: "${e.original}")${tag}`);
			}
			lines.push("Use /unlock-last-path [n] to allow a path (default n=1, the newest).");
			ctx.ui.notify(lines.join("\n"), "info");
		},
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

		if (isToolCallEventType("read", event) || isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			const path = event.input.path as string;
			const result = checkPath(path, ctx.cwd);

			if (!result.allowed) {
				recordBlocked(path, result.resolved ?? path, event.toolName, tryRealpath);
				if (ctx.hasUI) {
					ctx.ui.notify(`Sandbox blocked: ${event.toolName} to "${path}"`, "warning");
				}
				return { block: true, reason: result.reason };
			}
			return undefined;
		}

		if (isToolCallEventType("bash", event)) {
			const command = event.input.command as string;
			const result = checkBashCommand(command, ctx.cwd);

			if (!result.allowed) {
				recordBlocked(result.original ?? command, result.resolved ?? "", event.toolName, tryRealpath);
				if (ctx.hasUI) {
					ctx.ui.notify(`Sandbox blocked bash command: ${result.reason}`, "warning");
				}
				return { block: true, reason: result.reason };
			}
			return undefined;
		}

		if (isToolCallEventType("grep", event) || isToolCallEventType("find", event) || isToolCallEventType("ls", event)) {
			const input = event.input as { path?: string; scope?: string };
			const target = input.path ?? input.scope;
			if (target) {
				const result = checkPath(target, ctx.cwd);
				if (!result.allowed) {
					recordBlocked(target, result.resolved ?? target, event.toolName, tryRealpath);
					if (ctx.hasUI) {
						ctx.ui.notify(`Sandbox blocked: ${event.toolName} path "${target}"`, "warning");
					}
					return { block: true, reason: result.reason };
				}
			}
			return undefined;
		}

		return undefined;
	});
}
