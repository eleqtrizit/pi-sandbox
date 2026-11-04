/**
 * Tests for the /sandbox-unblock-paths picker: row building (merge, dedupe,
 * filtering, sectioning), plan extraction, and the component's keyboard state
 * machine. Rendering is smoke-tested only; the pure functions carry the
 * behavior.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { blockedHistory, type BlockedEntry } from "./state.js";
import type { JournalEntry } from "./journal.js";
import { buildPickerRows, planFromMarks, UnblockPicker, type PickerRow, type UnlockPlan, type UnlockScope } from "./picker.js";

/** Theme stub: identity colors, so assertions can match plain text. */
const stubTheme = { fg: (_color: string, s: string) => s } as unknown as Theme;

/** Journal-shaped entry builder. */
function j(path: string, timestamp: number, tool = "read", original = path): JournalEntry {
	return { path, original, tool, timestamp };
}

/** History-shaped entry builder. */
function h(path: string, timestamp: number, tool = "bash", original = path): BlockedEntry {
	return { path, original, tool, timestamp };
}

/** Two real directories under a temp root, so an unlock target equals the blocked path. */
function blockedDirs(): { a: string; b: string } {
	const root = mkdtempSync(join(tmpdir(), "picker-keys-"));
	const a = join(root, "a");
	const b = join(root, "b");
	mkdirSync(a);
	mkdirSync(b);
	return { a, b };
}

describe("buildPickerRows", () => {
	it("merges journal and history, keeping the newest occurrence per path and sorting newest first", () => {
		const rows = buildPickerRows({
			journal: [j("/a", 100), j("/b", 300)],
			history: [h("/a", 200)],
			alreadyUnlocked: [],
			sessionPaths: [],
			globalPaths: [],
		});
		const blocked = rows.filter((r) => r.section === "blocked");
		expect(blocked.map((r) => r.path)).toEqual(["/b", "/a"]);
		expect(blocked[0].timestamp).toBe(300);
		// The newer history occurrence wins over the journal entry for /a.
		expect(blocked[1]!.tool).toBe("bash");
		expect(blocked[1]!.timestamp).toBe(200);
	});

	it("hides blocked entries under already-unlocked prefixes", () => {
		const rows = buildPickerRows({
			journal: [],
			history: [h("/private/a", 1), h("/elsewhere/b", 2)],
			alreadyUnlocked: ["/private"],
			sessionPaths: [],
			globalPaths: [],
		});
		expect(rows.map((r) => r.path)).toEqual(["/elsewhere/b"]);
	});

	it("uses the parent directory as the unlock target for blocked files and the path itself for directories", () => {
		const dir = mkdtempSync(join(tmpdir(), "picker-"));
		const file = join(dir, "notes.txt");
		const rows = buildPickerRows({
			journal: [],
			history: [h(file, 1, "write"), h(dir, 2, "read")],
			alreadyUnlocked: [],
			sessionPaths: [],
			globalPaths: [],
		});
		expect(rows.find((r) => r.path === file)!.target).toBe(dir); // ENOENT file: parent
		expect(rows.find((r) => r.path === dir)!.target).toBe(dir);
	});

	it("lists session and global unlock roots after the blocked rows, sorted", () => {
		const rows = buildPickerRows({
			journal: [],
			history: [h("/gone", 1)],
			alreadyUnlocked: [],
			sessionPaths: ["/b", "/a"],
			globalPaths: ["/z"],
		});
		expect(rows.map((r) => `${r.section}:${r.path}`)).toEqual([
			"blocked:/gone",
			"session:/a",
			"session:/b",
			"global:/z",
		]);
	});
});

describe("planFromMarks", () => {
	const rows: PickerRow[] = [
		{ section: "blocked", path: "/one", target: "/one", original: "/one", tool: "read", timestamp: 2 },
		{ section: "blocked", path: "/two/file", target: "/two", original: "/two/file", tool: "read", timestamp: 1 },
		{ section: "blocked", path: "/other/file", target: "/two", original: "/other/file", tool: "bash", timestamp: 0 },
		{ section: "session", path: "/s", target: "/s", original: "/s", tool: "", timestamp: 0 },
	];

	it("groups marks by scope in row order and skips unmarked or unlocked-section rows", () => {
		const marks = new Map<string, UnlockScope>([
			["/one", "temporary"],
			["/two", "repo"],
			["/s", "global"], // session rows are never marked by the component
		]);
		expect(planFromMarks(rows, marks)).toEqual<UnlockPlan>({
			temporary: ["/one"],
			repo: ["/two"],
			global: [],
		});
	});

	it("dedupes targets that several blocked rows share", () => {
		const plan = planFromMarks(
			rows,
			new Map([
				["/two", "global"],
				["/one", "temporary"],
			]),
		);
		expect(plan.global).toEqual(["/two"]);
		expect(plan.temporary).toEqual(["/one"]);
	});

	it("returns an empty plan when nothing is marked", () => {
		expect(planFromMarks(rows, new Map())).toEqual<UnlockPlan>({ temporary: [], repo: [], global: [] });
	});
});

describe("UnblockPicker", () => {
	function picker(rows: PickerRow[], done: (r: UnlockPlan | undefined) => void): UnblockPicker {
		return new UnblockPicker(stubTheme, done, rows);
	}

	it("cancel passes undefined on Escape", () => {
		const rows = buildPickerRows({ journal: [], history: [h("/x", 1)], alreadyUnlocked: [], sessionPaths: [], globalPaths: [] });
		let result: UnlockPlan | undefined | "unset" = "unset";
		const p = picker(rows, (r) => (result = r));
		p.handleInput("\x1b[A"); // irrelevant navigation first
		p.handleInput("\x1b");
		expect(result).toBeUndefined();
	});

	it("Enter passes an empty plan when nothing is marked", () => {
		const rows = buildPickerRows({ journal: [], history: [h("/x", 1)], alreadyUnlocked: [], sessionPaths: [], globalPaths: [] });
		let result: UnlockPlan | undefined | "unset" = "unset";
		picker(rows, (r) => (result = r)).handleInput("\r");
		expect(result).toEqual<UnlockPlan>({ temporary: [], repo: [], global: [] });
	});

	it("marks the selected blocked row, switches scope on a different key, and clears on a repeat", () => {
		const { a, b } = blockedDirs();
		const rows = buildPickerRows({
			journal: [],
			history: [h(a, 2), h(b, 1)],
			alreadyUnlocked: [],
			sessionPaths: [],
			globalPaths: [],
		});
		let result: UnlockPlan | undefined | "unset" = "unset";
		const p = picker(rows, (r) => (result = r));
		p.handleInput("t"); // first row, newest blocked
		p.handleInput("r"); // same row: switch to repo
		p.handleInput("j"); // move to second row
		p.handleInput("g"); // global
		p.handleInput("r"); // same row again: switch to repo
		p.handleInput("r"); // third press clears it
		p.handleInput("\r");
		expect(result).toEqual<UnlockPlan>({ temporary: [], repo: [a], global: [] });
	});

	it("ignores scope keys on session-unlocked rows", () => {
		const rows = buildPickerRows({
			journal: [],
			history: [],
			alreadyUnlocked: [],
			sessionPaths: ["/s"],
			globalPaths: [],
		});
		let result: UnlockPlan | undefined | "unset" = "unset";
		const p = picker(rows, (r) => (result = r));
		p.handleInput("t");
		p.handleInput("\r");
		expect(result).toEqual<UnlockPlan>({ temporary: [], repo: [], global: [] });
	});

	it("navigates with j/k and arrow keys across sections", () => {
		const { a } = blockedDirs();
		const rows = buildPickerRows({
			journal: [],
			history: [h(a, 2)],
			alreadyUnlocked: [],
			sessionPaths: ["/s"],
			globalPaths: [],
		});
		let result: UnlockPlan | undefined | "unset" = "unset";
		const p = picker(rows, (r) => (result = r));
		p.handleInput("j"); // to session row
		p.handleInput("j"); // clamped at the last row
		p.handleInput("k"); // back to blocked row
		p.handleInput("t");
		p.handleInput("\r");
		expect(result).toEqual<UnlockPlan>({ temporary: [a], repo: [], global: [] });
	});

	it("renders a uniform-width box with all three sections", () => {
		const rows = buildPickerRows({
			journal: [],
			history: [h("/a/b/c", 2, "read", "~/a/b/c")],
			alreadyUnlocked: [],
			sessionPaths: ["/s"],
			globalPaths: [],
		});
		const lines = new UnblockPicker(stubTheme, () => {}, rows).render(120);
		expect(lines.length).toBeGreaterThan(5);
		const widths = new Set(lines.map((l) => visibleWidth(l)));
		expect(widths.size).toBe(1);
		const text = lines.join("\n");
		expect(text).toContain("Blocked paths (1)");
		expect(text).toContain("Unlocked this session (1)");
		expect(text).toContain("Unlocked globally (0)");
		expect(text).toContain("t session");
	});
});
