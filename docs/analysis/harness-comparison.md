# evopi 핵심 하네스 점검 + 4자 마스터 아키텍처 비교 (2026-09-03)

> 입력: docs/analysis/{evopi-harness-inventory, claude-code-arch, omp-master-arch, prime-master-arch, evo}.md,
> refs/claude-code-8layer-map.md(사용자 제공 슬라이드 전사). 코드 인용은 `파일:라인`. 미확인은 "미확인".
> 산출물: docs/diagrams/evopi-master-arch.{dot,png}, claude-code-master-arch.{dot,png}, docs/seminar/evopi-architecture.pptx

## 0. 한 줄 결론

evopi 는 **prime-agent 의 "단일 툴(ipython) + 파이썬 커널 + continual harness" 골격을 무수정으로 유지**하면서,
omp 자산(dialect·auth-pool·hashline·mnemopi·oneshot-retry)을 `sdk.ts streamFn` 클로저·확장 훅·빌트인 확장이라는
세 seam 에만 끼워 넣었고, Evo-Harness 논문 델타(D1 실패 한정 + D4 접지 피드백)를 `EVOPI_EVO` 게이트 뒤의
optional 레이어로 얹었다. Claude Code 8레이어 맵에 박스 단위로 대응되며, Claude Code 에 없는 **9번째 레이어(EVO)** 를 가진다.
하네스 자체는 건재(tsgo 0, Bun 실코드 0, .omp 0)하나 **커널 env 상속(Q6)·OS 샌드박스 미구현·셀 타임아웃 부재·실 A/B 미실행** 4개 리스크가 남는다.

## 1. evopi 하네스 실측 요약 (inventory 기준)

| 축 | 실측 | 근거 |
|---|---|---|
| 제어 루프 | `agentLoop`(963줄) 무수정; `AgentSession` 11,962줄이 감쌈; streamFn 배선은 `sdk.ts:288-345` | agent-loop.ts:181,304 · sdk.ts:288 |
| 툴 | 등록 툴 = `ipython`(기본, sequential) + `hashline_edit`(선택). TS `bash`/`edit` 정의는 **미등록** | tools/index.ts:59 · ipython.ts:620 |
| 커널 | `spawn(python,["-m","rlm.repl"])` 1곳, 프로토콜 v3, dill 스냅샷 256MB/16MB, boot-gate | repl-manager.ts:252 · state-snapshot.ts:12-14 |
| 컨텍스트 | `buildSystemPrompt` + `formatHarnessStateForPrompt(selectEntries)`; MMR 선택기는 evo/설정 게이트 | system-prompt.ts:117,156 · harness-select.ts:57 |
| 권한 | permission-gate 7패턴 block/warn/off, no-UI 즉시 block; bwrap 은 **프로브만**(래핑 코드 없음) | permission-gate.ts:28-62 · sandbox-probe.ts:46 |
| 확장 | 훅 이벤트 **31종**(types.ts `type:` 리터럴 재집계 — inventory 의 19 는 과소집계), 빌트인 3 | extensions/types.ts · builtin/ |
| 자기개선 | refinement.ts 1,041 + harness.py 820; `session_before_refine` → grounded-refine 3분기 | agent-session.ts:8243-8262 · grounded-refine.ts:191-203 |
| 모델 | 9 API 종 등록, 카탈로그(prime 기준 32 프로바이더 키), OAuth 3, auth.json 1키/프로바이더 + env 풀 | register-builtins.ts:344-400 · auth-pool/env.ts:34 |
| 런타임 | node ≥22.8, Bun 게이트 8 hit 전부 주석, `.prime` 경로 리터럴 2건 = 외부 Prime CLI interop(승인 예외) | inventory §8 |
| 평가 | eval/ bun 격리, 4 arm 정의, **실 실행 SKIP(키 부재)**, 스모크 2종 | eval/RESULTS.md |

**inventory 정정 2건**: (a) 훅 이벤트 수 19→31 (`rg -o '^\s+type: "[a-z_]+"' types.ts | sort -u` = 31 이벤트명).
(b) evopi-runtime 의 `.prime` 잔존 0 — `harness.py` 는 `~/.evopi/agent` 로 개명 완료(`_agent_dir()`).

## 2. Claude Code 8레이어 맵 ↔ evopi 대응

| 레이어 | Claude Code (참조 맵) | evopi | 차이의 본질 |
|---|---|---|---|
| Master Loop | Gather-Act-Verify, Claude 모델 + 도구 | Think → ipython 실행 → Verify, agentLoop + AgentSession | 도구 선택 대신 **코드 작성**이 행동 |
| INPUT | CLI/IDE/CI-CD · Resume/Fork · Ask/Allow/Deny | TUI/print/RPC/ACP/SDK/daemon · jsonl 트리 + dill 복원 · permission-gate | 세션 복원이 커널 변수까지 포함 |
| KNOWLEDGE | CLAUDE.md · Auto Memory · Skills · Compaction | AGENTS.md/SYSTEM.md · Harness 원장 · SKILL.md+pyproject · 요약 컴팩션 + MMR | 메모리가 파일이 아닌 **편집 가능한 구조화 원장** |
| EXECUTION | Tool Dispatch(typed) · Prompt Cache · Streaming | ipython 단일 툴(sequential) · IPython 커널 · streamFn(auth-pool·dialect) | 다수 도구 → 단일 REPL 셀 합성; 툴 병렬 없음 |
| MULTI-AGENT | Subagents(isolated) · Worktrees | `rlm()` 커널 내 호출 → in-process 자식 Agent · Worktrees v2 | 서브에이전트 = Python 함수 호출 |
| OBSERVABILITY | Hooks(lifecycle) · Background | 확장 훅 31 · rlm.bash 핸들/cron/백그라운드 refine | 훅이 refine 플래너까지 교체 |
| INTEGRATION | MCP Runtime · Ext Servers | rlm.mcp(커널 내) · 9 API · pi-natives | MCP 도구도 Python 네임스페이스 |
| OUTPUT | Task Result / Memory updated | Task Result / harness 갱신(refinements.jsonl) | 출력이 다음 편집의 증거 |
| **(+) EVO** | — | autoRefine + grounded-refine(D1·D4) · EVOPI_EVO · metaharness 접지 | Claude Code 에 없는 레이어 |

## 3. 4자 비교 매트릭스 (9축)

| 축 | Claude Code (자료 기준) | oh-my-pi v18.1.2 | prime-agent v0.9.1 | evopi v0.9.6 |
|---|---|---|---|---|
| 1 제어 루프 | Gather-Act-Verify; 독립 도구 병렬 [PDF p.8,30] | agent-loop 3,010줄; 29 툴 shared/exclusive 병렬; steering/aside/follow-up 3큐 + 3층 abort; TTSR | 동일 agent-loop; AgentSession 11,948줄; ipython sequential | prime 루프 무수정; streamFn 에 dialect·pool 삽입 |
| 2 도구/실행 | 5 카테고리 tool_use; Local/Cloud VM/Remote [p.11,22] | 29 빌트인 툴; Rust in-process 셸(brush-core); hashline 편집; xd:// discoverable 장치 | ipython 1툴; IPython 커널 + dill; 셸/편집은 Python 심볼 | 동일 + hashline_edit 선택; natives prebuilt 로더 |
| 3 컨텍스트 | CLAUDE.md 매 턴, MEMORY.md 200줄/25KB, Skills 3단, 자동 압축 [p.13-17,26-27] | AGENTS.md; 메모리 백엔드 4종(hindsight/mnemopi/sharpshooter/local); 컴팩션 5전략(snapcompact PNG); append-only 프리픽스 캐시 | AGENTS.md + Harness 원장(kind별 6개), 요약 컴팩션, compact→refine | prime + MMR 하네스 선택기(문자 예산) |
| 4 권한/안전 | 4 모드, allowlist 계층, 체크포인트 되감기, Hooks 게이트 [p.23,35] | approval allow/deny/prompt × 모드 always-ask/write/yolo; CRITICAL_BASH_PATTERNS; COW worktree(pi-iso) 격리, OS 샌드박스 없음 | 권한 프롬프트; 샌드박스는 예제 확장(bwrap, bash 툴만); 커널 무격리 | permission-gate 내장 + 샌드박스 프로브(D3 폴백); 커널 무격리 동일 |
| 5 확장성 | Skills/MCP/Hooks(14 이벤트)/Subagents/Plugins [p.35,39-40] | 훅 28, 슬래시 83, 커스텀 툴, MCP, Advisor/Watchdog, task 서브에이전트(23k줄) | extensions(jiti) 31 훅, Python 스킬, MCP(커널), rlm() | prime 표면 그대로 + 빌트인 3 |
| 6 자기개선 | MEMORY.md 갱신만; 하네스 자동 정련 **없음** [p.26,42] | **있음** — autolearn(유의미 턴 후 managed SKILL.md 자동 저작), learn/manage_skill 툴, 메모리 4백엔드 통합, advisor. 하네스 코드 수정 기제는 미확인 | continual harness refine (**자가 판단 = Self-Generated**) | prime refine + 접지(D4) + 실패 한정(D1) + MMR |
| 7 모델 연결 | Claude Sonnet/Opus, /model [p.11]; 프로바이더 미기재 | 카탈로그 66 프로바이더(12MB models.json), dialect 11, auth-storage 6,934줄 풀 로테이션, auth-broker/gateway 사이드카 | 9 API, 카탈로그 32, OAuth 3, Bedrock, auth.json 1키 | prime 카탈로그 + 풀 로테이션 + dialect 11 + Databricks |
| 8 런타임/배포 | 미기재 (일반지식: npm CLI) | Bun 전용(src `Bun.*` 1,282회/426파일), Rust napi 9 crate(Bazel), 설치 = GitHub Releases 단일 바이너리 | node + uv Python, install.sh 45KB, R2 | node ≥22, Bun 실코드 0, curl\|sh → GitHub Pages |
| 9 평가 | 미기재; Hooks 로깅, /context | metaharness(harbor/edit/snapcompact) | 없음(autoRefine off 로 대조군만) | metaharness bun 격리 4-arm; 실 실행 SKIP |

**자기개선 축 재판정**: Claude Code = 메모리 파일 갱신만 / omp = 스킬 자동 저작 + 메모리(하네스 원장 없음) / prime = 하네스 원장 편집(자가 판단) / evopi = 하네스 원장 편집 + 외부 접지. 즉 "무엇을 진화시키나"가 파일 → 스킬 → 원장, "무엇으로 판단하나"가 없음 → LLM 자가 → 환경 신호로 갈린다.

## 4. 하네스 점검 — 강점 / 리스크

**강점**
1. 골격 무수정 — prime agent-loop·커널 무변경, 확장은 streamFn/훅/빌트인 seam 에만 (agent-loop.ts diff 0, sdk.ts:288).
2. 대조군 내장 — `EVOPI_EVO=off` 시 확장 미등록 + MMR 비활성 → prime 경로 바이트 동일 (services.ts:177-182, settings-manager.ts:930-960).
3. 접지된 진화 — 논문에서 유일하게 직접 절제 근거(Table 4)가 있는 D4 를 1파일(208줄)로 배선, 안전 구속 SPEC §4:56.
4. 이식 자산 활성 — dialect·auth-pool·mnemopi·hashline·oneshot-retry 전부 소비 배선 완료(M15-M18), 휴면 0.

**리스크**
| # | 심각도 | 내용 | 근거 | 권고 |
|---|---|---|---|---|
| R-1 | 높음 | 커널이 `...process.env` 전체 상속 → API 키가 커널·사용자 코드에 노출 (OPEN-QUESTIONS Q6 미해소) | repl-manager.ts:257 | 커널 spawn env allowlist(EVOPI_*, PATH, HOME, LANG…) + 키 계열 제거 옵션 |
| R-2 | 높음 | OS 샌드박스 미구현 — bwrap 은 프로브만, 래핑은 examples 에만. 집행 계층 = 컨테이너 경계 전제 | sandbox-probe.ts:46 · inventory §4 | 배포 문서에 컨테이너 전제 명시(완료) + userns 가용 환경에서 sandbox 확장 승격 |
| R-3 | 중 | 사용자 ipython 셀 실행 타임아웃 없음; abort 는 호스트 측 정산만 → Python 무한루프 미종료 | repl-manager.ts:719-737,854-870 | `ExecuteOptions` 에 timeout 노출 + 초과 시 커널 restart |
| R-4 | 중 | 실 A/B 미실행 — evo 효과 주장은 논문 수치 인용 상태(GAP-4) | eval/RESULTS.md | 키 확보 후 4-arm × 3회 |
| 기타 | 낮음 | RESULTS.md "pi-ai mock 없음" 서술 vs `providers/faux.ts:391` 존재 불일치; inventory 훅 수 19 오기 | — | 문서 갱신 |

## 5. 산출물
- 다이어그램: `docs/diagrams/evopi-master-arch.{dot,png}`, `docs/diagrams/claude-code-master-arch.{dot,png}` (graphviz neato, Noto Sans CJK KR, 틸 액센트)
- 세미나 덱: `docs/seminar/evopi-architecture.pptx` (42장, 생성기 `build_deck.py`, 렌더 검증 PDF 동봉)
- 분석: `docs/analysis/{evopi-harness-inventory,claude-code-arch,prime-master-arch,omp-master-arch}.md`
