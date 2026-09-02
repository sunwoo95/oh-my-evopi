# evopi eval harness (M12)

Isolated **bun** copy of omp `metaharness` + `typescript-edit-benchmark`. This
tree runs under bun only; the node product graph (`packages/`) is completely
separate (R7: product = node-only, metaharness = bun-isolated). Nothing here is
imported by the product.

## Layout

```
eval/
  package.json          # bun workspace root: catalog pins @oh-my-pi/* = 18.1.2 (npm), members below
  bunfig.toml           # minimumReleaseAge=0 (sandbox), hoisted linker
  metaharness/          # copy of omp packages/metaharness (unmodified)
  typescript-edit-benchmark/   # copy of omp packages/typescript-edit-benchmark (npm-unpublished → local member)
```

The `@oh-my-pi/*` library deps resolve from the **published npm** packages
(`18.1.2`); `@oh-my-pi/typescript-edit-benchmark` is npm-unpublished so it is a
local workspace member.

## Install & boot (verified M12)

```sh
export PATH="$HOME/.bun/bin:$PATH"
cd eval && bun install                              # → 189 packages, exit 0
cd metaharness
bun adapters/edit/cli.ts --help                     # edit runner boots, exit 0
bun adapters/edit/cli.ts --check-fixtures           # → "Fixtures OK"
bun adapters/edit/cli.ts --list                     # task ids as JSON
```

## Pointing the edit benchmark at evopi (Q2)

The coding track reuses metaharness `kind:"edit"`. The peer agent under test is
resolved from the `@oh-my-pi/pi-coding-agent` package, in one of two modes
(`adapters/edit/runner.ts`):

- **In-process (default, `inProcess: true` — cli.ts:259)**: `InProcessClient`
  from `@oh-my-pi/typescript-edit-benchmark/in-process-client` imports
  `@oh-my-pi/pi-coding-agent` directly and drives agent sessions in-process.
- **Subprocess (`--no-in-process`)**: `RpcClient` spawns the CLI at
  `CLI_PATH = import.meta.resolve("@oh-my-pi/pi-coding-agent/cli")`
  (runner.ts:39 → resolves to `node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts`,
  confirmed M12).

Both hinge on the `@oh-my-pi/pi-coding-agent` resolution. To evaluate **evopi**
instead of the published omp agent, repoint that dependency at evopi's local
build. In `eval/package.json` add a bun override:

```jsonc
{
  "overrides": {
    "@oh-my-pi/pi-coding-agent": "file:../packages/coding-agent"
  }
}
```

(evopi's package is `@evopi/pi-coding-agent`; installed under the `@oh-my-pi`
key it presents the same prime/omp-derived export surface the edit client uses.)
Run `npm run build` in `packages/coding-agent` first so `dist/` and the `cli`
export exist.

The A/B arms — `evopi-omp` / `evopi-prime` / `evopi-evooff` / `evopi-evoon`
(SPEC §7) — are configured at eval time by selecting this override (evopi vs
published omp) and the `EVOPI_EVO` / `autoRefine` settings per arm. The evo-on
arm **must** have a grounded signal wired (`EVOPI_FEEDBACK_FILE`) — SPEC §4:56.
Wiring the arms and the actual run (or key-less faux smoke) is **STEP 14**.
