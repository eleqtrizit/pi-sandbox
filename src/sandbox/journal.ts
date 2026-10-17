/**
 * Persistent journal of blocked sandbox paths.
 *
 * Every block recorded by recordBlocked is also appended to
 * ~/.pi/agent/sandbox-blocked.jsonl as one JSON object per line, so blocked
 * paths stay visible across sessions. The file grows without bound, so
 * appends trim it back once it exceeds MAX_JOURNAL_LINES lines.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOME } from "./state.js";

/** Serialized journal line, mirroring the in-memory BlockedEntry shape. */
export interface JournalEntry {
	/** Realpath-resolved path that was denied. */
	path: string;
	/** Path as it appeared in the tool input, for human display. */
	original: string;
	/** Tool that issued the blocked call. */
	tool: string;
	/** Epoch milliseconds when the block happened. */
	timestamp: number;
}

/** Maximum number of lines the journal keeps before trimming to TRIM_TO. */
export const MAX_JOURNAL_LINES = 5000;

/** Line count kept after a trim; leaves headroom for the next appends. */
export const TRIM_TO = 4000;

/** Journal path: ~/.pi/agent/sandbox-blocked.jsonl (overridable for tests). */
export function journalPath(home: string = HOME): string {
	return join(home, ".pi", "agent", "sandbox-blocked.jsonl");
}

/** Appends since the last compaction; compaction keeps the file bounded. */
let appendsSinceCompact = 0;

/** Options overriding the trim thresholds, mainly for tests. */
export interface AppendOptions {
	/** Appends after which the journal is compacted; defaults to MAX_JOURNAL_LINES. */
	compactAfter?: number;
	/** Entries kept after compaction; defaults to TRIM_TO. */
	trimTo?: number;
}

/** Append one blocked-path entry to the journal as a raw line. The file is
 * compacted back to TRIM_TO lines only once it has grown by
 * MAX_JOURNAL_LINES appends, so each append stays O(1). */
export function appendJournalEntry(entry: JournalEntry, path: string = journalPath(), options: AppendOptions = {}): void {
	const compactAfter = options.compactAfter ?? MAX_JOURNAL_LINES;
	const trimTo = options.trimTo ?? TRIM_TO;
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
	appendsSinceCompact++;
	if (appendsSinceCompact >= compactAfter) {
		appendsSinceCompact = 0;
		compactJournal(path, trimTo);
	}
}

/** Rewrite the journal keeping the newest unique `trimTo` entries, or empty it when none remain. */
function compactJournal(path: string, trimTo: number = TRIM_TO): void {
	if (!existsSync(path)) {
		return;
	}
	const entries = parseEntries(readFileSync(path, "utf8"));
	const newestByPath = new Map<string, JournalEntry>();
	for (const entry of entries) {
		newestByPath.set(entry.path, entry);
	}
	const kept = [...newestByPath.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-trimTo);
	if (kept.length === 0) {
		writeFileSync(path, "", "utf8");
		return;
	}
	writeFileSync(path, `${kept.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
}

/** Parse journal lines into entries, skipping malformed lines. */
function parseEntries(raw: string): JournalEntry[] {
	const entries: JournalEntry[] = [];
	for (const line of raw.split("\n")) {
		if (line === "") {
			continue;
		}
		try {
			const parsed = JSON.parse(line) as Partial<JournalEntry>;
			if (typeof parsed.path === "string" && typeof parsed.timestamp === "number") {
				entries.push({
					path: parsed.path,
					original: typeof parsed.original === "string" ? parsed.original : parsed.path,
					tool: typeof parsed.tool === "string" ? parsed.tool : "unknown",
					timestamp: parsed.timestamp,
				});
			}
		} catch {
			// Skip corrupt lines; the journal is diagnostic, not load-bearing.
		}
	}
	return entries;
}

/**
 * Read the newest unique blocked paths from the journal, newest last. A later
 * block of the same path replaces its earlier occurrence, mirroring the
 * in-memory blockedHistory dedupe. Returns at most `limit` entries.
 */
export function readJournal(limit: number, path: string = journalPath()): JournalEntry[] {
	if (!existsSync(path) || limit <= 0) {
		return [];
	}
	let entries = parseEntries(readFileSync(path, "utf8"));
	const newestByPath = new Map<string, JournalEntry>();
	for (const entry of entries) {
		newestByPath.set(entry.path, entry);
	}
	entries = [...newestByPath.values()].sort((a, b) => a.timestamp - b.timestamp);
	return entries.slice(-limit);
}

/**
 * Remove every journal line whose path matches `target`, then rewrite the
 * file. Called when a path is unlocked so /sandbox-paths stops offering it.
 * No-op (and returns the path unchanged) when the journal is missing.
 */
export function removeJournalPath(target: string, path: string = journalPath()): void {
	if (!existsSync(path)) {
		return;
	}
	const kept = parseEntries(readFileSync(path, "utf8")).filter((e) => e.path !== target);
	writeFileSync(path, kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length > 0 ? "\n" : ""), "utf8");
}
