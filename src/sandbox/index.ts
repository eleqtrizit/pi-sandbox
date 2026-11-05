/**
 * Sandbox extension wiring: session hooks, the OS-sandboxed bash tool,
 * in-process tool_call interception for path-based tools, the slash commands,
 * and the factory-time subscription to the pi-sandbox:allow-path event
 * (handled in registry.ts) so extensions without an import can allow extra
 * directories. Kernel confinement lives in os-sandbox.ts; path decisions for
 * pi's own tools live in paths.ts.
 */

import { type ExtensionAPI, type ExtensionContext, createBashTool, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { allUnlockedPaths, blockedHistory, globalUnlockedPaths, recordBlocked, sandboxState, symlinkTargets, unlockedPaths } from "./state.js";
import { tryRealpath } from "./fs-utils.js";
import { checkPath } from "./paths.js";
import { subscribeAllowPathEvent, validExtensionPaths } from "./registry.js";
import { collectSymlinkTargets } from "./symlinks.js";
import { extractDeniedHomePaths } from "./denials.js";
import { appendJournalEntry, readJournal, removeJournalPath, type JournalEntry } from "./journal.js";
import { detectOsSandbox, type ProfileInput } from "./os-sandbox.js";
import { buildPickerRows, UnblockPicker, type UnlockPlan } from "./picker.js";
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
import { buildBanner, displayPath, statusLine } from "./display.js";

/** Sandbox-root paragraph prepended to the system prompt so the agent knows its confinement. */
export function sandboxSystemPromptAddendum(sandboxRoot: string): string {
	return (
		`At session start, you are sandboxed into ${sandboxRoot}. ` +
		"Directories referenced outside this path may exist, but you cannot see them. " +
		"IF the user directs you to a path outside of your sandbox, stop and ask the user to use " +
		"/sandbox-unblock-paths (or /sandbox-unlock to disable the sandbox). " +
		"You will get prompts that tell you of updated access to other directories."
	);
}

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
	// Symlink targets are allowlisted once at session start (and on exit of
	// /sandbox-unblock-paths). Re-scanning here would let an agent allowlist
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
		rescanSymlinkTargets(ctx.cwd);
		refreshStatus(ctx);
		if (event.reason === "startup" && ctx.hasUI) {
			ctx.ui.notify(buildBanner(ctx.cwd, configPath, cfg), "info");
		}
	});

	// Prepend the sandbox confinement paragraph to the system prompt for every
	// run. Recomputed from the fresh prompt each run, so unlock prompts (sent as
	// user messages) remain the channel for access updates; the static text never
	// changes after start.
	pi.on("before_agent_start", async (event) => ({
		systemPrompt: `${sandboxSystemPromptAddendum(process.cwd())}\n\n${event.systemPrompt}`,
	}));

	// /sandbox-unblock-paths - the single path-access picker: browse globally
	// unlocked, repo-config unlocked, and the 10 most recently blocked paths,
	// mark entries to unblock as t (session), r (repo config), or g (global
	// config); Enter applies and saves, Escape cancels.
	pi.registerCommand("sandbox-unblock-paths", {
		description: "Browse blocked and unlocked paths; mark entries to unblock (t = this session, r = repo config, g = global config). Enter applies and saves; Escape cancels",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/sandbox-unblock-paths needs the interactive UI to show the picker.", "warning");
				return;
			}
			const rows = buildPickerRows({
				journal: readJournal(100),
				history: blockedHistory,
				alreadyUnlocked: [...allUnlockedPaths(), ...validExtensionPaths()],
				repoPaths: [...unlockedPaths],
				globalPaths: [...globalUnlockedPaths],
			});
			if (rows.length === 0) {
				ctx.ui.notify("Nothing to show: no blocked, repo-unlocked, or globally unlocked paths yet.", "info");
				return;
			}
			const plan = await ctx.ui.custom<UnlockPlan | undefined>(
				(tui, theme, _keybindings, done) =>
					new UnblockPicker(theme, done, rows, () => tui.terminal.rows - 2),
				{ overlay: true },
			);
			if (plan === undefined) {
				// Escape: marks discarded, nothing saved.
				ctx.ui.notify("Sandbox picker cancelled — nothing changed.", "info");
				return;
			}
			const { lines, hadError, applied } = applyUnlockPlan(ctx.cwd, plan);
			ctx.ui.notify(lines.join("\n"), hadError ? "error" : "info");
			if (applied.length > 0) {
				pi.sendMessage({
					customType: "sandbox-paths",
					content:
						`The sandbox has unlocked the following directories; everything under them is now allowed: ` +
						applied.map((p) => displayPath(p)).join(", "),
					display: false,
				}, { deliverAs: "followUp", triggerTurn: true });
			}
			refreshStatus(ctx);
		},
	});

	// /sandbox-unlock - disables all sandbox checks; a picker decides whether
	// the unlock is temporary (session only, never written to any config) or
	// permanent (saved to the project config at once).
	pi.registerCommand("sandbox-unlock", {
		description: "Disable all sandbox checks; pick Temporary (this session only, not saved) or Permanent (saved to the project config)",
		handler: async (_args, ctx) => {
			const TEMPORARY = "Temporary — this session only, not saved";
			const PERMANENT = "Permanent — saved to the project config";
			let permanent = false;
			if (ctx.hasUI) {
				const choice = await ctx.ui.select("Unlock the sandbox", [TEMPORARY, PERMANENT]);
				if (choice === undefined) {
					ctx.ui.notify("Cancelled — the sandbox stays locked.", "info");
					return;
				}
				permanent = choice === PERMANENT;
			}
			// Without a UI to pick in, default to the session-only unlock.
			sandboxState.locked = false;
			sandboxState.temporaryUnlock = !permanent;
			if (permanent) {
				try {
					rescanSymlinkTargets(ctx.cwd);
					const path = saveSandboxConfig(ctx.cwd, currentConfig());
					ctx.ui.notify(`🔓 Sandbox unlocked permanently — saved to ${displayPath(path)}`, "info");
				} catch (err) {
					// The unlock still applies, but a failed save must not let
					// a later snapshot save promote it to permanent.
					sandboxState.temporaryUnlock = true;
					ctx.ui.notify(
						`🔓 Sandbox unlocked for this session — saving the config failed: ${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
				}
			} else {
				ctx.ui.notify("🔓 Sandbox unlocked for this session — nothing saved", "info");
			}
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
			// Locking supersedes any unlock, temporary or permanent.
			sandboxState.temporaryUnlock = false;
			ctx.ui.notify("🔒 Sandbox locked — paths outside the sandbox are blocked", "info");
			refreshStatus(ctx);
		},
	});

	/** Extend the symlink-target scan with the targets that exist right now. */
	function rescanSymlinkTargets(cwd: string): void {
		for (const target of collectSymlinkTargets(cwd)) {
			symlinkTargets.add(target);
		}
	}

	/**
	 * Apply an unlock plan from /sandbox-unblock-paths and persist the sandbox
	 * state. Repo marks land in the project config through the saved snapshot,
	 * global marks in the global config file, and temporary marks stay
	 * session-only. Enter in the picker saves unconditionally, which folds the
	 * old /sandbox-save-config command into this one.
	 */
	function applyUnlockPlan(cwd: string, plan: UnlockPlan): { lines: string[]; hadError: boolean; applied: string[] } {
		const lines: string[] = [];
		let hadError = false;

		// Re-scan symlink targets first so the saved snapshot is current.
		rescanSymlinkTargets(cwd);

		// Repo marks join unlockedPaths before the save, so the project
		// config snapshot picks them up.
		for (const target of plan.repo) {
			unlockedPaths.add(target);
		}

		// Global marks write through to the global config immediately, then
		// reload. A failure throws before globalUnlockedPaths is touched, so
		// the live set only reflects paths really saved to disk.
		const globalApplied: string[] = [];
		try {
			for (const target of plan.global) {
				addGlobalUnlockedPath(target);
			}
			reloadGlobalConfig();
			globalApplied.push(...plan.global);
		} catch (err) {
			hadError = true;
			lines.push(`✗ Global config: ${err instanceof Error ? err.message : String(err)}`);
		}

		// Save the full project snapshot before temporary marks are applied,
		// so they never reach the config file.
		try {
			const savedTo = saveSandboxConfig(cwd, currentConfig());
			lines.push(`💾 Sandbox config saved to ${displayPath(savedTo)}`);
		} catch (err) {
			hadError = true;
			lines.push(`✗ Project config: ${err instanceof Error ? err.message : String(err)}`);
		}

		// Temporary marks apply after the save: session-only.
		for (const target of plan.temporary) {
			unlockedPaths.add(target);
		}

		// Applied targets leave the blocked journal so the picker stops
		// offering them.
		const applied = [...plan.repo, ...globalApplied, ...plan.temporary];
		for (const target of applied) {
			try {
				removeJournalPath(target);
			} catch {
				// Journal cleanup is best-effort.
			}
		}

		if (plan.temporary.length > 0) {
			lines.push(`🔓 Session: ${plan.temporary.map((p) => displayPath(p)).join("  ")}`);
		}
		if (plan.repo.length > 0) {
			lines.push(`🔓 Repo: ${plan.repo.map((p) => displayPath(p)).join("  ")}`);
		}
		if (globalApplied.length > 0) {
			lines.push(`🔓 Global (saved to ${displayPath(globalConfigPath())}): ${globalApplied.map((p) => displayPath(p)).join("  ")}`);
		}
		if (applied.length === 0) {
			lines.push("No paths marked — only the sandbox config was saved.");
		}

		return { lines, hadError, applied };
	}

	// The kernel denies bash file access without telling pi, so read the denied
	// paths back out of the command's error output for /sandbox-unblock-paths.
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
