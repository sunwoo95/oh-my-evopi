# AUDIT — 초기 목표 정합성 감사 (2026-09-02)

> 트리거: 사용자 /goal — "oh-my-pi 기반 + prime-agent RLM Harness + arXiv 2608.05446v1
> 개념을 포함한 pi agent 하네스 CLI" 라는 초기 목표 대비, GOAL→DECISIONS 전 과정이
> 제대로 이행됐는지 점검. base 가 pi(omp)→prime 으로 바뀐 것은 사용자 인지 완료 —
> 검증 대상은 "**pi 의 강력한 생태계 유지** + prime 의 **RLM 하네스·python interpreter
> 직접 검증** 포함"의 실질 달성 여부와, 수정 가능 갭의 방향성 계획.
> 방법: 계획 문헌(GOAL.md, ../RUNBOOK.md, ../oh-my-pi-analysis.md,
> ../PRIME_AGENT_ANALYSIS.md, docs/design/DECISIONS.md, REVIEW.md, docs/plans/PLAN.md)
> ↔ 현 코드 실측 대조. 모든 판정은 파일경로:라인 근거.

---

## 1. 기준 재구성 (사용자 초기 목표 → 검증 가능한 4기준)

| # | 기준 | 출처 |
|---|---|---|
| C1 | 논문 개념 포함: arXiv **2608.05446v1** 제안 개념 | 사용자 /goal 원문 |
| C2 | **pi 생태계 유지** (oh-my-pi 가 대표하는 pi 계열 자산·확장 표면) | 사용자 /goal 원문 |
| C3 | prime 의 **RLM 하네스** 포함 | 사용자 /goal 원문 |
| C4 | prime 의 **python interpreter 를 통한 직접 검증** 포함 | 사용자 /goal 원문 |

---

## 2. 기준별 판정

### C1. 논문 개념 — **판정: 불일치 (GAP-1). 단, 대체 채택이 설계상 우월**

- **실측**: 프로젝트 전 문헌이 참조하는 논문은 **arXiv 2608.15071** ("EVO-HARNESS:
  Context-to-Harness Skill Compilation for Self-Evolving Agents", Tianxin Wei 외) 단일.
  GOAL.md:5, RUNBOOK.md:58·:305·:728, papers/evo-harness.txt:102(`arXiv:2608.15071v2`).
  **2608.05446 은 어느 계획 문헌에도 등장하지 않는다** (grep 0건 — 본 감사 트리거
  기록 제외).
- **사용자 지목 논문 실측** (arxiv.org/abs/2608.05446 fetch): "**EvoHarness-RL**:
  Learning Self-Evolving Runtime Harness for Long-Horizon LLM Agents" — 하네스 상태를
  Belief/Progress/Experience 3구획으로 두고 **SFT+cost-aware GRPO 로 하네스
  읽기/갱신/통합 정책을 학습**, ALFWorld 평가(Qwen3-8B, 96.9%). 공저자(Tianxin Wei)가
  겹치는 **자매 논문이며 별개 논문**.
- **차이의 본질**: 05446 = *모델을 훈련*해 하네스 운용 정책을 얻는다(RL 필요, ALFWorld
  환경 전제). 15071 = *frozen solver* 전제로 실행 컨텍스트를 하네스 엔트리로 컴파일한다
  (학습 불요, one-shot 스트림).
- **정상 참작**: evopi 는 파라미터 고정 상용 모델을 쓰는 코딩 CLI 다 — 05446 의 핵심
  기여(SFT+GRPO 학습)는 **구조적으로 이식 불가**하고, 그 평가 환경(ALFWorld)은 GOAL.md
  가 명시 제외했다("ALFWorld 는 범위 밖", GOAL.md:17). frozen-solver 전제인 15071 이
  제품 조건에 부합한다. 즉 **결과적 채택은 합리적이나, "05446 개념 포함"이라는 초기
  의도 대비로는 (a) 논문이 뒤바뀐 경위가 미기록이고 (b) 05446 의 무학습 이식 가능
  개념(하네스 상태 3구획, annealing/consolidation, cost-aware 운용)은 검토조차 안 됐다.**
- **구현 실측(15071 델타의 실재)**: R4 [자동확정] v1 = D4(접지 피드백)+D1(실패 한정
  트리거)+D0(평가 배선) — `src/core/extensions/builtin/grounded-refine.ts`(M11, 단위
  테스트+dist 스모크), seam `EVOPI_EVO`/`evo.enabled`(settings-manager.ts:915-920),
  신호 파일 `EVOPI_FEEDBACK_FILE`(grounded-refine.ts:69). DECISIONS §R4·M11 기록 정합.

### C2. pi 생태계 유지 — **판정: 부분 달성 (구조 PASS / 실효 PARTIAL, GAP-2·GAP-3)**

**(a) pi 계열 공통 생태계 — PASS.** prime 골격 자체가 pi(earendil-works) 포크라
(PRIME_AGENT_ANALYSIS §1) pi 생태계의 핵심 표면이 골격째 유지됐다:
extensions(jiti 무컴파일 TS, ~70 예제 계약 호환) · skills(Agent Skills 표준,
`~/.agents/skills/` 벤더중립 경로 유지 — DECISIONS Phase 3 표) · packages(`pi` 매니페스트
+ `pi-package` 키워드) · themes/prompt-templates · SDK/RPC/ACP/MCP. `evo off` 시 전 기능
무변경(D7, M11 검증)이라 pi 계열 하위호환 훼손 없음.

**(b) omp(oh-my-pi) 고유 자산 이식 — PARTIAL.** 3단 실측:

| 상태 | 자산 | 근거 |
|---|---|---|
| 이식+**배선 완료** | hashline(`hashline_edit` 선택 툴 — tools/index.ts:53 `ToolName = "ipython" \| "hashline_edit"`), natives-loader(prebuilt R6), metaharness(eval/ bun 격리, 4-arm 배선), 스킬 md 3종(M13), permission-gate 계열(M10) | REVIEW M5·M6·M10·M12·M13 |
| 이식+**휴면(소비 배선 없음)** | **dialect**(11방언 스캐너 — `@evopi/pi-ai/dialect` 서브패스로 존재하나 스트림 경로 소비 0건; REVIEW M8 말미 "모델 커넥터 배선은 후속 소비 단계, M8 백포트 범위 밖") · **auth-pool**(풀 로테이션+retry 17/17 테스트 통과하나 기존 `core/auth-storage.ts` 단일-크리덴셜 유지, "풀 소비 배선은 후속" — REVIEW M9 말미) · **mnemopi**(3커널 18/18 테스트 통과하나 coding-agent 의존 0건 — package.json deps 실측, "coding-agent 소비 배선은 후속(병존 단계)" — REVIEW M7 말미) | REVIEW M7:157·M8:202·M9:249 |
| **미이식 + 판정 기록 부재** | **usage · provider-details · oneshot-retry · registry 선언 패턴** — GOAL.md:14-15 고정 요구("모델 커넥팅: omp+prime 합집합", 변경 불가 조항)에 명시돼 있으나 PLAN.md M1-M14 에 해당 모듈 자체가 없고 REVIEW 에 이식·이연 기록 0건. auth-broker/gateway 만 Phase 3 [자동확정]으로 v2 이연이 기록됨(DECISIONS:146-149) | GOAL.md:13-16, PLAN.md M 목록, REVIEW grep |
| v2 명시 이연(정당 기록) | TTSR·Advisor·snapcompact·in-process shell·pi-iso·omp tui·catalog KDL·auth-broker/gateway | RUNBOOK §C, DECISIONS 등급표 D·E |

**해석**: "휴면 백포트" 3종은 매 체크포인트에 "소비 배선은 후속"으로 **일관 기록**돼
있어 은폐는 아니다. 그러나 초기 목표의 "생태계 **유지**"를 사용자 관점(동작하는 기능)
으로 읽으면, omp 의 대표 강점 중 **오픈모델 in-band 툴콜(dialect)·다중 크리덴셜
로테이션(auth-pool)·에이전트 메모리(mnemopi)가 현재 사용자에게 아무 효과가 없다**.
그리고 4종(usage/provider-details/oneshot-retry/registry)은 "변경 불가" 요구 대비
**무판정 탈락**으로, GOAL 모드 기록 원칙 위반이다.

### C3. RLM 하네스 — **판정: PASS**

prime 골격 채택(D1)으로 완전 보존: `rlm(...)` 서브에이전트(rlm-runtime), 단일 `ipython`
내장 툴, continual harness(`refinement.ts`, HarnessEntry 4종, refinements.jsonl),
daemon 장기 실행(goal/autonomous/cron/heartbeat). M2v 부팅·커널 검증, STEP 15 커널
실증 통과. 여기에 15071 델타(grounded-refine)가 **optional 레이어**로 얹혔고 evo off
대조군이 성립(D7).

### C4. python interpreter 직접 검증 — **판정: PASS (평가 루프만 미완, GAP-4)**

- 커널 실재: `src/core/kernel/{bootstrap,repl-manager,state-snapshot,boot-gate}.ts` +
  evopi-runtime(rlm 패키지), uv 부트스트랩 + dill 스냅샷(D2). R5 [자동확정](12패키지
  전부 wheel), STEP 15 tarball 설치 후 커널 부팅 실증.
- "직접 검증"의 두 층위 모두 충족: (i) 모델이 REPL 에서 실행·검증(prime 철학 그대로)
  (ii) 외부 검증 신호를 refine 에 접지(grounded-refine, D4) — 후자가 15071 델타의 존재
  이유다.
- **잔여(GAP-4)**: 실 A/B 4-arm 평가는 API 키 부재로 SKIP(eval/RESULTS.md — 키는 셸
  export 만 허용이라는 제약과 샌드박스 무키 환경의 교차). faux 스모크 2종으로 대체
  검증됨. 배선은 완료 상태 — 키만 있으면 실행 가능.

---

## 3. 종합 판정

| 기준 | 판정 | 갭 |
|---|---|---|
| C1 논문(05446) 개념 | **불일치** — 15071 로 대체 채택(합리적이나 경위 미기록) | GAP-1 |
| C2 pi 생태계 유지 | 구조 PASS / **실효 PARTIAL** | GAP-2(휴면 3종), GAP-3(무판정 4종) |
| C3 RLM 하네스 | **PASS** | — |
| C4 python 직접 검증 | **PASS** | GAP-4(실 A/B 미실행) |

**한 줄 결론**: "prime 골격 + omp 자산 + 논문 델타"라는 병합 자체는 초기 의도의
합리적 실현이고 RLM/커널 축은 완전하다. 그러나 (1) 논문이 사용자가 의도한 05446 이
아니라 15071 이며 그 전환이 무기록이고, (2) omp 생태계 백포트의 절반이 "라이브러리만
이식·미배선" 상태로 사용자 체감 효과가 없으며, (3) GOAL 고정 요구 4종이 무판정
탈락했다.

---

## 4. 수정 방향 계획 (제안)

> 우선순위 = (초기 의도 정합 회복 효과) ÷ (구현 비용·리스크). 각 항목은 독립 실행 가능.

### P1. 논문 방침 확정 — GAP-1 (비용: 문서 0.5, 코드 옵션별)
- **P1a (즉시, 권고)**: DECISIONS 에 "논문 기반 = 15071, 사유 = frozen-solver 정합 +
  05446 의 RL 학습은 제품 조건에서 이식 불가 + ALFWorld 제외 결정과 정합"을 **소급
  명시 확정**하고 GOAL.md 에 05446→15071 전환 주석을 남긴다. (본 감사가 그 근거 문서)
- **P1b (v2 백로그, 선택)**: 05446 의 **무학습 이식 가능 개념** 3종을 evo v2 델타
  후보로 등재 —
  ① 하네스 상태의 Belief/Progress/Experience **3구획 매핑**(prime HarnessEntry 4종
  { prompt, memory, skill, subagent } 위에 뷰 계층으로: memory→Belief/Experience 태깅,
  goal/progress 연동), ② **harness annealing**(오래되고 미사용 엔트리의 주기적
  통합·감쇠 — refinements.jsonl 이력이 이미 있어 통계 산출 가능), ③ **cost-aware
  주입**(15071 의 injection budget 과 동치 계열 — 시스템 프롬프트 주입 엔트리의 토큰
  예산 상한). 각각 확장/스킬 레이어로 evo-off 무영향 구현 가능(D7 유지).
- **비고**: 05446 의 본체(SFT+GRPO)는 채택 불가 판정 유지 — 모델 훈련은 범위 밖.

### P2. 휴면 백포트 배선 — GAP-2 (사용자 체감 최대, 권고 순서대로)
- **P2a dialect 소비 배선** (비용: 중) — 오픈모델(GLM/Qwen/Kimi/DeepSeek/Harmony 등)
  in-band 툴콜 파싱 활성화. 주입점: `packages/ai/src/providers/openai-completions.ts`
  스트림 경로에 `@evopi/pi-ai/dialect` InbandScanner 를 모델별 preferredDialect
  (dialect/compat/identity.ts 휴리스틱)로 연결. omp 대응물이 원 코드에 있어 배선
  패턴 참조 가능. 효과: 로컬/오픈모델 사용성 — "provider-agnostic" 방향(금일 Prime
  종속 해소·Databricks 추가)과 시너지.
- **P2b auth-pool 소비 배선** (비용: 소~중) — `core/auth-storage.ts` 의 provider 당
  단일 크리덴셜(AuthStorageData:54)을 유지하되, 동일 provider 다중 키 존재 시
  `CredentialPool`+`withAuth` 로 401/403/usage-limit 로테이션. 주입점:
  `model-registry.ts getApiKeyAndHeaders`(:1292) 또는 stream 재시도 계층.
- **P2c mnemopi 소비 배선** (비용: 중) — 커널 Python 스킬(retain/recall 계열) 또는
  harness memory 검색 보조(MMR rerank)로 노출. prime harness memories 와 "병존"
  결정(Phase 3)에 부합하는 최소 표면 = recall 시 mnemopi 벡터 rerank.
- 각 배선은 개별 M-phase 로: 트리거 기록 → 구현 → 단위+dist 스모크 → REVIEW 체크포인트.

### P3. GOAL 고정 요구 4종 정리 — GAP-3 (비용: 소, 기록 위생)
- **usage / provider-details / oneshot-retry / registry 선언 패턴**: 각각 (i) 소형이면
  이식(oneshot-retry 는 omp 실측 소형·Bun 경미 — 1순위 후보), (ii) 아니면 DECISIONS 에
  [자동확정] v2 이연을 **명시 기록**해 "변경 불가" 요구와의 충돌을 해소(요구 자체의
  개정 기록 포함). 무기록 상태만은 제거한다.

### P4. 실 A/B 평가 실행 — GAP-4 (비용: 실행만, 키 필요)
- 사용자 API 키 export 후 `eval/` 4-arm(evopi-omp/evopi-prime/evopi-evooff/evopi-evoon)
  실행 → RESULTS.md 의 SKIP 을 실측으로 대체. evo 델타(D4+D1)의 효과 주장이 이때
  비로소 논문 Table 4 와 대조 가능해진다.

### 실행 순서 권고
P1a(기록 정정, 즉시) → P3(기록 위생) → P2a(dialect — 체감 최대) → P2b → P2c →
P1b/P4(키·우선순위 확보 시). 전부 evo-off 무영향·prime 골격 무변경 원칙(D7·데몬 동결)
안에서 가능하다.
