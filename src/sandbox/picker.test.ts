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
		{ section: "custom", path: "/mine", target: "/mine", original: "/mine", tool: "", timestamp: 0 },
	];

	it("groups marks by scope in row order and skips unmarked or unlocked-section rows", () => {
		const marks = new Map<string, UnlockScope>([
			["/one", "temporary"],
			["/two/file", "repo"],
			["/mine", "global"], // custom rows are markable like blocked rows
			["/s", "temporary"], // repo rows are never marked by the component
		]);
		expect(planFromMarks(rows, marks)).toEqual<UnlockPlan>({
			temporary: ["/one"],
			repo: ["/two"],
			global: ["/mine"],
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

	it("scrolls the whole box when the terminal is shorter than the box", () => {
		const history = Array.from({ length: 10 }, (_, i) => h(`/p/${i}`, i));
		const rows = buildPickerRows({ ...emptySources, history });
		const p = new UnblockPicker(stubTheme, () => {}, rows, () => 24);
		const plain = (lines: string[]): string => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		const first = p.render(120);
		expect(first).toHaveLength(24); // box height pinned to the terminal
		expect(plain(first)).toContain("/p/9");
		expect(plain(first)).not.toContain("/p/0");
		expect(plain(first)).not.toContain("custom path: press c");
		expect(plain(first.slice(-1))).toContain("↓"); // content hidden below
		expect(plain(first.slice(0, 1))).not.toContain("↑"); // nothing hidden above
		p.handleInput("\x1b[6~"); // PageDown scrolls the box, not the selection
		const second = p.render(120);
		expect(second).toHaveLength(24);
		expect(plain(second)).toContain("/p/0");
		expect(plain(second)).toContain("custom path: press c"); // bottom of the box in view
		expect(plain(second.slice(0, 1))).toContain("↑");
		p.handleInput("\x1b[5~"); // PageUp scrolls back to the top of the box
		const third = p.render(120);
		expect(plain(third)).toContain("/p/9");
		expect(plain(third.slice(0, 1))).not.toContain("↑");
	});

	it("jumps to the bottom when the custom-path input opens with c", () => {
		const history = Array.from({ length: 10 }, (_, i) => h(`/p/${i}`, i));
		const rows = buildPickerRows({ ...emptySources, history });
		const p = new UnblockPicker(stubTheme, () => {}, rows, () => 24);
		const plain = (lines: string[]): string => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		p.handleInput("c");
		const text = plain(p.render(120));
		expect(text).toContain("custom path:"); // input row visible at the bottom
		expect(text).toContain("▌"); // with the text cursor
	});

	it("renders a uniform-width box with all three sections", () => {		const rows = buildPickerRows({
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
		expect(text).toContain("t         unlock for session");
		expect(text).toContain("esc       cancel");
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

	it("adds a typed custom path under a custom section and marks it like a blocked row", () => {
		const dir = mkdtempSync(join(tmpdir(), "picker-custom-"));
		const rows = buildPickerRows({ ...emptySources, history: [h("/gone", 1)] });
		let result: UnlockPlan | undefined | "unset" = "unset";
		const p = picker(rows, (r) => (result = r));
		const text = (): string => p.render(200).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(text()).not.toContain("Custom path (");
		expect(text()).toContain("custom path: press c");
		p.handleInput("c");
		p.handleInput(dir);
		expect(text()).toContain(`${dir}▌`); // typing shows in the input
		p.handleInput("\r"); // Enter in the input submits the path
		expect(text()).toContain("Custom path (1)");
		expect(text()).toContain(dir);
		p.handleInput("g"); // the new custom row is selected and markable
		expect(text()).toContain("[g]");
		p.handleInput("\r"); // Enter outside the input exits and applies
		expect(result).toEqual<UnlockPlan>({ temporary: [], repo: [], global: [dir] });
	});

	it("cancels the custom input with escape without adding a path", () => {
		const rows = buildPickerRows({ ...emptySources, history: [h("/gone", 1)] });
		let result: UnlockPlan | undefined | "unset" = "unset";
		const p = picker(rows, (r) => (result = r));
		p.handleInput("c");
		p.handleInput("/no/such/path");
		p.handleInput("\x1b"); // Escape leaves the input, not the picker
		const text = p.render(200).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(text).not.toContain("Custom path (");
		p.handleInput("\r"); // The picker still works: Enter exits normally
		expect(result).toEqual<UnlockPlan>({ temporary: [], repo: [], global: [] });
	});

	it("does not add the same custom path twice", () => {
		const dir = mkdtempSync(join(tmpdir(), "picker-dup-"));
		const rows = buildPickerRows({ ...emptySources, history: [] });
		const p = picker(rows, () => {});
		p.handleInput("c");
		p.handleInput(dir);
		p.handleInput("\r");
		p.handleInput("c");
		p.handleInput(dir);
		p.handleInput("\r");
		const text = p.render(200).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(text).toContain("Custom path (1)");
		expect(text.split(dir).length - 1).toBe(1); // the row appears exactly once
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

	it("renders one line per key, key first, description second", () => {
		expect(plain(hintLines(stubTheme)).map((l) => l.trimEnd())).toEqual([
			"t         unlock for session",
			"r         perm unlock for repo",
			"g         perm unlock globally",
			"space     clear",
			"c         add a custom path",
			"↑↓        move",
			"PgUp/PgDn scroll the box",
			"enter     save & exit",
			"esc       cancel",
		]);
	});

	it("aligns every description in the same column", () => {
		const starts = plain(hintLines(stubTheme)).map((line) => {
			const match = /\s{2}\S/.exec(line);
			expect(match).not.toBeNull();
			return (match as RegExpExecArray).index + 2;
		});
		expect(new Set(starts).size).toBe(1);
	});

	it("colors each key bright green", () => {
		const text = hintLines(stubTheme).join("");
		for (const key of ["t", "r", "g", "space", "c", "↑↓", "PgUp/PgDn", "enter", "esc"]) {
			expect(text).toContain(`\x1b[1;92m${key}\x1b[22;39m`);
		}
	});

	it("renders the hint table flat inside the box, never wrapped", () => {
		const rows = buildPickerRows({ ...emptySources, history: [h("/x", 1)] });
		const lines = new UnblockPicker(stubTheme, () => {}, rows).render(120);
		const widths = new Set(lines.map((l) => visibleWidth(l)));
		expect(widths.size).toBe(1);
		const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(text).toContain("t         unlock for session");
		expect(text).toContain("esc       cancel");
	});
});
