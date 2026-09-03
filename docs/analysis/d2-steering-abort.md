# D2 — steering 3중 큐 · 3층 abort: omp 대비 분석과 evopi 적용 경로 (2026-09-03)

> 출처: NS Phase 분석 워크플로(omp/prime 리더 2 + 합성). 결정: DECISIONS.md M24 (경로 (b)+(a), abort 후 자동 재개, 순수 대기 툴만 interruptible, 상류 PR 2단계).


전제(검증): evopi `packages/agent/src/agent-loop.ts`는 prime 사본과 `diff` 결과 14행 import 지정자(`@evopi/pi-ai`)만 다름(963행). omp 루프는 3010행. 로드맵 상태는 `docs/design/NEXT-STEPS.md:48`(트랙 D 표), `:79`(보류), `docs/design/DECISIONS.md:850`, `REVIEW.md:794`. 주의: `DECISIONS.md:13`의 "D2"는 코드 실행 엔진 결정으로 별개 항목.

## 1. omp 메커니즘 요약

**3중 큐** (모두 Agent 소유, 루프는 config 콜백으로만 접근)
- steering: `oh-my-pi/packages/agent/src/agent.ts:374`, `steer()` :995-998(waiter 깨움). 소비 지점은 3곳뿐 — 루프 시작 `agent-loop.ts:1067`, 매 턴의 툴 배치 완료 후 `:1509`, yield 직전 lateSteering `:1538`. 외부 abort 중에는 드레인하지 않음(`:1503-1509` 주석: "abort then continue"). one-at-a-time 기본(`agent.ts:467`, `:1055-1067`).
- follow-up: `agent.ts:375`, `:1004-1006`; 루프가 멈추려는 지점 `:1540`에서만 폴링(`types.ts:281-288`).
- aside: `types.ts:289-299`("NEVER abort in-flight tools"), 공급자 `agent.ts:896-898`, 폴링 `:1512`(mid-work)와 `:1539`(yield). IRC 인터럽트는 세션 소유 4번째 큐로 루프는 peek만(`:2401-2414`).

**3층 abort** (`executeToolCalls`, `agent-loop.ts:2336-2352` — NEXT-STEPS가 인용한 바로 그 구간)
- L1 외부 run signal(`signal`): 스트림·모든 툴 종료. `Agent.abort(reason)` `agent.ts:1103-1105` → `abortReasonText` `:2105-2114`로 errorMessage 전파.
- L2 `steeringAbortController`(:2336)+`ircAbortController`(:2337) → `interruptibleSignal = AbortSignal.any([...])`(:2350-2352). `tool.interruptible`(bool|fn) 인 툴에만 전달(:2368-2387; `types.ts:786-796`). 실제 대상: hub wait/logs --follow(`tools/hub/index.ts:175-178`), vibe(`tools/vibe.ts:158`).
- L3 `steeringSoftController`(:2343) → `ToolCallContext.steeringSignal`(:2601, `types.ts:545-561`) 협력 신호. bash/eval이 이를 보고 자동 백그라운드(`tools/bash.ts:1075-1102`, `async/auto-background.ts:37-50`).

**중간 감지**: `checkSteering`(:2416-2454)은 비소비 peek(`hasSteeringMessages`, `agent.ts:1494-1514`), 매 툴 종료 후(:2713) + 이벤트 워처/250ms 타이머(:2726-2775, `:159`). 감지 시 미시작 툴 skip(:2507-2515) → tail sweep에서 "Skipped due to queued user message…" 합성 결과(:2814-2823, :2980-3010). interruptMode 'wait'면 전부 비활성(:2335).

**abort 후 정합성**: 부분 텍스트 유지 + 미완성 toolCall 블록 제거(`retainCompletedToolCalls` :1985) + 남은 toolCall마다 placeholder toolResult(:1314-1336). 세션은 `abort({reason:'Interrupted by user'})`(`session/messages.ts:469`, `input-controller.ts:252-254`) 후 `#drainStrandedQueuedMessages`(`agent-session.ts:835-862`)로 큐를 자동 재개.

## 2. evopi/prime 현재 상태

- 루프 폴링: steering `agent-loop.ts:314`(시작), `:397-410`(턴 = LLM 응답 + **전체 툴 배치** 종료 후); follow-up `:414-426`; continuation `:429-443`. 툴 사이 폴링·peek·interruptMode·aside·onBeforeYield 없음(`types.ts:118-273` 필드 목록 확인).
- abort 1층: 툴에는 항상 run signal 하나(:838). `raceWithAbort`는 툴 promise를 버림(:48-56). 순차 모드는 abort 시 잔여 툴을 결과 없이 break(:619-621, :656-658); 병렬 모드는 prepare 전부 → execute 전부(:677-712)라 각 툴이 "Tool execution aborted"(:874-879). aborted 턴은 placeholder 없이 `turn_end{toolResults:[]}`(:343-347), errorMessage 고정 "Request was aborted"(:28, :132-147). `Agent.abort()`는 reason 인자 없음(`agent.ts:319-321`).
- 세션: steering을 **stop-and-restart**로 구현. `_actionStore` 주석 "never fed into Agent.steer/followUp"(`core/agent-session.ts:1065`); `this.agent.steer(` 호출 0건, `followUp`은 `:7832`(컴팩션 후 재큐)만. `_steeringStopPending`(:2197-2208)이 `shouldStopBeforeTurn/AfterTurn`(:1496-1497, :2210-2212, :2246)으로 run을 끝내고, 펌프가 `waitForIdle`(:5721) 후 `agent.prompt()`(:6068-6069)로 새 run 시작. 즉 steer마다 agent_end/agent_start 쌍·turnIndex 리셋·before_agent_start 재실행(추론: 제어 흐름 기반).
- abort: `requestAbort`(:6970-6997)가 펌프 중단(:6975-6977), 가시 큐 보존(:6980-6986), `agent.abort()`(:6996). 연결층은 `session.requestAbort()`만 호출(`in-process-agent-connection.ts:421-423`). 재개는 `resumeQueuedWork`(:6853-6858) = 다음 submit/큐 편집 시(interactive-mode.ts:6790-6791).
- 사용 가능한 seam(검증): sdk streamFn의 provider 전용 signal 합성(`core/sdk.ts:303-308`), `wrapToolDefinition`(`tool-definition-wrapper.ts:16-17`, 5번째 ctx 인자 주입 가능; ipython은 이미 `ctx` 선언 `ipython.ts:634`, `executionMode:'sequential'` :632), beforeToolCall/afterToolCall(:1440-1489; **terminate가 세션에서 탈락** :1483-1487), `agent.toolExecution` 공개 필드(세션은 :9565에서 읽기만).
- 미검증: 순차 모드 abort로 남는 고아 toolCall을 세션이 보정하는지(`core/messages.ts`, `agent-session.ts` grep에서 관련 처리 없음).

## 3. 갭 표

| 항목 | omp | evopi/prime | seam으로 가능? |
|---|---|---|---|
| steer 주입 시점 | 배치 종료 직후, run 유지(:1509) | run 종료 후 재프롬프트(:2246→:6068) | 가능(`agent.steer()` → 루프 :397) |
| 배치 중 미시작 툴 skip | :2507-2515 | 없음 | 순차 모드만(wrapper/beforeToolCall) |
| 병렬 배치 형제 skip | 가능 | 불가(:677-712) | **불가** |
| 순수 대기 툴 hard abort(L2) | :2350-2387 | 없음 | wrapper에서 `AbortSignal.any` 합성 가능 |
| 협력 steeringSignal(L3) | :2601 | 없음 | wrapper 5번째 ctx로 가능 |
| 비소비 peek/이벤트 wake | :2416-2454 | 없음 | 루프 외부에서만(세션 플래그) |
| abort reason 라벨 | `abort(reason)` | 고정 문구(:28) | UI 표시만(:5585-5591), 영구 메시지는 불가 |
| aborted 턴 placeholder | :1314-1336 | 없음(:343-347) | 세션이 agent_end 후 transcript 보정 |
| abort 후 큐 자동 재개 | :835-862 | 펌프 중단(:6975) | 정책 변경으로 가능 |
| aside 큐 | :1512/:1539 | 없음 | steer 큐에 태워 근사(루프 내 구분 불가) |

## 4. 구현 경로 3안

**(a) prime 상류 제안.** prime에 필요한 최소 API(omp 계약 그대로 인용 가능): ① `AgentLoopConfig.hasSteeringMessages` + `waitForSteeringMessages` + `interruptMode`(`oh-my-pi types.ts:262-306`, :155); ② `AgentTool.interruptible` + 툴별 signal 분기(:2349-2387); ③ `AgentTool.execute` 5번째 `ToolCallContext{steeringSignal}` 또는 `config.getToolContext`(:2595-2603); ④ 미시작 툴 skip + 합성 결과(:2507-2515, :2814-2823, :2980-3010); ⑤ `Agent.abort(reason)` + `abortReasonText`(:2105-2114); ⑥ aborted 턴 placeholder(:1314-1336) 및 순차 모드 break 시 placeholder 방출. ⑤⑥은 미사용 시 동작 불변이라 1차 PR로 분리 권장. 실현성: prime 루프가 963행으로 작아 patch 자체는 명확하나 수용 일정은 통제 불가. 파급: evopi 0(수용 후 coding-agent만 수정). 얻는 것: omp와 동일 계약 → omp extension/툴 호환.

**(b) sdk/agent-session 에뮬레이션(골격 무수정).** 가능: (b1) next_turn_boundary 액션을 `agent.steer()`로 라우팅 → 루프 :397에서 run 유지 주입(omp 'wait' 모드와 동치). ActionStore 티켓/큐 UI 동기화를 세션이 병행 처리해야 함(추론). (b2) wrapper(`tool-definition-wrapper.ts:16-17`)에서 세션 소유 "steer pending" 컨트롤러를 만들어, 순수 대기로 표시한 툴에는 `AbortSignal.any([signal, steerSignal])`, 모든 툴에는 ctx.steeringSignal 전달 → L2/L3 재현. 툴이 throw하면 루프 :868-879가 툴 자체 메시지로 error 결과 기록, run은 계속. (b3) 순차 모드에서 execute 진입 시 steer pending이면 "Skipped due to queued user message" 합성 결과 즉시 반환, 혹은 beforeToolCall block(:791-811). (b4) `terminate` 노출(:1483-1487 한 줄) → 배치 조기 종료 → :397 주입. (b5) abort 후 자동 재개 정책, UI 라벨. 불가: 같은 배치 툴 사이 메시지 주입, 병렬 형제 skip, 이벤트 wake, 영구 메시지의 abort 라벨, 루프 내 placeholder. streamFn signal 합성(`sdk.ts:303-308`)으로 provider만 중단하는 것은 가능하지만, prime :343-347이 aborted stopReason에서 run을 끝내므로 dialect 패턴(:337-339)처럼 wrapper가 `done`을 위조해야 하며 권장하지 않음. 파급: coding-agent 내부 5~7파일. 얻는 것: 사용자 체감 갭의 대부분(장기 ipython 중 steer 지연·run 재시작 오버헤드).

**(c) packages/agent 로컬 포크.** omp `executeToolCalls`는 509행, prime은 346행. 최소 이식 추정 250~350행(agent-loop +150~250, agent.ts +~50, types.ts +~40; 추정치). 기존 `packages/agent/test/agent-loop.test.ts:112-269`의 abort 테스트를 유지해야 함. 유지비: prime 동기화마다 3-way merge, 골격 무수정 원칙(`DECISIONS.md:850`) 폐기. 얻는 것: omp와 완전 동치. 권장하지 않음.

## 5. 권고 및 단계 계획

권고: **(b)를 먼저, (a)를 병행 제출, (c)는 보류.**
- Phase 0(무위험): UI abort 라벨 통일(:5585-5591), 순차 모드 고아 toolCall 보정 여부 확인 및 필요 시 세션 보정, abort 후 자동 재개 정책 결정.
- Phase 1: (b1) `agent.steer()` 라우팅 + ActionStore 미러링. 테스트: 툴 배치 중 steer → agent_start 1회, 다음 모델 호출 전 user 메시지 삽입; 기존 `agent-session-queue-mutation.test.ts`, `interactive-queue-edit.test.ts` 회귀.
- Phase 2: (b2~b4) wrapper L2/L3 + 순차 skip + terminate 노출. 테스트: 장기 ipython 중 steer → 다음 ipython 호출이 합성 skip 결과; interruptible 마킹 툴 abort 후 run 지속; 병렬 배치는 skip되지 않음(문서화된 한계).
- Phase 3: (a) PR 2건(⑤⑥ 먼저, ①~④ 후속) 제출; 수용 시 wrapper 코드를 루프 계약으로 치환.

## 6. 오너 결정 사항

```json
{"userDecisions":[
{"id":"D2-1","question":"D2 구현 경로를 무엇으로 확정할까?","options":[{"label":"(b) 세션/sdk 에뮬레이션 우선 + (a) 상류 제안 병행","description":"골격 무수정 유지. 배치 사이 주입·L2/L3·순차 skip 확보, 병렬 형제 skip은 상류 수용까지 미지원"},{"label":"(a) 상류 제안만","description":"수용까지 D2 보류 유지, 사용자 체감 개선 지연"},{"label":"(c) packages/agent 포크","description":"omp 동치 확보, 250~350행 이식 추정 + prime 동기화마다 3-way merge"}],"recommendation":"(b)+(a) 병행"},
{"id":"D2-2","question":"steer 의미론을 stop-and-restart(현행)에서 run 유지 주입(agent.steer → 루프 :397)으로 바꿀까?","options":[{"label":"run 유지 주입","description":"agent_end/agent_start 쌍·turnIndex 리셋·before_agent_start 재실행 제거. ActionStore 티켓 미러링 필요"},{"label":"현행 유지","description":"확장 이벤트 순서 불변, 지연 유지"}],"recommendation":"run 유지 주입(Phase 1)"},
{"id":"D2-3","question":"Esc/Ctrl+C abort 후 보존된 steering/follow-up을 omp처럼 자동 재개할까?","options":[{"label":"자동 재개(omp 방식)","description":"requestAbort의 펌프 중단(:6975-6977)을 abort 정착 후 resumeQueuedWork로 전환"},{"label":"수동 재개(현행)","description":"다음 submit/큐 편집 시 재개(:6790-6791)"}],"recommendation":"자동 재개, 세션 전환 중 abort는 예외"},
{"id":"D2-4","question":"L2 hard abort 대상 툴과 순차 강제 범위는?","options":[{"label":"순수 대기 툴만 interruptible, toolExecution은 기본 parallel 유지","description":"omp 원칙 동일. 병렬 배치 형제 skip 불가를 문서화"},{"label":"toolExecution='sequential' 전역 강제","description":"모든 배치에서 skip 가능하나 병렬성 상실"}],"recommendation":"순수 대기 툴만, parallel 유지"},
{"id":"D2-5","question":"상류 PR 범위와 순서는?","options":[{"label":"2단계: abort(reason)+placeholder 먼저, interrupt 메커니즘 후속","description":"1차는 미사용 시 동작 불변이라 수용 가능성 높음"},{"label":"단일 PR로 omp executeToolCalls 전체 이식 제안","description":"수용 난이도 높음"}],"recommendation":"2단계"}
]}
```
## 7. 구현 상태 (2026-09-03, route (b) 에뮬레이션 — 골격 무수정)

결정 D2-1~D2-5 를 `packages/coding-agent` 안에서만 구현. `packages/agent` 는 0행 변경(검증: 루프 `agent-loop.ts:397` 폴링을 그대로 사용).

| 결정 | 구현 위치 | 동작 | opt-out |
|---|---|---|---|
| D2-2 run 유지 주입 | `core/agent-session.ts` `_trySteerAction`(:2426) — `_admitSessionInput`(:5979)에서 **동기** 호출 → `agent.steer(records)`; `_steeringStopPending`(:2372)이 `steered` 액션을 제외 | 툴 배치 중 steer → `agent_start` 1회, 다음 provider 호출 직전 user 메시지 삽입(루프 :331-336). 액션은 store 에 `queued` 로 남아 큐 UI/편집이 계속 동작; `message_start` 에서 selected→preparing→committing(:3812-3822), `message_end` 에서 running(기존 코드), `agent_end` 후 completed(`_completeSteeredActionsAfterRun` :2482, retry 체인 포함). 미드레인 잔여는 `agent_end` 동기 핸들러(:3802)와 펌프 선택 직전(:6082)에서 `_reclaimUndeliveredSteeredActions` 로 회수 → 레거시 재프롬프트 | `EVOPI_STEER_MODE=restart` (`resolveSteerDeliveryMode` :786) |
| D2-3 abort 후 자동 재개 | `requestAbort(options)`(:7503) → `_scheduleQueuedWorkResumeAfterAbort`(:2531): `agent.waitForIdle` → `_agentEventQueue` 정착 후 epoch/suspend/pause 재확인 → `resumeQueuedWork()` | Esc/Ctrl+C(in-process·daemon 모두 `requestAbort()`) 후 보존된 steering/follow-up 이 자동 드레인. **활성 run 이 있을 때만**(omp `#drainStrandedQueuedMessages` 와 동일 조건) — idle 상태의 `requestAbort()` 는 기존 "펌프 정지" 의미 유지(특성 테스트 `suite/agent-session-queue.test.ts:424`, `:2928`, `suite/agent-session-compaction.test.ts:404` 불변). `abort()`(:7537, 세션 전환/fork/new-session·테스트 경로)는 `resumeQueuedWork:false` 고정 | `EVOPI_STEER_AUTO_RESUME=off` (`resolveSteerAutoResume` :791) |
| D2-4 L2/L3 | `core/tools/tool-definition-wrapper.ts` `ToolSteeringRuntime` + `wrapToolDefinition(definition, ctxFactory, steering)`; 세션 `_toolSteeringRuntime`(:2524)·`_steerPendingController`; `_refreshToolRegistry`(:9609)가 wrapper.ts 대신 직접 `wrapToolDefinitions` 호출 | 모든 툴: `ctx.steeringSignal`(5번째 인자, `extensions/types.ts` `ExtensionContext.steeringSignal`). `ToolDefinition.interruptible`(bool|fn) 툴만 `AbortSignal.any([runSignal, steeringSignal])`. 내장 ipython/hashline_edit 은 비-interruptible. `toolExecution` 기본 parallel 유지 | restart 모드에서는 runtime 자체가 `undefined` → wrapper 바이트 동일 |
| D2-4 미시작 skip | wrapper: `steerPending` 이면 `SteeringSkippedToolError` throw → 루프 :868-879 가 `isError` 결과 기록 (omp `createSkippedToolResult` 문구 동일). `steerPending`(`_isSteerPending` :2507)은 **미러링된(steered) 사용자 메시지만** 계산 — 세션 내부 goal 알림·큐된 세션 커맨드는 skip/L2/L3 를 유발하지 않고 레거시 "배치 후 정지" 경로 유지 | 순차 배치(ipython 포함)에서 steer 이후 미시작 툴은 실행되지 않음. 병렬 배치는 루프가 전 툴을 동시에 시작(:697-713)하므로 **배치 시작 전에 steer 가 있었을 때만** 전부 skip; 이미 시작한 형제는 skip 불가(상류 Stage 2 필요) | restart 모드 |
| D2 UI | `modes/interactive/interactive-mode.ts` `formatAbortedTurnLabel`(:910) — 라이브(:5641)·리플레이(:6657) 공용 | retry 체인 > 구체 사유 > "Operation aborted" | — |
| aborted 턴 placeholder | **이미 처리됨 → 생략.** `packages/ai/src/providers/transform-messages.ts:171-219` 가 모든 provider 경계에서 aborted/error assistant 턴을 제외하고 결과 없는 toolCall 에 `"No result provided"` 합성 결과를 삽입(anthropic.ts:1074, openai-*:116/825, google:113, bedrock:645, mistral:70 에서 호출) | 세션 보정 불필요; 상류 제안(Stage 1b)에서는 opt-in 으로만 제안 | — |
| D2-5 상류 제안 | `docs/design/upstream-proposals/prime-d2.md` | Stage 1(abort(reason)+abortReasonText+opt-in placeholder) / Stage 2(hasSteeringMessages·waitForSteeringMessages·interruptMode·interruptible·ToolCallContext.steeringSignal·skip) | — |

테스트: `packages/coding-agent/test/steering-emulation.test.ts`(13건: 배치 중 steer 단일 run·promptAndWait 완료·interruptible 하드 abort·협력 signal·순차 skip·큐 편집 동기화·abort 자동 재개·AUTO_RESUME=off·abort() 비재개·STEER_MODE=restart·라벨·wrapper seam 2건). 기존 `agent-session-queue-mutation.test.ts`·`interactive-queue-edit.test.ts` 39건 유지.

알려진 한계(문서화): (1) 병렬 배치의 이미 시작한 형제 skip 불가(루프 :697-713). (2) 이벤트 기반 wake 없음 — 툴 시작 시점에만 `steerPending` 평가(실행 중 툴은 signal 로만 감지). (3) 루프가 `getSteeringMessages` 로 드레인한 직후~`message_start` 사이의 극소 창에서 큐 삭제가 들어오면 메시지는 그대로 전달되고 티켓만 취소 오류로 정착(레거시 committing 취소와 동급). (4) 영구 transcript 의 abort 라벨은 루프 고정 문구 유지(UI 라벨만 통일) — 상류 Stage 1a 로 해소. (5) omp 와의 미세 차이: omp 는 워처의 첫 `checkSteering` 이 마이크로태스크 뒤에 돌아 배치의 첫 툴은 보통 시작되지만, evopi wrapper 는 `execute` 진입 시점에 `steerPending` 을 평가하므로 **스트리밍 중에 steer 가 들어온 배치는 첫 툴부터 전부 skip** 된다(사용자 메시지가 먼저 전달되고 모델이 재계획). 의도된 동작이며 `EVOPI_STEER_MODE=restart` 로 회피 가능. (6) 세션 내부 goal 컨텍스트 steer(`budget_limit`, `GOAL_CONTEXT_CUSTOM_TYPE`)는 같은 run 안의 `goal.complete()` 가 `_clearQueuedGoalContexts` 로 회수해야 하므로 미러링 대상에서 제외(`_isSteerableAction`) — stop-and-restart 유지(`suite/agent-session-goal.test.ts:671` 불변).
