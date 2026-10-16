/**
 * Registry other extensions use to allow extra directories inside the sandbox.
 *
 * A consumer extension imports registerAllowedPath from this package (same
 * process, same module instance) and calls it from its factory or
 * session_start. Load order does not matter: both enforcement layers read
 * extensionPaths lazily on every operation (checkPath per tool call,
 * profileInputFor per bash spawn), so a path registered at any point is
 * enforced from the next call onward.
 *
 * Registrations are never written to the sandbox config file: the config is a
 * trust anchor owned by slash commands, and extensions re-register on every
 * load anyway. The agent itself has no tool path to this API.
 *
 * Security note: a registered root must live under a parent directory the
 * agent cannot write to. Registration and enforcement re-resolve the stored
 * path, which closes the common symlink-swap cases, but a concurrent process
 * that can replace the root between the userspace check and the kernel mount
 * (bubblewrap bind, Landlock) still wins a narrow race. Registering a
 * directory inside an agent-writable parent is documented as unsafe.
 */

import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { expandTilde, isUnderPrefix, realpathThroughExisting } from "./fs-utils.js";
import { extensionPaths } from "./state.js";

/**
 * Allow a directory and everything under it inside the sandbox, for both
 * in-process tools and OS-sandboxed bash (read-write).
 *
 * The path is canonicalized at registration through the deepest existing
 * ancestor. Registering a child of an already-registered parent is a no-op;
 * registering a parent drops covered children. Relative paths throw; the path
 * must be absolute or tilde. Enforcement revalidates the stored path on every
 * check and bash spawn (see validExtensionPaths).
 *
 * @param path - Directory to allow. Must be an absolute or tilde path.
 * @returns The resolved path as stored in the registry.
 * @throws When the path is not absolute after tilde expansion.
 */
export function registerAllowedPath(path: string): string {
	// expandTilde only understands "~" and "~/..."; "~username" would fall
	// through and resolve relative to cwd, so reject it here.
	if (!path.startsWith("/") && path !== "~" && !path.startsWith("~/")) {
		throw new Error(`registerAllowedPath: "${path}" must be an absolute or tilde path`);
	}
	// Canonicalize through the deepest existing ancestor so a missing tail
	// under a symlinked ancestor (e.g. /var -> /private/var on macOS) is
	// stored on the same real spine enforcement compares against.
	const resolved = realpathThroughExisting(resolve(expandTilde(path)));
	// Child under an already-registered parent: skip, the parent covers it.
	for (const existing of extensionPaths) {
		if (isUnderPrefix(resolved, existing)) {
			return existing;
		}
	}
	// A new parent covers previously registered children.
	for (const existing of [...extensionPaths]) {
		if (isUnderPrefix(existing, resolved)) {
			extensionPaths.delete(existing);
		}
	}
	extensionPaths.add(resolved);
	return resolved;
}

/**
 * Extension-registered roots that still resolve to their registered canonical
 * form and are not themselves symlinks. Called per tool check and per bash
 * spawn; a root that was swapped or replaced after registration is dropped
 * (fail closed) instead of being honored at its new target.
 */
export function validExtensionPaths(): string[] {
	return [...extensionPaths].filter((allowed) => {
		if (lstatSync(allowed, { throwIfNoEntry: false })?.isSymbolicLink()) {
			return false;
		}
		return realpathThroughExisting(allowed) === allowed;
	});
}

/** All extension-registered allowed paths, realpath-resolved. */
export function registeredAllowedPaths(): string[] {
	return [...extensionPaths];
}
