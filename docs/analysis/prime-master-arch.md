# prime-agent 마스터 아키텍처 (side-by-side 비교용 압축본)

대상: `/opt/workspace/local/sw4kim/my-agent/prime-agent` (READ-ONLY, HEAD `81ae3cb34 chore: prepare v0.9.1 release (#1961)`)
모든 경로는 prime-agent 레포 기준. 크기는 `wc -l`. **근거만 기록 — 이식/RECONFIRM 결론 없음.**
선행 조사 `docs/analysis/prime.md`(1087행)에 커널 상세·D3 근거가 있고 여기서는 재인용만 한다.

## 1. 제어 루프
- 저수준 루프는 `packages/agent` 에 격리: `src/agent-loop.ts`(963), `src/agent.ts`(556), `src/types.ts`(405).
- 엔트리 4종: `agent-loop.ts:181` `agentLoop`, `:215` `agentLoopContinue`, `:247` `runAgentLoop`, `:272` `runAgentLoopContinue`. 스트림은 `:297-302` `createAgentStream` (`agent_end` 에서 종료되는 EventStream).
- 턴 구조는 `:304-` `runLoop` 의 이중 while. 외곽 루프가 턴 경계마다 steering → follow-up → continuation 순으로 메시지를 흡수 (`types.ts:118-273` 의 `getSteeringMessages`/`getFollowUpMessages`/`getContinuationMessages`/`shouldStopBeforeTurn`/`shouldStopAfterTurn`). 모든 훅 계약에 "must not throw" 명시.
- 모델 호출: `:445-` `streamAssistantResponse` = `transformContext` → `convertToLlm` → `getApiKey` → `streamFunction(config.model, llmContext, {...config, apiKey, signal})`. 기본 `streamSimple`. abort 는 단일 `AbortSignal`.
- 툴 디스패치 `:585-599`: 배치 내 툴 하나라도 `executionMode === "sequential"` 이면 배치 전체 직렬. `:746-748` `shouldTerminateToolBatch` = 모든 결과가 `terminate === true`.
- 이벤트 11종 `types.ts:391-405`, 툴 정의 `:347-372`(`executionMode`), 커스텀 메시지 `:291-296` declaration merging.
- 고수준 오케스트레이터는 `packages/coding-agent/src/core/agent-session.ts` (**11948행 — 레포 최대**). 큐/프로바이더 호출/컴팩션/goal/자식 세션/전사 기록을 전부 소유 (`packages/coding-agent/docs/architecture.md:46`).
- **RLM 턴이 일반 툴콜 턴과 다른 점**: 모델 노출 툴이 기본 `ipython` 하나 (`core/system-prompt.ts:67` `const tools = selectedTools ?? ["ipython"]`). 즉 "툴 선택"이 아니라 "파이썬 코드 작성"이 모델의 행동이고, 나머지 능력은 커널 안 파이썬 심볼로 주입 (`core/tools/ipython.ts:24-143`). `ipython` 은 `:609-624` 에서 `executionMode: "sequential"` → 배치 항상 직렬.
- 확장 훅 설치: `agent-session.ts:1437-1485` `_installAgentToolHooks` 가 `agent.beforeToolCall`/`afterToolCall` 에 얹는다.

## 2. 툴 시스템과 실행 엔진
- 커널 디렉터리 `core/kernel/` 7파일: `bootstrap.ts`(916), `repl-manager.ts`(1502), `shared.ts`(330), `state-snapshot.ts`(47), `boot-gate.ts`(34), `bootstrap-cli.ts`(13).
- 커널 프로세스 스폰은 레포 전체에서 **단 한 곳** `kernel/repl-manager.ts:252-262` — `python -m rlm.repl`, JSON-lines stdio, PROTOCOL_VERSION 3, 이벤트 8종. spawn 옵션은 `cwd`/`env`/`stdio` 뿐 (→ 4장).
- `ReplKernelManager` 인스턴스화도 단 한 곳 `core/tools/ipython.ts:461`. 부팅 순서 `:487-514` — boot permit(`boot-gate.ts`)은 `start()` 에만 걸리고, 이어 `restoreState()` → `execute(bootstrapCode)`.
- 셀 입력 스키마는 문자열 하나 (`tools/ipython.ts:144-149` `code`). 사용자 셀에 **실행 타임아웃 없음**(선행 문서 확정).
- 스냅샷: `state-snapshot.ts`(47) + `dill` 변수 단위 직렬화 → `kernel-state.dill` + 매니페스트 `kernel-state.json`. 실패 변수는 스킵되고 매니페스트에 기록. 저장 위치가 session artifact dir 이므로 비영속 세션(`session-manager.ts:1349-1351` 이 `undefined`)에는 스냅샷도 없다.
- 파이썬 스킬 계약: `pyproject.toml` + `src/<pkg>/__init__.py`, uv editable 설치. 설치 순서는 `bootstrap.ts` 의 `normalizePythonSkills`/`sortPythonSkillsForInstall`(위상 정렬), 무효화는 `.bootstrap-version` + `src/rlm/**/*.py` sha256. 정본 예시 `packages/coding-agent/skills/refine/` (SKILL.md 42 / pyproject.toml 17 `dependencies = []` / `src/refine/__init__.py` 50).
- bash/edit/read 와 커널의 관계: 부트스트랩이 `rlm`,`bash`,`mcp` 심볼 주입 (`tools/ipython.ts:24-67`, `rlm` 부재 시 `_PrimeAgentMissingRlm` 폴백). `:70-143` `buildRlmBootstrapCode` 가 각 파이썬 스킬을 래핑해 `await <skill>(...)` 로 호출 가능하게 하고 미설치 스킬은 호출 시점 예외. 즉 편집·셸은 네이티브 툴이 아니라 파이썬 심볼 경로.
- 호스트 브리지: 파이썬 `rlm.host_request` → repl 프로토콜 → TS 핸들러. 등록 지점 `agent-session.ts:9209-9312` `_createKernelHostHandlers` (`rlm.run`/`find_models`/`list_subagents`/`delete_subagent`/`model.info` 상시; `goal.*`/`compact.*`/`refine.*`/`rlm_heartbeat.*`/`agent_message.*`/`agent_observe.*`/MCP 조건부). MCP 핸들러는 `core/mcp/mcp-manager.ts:179-` `hostHandlers()` (`mcp.refresh`,`mcp.config`).
- 파이썬 런타임 본체는 별도 워크스페이스 `prime-agent-runtime/src/rlm/`: `__init__.py`(299) 가 모델 대면 표면. `host_request` 는 payload 를 먼저 펼쳐 `"type"` 덮어쓰기를 막고, 모듈 자체를 `sys.modules[__name__].__class__ = _CallableModule` 로 awaitable 화. `_HarnessProxy` 는 접근 시점 해석·절대 raise 하지 않고 in-memory 로 degrade.

## 3. 컨텍스트 관리
- `core/system-prompt.ts:41-180` `buildSystemPrompt`. 기본 분기 조립 순서: `buildRlmPrompt`(:123-131) → `buildSubagentGuidance`(:136-145) → `formatHarnessStateForPrompt`(:147-149) → generic-MCP(:151-153) → `# Additional Guidance`(:155-158) → `# Project Context`(:160-167) → skills(:169-173) → `appendSystemPrompt`(:175-177). 주석 `:133-135` 가 순서 이유 명시("학습된 prefix 뒤, harness 메뉴 앞").
- harness 주입 `core/refinement/refinement.ts:429-521` `formatHarnessStateForPrompt`: kind 별 6개, refinement 5개, content 180자 절단, 그리고 "When to call `await refine.run()`" 트리거 목록을 프롬프트에 직접 심는다.
- 세션 저장 `core/session-manager.ts:281-283` `<sessionDir>/<uuidv7>.jsonl`, `:296-302` artifacts 루트 = `join(dirname(sessionDir), "session-artifacts")`. 포맷 `packages/coding-agent/docs/session-format.md:5-27`.
- 컴팩션 임계/전략은 `packages/coding-agent/docs/compaction.md:29-70`. 턴 종료 시 refine 체크포인트가 **임계 컴팩션보다 먼저** 직렬 실행돼야 한다는 제약이 코드에 박혀 있다 (`agent-session.ts:2212-2244` `_shouldStopAfterTurn`).

## 4. 권한 / 안전
- 문서가 성격을 못 박음 — `packages/coding-agent/docs/architecture.md:49`: "Workers and kernels are separate processes for lifecycle and failure containment, **not security sandboxes**. They normally run with the same operating-system permissions as the client."
- 커널 스폰(`kernel/repl-manager.ts:252-262`) 옵션은 `cwd`/`env`/`stdio` 뿐. 선행 조사에서 `prime-agent-runtime/src/` + `packages/coding-agent/src/` 전체를 `setrlimit|RLIMIT|seccomp|cgroup|unshare|setuid|setgid|chroot|nice(` 로 grep → **유효 히트 0**. 커널은 호스트 uid/gid·FS·네트워크를 그대로 쓰고 `process.env` 를 상속.
- 게이트류는 코어가 아니라 **예제 확장** (`packages/coding-agent/examples/extensions/`, 총 74개 항목):
  - `permission-gate.ts`(34): 정규식 `[/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i]`, `pi.on("tool_call")`, `if (event.toolName !== "bash") return undefined;`. UI 없으면 `{block:true, reason:"Dangerous command blocked (no UI for confirmation)"}`.
  - `protected-paths.ts`: `[".env",".git/","node_modules/"]` 부분문자열 매칭, `if (event.toolName !== "edit") return undefined;`.
  - `confirm-destructive.ts`(59): **셸 명령과 무관**. `pi.on("session_before_switch")`(:11) / `pi.on("session_before_fork")`(:46) 로 세션 clear/switch/branch 확인만. `if (!ctx.hasUI) return;` — UI 없으면 통과.
  - `sandbox/index.ts`(321): `:1-42` 헤더가 `@anthropic-ai/sandbox-runtime`(Linux=bubblewrap, macOS=sandbox-exec) 기반 OS 레벨 샌드박스이며 "intentionally overrides the built-in `bash` tool" 임을 명시. `:54-76` DEFAULT_CONFIG (denyRead `~/.ssh`,`~/.aws`,`~/.gnupg`; allowWrite `.`,`/tmp`; denyWrite `.env`,`*.pem`,`*.key`). `:132-196` `createSandboxedBashOps` = `SandboxManager.wrapWithSandbox(command)` 후 `spawn("bash",["-c",wrapped])`. `:198-` 대체 `bash` 툴 + `user_bash` 훅 등록. **`ipython`/커널은 건드리지 않는다.**
- 확장 API 가로채기 지점 `core/extensions/types.ts:760-790` `ToolCallEvent`: 입력 mutable, 주석에 "No re-validation is performed after mutation." 판정·집행 모두 TS 애플리케이션 레이어이며 **툴 이름 스코프**.
- 무인 실행용 자동 승인: 예제 게이트가 `ctx.hasUI` 로 분기하며 `permission-gate.ts` 는 UI 없을 때 **차단**, `confirm-destructive.ts` 는 **통과** 쪽으로 갈린다. `install.sh:1528-1590` 은 프롬프트 status 2(TTY 없음)일 때 확인 없이 진행하고 파이썬 런타임 준비를 기본값으로 택한다.

## 5. 확장성
- `core/extensions/`: `loader.ts`(593), `runner.ts`(1074), `types.ts`(1434), `index.ts`(148), `wrapper.ts`(38), `bundled-modules.ts`(39) = 3326행. 로딩은 jiti. 디스패치 지점 `runner.ts:136,154,681`.
- 훅 이벤트 **31종** (`types.ts` 의 `type:` 리터럴, `resources_discover :478` … `tool_result :801`). 자기개선 관련: `session_before_refine :539` (결과 타입 `:544-549` `{skip?, proposal?}`, 준비 페이로드 `:520-534`), `refine_complete :652`, `tool_call :768`.
- builtin 확장은 단 하나: `core/extensions/builtin/herdr-agent-state.ts`(461).
- 스킬 로더 `core/skills.ts`(`formatSkillsForPrompt`,`getPythonSkillRuntimeInfo`), 문서 `packages/coding-agent/docs/skills.md`. 파이썬 스킬은 커널 venv 에 editable 설치.
- MCP: `core/mcp/` = `mcp-manager.ts`(245), `mcp-command.ts`(235), `acp-mcp-types.ts`(15). 커널에서는 pre-import 된 `mcp` 객체 (`system-prompt.ts:189-194` 가 `await mcp.list_tools(...)`/`await mcp.call_tool(...)` 안내).
- 서브에이전트: 호스트 핸들러 `rlm.run`/`list_subagents`/`delete_subagent` (`agent-session.ts:9209-9312`), 모델 대면은 `await rlm("sub-task")` (`refinement.ts:123-` 의 subagent 스펙 규약). 자식 런타임은 별도 세션(+옵션 커널).
- 실행 모드: `packages/coding-agent/src/modes/` (interactive TUI / print / JSON / RPC / ACP) + 데몬 supervisor·session worker·`AgentConnection` 3단 (`docs/architecture.md:7-49`, `docs/daemon.md`, `docs/agent-connection.md`).
- 프로바이더도 확장으로 추가 가능: `examples/extensions/custom-provider-anthropic/`(index.ts 604 + package.json + lock), `custom-provider-gitlab-duo/`(index.ts 349 + test.ts 82 + package.json).

## 6. 자기개선 레이어 (핵심)
- 코어 `core/refinement/refinement.ts`(1031).
- 데이터 모델 `:34-63`: `HarnessEntry`(kind = prompt|memory|skill|subagent, id/title/content/version/source/…), `HarnessRefinementEvent`, `HarnessState`.
- 저장 경로 `:269-279`: 글로벌 `getGlobalHarnessStateDir()` = `join(agentDir, HARNESS_STATE_DIR_NAME)` → `~/.prime/agent/harness`; 로컬 `getLocalHarnessStateDir(sessionArtifactDir)` → 세션 artifact 하위(artifact 없으면 `undefined`); 파일명 `harness_state.json`. 원장은 별도 `refinements.jsonl`.
- 병합/저장: `:326-343` `mergeHarnessStates` (id 충돌은 `${scope}:${id}` 키로 구분), `:345-359` `saveHarnessState` (temp + `renameSync`, mode 보존 또는 `0o600`).
- 프롬프트 `:123-` `REFINEMENT_SYSTEM_PROMPT`: base system prompt 불변, skill 편집은 `reference.type==="python"` + import + callable/call_pattern + `arguments` 요구, subagent 스펙은 `await rlm("sub-task")`. 출력 상한 `:199-200` 32k/4096.
- 계획 `:880-947` `planRefinement`: 대화를 `.slice(-80_000)` 해 LLM 에 넘기고 `void thinkingLevel` 로 non-reasoning JSON 출력 강제.
- 정규화/검증/적용/롤백: `:632-666` `normalizeRefinementProposal`(잘못된 필드도 보존해 apply 시점 검증으로 넘김) / `:676-712` `validateEdit`(`"base system prompt is not editable"`) / `:714-802` `applyRefinementProposal`(baseline 충돌 시 `"entry changed during refinement planning"`, `version = before ? before.version + 1 : 1`, `source: "refine"`) / `:804-836` `rollbackProposal`(`appliedEdits` 역순 순회로 `before` 복원 또는 삭제 — 롤백 스냅샷은 제안 단위 before/after 쌍).
- 자동 트리거 (`agent-session.ts`): `:3632` `this._assistantTurnsSinceAutoRefine++` (에러/중단 아닌 assistant 메시지에서만 증가) → `:7585-7587` 게이트 `return this._rlmDepth === 0 && this._localHarnessStateDir() !== undefined;` (루트 세션 + 영속 로컬 harness 필수) → `:7866-7960` `_maybeAutoRefine` (turnInterval/cooldown 검사 후 LLM 리뷰 게이트 `refinement.ts:963-1011` `reviewAutoRefine`, 대화 `.slice(-40_000)`; 거부 시 중단, 실패 시 cooldown 스탬프).
- 설정 `core/settings-manager.ts:23-28` `AutoRefineSettings` (`enabled` 기본 true, `turnInterval` 기본 25, `compact` 기본 true, `cooldownMs` 기본 20분), `:905-920` `getAutoRefineSettings` 가 clamp. → **opt-out 은 `autoRefine.enabled: false`.**
- 수동 `/refine` 경로 (3언어 3레이어): `skills/refine/src/refine/__init__.py` (`run(instructions=None, global_=False)` → `host_request("refine.run", payload)`) → `rlm.host_request` → `kernel/repl-manager.ts` `handleHostRequest` → `agent-session.ts:3030-3060` (`refine.status`/`refine.run`; 턴 없으면 `{scheduled:false, reason:"no active turn; refine can only be requested while a turn is running"}`) → 턴 경계에서 `_shouldStopAfterTurn`/`_maybeAutoRefine` 소비 → `:8054-8159` public `refine()` (직렬화 루프 + `waitForIdle` + 이벤트 큐 드레인) → `:8184-8268` `_planRefine` (글로벌+로컬 로드·머지, `session_before_refine` 발행) → `:8294-8400` `_applyRefine` (agent 분리, 커널의 `rlm.harness` 쓰기를 덮지 않도록 상태 재읽기, 적용·저장, 글로벌 원장 append, 시스템 프롬프트 재구성, `refine_complete` 발행).
- 커널 측 CRUD `prime-agent-runtime/src/rlm/harness.py`(820): `:78-91` `_state_file` (env `RLM_HARNESS_STATE_DIR`/`RLM_GLOBAL_HARNESS_STATE_DIR`/`RLM_SESSION_DIR`+harness; 로컬 미설정이면 raise), `:94-111` HarnessEntry dataclass(TS 형태 미러), `:187-197` `_sync_from_disk` (mtime 가드로 호스트 `/refine` 쓰기 감지), `:285-301` `save()` 는 `{"schema":1,"entries":…,"refinements":…}` 를 **평범한 `json.dump`** 로 기록(TS 의 temp+rename 과 다름), `:677` `record_refinement`, `:705` `plan_refinement`(정적 텍스트, LLM 없음), `:722` `overview`, `:771` `snapshot`, `:786-810` `get_harness_state` 캐시 키 `(file_path, scope)`. CRUD 메서드 13개.
- 트리거를 뒷받침하는 신호: 프롬프트에 심긴 트리거 목록(모델 자율 호출), 턴 카운터 + cooldown(횟수/시간), LLM 리뷰 게이트(대화 텍스트 판정). 테스트 통과·리워드 등 실행 신호를 읽는 코드는 refinement 경로에서 미발견.
- 확장 우회로 `examples/extensions/custom-refinement.ts`(109): `pi.on("session_before_refine")`(:21) 에서 `{skip:true}` 로 라운드 전체 억제 또는 자체 프롬프트로 `{proposal}` 반환(:100). 헤더 `:7-8` "Returned edits are still validated by the core apply path".

## 7. 모델 연결성
- `packages/ai/src/providers/register-builtins.ts`(403): `:343-395` 에 `registerApiProvider` 9개 — anthropic-messages, openai-completions, mistral-conversations, openai-responses, azure-openai-responses, openai-codex-responses, google-generative-ai, google-vertex, bedrock-converse-stream.
- 카탈로그 `packages/ai/src/models.generated.ts`(22086, `:1-2` 자동생성 표기), **프로바이더 키 32개** (amazon-bedrock … zai; prime-inference, openai-codex, github-copilot, opencode, vercel-ai-gateway, xiaomi 4변종 포함).
- 인증 `core/auth-storage.ts`(1154): `:54` `export type AuthStorageData = Record<string, AuthCredential>` → **프로바이더 id 당 크리덴셜 1개**. `:109` 기본 경로 `join(getAgentDir(), "auth.json")`. `:358-364` `!` 접두 api_key 는 셸 명령으로 해석.
- 벤더 특수 처리: `packages/ai/src/{oauth,bedrock-provider,openrouter-reasoning,env-api-keys,mcp,cache-pricing}.ts` 얇은 shim, Prime 자체 추론은 `core/prime-inference-auth.ts`.

## 8. 런타임 / 툴체인 / 배포
- Node 기반: `prime-agent.sh`(81) 기본 경로가 `tsx packages/coding-agent/src/cli.ts`. `--no-env` 는 API 키 약 40개 unset, `--dist` 는 번들 실행, `PRIME_AGENT_LAUNCHER_PATH`/`PRIME_AGENT_BUILD_ID` export.
- `pi-natives` 참조: `packages/` 전체에서 **0건**.
- `install.sh`(1620): `:61-143` 메인 흐름 = preflight → 채널 파일에서 버전 해석 → 확인 → 커널 런타임 확인 → 다운로드 → SHA256 검증 → `npm install -g`. `:1592-1618` 최종 명령 `env PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL=1 PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL=1 PRIME_AGENT_INSTALL_UV=1 npm install -g … "$tarball_path"`. `:1528-1590` TTY 없으면 무확인 진행. `prime_agent_*` 접두 함수 약 70개, 대부분 터미널/로고/애니메이션 렌더링.
- 설정 경로 단일 seam `packages/coding-agent/src/config.ts:487-504`: `package.json` 에서 `APP_NAME`, `CONFIG_DIR_NAME = ".prime/agent"`, `ENV_AGENT_DIR = ${envPrefix}_CODING_AGENT_DIR` 유도, `:525-531` `getAgentDir()`. themes/logs/auth.json/bin/sessions/cron/models.json/keybindings/daemon-workers/harness 가 모두 여기서 파생. **예외 2곳**: `core/kernel/bootstrap.ts:337-348`, `prime-agent-runtime/src/rlm/harness.py:38-44` 가 `.prime` 하드코딩.

## 9. 평가 / 텔레메트리
- `packages/coding-agent/test/` 268항목, `test/suite/` 26항목. SWE-bench / terminal-bench / eval harness 류 **미발견**. 성능 마이크로벤치만 (`*-bench.ts`, `scripts/bench-*.mjs`, `profile-coding-agent-node.mjs`).
- `test.sh` 는 `~/.prime/agent/auth.json` 을 trap 으로 치웠다 되돌리고 `PI_NO_LOCAL_LLM=1` 및 API 키 unset.
- 트레이스는 외부 업로드: `core/agent-traces.ts`(988) — `:17-35` 상한/레이트(20 MiB, 1s 디바운스, 60s 최소 간격, 60초당 5요청, 재시도 3), `AgentTraceCredentialSource = "environment"|"stored"|"prime-inference"|"prime-cli"`, `resolvePrimeAgentTracesBaseUrl` 로 Prime 서비스 전송. 로컬은 `core/telemetry.ts`.

## (a) 가장 특징적인 설계 선택 5가지
1. **네이티브 툴 1개(`ipython`) + 파이썬 심볼 주입** — 툴 선택 대신 코드 작성이 모델의 행동. `system-prompt.ts:67`, `tools/ipython.ts:24-143`, `tools/ipython.ts:461`(커널 1인스턴스).
2. **타입드 host_request 브리지로 권위 있는 연산을 TS 로 회수** — 파이썬은 제어 환경, 실제 조작은 호스트 (`docs/architecture.md:47`, `agent-session.ts:9209-9312`, `rlm/__init__.py`).
3. **continual harness 를 시스템 프롬프트에 상주시키고 LLM 이 스스로 편집** — 4종 엔트리, local/global 2스코프, 버전·원장·before/after 롤백 (`refinement.ts:34-63, 269-279, 714-836`).
4. **autoRefine 을 턴 카운터 + cooldown + LLM 리뷰 게이트로 삼중 방어** — 실행/테스트 신호가 아니라 대화 텍스트 판정이 근거 (`agent-session.ts:3632, 7585-7587, 7866-7960`, `settings-manager.ts:23-28`).
5. **격리는 프로세스 분리뿐이라고 문서가 선언** — 게이트/샌드박스는 예제 확장이며 샌드박스는 `bash` 툴만 대체, 커널 스폰에 OS 제한 없음 (`docs/architecture.md:49`, `examples/extensions/sandbox/index.ts:1-42, 132-196`, `kernel/repl-manager.ts:252-262`).

## (b) 컴포넌트 다이어그램 (텍스트)
박스:
```
[TUI / print / JSON / RPC / ACP]         packages/coding-agent/src/modes/
[AgentConnection]                        docs/agent-connection.md
[Daemon supervisor]                      docs/daemon.md
[Session worker -> AgentSessionRuntime]  docs/architecture.md:15-27
[AgentSession 11948]                     core/agent-session.ts
[agentLoop 963]                          packages/agent/src/agent-loop.ts
[Extension runner 1074 / 31 hooks]       core/extensions/{runner,types}.ts
[Provider registry 9 kinds / 32 catalog] packages/ai/src/providers/register-builtins.ts:343-395
[ReplKernelManager 1502]                 core/kernel/repl-manager.ts
[Python kernel: rlm.repl]                prime-agent-runtime/src/rlm/
[rlm.harness (py) 820]                   prime-agent-runtime/src/rlm/harness.py
[refinement core 1031]                   core/refinement/refinement.ts
[harness_state.json + refinements.jsonl] ~/.prime/agent/harness | session-artifacts
[sessions/*.jsonl + session-artifacts]   core/session-manager.ts:281-302
[kernel-state.dill + .json]              core/kernel/state-snapshot.ts
[MCP manager 245]                        core/mcp/mcp-manager.ts
```
화살표:
```
TUI/headless --> AgentConnection --(local daemon protocol)--> Daemon supervisor
Daemon supervisor --> Session worker --> AgentSession
AgentSession --> agentLoop --(streamFunction)--> Provider registry --> 모델 API
agentLoop --(beforeToolCall/afterToolCall)--> Extension runner    agent-session.ts:1437-1485
agentLoop --(executeToolCalls, sequential)--> ipython tool        tools/ipython.ts:609-624
ipython tool --> ReplKernelManager --(spawn python -m rlm.repl)--> Python kernel
                                                                 repl-manager.ts:252-262
Python kernel --(host_request)--> ReplKernelManager --> AgentSession host handlers
                                                                 agent-session.ts:9209-9312
Python kernel --> rlm.harness (py) --> harness_state.json
AgentSession --(restore/save)--> kernel-state.dill/.json
AgentSession --> refinement core --> harness_state.json + refinements.jsonl
refinement core --(formatHarnessStateForPrompt)--> buildSystemPrompt --> agentLoop 컨텍스트
                                                                 system-prompt.ts:147-149
AgentSession --> MCP manager --(hostHandlers)--> Python kernel 의 `mcp` 심볼
AgentSession --(append)--> sessions/*.jsonl, session-artifacts
AgentSession --> agent-traces (외부 업로드)                       core/agent-traces.ts:17-35
[예제 확장만] sandbox ext --(replace tool)--> bash tool
             ※ ipython/커널 경로에는 연결 없음   examples/extensions/sandbox/index.ts:198-
```

미확인: `extensions/runner.ts` 내부 디스패치 세부 의미론(grep 수준만 확인), `compaction/compaction.ts` 내부 구현(문서 기준으로만 기술), `docs/rlm.md`/`docs/rlm-runtime.md` 원문 재확인(선행 문서 인용에 의존).
