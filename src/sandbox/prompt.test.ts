import { describe, expect, it } from "vitest";
import registerSandbox, { sandboxSystemPromptAddendum } from "./index.js";

describe("sandboxSystemPromptAddendum", () => {
	it("mentions the sandbox root path verbatim", () => {
		const text = sandboxSystemPromptAddendum("/tmp/project");
		expect(text).toContain("you are sandboxed into /tmp/project");
	});

	it("points to both unlock commands", () => {
		const text = sandboxSystemPromptAddendum("/tmp/project");
		expect(text).toContain("/sandbox-unlock");
		expect(text).toContain("/sandbox-unlock-last-path");
	});

	it("explains invisibility of outside directories and the update channel", () => {
		const text = sandboxSystemPromptAddendum("/tmp/project");
		expect(text).toContain("Directories referenced outside this path may exist, but you cannot see them");
		expect(text).toContain("You will get prompts that tell you of updated access to other directories");
	});
});

describe("before_agent_start handler", () => {
	it("prepends the addendum to the rendered system prompt", () => {
		const handlers = new Map<string, (event: unknown) => Promise<unknown>>();
		const pi = {
			on: (event: string, handler: (event: unknown) => Promise<unknown>) => {
				handlers.set(event, handler);
			},
		} as never;
		const stub = (pi as Record<string, unknown>);
		stub.events = { on: () => () => {} };
		stub.registerTool = () => {};
		stub.registerCommand = () => {};
		registerSandbox(pi);
		const handler = handlers.get("before_agent_start");
		expect(handler).toBeDefined();
		const result = handler!({ systemPrompt: "BASE PROMPT" }) as Promise<{ systemPrompt: string }>;
		return result.then((res) => {
			expect(res.systemPrompt.startsWith(sandboxSystemPromptAddendum(process.cwd()))).toBe(true);
			expect(res.systemPrompt.endsWith("BASE PROMPT")).toBe(true);
		});
	});
});
