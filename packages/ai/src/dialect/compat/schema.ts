/**
 * Compat surface for the two schema helpers the dialect subsystem imports from
 * `@oh-my-pi/ai`'s `../utils/schema` barrel:
 *   - `toolWireSchema`         (catalog.ts, coercion.ts)
 *   - `jsonSchemaToTypeScript` (inventory.ts)
 *
 * The upstream barrel re-exports a dozen schema modules; only these two chains
 * are reachable from the dialect files, so only `wire.ts` (+ its `draft`/
 * `stamps`/`equality`/`types` deps) and `typescript.ts` are backported. The
 * sole external upstream dependency, ArkType's `Type`, is stubbed structurally
 * (see ./schema/omptype.ts) because evopi tools carry plain JSON Schema.
 */
export { toolWireSchema } from "./schema/wire.js";
export { jsonSchemaToTypeScript, type JsonSchemaToTsOptions } from "./schema/typescript.js";
