/**
 * Zod-style schema facade over TypeBox — oh-my-pi extension compatibility.
 *
 * oh-my-pi injects `pi.zod` into extensions (an omptype "ZodLike" builder,
 * `oh-my-pi/packages/omptype/src/zod.ts`), and most omp example extensions
 * author tool parameters as `pi.zod.object({...})`. evopi tools validate with
 * TypeBox (`typebox/value`), so instead of porting omptype (arktype IR compiler)
 * this facade materializes REAL TypeBox schemas and attaches the fluent Zod-v4
 * surface as non-enumerable properties:
 *
 * - the returned value IS a `TSchema`, so it can be passed straight to
 *   `registerTool({ parameters })` and to `validateToolArguments`;
 * - `JSON.stringify`, `Object.keys`, and object spread never see the helpers,
 *   so provider-bound JSON schema stays clean;
 * - TypeBox's non-enumerable `~kind` / `~optional` markers are preserved
 *   (mutations clone via property descriptors, never via spread).
 *
 * Coverage mirrors omp's facade: string/number/boolean/literal/enum/union/
 * array/object/record/unknown/any/null/undefined + describe/optional/nullable/
 * default/min/max/int/positive/nonnegative/regex/url/strict/passthrough/strip/
 * partial + parse/safeParse. `refine`/`transform`/`catch` cannot be expressed
 * as JSON Schema: they return the schema unchanged (documented limitation —
 * validation happens on the JSON-schema shape only).
 */

import { StringEnum } from "@evopi/pi-ai";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

/** Phantom marker carried by `.optional()`/`.default()` results (type-level only). */
export interface OptionalSchemaMarker {
	readonly _optional: true;
}

export interface ZodLikeIssue {
	path: PropertyKey[];
	message: string;
}

export type ZodLikeSafeParseResult<Out> =
	| { success: true; data: Out }
	| { success: false; error: { message: string; issues: ZodLikeIssue[] } };

/** A TypeBox schema carrying the Zod-v4-style fluent surface (helpers are non-enumerable). */
export type ZodLikeSchema<Out = unknown> = TSchema & {
	/** Type-level output marker (never present at runtime). */
	readonly _output: Out;
	parse(value: unknown): Out;
	safeParse(value: unknown): ZodLikeSafeParseResult<Out>;
	describe(description: string): ZodLikeSchema<Out>;
	optional(): ZodLikeSchema<Out | undefined> & OptionalSchemaMarker;
	nullable(): ZodLikeSchema<Out | null>;
	default(
		value: Exclude<Out, undefined> | (() => Exclude<Out, undefined>),
	): ZodLikeSchema<Exclude<Out, undefined>> & OptionalSchemaMarker;
	min(bound: number): ZodLikeSchema<Out>;
	max(bound: number): ZodLikeSchema<Out>;
	int(): ZodLikeSchema<Out>;
	positive(): ZodLikeSchema<Out>;
	nonnegative(): ZodLikeSchema<Out>;
	regex(expression: RegExp, message?: string): ZodLikeSchema<Out>;
	url(): ZodLikeSchema<Out>;
	refine(predicate: (value: Out) => unknown, messageOrOptions?: string | { message?: string }): ZodLikeSchema<Out>;
	transform<Next>(transformer: (value: Out) => Next): ZodLikeSchema<Next>;
	catch(fallback: Out | (() => Out)): ZodLikeSchema<Out>;
	strict(): ZodLikeSchema<Out>;
	passthrough(): ZodLikeSchema<Out & Record<string, unknown>>;
	strip(): ZodLikeSchema<Out>;
	partial(): ZodLikeSchema<Partial<Out>>;
};

type SchemaOutput<Schema> = Schema extends { readonly _output: infer Out } ? Out : never;
type Shape = Readonly<Record<string, ZodLikeSchema<unknown>>>;
type ObjectOutput<S extends Shape> = {
	-readonly [K in keyof S as S[K] extends OptionalSchemaMarker ? never : K]: SchemaOutput<S[K]>;
} & {
	-readonly [K in keyof S as S[K] extends OptionalSchemaMarker ? K : never]?: SchemaOutput<S[K]>;
};
type Simplify<T> = { [K in keyof T]: T[K] };
type UnionOutput<Schemas extends readonly ZodLikeSchema<unknown>[]> = SchemaOutput<Schemas[number]>;

const HELPER_NAMES = [
	"parse",
	"safeParse",
	"describe",
	"optional",
	"nullable",
	"default",
	"min",
	"max",
	"int",
	"positive",
	"nonnegative",
	"regex",
	"url",
	"refine",
	"transform",
	"catch",
	"strict",
	"passthrough",
	"strip",
	"partial",
] as const;

/** Clone a TypeBox schema preserving its non-enumerable markers, then apply enumerable patches. */
function cloneWith(schema: TSchema, patch: Record<string, unknown> = {}, remove: string[] = []): TSchema {
	const descriptors = Object.getOwnPropertyDescriptors(schema) as Record<string, PropertyDescriptor>;
	// Drop the (non-enumerable) helpers so a patched key such as `default` becomes a
	// plain enumerable JSON-schema value instead of silently updating the helper slot.
	for (const name of HELPER_NAMES) {
		if (descriptors[name] && !descriptors[name].enumerable) delete descriptors[name];
	}
	const clone = Object.create(Object.getPrototypeOf(schema), descriptors) as Record<string, unknown>;
	for (const key of remove) delete clone[key];
	for (const [key, value] of Object.entries(patch)) clone[key] = value;
	return clone as TSchema;
}

function schemaType(schema: TSchema): string | undefined {
	const type = (schema as { type?: unknown }).type;
	return typeof type === "string" ? type : undefined;
}

function isObjectSchema(schema: TSchema): boolean {
	return schemaType(schema) === "object" && typeof (schema as { properties?: unknown }).properties === "object";
}

function formatIssues(schema: TSchema, value: unknown): ZodLikeIssue[] {
	return [...Value.Errors(schema, value)].map((issue) => ({
		path: issue.instancePath
			.split("/")
			.filter((segment) => segment.length > 0)
			.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~")),
		message: issue.message,
	}));
}

/** Attach the fluent helpers to `schema` (non-enumerable, configurable) and return it typed. */
function decorate<Out>(schema: TSchema): ZodLikeSchema<Out> {
	const helpers: Record<(typeof HELPER_NAMES)[number], (...args: never[]) => unknown> = {
		parse(value: unknown): Out {
			if (Value.Check(schema, value)) return value as Out;
			const issues = formatIssues(schema, value);
			throw new Error(issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; "));
		},
		safeParse(value: unknown): ZodLikeSafeParseResult<Out> {
			if (Value.Check(schema, value)) return { success: true, data: value as Out };
			const issues = formatIssues(schema, value);
			return {
				success: false,
				error: { message: issues.map((issue) => issue.message).join("; "), issues },
			};
		},
		describe(description: string) {
			return decorate<Out>(cloneWith(schema, { description }));
		},
		optional() {
			return decorate<Out | undefined>(Type.Optional(cloneWith(schema)));
		},
		nullable() {
			const description = (schema as { description?: string }).description;
			return decorate<Out | null>(
				Type.Union([cloneWith(schema), Type.Null()], description ? { description } : undefined),
			);
		},
		default(value: unknown) {
			const resolved = typeof value === "function" ? (value as () => unknown)() : value;
			return decorate(Type.Optional(cloneWith(schema, { default: resolved })));
		},
		min(bound: number) {
			const type = schemaType(schema);
			if (type === "string") return decorate<Out>(cloneWith(schema, { minLength: bound }));
			if (type === "array") return decorate<Out>(cloneWith(schema, { minItems: bound }));
			if (type === "number" || type === "integer") return decorate<Out>(cloneWith(schema, { minimum: bound }));
			throw new Error(`cannot apply min to ${type ?? "this schema"}`);
		},
		max(bound: number) {
			const type = schemaType(schema);
			if (type === "string") return decorate<Out>(cloneWith(schema, { maxLength: bound }));
			if (type === "array") return decorate<Out>(cloneWith(schema, { maxItems: bound }));
			if (type === "number" || type === "integer") return decorate<Out>(cloneWith(schema, { maximum: bound }));
			throw new Error(`cannot apply max to ${type ?? "this schema"}`);
		},
		int() {
			const type = schemaType(schema);
			if (type !== "number" && type !== "integer") throw new Error(`cannot apply int to ${type ?? "this schema"}`);
			// Rebuild through TypeBox so the `~kind` marker matches the new type.
			const options = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "type"));
			return decorate<Out>(Type.Integer(options));
		},
		positive() {
			const type = schemaType(schema);
			if (type !== "number" && type !== "integer")
				throw new Error(`cannot apply positive to ${type ?? "this schema"}`);
			return decorate<Out>(cloneWith(schema, { exclusiveMinimum: 0 }, ["minimum"]));
		},
		nonnegative() {
			const type = schemaType(schema);
			if (type !== "number" && type !== "integer") {
				throw new Error(`cannot apply nonnegative to ${type ?? "this schema"}`);
			}
			return decorate<Out>(cloneWith(schema, { minimum: 0 }, ["exclusiveMinimum"]));
		},
		regex(expression: RegExp) {
			if (schemaType(schema) !== "string") throw new Error("cannot apply regex to a non-string schema");
			return decorate<Out>(cloneWith(schema, { pattern: expression.source }));
		},
		url() {
			if (schemaType(schema) !== "string") throw new Error("cannot apply url to a non-string schema");
			return decorate<Out>(cloneWith(schema, { format: "uri" }));
		},
		// Refinements/transforms have no JSON-schema form; the wire schema is unchanged.
		refine() {
			return decorate<Out>(schema);
		},
		transform() {
			return decorate(schema);
		},
		catch() {
			return decorate<Out>(schema);
		},
		strict() {
			if (!isObjectSchema(schema)) throw new Error("strict requires an object schema");
			return decorate<Out>(cloneWith(schema, { additionalProperties: false }));
		},
		passthrough() {
			if (!isObjectSchema(schema)) throw new Error("passthrough requires an object schema");
			return decorate(cloneWith(schema, { additionalProperties: true }));
		},
		strip() {
			if (!isObjectSchema(schema)) throw new Error("strip requires an object schema");
			return decorate<Out>(cloneWith(schema, {}, ["additionalProperties"]));
		},
		partial() {
			if (!isObjectSchema(schema)) throw new Error("partial requires an object schema");
			return decorate(Type.Partial(schema as Parameters<typeof Type.Partial>[0]));
		},
	};
	for (const name of HELPER_NAMES) {
		// `default` is both a Zod helper and a JSON-schema keyword: once a schema
		// carries a default VALUE that key stays the enumerable value (the helper is
		// not re-attached, so `.default()` is not chainable twice).
		if (name === "default" && Object.prototype.propertyIsEnumerable.call(schema, "default")) continue;
		Object.defineProperty(schema, name, {
			value: helpers[name],
			enumerable: false,
			configurable: true,
			writable: true,
		});
	}
	return schema as ZodLikeSchema<Out>;
}

export const string = (): ZodLikeSchema<string> => decorate<string>(Type.String());
export const number = (): ZodLikeSchema<number> => decorate<number>(Type.Number());
export const boolean = (): ZodLikeSchema<boolean> => decorate<boolean>(Type.Boolean());
export const literal = <const V extends string | number | boolean>(value: V): ZodLikeSchema<V> =>
	decorate<V>(Type.Literal(value));

const enumSchema = <const Values extends readonly [string, ...string[]]>(
	values: Values,
): ZodLikeSchema<Values[number]> => {
	if (values.length === 0) throw new Error("enum requires at least one value");
	// StringEnum renders as {type:"string", enum:[...]} — accepted by every provider (Google rejects anyOf literals).
	return decorate<Values[number]>(StringEnum(values));
};

export { enumSchema as enum };

export const union = <
	const Schemas extends readonly [ZodLikeSchema<unknown>, ZodLikeSchema<unknown>, ...ZodLikeSchema<unknown>[]],
>(
	schemas: Schemas,
): ZodLikeSchema<UnionOutput<Schemas>> => decorate(Type.Union(schemas.map((schema) => cloneWith(schema))));

export const array = <Element>(element: ZodLikeSchema<Element>): ZodLikeSchema<Element[]> =>
	decorate<Element[]>(Type.Array(cloneWith(element)));

export const object = <const S extends Shape>(shape: S): ZodLikeSchema<Simplify<ObjectOutput<S>>> => {
	const properties: Record<string, TSchema> = {};
	for (const [key, member] of Object.entries(shape)) properties[key] = cloneWith(member);
	return decorate(Type.Object(properties));
};

export const record = <Value_, Key extends string = string>(
	keySchema: ZodLikeSchema<Key>,
	valueSchema: ZodLikeSchema<Value_>,
): ZodLikeSchema<Record<string, Value_>> => {
	if (schemaType(keySchema) !== "string") throw new Error("record keys must use a string schema");
	return decorate<Record<string, Value_>>(Type.Record(Type.String(), cloneWith(valueSchema)));
};

export const unknown = (): ZodLikeSchema<unknown> => decorate<unknown>(Type.Unknown());
export const any = (): ZodLikeSchema<unknown> => decorate<unknown>(Type.Any());
const nullSchema = (): ZodLikeSchema<null> => decorate<null>(Type.Null());
const undefinedSchema = (): ZodLikeSchema<undefined> => decorate<undefined>(Type.Undefined());

export { nullSchema as null, undefinedSchema as undefined };

/** Runtime `z.*` facade injected as `pi.zod`, merged with the `z.infer` type namespace. */
export const z = {
	string,
	number,
	boolean,
	literal,
	enum: enumSchema,
	union,
	array,
	object,
	record,
	unknown,
	any,
	null: nullSchema,
	undefined: undefinedSchema,
};

export namespace z {
	export type infer<Schema> = Schema extends { readonly _output: infer Out } ? Out : never;
}

export type ZodFacade = typeof z;
