/**
 * Tests for the persistent blocked-path journal (src/sandbox/journal.ts).
 * Every test writes to a temp directory; the real ~/.pi journal is untouched.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_JOURNAL_LINES, TRIM_TO, appendJournalEntry, journalPath, readJournal, removeJournalPath } from "./journal.js";

let dir: string;
let file: string;

function entry(overrides: Partial<{ path: string; original: string; tool: string; timestamp: number }> = {}) {
	return {
		path: overrides.path ?? "/home/u/proj/secret",
		original: overrides.original ?? "~/proj/secret",
		tool: overrides.tool ?? "read",
		timestamp: overrides.timestamp ?? Date.now(),
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-sandbox-journal-"));
	file = join(dir, "sandbox-blocked.jsonl");
});

afterEach(() => {
	// Temp dirs are left for inspection on failure only.
});

describe("journalPath", () => {
	it("formats the home-relative path", () => {
		expect(journalPath("/home/u")).toBe("/home/u/.pi/agent/sandbox-blocked.jsonl");
	});
});

describe("appendJournalEntry", () => {
	it("creates the file and appends one JSON line per entry", () => {
		appendJournalEntry(entry(), file);
		appendJournalEntry(entry({ path: "/home/u/other", timestamp: 2 }), file);
		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0])).toMatchObject({ path: "/home/u/proj/secret", tool: "read" });
	});
});

describe("readJournal", () => {
	it("returns entries newest last, limited to the requested count", () => {
		for (let i = 1; i <= 30; i++) {
			appendJournalEntry(entry({ path: `/home/u/p${i}`, timestamp: i }), file);
		}
		const last5 = readJournal(5, file);
		expect(last5.map((e) => e.path)).toEqual(["/home/u/p26", "/home/u/p27", "/home/u/p28", "/home/u/p29", "/home/u/p30"]);
	});

	it("dedupes by path, keeping the newest occurrence", () => {
		appendJournalEntry(entry({ path: "/home/u/a", timestamp: 1 }), file);
		appendJournalEntry(entry({ path: "/home/u/b", timestamp: 2 }), file);
		appendJournalEntry(entry({ path: "/home/u/a", timestamp: 3 }), file);
		expect(readJournal(100, file).map((e) => e.path)).toEqual(["/home/u/b", "/home/u/a"]);
	});

	it("skips corrupt lines and returns empty when missing", () => {
		writeFileSync(file, "not json\n" + JSON.stringify(entry()) + "\n", "utf8");
		const entries = readJournal(10, file);
		expect(entries).toHaveLength(1);
		expect(readJournal(10, join(dir, "missing.jsonl"))).toEqual([]);
	});
});

describe("removeJournalPath", () => {
	it("removes entries with the given path and rewrites the file", () => {
		appendJournalEntry(entry({ path: "/home/u/a" }), file);
		appendJournalEntry(entry({ path: "/home/u/b" }), file);
		removeJournalPath("/home/u/a", file);
		expect(readJournal(10, file).map((e) => e.path)).toEqual(["/home/u/b"]);
	});

	it("is a no-op when the journal does not exist", () => {
		expect(() => removeJournalPath("/home/u/a", join(dir, "missing.jsonl"))).not.toThrow();
	});
});

describe("trim", () => {
	it("compacts the journal once it grows by the compact threshold", () => {
		const compactAfter = 10;
		const trimTo = 6;
		const total = compactAfter * 2 + 5;
		for (let i = 0; i < total; i++) {
			appendJournalEntry(entry({ path: `/home/u/p${i}`, timestamp: i }), file, { compactAfter, trimTo });
		}
		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(lines.length).toBeLessThanOrEqual(trimTo + compactAfter - 1);
		// Compaction keeps the newest unique entries; they stay readable.
		const kept = readJournal(100, file);
		expect(kept[kept.length - 1].path).toBe(`/home/u/p${total - 1}`);
	});
});
