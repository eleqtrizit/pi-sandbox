/**
 * Path-checking core for the sandbox: allow lists, sandbox containment checks,
 * and bash-command inspection. Pure decision logic over paths; callers (the
 * tool_call interception in index.ts) turn the returned verdicts into blocks.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { HOME, sandboxState, symlinkTargets, unlockedPaths } from "./state.js";
import { expandTilde, isUnderPrefix, isUnderRealPrefix, realpathThroughExisting, tryRealpath } from "./fs-utils.js";
import { refreshAndRecheck } from "./symlinks.js";

/**
 * Paths that are always allowed, regardless of sandbox boundaries. These are
 * resolved at module load time.
 */
const ALLOWED_PATHS: string[] = [
	resolve(`${HOME}/.pi`),
	resolve(`${HOME}/.agents`),
];

/**
 * Standard device and pseudo-filesystem paths safe to reference from any sandbox.
 * Resolved at module load time.
 */
const EXACT_ALLOWED_PATHS: ReadonlySet<string> = new Set([
	resolve("/dev/null"),
	resolve("/dev/zero"),
	resolve("/dev/stdout"),
	resolve("/dev/stderr"),
	resolve("/dev/stdin"),
	resolve("/dev/tty"),
	resolve("/dev/random"),
	resolve("/dev/urandom"),
	resolve("/dev/full"),
]);

/**
 * Path prefixes for innocuous pseudo-filesystem trees (e.g. fd redirects)
 * and scratch/temp directories: the shared /tmp and the macOS per-user
 * /var/folders (symlinked to /private/var/folders, resolved via realpath).
 */
const PREFIX_ALLOWED_PATHS: string[] = [
	resolve("/dev/fd"),
	resolve("/proc/self/fd"),
	resolve("/tmp"),
	resolve("/var/folders"),
];

/**
 * Check if a resolved path is under any of the always-allowed paths.
 * Checks both the original path and its realpath'd (symlink-resolved) form, so
 * that:
 *   - Symlinks inside ALLOWED_PATHS are allowed because the original path is
 *     under the allowed root.
 *   - Symlinks pointing into ALLOWED_PATHS are allowed because the realpath'd
 *     path is under the allowed root.
 */
export function isAllowedPath(resolvedPath: string): boolean {
	const resolved = resolve(resolvedPath);
	const normalized = realpathThroughExisting(resolved);

	// Check both the original path and the realpath'd version
	const candidates = [resolved];
	if (normalized !== resolved) {
		candidates.push(normalized);
	}

	const matchesAllowed = (candidate: string): boolean => {
		if (EXACT_ALLOWED_PATHS.has(candidate)) {
			return true;
		}

		if (PREFIX_ALLOWED_PATHS.some((allowed) => isUnderRealPrefix(candidate, allowed))) {
			return true;
		}

		if (ALLOWED_PATHS.some((allowed) => isUnderRealPrefix(candidate, allowed))) {
			return true;
		}

		// Paths explicitly unlocked by the user via /unlock-last-path.
		if ([...unlockedPaths].some((allowed) => isUnderRealPrefix(candidate, allowed))) {
			return true;
		}

		// In symlink mode, allow paths under the real targets of sandbox
		// symlinks. Targets are already realpath-resolved, so no extra syscall
		// is needed here. Mode-gated so /lock-sandbox-symlinks re-tightens.
		if (sandboxState.symlinkMode) {
			for (const prefix of symlinkTargets) {
				if (isUnderPrefix(candidate, prefix)) {
					return true;
				}
			}
		}

		return false;
	};

	return candidates.some(matchesAllowed);
}

/**
 * Check if a resolved path is inside the sandbox directory.
 * By default uses realpath to resolve symlinks before comparing, so paths like
 * /Users/arivera/Dropbox/foo match against a sandbox dir of
 * /Users/arivera/Library/CloudStorage/Dropbox/foo. In symlink mode, compares
 * lexically so symlinks inside the sandbox that resolve outside are allowed.
 */
export function isInsideSandbox(resolvedPath: string, sandboxDir: string): boolean {
	if (sandboxState.symlinkMode) {
		const rel = relative(resolve(sandboxDir), resolve(resolvedPath));
		return !rel.startsWith("..");
	}
	const realResolved = realpathThroughExisting(resolvedPath);
	const realSandbox = tryRealpath(resolve(sandboxDir));
	const rel = relative(realSandbox, realResolved);
	return !rel.startsWith("..");
}

/** Verdict from a sandbox path check. */
export interface PathCheckResult {
	/** True when the path may be used. */
	allowed: boolean;
	/** Human-readable block reason; present only when not allowed. */
	reason?: string;
	/** The fully resolved path that was examined. */
	resolved?: string;
}

/**
 * Normalize a path and check it against the sandbox.
 * Always-allowed paths bypass the sandbox check. Symlinks are resolved via
 * realpath before comparison, so symlinked paths match against resolved
 * sandbox dirs. Relative paths resolve against the sandbox root.
 */
export function checkPath(path: string, sandboxDir: string): PathCheckResult {
	const realSandboxDir = tryRealpath(resolve(sandboxDir));
	const expanded = expandTilde(path);
	const sandboxRoot = sandboxState.symlinkMode ? resolve(sandboxDir) : realSandboxDir;
	const resolved = resolve(sandboxRoot, expanded);
	if (isAllowedPath(resolved)) {
		return { allowed: true };
	}
	if (!isInsideSandbox(resolved, sandboxRoot)) {
		if (refreshAndRecheck(resolved, sandboxDir, isAllowedPath)) {
			return { allowed: true };
		}
		const displaySandbox = tryRealpath(resolve(sandboxDir));
		return {
			allowed: false,
			reason: `Sandbox blocked: path "${path}" resolves to "${resolved}" which is outside the sandbox directory "${displaySandbox}"`,
			resolved,
		};
	}
	return { allowed: true };
}

/**
 * Resolve the path that /unlock-last-path unlocks for a blocked path.
 * Blocked directories unlock themselves; blocked files unlock their parent
 * directory so the whole subtree becomes reachable. A path that no longer
 * exists (a blocked write to a new file) unlocks its parent too.
 */
export function unlockTargetFor(path: string): string {
	try {
		if (statSync(path).isDirectory()) {
			return path;
		}
	} catch {
		// Missing path: the parent directory is the meaningful unlock target.
	}
	return dirname(path);
}

/**
 * Split a bash command string into tokens, respecting single and double quotes.
 */
export function tokenizeCommand(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1] ?? "";

		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
			} else {
				current += ch;
			}
		} else if (inDouble) {
			if (ch === '"') {
				inDouble = false;
			} else if (ch === "\\" && (next === '"' || next === "\\" || next === "$" || next === "`")) {
				current += next;
				i++;
			} else {
				current += ch;
			}
		} else if (ch === "'") {
			inSingle = true;
		} else if (ch === '"') {
			inDouble = true;
		} else if (ch === " " || ch === "\t") {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
		} else {
			current += ch;
		}
	}

	if (current.length > 0) {
		tokens.push(current);
	}

	return tokens;
}

/**
 * Check if a token is a comment marker rather than a filesystem path.
 * Single-line comment: "//" or "///" etc. Multi-line comment start: "/*".
 */
export function isCommentToken(token: string): boolean {
	return /^\s*\/\/+/.test(token) || /^\s*\/\*/.test(token);
}

/**
 * Check if a token looks like a filesystem path and, if so, whether it exists
 * outside the sandbox.
 *
 * A token is considered "path-like" if it starts with "/" or "~".
 * If it is path-like and the resolved path exists on disk outside the sandbox,
 * it is blocked. Non-existent paths are allowed through (they could be flags,
 * regex patterns, etc. that happen to start with "/" or "~").
 */
export function checkPathToken(token: string, sandboxDir: string): PathCheckResult {
	if (!token.startsWith("/") && !token.startsWith("~")) {
		return { allowed: true };
	}

	// Allow comment markers — they are not filesystem paths
	if (isCommentToken(token)) {
		return { allowed: true };
	}

	const realSandboxDir = tryRealpath(resolve(sandboxDir));
	const expanded = expandTilde(token);
	const sandboxRoot = sandboxState.symlinkMode ? resolve(sandboxDir) : realSandboxDir;
	const resolved = resolve(sandboxRoot, expanded);

	if (!existsSync(resolved)) {
		return { allowed: true };
	}

	if (isAllowedPath(resolved)) {
		return { allowed: true };
	}

	if (!isInsideSandbox(resolved, sandboxRoot)) {
		if (refreshAndRecheck(resolved, sandboxDir, isAllowedPath)) {
			return { allowed: true };
		}
		return {
			allowed: false,
			reason: `Sandbox blocked bash command: Command references path "${token}" which resolves to "${resolved}" - outside the sandbox directory "${realSandboxDir}"`,
			resolved,
		};
	}

	return { allowed: true };
}

/**
 * Remove heredoc bodies from a bash command before path scanning. Agents
 * routinely use `cat >> file <<'EOF' ... EOF` to append file content, and the
 * body routinely contains standalone "/" or path-like text (markdown trees,
 * code samples) that must not be treated as bash path references.
 *
 * A line containing a `<<` heredoc operator (optionally `<<-`, with the
 * delimiter optionally quoted) opens a heredoc; all lines after it are dropped
 * until a line whose trimmed content equals the delimiter. The operator line
 * itself is kept so its redirect target and cd targets are still checked.
 *
 * This is deliberately line-based and only understands the common
 * `cmd <<'DELIM'` / `cmd << DELIM` form (operator at line end or followed by
 * whitespace). Quoted strings on the operator line containing "<<" are not
 * specially handled — a false heredoc open would only skip a few lines of
 * scanning, never produce a false block.
 */
export function stripHeredocBodies(command: string): string {
	const kept: string[] = [];
	let terminator: string | null = null;

	for (const line of command.split("\n")) {
		if (terminator !== null) {
			if (line.trim() === terminator) {
				terminator = null;
			}
			continue;
		}
		kept.push(line);
		const match = line.match(/(^|\s)<<-?\s*(['"]?)([A-Za-z0-9_]+)\2(\s|$)/);
		if (match) {
			terminator = match[3];
		}
	}

	return kept.join("\n");
}

/**
 * Best-effort bash command sandboxing. Splits on command separators, checks
 * every `cd` target, then checks each token for path-like references that
 * resolve outside the sandbox. Heredoc bodies (see {@link stripHeredocBodies})
 * are stripped first so file content passed via `<<'EOF'` is never scanned.
 */
export function checkBashCommand(command: string, sandboxDir: string): PathCheckResult & { original?: string } {
	const trimmed = stripHeredocBodies(command).trim();

	if (!trimmed || trimmed.startsWith("#")) {
		return { allowed: true };
	}

	const realSandboxDir = tryRealpath(resolve(sandboxDir));
	const segments = trimmed.split(/\s*&&\s*|\s*\|\|\s*|\s*;\s*|\s*\|\s*/);

	for (const segment of segments) {
		const s = segment.trim();

		if (!s || s.startsWith("#") || /^[A-Z_][A-Z0-9_]*=/.test(s)) {
			continue;
		}

		const cdMatch = s.match(/\bcd\s+(\S+)/);
		if (cdMatch) {
			const target = cdMatch[1];
			const expanded = expandTilde(target);
			const sandboxRoot = sandboxState.symlinkMode ? resolve(sandboxDir) : realSandboxDir;
			const cdResolved = target.startsWith("/") || target.startsWith("~")
				? resolve(expanded)
				: resolve(sandboxRoot, target);
			const cdAllowed =
				isAllowedPath(cdResolved) || isInsideSandbox(cdResolved, sandboxRoot)
				|| refreshAndRecheck(cdResolved, sandboxDir, isAllowedPath);
			if (!cdAllowed) {
				return {
					allowed: false,
					reason: `Sandbox blocked bash command: Command uses "cd ${target}" which resolves to "${cdResolved}" - outside the sandbox directory "${realSandboxDir}"`,
					resolved: cdResolved,
					original: `cd ${target}`,
				};
			}
		}

		const tokens = tokenizeCommand(s);
		for (const token of tokens) {
			const result = checkPathToken(token, realSandboxDir);
			if (!result.allowed) {
				return { ...result, original: token };
			}
		}
	}

	return { allowed: true };
}
