# Eval results — coding track A/B (STEP 14)

Date: 2026-09-02. Sandbox: x86_64 / Ubuntu 24.04 / node 24 / bun 1.4.0.

## Status: SKIP (no API key) — replaced by keyless faux-provider smokes

The four arms (`evopi-omp`/`evopi-prime`/`evopi-evooff`/`evopi-evoon`) are wired
and documented in `arms.md`. A **real** A/B run is **SKIPPED** per SPEC §7:78.

**SKIP 사유**: an actual run drives a coding agent against a provider model, which
needs a provider API key. Project constraint: real keys live only in the shell
env (`export`), never in a file and never committed — and this sandbox has none
(`env keys present: (none)`, asserted below). So no arm can execute a model turn.

A second, independent reason the *evo-on injection* cannot run keyless: the
grounded planner's LLM call (`grounded-refine.ts:113 defaultGroundedPlanner`)
short-circuits to `undefined` when `getApiKeyAndHeaders` reports no key
(`:126-128`), falling back to the built-in planner. evopi's own `@evopi/pi-ai`
does ship a keyless `faux` provider (`packages/ai/src/providers/faux.ts`,
`registerFauxProvider`), but the grounded planner resolves credentials through
`getApiKeyAndHeaders` for the *session's* model, so the in-product LLM path
stays unreachable unless the session itself runs on a faux model.

Per SPEC §7:78 the run is replaced by two faux-provider smokes that verify the
two halves which *can* be verified keyless: the completion primitive routes with
no key, and the evo-on D1 trigger/feedback logic is correct against product source.

## Smoke 1 — keyless `completeSimple` via pi-ai mock provider (eval side)

`eval/faux-provider-smoke.ts` — `registerMockApi()` + `createMockModel()` drive
`completeSimple` (`@oh-my-pi/pi-ai` `stream.ts:1716`, the exact primitive the
grounded planner uses) with a canned RefinementProposal, no HTTP, no key.

```
$ cd eval && bun faux-provider-smoke.ts
env keys present: (none)

calling completeSimple(mockModel, context) — no HTTP, no key:

=== assertions ===
  ok  no provider API key in environment (keyless)
  ok  provider is mock (got mock)
  ok  stopReason=stop (got stop)
  ok  zero cost (got 0)
  ok  mock recorded exactly one call (got 1)
  ok  canned proposal JSON round-trips (planner-parseable)
  ok  proposal has edits array

SMOKE: PASS — keyless completeSimple path works; evo-on planner can run against a faux provider.
```

Shows: the completion primitive resolves through the custom-API registry with a
faux provider (zero cost, one recorded call) and a canned proposal round-trips as
planner-parseable JSON. With a provider key wired, the same call reaches a real
model.

## Smoke 2 — keyless evo-on D1 trigger logic (product side)

`packages/coding-agent/step14-evoon-logic-smoke.ts` — calls the real exported
`grounded-refine.ts` functions directly (no key involved).

```
$ cd packages/coding-agent && ../../node_modules/.bin/tsx step14-evoon-logic-smoke.ts
  ok  unconfigured signal → undefined (quiet-stall guard, SPEC §4:49-51)
  ok  failure markers classified as failure
  ok  non-failure markers skip refinement
  ok  EVOPI_FEEDBACK_FILE JSON round-trips {task,status,detail}
  ok  signal missing required field → undefined (no interference)
  ok  Minimal block carries status + task
  ok  Minimal block omits diagnostic detail
  ok  Standard block includes diagnostic detail

SMOKE: PASS — evo-on D1 trigger + feedback-block logic verified keyless against product source.
```

Shows: the failure-only trigger, the quiet-stall guard (no signal / malformed
signal → no interference), and Minimal-vs-Standard feedback-block construction all
behave per SPEC §4 — the parts of the evo-on arm that don't require a model.

## Arm table

| arm            | agent under test              | EVOPI_EVO | grounded signal        | purpose                          |
|----------------|-------------------------------|-----------|------------------------|----------------------------------|
| `evopi-omp`    | published `@oh-my-pi/…` 18.1.2 | (unset)   | none                   | upstream omp baseline            |
| `evopi-prime`  | prime skeleton build          | (unset)   | none                   | prime skeleton baseline          |
| `evopi-evooff` | evopi local build             | `off`     | none                   | pure control (evo compiled out)  |
| `evopi-evoon`  | evopi local build             | `on`      | `EVOPI_FEEDBACK_FILE`  | evo treatment (D1+D4, SPEC §4:56) |

Seed is fixed by the benchmark task set (`typescript-edit-benchmark` fixtures,
deterministic). To run for real: set a provider key in the shell, apply the
`arms.md` per-arm commands, then ingest `runs/<arm>/result.json`.

## How to run the real A/B once an API key is available (B6/P4, 2026-09-03)

The four arms are fully wired (`arms.md`); only a provider key is missing.
Keys must be exported in the shell — never written to a file:

```bash
# 1. Export a provider key the arms' models can use, e.g.:
export ANTHROPIC_API_KEY=sk-ant-...        # or OPENAI_API_KEY / PRIME_API_KEY ...

# 2. From eval/ (bun workspace, isolated from the node product):
cd eval
bun metaharness/adapters/edit/cli.ts --check-fixtures   # sanity: "Fixtures OK"

# 3. Run each arm per arms.md (evopi-omp / evopi-prime / evopi-evooff / evopi-evoon).
#    The evo-on arm additionally requires the grounding signal file:
#      export EVOPI_EVO=on
#      export EVOPI_FEEDBACK_FILE=/tmp/evopi-feedback.json   # {task,status,detail?}
#    (SPEC §4:56: never run an evo-on arm without a wired grounding signal.)

# 4. Record pass-rates/cost per arm back into this file, replacing the SKIP above.
```

Optional rotation/dialect knobs now available to arms (B1/B2):
`EVOPI_API_KEY_POOL_<PROVIDER>` for multi-key rotation, `EVOPI_DIALECT` for
in-band tool calling on non-native-tool models.
