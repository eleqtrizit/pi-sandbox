/**
 * Detect paths the OS sandbox denied inside a bash command. The kernel refuses
 * the open and pi never sees the path, so the only evidence is the command's
 * own error output. This module turns that text into candidate paths.
 */

import { resolve } from "node:path";
import { HOME } from "./state.js";

/** Error phrases that show a refused or hidden file access (macOS EPERM, Linux ENOENT/EACCES). */
const DENIAL_LINE = /operation not permitted|permission denied|\bEPERM\b|\bEACCES\b|no such file or directory|\bENOENT\b/i;

/** An absolute or tilde path token; stops at whitespace, quotes, and `:` `,` `;` `)`. */
const PATH_TOKEN = /(?:^|[\s'"`(])((?:~|\/)[^\s'"`:,;)]*)/g;

/**
 * Return the absolute paths strictly under `home` that appear on error lines
 * of `output`, in order of appearance and without duplicates. The home
 * directory itself is excluded: tools such as node `lstat` it while resolving
 * a path, and unlocking all of home is never the intended fix.
 *
 * shortcut: paths containing spaces are cut at the first space; upgrade if
 * real denials show up with spaces in them.
 *
 * @param output - Combined stdout and stderr of a bash command.
 * @param home - Home directory to filter against; defaults to the real one.
 */
export function extractDeniedHomePaths(output: string, home: string = HOME): string[] {
	const found = new Set<string>();
	for (const line of output.split("\n")) {
		if (!DENIAL_LINE.test(line)) {
			continue;
		}
		for (const match of line.matchAll(PATH_TOKEN)) {
			const raw = match[1].startsWith("~") ? `${home}${match[1].slice(1)}` : match[1];
			const path = resolve(raw);
			if (path.startsWith(`${home}/`)) {
				found.add(path);
			}
		}
	}
	return [...found];
}
