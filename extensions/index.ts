/**
 * Sandbox paths extension for Pi.
 *
 * Prevents tools from reaching outside the directory where Pi is started by
 * intercepting the built-in path-based tools (read, write, edit, bash, grep,
 * find, ls) and blocking operations that resolve outside the project root.
 * Slash commands manage lock state, symlink mode, and per-path unlocks.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSandbox from "../src/sandbox/index.js";

export default function (pi: ExtensionAPI): void {
	registerSandbox(pi);
}
