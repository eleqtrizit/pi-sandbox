import { describe, expect, it } from "vitest";
import { homeAllowlist, homePaths } from "./allowlist.js";

describe("homeAllowlist", () => {
	it("roots every entry under the given home", () => {
		for (const e of homeAllowlist("/h")) expect(e.path.startsWith("/h/")).toBe(true);
	});

	it("allows uv-managed Python read-only", () => {
		expect(homePaths(false, "/h")).toContain("/h/.local/share/uv");
		expect(homePaths(true, "/h")).not.toContain("/h/.local/share/uv");
	});

	it("keeps pi config and caches writable", () => {
		expect(homePaths(true, "/h")).toEqual(expect.arrayContaining(["/h/.pi", "/h/.agents", "/h/.cache", "/h/.npm"]));
	});

	it("never lists secrets or all of ~/.local/share", () => {
		const all = homeAllowlist("/h").map((e) => e.path);
		for (const secret of ["/h/.gnupg", "/h/.aws", "/h/.local/share", "/h"]) {
			expect(all).not.toContain(secret);
		}
	});

	it("allows ~/.ssh read-only for git remotes", () => {
		expect(homePaths(false, "/h")).toContain("/h/.ssh");
		expect(homePaths(true, "/h")).not.toContain("/h/.ssh");
	});

	it("has no duplicate paths", () => {
		const all = homeAllowlist("/h").map((e) => e.path);
		expect(new Set(all).size).toBe(all.length);
	});
});
