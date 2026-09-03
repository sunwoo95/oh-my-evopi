# DECISIONS — oh-my-evopi

> 갱신: 2026-09-02 (**감사 반영 v2** — AUDIT-initial-goal.md 판정 정본화: D8 신설,
> 등급표 배선 상태 열, R8-R10 신설, v2 백로그 절). 원본 정책: ../../../RUNBOOK.md
> **이번 구현 사이클에서 git 작업(init/commit/tag)은 사용자 지시로 제외** — 체크포인트는 REVIEW.md 기록으로 대체.
> (이후 git 커밋/푸시는 사용자 지시로 재개됨 — 2026-09-02 배포 사이클부터.)

## 확정 결정 (재론 금지)

| # | 축 | 결정 |
|---|---|---|
| D1 | 베이스 | **prime-agent 골격 + omp TS 자산 등급별 이식** (실측 확정) |
| D2 | 코드 실행 엔진 | **prime IPython 커널 방식 확정** (uv 부트스트랩 + dill 스냅샷) |
| D4 | 권한 모델 | 2계층 분리 (의도=allowlist, 집행=OS 레이어. 최종 판정자는 집행 계층) |
| D5 | 컨텍스트 압축 | 요약 기반 (prime compaction 기반, snapcompact는 v2) |
| D7 | evo 레이어 | optional. evo off로 전 기능 동작 (A/B 대조군) |
| D8 | 논문 기반 | **arXiv 2608.15071 (EVO-HARNESS, skill compilation) 확정** — 초기 구상 2608.05446(EvoHarness-RL)은 SFT+GRPO 학습이 본체라 frozen-solver CLI 에서 이식 불가(AUDIT §C1). 무학습 개념 3종은 v2 백로그(아래 절) |

## 이식 등급표 (+ 배선 상태 — 2026-09-02 감사 정본화)

| 등급 | 패키지 | 처리 | 배선 상태 |
|---|---|---|---|
| **A: 즉시 이식** | `ai` (auth-gateway/broker/storage/retry, dialect, registry, usage, provider-details), `metaharness` | pi-natives 의존 0건. ⚠ R7(Bun) 게이트 선행 | dialect=**이식·휴면→B1(M15) 배선**, auth-storage(풀)+retry=auth-pool **이식·휴면→B2(M16) 배선**, metaharness=eval/ 격리 배선 완료, broker/gateway·usage·provider-details·registry=**v2 이연 [자동확정]**, oneshot-retry=**B4(M18) 이식** |
| **B: 알고리즘 재구현** | `mnemopi` — `mmrRerankIndices`, `cosineSimilarityPairs`, `vectorIndexTopK` | R6 채택으로 natives 직행 + TS 폴백 | **이식·휴면→B3(M17) 배선** (harness 주입 선택기) |
| **C: npm 대체** | `hashline` — `diffLineRuns`, `enclosingBlockBoundaries`, `nodeChainAt` | R6 채택으로 natives 직행 | **배선 완료** (`hashline_edit` 선택 툴, M6) |
| **D: v2 이연** | `snapcompact`(PNG 렌더), `tui`(PTY/sixel) | TUI는 prime tui 사용 | — |
| **E: v2 optional** | `pi-shell`, `pi-iso`, `crates/*` | prebuilt 바이너리 | — |

## RECONFIRM 상태 원장

| # | 쟁점 | 상태 |
|---|---|---|
| ~~R1~~ | 베이스 해석 | 해소 (D1) |
| ~~R2~~ | 커널 지속성 vs 격리 | 해소 (prime dill 스냅샷) |
| ~~**D3**~~ | 커널 샌드박싱 결합 | **판정 완료 [폴백] — 아래 판정 기록** (bwrap 불가 환경) |
| **R3** | allowlist 실효 범위 | 미결 — 권한 모듈 착수 직전 판정 |
| ~~**R4**~~ | 논문 델타 범위 | **판정 완료 [자동확정] — v1 = D4(+D7 흡수) + D1 + D0, 나머지 v2. 아래 판정 기록** |
| ~~**R5**~~ | uv x86_64 휠 가용성 | **해소 [자동확정] — 아래 판정 기록** |
| ~~**R6**~~ | prebuilt pi-natives 채택 | **채택 [자동확정] — 아래 판정 기록** (node 로더 심 1개 필요) |
| ~~**R7**~~ | omp 자산 Bun 의존 처리 | **판정 완료 [자동확정] (M12) — 제품=node 전용, metaharness=bun 격리 확정. 아래 판정 기록** |
| **R8** | dialect 소비 배선 (owned-mode) | **착수 확정 — B1(M15)**. 활성=models.json `dialect` 필드+`EVOPI_DIALECT`, 주입점=sdk.ts streamFn, off 시 바이트 동일 게이트 |
| **R9** | auth-pool 소비 배선 (스트림 로테이션) | **착수 확정 — B2(M16)**. 풀 소스=`EVOPI_API_KEY_POOL_<PROVIDER>` env, `withAuthStream`(buffer-until-replay-unsafe), env 부재 시 무랩핑 |
| **R10** | mnemopi 소비 배선 (harness 선택기) | **착수 확정 — B3(M17)**. MMR+jaccard+토큰 예산, 게이트=`evo.enabled` 또는 `harness.selection:"mmr"`, 기본 무변경 |

## v2 백로그 — 05446 무학습 개념 (D8 부속, AUDIT P1b)

| # | 개념 | 구현 방향 (전부 evo-off 무영향 확장/스킬 레이어) |
|---|---|---|
| ① | Belief/Progress/Experience 하네스 뷰 | prime HarnessEntry 4종{prompt,memory,skill,subagent} 위 태깅 계층: memory→Belief/Experience 분류, goal/progress 연동 |
| ② | harness annealing | refinements.jsonl 이력 기반 미사용·노후 엔트리 주기적 통합·감쇠 |
| ③ | cost-aware 주입 | 시스템 프롬프트 주입 엔트리 토큰 예산 상한 — **B3(M17)로 선반영** |

## RECONFIRM 처리 규칙 (GOAL 모드)
- 트리거 도달 시 STOP 하지 않는다. RUNBOOK 「GOAL 모드 실행 규칙」의
  자동 판정 정책 표(D3/R3/R4/R5/R6/R7)를 적용한다.
- 기록 형식: (1) 어디서 확인했는가 — 파일경로:라인
             (2) 적용한 판정 기준과 실행 출력(스모크 테스트 결과 등)
             (3) 판정 결과 [자동확정] 또는 [폴백]
- 판정 후 즉시 이 파일을 갱신하고 SPEC.md / PLAN.md 를 함께 수정.
- 판정 기준이 상충하거나 양쪽 다 실패하면 BLOCKERS.md에 기록하고
  비의존 모듈로 진행한다 (크리티컬 패스면 정지·보고).

---

## 판정 기록

### R5 [자동확정] — 해소 (2026-09-02, STEP 4)

- **근거 위치**: 패키지 목록 = prime `packages/coding-agent/src/core/kernel/bootstrap.ts:20-33`
  `DEFAULT_RLM_EXTRA_PACKAGES` (requests, httpx, pyyaml, tomli, python-dotenv, pandas,
  numpy, scipy, beautifulsoup4, lxml, pydantic, tyro).
- **적용 기준**: dry-run 출력에서 전부 `.whl` → 즉시 해소.
- **실행 출력**:
  - `uv venv --python 3.11 /tmp/kernel-probe` 성공.
  - `uv pip install --dry-run <12종>` → `Resolved 28 packages in 552ms / Would install 28 packages`,
    출력에 `.tar.gz` **0건** (전부 wheel).
  - 실 설치: `real 0m0.144s` (uv 캐시 워밍 후. 콜드 캐시 시 다운로드 시간이 추가되나
    소스 빌드는 없음).
  - 임포트 검증: 12개 모듈 전부 성공 — `all 12 import OK: numpy 2.4.6 pandas 3.0.5`.
- **결론**: x86_64 manylinux 휠 표준 제공 확인. `DEFAULT_RLM_EXTRA_PACKAGES` 수정 불필요.
  커널 부팅 지연 리스크 없음.

### D3 [폴백] — 커널 비격리 + 컨테이너 전제 (2026-09-02, STEP 7 게이트)

- **적용 기준**: GOAL 모드 정책 — bwrap 하 (1) uv 부트스트랩 (2) 커널 부팅 (3) dill
  저장·복원 3종 스모크 통과 시 [자동확정], 실패 시 [폴백].
- **실행 출력 (3회 시도)**:
  1. `bwrap --ro-bind / / … uv venv` → `bwrap: Creating new namespace failed: Operation not permitted`
  2. 진단: `/proc/self/status` → `CapEff: 00000000a80425fb`(CAP_SYS_ADMIN 없음),
     `Seccomp: 2`(필터 활성). `/.dockerenv` 존재 — **현 환경 자체가 Docker 컨테이너**.
  3. `unshare -m/-U/-p` 전부 `Operation not permitted` — mount/user/pid 네임스페이스
     생성이 seccomp 로 전면 차단. **bubblewrap 은 이 환경에서 구조적으로 불가**
     (호스트 설정 변경 없이는 해소 불능 — 코드 문제 아님).
- **폴백 내용** (정책 표 그대로):
  - 커널은 비격리로 유지한다. sandbox 확장(bash 툴 bwrap 래핑)은 코드로는 포함하되
    **네임스페이스 생성 가능 환경에서만 활성**(부팅 시 capability 프로브 → 불가 시
    경고 후 비활성; graceful degradation).
  - **eval 프로파일 = 컨테이너 전제를 문서화**: 무인 실행은 반드시 격리된 컨테이너/VM
    안에서 수행한다. 현 개발 환경이 그 사례(Docker 경계가 곧 집행 계층).
  - D4 의 집행 계층은 이 배포 형태에서 **컨테이너 경계**가 담당하고, 의도 계층
    (allowlist/permission-gate, R3)은 애플리케이션 레이어에서 그대로 구현한다.
- **베이스라인 검증 (비격리 3종 스모크 — 커널 메커니즘 자체는 건재)**:
  - uv venv + dill 0.4.1 설치 성공 / `boot OK 3.11.16` /
    dill 스냅샷 244B 저장 → **별도 프로세스에서 복원 성공** (`restore OK: x=42 f(21)=42`).
- **재검토 조건**: CAP_SYS_ADMIN 또는 unprivileged userns 가용 환경으로 이전 시
  bwrap 3종 스모크를 재실행해 [자동확정] 승격 (REVIEW.md 등재).

### R6 [자동확정] — prebuilt pi-natives 채택 (2026-09-02, 선행 스모크)

- **적용 기준**: `npm install @oh-my-pi/pi-natives` 후 node에서 3함수 + hashline 경로
  로드·호출 스모크 통과 → 채택 (등급 B/C 재구현 생략).
- **실행 출력**:
  - `npm install @oh-my-pi/pi-natives@18.1.2` → leaf `pi-natives-linux-x64` 자동 선택
    설치 성공 (`pi_natives.linux-x64-{baseline,modern}.node` 2변형 동봉).
  - ⚠ 래퍼 JS는 node에서 실패: `require()` → ERR_PACKAGE_PATH_NOT_EXPORTED (ESM 전용),
    ESM `import` → `loader-state.js:778`의 **`import.meta.dir`(Bun 전용 속성)** 이
    undefined → TypeError. 래퍼(index.js/loader-state.js)는 Bun 전제
    (`Bun.spawnSync` 사용처도 존재: loader-state.js:272).
  - **leaf `.node` 직접 로드는 성공**: `require('.../pi_natives.linux-x64-baseline.node')`
    → 100개 export, 6개 대상 함수 전부 존재.
  - 호출 스모크 6/6 통과 (의미론 검증 포함):
    `mmrRerankIndices(['apple pie','banana split','apple tart'], [0.9,0.5,0.8], 0.7, 2)` → `[0,2]` ✓
    `cosineSimilarityPairs(3×2, thr 0.9)` → `[0,1]` ✓ /
    `vectorIndexTopK` → indices `[0,2]`, scores `[1, 0.7071]` ✓ /
    `diffLineRuns('a\nb\nc','a\nX\nc')` → 정확한 removed/added run ✓ /
    `nodeChainAt({code, lang:'javascript', line:2})` → return_statement→statement_block→
    function_declaration 체인 ✓ (내장 tree-sitter 문법 동작 확인) /
    `enclosingBlockBoundaries` → `[]` (필드 규약: `code`/`lang`/`ranges[{startLine,endLine}]`)
- **결정**:
  1. 등급 B(mnemopi 3함수 TS 재구현)·등급 C(hashline 3함수 npm 대체) **생략**.
  2. evopi에 **node 전용 로더 심 1파일** 신설 (`natives-loader`): 플랫폼 leaf 패키지의
     `.node`를 직접 require, AVX2 감지로 modern/baseline 변형 선택, 미가용 플랫폼이면
     null 반환(호출측 폴백). 원본 래퍼는 사용하지 않음 — R7 정책(제품 `Bun.*` 0건)과 정합.
  3. 리스크 수용: upstream 버전 종속(18.1.2 고정), Bazel 산출물 블랙박스 —
     PROVENANCE.md에 기재.

### STEP 2·3 실측 부기 (2026-09-02)

- graphviz 2.43.0 + Noto CJK 설치, 한글 렌더 검증 통과 (docs/diagrams/font-test.png 육안 확인).
- bwrap / socat / rg 설치 완료 (D3 스모크 전제 충족).
- refs/: claude-code-architecture.pdf (45쪽, %PDF-1.3), slide5/6/7.png (150dpi),
  evo-harness.txt 복사 완료.
- `file` 명령 부재 → PDF 검증은 헤더 바이트(`head -c 8`)로 수행.

### Phase 3 — 선판정 5축 반증 검사 [자동확정] (2026-09-02, STEP 9)

RUNBOOK 병합 설계 분석 §B의 선판정을 Phase 1 분석(omp/prime/evo.md)과 대조:

| 축 | 선판정 | 반증 검사 결과 | 판정 |
|---|---|---|---|
| ai 인터페이스 소유자 | prime | **강화** — omp ai의 공개 타입 자체가 pi-catalog 재수출(omp.md §1.2: types.ts:1-2), stream.ts는 catalog 데이터(CATALOG_PROVIDERS)를 실소비 → omp 스트림 계약을 가져오면 catalog까지 끌려옴. prime 소유가 절단 비용 최소 | [자동확정] |
| mnemopi ↔ harness memories | 병존 (통합 v2) | 반증 없음 — R6 채택으로 mnemopi 3함수 natives 직행 가능, prime harness 원장과 저장소가 분리되어 충돌 없음 | [자동확정] |
| 코딩 트랙 | metaharness kind:"edit" 재사용 | 반증 없음 — edit kind 정의·지표 2종·arm 규약 실측(omp.md §2.2-2.3). 단 **Q2**(어댑터가 피실험 CLI를 무엇으로 spawn하는지) 미확인 — STEP 13 평가 모듈에서 검증 | [자동확정+Q2 유보] |
| tui | prime | 반증 없음 — Phase 1에서 신규 근거 없음 | [자동확정] |
| 벤더중립 경로 ~/.agents/skills/ | 유지 | 반증 없음 — prime이 이미 지원 (PRIME_AGENT_ANALYSIS §6) | [자동확정] |

**신규 발견 축 (Phase 1)**: omp ai 백포트의 v1 범위 —
Bun 사용 실측이 30파일·114회로 확대됨(omp.md §1.3, RUNBOOK v3 "5파일"은 오류로 정정).
구조적 재작성(Bun.serve/WebSocket 16회)은 auth-broker/auth-gateway 2서버에 국소화.
→ **[자동확정] v1 백포트 = auth-storage(풀)·auth-retry·dialect·registry 선언 패턴으로 한정.
auth-broker/auth-gateway(사이드카 서버)는 v2 이연.** 근거: 이 한정으로 제품 코드의
`Bun.*` 잔존을 1줄 심 계열로만 좁혀 R7 기본 정책(제품 node 전용, `rg 'Bun\.'` 0건 게이트)
유지 가능.

### R4 [자동확정] — v1 evo 델타 = D4(+D7) + D1 + D0 (2026-09-02, STEP 11)

- **적용 기준** (GOAL 모드 정책): 델타별 3조건 — ① prime에 "없음" 판정 AND
  ② 신규 파일 ≤3개 AND ③ metaharness 지표로 측정 가능 — 전부 충족만 v1.
- **입력**: docs/analysis/evo.md §3 델타 목록(D0~D9) + §5 체크리스트 (전 항목
  논문·prime 코드 이중 인용).
- **기계적 적용 결과**:
  - **D4 접지 피드백 배선**: ①✓(S8 없음) ②✓(1파일) ③✓(기존 status pass/fail +
    task_success_rate) → **v1**. 논문 근거 최강 (Table 4: SWE Minimal 67.33 vs
    No-Evolve 63.67). D7(y/f 슬롯)은 동일 배선 지점이므로 흡수.
  - **D1 실패 한정 트리거**: ①✓(S4 없음) ②✓(1파일, D4와 신호원 공유 시 통합 가능)
    ③✓(최종 판정은 기존 task_success_rate) → **v1**.
  - **D0 평가 배선**: ①✓ ②✓(0파일) ③✓(정의상) → **v1** (전제 인프라).
  - **D9 예산 상한**: 3조건 명목 통과하나 체크리스트의 선행 조건(D5 MERGE 또는
    삭제 정책)이 미충족이고 초과분 처리 정책이 논문에 미명시 → 기준의 "전부 ✓"를
    조건부 통과로 볼 수 없음 → **v2**.
  - **D2 배치 이중 컴파일**: ②가 2~3파일 경계(배치 경계 정의 포함 시 초과 추정)
    → 보수 적용으로 **v2**. (코딩 트랙 절제 근거는 강함 — v2 최우선 후보)
  - **D3·D5·D6·D8**: ① "부분" 판정으로 탈락 → **v2**.
- **= evo.md 선택지 B.** 구현 형태: `grounded-refine` 번들 확장 1파일 —
  (a) 외부 pass/fail 신호가 실패일 때만 refine 발동(D1), (b) 그 신호·진단을 refine
  입력에 주입(D4+D7), (c) 신호 부재 시 기존 turn_interval 경로 폴백(안전 조건).
- **안전 구속** (OPEN-QUESTIONS 안전 함의 반영): evo-on arm은 반드시 접지 신호가
  배선된 상태로만 구성한다 — 접지 없는 evo-on은 논문 Table 4 기준 No-Evolve 이하
  성능이 예측되므로 A/B 설계에서 금지.
- **피드백 세밀도 기본값**: Minimal(pass/fail만) — 코딩 트랙에서 Standard보다 근소
  우위(67.33 vs 67.00)이고 과잉 특수화 리스크가 낮다. Standard는 설정 옵트인.

---

## R4 방향 (확정)
prime 에 continual harness refinement 가 이미 구현되어 있다.
- rlm.harness = 프롬프트 노트 / 메모리 / 재사용 스킬 서술 / 서브에이전트 명세 /
  refinement 이벤트의 영속 상태 원장. "두 번째 실행 엔진이 아니다"라고 문서에 명시.
- 저장: 세션로컬 session-artifacts/<id>/harness/harness_state.json,
        전역 ~/.prime/agent/harness/
- /refine 은 현재 트라젝토리 리뷰 후 소규모 create/update/delete 편집을 적용.
  롤백은 before/after 스냅샷. 베이스 시스템 프롬프트는 불변, refinement 는 보충 상태.
- 에이전트 호출 가능: skills/refine/ (await refine.run(), 비블로킹)
- autoRefine 기본 활성, autoRefine.enabled: false 로 opt-out
- 확장점: extensions/custom-refinement.ts (플래너 교체), session_before_refine 훅,
  extensions/types.ts:650 (완료 이벤트)
→ evo-harness 는 신규 구현이 아니라 **논문과 이 구현의 델타**다.
→ A/B 대조군이 공짜로 생긴다: autoRefine off vs evopi 확장 루프.
→ 델타 후보 시드 4종 (../../../evo-harness-paper-summary.md §7): 실패 한정 반영 트리거 /
  배치 이중 컴파일(general·topic 2레벨) / 주입 예산+Select 모델 / **접지 피드백**(근거 최강).

## 평가 인프라 (ALFWorld 제외 → metaharness 전면 활용)
omp packages/metaharness = 통합 벤치마크 러너 + Harbor 실행 저장소 + REST/SSE + 대시보드.
- benchmarks.ts: BenchmarkDefinition{kind,label,metrics[]} /
  MetricDefinition{key,label,format,higherIsBetter} /
  BenchmarkTrace{status:pass|fail|error, reward, costUsd, durationMs, tracePath}
  기존 kind: harbor(success_rate) / edit(task_success_rate, edit_success_rate) /
             snapcompact(f1, exact_match)
- experiments.ts: job-name 접두사로 arm 그룹화. ArmSummary{passPct, costPerTask,
  meanTrialMs, projected}, ArmProjection{etaMs, totalCostUsd}
→ 코딩 트랙은 기존 kind:"edit" 재사용을 1순위로 검토. 별도 A/B 러너 개발 불필요.
→ A/B 4조건을 arm 으로 등록한다.

## A/B 실험 조건 (D7)
1. omp 원본  2. prime 원본 (autoRefine 기본값)  3. evopi (evo off)  4. evopi (evo on)
동일 모델·동일 파라미터 고정. 트랙: 코딩(metaharness edit 기반).

## .evopi 스키마 (prime 레이아웃 기준 + omp 흡수)
~/.evopi/agent/
  settings.json  auth.json  models.json  keybindings.json
  AGENTS.md  SYSTEM.md  (APPEND_SYSTEM.md)
  prompts/  skills/  harness/
  sessions/<root-session-id>.jsonl
  session-artifacts/<root-session-id>/
    kernel-state.dill  kernel-state.json  scheduled-jobs.json
    harness/harness_state.json
    sub-xxxxxxxx/...
  logs/                      ← omp ~/.omp/logs 흡수
  agent.db                   ← omp ~/.omp/agent/agent.db 흡수
  auth-gateway.token         ← omp ~/.omp/auth-gateway.token 흡수
  extensions/                ← prime 확장 + sandbox.json (examples/extensions/sandbox 계약:
                                전역 ~/.evopi/agent/extensions/sandbox.json,
                                프로젝트 .evopi/agent/sandbox.json)
프로젝트: .evopi/agent/{settings.json, sandbox.json, skills/, prompts/, commands/, tools/}
          (omp .omp/{commands,tools} 흡수)
벤더중립 경로 ~/.agents/skills/ 및 .agents/skills/: **유지** (GOAL 모드 선판정 — prime이
이미 지원, 제거 비용 > 유지 비용. 반증 발견 시에만 Phase 3 검사에서 [폴백])

### M9 Phase 시작 — auth-pool 백포트 트리거·정책 (2026-09-02)

- **트리거**: SPEC M9 "evopi-auth-pool (auth-storage 개명 + retry), prime auth.json
  1차/풀 2차 | 검증: 풀 로테이션 단위 테스트 + Bun 0건". CLAUDE.md 규칙에 따라 Phase
  시작 시 기록.
- **적용 정책 (Q1 [자동확정] 상속, DECISIONS §143-149)**: v1 백포트 = auth-storage(풀)
  ·auth-retry 로 한정. auth-broker/auth-gateway(Bun.serve 사이드카)는 v2 이연.
- **실측 (파일경로:라인)**:
  - omp `ai/src/auth-storage.ts` = 6934줄, `bun:sqlite`(auth/sqlite-credential-store)
    ·`Bun.hash`·`Bun.sleep` 다수 사용 → **전량 이식 불가·범위 밖**. 풀 개념(라운드로빈
    셀렉션 `#getNextRoundRobinIndex`:1729, 세션 해시 `#getHashedIndex`:1739,
    `#getCredentialOrder`:1751)만 추출.
  - omp `ai/src/auth-retry.ts` = 440줄, Bun 0건. 외부 의존: `@oh-my-pi/pi-utils`
    (extractHttpStatusFromError), `./error`(AIError.status/OAuthError/MissingApiKeyError),
    `./error/{auth-classify,flags,rate-limit}`(분류기). evopi ai 패키지엔 error 모듈
    부재(`ls ai/src` = oauth.ts·stream.ts뿐) → M8 방식으로 **compat 분류기 자족 이식**.
  - evopi `coding-agent/src/core/auth-storage.ts` = 1154줄, prime 파생. 저장 단위는
    provider당 단일 크리덴셜(`AuthStorageData = Record<string, AuthCredential>`:54),
    풀/라운드로빈 **없음**. `~/.evopi/auth.json`(FileAuthStorageBackend:109) 1차 소스.
- **[자동확정] M9 산출물 = `coding-agent/src/core/auth-pool/`** (신규, 자족 서브트리):
  ① `classify.ts` = auth-retry가 쓰는 분류기·에러클래스 compat(HTTP status 구동 +
     문서화된 usage-limit 마커 축약; provider별 텍스트 휴리스틱 전량은 범위 밖 —
     M8 "도달 가능 동작만 재현" 선례). ② `retry.ts` = auth-retry.ts 직접 이식
     (ApiKey/Resolver/withAuth/resolveNextAuthRetryKey a/b/c). ③ `pool.ts` =
     CredentialPool 라운드로빈+세션스티키(FNV-1a 순수-TS, Bun.hash 대체 — 내부
     로드분산용이라 온-와이어 아님) + prime auth.json 1차/풀 2차 브리지 resolver.
  - 검증: 풀 로테이션 단위 테스트(vitest) + `rg 'Bun\.|bun:|import.meta.dir'` 0건 +
    빌드된 dist 직접 호출 + REVIEW.md 체크포인트.

### M10 Phase 시작 — 권한 게이트·샌드박스 프로브 트리거·정책 (2026-09-02)

- **트리거**: SPEC M10 "permission-gate 내장 확장(intent 계층) + sandbox 프로브
  (enforcement 계층 게이트) | 검증: 현 환경 '불가' 감지 로그 + tool_call block 통합
  테스트(mock 세션) → R3 [자동확정], 실패 시 경고-only [폴백]".
- **적용 정책**: D4 2계층 권한 모델 — intent 계층(위험 명령 판정·차단)은 항상 로드,
  enforcement 계층(bwrap bash 래핑)은 프로브가 능력 확인 시에만. D3 [폴백] = OS
  샌드박스 불가 시 intent 계층 + 배포 컨테이너 경계로 대체.
- **실측 (파일경로:라인 · 실행 출력)**:
  - `bwrap --version` = exit 0 (`bubblewrap 0.9.0`) 이지만 기능 테스트
    `bwrap --ro-bind / / --unshare-user --die-with-parent true` = **exit 1**
    ("No permissions to create new namespace") → 존재-only 검사는 과대보고.
    `sandbox-probe.ts`가 실제 기능 실행으로 판정.
  - 빌드된 dist 직접 호출: `probeSandbox(true)` =
    `{"available":false,"kind":"bubblewrap","version":"bubblewrap 0.9.0",`
    `"detail":"bubblewrap present but unprivileged user namespaces are disabled`
    `by the kernel; OS sandbox unavailable"}` → **'불가' 감지 확인**.
  - no-UI block 결과 = `{"block":true,"reason":"Dangerous command blocked`
    `(no UI for confirmation): rm -rf /etc"}`; `isDangerousCommand("rm -rf /")`=true,
    `ls`=false, ipython escape `!sudo rm -rf /` 추출 확인.
- **[자동확정] R3 = block 기본 (게이트 tool_call 차단 통합 테스트 통과)**:
  `test/permission-gate.test.ts` **10/10 통과**(mock 세션이 ExtensionRunner.emitToolCall
  first-block 단락을 미러) — block 모드가 bash·ipython 위험 명령을 no-UI에서 차단,
  benign 통과, UI Yes/No 존중. 모드는 `EVOPI_PERMISSION_GATE`(block|warn|off)로
  세션당 1회 결정, D4 프로파일 매핑 strict/dev→block, eval→off.
  [폴백-경고만] 은 `warn` 모드로 상시 이용 가능(차단 없이 notify) — 판정 통과했으므로
  기본은 block 유지.

### M11 Phase 시작 — grounded-refine 접지 피드백 확장 트리거·정책 (2026-09-02)

- **트리거**: SPEC §4 evo 레이어 (D4+D7 흡수 + D1). PLAN §M11 "extensions-bundled/
  grounded-refine.ts — `session_before_refine` 훅: 외부 신호 파일(`EVOPI_FEEDBACK_FILE`
  — {task, status, detail?}) 읽기 → 실패 아니면 {skip:true}(D1), 실패면
  `<external_feedback>` 블록을 플래너 입력에 주입(D4, Minimal 기본). 신호원 미구성 시
  훅 미개입(폴백). `--evo on|off` 플래그 → autoRefine.enabled 매핑". CLAUDE.md 규칙에
  따라 Phase 시작 시 기록.
- **적용 정책 (R4 [자동확정] 상속, DECISIONS §151-177)**: v1 델타 = D4(+D7)+D1+D0.
  피드백 세밀도 기본 Minimal(pass/fail). 안전 구속 = evo-on arm 은 접지 신호 배선
  필수 (SPEC §4:56 금지 조항). evo off = 확장 미로드 → 기존 prime 경로 무변경.
- **실측 (파일경로:라인) — 주입 메커니즘 확정**:
  - 내장 플래너 `planRefinement`(refinement.ts:880)는 `options.instructions`를
    `<user_refine_instructions>`(refinement.ts:915)로만 읽는다. 훅 이벤트의
    `preparation.instructions`(agent-session.ts:8234)는 `options.instructions`의
    **복사본**이고 플래너 호출은 `options`를 그대로 넘긴다(agent-session.ts:8256-8266)
    → **preparation 변형은 플래너에 도달하지 않는 막다른 길**.
  - 따라서 D4 `<external_feedback>` 주입은 **`{proposal}` 반환(플래너 교체)** 경로로만
    가능(agent-session.ts:8248-8254가 proposal을 normalizeRefinementProposal 후 그대로
    적용). examples/extensions/custom-refinement.ts 와 동일 계약.
  - `SessionBeforeRefineResult`(types.ts:544): `{skip?, proposal?}`. skip →
    RefineSkippedError. proposal → normalizeRefinementProposal(refinement.ts:637,
    export됨) → apply-time 재검증. 훅은 `!rollbackId && hasHandlers` 일 때만 emit
    (agent-session.ts:8229) → 확장 미로드 시 short-circuit, 무변경.
- **[자동확정] M11 산출물 = `src/core/extensions/builtin/grounded-refine.ts`** (M10
  builtin 선례. PLAN "extensions-bundled/"는 evopi에 부재 → builtin/ + 팩토리 배선으로
  매핑, 기록):
  - 핸들러 3분기: (a) 신호 파일 미설정/판독 불가 → `undefined`(내장 경로 무개입, D1
    안전 폴백) (b) 신호 status가 실패 마커 아님 → `{skip:true}`(D1) (c) 실패 →
    `<external_feedback>` 주입 플래너(REFINEMENT_SYSTEM_PROMPT 재사용, export함) 호출
    → `{proposal}`(D4). 플래너 모델/인증 부재 시 `undefined`로 폴백.
  - 세밀도: 기본 Minimal(status·task만), `EVOPI_FEEDBACK_DETAIL=standard` 옵트인 시
    detail 텍스트 포함.
  - 팩토리 주입 가능 seam: `readFeedback`(신호 판독), `planner`(LLM 호출) — 단위 테스트용.
- **[자동확정] --evo 매핑 (spec §4:45-47 재해석, 기록)**: 플래그 부재 = prime 기본
  (autoRefine on, grounded 미로드) — prime out-of-box 동작·기존 계약 테스트 무회귀 유지.
  플래그 **명시 off** = 순수 대조군(autoRefine.enabled→false). 플래그 **명시 on** =
  grounded arm(확장 로드 + autoRefine on). seam = `EVOPI_EVO`(on|off) 환경변수 +
  settings `evo.enabled`(EVOPI_PERMISSION_GATE 선례). "off 기본값의 autoRefine 비활성"
  순수 대조군은 M12 eval arm 이 evo=off 를 명시 구성하여 달성(arm 설정 책임).
- 검증: (a) evo off 전 기능 (확장 미등록, hasHandlers false) (b) evo on + 모의 신호
  파일 skip/inject/no-signal/evo-off 단위 테스트 + 빌드 dist 직접 호출 스모크. SPEC
  §4:56 금지 조항(접지 미배선 evo-on arm 구성 금지) 준수.

### M12 Phase 시작 — metaharness 격리 트리거·정책 (2026-09-02)

- **트리거**: SPEC §7 평가 명세 / PLAN §M12 "omp metaharness → $EVOPI/eval/metaharness
  (사본), `bun install`, launch-args의 피실험 CLI 경로 조사(Q2) 후 evopi 지정 방법 문서화.
  검증: bun install 성공 + 러너/서버 기동 스모크 → R7 [자동확정] 기록". CLAUDE.md 규칙 준수.
- **적용 정책 (R7 상속, DECISIONS §37)**: 제품=node 전용, metaharness=bun 격리. 코딩 트랙은
  기존 kind:"edit" 재사용(별도 A/B 러너 미개발). ALFWorld 범위 밖.
- **실측 (파일경로:라인)**:
  - **Q2 판정(피실험 CLI spawn 방식)**: edit 어댑터 `adapters/edit/runner.ts:39` =
    `CLI_PATH = Bun.fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent/cli"))`
    — 피실험 CLI 경로는 `@oh-my-pi/pi-coding-agent` 패키지의 `cli` export 로 해석.
    `:115` "Use in-process agent sessions instead of spawning CLI subprocesses.
    Default: **true**" — 기본은 in-process(RpcClient + typescript-edit-benchmark/
    in-process-client), 서브프로세스 spawn 은 opt-in. → **evopi 지정 = 해당 의존을
    `@evopi/pi-coding-agent/cli` 로 재지정**(STEP 14 A/B arm 배선).
  - metaharness 는 구조적 bun 전용: `import.meta.dir`(launch-args.ts:11 등), `Bun.which`
    (launch-args.ts:56), `Bun.fileURLToPath`(runner.ts:39), `bun test`, `.md` text 로더
    → node 이식 대상 아님(R7 격리 정당).
  - 의존 그래프: `catalog:` → @oh-my-pi/{hashline,pi-agent-core,pi-ai,pi-catalog,
    pi-coding-agent,pi-utils}, `workspace:*` → @oh-my-pi/typescript-edit-benchmark,
    external → @stencil-hq/vibemon·clsx·d3-scale·d3-shape 등.
  - npm 게시 실측(2026-09-02, registry HTTP): @oh-my-pi/{pi-coding-agent,pi-catalog,
    pi-utils,pi-agent-core,pi-ai,hashline} = **18.1.2 게시(200)**, typescript-edit-benchmark
    = **404(미게시 — workspace 전용)**, pi-metaharness = 404(private).
  - evopi 보유 패키지(@evopi/*): pi-agent-core, pi-ai, pi-coding-agent, hashline,
    mnemopi, pi-natives-loader, pi-tui. **미보유(v2/eval 범위): pi-catalog(80종 v2),
    pi-utils, typescript-edit-benchmark**.
- **[자동확정] M12 격리 방식**: `eval/` 를 소형 bun 워크스페이스로 구성 — metaharness +
  typescript-edit-benchmark(로컬 사본, npm 미게시) 를 멤버로, catalog 에서 @oh-my-pi/*
  = 18.1.2(npm 게시본) 고정, external 은 npm. bun install 로 격리 설치·러너 기동 스모크.
  실 A/B 는 STEP 14 에서 in-process 클라이언트를 `@evopi/pi-coding-agent` 로 재지정(Q2).
  bun 은 제품(node) 그래프와 완전 분리(eval/ 하위) — R7 "metaharness=bun 격리" 충족.

### R7 [자동확정] — 제품 node / metaharness bun 격리 확정 (2026-09-02, M12)

- **적용 기준** (GOAL 모드 정책): 격리 사본에서 `bun install` 성공 + 러너 기동 스모크
  통과 시 [자동확정]. 제품 `rg 'Bun\.'` 게이트는 STEP 15 최종.
- **실행 출력**:
  - `eval/` 소형 bun 워크스페이스(catalog @oh-my-pi/*=18.1.2 npm, 로컬 멤버
    typescript-edit-benchmark) 에서 `bun install` = **189 packages installed, exit 0**
    (`Resolved, downloaded and extracted [800] / Saved lockfile`, bun.lock 61096B).
  - `bun adapters/edit/cli.ts --help` = **exit 0** (Edit Benchmark 사용법 렌더).
  - `bun adapters/edit/cli.ts --check-fixtures` = **"Fixtures OK"**, exit 0.
  - Q2 해석 실측: `import.meta.resolve("@oh-my-pi/pi-coding-agent/cli")` =
    `eval/node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts` (exit 0) — 피실험 CLI
    경로 확인. 기본 in-process(cli.ts:259)·서브프로세스(runner.ts:1150 cliPath) 양쪽
    모두 `@oh-my-pi/pi-coding-agent` 해석에 의존.
- **결론**: metaharness 는 `import.meta.dir`/`Bun.which`/`Bun.fileURLToPath`/`bun test`/
  `.md` text 로더로 구조적 bun 전용 → node 이식 불가·불필요. bun 1.4.0 으로 격리 실행
  확인. 제품(packages/, node)과 eval/(bun)은 상호 import 0건(격리 검증). **원본 omp
  레포는 cp -r 읽기만, 무변경**. evopi 지정 방법(Q2 override 레시피)은 eval/README.evopi.md,
  실 A/B arm 배선·faux 스모크는 STEP 14.

### M13 Phase 시작 — omp 스킬 md 3종 이식 트리거·정책 (2026-09-02)

- **트리거**: PLAN §M13 "omp .omp/skills/{semantic-compression,system-prompts,
  tool-prompt-optimization} → packages/coding-agent 스킬 배포 경로. 검증: 스킬 로더
  목록에 3종 노출". CLAUDE.md 규칙 준수.
- **적용 정책**: 번들 스킬은 `getBundledSkillsDir()`(config.ts:462 = 소스 체크아웃 시
  `packages/coding-agent/skills/`) 하위를 `collectAutoSkillEntries`(package-manager.ts:415)
  로 **자동 발견** → 3개 디렉터리 복사만으로 로더 목록 노출(매니페스트 편집 불필요).
  SKILL.md 프론트매터(name/description)는 evopi 로더 규약과 동일 확인.
- **실측**: omp 원본 = `oh-my-pi/.omp/skills/`(읽기 전용). semantic-compression=
  SKILL.md, system-prompts=SKILL.md+small-models.md, tool-prompt-optimization=
  SKILL.md+scripts/. 순수 프롬프트 엔지니어링 가이드(브랜드 비의존) — 복사 후
  `.omp`/`.prime` 잔재 grep 게이트.
- **검증**: 스킬 로더가 3종을 목록에 노출(직접 호출 스모크).

#### M13 이식 중 발견·조치 (2026-09-02)

- **[자동확정] 프론트매터 YAML 정합**: `tool-prompt-optimization/SKILL.md` 의
  description 이 `Two halves: (1) …` 처럼 인용부호 없는 스칼라 안에 `: ` 를 포함 →
  번들 스킬 엄격 파싱(`loadSkillsFromDir`)에서 "Nested mappings are not allowed"
  경고로 드롭. omp 에서는 이 스킬이 **저장소 스킬(.omp/skills)** 이라 번들 검증
  (`builtin-skills.test.ts "loads all bundled skills without diagnostics"`)을 통과할
  필요가 없었음. evopi 는 이를 **번들 스킬**로 승격하므로 프론트매터를 유효 YAML 로
  만들어야 함 → description 값을 큰따옴표로 감쌈(텍스트 원문 100% 보존, 파싱값 불변).
  조치 후 `loadSkillsFromDir` = 16 skills / **diagnostics 0**.
- **[자동확정] 사전존재 브랜딩 결함 수정(소스 검증)**: `builtin-skills.test.ts:318`
  가 `scripts/pack-prime-agent-release.mjs` 를 읽었으나 evopi 는 이미
  `scripts/pack-evopi-release.mjs` 로 개명(내용 line 207 `"skills"` 포함 확인). 이
  실패는 M13 복사와 무관한 개명 잔재 → 파일명 참조만 소스 검증 후 정정(맹목적 sed
  아님, 대상 변수=스크립트 파일명 1건만). 나머지 test 브랜딩 스윕은 STEP 15 유지.
- **caveat 기록**: 개명된 probe 스크립트(`scripts/probe.ts`, `probe-builtin.ts`)는
  evopi 미노출 표면(`@evopi/pi-catalog` 부재, `toolWireSchema`/`arkToWireSchema`/
  `getBundledModel` 미제공, coding-agent `config/settings`·`tools` 서브패스 export 없음)
  을 import → **v2 활성화 대상 참조 자료**. SKILL.md 방법론 본문은 브랜드 비의존·즉시 사용 가능.

### M14 Phase 시작 — 설치 스크립트 F1 격리 리허설 트리거·정책 (2026-09-02)

- **트리거**: SPEC §3 M14 "설치 스크립트 / F1 격리 리허설 / STEP 15 체크". F1 완료
  조건(§1) = `env HOME=/tmp/evopi-test bash install.sh` 성공 + `~/.evopi` 외 상태 생성
  0건. F3 = 격리 HOME 리허설에서 `.omp`/`.prime` 미생성.
- **적용 정책 [자동확정 예정]**: 이번 사이클은 **릴리스 미게시**(git/publish 제외).
  install.sh 는 `main()`(install.sh:62)에서 미치환 센티널
  `__EVOPI_DOWNLOAD_BASE_URL__` 감지 시 파일시스템 접근 전 exit 1. 따라서 실제
  end-to-end 설치(tarball 다운로드·npm -g)는 게시본에서만 가능 → **STEP 15/실릴리스로 이연**.
  이번 리허설의 검증 가능 계층:
  1. `bash -n install.sh` 문법 게이트(M3 조건).
  2. 브랜딩/경로 게이트: install.sh 내 `\.omp`/`\.prime`/미개명 `prime`/`omp` 잔재 grep 0건.
  3. **격리 리허설**: 격리 HOME 으로 실행 → 미설정 URL 가드로 조기 종료, HOME 하위
     `.evopi`/`.omp`/`.prime`/`.local` 상태 0건 확인(F1 "~/.evopi 외 0건" + F3 확증).
  4. 보강: 더미 `EVOPI_DOWNLOAD_BASE_URL` + `EVOPI_INSTALLER_PLAIN=1` 로 preflight~
     다운로드 실패 경로까지 실행, 임시파일은 `$TMPDIR` 한정·HOME 무오염 재확인.
- **근거 규칙**: 실제 명령 실행+출력 첨부(격리 HOME `find` 스냅샷).

### STEP 15 사전 스캔 + 발견 결함 (2026-09-02)

- **R7 `Bun.` 게이트(제품)**: `rg 'Bun\.' packages/*/src` = **6건 전부 주석**
  (natives-loader/hashline/auth-pool 이 대체한 상류 Bun API 설명 문구). **라이브 호출 0건 → PASS**.
- **F3 config-path 게이트(제품 src)**: `.omp` = 0. 실제 `~/.prime/config.json` 읽기 2곳:
  - `prime-inference-auth.ts:90`(기 승인 interop).
  - `ai/src/env-api-keys.ts:209` `getPrimeTeamId()` — **외부 Prime CLI 의**
    `~/.prime/config.json` 에서 `team_id` 로드(F5 모델 커넥팅). :90 과 동일 부류의
    **외부 CLI interop → 개명 금지(제2 승인 지점)**. 나머지 `.prime`/`primeintellect`
    히트는 서비스 식별자(api.primeintellect.ai, `primeTeam` 크레덴셜 필드)로 정당.
- **`oh-my-pi`/`prime-agent` (제품 src)**: 38건 = 전부 이식 출처 주석 또는 실제 상류 npm
  패키지명(`@oh-my-pi/pi-natives-<plat>` — require 대상, 개명 시 파손) → 정당.
- **[결함 수정] 커널 표시 MIME 계약 불일치(리브랜딩 누락 버그)**: 소비자
  (`src/core/kernel/shared.ts:80/83/86` DIFF/ATTACHMENT/AGENT_MESSAGE_DISPLAY_MIME)는
  이미 `application/vnd.evopi.*` 로 개명됐으나, **생산자 파이썬 스킬**은
  `application/vnd.prime-agent.*` 방출 유지 → `repl-manager.ts:690` 이
  `data["vnd.evopi.attachment+json"]` 조회 시 미스 → diff/attachment/agent-message
  표시 디스패치 **파손**. 소스 양측 확인 후(맹목적 sed 아님) 생산자 3종을 `vnd.evopi.*`
  로 정렬: `skills/{agent-message,attach-image,edit}/…`. 테스트 픽스처
  `kernel-attach-image-skill.test.ts:267` 도 실계약(evopi MIME) 방출로 정정
  (소비자 :690→:692 "attachment dropped" 경로는 evopi MIME 키에만 반응 확인).
  검증: 빌드 exit 0, src+dist 6 리터럴 + 소비자 3 상수 = **전부 vnd.evopi 균일**,
  py_compile OK. 라이브 커널 라운드트립은 STEP 15 커널 부팅 검증과 합류.

### STEP 14 Phase 시작 (2026-09-02)

- **트리거**: SPEC §3 M12 완료 후 §7 코딩 트랙 A/B 평가 배선. 4-arm 설계 +
  키 부재 시 faux 프로바이더 스모크(SPEC §7:78) + RESULTS.md.
- **arm 배선 정책 [자동확정]**:
  - arm = 잡네임 규약. `experimentOf(jobName)`=첫 `-` 토큰, `armOf(jobName)`=나머지
    (metaharness `src/experiments.ts:59-68`); launch=`POST /api/experiments/:id/arms`
    `AddArmRequest{arm,model,extraArgs?,...}`(server.ts:53-64), jobName=`${expId}-${arm}`
    (server.ts:163). edit 어댑터 argv=`bun adapters/edit/cli.ts --model <m> --output
    <jobDir>/result.json`(server.ts:400-406), extraArgs 후행 결합(:417).
  - **arm별 env 필드 부재**: 스폰 env=`{...process.env}`(server.ts:490), per-arm env
    필드 없음. 따라서 arm 구분은 (a) 모델/패키지 override, (b) 잡 실행 전 프로세스
    env 세팅으로 표현. per-arm env 는 어댑터 프로세스당 1개라 안전(러너 save/set/restore
    패턴 runner.ts:1107-1134 와 동종). per-task env 는 32-way 동시성에서 불안전 → 금지.
  - **4 arm (SPEC §7:75)**:
    - `evopi-omp`: 게시 omp `@oh-my-pi/pi-coding-agent` 그대로(대조 상류).
    - `evopi-prime`: prime 스켈레톤 대조(상류 prime 계열 설정).
    - `evopi-evooff`: evopi 빌드 + `EVOPI_EVO=off`. autoRefine.enabled→false, 순수 대조군.
    - `evopi-evoon`: evopi 빌드 + `EVOPI_EVO=on` + **`EVOPI_FEEDBACK_FILE` 배선 필수**
      (SPEC §4:56 / R4: 접지 신호 미배선 evo-on arm 금지). 신호=러너 result 이벤트
      (`{type:"result",success}` runner.ts:1439-1448)에서 `{task,status,detail?}` JSON 생성.
  - **evopi 패키지 리포인트**: bun `overrides` `"@oh-my-pi/pi-coding-agent":
    "file:../packages/coding-agent"`(eval/README.evopi.md 레시피, M12 Q2).
- **키 부재 정책 [폴백→자동확정]**: 실 API 키는 셸 export 전용 제약상 샌드박스에 부재.
  SPEC §7:78 에 따라 **실 A/B 실행 SKIP**, faux 프로바이더 스모크로 대체:
  1. **eval 측 프리미티브 스모크**: `@oh-my-pi/pi-ai/providers/mock`
     (`registerMockApi`/`createMockModel`)로 `completeSimple`(stream.ts:1716) 키 없이 구동,
     canned RefinementProposal JSON 왕복(플래너 파싱 가능) 확인 —
     `eval/faux-provider-smoke.ts` → PASS.
  2. **제품 측 evo-on D1 로직 스모크(키 무관)**: `grounded-refine.ts` 의 순수 함수
     (`readFeedbackFromEnv`/`isFailureStatus`/`buildFeedbackBlock`)를 실제 제품 소스로
     직접 호출. 단 `defaultGroundedPlanner`(grounded-refine.ts:113)는 `@evopi/pi-ai`
     의 `completeSimple` 를 쓰고 auth 부재 시 `undefined` 반환(:126-128)하여 built-in
     플래너로 폴백 → **제품 내 LLM 주입(D4)은 키 없이는 도달 불가**(정직 기록). evopi
     `@evopi/pi-ai` 에는 mock 프로바이더 없음(`rg createMockModel packages/ai/src`=0).
- **근거 규칙**: 실행+출력 첨부(두 스모크 stdout), 파일경로:라인 인용.

---

## STEP 15 Phase 시작 — 최종 브랜딩 스윕 (테스트·문서), 2026-09-02

- **트리거**: F3 게이트(코드에 `.omp`/`.prime` 잔존 시 실패) 및 브랜딩 일관성.
  적용 정책: CLAUDE.md 「브랜딩 개명은 맹목적 sed 금지, 변수별 소스 확인 후 개명」.
- **개명 원칙 [자동확정]**: 각 토큰마다 (a) src 의 실제 EVOPI_ 대응 심볼/문자열을 먼저
  확인하고 (b) 자기완결 테스트-내부 문자열/외부 Prime 서비스 식별자는 보존한다.
  개명 후 대상 스위트를 실행해 red→green 을 확인한다(맹목 sed 아님).
- **테스트 env/심볼 개명 (40파일)**: `PRIME_AGENT_*` → `EVOPI_*`. 개명 전 각 베이스가
  src 에 EVOPI_ 홈이 있음을 확인:
  - env: `EVOPI_CODING_AGENT_DIR`(config.ts:526), `EVOPI_SESSION_DIR`(동적
    `${envPrefix}_SESSION_DIR` config.ts:503 — 리터럴 부재 정상),
    `EVOPI_KERNEL_VENV`/`_PYTHON`(bootstrap.ts), `EVOPI_TELEMETRY`,
    `EVOPI_TRACES_BASE_URL`/`_API_KEY`, `EVOPI_MAX_CONCURRENT_KERNEL_BOOTS`(boot-gate.ts),
    `EVOPI_INTERNAL_*`(daemon-worker-protocol.ts 등).
  - 심볼: `PRIME_AGENT_META_NAMESPACE`→`EVOPI_META_NAMESPACE`(acp-meta.ts:13),
    `PRIME_AGENT_TRACES_PROVIDER_ID`→`EVOPI_TRACES_PROVIDER_ID`(prime-inference-auth.ts:20).
    **보존**: `PRIME_INFERENCE_PROVIDER_ID="prime-inference"`(:18, 외부 Prime Inference
    provider id) — `PRIME_AGENT_` 토큰이 아니므로 sed 미접촉, 실제 미접촉 확인.
  - 픽스처 전용(`PRIME_AGENT_TEST_*`/`_STRESS_WORKERS`/`_OWNED_TEST`): src 리더 0건
    (제품 미독), setter+reader 양측 동시 개명으로 자기완결성 유지.
- **제품 출력 비교 문자열 개명 (red→green 확인)**:
  - `evopi-assistant-N`(acp-events.ts messageId), `evopi-rlm-`(agent-session.ts),
    `evopi.refinement`/`evopi.update_restart`/`evopi.update_complete`(네임스페이스),
    `evopi.daemon`(=`DAEMON_PROTOCOL_NAME` daemon-protocol.ts; 핸드셰이크 검증
    `candidate.protocol?.name===DAEMON_PROTOCOL_NAME` 이므로 테스트 페이로드 필수 개명).
  - 인간 브랜드어 `Prime Agent`/`PRIME Agent` → `evopi`(제품은 소문자 "evopi" 통일:
    "the evopi daemon", "Welcome to evopi", "brew upgrade evopi" 등). 외부 보존:
    `Prime Inference`/`Prime CLI`/`Prime Intellect`/`Prime whoami`/`Prime team`.
  - CLI 커맨드명 `prime-agent <sub>` → `evopi <sub>`(bin=evopi, `APP_NAME=evopi`
    config.ts, `isSelfUpdateSource` 는 APP_NAME 수용). user-agent `evopi/${ver}`.
  - **로고 모듈**: `src/themes/prime-logo.js`→`evopi-logo.js`, 심볼
    `PRIME_BUTTERFLY_LOGO`→`EVOPI_LOGO`(login-dialog/prime-onboarding-splash 테스트).
  - **테마명 기능 버그(브랜딩 유발)**: theme-adaptive.test.ts `beforeEach` 가
    `initTheme("prime")` 호출 → "prime" 테마 부재로 dark(#343541) 폴백 →
    색상 넛지 픽스처(evopi userMsgBg=#1a1a1f) 불일치 → `initTheme("evopi")` 로 수정,
    18/18 green. (단순 문자열 아님, 잘못된 테마 로드로 인한 실패였음.)
- **테스트 자기완결/무관 잔존(개명 안 함, 근거)**: `parseSsListeners(stdout,"prime-agent")`
  (동일 fake stdout 필터, 임의 프로세스명), `/tmp/prime-agent.sock`·`prime-agent.tgz`
  (클라이언트 임의 경로/픽스처 파일명), 다수 `prime-agent-<suffix>` 임시 세션/에이전트명.
- **문서 스윕 (packages/coding-agent/docs/*.md 34파일 + docs.json + README.md)**:
  - 개명: `PRIME_AGENT_*`→`EVOPI_*`(23), `.prime/agent`→`.evopi/agent`(84),
    `prime-agent`(커맨드)→`evopi`, `prime-agent-debug.log`→`evopi-debug.log`,
    `pack-prime-agent-release.mjs`→`pack-evopi-release.mjs`(실존: 루트 scripts/),
    `prime-agent.sh`→`evopi.sh`(실존: 루트), `prime-agent/install.sh`→`evopi/install.sh`,
    "Prime Agent"→"evopi". docs 내 `.prime/config.json` 0건(개명 안전).
  - **보존(외부/귀속)**: `github.com/PrimeIntellect-ai/prime-agent/*`(리포·CI·discussion
    URL), `raw.githubusercontent.com/.../prime-agent/main/*`(스키마 URL),
    `cd prime-agent`(업스트림 클론 디렉터리), README 학술 인용 bibtex(`Prime Agent:
    A Self-Improving RLM Harness`), `app.primeintellect.ai` 호스트, R2 다운로드 URL.
  - **수용 잔존(정직 기록)**: dev-from-source 절이 업스트림 클론(`PrimeIntellect-ai/
    prime-agent`)+`cd prime-agent` 를 유지한 채 런처를 `evopi.sh` 로 표기 →
    공개 evopi 리포 URL 부재로 URL 은 조작하지 않음(귀속 유지). 사소한 불일치.
- **3번째 sanctioned interop 확인**: `.prime/config.json` 읽기는 3곳
  (prime-inference-auth.ts:90, ai/env-api-keys.ts:209, ai/scripts/generate-models.ts:384)
  — 모두 외부 Prime CLI interop, 개명 금지(F3 예외).
- **F3 게이트 PASS**: `packages/*/src` 내 evopi-소유 `.omp`/`.prime` 경로 리터럴 0건
  (3 interop 제외). 빌드 후 dist/skills 갱신 확인(websearch.py `.prime` 잔존 해소).
- **rg `-r` 재발 주의**: `rg -r`(replace 플래그)를 나열에 쓰면 가짜 식별자 출력.
  나열은 `-nN`/`-oN`, 검증은 `sed`/`cat -A` raw read.
- **검증(실행+출력)**: 비-hang 테스트 배치 222파일 2937 pass / 4 fail. 4 fail 모두
  **비-브랜딩**: config.test.ts:406 + tools.test.ts EACCES×2 = **root(uid 0) 환경**
  (chmod 0o444/0o222/0o500 무시로 미쓰기/EACCES 경로 미발동), oauth-selector 정렬 1건
  = 선존(외부 "Prime Inference" 텍스트, 파일 미편집). kernel-bootstrap 21/21 pass
  (EVOPI_KERNEL_VENV/PYTHON 검증). npm run build exit 0.

## [체크포인트] 2026-09-02 — Prime 종속 해소(온보딩/로그인/기본모델) + 랜딩 로고 EVO 강조

트리거: 사용자 지시 "prime intellect에 종속되지 않고 omp/opencode처럼 자유로운 형태"
+ "온보딩시 prime 종속 부분·관련 구현 점검·수정"(GOAL) + "랜딩 아스키아트 evo 강조 변형".

### 정책 판정 — DEMOTE(강등) not DELETE(삭제)
- prime-inference 는 **다수 provider 중 하나의 peer** 로 유지. 강제/기본/상단고정 금지.
  근거: sanctioned interop 3곳(prime-inference-auth.ts:90, ai/env-api-keys.ts:209,
  ai/scripts/generate-models.ts:384)은 개명·삭제 금지 예외(F3). 사용자가 실제로 Prime
  모델을 선택할 때만 활성화되는 코드(onboarding.ts prime-cli 스플래시 게이트,
  prime-inference-model-selection, agent-traces)는 결정지점 강제성이 없어 존치.

### 적용 변경 (src 5)
- `interactive-mode.ts` runOnboardingFlow: 강제 Prime 로그인 제거 → 미구성 시
  `showConfigurationMenu("providers")`(=`/login` 동일 표면) 호출. preselect 없음.
- `oauth-selector.ts` sortProviders: Prime 상단고정 블록 제거 + import 제거. 순위는
  getProviderSortRank(configured0/stale1/unconfig2) → compareAuthSelectorProviders
  (oauth<api_key, then name.localeCompare). 특권 provider 없음.
- `model-resolver.ts` findPreferredDefaultModel: Prime-first 분기 제거. registry 순서
  (defaultModelPerProvider: amazon-bedrock→anthropic→openai→…→prime-inference[idx5])대로
  첫 configured provider 기본모델 선택. PRIME_INFERENCE_DEFAULT_MODEL_ID(z-ai/glm-5.2)
  상수는 catalog 용도로 존치(line 26 사용).
- `prime-onboarding-splash.ts`: continueActionLabel 기본값
  "login with Prime Intellect"→"connect a provider". 브랜드라인 "Welcome to evopi" 유지.

### 테스트 갱신 (3) — 전부 pass
- oauth-selector.test.ts: "sorts Prime first…"→"does not privilege Prime Inference in
  login ordering"(기대 [Anthropic,OpenAI,Prime Inference]); stale-vs-unconfigured 는
  amazon-bedrock 픽스처 제거(ambient AWS_BEARER_TOKEN_BEDROCK 로 configured 판정되는
  env-fragile) → github-copilot(oauth, 무-ambient) 로 교체, OpenAI<Prime<Copilot 검증.
- model-resolver.test.ts: Prime-first 기대 → anthropicModel(claude-opus-4-7, registry상
  prime 선행) 기대로 변경, 근거 주석.
- prime-onboarding-splash.test.ts: "connect a provider" 문구 반영, 테스트명
  "invokes the continue action on confirm".

### 랜딩 로고 (Phase 3)
- `evopi-logo.ts` EVOPI_LOGO: 추상 chevron 엠블럼 → **풀블록 "EVO" 워드마크**(rows5-9)
  + 상승 chevron 악센트(rows2-3, evolve 모션) + iteration baseline(row11). 10행, maxW=25
  (≤32 제약 충족). 단일폭 글리프(▄ █ ▀)만.
- `install.sh` evopi_logo_line() rows2-11 바이트 동기(빈 행 4·10 은 `: ;;`). 스크립트로
  두 파일 동시 생성해 정렬오차 배제.
- 스플래시/로그인 테스트는 EVOPI_LOGO 를 동적 참조(`.split("\n")[0].trim()`)라 내용
  변경 무영향. 65/65 pass.

### 검증
- tsgo -p tsconfig.build.json exit 0. affected 4파일 65/65 pass
  (prime-onboarding-splash, oauth-selector, model-resolver, login-dialog).

### 미결(사용자 인가 대기)
- gh-pages 재게시: 새 로고를 반영한 install.sh 재배포는 push 필요 → 이번 사이클 git
  commit/push 제외 정책(CLAUDE.md)에 따라 **미실행**. 라이브 `curl|sh` 배너는 재배포
  전까지 구 로고. 인가 시 pack-evopi-release + gh-pages 오버레이로 갱신.
- src/test 변경 9파일 未커밋(정책상 유지). 체크포인트만 기록.

### [배포완료 갱신] 2026-09-02 — v0.9.2 게시 (위 "미결" 해소)
사용자 인가 "진행" 수신 → 커밋·배포 실행.
- **버전 정책**: v0.9.1 in-place 덮어쓰기 대신 **0.9.2 범프**(불변성 보존). 로고는
  install.sh 배너 + 타르볼 TUI 스플래시 양쪽에 존재하므로 타르볼 재빌드 필요 →
  범프가 정도(正道). `npm version 0.9.2 -ws` + sync-versions(7 내부 dep 범위 갱신),
  무-reinstall(pack 은 --version 으로 tarball dep URL 계산, node_modules 무관).
- **빌드/팩**: npm run build exit 0(신 로고 dist 반영, 구 emblem 제거 확인). pack
  --version 0.9.2 → 6 타르볼, 내부 @evopi/* 전부 Pages v0.9.2 URL 재작성 확인.
- **게시**: gh-pages 오버레이(v0.9.1 보존 + v0.9.2 추가), install.sh 재템플릿(연속형
  센티널만, 가드 유지), stable→v0.9.2, latest.json 갱신. push `f8a8f8f..8d4519c`.
  main push `574c8d2`(src+범프; models.generated.ts 는 빌드시 카탈로그 리프레시 동반).
- **실검증(격리 prefix)**: `curl … install.sh | sh` → `evopi-0.9.2.tgz: OK`,
  194 packages, exit 0, `evopi --version`=0.9.2, bin→dist/bundle/cli.js. 신 로고가
  설치 dist + 번들 청크(chunk-DQUBS5H4.js, ▀/▄/█ 이스케이프형)에 존재,
  구 emblem 부재. 라이브 latest.json=v0.9.2 + install.sh 신 로고 HTTP 200.
- **정리**: 임시 site/gh-pages clone/install prefix/release publish 제거.

## [체크포인트] 2026-09-02 — Databricks serving model provider 추가

트리거: 사용자 지시 — Anthropic 설정(Claude Code 방식: ANTHROPIC_BASE_URL +
ANTHROPIC_AUTH_TOKEN=Bearer)을 따르되, BASE_URL/AUTH_TOKEN 을 입력받아 Databricks
에서 모델을 직접 조회 후 연결.

### 설계
- **provider id `databricks`**, api `anthropic-messages`, baseUrl =
  `{workspace}/serving-endpoints/anthropic`, 모델 id = serving endpoint 이름.
- **모델 조회**: `GET {workspace}/api/2.0/serving-endpoints` (Bearer) →
  이름에 "claude" 포함 endpoint 필터 → 모델 등록.
- **모델 지속화**: prime private-models 캐시 패턴 준용 — `databricks-models.json`
  (models.json 옆). models.json 직접 재작성 회피(사용자 주석 보존).
  models.json 의 databricks 설정이 있으면 그것이 우선(request config 후기 set 승리).
- **인증**: 토큰은 auth.json(api_key) 저장, request 는 registry providerRequestConfig
  `authHeader:true` → `Authorization: Bearer` + `x-databricks-use-coding-agent-mode:
  true` 헤더. /logout 시 모델은 남고 unconfigured (apiKey 없는 config 는
  hasConfiguredProviderRequestAuth=false — model-registry.ts:1230).
- **pi-ai 일반 개선**: anthropic provider 기본 분기에서 커스텀 Authorization 헤더
  존재 시 `apiKey: null` → x-api-key 미전송 (Claude Code ANTHROPIC_AUTH_TOKEN 계약과
  동일). Authorization 부재 시 기존 x-api-key 경로 그대로(회귀 가드 테스트).
- **모델 파라미터 휴리스틱**: endpoint 메타에 모델 한계 부재 → 이름 기반:
  claude-3.x/legacy → reasoning false·maxTokens 8192, 그 외 → true·32000,
  contextWindow 200k, cost 0(DBU 과금). 표시명 "databricks-claude-sonnet-5"→
  "Claude Sonnet 5".
- **UX**: /login 메뉴에 Databricks 상시 노출(모델 조회 전이므로 Serper 패턴 수동
  추가+중복가드). DATABRICKS_HOST/TOKEN env 는 빈 입력 시 기본값.

### 변경 파일
- 신규 `src/core/databricks-auth.ts` (정규화/조회/캐시), `test/databricks-auth.test.ts`
  (11), `packages/ai/test/anthropic-bearer-auth.test.ts` (2).
- `src/core/model-registry.ts` (loadModels 통합 + storeDatabricksModelCache),
  `src/modes/interactive/auth-flows.ts` (runDatabricksLogin + 메뉴 + 라우팅),
  `src/core/provider-display-names.ts` (+databricks),
  `packages/ai/src/providers/anthropic.ts` (Bearer-only 분기),
  `docs/providers.md` (Databricks 절).

### 검증
- tsgo: ai/coding-agent 둘 다 exit 0. 신규 13 테스트 pass. 회귀 배치
  (auth-flows/auth-storage/model-registry/oauth-selector/login-dialog/
  model-resolver + ai anthropic 4파일) 209 pass / 5 skip / 0 fail. 빌드 exit 0.
- **미검증(정직 기록)**: 실 Databricks workspace 대상 e2e (토큰 없음). REST 응답
  포맷·인증 계약은 fake fetch/SDK mock 으로 검증. 실 연결 검증은 사용자 토큰
  보유 환경에서 /login → Databricks 로 수행 필요.

## [Phase 시작] 2026-09-02 — 초기 목표 정합성 감사 (GOAL: 초기 의도 대비 점검)

- **트리거**: 사용자 /goal — "oh-my-pi 기반 + prime-agent RLM Harness + arXiv
  2608.05446v1 개념의 pi agent 하네스 CLI"라는 초기 목표 대비 GOAL→DECISIONS 전
  과정 점검. base 가 pi→prime 으로 바뀐 것은 인지: 원 의도 = **pi 생태계 유지** +
  prime 의 **RLM 하네스·python interpreter 직접 검증** 포함이 제대로 됐는지 검증,
  수정 가능하면 방향성 계획 작성.
- **적용 정책**: 판정은 메인 컨텍스트가 수행(서브에이전트는 근거만). 근거는
  파일경로:라인. 산출물 = docs/design/AUDIT-initial-goal.md (판정표 + 갭 + 수정
  방향 계획). 점검 결과를 README 에도 반영 후 커밋·재배포(사용자 지시).
- **선행 실측**: arXiv 2608.05446 = "EvoHarness-RL: Learning Self-Evolving Runtime
  Harness for Long-Horizon LLM Agents" (SFT+GRPO 로 하네스 운용 정책 학습, ALFWorld
  평가) — 레포가 실제 채택한 2608.15071 "EVO-HARNESS: Context-to-Harness Skill
  Compilation for Self-Evolving Agents" (frozen solver, one-shot, 학습 없음)와
  **상이한 자매 논문**(공저자 Tianxin Wei 중복). 판정 쟁점으로 등재.

### [감사 판정] 초기 목표 정합성 감사 완료 + P1a/P3 소급 확정 (2026-09-02)

산출물: **docs/design/AUDIT-initial-goal.md** (기준 4종 판정표 + GAP 4건 + 수정 방향
계획 P1-P4). 요지: C3 RLM 하네스·C4 python 직접 검증 = PASS, C2 pi 생태계 = 구조
PASS/실효 PARTIAL(휴면 백포트 dialect·auth-pool·mnemopi 3종 + 무판정 4종), C1 논문 =
15071 채택(사용자 의도 05446 과 상이, 경위 무기록).

- **[소급 확정 — P1a] 논문 기반 = arXiv 2608.15071 (EVO-HARNESS, skill compilation)**.
  사유: ① evopi 는 frozen solver(파라미터 고정 상용 모델) CLI — 05446(EvoHarness-RL)의
  본체인 SFT+GRPO 하네스 정책 학습은 구조적으로 이식 불가. ② 05446 평가 환경
  ALFWorld 는 GOAL.md:17 이 명시 제외. ③ 15071 의 frozen-solver·one-shot 전제가 제품
  조건과 정합. 05446 의 무학습 이식 가능 개념 3종(Belief/Progress/Experience 뷰,
  harness annealing, cost-aware 주입)은 **v2 evo 델타 백로그**로 등재(AUDIT P1b).
- **[자동확정 — P3] GOAL.md:14-15 "모델 커넥팅 합집합" 잔여 4종 처리**:
  `oneshot-retry` = **v1.x 이식 후보 1순위**(소형, Bun 경미 — 착수 시 M-phase 기록).
  `usage`·`provider-details`·`registry 선언 패턴` = **v2 이연** [자동확정] — 근거:
  Phase 3 [자동확정](DECISIONS:146-149)의 "v1 한정" 원칙과 동일 계열이나 당시 명시
  누락분을 본 감사로 소급 기록. prime 측 대응물(cache-pricing=usage 일부,
  models.generated=카탈로그)이 기능 공백을 부분 커버.
- 휴면 백포트 3종의 배선(P2a dialect → P2b auth-pool → P2c mnemopi)과 실 A/B(P4)는
  **사용자 승인 대기 제안**으로 AUDIT 문서에 상세 기재(주입점 파일:라인 포함).

### M18 완료 — oneshot-retry 이식 + grounded-refine 소비 (2026-09-02, B4)

- **트리거**: 수정 계획 B4 (GOAL v2 이식 후보 1순위, AUDIT P3).
- omp `ai/src/oneshot-retry.ts`(235줄, Bun 0건) → `auth-pool/oneshot-retry.ts` 자족
  이식. compat 축약(도달 가능 동작만, M8/M9 선례): ① AIError 비트플래그(flags.ts
  865줄) → `classifyOneshotFailure` 축약(HTTP status 구동 + context-overflow 증거
  패턴 목록은 verbatim 이식 + content-blocked/transient 마커 축약, errorId→kind
  라벨) ② `extractRetryHint` 는 본문 패턴만 도달(source=undefined 호출) →
  `extractRetryHintFromText` ③ retry-after 헤더 헬퍼 near-verbatim ④ evopi
  AssistantMessage 에 errorStatus 부재 → 메시지 텍스트에서 status 복원 ⑤
  Promise.withResolvers → 수동 리졸버.
- **소비 1곳**: grounded-refine 플래너 completeSimple 을 retryTransientCompletion
  래핑 — transient 블립이 grounded arm 을 무음으로 기본 플래너로 강등시키는 것 방지.
- 검증: oneshot-retry 12 테스트 + grounded-refine·auth-pool(17) 회귀 = 37/37,
  tsgo exit 0, Bun 게이트 0건.

### M17 완료 — mnemopi 배선: harness 주입 MMR 선택기 + cost-aware 예산 (2026-09-02, B3/R10)

- **트리거**: 수정 계획 B3 (GAP-2 P2c + D8 백로그 ③ 선반영).
- 신규 `refinement/harness-select.ts`: `createMmrHarnessSelector` — mnemopi
  `mmrRerank`+`jaccardSimilarity`(임베딩 불요)로 kind별 엔트리 선택. relevance=
  updated_at 최근성(반감기 7일), diversity=jaccard, `charBudget` 문자 예산(첫
  엔트리는 항상 포함). `formatHarnessStateForPrompt`에 `selectEntries` seam 추가
  (미전달 시 기존 사전순 절단 바이트 동일 — 테스트 고정).
- **게이트(D7)**: settings `harness.selection`("lexicographic"|"mmr") 명시 우선,
  미설정 시 evo 게이트 추종(evo on→mmr). `getHarnessSelectionSettings()`
  (settings-manager). agent-session `_resolveHarnessSelector()` → buildSystemPrompt
  `harnessSelector` 옵션 → 양 call site 전달.
- **의존**: coding-agent에 `@evopi/mnemopi` 워크스페이스 의존 추가 + pack 스크립트
  releasePackages에 mnemopi 추가(타르볼 의존 404 방지, Phase 1 선례).
- 검증: harness-select 6 테스트(다양화·최근성·예산·결정성·seam off 바이트 동일·
  overflow), tsgo exit 0, Bun 게이트 0건.

### M15 Phase 시작 — dialect owned-mode 배선 트리거·정책 (2026-09-03, B1/R8)

- **트리거**: 수정 계획 B1 (GAP-2 P2a). 활성 = models.json `dialect` 필드(11방언 |
  "auto") + `EVOPI_DIALECT` env("off" 비활성). 주입점 = sdk.ts streamFn 클로저 —
  packages/agent(prime 골격) 무수정 (agent-loop.ts:488-499 가 llmContext 를 streamFn
  에 위임, 툴 실행은 AgentContext.tools 별도 참조 — 실측).
- **적용 정책**: off 시 바이트 동일(반환 스트림 reference equality 게이트). owned
  활성 시 ① tools 제거 ② renderInbandToolPrompt ③ encodeInbandToolHistory ④
  wrapInbandToolStream 래핑, fabrication AbortController 는 provider signal 에만
  병합(omp agent-loop.ts:1602-1773 의미론). dialect compat 스트림 ↔ pi-ai 스트림은
  캐스트 브리지(런타임 형상 호환 — pi-ai provider 는 compat 전용 image_end 미방출).

#### M15 완료 (2026-09-03)

- 배럴 export(preferredDialect/FALLBACK_DIALECT) + models.json 3스키마 `dialect`
  필드(11방언|auto) + registry modelDialects 저장(storeModelHeaders 미러) +
  `dialect-mode.ts`(resolve/apply/wrap, compat 캐스트 브리지) + sdk streamFn 배선
  (fabrication AbortController → provider signal 한정).
- 검증: dialect-mode 10 테스트(auto 휴리스틱·env 우선/off·미설정 undefined·카탈로그
  렌더+히스토리 재인코딩+원본 불변·hermes in-band→네이티브 toolcall 재물질화(실
  pi-ai 스트림 객체로 캐스트 브리지 검증)·fabrication abort) + 회귀 140(model-registry
  ·databricks·dialect 2파일) + tsgo 0 + Bun 게이트 0건.
