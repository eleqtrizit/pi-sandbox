/**
 * The interactive path picker behind /sandbox-unblock-paths.
 *
 * Shows three sections in one overlay: paths unlocked globally, paths
 * unlocked in the repo config, and the 10 most recently blocked paths
 * (merged from the persistent journal and the in-memory history). The user
 * moves with the arrow keys,
 * marks blocked rows with t (temporary, this session), r (repo config), or
 * g (global config), clears a mark with space, and exits with Enter, which applies the marks and saves
 * the sandbox config automatically. Escape discards the marks.
 *
 * Row building and plan extraction are pure functions so tests can cover the
 * merge/dedupe/filter logic without a terminal; the component only adds
 * navigation, marking, and rendering on top.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, type Focusable, type KeyId } from "@earendil-works/pi-tui";
import { type BlockedEntry } from "./state.js";
import type { JournalEntry } from "./journal.js";
import { isUnderRealPrefix } from "./fs-utils.js";
import { unlockTargetFor } from "./paths.js";
import { ageMs, displayPath } from "./display.js";

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
	/** Which section the row belongs to. Only "blocked" rows can be marked. */
	section: "blocked" | "repo" | "global";
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
 * Extract the unlock plan from the current marks (keyed by blocked row path),
 * preserving row order and dropping duplicate unlock targets: several marked
 * files in one directory yield a single unlock of that directory.
 */
export function planFromMarks(rows: PickerRow[], marks: ReadonlyMap<string, UnlockScope>): UnlockPlan {
	const plan: UnlockPlan = { temporary: [], repo: [], global: [] };
	const seen = new Set<string>();
	for (const row of rows) {
		if (row.section !== "blocked") {
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

/** One column of the hint table: a key and the description printed under it. */
interface HintColumn {
	/** Key name, bright green in the first table row. */
	key: string;
	/** Description, dim in the second table row. */
	label: string;
}

/** Bold bright green (ANSI 92), used for the hint keys and the section headers. */
const brightGreen = (s: string): string => `\x1b[1;92m${s}\x1b[22;39m`;

/** Hint table columns: marking keys first, movement keys second. */
const HINT_COLUMNS: readonly HintColumn[] = [
	{ key: "t", label: "unlock for session" },
	{ key: "r", label: "perm unlock for repo" },
	{ key: "g", label: "perm unlock globally" },
	{ key: "space", label: "clear" },
	{ key: "↑↓", label: "move" },
	{ key: "enter", label: "save & exit" },
	{ key: "esc", label: "cancel" },
];

/** Lead-in of the hint table's first row. */
const HINT_PREFIX = "Press ";

/** Gap between hint table columns, in visible columns. */
const HINT_COLUMN_GAP = 2;

/** Column widths: each column fits both its key and its description. */
const HINT_COLUMN_WIDTHS: readonly number[] = HINT_COLUMNS.map((c) => Math.max(visibleWidth(c.key), visibleWidth(c.label)));

/** Smallest box width that fits the hint table: content plus lead and borders. */
const HINT_MIN_WIDTH =
	visibleWidth(HINT_PREFIX) +
	HINT_COLUMN_WIDTHS.reduce((sum, w) => sum + w, 0) +
	HINT_COLUMN_GAP * (HINT_COLUMNS.length - 1) +
	4;

/** Pad a plain string with spaces to a visible width. */
const padTo = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - visibleWidth(s)));

/**
 * Build the two-row hint table: bright green keys in the first row, their
 * descriptions aligned underneath in the second. No borders or separators;
 * the box widens to HINT_MIN_WIDTH so the table always prints flat.
 */
export function hintLines(theme: Theme): string[] {
	const gap = " ".repeat(HINT_COLUMN_GAP);
	const prefix = theme.fg("dim", HINT_PREFIX);
	const keysRow =
		prefix + HINT_COLUMNS.map((c, i) => padTo(brightGreen(c.key), HINT_COLUMN_WIDTHS[i]!)).join(gap);
	const labelsRow =
		" ".repeat(visibleWidth(HINT_PREFIX)) +
		HINT_COLUMNS.map((c, i) => theme.fg("dim", padTo(c.label, HINT_COLUMN_WIDTHS[i]!))).join(gap);
	return [keysRow, labelsRow];
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
	/** Marks keyed by blocked row path, so a keypress tags exactly one row. */
	private marks = new Map<string, UnlockScope>();

	/**
	 * @param theme Active pi theme for colors.
	 * @param done Callback that ends the overlay: Enter passes the plan
	 *   (empty when nothing is marked), Escape passes undefined.
	 * @param rows Rows from buildPickerRows, in display order.
	 */
	constructor(
		private theme: Theme,
		private done: (result: UnlockPlan | undefined) => void,
		private rows: PickerRow[],
	) {
		// Row content is cursor + mark tag + path; 76 covers the longest legend
		// line, and HINT_MIN_WIDTH covers the two flat hint rows.
		const longest = this.rows.reduce((m, r) => Math.max(m, visibleWidth(displayPath(r.path))), 24);
		this.width = Math.min(116, Math.max(76, longest + 10, HINT_MIN_WIDTH));
	}

	/** No cached rendering state; re-render always reads the live marks. */
	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			this.done(planFromMarks(this.rows, this.marks));
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
		const row = this.rows[this.selected];
		if (row?.section !== "blocked") {
			return;
		}
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

	/** The current marks, exposed for tests and the legend count. */
	currentMarks(): ReadonlyMap<string, UnlockScope> {
		return this.marks;
	}

	render(_width: number): string[] {
		const th = this.theme;
		const innerW = this.width - 2;
		const lines: string[] = [];
		const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
		const row = (content: string) => th.fg("border", "│") + pad(content, innerW) + th.fg("border", "│");

		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		lines.push(row(` ${th.fg("accent", "🛡 Sandbox paths")}`));
		for (const hint of hintLines(th)) {
			lines.push(row(`  ${hint}`));
		}
		lines.push(row(""));

		const sections: Array<{ section: PickerRow["section"]; title: string }> = [
			{ section: "global", title: "Unlocked globally" },
			{ section: "repo", title: "Unlocked in repo config" },
			{ section: "blocked", title: `Blocked paths (${MAX_BLOCKED_ROWS} most recent)` },
		];

		const visibleRows = this.rows.slice(this.top, this.top + MAX_VISIBLE_ROWS);
		for (const { section, title } of sections) {
			const sectionRows = this.rows.filter((r) => r.section === section);
			lines.push(row(` ${brightGreen(`${title} (${sectionRows.length})`)}`));
			if (sectionRows.length === 0) {
				lines.push(row(`   ${th.fg("dim", "(none)")}`));
				continue;
			}
			const visibleSection = visibleRows.filter((r) => r.section === section);
			for (const r of visibleSection) {
				lines.push(row(this.renderRow(r)));
			}
			const hidden = sectionRows.length - visibleSection.length;
			if (hidden > 0) {
				lines.push(row(`   ${th.fg("dim", `… ${hidden} more (scroll down)`)}`));
			}
		}

		lines.push(row(""));
		lines.push(row(` ${th.fg("accent", this.legendLine())}`));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return lines;
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
		if (r.section !== "blocked") {
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
		this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + delta));
		if (this.selected < this.top) {
			this.top = this.selected;
		} else if (this.selected >= this.top + MAX_VISIBLE_ROWS) {
			this.top = this.selected - MAX_VISIBLE_ROWS + 1;
		}
	}
}