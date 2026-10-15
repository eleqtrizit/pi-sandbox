import { describe, expect, it } from "vitest";
import { extractDeniedHomePaths } from "./denials.js";

const HOME = "/Users/u";

describe("extractDeniedHomePaths", () => {
	it("finds paths in macOS EPERM lines", () => {
		const out = "ls: /Users/u/.local/share/uv/python/bin: Operation not permitted\n";
		expect(extractDeniedHomePaths(out, HOME)).toEqual(["/Users/u/.local/share/uv/python/bin"]);
	});

	it("finds paths in cp-style errors with quotes", () => {
		const out = "cp: cannot stat '/Users/u/data/a.txt': No such file or directory";
		expect(extractDeniedHomePaths(out, HOME)).toEqual(["/Users/u/data/a.txt"]);
	});

	it("expands tilde paths", () => {
		expect(extractDeniedHomePaths("cat: ~/notes/x: Permission denied", HOME)).toEqual(["/Users/u/notes/x"]);
	});

	it("ignores paths on lines without a denial phrase", () => {
		expect(extractDeniedHomePaths("building /Users/u/proj/dist ok", HOME)).toEqual([]);
	});

	it("ignores paths outside home and the home directory itself", () => {
		const out = "x: /etc/hosts: Operation not permitted\nlstat '/Users/u': Operation not permitted";
		expect(extractDeniedHomePaths(out, HOME)).toEqual([]);
	});

	it("does not treat a sibling directory with the home prefix as inside home", () => {
		expect(extractDeniedHomePaths("x: /Users/u2/a: Operation not permitted", HOME)).toEqual([]);
	});

	it("dedupes and keeps order of appearance", () => {
		const out = [
			"a: /Users/u/b: Operation not permitted",
			"a: /Users/u/a: Operation not permitted",
			"a: /Users/u/b: Operation not permitted",
		].join("\n");
		expect(extractDeniedHomePaths(out, HOME)).toEqual(["/Users/u/b", "/Users/u/a"]);
	});

	it("normalizes dot segments", () => {
		expect(extractDeniedHomePaths("x: /Users/u/a/../b: Operation not permitted", HOME)).toEqual(["/Users/u/b"]);
	});
});
