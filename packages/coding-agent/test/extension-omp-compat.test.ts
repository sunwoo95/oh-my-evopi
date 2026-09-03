import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, describe, expect, it } from "vitest";
import { loadExtensions } from "../src/core/extensions/loader.js";
import { z } from "../src/core/extensions/zod-compat.js";

describe("zod-compat facade (pi.zod)", () => {
	it("materializes real TypeBox schemas that validate with typebox/value", () => {
		const schema = z.object({
			name: z.string().describe("Name to greet"),
			count: z.number().int().min(1).max(5).optional(),
			mode: z.enum(["fast", "slow"]).default("fast"),
			tags: z.array(z.string()).min(1).optional(),
		});

		// JSON view is a clean JSON schema: no helper functions, TypeBox markers non-enumerable.
		const json = JSON.parse(JSON.stringify(schema));
		expect(json).toEqual({
			type: "object",
			properties: {
				name: { type: "string", description: "Name to greet" },
				count: { type: "integer", minimum: 1, maximum: 5 },
				mode: { type: "string", enum: ["fast", "slow"], default: "fast" },
				tags: { type: "array", items: { type: "string" }, minItems: 1 },
			},
			required: ["name"],
		});
		expect(Object.keys(schema)).not.toContain("parse");

		expect(Value.Check(schema, { name: "pi" })).toBe(true);
		expect(Value.Check(schema, { name: "pi", count: 3, mode: "slow" })).toBe(true);
		expect(Value.Check(schema, { name: "pi", count: 2.5 })).toBe(false);
		expect(Value.Check(schema, { name: "pi", count: 9 })).toBe(false);
		expect(Value.Check(schema, { name: "pi", mode: "medium" })).toBe(false);
		expect(Value.Check(schema, { count: 1 })).toBe(false);
	});

	it("keeps TypeBox kind/optional markers (behaves exactly like Type.* output)", () => {
		const viaZod = z.object({ a: z.string().optional(), b: z.boolean() });
		const viaTypebox = Type.Object({ a: Type.Optional(Type.String()), b: Type.Boolean() });
		expect(JSON.parse(JSON.stringify(viaZod))).toEqual(JSON.parse(JSON.stringify(viaTypebox)));
		for (const value of [{ b: true }, { a: "x", b: false }, { a: 1, b: true }, {}]) {
			expect(Value.Check(viaZod, value)).toBe(Value.Check(viaTypebox, value));
		}
	});

	it("supports parse/safeParse, nullable, literal, union, record and object modes", () => {
		const s = z.string().min(2);
		expect(s.parse("ok")).toBe("ok");
		expect(() => s.parse("x")).toThrow();
		expect(s.safeParse("x").success).toBe(false);
		expect(s.safeParse("xy")).toEqual({ success: true, data: "xy" });

		const nullable = z.number().nullable();
		expect(Value.Check(nullable, null)).toBe(true);
		expect(Value.Check(nullable, 1)).toBe(true);
		expect(Value.Check(nullable, "1")).toBe(false);

		const u = z.union([z.literal("a"), z.literal(1)]);
		expect(Value.Check(u, "a")).toBe(true);
		expect(Value.Check(u, 1)).toBe(true);
		expect(Value.Check(u, 2)).toBe(false);

		const r = z.record(z.string(), z.number());
		expect(Value.Check(r, { x: 1 })).toBe(true);
		expect(Value.Check(r, { x: "1" })).toBe(false);

		const strict = z.object({ a: z.string() }).strict();
		expect(Value.Check(strict, { a: "x", extra: 1 })).toBe(false);
		expect(Value.Check(z.object({ a: z.string() }).passthrough(), { a: "x", extra: 1 })).toBe(true);
		expect(Value.Check(z.object({ a: z.string() }).partial(), {})).toBe(true);

		expect(Value.Check(z.number().positive(), 0)).toBe(false);
		expect(Value.Check(z.number().nonnegative(), 0)).toBe(true);
		expect(Value.Check(z.string().regex(/^[a-z]+$/), "abc")).toBe(true);
		expect(Value.Check(z.string().regex(/^[a-z]+$/), "ABC")).toBe(false);
		expect(JSON.parse(JSON.stringify(z.string().url()))).toEqual({ type: "string", format: "uri" });
	});

	it("refine/transform/catch leave the wire schema unchanged (documented limitation)", () => {
		const base = z.string();
		const refined = base.refine((v) => v.length > 3, "too short");
		expect(JSON.parse(JSON.stringify(refined))).toEqual({ type: "string" });
		expect(Value.Check(refined, "ab")).toBe(true);
	});
});

describe("oh-my-pi extension compatibility (loader)", () => {
	const dir = mkdtempSync(join(tmpdir(), "evopi-omp-ext-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("loads the omp examples/extensions/hello.ts shape verbatim (@oh-my-pi import + pi.zod + pi.logger)", async () => {
		// Copy of oh-my-pi/packages/coding-agent/examples/extensions/hello.ts (read-only upstream sample).
		const file = join(dir, "hello-omp.ts");
		writeFileSync(
			file,
			`import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
export default function (pi: ExtensionAPI) {
	const z = pi.zod;
	pi.registerTool({
		name: "hello",
		label: "Hello",
		description: "A simple greeting tool",
		parameters: z.object({ name: z.string().describe("Name to greet") }),
		async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
			const { name } = params;
			pi.logger.debug("Hello tool executed", { name });
			return { content: [{ type: "text", text: \`Hello, \${name}!\` }], details: { greeted: name } };
		},
	});
}
`,
		);
		const result = await loadExtensions([file], dir);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		const tool = result.extensions[0].tools.get("hello");
		expect(tool).toBeDefined();
		const parameters = tool!.definition.parameters;
		expect(JSON.parse(JSON.stringify(parameters))).toEqual({
			type: "object",
			properties: { name: { type: "string", description: "Name to greet" } },
			required: ["name"],
		});
		expect(Value.Check(parameters, { name: "omp" })).toBe(true);
		expect(Value.Check(parameters, {})).toBe(false);
	});

	it("resolves value imports from @oh-my-pi/pi-ai and @oh-my-pi/pi-tui to the bundled evopi modules", async () => {
		const file = join(dir, "omp-values.ts");
		writeFileSync(
			file,
			`import { Type } from "@oh-my-pi/pi-ai";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "width",
		label: "Width",
		description: "measures",
		parameters: Type.Object({ text: Type.String() }),
		async execute(_id, params) {
			return { content: [{ type: "text", text: String(visibleWidth((params as { text: string }).text)) }], details: {} };
		},
	});
}
`,
		);
		const result = await loadExtensions([file], dir);
		expect(result.errors).toEqual([]);
		expect(result.extensions[0].tools.has("width")).toBe(true);
	});

	it("still reports a broken extension as a load error", async () => {
		const file = join(dir, "broken.ts");
		writeFileSync(file, `export default function () { throw new Error("boom-from-extension"); }\n`);
		const result = await loadExtensions([file], dir);
		expect(result.extensions).toHaveLength(0);
		expect(result.errors[0]?.error).toContain("boom-from-extension");
	});
});
