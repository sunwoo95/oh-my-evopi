# oh-my-pi (omp) 마스터 아키텍처 — 코딩 에이전트 하네스

> 대상 `/opt/workspace/local/sw4kim/my-agent/oh-my-pi` (v18.1.2, 읽기 전용). 경로는 omp 레포 상대경로. 이식 판정/결론 없음 — 구조 사실만. 선행 문서: `docs/analysis/omp.md`(백포트 등급 실측). 규모: `find packages -name '*.ts'` = 4665, 루트 `package.json` `packageManager: bun@1.4.0`.

| 패키지 | .ts | src 라인 | 역할 |
|---|---|---|---|
| `packages/agent` | 68 | 15,970 | 제어 루프 + 컴팩션 코어 (`pi-agent-core`) |
| `packages/coding-agent` | 2877 | 473,624 | 툴·세션·확장·CLI (bin `omp`) |
| `packages/ai` | 702 | 108,502 | 프로바이더/스트림/auth/dialect |
| `packages/catalog` | 177 | 32,688 | 모델 카탈로그 (`models.json` 12.03MB, 최상위 키 66=프로바이더) |
| `packages/tui` / `utils` | 150 / 251 | 27,938 / 43,664 | 터미널 UI / dirs·env·procmgr |
| `packages/mnemopi` / `hashline` / `snapcompact` | 143 / 33 / 5 | 19,743 / 7,195 / 2,186 | 메모리 / 편집포맷 / 이미지 컴팩션 |
| `packages/metaharness` | 28 | 5,524 | 벤치 러너·대시보드 |

## 1. 제어 루프 — packages/agent/src/agent-loop.ts (3,010 lines)

진입 계층: `agentLoop()` (`:526`) / `agentLoopContinue()` (`:588`) / `agentLoopDetailed()` (`:724`) → `runLoop()` (`:934`, 텔레메트리 span 래퍼) → **코어 `runLoopBody()` (`:1025`–`:1563`, 539 lines)**.

**턴 구조 2중 루프**: 외부 `while(true)` (`:1124`, follow-up 도착 시 재진입) / 내부 `while (hasMoreToolCalls || pendingMessages.length > 0)` (`:1129`). 반복 시작마다 `yieldIfDue()` (`:1137`) + 전역 일시정지 게이트 `agentPauseGate.paused / waitUntilResumed(signal)` (`:1139`; `packages/agent/src/pause.ts` 107 lines). 재개 특수경로: `unpairedToolCallTail()` (`:567`)로 미완결 toolCall 꼬리 감지 시 **모델 호출 전에 툴 재실행** (`:1092`–`:1122`) — 이때 steering은 tool_use/result 페어링 불변식 보호를 위해 배치 후로 파킹(`:1085`–`:1091` 주석).

**컨텍스트 준비** `prepareProviderCall()` (`:1589`–`:1636`): `transformContext` → `convertToLlm` → `normalizeMessagesForProvider` (`:791`) → `appendOnlyContext.build()` 또는 `normalizeTools()` (`:890`) → `transformProviderContext`.

**스트리밍** `streamAssistantResponse()` (`:1642`–`:1984`, 343 lines). `EventStream<AgentEvent, AgentMessage[]>` (`:620`). 이벤트 유니온 `packages/agent/src/types.ts:864`–`:888`: `agent_start/agent_end`, `turn_start/turn_end`, `message_start/message_update/message_end`, `tool_execution_start/update/end`. 스트리밍 중 툴콜은 `message_end` 전에 검증+`beforeToolCall`을 거쳐 `preparedDispatchByMessage`에 캐시(`:2359`) — 훅 수정본이 메시지에 이미 반영된다.

**툴콜 디스패치**: `prepareToolCallDispatch()` (`:2220`) → `resolveToolForCall()` (`:2192`) → `validateToolArguments()` (`:2254`) → **`executeToolCalls()` (`:2305`–`:2847`, 543 lines)**. 스케줄링: 툴 선언 `concurrency: "shared"|"exclusive"|(args)=>...` 에 따라 shared 병렬 / exclusive는 이전 전체 배리어 후 단독 (`:2778`–`:2801`), 종료 `Promise.allSettled` (`:2804`).

**steering / aside / follow-up 3중 큐** (계약 `packages/agent/src/types.ts`):
- `getSteeringMessages` (`:236`) 소비형 dequeue — 주입 경계 3곳뿐: 루프 시작(`agent-loop.ts:1067`), 배치 정산 후(`:1509`), stop 경계 재폴(`:1538`).
- `hasSteeringMessages` (`:246`) **비소비 peek**, 툴 1건마다 확인해 잔여 배치 skip. 반환 `boolean | SteeringQueueState{queued, source:"user"|"agent"|"system"|"unknown"}` (`:131`–`:142`).
- `waitForSteeringMessages` (`:265`) 이벤트 wake / `hasIrcInterrupts` (`:271`) 피어 인터럽트 peek. 폴 주기 `STEERING_INTERRUPT_POLL_MS = 250` (`agent-loop.ts:159`).
- `getFollowUpMessages` (`:284`) 정지 직전 폴 → 있으면 턴 1회 더. `getAsideMessages` (`:293`) **비인터럽트 수동 통지**(백그라운드 잡 완료, 지연 LSP 진단); `AsideMessage`는 thunk 가능하며 주입 순간 `null` 반환으로 드롭 (`agent-loop.ts:1004`–`:1018`), 커밋/폐기 심볼 `ASIDE_MESSAGE_COMMIT/DISCARD` (`:1019`, `:1149`).
- `onBeforeYield` (`:303`), `syncContextBeforeModelCall` (`:496`), `beforeModelCall`(게이트가 stop 가능 `:1191`). 호스트 배선 예 `packages/agent/src/agent.ts:1487`, `:1494`.

**abort 3층 분리** (`:2336`–`:2352`): ① `nonInterruptibleSignal`=외부 signal만 — 부작용 있는 툴(bash)은 steering으로 죽지 않음 ② `interruptibleSignal`=외부∪steering∪IRC, `tool.interruptible`인 순수 대기형만 ③ `steeringSoftController`→`ctx.steeringSignal` (`types.ts:553`–`:560`) 협조적, 무시해도 안전. `deadline`은 `AbortSignal.any` 합성 (`:1035`–`:1046`). `interruptMode: "immediate"|"wait"` (`types.ts:151`). 중단 시 `createSyntheticToolResultMessage()` (`:2911`), `source`는 `assistant_stop_*`/`interrupt_skipped` (`:2848`–`:2877`).

**in-band 툴콜(dialect)** (`:1602`–`:1634`): `ownedDialect = config.dialect ?? resolveOwnedDialectFromEnv(Bun.env.PI_DIALECT)` (`:1602`). dialect 존재 시 wire `tools`를 **제거**하고 `renderInbandToolPrompt()`를 시스템 프롬프트에 append, 히스토리를 `encodeInbandToolHistory()`로 재인코딩 (`:1626`–`:1633`); `toolChoice` 무효화(`:1699`), `pruneToolDescriptions` 강제 off(`:1603`). **Harmony 누출 완화**: `isHarmonyLeakMitigationTarget(model)` (`:1667`) → 전용 컨트롤러로 스트림 절단·재샘플, `truncate_resume` 2회 / `abort_retry` 2회 상한 + temperature +0.05 (`:1272`–`:1297`, `:1697`), 감사 `emitHarmonyAudit()` (`:1565`).

## 2. 툴 시스템 & 실행 엔진

**레지스트리**: `src/tools/builtin-names.ts:1`–`:30` 빌트인 **29종** — `read, bash, edit, ast_grep, ast_edit, ask, debug, eval, github, glob, grep, lsp, inspect_image, browser, computer, checkpoint, rewind, security_scan, task, hub, todo, web_search, write, memory_edit, retain, recall, reflect, learn, manage_skill`; 숨김 3종 `yield, goal, think` (`:34`). 팩토리 `BUILTIN_TOOLS` (`tools/index.ts:462`) / `HIDDEN_TOOLS` (`:494`) / `createTools()` (`:505`). 별칭 `search→grep`, `find→glob` (`builtin-names.ts:38`–`:41`); MCP는 `mcp__` 접두사 (`:68`).

**툴 인터페이스** `packages/agent/src/types.ts:762`–`:854`: `loadMode:"essential"|"discoverable"` (`:773`, 정의 `:717`), `concurrency` (`:783`), `lenientArgValidation` (`:785`), `interruptible` (`:797`), `intent`(=`INTENT_FIELD` `i` 주입 정책, `:806`), `approval` (`:838`), 스트림 매처 `matcherDigest`/`matcherPaths`/`matcherEntries` (`:815`,`:827`,`:836`). 스키마는 omptype `type({...})` (예 `tools/learn.ts:9`).

**bash/셸**: `src/exec/bash-executor.ts` (776) — `import { MinimizerOptions, PtySession, Shell, ShellRunResult } from "@oh-my-pi/pi-natives"` (`:7`). 즉 **`/bin/bash` spawn 없이 Rust `brush-core` 셸을 in-process 실행** (`:1`–`:5`; `crates/pi-shell/Cargo.toml:17`–`:18` brush-core/brush-parser, uutils 빌트인 `pi-builtins` `:16`). `useUserShell` + `pty:{cols,rows,onChunk}` 로 zsh/fish를 헤드리스 PTY 실행 (`:29`–`:30`,`:47`–`:53`); 네이티브 minimizer가 출력 재작성 시 원본은 artifact 보존 (`:35`–`:45`); 셸 스냅샷 `:13`, direnv `:14`, 비대화 env `:15`.

**편집(hashline)**: `packages/hashline` 7,195 lines / 19 서브모듈 (`src/index.ts:1`–`:19`). 포맷 SSOT `src/format.ts`: 섹션 `[path#hash]` (`:10`–`:12`), 키워드 `PUT/CUT/REM/MV` (`:16`–`:23`), 갭 시길 `<N`/`>N`/`>$` (`:26`–`:32`), 블록확장 `N*` (`:30`), 레지스터 `@name` (`:34`), 범위 `5.=10` (`:41`). 어댑터 `src/edit/hashline/{block-resolver,diff,execute,filesystem,params}.ts` (1,102); 그 외 `src/edit/{apply-patch,modes,sloppy.ts,notebook.ts}`.

**실행 순서**: 스키마 검증(`agent-loop.ts:2254`) → `beforeToolCall`(revise/block, `blocked/blockReason` `:2394`–`:2402`) → approval 게이트 → execute → `afterToolCall`. 배선 `src/session/agent-session.ts:1534`(after) / `:1538`(before), 구현 `:3690` / `:3715`.

**샌드박스**: OS 레벨(bwrap/seccomp/landlock) **없음** — `rg 'bwrap|landlock|seccomp' packages/**/*.ts` 히트는 `packages/utils/src/dirs.ts:700`(puppeteer 디렉터리명)과 `packages/metaharness/src/tb/vmon.ts:59`(원격 VM `Sandbox` API)뿐. 격리는 **COW 파일시스템 + git worktree**: `crates/pi-iso/src/{overlayfs,linux_reflink,btrfs,apfs,zfs,projfs,windows_block_clone}.rs`; 라이프사이클 `src/task/isolation-runner.ts:1`–`:20` (prepare → runIsolatedSubprocess(worktree) → mergeIsolatedChanges), `src/task/worktree.ts` (1,028). 컨테이너는 `Dockerfile`, `Dockerfile.robomp:1`–`:15`.

## 3. 컨텍스트 관리

**시스템 프롬프트**: `src/system-prompt.ts` (1,040). `buildSystemPrompt()` (`:681`)가 조립; 재료는 `.md` 텍스트 임포트 — `system-prompt.md`, `project-prompt.md`, `active-repo-context.md`, `computer-safety.md`, `custom-system-prompt.md`, personality 3종 (`:28`–`:35`). 로더 `loadProjectContextFiles()` (`:451`) / `loadSystemPromptFiles()` (`:491`); 중복 억제 `dedupeContainedContextFiles()` (`:425`), `dedupeAlwaysApplyRules()` (`:132`), `promptSourceContainsRule()` (`:128`); 환경 블록 `getEnvironmentInfo()` (`:357`). `src/prompts/system/` 에 75개 md 조각(auto-continue, plan-mode-*, ttsr-*, snapcompact-*, subagent-*, autolearn-*).

**프리픽스 캐시**: `packages/agent/src/append-only-context.ts` (374) — `StablePrefix`(시스템프롬프트+툴스펙 1회 스냅샷 동결 `:27`–`:31`) + `AppendOnlyLog`(과거 턴 재직렬화 금지) → 턴마다 신규 델타만 캐시 미스 (`:1`–`:15`).

**컴팩션**: `packages/agent/src/compaction/` 6,297 lines (`compaction.ts` 1,861 / `compaction-v2-streaming.ts` 847 / `openai.ts` 1,008 / `shake.ts` 475 / `pruning.ts` 440 / `branch-summarization.ts` 382 / `utils.ts` 350 / `messages.ts` 283). 전략 5종 `"context-full"|"handoff"|"shake"|"snapcompact"|"off"` (`compaction.ts:169`). `DEFAULT_COMPACTION_SETTINGS` (`:208`–`:219`): `context-full`, `thresholdPercent:-1`/`thresholdTokens:-1`(자동), `midTurnEnabled:true`, `keepRecentTokens:20000`, `autoContinue:true`, `remoteEnabled:true`, `remoteStreamingV2Enabled:true`. `DEFAULT_RESERVE_TOKENS=16384` (`:191`), `MAX_SUMMARY_TOKENS=DEFAULT_RESERVE_TOKENS` (`:203`; 근거 `:193`–`:202`: 요약 예산 `floor(0.8*reserve)`, 유효 reserve ≥ 창의 15%). 판정 `shouldCompact()` (`:337`) / 임계 `resolveThresholdTokens()` (`:362`) / 컷포인트 `findCutPoint()` (`:499`), 턴경계 `findTurnStartIndex()` (`:457`) / `generateSummary()` (`:847`) / `generateHandoff()` (`:1123`) / `compact()` (`:1522`). 네이티브 컴팩션 판정 `shouldUseProviderNativeCompaction()` (`:222`), OpenAI 원격 경로 `compaction/openai.ts`. 컨텍스트 토큰은 프로바이더 오케스트레이션 토큰 차감 (`:244`–`:253`). `shake` = LLM 없이 툴결과/대형블록을 플레이스홀더 치환 (`shake.ts:1`–`:12`), `pruning` = 툴출력 프루닝(보호 매처 `tool-protection.ts`, 스킬 read 결과 보호 `pruning.ts:13`).

**snapcompact** (`packages/snapcompact/src/snapcompact.ts` 2,185): 폐기 히스토리를 **픽셀폰트 PNG 프레임으로 렌더**해 비전 모델이 직접 읽게 함 (`:1`–`:8`). 프레임 shape는 프로바이더별 eval 결정 — Anthropic `11on16-bw`, Google `8on22-bw@2048`, OpenAI `8on22-bw@1568`, 기타 `8on22-bw` (`:18`–`:44`). LLM 호출 0·결정적, 래스터화는 네이티브 `renderSnapcompactPng` (`:50`, 구현 `crates/pi-natives/src/snapcompact.rs` — `:43` 주석). 프레임은 컴팩션 엔트리 `preserveData`에 저장 → **매 컨텍스트 재구성마다 요약 메시지에 재부착** (`:46`–`:48`).

**메모리 주입**: 추상화 `src/memory-backend/types.ts`, 선택 `resolve.ts:20`–`:26` — `hindsight | mnemopi | sharpshooter | local | off` (단일 선택지점). 주입 훅 2+1: `beforeAgentStartPrompt()` (`types.ts:152`, 해당 턴 시스템 프롬프트 append; 주석상 "세션 첫 답변에 영향 줄 수 있는 유일한 지점"), 이후 재구성은 `buildDeveloperInstructions()`, 컴팩션 요약 프롬프트 삽입 `preCompactionContext()` (`types.ts:163`). 저장 내용 — mnemopi: SQLite 벡터/그래프 (`packages/mnemopi/src/core/` 39모듈: `episodic-graph`, `triples`, `patterns`, `veracity-consolidation`, `weibull`, `polyphonic-recall`, `mmr`) / local: 롤아웃→SQLite→`memory_summary.md` 2단계 파이프라인 (`src/memories/index.ts:20`–`:39` `claimStage1Jobs`/`tryClaimGlobalPhase2Job`/`markGlobalPhase2Succeeded`; `storage.ts` 578; DB `bun:sqlite` `:1`) / hindsight: 원격 뱅크 3스코핑(global·per-project·per-project-tagged, `hindsight/bank.ts:1`–`:20`) + mental models / sharpshooter: friction-gated 결정 메모리, delta kind `architecture_decision|product_decision|style_decision|constraint|rejected_approach|correction` (`sharpshooter/extract.ts:16`–).

## 4. 권한/안전

`src/tools/approval.ts` (288): 정책 `allow|deny|prompt` (`:13`), 모드 `always-ask|write|yolo` (`:14`), 티어 `read|write|exec` (`:29`)+랭크(`:31`), 모드별 자동승인 상한 `{always-ask:read, write:write, yolo:exec}` (`:37`–`:41`). 해석 순서 (`:104`–`:117`, 구현 `resolveApproval()` `:120`): ① 툴 `approval(args)`(생략시 `exec`) ② 유저 `tools.approval.<policyKey|tool.name>` ③ 모드 티어 비교. `policyKey`로 디스패처 툴(`write`의 `xd://` 장치 호출)이 서브툴 단위 정책 참조. yolo에서는 `override:true` 강제프롬프트 무시, 유저 설정은 권위 유지 (`:112`–`:113`). 렌더 `formatApprovalPrompt()` (`:267`), 거부 `denyError()` (`:224`).

**위험 명령**: `src/tools/bash.ts:172`–`:219` `CRITICAL_BASH_PATTERNS` — `rm -rf /` 변형(플래그 순서 무관 `:177`), `--no-preserve-root`(`:180`), `sudo rm`(`:182`), `chmod/chown -R … /`(`:183`–`:185`), 포크밤(`:188`), `>/dev/sd[a-z]`·`mkfs`·`dd of=/dev/`·`shred /dev/`·`cryptsetup`(`:191`–`:196`), `/etc/{passwd,shadow,sudoers}` 덮어쓰기·`tee`(`:199`–`:200`), `curl|sh`·`bash <(curl …)`·`eval $(curl …)`(`:203`–`:209`), `kill -9 1`·shutdown/reboot/halt·`init 0`(`:212`–`:216`), `nc -e/-c`(`:219`). 원칙 "false negative 비용이 크므로 의도적으로 타이트" (`:167`–`:170`). 유저 패턴은 glob→RegExp(`:229`) 후 **복합 명령을 세그먼트 단위 매칭**해 `cd x && rm -rf /` 포착 (`:264`–`:278`; 토크나이저 `tools/shell-tokenize.ts`).

기타 방어층: `tools/plan-mode-guard.ts`(155), `tools/bash-interceptor.ts`(148), `tools/security-scan.ts`(287) + `src/security/`(sarif/provenance/preflight/coordinator), **시크릿 난독화** `src/secrets/{obfuscator,placeholder,message-transform}.ts`(모델로 나가는 툴 인자 치환; 사용 예 `advisor/runtime.ts:8` `obfuscateToolArguments`), ACP 게이트 `session/acp-permission-gate.ts`.

## 5. 확장성

**훅 28종** — `HookEvent` 유니온 `src/extensibility/hooks/types.ts:388`–`:403`, 문자열 이름은 `shared-events.ts:29`–`:296`: `session_start, session_before_switch, session_switch, session_before_branch, session_branch, session_before_compact, session_compact, session_shutdown, session_stop, session_before_tree, session_tree, goal_updated, context, agent_start, agent_end, turn_start, turn_end, auto_compaction_start, auto_compaction_end, auto_retry_start, auto_retry_end, retry_fallback_applied, retry_fallback_succeeded, ttsr_triggered, todo_reminder` + `before_agent_start`(`hooks/types.ts:280`), `tool_call`(`:305`), `tool_result`(`:318`). 훅이 컨텍스트를 바꿀 수 있음: `ContextEventResult.messages` (`:413`), `BeforeAgentStartEventResult.message` (`:425`). 러너 `hooks/{loader,runner,tool-wrapper}.ts`.

**익스텐션** `src/extensibility/extensions/` (loader 762 / runner 1,767 / types 1,786 / wrapper 417, `compact-handler`, `get-commands-handler`, `managed-timers`, `model-api`) + 레거시 shim 3종 + `legacy-typebox.ts`. **커스텀 툴** `custom-tools/{loader 301, types 297, wrapper 52}`. 어댑터 경계에서 `loadMode` 생략은 `discoverable` 기본이며, 빌트인 이름은 `ESSENTIAL_BUILTIN_TOOL_NAMES` (`tools/essential-tools.ts:24`–`:35`: read/write/bash/edit/glob/computer/eval/task/hub/learn/manage_skill)로 `essential` 고정 (`:44`–`:46`, 이유 `:9`–`:15` — 렌더 커스터마이즈용 재등록이 xdev로 언마운트되는 회귀 #5764).

**xd:// 가상 툴 장치** `src/tools/xdev.ts:1`–`:25`: discoverable 툴을 요청 tools 배열에서 언마운트하고 `read xd://`(목록)/`read xd://<tool>`(문서+스키마)/`write xd://<tool>`(실행, content=JSON args)로 노출. 인자는 네이티브 툴콜과 동일 `validateToolArguments` 검증(불일치 시 스키마 반환 → 자기교정).

**스킬** `src/extensibility/skills.ts` (542): `Skill{name,description,filePath,baseDir,source,hide?,containRoot?}` (`:18`–`:37`), `skill://<name>` + `/skill:<name>` (`:24`–`:28`), Agent Plugin 스킬은 `containRoot` realpath 봉쇄 (`:30`–`:33`), 프롬프트 `prompts/skills/{autoload,user-invocation}.md` (`:14`–`:15`). 레포 스킬 3종 `.omp/skills/{semantic-compression(142행), system-prompts(182행+small-models.md), tool-prompt-optimization(116행+scripts/probe.ts)}`.

**슬래시 커맨드** `src/slash-commands/` — 빌트인 정의 83건 (`rg -o '^\t*name: "…"' builtin-*.ts` = 83); 레지스트리 `builtin-registry.ts:54`(예약명), `:57`(DEFS), `:97`(TUI), `:110`(내부 spec); 카테고리 control/lifecycle/session/modes/collaboration/marketplace/completions/acp.

**MCP** `src/mcp/` 22파일 — client/manager/loader, transports/, OAuth 3종, Smithery 3종, 브리지 `mcp/tool-bridge.ts:1`–`:5`(MCP 정의→CustomTool, `normalizeSchemaForMCP` `:8`).

**서브에이전트** `src/task/` 27파일 23,466 lines (`executor.ts` 3,649 / `render.ts` 1,830 / `name-generator.ts` 1,577 / `index.ts` 1,542 / `worktree.ts` 1,028). `task/index.ts:1`–`:14`: 정의는 번들 + `~/.omp/agent/agents/*.md` + `.omp/agents/*.md`에서 발견, 호출당 단일 스폰(병렬은 병렬 task 콜), `task.batch` 시 배치+공유 컨텍스트, `async.enabled` 시 AsyncJobManager 백그라운드, JSON 이벤트 진행 추적. 깊이 제한 `canSpawnAtDepth`(`:37`), `spawn-policy.ts`, `read-only-policy.ts`, `provider-concurrency.ts`, `structured-subagent.ts`(694).

**TTSR (Time Traveling Stream Rules)** `docs/ttsr-injection-lifecycle.md:3` — 스트리밍 중 규칙 매칭 → 스트림 중단 → 규칙 주입 → 재시도. 조율 `src/session/ttsr-coordinator.ts`, 프론트매터 `src/capability/rule.ts:26`–`:34` (`condition`, `astCondition`(ast-grep, edit/write 스트림 한정), `scope`, `interruptMode:"never"|"prose-only"|"tool-only"|"always"`), 버킷 `capability/rule-buckets.ts`, 툴측 훅 `matcherDigest/matcherPaths/matcherEntries` (`packages/agent/src/types.ts:815`–`:836`). 룰 소스는 Cursor `.mdc`/Windsurf/Cline 정규화 (`capability/rule.ts:1`–`:6`).

**Advisor/Watchdog** `docs/advisor-watchdog.md:3`–`:5`: 리뷰어 모델을 세션에 부착, 자체 툴(기본 `read/grep/glob`, `WATCHDOG.yml`로 mutating 툴 허용 가능·세션 approval 준수)로 워크스페이스 조사 후 1차 세션에 조언 주입. 승인권/상태변경권 없음. 구현 `src/advisor/` 10파일 (`runtime.ts` 1,677).

## 6. 자기개선/학습 레이어 (존재함)

1. **autolearn** `src/autolearn/controller.ts:1`–`:12`: 세션 이벤트 구독, 유의미한 턴 후 합성 capture 턴 자동 실행(패시브 모드는 프롬프트 캐시 중립 — 숨은 리마인더 미삽입). 트리거 `DEFAULT_MIN_TOOL_CALLS=5` (`:21`, 설정 키 `autolearn.minToolCalls` `:114`). `autolearn/managed-skills.ts:1`–`:9`: **자동 생성/보강 SKILL.md**를 `~/.omp/agent/managed-skills`(유저 작성 `~/.omp/agent/skills`와 분리)에만 기록, provider id `omp-managed` (`:17`), 본문 상한 64,000 bytes (`:20`).
2. **learn 툴** `src/tools/learn.ts:9`–`:18`: `{memory, context?, skill?{action:create|update,name,description,body}}` — 교훈을 장기 메모리에 저장 + 동일 호출로 managed skill 생성/보강. 게이트 `autolearn.enabled` + 활성 메모리 백엔드 (`:22`–`:28`).
3. **manage_skill 툴** `src/tools/manage-skill.ts:14`–`:20`: `create|update|delete` (managed 디렉터리 한정).
4. **메모리 파이프라인**: local 2단계 요약(§3), mnemopi 통합/중복병합, hindsight mental model 자동 리프레시(`hindsight/mental-models.ts:5`–`:7`: 생성 시 백그라운드 reflect, consolidation 시 `refresh_after_consolidation:true` 자동 갱신; 시딩 `hindsight/seeds.json`, 기존 모델 미변경 `:20`–`:21`), sharpshooter `{extract,consolidate,scheduler,queue}.ts` 델타→통합.
5. **advisor 트랜스크립트 기록** `advisor/transcript-recorder.ts`.

→ 3축 = (a) 메모리 4백엔드, (b) 스킬 자동 저작(autolearn/learn/manage_skill), (c) 조언자 루프. 하네스 **코드 자체**를 수정하는 기제는 확인되지 않음(미확인).

## 7. 모델 연결성 — packages/ai (108,502 lines)

- 프로바이더: `src/providers/` 55파일, `src/registry/` 85파일(프로바이더 1개 = 선언 1파일 패턴: `anthropic.ts`, `amazon-bedrock.ts`, `cursor.ts`, `cline-pass.ts`, `cloudflare-ai-gateway.ts` …). 카탈로그 `packages/catalog/src/models.json` 12,030,881 bytes / 최상위 키 66.
- **dialect 11종** `packages/catalog/src/identity/dialect.ts:3`–`:14` `glm, hermes, kimi, xml, anthropic, deepseek, harmony, qwen3, gemini, gemma, minimax`; 폴백 `FALLBACK_DIALECT="xml"` (`:16`), 매핑 `preferredDialect()` (`:18`). 구현 `packages/ai/src/dialect/` (방언별 `.ts`+`.md` 11세트 + `factory/coercion/demotion/history/inventory/owned-stream/thinking/rendering/fenced-thinking/thinking-fence-strip`), 배럴 `dialect/index.ts:1`–`:15` (`rendering`은 의도적 배럴 제외 `:9`–`:12`).
- **auth-storage** `src/auth-storage.ts` **6,934 lines**: `AuthCredentialStore` 인터페이스 + `AuthStorage` 클래스 (`:5`–`:8`). 다계정 풀 라운드로빈(`:1299` provider:type별 next index, 키 `"anthropic:oauth"`/`"openai:api_key"` `:1720`,`:1726`), 세션 스티키(`SESSION_STICKY_CACHE_PREFIX="session:sticky:"` `:93`; sessionId 있으면 스티키·없으면 라운드로빈 `:1749`), 랭킹 전략 `CredentialRankingStrategy` + `DEFAULT_RANKING_STRATEGIES` (`:1107`), 사용량 한도·OAuth 리프레시 통합. 백엔드 `src/auth/sqlite-credential-store.ts`.
- 재시도: `auth-retry.ts` (440, `ApiKeyResolver`) 401/한도초과 시 형제 크레덴셜 회전. `oneshot-retry.ts` (235) 루프 외 단발 완성용 — 근거 `:6`–`:29`(streamSimple은 auth만 재시도, 트랜지언트는 `stopReason:"error"` 해결메시지로 넘겨 `TurnRecovery`가 소유; 부작용 없는 oneshot은 전체 재발행이 안전). 기본 `maxAttempts 3`, `baseDelayMs 500`(2배), `maxDelayMs 30_000` (`:31`–`:41`).
- 사이드카: `auth-broker/` 9파일 — 브로커 호스트 SQLite를 감싼 REST(스냅샷 pull/refresh/disable) + 만료 임박 백그라운드 리프레시, 전송 보안은 운영자(Tailscale/Wireguard) 위임 + 요청별 bearer allow-list (`auth-broker/server.ts:1`–`:11`). `auth-gateway/` 4파일 — **임의 프로바이더 포맷 in/out 번역 게이트웨이** (`auth-gateway/server.ts:1`–`:19`): `/healthz`, `/v1/usage`, `/v1/credentials/check`, `/v1/models`, `POST /v1/chat/completions|/v1/messages|/v1/responses`. 컨테이너에 키를 넣지 않기 위한 장치(소비처 `packages/metaharness/src/runner.ts:6`–`:11`).
- 사용량: `src/usage.ts` (427) 정규화 — `UsageUnit` 8종(`:9`), `UsageStatus` 4종(`:11`), `UsageWindow{id,label,durationMs,resetsAt,resetLabel}` (`:14`–`:29`); 프로바이더 어댑터 `src/usage/` 19파일(claude, openai-codex, cursor, github-copilot, google-antigravity, kimi, minimax-code, zai, ollama, devin, umans, synthetic, xai-oauth …). 집계·DB는 별 패키지 `packages/stats/src/`.
- 스트림 코어 `src/stream.ts` (2,428), `provider-details.ts` (90), 에러 분류 `src/error/`(rate-limit/gateway).

## 8. 런타임/툴체인 & 배포

- **Bun 의존**: `rg -o 'Bun\.' packages/*/src -g '*.ts'` = **1,282회 / 426파일** (테스트 포함 전체 트리 6,518 / 1,247). src 기준 패키지별: coding-agent 903(313), ai 114(30), utils 87(27), tui 56(13), metaharness 26(8), catalog 26(6), mnemopi 12(7), agent 9(5), hashline 8(3), snapcompact 1(1). API 상위: `Bun.file` 307, `env` 190, `write` 138, `sleep` 112, `hash` 96, `spawn` 59, `stringWidth` 44, `Glob` 39, `deepEquals` 26, `SHA` 24, `Image` 21, `CryptoHasher` 16, `randomUUIDv7` 15, `serve` 13, `color` 13, `resolveSync` 11, `stripANSI` 10, `JSONL` 10, `Server` 8, `WebSocket` 7. 추가 결합: `with { type: "text" }` 텍스트 임포트 **337회**, `from "bun"` 93회 (예 `autolearn/managed-skills.ts:14` `import { YAML } from "bun"`), `bun:sqlite` 3지점(`src/memories/index.ts:1`, `packages/metaharness/src/store.ts:10`, `metaharness/src/tb/store.ts:1`). `packages/coding-agent/package.json` `engines:{bun:">=1.3.14"}`.
- **pi-natives(Rust napi)**: `crates/` 9종 — `pi-natives`(바인딩), `pi-shell`(brush), `pi-builtins`(uutils), `pi-ast`, `pi-walker`, `pi-vcs`, `pi-iso`(COW FS), `pi-voice`, `vendor`. `packages/natives/package.json` description: "PDF conversion, audio, WebRTC, grep, clipboard, image processing, syntax highlighting, PTY, and shell operations via N-API"; exports `.`/`./desktop`/`./clipboard`/`./vcs`; 빌드 Bazel(`bun scripts/bazel-natives.ts host --dest native`, `MODULE.bazel`/`BUILD.bazel`).
- coding-agent 런타임 의존성 25개: 워크스페이스 12종(hashline, omp-stats, omptype, pi-agent-core, pi-ai, pi-catalog, pi-mnemopi, pi-natives, pi-tui, pi-utils, pi-wire, snapcompact) + `@babel/parser` + OpenTelemetry 11종 + `puppeteer-core`.
- **경로** `packages/utils/src/dirs.ts`: `APP_NAME="omp"` (`:21`), `CONFIG_DIR_NAME=".omp"` (`:24`), env 오버라이드 `PI_CONFIG_DIR` (`:282`), 프로필 `~/.omp/profiles/<name>` (`:330`), XDG 플래트닝(`:368` `~/.omp/agent/sessions → $XDG_DATA_HOME/omp/sessions`).
- `~/.omp/`: `logs/omp.YYYY-MM-DD.PID.log`(`:591`–`:593`), `reports/`(`:581`), `plugins/{node_modules,package.json,omp-plugins.lock.json}`(`:597`,`:613`,`:618`,`:623`), `remote/`(`:628`), `wt/<segment>`(`:672`,`:732`), `ssh-control/`(`:680`), `remote-host/`(`:685`), `python-env/`(`:690`), `python-gateway/`(`:695`), `puppeteer/`(`:700`), `browser-relay/`(`:705`), `autoqa.db`(`:715`), `gpu_cache.json`(`:737`), `cache/github-cache.db`(`:743`), `last-changelog-version`(`:842`).
- `~/.omp/agent/`: `sessions/`(`:871`), `blobs/`(`:876`), `themes/`(`:881`), `tools/`(`:886`), `commands/`(`:891`), `prompts/`(`:896`), `modules/`(`:901`), `memories/`(`:906`), `terminal-sessions/`(`:911`), `omp-crash.log`(`:916`), `omp-debug.log`(`:921`), `secret-placeholder.key`(`:945`), `mcp.json`(`:1014`), `ssh.json`(`:1022`), `cache/{tiny-models,document-conversions,composer}`(`:857`,`:862`,`:866`), `managed-skills/`(`src/autolearn/managed-skills.ts:5`). 프로젝트 스코프 `.omp/`(`:572`–`:574`) — 레포 실측 `.omp/{commands, skills, tools}`.
- **설치** `scripts/install.sh` (334): 원라이너 `curl -fsSL https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.sh | sh` (`:5`). (a) 기본 = GitHub Releases 단일 바이너리 `omp-${PLATFORM}-${ARCH}` (`:238`; linux/darwin × x64/arm64, musl 감지 `:235`–`:239`) + `omp --version` 스모크 검증 (`:276`). (b) `--source` = bun 설치(`:156`–`:166`, 없으면 `curl -fsSL https://bun.sh/install`) 후 `bun install -g packages/coding-agent` (`:203`/`:208`); 최소 `MIN_BUN_VERSION="1.3.14"` (`:16`). Windows `scripts/install.ps1`. CLI 엔트리 `packages/coding-agent/package.json` `bin:{omp:"src/cli.ts"}`.

## 9. 평가 — packages/metaharness (3,832 + tb)

- **kind 3종** `store.ts:19` `"harbor" | "edit" | "snapcompact"`. 정의 `benchmarks.ts:23`–`:44`: harbor(`success_rate`), edit("TypeScript edit": `task_success_rate`,`edit_success_rate`), snapcompact(`f1`,`exact_match`). 메트릭 스키마 `MetricDefinition{key,label,format:"percent"|"number"|"usd",higherIsBetter}` (`:8`–`:13`); 트레이스 `BenchmarkTrace` (`:48`): `status:"pass"|"fail"|"error"|"running"` (`:51`), `reward:number|null` (`:52`), `costUsd/durationMs/detail/tracePath`. 설계 의도 "storage and UI do not hard-code benchmark semantics" (`:5`).
- **러너** `runner.ts` (1,730, `#!/usr/bin/env bun` `:1`): Harbor(`harbor run`)를 로컬 omp 빌드로 구동, 커스텀 에이전트 `agent/omp_local.py`, 작업트리를 `/work/pi`에 설치, **모든 모델 인증을 호스트 pm2 auth-gateway로 라우팅해 컨테이너에 키 미투입** (`:6`–`:11`); Harbor 출력은 로그로 리다이렉트하고 자체 라이브 대시보드(진행/성공률/지출/토큰/ETA) 렌더 (`:12`–`:15`); 게이트웨이 URL `http://host.docker.internal:4000` / vmnet `192.168.64.1:4000` (`:37`–`:39`).
- **서버/대시보드** `server.ts` (785): REST+SSE+정적 웹+런처(러너를 관리 자식으로 spawn). 엔드포인트 `:8`–`:24` — `/api/experiments`(GET/POST), `/api/experiments/:id`(GET/PUT/DELETE), `/api/experiments/:id/arms`(POST=비교 arm), `/api/runs`(GET/POST), `/api/runs/:name`(+`/cancel`,`/resume`,DELETE), `/api/runs/:name/traces/:trace`, `/api/events`(SSE). UI `src/web/{app.tsx,index.html}`.
- **arm/experiment 규약** `experiments.ts`: `experimentOf(jobName)`=첫 `-` 앞 토큰 (`:58`–`:62`), `armOf`=접두사 제거 나머지 (`:64`–`:68`), 재실행 접미사 `RERUN_SUFFIX=/-(fix|backfill|refill|retry|rerun|bf)\d*$/i` (`:246`) → `canonicalArmOf()` (`:249`), 병합 `pickMergedTrials()` (`:270`: pass/fail이 error/running보다 우선, 동급이면 최신 승). `ExperimentDetail{id,goal,arms,tasks,matrix: arm→task→{status,reward}}` (`:48`–`:57`).
- 부속: `store.ts` (587, `bun:sqlite` `:10`), `launch-args.ts` (84), `src/tb/{agent,cli,dataset,store,trial,types,vmon}.ts`(원격 VM `Sandbox` 트라이얼), `src/adapters/snapcompact.py`. edit 벤치 본체는 별 패키지 `packages/typescript-edit-benchmark`.

## (a) omp의 가장 특징적인 아키텍처 선택 5

- **셸을 프로세스가 아니라 라이브러리로 갖는다** — bash 툴이 `/bin/bash`를 spawn하지 않고 Rust `brush-core`를 in-process 실행, uutils 빌트인·출력 minimizer·PTY까지 네이티브 경계 안 (`src/exec/bash-executor.ts:7`, `crates/pi-shell/Cargo.toml:16`–`:18`).
- **steering/aside/follow-up 3중 큐 + 3층 abort 신호로 "부작용 있는 툴은 절대 죽이지 않는다"는 불변식**을 루프에 못박음 (`agent-loop.ts:2336`–`:2352`, `packages/agent/src/types.ts:236`–`:303`); peek/dequeue 분리로 abort 창에서도 큐 무손실 (`agent-loop.ts:1503`–`:1509`).
- **컴팩션이 5전략 다형이고 그 중 하나는 히스토리를 PNG로 렌더** (`compaction.ts:169`, `packages/snapcompact/src/snapcompact.ts:1`–`:8`); 프로바이더별 프레임 shape를 eval로 확정, LLM 호출 0.
- **TTSR — 스트리밍 중간에 규칙을 매칭해 생성을 끊고 규칙 주입 후 재시도** (`docs/ttsr-injection-lifecycle.md:3`, `capability/rule.ts:26`–`:34`); 툴이 `matcherEntries`로 부분 스트림의 파일별 델타를 노출해 경로 스코프 규칙이 성립 (`packages/agent/src/types.ts:836`).
- **요청 바이트 프리픽스 안정화 2축** — `loadMode:discoverable`+`xd://` 가상 장치로 스키마를 요청에서 빼고 (`tools/xdev.ts:1`–`:25`, `tools/essential-tools.ts:24`), append-only 컨텍스트로 프리픽스를 동결 (`packages/agent/src/append-only-context.ts:27`–`:31`).
- (보너스) **크레덴셜 사이드카 분리** — auth-broker(REST 스냅샷)+auth-gateway(프로토콜 번역)로 컨테이너·벤치에 프로바이더 키 미투입 (`packages/ai/src/auth-broker/server.ts:1`–`:11`, `auth-gateway/server.ts:1`–`:19`, 소비처 `metaharness/src/runner.ts:6`–`:11`).

## (b) 컴포넌트 다이어그램 (텍스트)

```
[BOX] CLI/TUI        packages/coding-agent/src/cli.ts + packages/tui
[BOX] AgentSession   coding-agent/src/session/agent-session.ts (10,230)
[BOX] Agent          agent/src/agent.ts (1,779)
[BOX] agentLoop      agent/src/agent-loop.ts (3,010) — 코어 runLoopBody :1025-1563
[BOX] Compaction     agent/src/compaction/* (6,297) + packages/snapcompact
[BOX] ToolRegistry   coding-agent/src/tools/{builtin-names,index}.ts (29 + 3 hidden)
[BOX] ExecEngine     coding-agent/src/exec/bash-executor.ts → pi-natives(Shell/PtySession)
[BOX] EditEngine     packages/hashline + coding-agent/src/edit/*
[BOX] Extensibility  hooks(28) / extensions / custom-tools / skills / slash(83) / MCP / xd://
[BOX] TaskSubagents  coding-agent/src/task/* (23,466) + pi-iso COW worktree
[BOX] MemoryBackends memory-backend/resolve.ts → {hindsight|mnemopi|sharpshooter|local|off}
[BOX] SelfImprove    autolearn(controller+managed-skills) / learn / manage_skill / advisor
[BOX] pi-ai          packages/ai (providers 55, registry 85, dialect 11)
[BOX] pi-catalog     packages/catalog (models.json 12MB, 66 providers)
[BOX] AuthStorage    ai/src/auth-storage.ts (6,934) + auth/sqlite-credential-store
[BOX] AuthBroker     ai/src/auth-broker (REST sidecar)   [BOX] AuthGateway ai/src/auth-gateway
[BOX] pi-natives     crates/{pi-natives,pi-shell,pi-builtins,pi-ast,pi-walker,pi-vcs,pi-iso,pi-voice}
[BOX] Stats          packages/stats     [BOX] Metaharness packages/metaharness + typescript-edit-benchmark

CLI/TUI --prompt--> AgentSession --AgentLoopConfig--> Agent --> agentLoop
AgentSession --beforeToolCall/afterToolCall(:1534,:1538)--> agentLoop
AgentSession --getSteering/hasSteering/getAside/getFollowUp--> agentLoop
AgentSession --TTSR(ttsr-coordinator)--> [스트림 중단·규칙주입·재시도] --> agentLoop
agentLoop --transformContext/convertToLlm/appendOnlyContext--> pi-ai.streamSimple
pi-ai.streamSimple --getApiKey(ApiKeyResolver)--> AuthStorage --> {SQLite store | AuthBroker REST}
pi-ai --model 조회--> pi-catalog
pi-ai.dialect --in-band tool prompt/history 인코딩--> agentLoop(prepareProviderCall :1626)
agentLoop --executeToolCalls(:2305)--> ToolRegistry --> {ExecEngine, EditEngine, Task, MCP, xd:// devices}
ExecEngine --napi--> pi-natives(Shell/PtySession/minimizer)
EditEngine --napi--> pi-natives(diffLineRuns/nodeChainAt/enclosingBlockBoundaries)
Task --COW worktree--> pi-iso --merge back--> parent repo
AgentSession --shouldCompact/compact--> Compaction --> {context-full,handoff,shake,snapcompact,off}
Compaction(snapcompact) --renderSnapcompactPng(napi)--> PNG frames --preserveData 재부착--> agentLoop
AgentSession --beforeAgentStartPrompt/buildDeveloperInstructions--> MemoryBackends
SelfImprove(autolearn/learn) --write--> ~/.omp/agent/managed-skills --discover--> Extensibility.skills
SelfImprove(advisor) --advice--> AgentSession (aside/steering 주입)
pi-ai.usage --> Stats(DB/aggregate) --> CLI/TUI, AuthGateway /v1/usage
Metaharness.runner --spawn omp(container)--> AuthGateway(:4000) --> providers
Metaharness.runner --trials/result.json--> store(bun:sqlite) --> server(REST+SSE) --> web/app.tsx
```

## RECONFIRM 근거 (사실만, 판정 없음)

- **R7(Bun)**: src 기준 `Bun.` 1,282회/426파일. 구조적 API 분포 — `serve` 13, `Server` 8, `WebSocket` 7, `Image` 21, `spawn` 59, `Glob` 39, `JSONL` 10, `stringWidth` 44, `color` 13, `resolveSync` 11. Bun 전용 문법 결합: `with { type: "text" }` 337회, `from "bun"` 93회, `bun:sqlite` 3지점(§8). `engines.bun>=1.3.14` (`packages/coding-agent/package.json`), 루트 `packageManager: bun@1.4.0`. 설치 기본 경로는 bun-컴파일 단일 바이너리(`scripts/install.sh:238`,`:276`)이고 bun 런타임 요구는 `--source` 경로만(`:203`).
- **R6(natives)**: 하네스 핫패스가 napi에 직접 묶인 지점 — bash 실행(`exec/bash-executor.ts:7`), snapcompact 렌더(`packages/snapcompact/src/snapcompact.ts:50`), 서브에이전트 격리(`task/isolation-runner.ts:22`–`:23` `pi-natives/vcs`), hashline 구문경계(선행문서 `docs/analysis/omp.md` §4).
- **D3/R3 관련**: 코딩 트랙 접지 신호는 `BenchmarkTrace.status`(`benchmarks.ts:51`)와 `reward:number|null`(`:52`)로 이미 정규화; arm 등록은 job-name 규약(`experiments.ts:58`,`:64`)만으로 성립하고 추가 코드 불요. `kind:"edit"` 메트릭은 `task_success_rate`/`edit_success_rate` 2종(`benchmarks.ts:31`–`:35`).
- **샌드박스**: OS 레벨 격리 기제는 코드베이스에서 확인되지 않음(bwrap/seccomp/landlock 히트 없음 — §2). 격리는 COW 파일시스템(`crates/pi-iso`) + git worktree + 컨테이너(`Dockerfile`) 조합.
