export * from "./catalog.js";
export * from "./coercion.js";
// Model-id → dialect heuristic, needed by owned-mode consumers (B1/M15) to
// resolve `dialect: "auto"` in models.json.
export { FALLBACK_DIALECT, preferredDialect } from "./compat/identity.js";
export * from "./demotion.js";
export * from "./examples.js";
export * from "./factory.js";
export * from "./history.js";
export * from "./inventory.js";
export * from "./owned-stream.js";
// `./rendering` is a dialect-internal primitives module deliberately excluded
// from the barrel. `renderDelimitedThinking` is the one helper an external
// consumer needs (the legacy markdown `/dump` reuses its `<thinking>` envelope
// unwrap), so re-export only that symbol rather than `export *`-ing the rest.
export { renderDelimitedThinking } from "./rendering.js";
export * from "./thinking.js";
export * from "./types.js";
