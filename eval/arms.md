# A/B arm wiring — coding track (STEP 14, SPEC §7)

Four arms (SPEC §7:75). Each arm is launched as a metaharness job whose name
encodes the arm: `experimentOf(jobName)` = first `-` token, `armOf` = the rest
(`metaharness/src/experiments.ts:59-68`); the manager builds the edit adapter
argv `bun adapters/edit/cli.ts --model <m> --output <jobDir>/result.json`
(`server.ts:400-406`) and spawns it with `env = {...process.env}`
(`server.ts:490`).

**There is no per-arm `env` field** in `AddArmRequest` (`server.ts:53-64`). An arm
is therefore expressed by two levers set *before/around the job process*:

1. **Which agent is under test** — a bun `overrides` switch on
   `@oh-my-pi/pi-coding-agent` (published omp vs evopi local build). See
   `README.evopi.md` §"Pointing the edit benchmark at evopi".
2. **Process env** on the adapter process (`EVOPI_EVO`, `EVOPI_FEEDBACK_FILE`,
   `EVOPI_FEEDBACK_DETAIL`). Per-arm env is safe: one env per adapter process.
   Per-*task* env is not (32-way concurrency) and is never used.

`<MODEL>` below is a real provider model id; a run needs a provider API key in
the shell env (never a file, never committed). Absent a key, see `RESULTS.md`
(run SKIPPED per SPEC §7:78, replaced by keyless faux-provider smokes).

## arm: `evopi-omp` — published omp control (upstream baseline)

```sh
# eval/package.json: NO override (default resolution → published @oh-my-pi/pi-coding-agent 18.1.2)
cd eval && bun install
cd metaharness
env -u EVOPI_EVO -u EVOPI_FEEDBACK_FILE \
  bun adapters/edit/cli.ts --model "<MODEL>" --output runs/omp/result.json
```

## arm: `evopi-prime` — prime skeleton control

Same as `evopi-omp` but the override points at the prime-derived agent build
(the unmodified prime skeleton export surface). evo layer absent by construction.

```sh
# eval/package.json overrides: "@oh-my-pi/pi-coding-agent": "file:../packages/coding-agent"
# with the evopi build produced from the prime skeleton, evo NOT compiled in
cd metaharness
env -u EVOPI_EVO -u EVOPI_FEEDBACK_FILE \
  bun adapters/edit/cli.ts --model "<MODEL>" --output runs/prime/result.json
```

## arm: `evopi-evooff` — evopi build, evo OFF (pure control arm)

```sh
# eval/package.json overrides: "@oh-my-pi/pi-coding-agent": "file:../packages/coding-agent"
# (run `npm run build` in packages/coding-agent first)
cd metaharness
EVOPI_EVO=off \
  bun adapters/edit/cli.ts --model "<MODEL>" --output runs/evooff/result.json
```

`EVOPI_EVO=off` → the grounded-refine extension is never registered
(`agent-session-services.ts`), `autoRefine.enabled → false`; prime's stock
turn_interval refinement is unchanged. This is the control arm the evo delta is
measured against.

## arm: `evopi-evoon` — evopi build, evo ON + grounded signal (REQUIRED)

SPEC §4:56 / DECISIONS R4: an evo-on arm **must** have a grounded signal wired.
`EVOPI_FEEDBACK_FILE` points at a JSON `{task, status, detail?}`
(`grounded-refine.ts:39-47`). On a failure `status` (`fail`/`failed`/`failure`/
`error`/`errored`, `isFailureStatus` :60-65) the refinement planner is replaced
with one that injects an `<external_feedback>` block (`buildFeedbackBlock` :101);
on anything else the round is skipped (D1 failure-only trigger); with no readable
signal the extension is a no-op (quiet-stall guard :74-77).

```sh
# eval/package.json overrides: "@oh-my-pi/pi-coding-agent": "file:../packages/coding-agent"
cd metaharness
export EVOPI_EVO=on
export EVOPI_FEEDBACK_FILE="$PWD/runs/evoon/feedback.json"   # produced from prior-attempt verification
export EVOPI_FEEDBACK_DETAIL=standard                        # optional: inject diagnostic text
bun adapters/edit/cli.ts --model "<MODEL>" --output runs/evoon/result.json
```

The signal is produced from the runner's terminal result event
`{type:"result", success, ...}` (`runner.ts:1439-1448`): `success:false` →
`{task:<id>, status:"fail", detail:<verify message>}`. Because the edit
benchmark verifies once per attempt, a live grounded loop requires multi-attempt
mode so a prior attempt's failure becomes the next round's signal; single-attempt
runs leave the signal absent (extension no-op, matching `evopi-evooff`).

## Comparisons

- `evopi-evoon` vs `evopi-evooff`: isolates the evo delta (identical build; only
  `EVOPI_EVO` + signal differ) — the paper's control-vs-treatment contrast.
- `evopi-evooff` vs `evopi-omp`/`evopi-prime`: confirms the port is behavior-
  neutral with evo off (F: "evo off = 전 기능 동작").

Ingestion: the edit adapter writes `<jobsDir>/<jobName>/result.json`
(`server.ts:402`); `readEditSnapshot` maps `success → pass`, reward 1, metrics
`task_success_rate`/`edit_success_rate` (`benchmarks.ts:144-187`).
