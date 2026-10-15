/**
 * Small filesystem helpers shared by the sandbox modules: realpath fallback,
 * tilde expansion, and prefix comparisons. No pi imports; fully unit-testable.
 */

import { existsSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { HOME } from "./state.js";

/**
 * Resolve symlinks along the deepest existing ancestor of `path`, keeping the
 * non-existing tail lexical. `realpathSync` fails on non-existing paths, which
 * would compare a symlinked ancestor (e.g. /var/folders -> /private/var/folders)
 * inconsistently between the candidate and the sandbox root. Walking up to the
 * first existing ancestor keeps both sides on the same real spine.
 */
export function realpathThroughExisting(path: string): string {
	const parts = resolve(path).split("/");
	for (let i = parts.length; i >= 1; i--) {
		const ancestor = parts.slice(0, i).join("/") || "/";
		if (existsSync(ancestor)) {
			const realAncestor = tryRealpath(ancestor);
			const rest = parts.slice(i).join("/");
			return rest.length > 0 ? join(realAncestor, rest) : realAncestor;
		}
	}
	return resolve(path);
}

/**
 * Resolve symlinks in a path, falling back to the original path if realpath
 * fails. This handles Dropbox-style symlinks (e.g.
 * ~ -> ~/Library/CloudStorage/home) where the sandbox directory is the realpath
 * but the command uses the symlink path.
 */
export function tryRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Expand a tilde path to the full home directory path. */
export function expandTilde(path: string): string {
	if (path === "~") return HOME;
	if (path.startsWith("~/")) return `${HOME}/${path.slice(2)}`;
	return path;
}

/**
 * Test whether `candidate` is equal to or under `prefix` (lexical compare).
 * `relative` correctly treats the prefix's last segment as a path component,
 * so a file-typed prefix only matches itself, not sibling files.
 */
export function isUnderPrefix(candidate: string, prefix: string): boolean {
	const rel = relative(resolve(prefix), resolve(candidate));
	return !rel.startsWith("..");
}

/**
 * Like `isUnderPrefix`, but resolve `prefix` through realpath first, so that
 * allowed paths which are themselves symlinks (e.g. ~/Dropbox) compare against
 * the same real location the candidate resolves to.
 */
export function isUnderRealPrefix(candidate: string, prefix: string): boolean {
	return isUnderPrefix(candidate, tryRealpath(prefix));
}

/** A config path expressed relative to cwd when inside it, else absolute. */
export function relativeSafe(cwd: string, p: string): string {
	const r = relative(resolve(cwd), resolve(p));
	return r && !r.startsWith("..") ? r : p;
}
