/**
 * The interactive path picker behind /sandbox-unblock-paths.
 *
 * Shows the sections in one overlay: paths unlocked globally, paths
 * unlocked in the repo config, the 10 most recently blocked paths (merged
 * from the persistent journal and the in-memory history), and paths added
 * by hand. The user moves with the arrow keys, marks rows with t
 * (temporary, this session), r (repo config), or g (global config), clears
 * a mark with space, types a custom path to add with c, and exits with
 * Enter, which applies the marks and saves the sandbox config
 * automatically. Escape discards the marks. When the terminal is shorter
 * than the box, the whole box scrolls inside the viewport.
 *
 * Row building and plan extraction are pure functions so tests can cover the
 * merge/dedupe/filter logic without a terminal; the component only adds
 * navigation, marking, the custom-path input, and rendering on top.
 */

import { resolve } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, type Focusable, type KeyId } from "@earendil-works/pi-tui";
import { type BlockedEntry } from "./state.js";
import type { JournalEntry } from "./journal.js";
import { expandTilde, isUnderRealPrefix } from "./fs-utils.js";
import { unlockTargetFor } from "./paths.js";
import { displayPath } from "./display.js";

/** Scope of an unlock mark. "temporary" lasts for this session only, "repo" is persisted in the project config, "global" in ~/.pi/agent. */
export type UnlockScope = "temporary" | "repo" | "global";

/** Marks collected in the picker, applied by the command handler on exit. */
export interface UnlockPlan {
	/** Targets to allow for this session only. */
	temporary: string[];
	/** Targets to persist in the project sandbox config. */
	repo: string[];
	/** Targets to persist in the global sandbox config. */
	global: string[];
}

/** Keyboard key for each unlock scope. */
const SCOPE_KEYS: ReadonlyMap<KeyId, UnlockScope> = new Map<KeyId, UnlockScope>([
	["t", "temporary"],
	["r", "repo"],
	["g", "global"],
]);

/** One row shown in the picker. */
export interface PickerRow {
	/** Which section the row belongs to. "blocked" and "custom" rows can be marked. */
	section: "blocked" | "custom" | "repo" | "global";
	/** Realpath-resolved path the row describes. */
	path: string;
	/** Directory an unlock would allow: the row path itself, or its parent for blocked files. */
	target: string;
	/** Path as it appeared in the tool input, for blocked rows. */
	original: string;
	/** Tool that issued the blocked call; empty for unlocked rows. */
	tool: string;
	/** Epoch milliseconds of the block; 0 for unlocked rows. */
	timestamp: number;
}

/** Inputs to buildPickerRows, all plain data so tests need no live sandbox state. */
export interface PickerSources {
	/** Recent blocked paths from the persistent journal, oldest to newest. */
	journal: JournalEntry[];
	/** Recent blocked paths from the in-memory history ring, oldest to newest. */
	history: BlockedEntry[];
	/** Prefixes already allowed (session, global, and extension paths). Blocked entries under them are hidden. */
	alreadyUnlocked: string[];
	/** Repo-config unlocked roots to list in the picker. */
	repoPaths: string[];
	/** Globally unlocked roots to list in the picker. */
	globalPaths: string[];
}

/**
 * Maximum blocked rows kept in the picker: the 10 most recently blocked paths.
 * Older entries stay in the journal/history sources but are not offered.
 */
const MAX_BLOCKED_ROWS = 10;

/**
 * Build the picker rows: globally unlocked roots, then repo-config unlocked
 * roots (both sorted), then blocked paths from both sources merged, deduped
 * by path (newest occurrence wins, newest first), capped at the 10 most
 * recent, with already-unlocked entries hidden. Blocked entries whose paths
 * are identical keep only the newest occurrence, matching the dedupe of the
 * journal and of recordBlocked.
 */
export function buildPickerRows(sources: PickerSources): PickerRow[] {
	const newestByPath = new Map<string, { original: string; tool: string; timestamp: number }>();
	for (const entry of [...sources.journal, ...sources.history]) {
		const existing = newestByPath.get(entry.path);
		if (!existing || entry.timestamp >= existing.timestamp) {
			newestByPath.set(entry.path, { original: entry.original, tool: entry.tool, timestamp: entry.timestamp });
		}
	}
	const blocked = [...newestByPath.entries()]
		.filter(([path]) => !sources.alreadyUnlocked.some((prefix) => isUnderRealPrefix(path, prefix)))
		.sort((a, b) => b[1].timestamp - a[1].timestamp)
		.slice(0, MAX_BLOCKED_ROWS)
		.map(([path, meta]) => ({
			section: "blocked" as const,
			path,
			target: unlockTargetFor(path),
			original: meta.original,
			tool: meta.tool,
			timestamp: meta.timestamp,
		}));

	const unlockedRow = (section: "repo" | "global") => (path: string): PickerRow => ({
		section,
		path,
		target: path,
		original: path,
		tool: "",
		timestamp: 0,
	});

	return [
		...[...sources.globalPaths].sort().map(unlockedRow("global")),
		...[...sources.repoPaths].sort().map(unlockedRow("repo")),
		...blocked,
	];
}

/**
 * Extract the unlock plan from the current marks (keyed by blocked or
 * custom row path),
 * preserving row order and dropping duplicate unlock targets: several marked
 * files in one directory yield a single unlock of that directory.
 */
export function planFromMarks(rows: PickerRow[], marks: ReadonlyMap<string, UnlockScope>): UnlockPlan {
	const plan: UnlockPlan = { temporary: [], repo: [], global: [] };
	const seen = new Set<string>();
	for (const row of rows) {
		if (row.section === "repo" || row.section === "global") {
			continue;
		}
		const scope = marks.get(row.path);
		if (scope === undefined || seen.has(row.target)) {
			continue;
		}
		seen.add(row.target);
		plan[scope].push(row.target);
	}
	return plan;
}

/** Maximum rows rendered at once; older rows scroll into view. */
const MAX_VISIBLE_ROWS = 18;

/** One entry of the hint table: a key and its description, printed on one line. */
interface HintEntry {
	/** Key name, bright green in the first table column. */
	key: string;
	/** Description, dim in the second table column. */
	label: string;
}

/** Bold bright green (ANSI 92), used for the hint keys and the section headers. */
const brightGreen = (s: string): string => `\x1b[1;92m${s}\x1b[22;39m`;

/** Hint table entries: marking keys first, then the custom path, then movement keys. */
const HINT_ENTRIES: readonly HintEntry[] = [
	{ key: "t", label: "unlock for session" },
	{ key: "r", label: "perm unlock for repo" },
	{ key: "g", label: "perm unlock globally" },
	{ key: "space", label: "clear" },
	{ key: "c", label: "add a custom path" },
	{ key: "↑↓", label: "move" },
	{ key: "PgUp/PgDn", label: "scroll the box" },
	{ key: "enter", label: "save & exit" },
	{ key: "esc", label: "cancel" },
];

/** Gap between the key and description columns, in visible columns. */
const HINT_COLUMN_GAP = 2;

/** Width of the key column: the widest key, so all descriptions align. */
const HINT_KEY_COLUMN_WIDTH = Math.max(...HINT_ENTRIES.map((e) => visibleWidth(e.key)));

/** Smallest box width that fits the hint table: content plus lead and borders. */
const HINT_MIN_WIDTH =
	HINT_KEY_COLUMN_WIDTH +
	HINT_COLUMN_GAP +
	Math.max(...HINT_ENTRIES.map((e) => visibleWidth(e.label))) +
	4;

/** Pad a plain string with spaces to a visible width. */
const padTo = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - visibleWidth(s)));

/**
 * Build the hint table, one line per key: bright green keys in the first
 * column, descriptions aligned in the second. No borders or separators.
 */
export function hintLines(theme: Theme): string[] {
	const gap = " ".repeat(HINT_COLUMN_GAP);
	return HINT_ENTRIES.map(
		(e) =>
			`${padTo(brightGreen(e.key), HINT_KEY_COLUMN_WIDTH)}${gap}${theme.fg("dim", e.label)}`,
	);
}

/**
 * Overlay component for /sandbox-unblock-paths. Not constructed directly by
 * tests; they exercise buildPickerRows and planFromMarks instead, plus this
 * class's handleInput state machine with a stub theme.
 */
export class UnblockPicker implements Focusable {
	readonly width: number;
	focused = false;

	private selected = 0;
	/** Index of the first visible row; the window follows the selection. */
	private top = 0;
	/** Marks keyed by blocked or custom row path, so a keypress tags exactly one row. */
	private marks = new Map<string, UnlockScope>();
	/** True while the custom-path input at the bottom of the box has focus. */
	private inputMode = false;
	/** Text typed into the custom-path input. */
	private inputText = "";
	/** Scroll offset of the whole box, when it is taller than the viewport. */
	private scroll = 0;
	/** Viewport height in content lines; Infinity when the whole box fits. */
	private view = Number.POSITIVE_INFINITY;
	/**
	 * True when the viewport should track the selection (movement and marking);
	 * false after PgUp/PgDn scroll the box freely. c sets it false and jumps
	 * to the bottom so the custom-path input comes into view.
	 */
	private followSelection = true;

	/**
	 * @param theme Active pi theme for colors.
	 * @param done Callback that ends the overlay: Enter passes the plan
	 *   (empty when nothing is marked), Escape passes undefined.
	 * @param rows Rows from buildPickerRows, in display order.
	 * @param availableRows Terminal height the box must fit into; Infinity
	 *   when the viewport is unknown. A too-tall box keeps every row and
	 *   scrolls as a whole inside the viewport instead of being clipped.
	 */
	constructor(
		private theme: Theme,
		private done: (result: UnlockPlan | undefined) => void,
		private rows: PickerRow[],
		private availableRows: () => number = () => Number.POSITIVE_INFINITY,
	) {
		// Row content is cursor + mark tag + path; 76 covers the longest legend
		// line, and HINT_MIN_WIDTH covers the two flat hint rows.
		const longest = this.rows.reduce((m, r) => Math.max(m, visibleWidth(displayPath(r.path))), 24);
		this.width = Math.min(116, Math.max(76, longest + 10, HINT_MIN_WIDTH));
	}

	/** No cached rendering state; re-render always reads the live marks. */
	invalidate(): void {}

	handleInput(data: string): void {
		if (this.inputMode) {
			this.handleInputMode(data);
			return;
		}
		if (matchesKey(data, "escape")) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			this.done(planFromMarks(this.rows, this.marks));
			return;
		}
		if (matchesKey(data, "pageUp")) {
			// Page keys scroll the box itself; the selection stays put.
			this.scroll -= this.pageStep();
			this.followSelection = false;
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scroll += this.pageStep();
			this.followSelection = false;
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.move(1);
			return;
		}
		if (matchesKey(data, "c")) {
			this.inputMode = true;
			this.inputText = "";
			// Reveal the input row at the bottom of the box.
			this.scroll = Number.MAX_SAFE_INTEGER;
			this.followSelection = false;
			return;
		}
		const row = this.rows[this.selected];
		if (row?.section !== "blocked" && row?.section !== "custom") {
			return;
		}
		// Marking acts on the selection, so bring it back into view.
		this.followSelection = true;
		if (matchesKey(data, "space")) {
			this.marks.delete(row.path);
			return;
		}
		for (const [key, scope] of SCOPE_KEYS) {
			if (matchesKey(data, key)) {
				if (this.marks.get(row.path) === scope) {
					this.marks.delete(row.path);
				} else {
					this.marks.set(row.path, scope);
				}
				return;
			}
		}
	}

	/**
	 * Keys while the custom-path input has focus: printable characters and
	 * backspace edit, Enter adds the path to the list, Escape cancels the
	 * input but keeps the picker open.
	 */
	private handleInputMode(data: string): void {
		if (matchesKey(data, "escape")) {
			this.inputMode = false;
			this.inputText = "";
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			this.submitCustomPath();
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.inputText = this.inputText.slice(0, -1);
			return;
		}
		// Append printable characters; multi-character pastes arrive as one string.
		if (/^[\x20-\x7e]+$/.test(data)) {
			this.inputText += data;
		}
	}

	/** Add the typed path as a custom row and select it; duplicates reselect. */
	private submitCustomPath(): void {
		this.inputMode = false;
		const typed = this.inputText.trim();
		this.inputText = "";
		if (typed === "") {
			return;
		}
		const path = resolve(expandTilde(typed));
		const existing = this.rows.findIndex((r) => r.section === "custom" && r.path === path);
		if (existing !== -1) {
			this.selected = existing;
			return;
		}
		this.rows.push({
			section: "custom",
			path,
			target: unlockTargetFor(path),
			original: typed,
			tool: "",
			timestamp: 0,
		});
		this.selected = this.rows.length - 1;
	}

	/** The current marks, exposed for tests and the legend count. */
	currentMarks(): ReadonlyMap<string, UnlockScope> {
		return this.marks;
	}

	render(_width: number): string[] {
		const { lines: content, selectedLine } = this.contentLines();
		const available = this.availableRows();
		if (!Number.isFinite(available) || content.length + 2 <= available) {
			this.view = Number.POSITIVE_INFINITY;
			this.scroll = 0;
			return [this.boxBorder("top", false), ...content, this.boxBorder("bottom", false)];
		}
		// The terminal is shorter than the box: every row keeps its line and
		// the whole box scrolls. Selection movement and marking track the
		// selected line; PgUp/PgDn scroll freely, and the borders carry ↑/↓
		// when content lies beyond them.
		const view = Math.max(1, available - 2);
		this.view = view;
		this.scroll = Math.max(0, Math.min(this.scroll, content.length - view));
		if (this.followSelection) {
			if (selectedLine < this.scroll) {
				this.scroll = selectedLine;
			} else if (selectedLine >= this.scroll + view) {
				this.scroll = selectedLine - view + 1;
			}
		}
		return [
			this.boxBorder("top", this.scroll > 0),
			...content.slice(this.scroll, this.scroll + view),
			this.boxBorder("bottom", this.scroll + view < content.length),
		];
	}

	/** Lines the PageUp/PageDown keys jump, in box content lines. */
	private pageStep(): number {
		return Number.isFinite(this.view) ? Math.max(1, this.view - 1) : MAX_VISIBLE_ROWS;
	}

	/** Top or bottom border; the arrow marks content hidden beyond it. */
	private boxBorder(edge: "top" | "bottom", arrow: boolean): string {
		const th = this.theme;
		const innerW = this.width - 2;
		const head = edge === "top" ? "╭" : "╰";
		const glyph = edge === "top" ? "↑" : "↓";
		const tail = edge === "top" ? "╮" : "╯";
		const inner = arrow ? `${"─".repeat(innerW - 3)} ${glyph} ` : "─".repeat(innerW);
		return th.fg("border", `${head}${inner}${tail}`);
	}

	/** All box lines between the borders, plus the content line the selection sits on. */
	private contentLines(): { lines: string[]; selectedLine: number } {
		const th = this.theme;
		const lines: string[] = [];
		let selectedLine = 0;
		lines.push(this.boxRow(` ${th.fg("accent", "🛡 Sandbox paths")}`));
		for (const hint of hintLines(th)) {
			lines.push(this.boxRow(`  ${hint}`));
		}
		lines.push(this.boxRow(""));

		const sections: Array<{ section: PickerRow["section"]; title: string }> = [
			{ section: "global", title: "Unlocked globally" },
			{ section: "repo", title: "Unlocked in repo config" },
			{ section: "blocked", title: `Blocked paths (${MAX_BLOCKED_ROWS} most recent)` },
		];
		// The custom section appears only after the user adds a path.
		if (this.rows.some((r) => r.section === "custom")) {
			sections.push({ section: "custom", title: "Custom path" });
		}

		// The row window can leave top past the last page; clamp it.
		const top = Math.min(this.top, Math.max(0, this.rows.length - MAX_VISIBLE_ROWS));
		const visibleRows = this.rows.slice(top, top + MAX_VISIBLE_ROWS);
		for (const { section, title } of sections) {
			const sectionRows = this.rows.filter((r) => r.section === section);
			lines.push(this.boxRow(` ${brightGreen(`${title} (${sectionRows.length})`)}`));
			if (sectionRows.length === 0) {
				lines.push(this.boxRow(`   ${th.fg("dim", "(none)")}`));
				continue;
			}
			const visibleSection = visibleRows.filter((r) => r.section === section);
			for (const r of visibleSection) {
				if (this.rows[this.selected] === r) {
					selectedLine = lines.length;
				}
				lines.push(this.boxRow(this.renderRow(r)));
			}
			const hidden = sectionRows.length - visibleSection.length;
			if (hidden > 0) {
				lines.push(this.boxRow(`   ${th.fg("dim", `… ${hidden} more (scroll down)`)}`));
			}
		}

		lines.push(this.boxRow(this.renderInput()));
		lines.push(this.boxRow(""));
		lines.push(this.boxRow(` ${th.fg("accent", this.legendLine())}`));
		return { lines, selectedLine };
	}

	/** The always-visible custom-path input row at the bottom of the box. */
	private renderInput(): string {
		const th = this.theme;
		if (this.inputMode) {
			return ` ${th.fg("accent", "custom path:")} ${this.inputText}${th.fg("accent", "▌")}`;
		}
		return ` ${th.fg("dim", "custom path: press c, type, enter to add")}`;
	}

	/** One content line, padded to the box interior and wrapped in borders. */
	private boxRow(content: string): string {
		const th = this.theme;
		const innerW = this.width - 2;
		const padding = " ".repeat(Math.max(0, innerW - visibleWidth(content)));
		return th.fg("border", "│") + content + padding + th.fg("border", "│");
	}

	/** One line of the legend under the list, summarizing the current marks. */
	private legendLine(): string {
		const counts = { temporary: 0, repo: 0, global: 0 };
		for (const scope of this.marks.values()) {
			counts[scope]++;
		}
		const total = counts.temporary + counts.repo + counts.global;
		if (total === 0) {
			return "Nothing marked yet — press enter to open with the current state saved.";
		}
		return `Marked ${total} path(s): ${counts.temporary} session, ${counts.repo} repo, ${counts.global} global. Enter applies and saves.`;
	}

	/** Render one row: cursor, mark tag in front of the path. */
	private renderRow(r: PickerRow): string {
		const th = this.theme;
		const index = this.rows.indexOf(r);
		const cursor = index === this.selected ? th.fg("accent", "❯") : " ";
		if (r.section === "repo" || r.section === "global") {
			return ` ${cursor} ${th.fg("success", "✓")} ${th.fg("dim", displayPath(r.path))}`;
		}
		const mark = this.marks.get(r.path);
		// Padded so marked and unmarked paths stay aligned.
		const tag = mark === undefined ? "    " : `${th.fg("warning", `[${mark === "temporary" ? "t" : mark === "repo" ? "r" : "g"}]`)} `;
		return ` ${cursor} ${tag}${displayPath(r.path)}`;
	}

	/** Move the selection by delta, keeping it inside the rows and the window. */
	private move(delta: number): void {
		if (this.rows.length === 0) {
			return;
		}
		this.followSelection = true;
		this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + delta));
		if (this.selected < this.top) {
			this.top = this.selected;
		} else if (this.selected >= this.top + MAX_VISIBLE_ROWS) {
			this.top = this.selected - MAX_VISIBLE_ROWS + 1;
		}
	}
}