/**
 * Tests for the /sandbox-unblock-paths picker: row building (merge, dedupe,
 * filtering, sectioning, capped blocked list), plan extraction, and the
 * component's keyboard state machine. Rendering is smoke-tested only; the
 * pure functions carry the behavior.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { blockedHistory, type BlockedEntry } from "./state.js";
import type { JournalEntry } from "./journal.js";
import { buildPickerRows, hintLines, planFromMarks, UnblockPicker, type PickerRow, type UnlockPlan, type UnlockScope } from "./picker.js";

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

const emptySources = { journal: [] as JournalEntry[], history: [] as BlockedEntry[], alreadyUnlocked: [] as string[], repoPaths: [] as string[], globalPaths: [] as string[] };

describe("buildPickerRows", () => {
	it("merges journal and history, keeping the newest occurrence per path and sorting newest first", () => {
		const rows = buildPickerRows({
			journal: [j("/a", 100), j("/b", 300)],
			history: [h("/a", 200)],
			alreadyUnlocked: [],
			repoPaths: [],
			globalPaths: [],
		});
		const blocked = rows.filter((r) => r.section === "blocked");
		expect(blocked.map((r) => r.path)).toEqual(["/b", "/a"]);
		expect(blocked[0].timestamp).toBe(300);
		// The newer history occurrence wins over the journal entry for /a.
		expect(blocked[1]!.tool).toBe("bash");
		expect(blocked[1]!.timestamp).toBe(200);
	});

	it("caps blocked rows at the 10 most recent, newest first", () => {
		const rows = buildPickerRows({
			journal: Array.from({ length: 5 }, (_, i) => j(`/old/${i}`, i + 1)),
			history: Array.from({ length: 8 }, (_, i) => h(`/new/${i}`, i + 100)),
			alreadyUnlocked: [],
			repoPaths: [],
			globalPaths: [],
		});
		const blocked = rows.filter((r) => r.section === "blocked");
		expect(blocked).toHaveLength(10);
		// The 8 history entries are all newer than the journal's; the two
		// newest journal entries fill the remaining slots.
		expect(blocked.map((r) => r.path)).toEqual([
			...Array.from({ length: 8 }, (_, i) => `/new/${7 - i}`),
			"/old/4",
			"/old/3",
		]);
	});

	it("hides blocked entries under already-unlocked prefixes", () => {
		const rows = buildPickerRows({
			journal: [],
			history: [h("/private/a", 1), h("/elsewhere/b", 2)],
			alreadyUnlocked: ["/private"],
			repoPaths: [],
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
			repoPaths: [],
			globalPaths: [],
		});
		expect(rows.find((r) => r.path === file)!.target).toBe(dir); // ENOENT file: parent
		expect(rows.find((r) => r.path === dir)!.target).toBe(dir);
	});

	it("lists global unlock roots first, repo unlock roots second, then the blocked rows, both unlocked lists sorted", () => {
		const rows = buildPickerRows({
			journal: [],
			history: [h("/gone", 1)],
			alreadyUnlocked: [],
			repoPaths: ["/b", "/a"],
			globalPaths: ["/z"],
		});
		expect(rows.map((r) => `${r.section}:${r.path}`)).toEqual([
			"global:/z",
			"repo:/a",
			"repo:/b",
			"blocked:/gone",
		]);
	});
});

describe("planFromMarks", () => {
	const rows: PickerRow[] = [
		{ section: "blocked", path: "/one", target: "/one", original: "/one", tool: "read", timestamp: 2 },
		{ section: "blocked", path: "/two/file", target: "/two", original: "/two/file", tool: "read", timestamp: 1 },
		{ section: "blocked", path: "/other/file", target: "/two", original: "/other/file", tool: "bash", timestamp: 0 },
		{ section: "repo", path: "/s", target: "/s", original: "/s", tool: "", timestamp: 0 },
	];

	it("groups marks by scope in row order and skips unmarked or unlocked-section rows", () => {
		const marks = new Map<string, UnlockScope>([
			["/one", "temporary"],
			["/two/file", "repo"],
			["/s", "global"], // repo rows are never marked by the component
		]);
		expect(planFromMarks(rows, marks)).toEqual<UnlockPlan>({
			temporary: ["/one"],
			repo: ["/two"],
			global: [],
		});
	});

	it("dedupes unlock targets that several marked rows share", () => {
		// /two/file and /other/file both unlock /two; only one is marked.
		const plan = planFromMarks(
			rows,
			new Map([
				["/two/file", "global"],
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
		const rows = buildPickerRows({ ...emptySources, history: [h("/x", 1)] });
		let result: UnlockPlan | undefined | "unset" = "unset";
		const p = picker(rows, (r) => (result = r));
		p.handleInput("\x1b[A"); // irrelevant navigation first
		p.handleInput("\x1b");
		expect(result).toBeUndefined();
	});

	it("Enter passes an empty plan when nothing is marked", () => {
		const rows = buildPickerRows({ ...emptySources, history: [h("/x", 1)] });
		let result: UnlockPlan | undefined | "unset" = "unset";
		picker(rows, (r) => (result = r)).handleInput("\r");
		expect(result).toEqual<UnlockPlan>({ temporary: [], repo: [], global: [] });
	});

	it("marks the selected blocked row, switches scope on a different key, and clears on a repeat", () => {
		const { a, b } = blockedDirs();
		const rows = buildPickerRows({
			...emptySources,
			history: [h(a, 2), h(b, 1)],
		});
		let result: UnlockPlan | undefined | "unset" = "unset";
		const p = picker(rows, (r) => (result = r));
		p.handleInput("t"); // first blocked row, newest
		p.handleInput("r"); // same row: switch to repo
		p.handleInput("j"); // move to second blocked row
		p.handleInput("g"); // global
		p.handleInput("r"); // same row again: switch to repo
		p.handleInput("r"); // third press clears it
		p.handleInput("\r");
		expect(result).toEqual<UnlockPlan>({ temporary: [], repo: [a], global: [] });
	});

	it("ignores scope keys on repo-unlocked rows", () => {
		const rows = buildPickerRows({ ...emptySources, repoPaths: ["/s"] });
		let result: UnlockPlan | undefined | "unset" = "unset";
		const p = picker(rows, (r) => (result = r));
		p.handleInput("t");
		p.handleInput("\r");
		expect(result).toEqual<UnlockPlan>({ temporary: [], repo: [], global: [] });
	});

	it("navigates with j/k and arrow keys across sections", () => {
		const { a } = blockedDirs();
		const rows = buildPickerRows({
			...emptySources,
			history: [h(a, 2)],
			repoPaths: ["/s"],
		});
		let result: UnlockPlan | undefined | "unset" = "unset";
		const p = picker(rows, (r) => (result = r));
		p.handleInput("k"); // clamped at the first row (repo)
		p.handleInput("j"); // to the blocked row
		p.handleInput("j"); // clamped at the last row (still blocked)
		p.handleInput("t");
		p.handleInput("\r");
		expect(result).toEqual<UnlockPlan>({ temporary: [a], repo: [], global: [] });
	});

	it("renders a uniform-width box with all three sections", () => {
		const rows = buildPickerRows({
			...emptySources,
			history: [h("/a/b/c", 2, "read", "~/a/b/c")],
			repoPaths: ["/s"],
		});
		const lines = new UnblockPicker(stubTheme, () => {}, rows).render(120);
		expect(lines.length).toBeGreaterThan(5);
		const widths = new Set(lines.map((l) => visibleWidth(l)));
		expect(widths.size).toBe(1);
		const raw = lines.join("\n");
		// Section headers are bright green, like the hint keys.
		expect(raw).toContain("\x1b[1;92mUnlocked globally (0)\x1b[22;39m");
		expect(raw).toContain("\x1b[1;92mBlocked paths (10 most recent) (1)\x1b[22;39m");
		const text = raw.replace(/\x1b\[[0-9;]*m/g, "");
		expect(text).toContain("Unlocked globally (0)");
		expect(text).toContain("Unlocked in repo config (1)");
		expect(text).toContain("Blocked paths (10 most recent) (1)");
		expect(text).toContain("Press t = unlock for session · r = perm unlock for repo · g = perm unlock globally · space = clear");
		expect(text).toContain("esc cancel");
	});

	it("clears the selected row's mark with space", () => {
		const { a } = blockedDirs();
		const rows = buildPickerRows({ ...emptySources, history: [h(a, 1)] });
		let result: UnlockPlan | undefined | "unset" = "unset";
		const p = picker(rows, (r) => (result = r));
		p.handleInput("g");
		p.handleInput(" ");
		p.handleInput("\r");
		expect(result).toEqual<UnlockPlan>({ temporary: [], repo: [], global: [] });
	});

	it("marks only the pressed row, not siblings sharing its unlock target", () => {
		const root = mkdtempSync(join(tmpdir(), "picker-sib-"));
		const one = join(root, "one.txt");
		const two = join(root, "two.txt");
		writeFileSync(one, "x");
		writeFileSync(two, "x");
		const rows = buildPickerRows({ ...emptySources, history: [h(one, 2), h(two, 1)] });
		let result: UnlockPlan | undefined | "unset" = "unset";
		const p = picker(rows, (r) => (result = r));
		p.handleInput("g"); // newest row (one.txt); both rows target `root`
		const text = p.render(200).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		// Exactly one row shows the tag, in front of its path.
		expect(text.match(/\[g\]/g)).toHaveLength(1);
		expect(text).toContain("[g] ");
		p.handleInput("\r");
		// The plan still unlocks the shared parent once.
		expect(result).toEqual<UnlockPlan>({ temporary: [], repo: [], global: [root] });
	});
});

describe("hintLines", () => {
	const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

	it("renders two rows: marking keys, then movement keys", () => {
		expect(plain(hintLines(stubTheme))).toEqual([
			"Press t = unlock for session · r = perm unlock for repo · g = perm unlock globally · space = clear",
			"↑↓ move · enter save & exit · esc cancel",
		]);
	});

	it("colors each key bright green", () => {
		const text = hintLines(stubTheme).join("");
		for (const key of ["t", "r", "g", "space", "↑↓", "enter", "esc"]) {
			expect(text).toContain(`\x1b[1;92m${key}\x1b[22;39m`);
		}
	});

	it("renders the hint rows flat inside the box, never wrapped", () => {
		const rows = buildPickerRows({ ...emptySources, history: [h("/x", 1)] });
		const lines = new UnblockPicker(stubTheme, () => {}, rows).render(120);
		const widths = new Set(lines.map((l) => visibleWidth(l)));
		expect(widths.size).toBe(1);
		const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(text).toContain("Press t = unlock for session · r = perm unlock for repo · g = perm unlock globally · space = clear");
	});
});
