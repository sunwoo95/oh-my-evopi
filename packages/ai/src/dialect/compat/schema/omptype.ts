/**
 * Minimal structural stand-in for `@oh-my-pi/omptype`'s `Type` (an ArkType
 * schema instance). The upstream `@oh-my-pi/ai` dialect subsystem accepts tool
 * parameters authored either as ArkType schemas or as plain JSON Schema. evopi
 * tools always carry plain JSON Schema (typebox), so `isArkSchema()` never
 * matches here and the ArkType conversion branch is dead code — but the two
 * functions that reference `Type` (`isArkSchema`, `arkToWireSchema`) still need
 * a type to compile against. This reproduces only the surface those functions
 * touch (`toJsonSchema` / `assert`), so no ArkType runtime dependency is pulled
 * into the backport.
 */
export interface Type {
	toJsonSchema(options: { target: string; fallback: (ctx: { base: unknown }) => unknown }): unknown;
	assert(...args: unknown[]): unknown;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	[key: string]: any;
}
