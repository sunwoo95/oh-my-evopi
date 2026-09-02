# PORTING — 모듈 매핑·충돌·경로 통합 설계

> 작성: 2026-09-02 (STEP 10). 입력: docs/analysis/{omp,prime,evo}.md, DECISIONS.md,
> RUNBOOK 병합 설계 분석. 게이트 반영: D3[폴백], R5[해소], R6[채택], R7[기본 정책+v1 범위 한정].

## 0. 레포 배치 결정

evopi 제품 = **prime-agent 트리의 리브랜딩 사본**을 `oh-my-evopi/` 루트에 배치:
```
oh-my-evopi/
├── packages/{agent, ai, tui, coding-agent}   ← prime 사본 (M1)
├── prime-agent-runtime/ → evopi-runtime/     ← rlm Python 패키지 (M1, 디렉터리명만 변경)
├── evopi.sh (← prime-agent.sh) · install.sh · package.json
├── docs/ · refs/ · GOAL.md · CLAUDE.md …     ← 기존 설계 산출물 (유지)
└── src/, tests/                              ← 스캐폴드 잔재 — evopi 신규 코드(natives-loader,
                                                 grounded-refine 확장 등)는 packages/coding-agent
                                                 관례를 따르므로 src/는 제거 예정
```
원본 2레포는 읽기 전용 유지. 복사는 `.git`/`node_modules`/`dist` 제외.

## 1. 모듈 매핑표 (이식 등급표 반영)

| 원본 | evopi 위치 | 처리 | 근거 |
|---|---|---|---|
| prime packages/agent | packages/agent | **그대로** (스코프명만 @evopi) | 등급 골격 |
| prime packages/ai | packages/ai | **그대로** + 백포트 주입점(api-registry) 유지 | 스트림 계약 소유자 |
| prime packages/tui | packages/tui | **그대로** | 등급 D (omp tui는 v2) |
| prime packages/coding-agent | packages/coding-agent | **piConfig 리브랜딩** + 로고 교체 + 확장 추가 | prime.md §3 |
| prime prime-agent-runtime (rlm) | evopi-runtime (Python 패키지명 `rlm` 유지) | 그대로 | D2. 패키지명 변경은 커널 계약 파괴 위험 → 유지 |
| prime examples/extensions/{sandbox,permission-gate} | packages/coding-agent/extensions-bundled/ (신설) | **개조** — capability 프로브 + graceful degradation (D3 폴백) | D3/R3 |
| prime install.sh / prime-agent.sh | install.sh / evopi.sh | **개조** — `prime_agent_` 접두 함수 sed 치환 + 로고 교체 | prime.md §4 |
| omp ai/src/auth-storage.ts + auth/ | packages/ai/src/evopi-auth-pool/ | **개명 백포트** (v1) — catalog import를 prime 타입 어댑터로 치환, Bun 1줄 심 | 충돌 1순위 회피 |
| omp ai/src/auth-retry.ts, oneshot-retry.ts | packages/ai/src/evopi-auth-pool/ | 백포트 (v1) | 등급 A |
| omp ai/src/dialect/ | packages/ai/src/dialect/ | **백포트** (v1) — catalog/identity 의존은 로컬 타입으로 절단 | 등급 A, 절단면 소형 (omp.md §1.2) |
| omp ai/src/{auth-broker, auth-gateway} | — | **v2 이연** (Phase 3 신규 축 판정 — Bun.serve/WS 재작성 비용) | DECISIONS Phase 3 |
| omp ai/src/registry 선언 패턴 | — | **v2 이연** — prime 카탈로그(models.generated)가 v1 요구 충족. 요구사항 "합집합"은 auth 계층(풀)과 dialect로 달성, 신규 프로바이더 추가 절차만 PROVENANCE에 문서화 | 카탈로그 소유자=prime |
| omp hashline (패키지 전체) | packages/hashline | **백포트** (v1) — natives 3함수는 natives-loader 경유 | 등급 C→R6 채택 |
| omp mnemopi | packages/mnemopi | **백포트** (v1, 병존) — natives 3함수는 natives-loader 경유. omp 코어(core/{mmr,shmr,vector-index}+스토어)만, MCP 서버 겸용 기능은 v2 | 등급 B→R6 채택 |
| (신규) natives-loader | packages/natives-loader | **신설 1파일** — leaf .node 직접 require, AVX2 감지(modern/baseline), 미가용 시 null | R6 판정 기록 |
| omp metaharness | eval/metaharness (제품 밖 트리) | **사본 격리** — bun으로 구동, 제품 워크스페이스에 불포함 | R7 정책 |
| omp .omp/skills 3종 (md) | packages/coding-agent/skills-md/ 또는 ~/.evopi 배포분 | 복사 (v1) | 등급 A |
| (신규) grounded-refine 확장 | packages/coding-agent/extensions-bundled/grounded-refine.ts | **신설** — R4 v1 델타 D4+D1(+D7 흡수) | evo.md 선택지 B |
| omp snapcompact / tui 저수준 / pi-shell / pi-iso / TTSR / Advisor / URL 스킴 / worktree | — | v2 백로그 | 등급 D/E |

## 2. 충돌 목록과 해결안

| # | 충돌 | 해결안 |
|---|---|---|
| C1 | **auth-storage.ts 동명이역** — prime `core/auth-storage.ts`(auth.json 파일락) vs omp `ai/src/auth-storage.ts`(SQLite 로테이션 풀) | omp 것을 `evopi-auth-pool/` 디렉터리로 개명 이식. prime auth.json = 1차 소스, 풀은 동일 프로바이더에 크레덴셜 ≥2개일 때만 활성. 조회 순서: auth.json → pool |
| C2 | **omp ai ↔ pi-catalog 결합** (import 54개) | v1 백포트 범위(dialect, auth-pool)의 catalog 의존은 타입+순수 헬퍼뿐(omp.md §1.2) → `packages/ai/src/evopi-compat/` 에 로컬 사본(타입 정의 + 헬퍼 함수)으로 절단. stream.ts 등 데이터 소비부는 미백포트 |
| C3 | **Bun API** (30파일·114회) | v1 범위 한정으로 구조적 사용 회피. 백포트 파일마다 1줄 심 치환(env/sleep/file/hash/deepEquals→node 표준). 게이트: 제품 packages/ `rg 'Bun\.'` 0건 (단 prime 원본의 isBunRuntime 감지 코드는 예외 목록으로 허용 — config.ts:32-36은 node 실행에 무해) |
| C4 | **scope 이름 충돌** — prime HarnessEntry.scope(local/global=영속 범위) vs 논문 scope(cross-task/task-type=일반성) | v1 델타는 scope를 건드리지 않음(D2·D6은 v2). grounded-refine 확장 문서에 용어 구분 명시 |
| C5 | **`path` 기본값 "general"** (refinement.ts:776) — 논문 general 레벨과 무관한 문자열 | v1에서 미사용. v2 D2 설계 시 별도 필드로 분리 (오독 방지 주석만 v1에 추가) |
| C6 | **세션 트리 JSONL** — 양쪽 포맷 유사하나 상이 | prime 포맷 단독 채택 (omp 세션 임포트는 v2) |

## 3. 이연 항목 (v2 백로그 — 이유)

auth-broker/gateway(Bun 서버 재작성), omp registry ~80종(카탈로그 소유자=prime),
snapcompact(natives PNG 렌더), omp tui 저수준(PTY/sixel), pi-shell/pi-iso(Rust 툴체인),
TTSR·Advisor·URL 스킴·worktree 격리(병합 분석 §C), mnemopi MCP 서버 겸용,
evo 델타 D2·D3·D5·D6·D8·D9(R4 판정 — DECISIONS 참조), omp 세션 임포트,
데몬 계층 개조(v1 동결).

## 4. 설정 경로 통합 (.omp / .prime → ~/.evopi) — 누락 0건 매핑

| 원본 경로 | evopi 경로 | 메커니즘 |
|---|---|---|
| ~/.prime/agent/settings.json | ~/.evopi/agent/settings.json | piConfig configDir 파생 (config.ts:498,530 — 자동) |
| ~/.prime/agent/auth.json | ~/.evopi/agent/auth.json | 〃 |
| ~/.prime/agent/models.json | ~/.evopi/agent/models.json | 〃 |
| ~/.prime/agent/keybindings.json | ~/.evopi/agent/keybindings.json | 〃 |
| ~/.prime/agent/AGENTS.md, SYSTEM.md, APPEND_SYSTEM.md | ~/.evopi/agent/〃 | 〃 |
| ~/.prime/agent/prompts/, skills/, harness/, themes/, extensions/, logs/, bin/ | ~/.evopi/agent/〃 | 〃 |
| ~/.prime/agent/sessions/<id>.jsonl | ~/.evopi/agent/sessions/ | 〃 |
| ~/.prime/agent/session-artifacts/<id>/* (kernel-state.dill 포함) | ~/.evopi/agent/session-artifacts/ | 〃 |
| ~/.prime/agent/kernel-venv/ | ~/.evopi/agent/kernel-venv/ | 〃 |
| ~/.prime/agent/cron-jobs.json | ~/.evopi/agent/cron-jobs.json | 〃 |
| PRIME_AGENT_* env | EVOPI_* env | envPrefix 파생 (config.ts:490-504 — 자동) |
| .prime/agent/{settings.json, skills/, prompts/} (프로젝트) | .evopi/agent/〃 | 〃 |
| ~/.agents/skills/, .agents/skills/ (벤더중립) | 유지 (변경 없음) | Phase 3 확정 |
| ~/.omp/agent/agent.db | ~/.evopi/agent/agent.db (auth-pool 저장소) | evopi-auth-pool 경로 상수 — getAgentDir() 기반으로 신규 작성 |
| ~/.omp/logs/ | ~/.evopi/agent/logs/ | prime 로그 경로 흡수 (별도 코드 불요) |
| ~/.omp/auth-gateway.token | — (v2 — gateway 이연) | v2 |
| .omp/{commands, tools} (프로젝트) | .evopi/agent/{commands, tools} | v1: 디렉터리 규약만 예약 (기능은 prime 확장/스킬로 대체, 로더는 v2) |
| .omp/skills/ | .evopi/agent/skills/ | prime 스킬 로더가 그대로 처리 |
| 프로젝트 .evopi/agent/sandbox.json + 전역 ~/.evopi/agent/extensions/sandbox.json | sandbox 확장 계약 유지 | D3 폴백 (프로브 실패 시 비활성) |

**검증 규칙** (STEP 15): `rg -n '\.omp|\.prime' packages/ evopi.sh install.sh --glob '!*.md'` 출력 0건
+ 격리 HOME 설치 리허설에서 `.omp`/`.prime` 생성 0건.

## 5. 모델 커넥팅 합집합 설계

- **1차 (prime 그대로)**: models.generated 카탈로그, OAuth 3종(Anthropic/Copilot/Codex),
  bedrock-provider(SigV4), env-api-keys, openrouter-reasoning, cache-pricing, mcp, faux.
- **omp 백포트 계층**:
  - `evopi-auth-pool`: 프로바이더당 다중 크레덴셜(SQLite agent.db) + 라운드로빈 +
    사용량 랭킹 + 401/한도 시 형제 크레덴셜 재시도(auth-retry). prime `getApiKey` 훅
    (AgentLoopConfig — 만료 토큰 대응 지점)에 어댑터로 연결.
  - `dialect`: 오픈모델 in-band 툴콜 파싱(harmony/qwen3/glm/kimi/deepseek) —
    prime 스트림 이벤트로 정규화하는 후처리 어댑터. 주입점: prime `api-registry.ts`
    (열린 Map + registerApiProvider) 또는 스트림 후처리 훅.
- **신규 프로바이더 추가 절차** (문서화): prime 방식 = models.generated 재생성(generate-models.ts)
  또는 ~/.evopi/agent/models.json 수동 등록 + 확장 `pi.registerProvider()`.

## 6. IPython 커널 설계안 (D3 폴백 반영)

- 커널 스택(bootstrap/repl-manager/state-snapshot/boot-gate + rlm)은 **무변경 이식**.
  R5 해소로 DEFAULT_RLM_EXTRA_PACKAGES 수정 불요.
- D3 폴백 구현:
  1. `sandbox-probe.ts` (신설, 소형): 부팅 시 `bwrap --ro-bind / / true` 시도 →
     가능 여부를 세션 컨텍스트에 기록.
  2. sandbox 확장(examples 패턴 이식): 프로브 성공 환경에서만 bash 툴 래핑 활성,
     실패 시 1회 경고 로그 + 비활성 (graceful degradation).
  3. eval 프로파일 문서·시스템 메시지에 "컨테이너/VM 격리 전제" 명시.
  4. (개선 후보, Q6) 커널 spawn env 필터: `EVOPI_*`·API 키 계열 env를 커널에 전달하지
     않는 allowlist 옵션 — v1 포함 여부는 PLAN에서 소형 모듈로 분리.
- 재검토 조건: userns 가용 환경에서 bwrap 3종 스모크 재실행 → 커널 래핑 승격 (DECISIONS 기록).

## 7. 평가 하네스 이식 범위

- `eval/metaharness/` = omp metaharness 사본 (제품 워크스페이스 외부, bun 전용).
  개조 최소화: launch-args의 피실험 CLI 경로만 evopi로 향하게 설정 (Q2 실측 후 확정).
- A/B 4-arm: 실험 접두사 `evopi` — `evopi-omp` / `evopi-prime` / `evopi-evooff` / `evopi-evoon`
  (experimentOf/armOf 규약 — omp.md §2.3).
- No-Evolve arm = `autoRefine.enabled:false` (settings-manager.ts:909 — 코드 수정 0).
- 접지 신호: BenchmarkTrace.status pass/fail → grounded-refine 확장 입력 (R4 D4).
- 키 부재 시: faux 프로바이더 스모크로 대체 (STEP 14 정책).

## 8. 리브랜딩 잔존 검사 목록 (omp 문서 §4.4 재활용 — STEP 15 감사)

1. piConfig {name, configDir} ✓(자동 파생) 2. bin 이름 3. 패키지 스코프명(@evopi/*)
4. install.sh/evopi.sh 문자열·함수 접두사 5. 로고(prime-logo.ts) 6. self-update 경로
(config.ts InstallMethod — upstream GitHub 릴리스 참조 여부 확인 필요) 7. README/문서
8. env 접두사 ✓(자동 파생) 9. User-Agent 문자열 (미확인 — 검사 시 rg)
