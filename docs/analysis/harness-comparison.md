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

## 3. 6자 비교 매트릭스 (9축)

> 2026-09-07 갱신: 사용자 지시로 "GitHub 스타 다수의 인기 OSS 코딩 도구" 비교를 확대. 신규 2열의 근거 등급이 다르다 —
> **opencode+oh-my-openagent** 열은 워크스페이스 상위 `/opt/workspace/local/sw4kim/opencode/`(oh-my-evopi 저장소 외부,
> 읽기 전용 실측)를 직접 조사한 `docs/analysis/opencode-oh-my-openagent-arch.md` 기준 — 인용은 그 문서의 §번호로 축약.
> **Codex CLI** 열은 로컬에 설정 조각 하나뿐(`/opt/workspace/local/.codex/config.toml.bak`, mcpServers 1개)이라 **공개
> 자료/일반 지식 기준(미검증)** 으로 표시하고, 확인 불가한 세부는 각주에 "미확인"으로 남긴다. 두 열 모두 Cursor/Aider/
> Cline/Windsurf 는 제외(사용자 지시). `opencode.json` 의 평문 API 키는 이 표에도 어떤 열에도 값으로 등장하지 않는다.

| 축 | Claude Code (자료 기준) | oh-my-pi v18.1.2 | prime-agent v0.9.1 | evopi v0.9.6 | opencode+oh-my-openagent (로컬 실측, 저장소 외부) | Codex CLI (공개 자료 기준, 미검증) |
|---|---|---|---|---|---|---|
| 1 제어 루프 | Gather-Act-Verify; 독립 도구 병렬 [PDF p.8,30] | agent-loop 3,010줄; 29 툴 shared/exclusive 병렬; steering/aside/follow-up 3큐 + 3층 abort; TTSR | 동일 agent-loop; AgentSession 11,948줄; ipython sequential | prime 루프 무수정; streamFn 에 dialect·pool 삽입 | 코어 자체가 `agent.plan/build` 를 1급 모드-모델 축으로 노출(§2); 그 위에 oh-my-openagent 가 10-에이전트 롤스터로 오케스트레이션 추가(§3.1). 코어 루프 알고리즘 자체는 미확인(§8) | 단일 에이전트 루프로 알려짐; 서브에이전트/이름있는 롤스터 개념은 확인 안 됨(미확인) |
| 2 도구/실행 | 5 카테고리 tool_use; Local/Cloud VM/Remote [p.11,22] | 29 빌트인 툴; Rust in-process 셸(brush-core); hashline 편집; xd:// discoverable 장치 | ipython 1툴; IPython 커널 + dill; 셸/편집은 Python 심볼 | 동일 + hashline_edit 선택; natives prebuilt 로더 | 4개 명명 에이전트(`agents/*.md`)가 각각 `mode: primary\|subagent` + 툴별 `edit: allow\|deny` 선언(§3.3) | 내장 파일편집/셸 + MCP 클라이언트로 외부 서버 도구 확장(로컬 실측: `config.toml.bak` mcpServers.n8n-mcp 1개, command=bash) |
| 3 컨텍스트 | CLAUDE.md 매 턴, MEMORY.md 200줄/25KB, Skills 3단, 자동 압축 [p.13-17,26-27] | AGENTS.md; 메모리 백엔드 4종(hindsight/mnemopi/sharpshooter/local); 컴팩션 5전략(snapcompact PNG); append-only 프리픽스 캐시 | AGENTS.md + Harness 원장(kind별 6개), 요약 컴팩션, compact→refine | prime + MMR 하네스 선택기(문자 예산) | 설정 표면(json/md)만 조사 범위 — 컨텍스트 관리 방식은 **미확인**(§8) | AGENTS.md 컨벤션으로 알려짐(공개 자료); 세부 압축·메모리 전략 미확인 |
| 4 권한/안전 | 4 모드, allowlist 계층, 체크포인트 되감기, Hooks 게이트 [p.23,35] | approval allow/deny/prompt × 모드 always-ask/write/yolo; CRITICAL_BASH_PATTERNS; COW worktree(pi-iso) 격리, OS 샌드박스 없음 | 권한 프롬프트; 샌드박스는 예제 확장(bwrap, bash 툴만); 커널 무격리 | permission-gate 내장 + 샌드박스 프로브(D3 폴백); 커널 무격리 동일. 승인은 `read/write/exec × hazard` 4축, 세분화 단위는 **툴 이름**(`approval.toolTiers[toolName]`) + 전역 정규식 화이트리스트(`permissionGate.allow[]`), 명령 패턴별 프리셋은 없음(permission-gate.ts:349-420,618-641,739-747) | **bash 를 글롭 패턴별로** 3단계(`allow/ask/deny`) 세분화, 서브에이전트 파일마다 다른 강도(coder < researcher < reviewer, §3.3) — evopi 대비 그래뉼러리티가 툴 하나 아래 명령 패턴 단위 | OS 샌드박스(macOS seatbelt / Linux landlock+seccomp)를 기본 내장으로 알려짐 + 승인 모드 단계(공개 자료, 정확한 현재 명칭·단계 수는 미검증) |
| 5 확장성 | Skills/MCP/Hooks(14 이벤트)/Subagents/Plugins [p.35,39-40] | 훅 28, 슬래시 83, 커스텀 툴, MCP, Advisor/Watchdog, task 서브에이전트(23k줄) | extensions(jiti) 31 훅, Python 스킬, MCP(커널), rlm() | prime 표면 그대로 + 빌트인 3 | plugin = npm 패키지명 배열(`opencode.json`) + TUI 전용 별도 플러그인 슬롯(`tui.json`, §2); 스킬 마켓 1,460개, `tools:` 필드로 165개가 크로스-CLI(claude/cursor/codex/gemini 등) 호환을 선언(§5) — 컨벤션 자체는 아직 불안정 | MCP 서버 연결이 주 확장축(로컬 실측 1건); 훅/플러그인 생태계 성숙도는 미확인 |
| 6 자기개선 | MEMORY.md 갱신만; 하네스 자동 정련 **없음** [p.26,42] | **있음** — autolearn(유의미 턴 후 managed SKILL.md 자동 저작), learn/manage_skill 툴, 메모리 4백엔드 통합, advisor. 하네스 코드 수정 기제는 미확인 | continual harness refine (**자가 판단 = Self-Generated**) | prime refine + 접지(D4) + 실패 한정(D1) + MMR | 자동 하네스 정련 기제 관측 안 됨 — `docs/superpowers/` 는 사람/에이전트가 쓰는 spec+plan 문서 워크플로(§7)이지 런타임 자기개선이 아님. 카테고리→모델 매핑 로직 자체는 미설치라 **미확인** | 확인된 자동 정련 기제 없음(미확인) |
| 7 모델 연결 | Claude Sonnet/Opus, /model [p.11]; 프로바이더 미기재 | 카탈로그 66 프로바이더(12MB models.json), dialect 11, auth-storage 6,934줄 풀 로테이션, auth-broker/gateway 사이드카 | 9 API, 카탈로그 32, OAuth 3, Bedrock, auth.json 1키 | prime 카탈로그 + 풀 로테이션 + dialect 11 + Databricks | provider.databricks 커스텀 OpenAI-호환 엔드포인트(§2) + **10-에이전트 개별 모델/폴백**(§3.1) + **8-카테고리 작업성격별 라우팅/폴백**(§3.2, 완전히 별도 축) + 프로바이더 호환 monkey-patch 플러그인(gemini-fix.js, §4.1) | OpenAI 모델(o-series/gpt) 중심으로 알려짐; 프로바이더 추상화 범위 미검증 |
| 8 런타임/배포 | 미기재 (일반지식: npm CLI) | Bun 전용(src `Bun.*` 1,282회/426파일), Rust napi 9 crate(Bazel), 설치 = GitHub Releases 단일 바이너리 | node + uv Python, install.sh 45KB, R2 | node ≥22, Bun 실코드 0, curl\|sh → GitHub Pages | TUI/코어 프로세스 분리(SDK가 `./client`/`./server`/`./tui` export 분리, §2); 코어 구현 언어(Go vs TS/Bun)는 로컬 자료로 미확정, 공개 지식상 Go TUI + TS/Bun 서버로 알려짐(§8, 미검증) | Rust 로 재작성된 단일 바이너리 CLI로 알려짐(공개 자료, 미검증); 세션 rollout JSONL 로깅 컨벤션도 공개 자료 기준 |
| 9 평가 | 미기재; Hooks 로깅, /context | metaharness(harbor/edit/snapcompact) | 없음(autoRefine off 로 대조군만) | metaharness bun 격리 4-arm; 실 실행 SKIP | 관측된 평가/벤치마크 하네스 없음(미확인) | 관측된 평가/벤치마크 하네스 없음(미확인) |

**자기개선 축 재판정**: Claude Code = 메모리 파일 갱신만 / omp = 스킬 자동 저작 + 메모리(하네스 원장 없음) / prime = 하네스 원장 편집(자가 판단) / evopi = 하네스 원장 편집 + 외부 접지 / opencode+oh-my-openagent = 자동 정련 기제 미관측(설정 자체를 사람이 spec+plan 워크플로로 편집) / Codex CLI = 미확인. 즉 "무엇을 진화시키나"가 파일 → 스킬 → 원장 → (관측 안 됨), "무엇으로 판단하나"가 없음 → LLM 자가 → 환경 신호 → (관측 안 됨)로 갈린다.

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
- (2026-09-07 추가) `docs/analysis/opencode-oh-my-openagent-arch.md` — 신규 비교 대상 실측(저장소 외부, 읽기 전용).
  UX 격차 추출은 `docs/analysis/evopi-ux-gap-analysis.md`, 제안서는 `docs/design/UXP-evopi-ux-proposal.md`.
