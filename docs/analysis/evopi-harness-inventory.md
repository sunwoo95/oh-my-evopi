# evopi 하네스 현행 구현 인벤토리 (2026-09-03)

읽기 전용 감사. 모든 주장은 `파일:라인` 인용, 확인 못한 것은 "미확인".
범위: packages/agent, packages/coding-agent/src, packages/ai, packages/mnemopi,
packages/natives-loader, packages/hashline, evopi-runtime, 빌트인 익스텐션. `node_modules`,
`dist`, `release/`, `packages/coding-agent/core`(코어덤프) 제외.

## 0. 게이트 실행 결과 (실측)

| 항목 | 명령 | 결과 |
|---|---|---|
| 타입체크 | `npx tsgo -p packages/coding-agent/tsconfig.build.json --noEmit` | **exit=0**, 출력 없음 (2.5s) |
| 테스트 파일 수 | `ls packages/coding-agent/test \| wc -l` | 276 엔트리, 그중 `*.test.ts` 265 |
| 타 패키지 테스트 | `ls packages/<p>/test \| grep -c .test.ts` | agent 3 / ai 75 / mnemopi 2 / hashline 12 / natives-loader 1 / tui 29 |
| Python 테스트 | `evopi-runtime/test/*.py` | 8 파일, 6025 라인 (wc) |
| eval 테스트 | `find eval -name '*.test.ts' -not -path '*/node_modules/*'` | 10 |
| Bun 게이트 | `rg -n 'Bun\.\|bun:\|import\.meta\.dir' packages/*/src` | 8 hit, **전부 주석**(아래 §8) |
| .omp/.prime 게이트 | `rg -n '\.omp\|\.prime' packages/*/src` | 16 hit — `.omp` 0, `.prime` 경로 리터럴 **2건 실코드**(§8) |
| 루트 `extensions/builtin` | `ls extensions` | 디렉터리 없음. 빌트인은 `packages/coding-agent/src/core/extensions/builtin/` |

## 1. 제어 루프 (agent loop / turn / streaming)

| 파일 | 라인수 | 역할 |
|---|---|---|
| packages/agent/src/agent-loop.ts | 963 | 순수 루프: `agentLoop`(:181) `agentLoopContinue`(:215) `runAgentLoop`(:247) `runAgentLoopContinue`(:272) → 내부 `runLoop`(:304) |
| packages/agent/src/agent.ts | 604 | `Agent` 클래스(:189). `streamFn` 필드(:197, 기본 `streamSimple` :226), `prompt`(:344) `continue`(:355) `steer`(:285) `followUp`(:290) `abort`(:319) |
| packages/agent/src/types.ts | 405 | `StreamFn`(:25) `AgentLoopConfig`(:118) `transformContext`(:169) `getSteeringMessages`(:216) `getFollowUpMessages`(:229) |
| packages/coding-agent/src/core/agent-session.ts | **11962** | 세션 오케스트레이터. `prompt`(:4534) `compact`(:7399) `refine`(:8068) |
| packages/coding-agent/src/core/sdk.ts | 428 | `createAgentSession`(:147); `Agent` 생성 시 `streamFn` 클로저(:288-345) |

턴 구조 (`runLoop` agent-loop.ts:304-345): `agent_start`→`turn_start`→ steering 메시지 주입 → `streamAssistantResponse`(:451) → 툴콜 있으면 `executeToolCalls`(:585; sequential :607 / parallel :667) → `turn_end` → 반복. 툴 이벤트 `tool_execution_start/update/end`(:624,:845,:940). 에러/abort 시 `agent_end`(:344).

배선: `AgentSession` 생성자가 `this.agent.subscribe(this._handleAgentEvent)`(agent-session.ts:1306, 재구독 :3869; 핸들러 :3440) → `Agent.prompt` → `runPromptMessages`(agent.ts:426)가 `runAgentLoop(..., this.streamFn)`(:431-437) 호출. `sdk.ts:288` streamFn은 ① `modelRegistry.getApiKeyAndHeaders`(:289) ② `resolveOwnedDialect`(:297, EVOPI_DIALECT) ③ `getEnvCredentialPool`이 있으면 `withAuthStream(createPoolResolver(...), streamSimple)`(:324-336) 아니면 `streamSimple`(:337) ④ dialect on이면 `wrapOwnedDialectStream`(:339). `onPayload`는 `before_provider_request` 훅으로 위임(:343-346). 서브에이전트도 동일 `new Agent({...})`(agent-session.ts:9522).

## 2. 툴 시스템 & 실행 엔진 (IPython 커널)

| 파일 | 라인 | 핵심 |
|---|---|---|
| core/tools/index.ts | 70 | `createAllToolDefinitions`(:61): 등록 툴은 `ipython`, `hashline_edit` 둘뿐(:59 `ToolName`). 기본 활성 `["ipython"]`(agent-session.ts:9171) |
| core/tools/ipython.ts | 700 | `createIpythonToolDefinition`(:608, `executionMode:"sequential"` :620), `IpythonKernelProvisioner`(:307), `buildRlmBootstrapCode`(:70) |
| core/tools/hashline-edit.ts | 178 | `createHashlineEditToolDefinition`(:123) — `--tools` 게이트 구조 편집기(index.ts:55-58 주석) |
| core/tools/bash.ts | 452 | `createBashToolDefinition`(:273) 존재하지만 **툴 레지스트리 미등록**; 사용처는 TUI 렌더 폴백만(modes/interactive/components/tool-execution.ts:57). 셸은 커널 내 `bash()` 경유(ipython.ts:617 설명문) |
| core/tools/edit.ts | 533 | `createEditToolDefinition`(:342) — 레지스트리 미등록(index.ts 재export만). 실제 edit는 Python 스킬(§아래) |
| core/bash-executor.ts | 137 | `executeBashWithOperations`(:40) |
| core/kernel/repl-manager.ts | 1502 | `ReplKernelManager`(:136): `start`(:207) → `spawn(python, ["-m","rlm.repl"])`(:252), `execute`(:719) `shutdown`(:1205) `restart`(:1296) `snapshotState`(:1332) `restoreState`(:1385) |
| core/kernel/bootstrap.ts | 915 | `ensureKernelPython`(:905): uv 탐색(:509-533) → venv `~/.evopi/agent/kernel-venv`(:337-341, `EVOPI_KERNEL_VENV` 오버라이드) ; 기본 추가 패키지 12개(:20-33: requests/httpx/pyyaml/tomli/dotenv/pandas/numpy/scipy/bs4/lxml/pydantic/tyro) + dill(:19) |
| core/kernel/bootstrap-cli.ts | 13 | `test:ci`의 사전 부트스트랩 엔트리 |
| core/kernel/boot-gate.ts | 34 | `withKernelBootPermit`(:28) 세마포어; `EVOPI_MAX_CONCURRENT_KERNEL_BOOTS`(:10), 기본 min(16,max(4,cpus*2)) (:6) |
| core/kernel/state-snapshot.ts | 47 | dill 스냅샷 경로 `kernel-state.dill/.json`(:41-47), 256MB/16MB 상한(:12-14) |
| core/kernel/shared.ts | 330 | 타임아웃 상수(:5-13), 커스텀 MIME(diff/attachment/agent-message :80-86), `HostRequestHandlers`(:31) |
| evopi-runtime/src/rlm/repl.py | 1166 | 커널 측 서버: stdin 요청/stdout 이벤트 펌프(`_Pump` :139), `_handle_execute`(:535), `_snapshot_state`(:607) `_restore_state`(:782), `host_request`(:101) |
| evopi-runtime/src/rlm/bash.py | 890 | `bash()`(:652) → `BashHandle`(:108) — 커널 내부 셸 실행 |

**호스트 요청 채널**: `_createKernelHostHandlers`(agent-session.ts:9223)가 `rlm.run / rlm.find_models / rlm.list_subagents / rlm.delete_subagent`(:9225-9230), `model.info`, `refine.run / refine.status`(:9248; 처리 :3032,:3041), MCP 핸들러 `_mcpManager.hostHandlers()`(:9322)를 커널에 제공(ipython.ts:283,:471 경유).

**Python 스킬 로딩**: `skills.ts:loadSkillsFromDir`(:275)이 `SKILL.md` 디렉터리를 스킬 루트로(:271-302), `detectPythonSkill`이 `pyproject.toml` 존재 시 `kind:"python"`(:207-252). `getPythonSkillRuntimeInfo`(:256) → `ensureKernelPython({pythonSkills})`가 pyproject 해시로 venv에 설치(bootstrap.ts:130-141,:262-270) → `buildRlmBootstrapCode(pythonSkills)`(ipython.ts:70)로 커널 import. 번들 스킬 디렉터리는 `getBundledSkillsDir`(config.ts:462-471) → `DefaultResourceLoader`(resource-loader.ts:218). 사용자/프로젝트 스킬은 `~/.evopi/agent/skills`, `<cwd>/.evopi/agent/skills`(skills.ts:520-521).

## 3. 컨텍스트 관리

| 파일 | 라인 | 핵심 |
|---|---|---|
| core/system-prompt.ts | 219 | `buildSystemPrompt`(:48) — 옵션 `customPrompt/selectedTools/skills/harnessState/harnessSelector`(:49-61). 하네스 상태 삽입 `formatHarnessStateForPrompt(..., selectEntries: harnessSelector)`(:117,:156) |
| core/refinement/refinement.ts | 1041 | `formatHarnessStateForPrompt`(:429; `selectEntries` 옵션 :444) |
| core/refinement/harness-select.ts | 93 | `createMmrHarnessSelector`(:57): `mmrRerank`(mnemopi) + recency(반감기 7일 :50) + `charBudget`(:69-85). 기본은 lexicographic; evo 게이트 뒤에서만(:17-18) |
| core/settings-manager.ts | — | `getHarnessSelectionSettings`(:942; `harness.selection`="mmr" 또는 evo on → MMR :944), `resolveEvoEnabled`(:930) |
| core/compaction/compaction.ts | 788 | `shouldCompact`(:206) `prepareCompaction`(:579) `compact`(:673) `generateSummary`(:508) `findCutPoint`(:367); 요약 프롬프트는 `compact` 스킬(:102) |
| core/compaction/branch-summarization.ts | 307 | 브랜치 요약 |

배선: `AgentSession._rebuildSystemPrompt`(agent-session.ts:4359) → `buildSystemPrompt`(:4399); 툴/스킬/하네스 변경 시 재빌드(:1336,:1355,:4226,:8389,:8825,:11367). 자동 압축: 턴 후 `shouldCompact` 판정(:2751, :8546) → `this.compact`(:7399 → `prepareCompaction` :7501 → `compact` :7534). `/compact` 명령 경로 :6106.

## 4. 권한 / 안전

| 파일 | 라인 | 핵심 |
|---|---|---|
| core/extensions/builtin/permission-gate.ts | 125 | `DANGEROUS_PATTERNS` 7개(:28-36: rm -rf, sudo, chmod/chown 777, mkfs, dd of=/dev/, fork bomb, >/dev/sda). `isDangerousCommand`(:39). `extractShellCommand`(:48)은 `bash.command`와 `ipython.code`의 `!`/`os.system`/`subprocess`(:53). 모드 `EVOPI_PERMISSION_GATE` = `block`(기본)/`warn`/`off`(:58-62). `session_start`에서 `probeSandbox` 결과 notify(:90-103); `tool_call`에서 block/warn 처리(:105-124): UI 없으면 즉시 block(:116-118), UI 있으면 `ctx.ui.select` 확인(:119) |
| core/sandbox-probe.ts | 112 | `probeSandbox`(:94): `bwrap --version`(:34) + 실제 `bwrap --ro-bind / / --unshare-user --die-with-parent true`(:46) 실행 판정. 종류 `bubblewrap/sandbox-exec/none`(:19) |
| core/agent-session-services.ts | — | 빌트인 등록(:177-182): `createPermissionGateExtension()`은 `noExtensions`가 아니면 항상 로드(:181) |

**bwrap 래핑**: `packages/coding-agent/src`에 bwrap 실행 래핑 코드 **없음** — `rg bwrap` 히트는 sandbox-probe.ts만(:7,:8,:11,:34,:39,:46). OS 레벨 래핑은 예제 익스텐션 `examples/extensions/sandbox/index.ts`(`@anthropic-ai/sandbox-runtime` `SandboxManager.wrapWithSandbox` :47,:139)로만 존재, 제품에 미포함. 즉 현행 enforcement 층은 D3 [폴백](permission-gate.ts:7-11 주석) 상태.

## 5. 확장성

| 항목 | 위치 |
|---|---|
| 익스텐션 러너 | core/extensions/runner.ts (1074): `ExtensionRunner`(:235), `hasHandlers`(:497), 범용 `emit`(:686), 전용 `emitToolCall`(:812) `emitToolResult`(:762) `emitContext`(:864) `emitBeforeProviderRequest`(:896) `emitBeforeAgentStart`(:930) `emitInput`(:1045) `emitUserBash`(:835) |
| 훅 이벤트(types.ts 1434) | session_start(:491) session_before_switch(:500) session_before_compact(:514) **session_before_refine**(:539) session_compact(:553) session_shutdown(:560) session_before_tree(:583) session_tree(:590) context(:609) before_provider_request(:615) before_agent_start(:628) agent_end(:646) turn_start(:665) turn_end(:672) model_select(:726) user_bash(:740) input(:753) tool_call(:768) tool_result(:801) |
| 로더 | core/extensions/loader.ts (593): `loadExtensions`(:418) `discoverAndLoadExtensions`(:552) `loadExtensionFromFactory`(:402); jiti 가상모듈 표 bundled-modules.ts:22-39 (`@evopi/*` + `@mariozechner/*` 별칭) |
| 빌트인 3개 | `herdr-agent-state.ts`(461; HERDR_ENV=1일 때만 동작 :15-16), `permission-gate.ts`(125), `grounded-refine.ts`(208; **evo on일 때만 등록** agent-session-services.ts:177-182) |
| 번들 스킬 | `packages/coding-agent/skills/` **16개** (SKILL.md 16, pyproject 11). Python: agent-message, agent-observe, attach-image, compact, edit, goal, linear, notion, refine, rlm-heartbeat, websearch. Markdown: prime-intellect, semantic-compression, skill-creator, system-prompts, tool-prompt-optimization |
| MCP | core/mcp/mcp-manager.ts (245): `McpManager`(:35) `registerUserProviders`(:122) `hostHandlers`(:179) `getDisabledBuiltinSkillOverrides`(:167, 로그인 안 된 통합 스킬 비활성). Python 측 evopi-runtime/src/rlm/mcp.py(658), mcp_base.py(333); 커널이 `rlm.mcp` import(agent-session.ts:1371) |
| 서브에이전트 | Python `rlm.run/find_models/list_subagents/delete_subagent`(evopi-runtime/src/rlm/__init__.py:92,:117,:161,:170) → host_request → agent-session.ts:9225-9230 → `_createInlineRlmSubagentRuntime`(:9510)이 자식 `SessionManager`+`Agent`(:9511,:9522) 생성. TS 헬퍼 core/rlm-runtime.ts(255) |

## 6. 자기개선 층 (refinement / rlm.harness / grounded-refine)

| 파일 | 라인 | 핵심 |
|---|---|---|
| core/refinement/refinement.ts | 1041 | 종류 `prompt/memory/skill/subagent`(:30), `HarnessState`(:59), `planRefinement`(:890; 모델 호출 LLM 계획, `rollbackId`면 `rollbackProposal`(:823) :902-911), `applyRefinementProposal`(:726), `refineHarness`(:1024), `reviewAutoRefine`(:973), 상태 저장 `saveHarnessState`(:345)/글로벌 이력 `appendGlobalRefinement`(:374). 글로벌 디렉터리 `getGlobalHarnessStateDir`(:269, agentDir 기준) / 로컬 `getLocalHarnessStateDir`(:273) |
| core/agent-session.ts | — | `refine`(:8068) → `planRefinement`(:8270). **훅 지점** `session_before_refine`(:8243-8262): 결과 `skip`→`RefineSkippedError`(:8260), `proposal`→계획 대체. 자동 리파인: `_runSerializedRefineCheckpoint`(:2272) `_runSerializedAutoRefineReview`(:2425) `_maybeStartSerializedBackgroundPlan`(:2536) `_runBackgroundPlan`(:2592); 사유 `turn_interval`/`compact`(refinement.ts:110) |
| core/settings-manager.ts | — | `getAutoRefineSettings`(:948): `EVOPI_EVO=off`면 `enabled=false`(:955), 기본 `turnInterval=25`(:958), `compact=true`(:960) |
| core/extensions/builtin/grounded-refine.ts | 208 | `readFeedbackFromEnv`(:69, `EVOPI_FEEDBACK_FILE` JSON `{task,status,detail?}`), `isFailureStatus`(:64), `buildFeedbackBlock`(:102 `<external_feedback>`), `defaultGroundedPlanner`(:114; 키 없으면 undefined→기본 planner :126-128; `retryTransientCompletion(completeSimple)` :152-154). 훅(:191-203): 신호 없음→no-op, 비실패→`{skip:true}`, 실패→planner 대체 |
| evopi-runtime/src/rlm/harness.py | 820 | `HarnessState`(:142): `load/save`(:199,:285) `upsert`(:303) `create_*/update_*/delete_*` memory/prompt_note/skill/subagent(:531-674) `record_refinement`(:677) `plan_refinement`(:705) `overview`(:722) `snapshot`(:771); `get_harness_state`(:786). 커널에서 `rlm.harness` 프록시(__init__.py:184 `_HarnessProxy`) |
| skills/refine/src/refine/__init__.py | 50 | `status()`→`host_request("refine.status")`(:22), `run()`→`"refine.run"`(:50) |

evo 토글: `resolveEvoEnabled`(settings-manager.ts:930) — `EVOPI_EVO` on/off가 `evo.enabled` 설정에 우선. off/unset이면 grounded-refine 미등록(agent-session-services.ts:177-182)이고 MMR selector도 비활성(:944) → prime 스톡 경로 유지(D7).

## 7. 모델 연결

| 항목 | 위치 |
|---|---|
| 프로바이더 파일 | packages/ai/src/providers/: amazon-bedrock, anthropic, azure-openai-responses, cloudflare, faux, github-copilot-headers, google-shared, google-vertex, google, mistral, openai-codex-responses, openai-completions, openai-responses(-shared), register-builtins, simple-options, transform-messages |
| 등록 API 9종 | register-builtins.ts:344-400: anthropic-messages, openai-completions, mistral-conversations, openai-responses, azure-openai-responses, openai-codex-responses, google-generative-ai, google-vertex, bedrock-converse-stream(node-only 지연 import :24-25,:315). 모듈 로드 시 자동 등록(:405) |
| Faux 프로바이더 | providers/faux.ts: `registerFauxProvider`(:391), `fauxToolCall`(:57) 등 — 키 없는 테스트용. `packages/ai/src/index.ts`에서 export |
| 모델 카탈로그 | models.ts `getModel/getProviders/getModels`(:19-31), models.generated.ts; api-registry.ts `registerApiProvider`(:66); stream.ts `stream/streamSimple`(:25,:43) |
| 모델 레지스트리 | core/model-registry.ts (1678): `ModelRegistry`(:463) `refresh`(:506) `getAvailable`(:804) `find`(:1084) `getApiKeyAndHeaders`(:1377; authStorage → providerConfig.apiKey 순) |
| 인증 저장 | core/auth-storage.ts (1154): `AuthStorage`(:256) `login`(:762) `logout`(:775) `getApiKeyWithSourceToken`(:846) `getApiKey`(:983); 파일 백엔드 `FileAuthStorageBackend`(:108) → `~/.evopi/agent/auth.json`(config.ts:606). Prime Inference 팀 선택(:995-1048) |
| OAuth | packages/ai/src/utils/oauth/: anthropic, github-copilot, openai-codex, pkce, oauth-page; `getOAuthProvider/registerOAuthProvider/refreshOAuthToken/getOAuthApiKey`(index.ts:37-104). `packages/ai/src/oauth.ts`는 re-export(:1) |
| 인증 풀 | core/auth-pool/: env.ts `getEnvCredentialPool`(:34, `EVOPI_API_KEY_POOL_<PROVIDER>`) `rebindAuthHeader`(:50); pool.ts `CredentialPool`(:47) `createPoolResolver`(:125) `fnv1a32`(:22, Bun.hash 대체); retry.ts `withAuth`(:192) `AUTH_RETRY_MAX_ATTEMPTS=64`(:79); stream.ts `withAuthStream`(:61); oneshot-retry.ts `retryTransientCompletion`(:342) `classifyOneshotFailure`(:128); classify.ts `isAuthRetryableError`(:200) |
| Dialect(인밴드 툴콜) | core/dialect-mode.ts (126): `resolveOwnedDialect`(:65, `EVOPI_DIALECT` 우선 :66-68) `applyOwnedDialectContext`(:85) `wrapOwnedDialectStream`(:111). 엔진 packages/ai/src/dialect/ 39파일 6093라인(anthropic/deepseek/gemini/gemma/glm/harmony/hermes/kimi/minimax/qwen3/qwen-xml/xml 템플릿, catalog.ts:9 `renderToolCatalog`, coercion.ts) |
| Databricks | core/databricks-auth.ts (215): `fetchDatabricksClaudeEndpoints`(:93) `buildDatabricksModelCache`(:159) 캐시 파일 `databricks-models.json`(:9) |
| Prime CLI 연동 | core/prime-inference-auth.ts:90, packages/ai/src/env-api-keys.ts:209 — `~/.prime/config.json` 읽기(§8 참조) |

## 8. 런타임/툴체인 & 배포

**Bun 게이트 raw hits (8건, 모두 주석/문서 문자열, 실행 코드 0)**
```
natives-loader/src/index.ts:5  * `import.meta.dir` and `Bun.spawnSync`, which are undefined under Node. So we
natives-loader/src/index.ts:11 * product free of `Bun.*` (R7 policy).
hashline/src/hash.ts:2         * Node-only hashing for hashline (replaces the upstream `Bun.hash` usage).
hashline/src/hash.ts:5         * byte-identical to `Bun.hash.xxHash32(text, 0)`, which is what mints the
mnemopi/src/core/similarity-clusters.ts:4 * SQLite store (those depend on `bun:sqlite` and are deferred ...
mnemopi/src/index.ts:10        * `bun:sqlite` and is deferred (Q1: `bun:sqlite` → `node:sqlite`); the MCP
coding-agent/src/core/auth-pool/pool.ts:15 * `Bun.hash.xxHash32`: it is only an internal load-distribution ...
coding-agent/src/core/auth-pool/index.ts:8 ... The Bun.serve auth-broker /
```

**`.omp`/`.prime` 게이트 (16 hit) 분류**
| 분류 | 건수 | 위치 |
|---|---|---|
| `.omp` | 0 | — |
| 식별자 일부(`primeTeam`, `PrimeCliConfigPath`, `usePrimeCliConfig`) — 경로 아님 | 11 | auth-storage.ts:1022,1040,1063,1073,1074,1078,1079,1109,1136,1152 |
| 도메인/네임스페이스 문자열 | 3 | prime-inference-auth.ts:23-24(`api.primeintellect.ai`), telemetry.ts:13, acp-meta.ts:13 |
| **`~/.prime/config.json` 경로 리터럴(실코드)** | **2** | prime-inference-auth.ts:90 `join(homedir(), ".prime", "config.json")`; packages/ai/src/env-api-keys.ts:209 (동일, `getPrimeTeamId`) |

→ 2건은 evopi 설정 디렉터리가 아닌 외부 Prime Intellect CLI 설정 파일 읽기이나, CLAUDE.md "코드에 .prime 이 남으면 실패" 기준으로는 **미해결 잔존**. 판정은 메인 컨텍스트 몫.

**설정 경로**: `piConfig.configDir=".evopi/agent"`(packages/coding-agent/package.json:8), `CONFIG_DIR_NAME`(config.ts:498), `getAgentDir`(:525). `bin: {"evopi": "dist/bundle/cli.js"}`(package.json:10-12). 루트 `engines.node >=22.8.0`.

**배포 스크립트**
| 파일 | 라인 | 역할 |
|---|---|---|
| install.sh | 1621 | curl 원라이너 설치기. `EVOPI_DOWNLOAD_BASE_URL`/채널(stable|beta) 해석(:9-15,:948-962) → `$base/releases/v$ver/evopi-$ver.tgz` 다운로드(:102-113) → npm 설치(:909 npm 필수), 필요시 Node standalone 설치(:1102-1192) |
| evopi.sh | 81 | 개발 런처: `--dist`면 `node dist/bundle/cli.js`(:66-72), 아니면 `tsx packages/coding-agent/src/cli.ts`(:75-81); `--no-env`로 키 환경변수 제거(:24-63) |
| scripts/pack-evopi-release.mjs | 357 | 워크스페이스 7패키지(natives-loader, hashline, mnemopi, ai, tui, agent, coding-agent :26-36)를 tarball로 pack, 내부 의존을 릴리스 URL로 rewrite; 기본 출력 `packages/coding-agent/release`(:19) |
| packages/coding-agent/scripts/bundle.mjs | 52 | esbuild로 `dist/cli.js`→`dist/bundle/`(:3-12), jiti virtualModules `__PI_BUNDLED__` |
| packages/coding-agent/postinstall.cjs | 14 | `dist/postinstall.js` 실행(있을 때만) |
| build 순서 | 루트 package.json `build`: natives-loader→hashline→mnemopi→tui→ai→agent→coding-agent; `copy-assets`가 `evopi-runtime`과 `skills`를 dist로 복사 |

**네이티브**: packages/natives-loader/src/index.ts (184): `loadNatives`(:141) — Bun 래퍼 우회, 플랫폼 leaf `.node` 직접 `require`(AVX2 `detectAvx2` :109), 실패 시 `null`. hashline/src/native.ts(:22-28 `diffLineRuns` 네이티브→TS LCS 폴백), mnemopi/src/native.ts(:20 `mmrRerankIndices` null→TS 폴백). mnemopi는 MMR/벡터인덱스/클러스터 3커널만, SQLite(SHMR)·MCP 서버는 이연(index.ts:9-12).

## 9. 평가 인프라 (eval/)

| 항목 | 내용 |
|---|---|
| 격리 | `eval/package.json`: bun 워크스페이스, `@oh-my-pi/*` 18.1.2 카탈로그 핀. 제품(node)과 분리(README.evopi.md:3-6). bun.lock/bunfig.toml 존재 |
| metaharness | eval/metaharness/{src: server,store,runner,launch-args,benchmarks,experiments; adapters/edit; agent/omp_local.py; scripts/trace-report,tb-floor; test 7파일} — omp 복사본(README.evopi.md:14 "unmodified") |
| typescript-edit-benchmark | eval/typescript-edit-benchmark/src (shared,verify,mutations,tasks,hunks,edit-shape-stats,formatter,in-process-client,generate) + fixtures.tar.gz + test 2 |
| faux-provider-smoke.ts | 79라인. `@oh-my-pi/pi-ai/providers/mock`의 `registerMockApi/createMockModel`로 `completeSimple` 키리스 검증(:13-14,:30-56). **evopi 자체 faux.ts는 사용하지 않음** |
| arms.md | 4 arm(`evopi-omp`/`evopi-prime`/`evopi-evooff`/`evopi-evoon`) 커맨드. arm 구분 = bun `overrides`(에이전트 선택) + 프로세스 env(`EVOPI_EVO`,`EVOPI_FEEDBACK_FILE`,`EVOPI_FEEDBACK_DETAIL`) |
| RESULTS.md | **Status: SKIP (no API key)** — 실제 A/B 미실행. 대체: Smoke1 (eval 측 mock completeSimple PASS), Smoke2 (`packages/coding-agent/step14-evoon-logic-smoke.ts`, grounded-refine 로직 PASS). "pi-ai ships no mock provider" 서술은 현재 `packages/ai/src/providers/faux.ts:391 registerFauxProvider` 존재와 **불일치**(RESULTS 작성 후 추가된 것으로 추정, 미확인) |

## 10. 요약 소견 (사실 기반)

- 제품 그래프는 tsgo 타입체크 통과(exit 0); Bun API 실코드 0건.
- 기본 툴은 `ipython` 단독, 셸/편집은 커널 내 `bash()`·Python `edit` 스킬 경로. TS `bash`/`edit` 툴 정의는 존재하나 미등록.
- 권한은 intent 층(정규식 7패턴)만 작동, bwrap enforcement는 probe만 있고 래핑 미구현(예제 익스텐션만).
- evo 층은 `EVOPI_EVO` 게이트 뒤 grounded-refine 등록 + MMR selector + autoRefine 토글 3지점으로 한정되어 off 시 스톡 경로.
- `.prime` 경로 리터럴 2건(prime-inference-auth.ts:90, env-api-keys.ts:209) 잔존.
- 평가는 API 키 부재로 SKIP, 스모크 2종만 기록.
