# Evo-Harness 논문 ↔ prime refinement 구현 델타 분석 (R4 게이트 입력)

> 작성: evo-analyst · 2026-09-02
> 임무: 신규 설계 제안이 아니라 **논문 메커니즘과 prime 기존 구현의 델타 실측**.
> 입력: `evo-harness-paper-summary.md` §7 델타 시드 4종을 prime 코드로 검증·확장.
> 최종 v1/v2 결정은 하지 않는다 — 선택지와 3조건 체크리스트 근거만 제시한다.

## 0. 인용 규약 (경로 범례)

| 접두 | 절대 경로 루트 |
|---|---|
| `paper:` | `/opt/workspace/local/sw4kim/my-agent/papers/evo-harness.txt` (arXiv 2608.15071 v2 전문 추출본) |
| `prime:` | `/opt/workspace/local/sw4kim/my-agent/prime-agent/` (**읽기 전용 — 수정하지 않았다**) |
| `omp:` | `/opt/workspace/local/sw4kim/my-agent/oh-my-pi/` |
| `evopi:` | `/opt/workspace/local/sw4kim/my-agent/oh-my-evopi/` |

논문 인용은 (섹션/식·표 번호 + `paper:` 라인)을 함께 적는다. prime 인용은 항상 `파일경로:라인`이다.
근거 없는 추론은 모두 **(추정)** 으로 표기했다.

---

## 1. 논문 메커니즘 단계 분해

논문의 파이프라인은 §3.1 형식화 → §3.2 2단계 컴파일 → §3.3 하네스 레벨 → §3.4 Algorithm 1 로 정의되고,
구현 상수는 Appendix F, 프롬프트 계약은 Appendix E, 평가 규약은 Appendix I 에 있다.

| # | 단계 | 입력 | 출력 | 성공 조건 | 논문 근거 |
|---|---|---|---|---|---|
| **S1** | 하네스 저장·포맷 | 이전 배치의 편집 집합 | `Hᵢ = {h¹ᵢ…hⁿᵢ}` — 재사용 가능 지침 엔트리 집합. 엔트리 = **trigger + 짧은 실행가능 규칙/절차 + (선택) evidence + scope** | 하네스가 frozen solver 외부에 있고, 원시 궤적 저장이 아니라 압축된 지침이며, 검사·이식 가능 | §3.1 식(1) `paper:334-343`; Appendix F 포맷 `paper:1531-1539` (Markdown 스킬 파일 + 경량 YAML 메타데이터) |
| **S2** | Select / Inject | 태스크 `xᵢⱼ`, 현 하네스 `Hᵢ`, 주입 예산 `b` | `Sᵢⱼ = Select(xᵢⱼ, Hᵢ; b)`, `|Sᵢⱼ| ≤ b` → `x̃ᵢⱼ = Inject(xᵢⱼ, Sᵢⱼ)` | 태스크별 **관련성 기반** 검색이며 예산 내로 압축. 전 실험에서 **선택은 별도 모델(Claude Sonnet 4.5)** 이 수행 | §3.1 식(2)(3) `paper:344-348, 403-406`; Appendix F 선택 모델 `paper:1615-1618` |
| **S3** | 실행 컨텍스트 수집 | `x̃ᵢⱼ` | `(τ, y, f) = A(x̃)` → `cᵢⱼ = (x, τ, y, f)`. `f` = **verifier 결과 / 유닛테스트 출력 / 툴 진단 / judge 피드백** | solver 파라미터 불변(frozen). `f`가 **환경에서 온다** — solver 자가 판단이 아니다 | §3.1 식(4)(5) `paper:407-418`; 벤치마크별 신호 Table 5 `paper:1328-1345` |
| **S4** | Reflect (실패 한정) | `cᵢⱼ` | `rᵢⱼ = Reflect(cᵢⱼ) = (lesson, trigger, evidence, scope_hint)` | **실행이 실패하거나 부정 피드백을 받았을 때만** 후보 메모리를 생성. 현 하네스와 비교하지 않음(최종 갱신이 아닌 후보 신호). 성공 궤적의 태스크 한정 디테일 유입 차단 | §3.2 식(6) `paper:425-431`; 식(7) `paper:432-434`; 실패 집중 근거 `paper:436-449` |
| **S5** | Evolver 컴파일 | `Hᵢ`, `Rᵢ = {rᵢⱼ}` | `Oᵢ = Evolver(Hᵢ, Rᵢ)`, `o ∈ {ADD, MERGE, REVISE, SKIP}` → `Hᵢ₊₁ = ApplyEdits(Hᵢ, Oᵢ)` | 후보를 **append 하지 않는다**. 노이즈/중복 필터(SKIP), 호환 신호 병합(MERGE), 기존 지침 수정(REVISE), 재사용 교훈 승격(ADD). 일반화 가능성 테스트 통과 | §3.2 식(8)(9)(10)(11) `paper:450-474`; curator 계약 Appendix E.2 `paper:1502-1510` |
| **S6** | 2레벨 general / topic | `Hᵢ`, `Rᵢ` | `Otype = CompileTaskType(Hᵢ,Rᵢ)`, `Ocross = CompileCrossTask(Hᵢ,Rᵢ)`, `Oᵢ = Otype ∪ Ocross` | 레벨은 **사전 라벨이 아니라 evolver의 필터·비교·통합 과정에서 창발**. general은 복수 컨텍스트에 걸친 패턴만 승격, 컨텍스트 한정 참조 금지 | §3.3 `paper:515-526`; Algorithm 1 line 12-14 `paper:499-511`; general curator Appendix E.3 `paper:1512-1519` |
| **S7** | 배치·예산 관리 | 태스크 배치 `Bᵢ` | 배치 종료 시 1회 컴파일. `|Bᵢ|=1` 이면 task-type 갱신으로 축약 | **배치 크기 16**, general 스킬 최대 **5**, topic당 스킬 최대 **5**. 예산이 evolver의 병합을 강제하고 태스크 한정 기록 누적을 방지 | §3.4 `paper:527-542`; Appendix F 상수 `paper:1619-1625` |
| **S8** | 피드백 접지 | `f`의 출처와 세밀도 | Self-Generated / Minimal(환경 pass-fail만) / Standard(+진단 메시지·에러 트레이스) | **환경 접지가 필수**. Self-Generated는 No-Evolve보다 악화. Standard가 대체로 우세하나 SWE-bench에선 Minimal 근소 우위 | §4.6 RQ4 Table 4 `paper:979-1034` |
| **S9** | 평가 | evolved harness, 태스크 스트림 | 성공률/pass rate (%) | **No-Evolve 대조군** 필수. pass rate 주지표, 동일 seed(42), **3회 평균**, 전 태스크셋(서브샘플링 없음) | §4.1 `paper:569-588`; Table 1 `paper:612-667`; Appendix I.3 `paper:1741-1747` |

---

## 2. 단계별 prime 구현 판정

### 판정 요약표

| # | 단계 | 판정 | prime 근거 (핵심 1줄) |
|---|---|---|---|
| S1 | 하네스 저장·포맷 | **부분** | 영속 원장·4종 엔트리·버전·롤백은 있으나 포맷은 단일 JSON, 엔트리에 `trigger`/`evidence` 필드 없음, `scope`는 `local\|global`(영속 범위)로 논문의 `cross-task\|task-type`과 의미가 다름 |
| S2 | Select / Inject | **부분** (Inject 동일 / **Select 없음**) | 시스템 프롬프트 주입은 있으나 선택이 **알파벳 정렬 후 kind별 6개 잘라내기** — 태스크 관련성 기반 검색도, 별도 Select 모델도 없음 |
| S3 | 실행 컨텍스트 수집 | **부분** | `x`,`τ`는 직렬화 대화로 들어가지만 `y`(결과)·`f`(외부 피드백) 슬롯이 아예 없음 |
| S4 | Reflect (실패 한정) | **없음** | 트리거가 `turn_interval \| compact` (시간/턴 기반). 리뷰 게이트 기준이 "이 세션 다음 턴에 유용한 증거"이며 실패·부정 피드백 조건이 아님 |
| S5 | Evolver 컴파일 | **부분** | `create/update/delete` 3연산. ADD≈create, REVISE≈update 대응이나 **MERGE·SKIP 없음**, `delete`는 논문 어휘에 없는 prime 고유 연산 |
| S6 | 2레벨 general/topic | **없음** | `CompileCrossTask` 대응물 없음. 그룹화 프리미티브는 `path` 하나이고 기본값이 문자열 `"general"`. 컴파일은 단일 세션 트라젝토리 1패스 |
| S7 | 배치·예산 관리 | **없음** | 적용 경로에 엔트리 수 상한이 없음. 상한은 프롬프트 **표시용**만 존재. 배치 개념 자체가 없음(세션 단위) |
| S8 | 피드백 접지 | **없음** | 플래너 입력에 verifier/테스트 필드 없음. 완료 이벤트에도 pass/fail 없음 → 논문의 **Self-Generated 설정에 해당** |
| S9 | 평가 | **없음** (prime) / 별도 자산 존재 (omp) | prime에 A/B 러너 없음. `omp:packages/metaharness`가 대체 자산. No-Evolve arm은 `autoRefine.enabled:false`로 무비용 확보 가능 |
| 부록 | cross-model evolver 분리 | **부분** | 기본은 세션 모델로 플래닝. 단 `session_before_refine` 훅 + 예제 확장으로 교체 가능한 확장점이 이미 있음 |

### S1 하네스 저장·포맷 — 부분

- 논문: 엔트리 = trigger + 짧은 실행가능 규칙 + (선택) evidence + scope(cross-task vs task-type), 저장은 **Markdown 스킬 파일 + 경량 YAML 메타데이터** (Appendix F, `paper:1531-1539`).
- prime: `HarnessEntry`는 `id/kind/title/content/path/scope/reference/arguments/metadata/source/created_at/updated_at/version`
  — `prime:packages/coding-agent/src/core/refinement/refinement.ts:34-48`.
  - `trigger`·`evidence` 전용 필드가 **엔트리에 없다**. 두 필드는 refinement **이벤트** 레벨에만 존재한다:
    `HarnessRefinementEvent{id, trigger, changes, evidence, outcome, created_at}` — `refinement.ts:50-57`.
    즉 논문 `r = (lesson, trigger, evidence, scope_hint)` (식 7, `paper:432-434`)와 필드 이름이 거의 일치하지만,
    prime에서는 그것이 **검색 대상 엔트리가 아니라 감사 로그**다.
  - `scope`는 `"local" | "global"` — `refinement.ts:32`. 이는 **영속 범위**(세션 로컬 vs 전역)이며
    논문의 `scope`(cross-task vs task-type, `paper:1533-1539`)와 의미가 다르다. 이름 충돌에 주의.
  - 저장 포맷은 단일 JSON 파일: `getHarnessStatePath()` → `harness_state.json` (`refinement.ts:277-279`),
    원자적 저장 `refinement.ts:345-359`. Markdown+YAML 아님.
  - 스키마 버전 필드 존재 → 마이그레이션 경로 있음: `refinement.ts:59` (`schema: number`), 로드 시 기본 1 `refinement.ts:303`.
- 문서 근거: `prime:packages/coding-agent/docs/rlm-runtime.md:193-199` ("Continual Harness State" — `rlm.harness`는
  프롬프트 노트/메모리/스킬 서술/서브에이전트 명세/refinement 이벤트의 영속 원장, "두 번째 실행 엔진이 아니다").
- 판정 근거: **영속 외부 하네스 + 소규모 편집 + 롤백**이라는 골격은 논문과 동일 계열이나,
  **엔트리 스키마(trigger/evidence/scope_hint)와 포맷(md+yaml)** 이 불일치 → 부분.

### S2 Select / Inject — 부분 (Inject 동일, Select 없음)

- 논문: `Sᵢⱼ = Select(xᵢⱼ, Hᵢ; b)`, `|Sᵢⱼ| ≤ b` (식 2, `paper:344-348`), 선택은 **전 실험에서 Claude Sonnet 4.5 별도 모델**
  이 수행 (`paper:1615-1618`).
- prime **Inject 쪽은 동일**: 하네스 상태가 시스템 프롬프트에 삽입된다 —
  `prime:packages/coding-agent/src/core/system-prompt.ts:109` 및 `:148` 두 경로에서 `formatHarnessStateForPrompt()` 호출.
- prime **Select 쪽이 없다**:
  - 정렬이 `path → title → id` 알파벳 순이다 — `refinement.ts:467-469`.
  - 그 뒤 kind별로 앞에서 잘라낸다 — `refinement.ts:481` (`entries.slice(0, maxEntriesPerKind)`),
    기본 6 — `refinement.ts:26` (`DEFAULT_OVERVIEW_ENTRY_LIMIT = 6`), 적용 `refinement.ts:440`.
  - 즉 **태스크와 무관한 결정론적 절단**이다. 관련성 점수도, 태스크 텍스트 입력도, 별도 모델 호출도 없다.
  - 넘친 엔트리는 `- +N more <kind> entries` 한 줄로만 알려진다 — `refinement.ts:497-500`.
  - 프롬프트 본문이 스스로 "compact summaries, not full descriptions … routing/context hints" 라고 명시 —
    `refinement.ts:449`. 즉 설계 의도가 **요약 메뉴**이고 논문의 예산 하 검색이 아니다.
- 판정 근거: Inject 동일 / Select 없음이므로 단계 전체로는 **부분**. 델타는 Select 쪽에만 있다.

### S3 실행 컨텍스트 수집 — 부분

- 논문: `cᵢⱼ = (xᵢⱼ, τᵢⱼ, yᵢⱼ, fᵢⱼ)` (식 5, `paper:413-418`), `f`는 verifier 결과·유닛테스트 출력·툴 진단·judge 피드백.
- prime 플래너 입력은 4블록이다 — `refinement.ts:910-919`:
  `<current_harness_state>` / `<refinement_history>` / `<conversation>` / `<scope_policy>` (+ 선택적 `<user_refine_instructions>`).
  - `<conversation>`은 직렬화 대화의 마지막 80k 문자 — `refinement.ts:906`
    (`serializeConversation(convertToLlm(messages)).slice(-80_000)`). 여기에 `x`와 `τ`가 섞여 들어간다.
  - **`y`(결과)와 `f`(외부 피드백)에 해당하는 별도 입력 슬롯이 없다.** 툴 실패는 대화 텍스트에 우연히 섞여 있을 뿐,
    구조화된 pass/fail 신호로 전달되지 않는다.
- 확장점 쪽도 동일하다: `RefinePreparation{trigger, instructions, scope, planningState, history, conversationText}`
  — `prime:packages/coding-agent/src/core/extensions/types.ts:522-535`. 여기에도 verifier/결과 필드가 없다.
- 판정 근거: `x`,`τ`는 있고 `y`,`f`는 없음 → **부분**. (S8과 같은 뿌리의 결함이지만, S8은 "접지 정책",
  S3은 "컨텍스트 스키마"라는 서로 다른 델타 지점이다.)

### S4 Reflect (실패 한정 트리거) — 없음

> §7 델타 후보 1의 실측 결과: **시드의 추정("실패 여부와 무관")이 맞다.**

- 논문: 후보 메모리는 **"only when the execution fails or receives negative feedback"** (식 6, `paper:425-431`).
  실패 집중 이유는 solver의 경계(잘못된 가정, 누락 제약, 비효율 툴 사용, 약한 검증, 복구 실패) 노출과
  성공 궤적의 태스크 한정 디테일 차단 (`paper:436-449`).
- prime 트리거 어휘가 실패와 무관하다: `export type AutoRefineReason = "turn_interval" | "compact";`
  — `refinement.ts:110`. 컨텍스트는 `{reason, turnsSinceLastReview}` — `refinement.ts:112-115`.
- 실제 발동 조건:
  - 턴 간격: `if (reason === "turn_interval" && this._assistantTurnsSinceAutoRefine < settings.turnInterval) return;`
    — `prime:packages/coding-agent/src/core/agent-session.ts:7908-7910`.
  - 기본값: `turnInterval` 25 어시스턴트 턴, `cooldownMs` 20분, `enabled` 기본 true, `compact` 기본 true
    — `prime:packages/coding-agent/src/core/settings-manager.ts:905-920`.
  - 컴팩션 후 트리거 경로 — `agent-session.ts:3988-4000`, `:4012-4031`.
- 리뷰 게이트 기준도 실패가 아니다:
  `"approve when the trajectory contains evidence useful to this session's future turns"`
  — `refinement.ts:176-178` (`AUTO_REFINE_REVIEW_SYSTEM_PROMPT`). 거부 대상은 "one-off noise,
  unsupported hypotheses, transient tool outputs"이며 성공 궤적을 배제하지 않는다.
- 유일한 근접 신호는 **권고 문구**일 뿐 게이트가 아니다:
  시스템 프롬프트에 "after a repeated failure, a reusable tactic emerges, …" 라고 적혀 있다 — `refinement.ts:454`.
  모델에게 주는 힌트이며 코드 조건이 아니다.
- 판정 근거: 실패/부정 피드백을 **전제 조건으로 강제하는 코드 경로가 존재하지 않는다** → **없음**.

### S5 Evolver 컴파일 (ADD/MERGE/REVISE/SKIP) — 부분

- 논문: `o ∈ {ADD, MERGE, REVISE, SKIP}` (식 10, `paper:460-467`).
  curator 계약: 제안별 ACCEPT/MERGE/SKIP, "Prefer merging over duplication, respect the budget,
  require a clear trigger description, … apply a generalizability test" — Appendix E.2 `paper:1502-1510`.
  solver-side proposal은 NEW/ENHANCE/NONE 결정 + "Filter aggressively" — Appendix E.1 `paper:1486-1500`.
- prime: `export type RefinementAction = "create" | "update" | "delete";` — `refinement.ts:31`,
  검증도 이 3종만 허용 — `refinement.ts:674-677`.
  - 대응: ADD ≈ `create`, REVISE ≈ `update`.
  - **MERGE 없음.** 같은 id로 create 하면 병합이 아니라 **실패**한다:
    `appliedEdits.push({... applied: false, error: "entry already exists" })` — `refinement.ts:760-762`.
  - **SKIP 없음.** 후보를 명시적으로 기각하는 연산이 없다. 가장 가까운 것은 빈 edits 배열 반환 지시
    (`"If no useful edit is justified, return an empty edits array with a rationale."` — `refinement.ts:916`)와
    리뷰 게이트의 `shouldRefine:false` — `refinement.ts:181-185`. 둘 다 **라운드 전체**의 on/off이며
    **후보별 기각**이 아니다.
  - `delete`는 논문 편집 어휘에 없는 prime 고유 연산 — `refinement.ts:750-758`.
  - `ApplyEdits` 대응 함수는 존재: `applyRefinementProposal()` — `refinement.ts:716-811`.
    낙관적 동시성 검사(`"entry changed during refinement planning"` — `refinement.ts:736-749`)와
    before/after 스냅샷 기반 롤백(`rollbackProposal()` — `refinement.ts:813-845`)까지 갖췄다.
- 판정 근거: 편집 적용 인프라와 2/4 연산은 있으나 MERGE·SKIP이 없고 어휘가 어긋난다 → **부분**.

### S6 2레벨 general / topic — 없음

> §7 델타 후보 2의 실측 결과: **시드의 추정("세션 단위 refine, 2레벨 구분 없음")이 맞다.**

- 논문: `Otype = CompileTaskType(...)`, `Ocross = CompileCrossTask(...)`, 합집합 적용
  — Algorithm 1 line 12-14 `paper:499-511`. 레벨은 사전 라벨이 아니라 evolver의 비교·통합에서 창발 — §3.3 `paper:515-526`.
  general curator는 "Create or update a general skill only when a pattern appears across multiple contexts"
  — Appendix E.3 `paper:1512-1519`.
- prime:
  - 컴파일은 **단일 세션 트라젝토리에 대한 1패스 LLM 호출**이다 — `refinement.ts:927-934` (`completeSimple`),
    호출자 `agent-session.ts:8256-8266`. 두 번째 컴파일러가 없다.
  - 태스크 간 비교 입력이 없다. 입력의 "과거" 축은 `<refinement_history>`(자기 편집 로그, `refinement.ts:548-562`)
    뿐이고, **다른 태스크의 실행 컨텍스트가 아니다**.
  - 그룹화 프리미티브는 `path` 하나이며 기본값이 하필 문자열 `"general"` 이다 —
    `refinement.ts:776` (`path: edit.path ?? before?.path ?? "general"`).
    이는 **논문의 general 레벨과 무관한 기본 폴더명**이다. 이름이 같아 오독 위험이 크다.
  - 두 레벨에 유사한 유일한 구조는 `local`/`global` 이중 스토어다 —
    `getGlobalHarnessStateDir()`/`getLocalHarnessStateDir()` `refinement.ts:269-275`,
    병합 `mergeHarnessStates()` `refinement.ts:326-343`. 그러나 이 축은
    **세션 수명(cross-session vs session)** 이지 **일반성(cross-task vs task-type)** 이 아니다.
    프롬프트 정책이 이를 명시한다 — `refinement.ts:141-145`.
- 판정 근거: `CompileCrossTask` 대응물, 태스크 간 비교 입력, 레벨 라벨이 모두 없다 → **없음**.
  (단 `local/global` 이중 스토어와 `path` 필드는 **배선 가능한 기존 프리미티브**다.)

### S7 배치·예산 관리 — 없음

> §7 "스킬당 예산 상한(general 5 / topic당 5)" 항목의 실측 결과: **prime에 강제 상한이 없다.**

- 논문: 배치 크기 16, general 스킬 최대 5, topic당 스킬 최대 5. "This budget encourages the evolver
  to merge overlapping guidance and avoid accumulating overly detailed or task-specific records."
  — Appendix F `paper:1619-1625`. 예산은 curator 프롬프트에 입력으로 들어간다 ("Inputs: topic,
  current skill library, **budget**, and proposals" — `paper:1503-1505`).
- prime:
  - **적용 경로에 엔트리 수 상한이 없다.** `applyRefinementProposal()` 전체(`refinement.ts:716-811`)에
    카운트 검사가 없다. 무한히 누적될 수 있다.
  - 존재하는 상한은 전부 **표시/토큰 예산**이다: `DEFAULT_OVERVIEW_ENTRY_LIMIT=6`,
    `DEFAULT_OVERVIEW_REFINEMENT_LIMIT=5`, `DEFAULT_OVERVIEW_CONTENT_LIMIT=180`
    — `refinement.ts:26-28`, 적용 `refinement.ts:440-442`. 별도로 플래너 입력용 40개 절단
    `refinement.ts:527`, `:541-543`. 출력 토큰 예산 `refinement.ts:193`, `:199-201`.
    이들은 **프롬프트에서 안 보이게 하는 것**이고 저장소를 제한하지 않는다.
  - **배치 개념 자체가 없다.** 갱신 단위는 세션 체크포인트(턴 간격/컴팩션/명시 호출)다 — `refinement.ts:110`,
    `agent-session.ts:7908`. 논문 `|Bᵢ|=1` 축약 케이스(`paper:533-534`)에 상시 대응하는 상태.
  - 예산을 curator에게 알려주는 경로도 없다 — 플래너 프롬프트(`refinement.ts:123-173`)에 budget 언급 없음.
- 판정 근거: 강제 예산·배치 경계·예산 인식 병합이 모두 없다 → **없음**.

### S8 피드백 접지 — 없음

> §7 델타 후보 4의 실측 결과: **시드의 추정("외부 verifier 접지 없음")이 맞다. 논문 근거가 가장 강한 항목이다.**

- 논문 Table 4 (`paper:992-1009`):

  | Feedback Level | CL-Bench | SWE-bench Lite |
  |---|---|---|
  | No Evolve | 29.54 | 63.67 |
  | Self-Generated | **27.96** | **61.67** |
  | Minimal | 29.86 | **67.33** |
  | Standard | **34.02** | 67.00 |

  Self-Generated 정의: "asks the LLM itself to judge whether the execution succeeded and what should be learned"
  — `paper:983-987`. 결론: "Self-Generated feedback underperforms No-Evolve on both benchmarks …
  LLM-generated self-judgment can introduce misleading updates when it is not grounded in external
  execution evidence" — `paper:1010-1019`.
- prime의 refine 루프는 정의상 **Self-Generated에 해당한다**:
  - 성공 여부 판단이 LLM 자가 판단이다 — 리뷰 게이트가 `shouldRefine` 을 스스로 결정 `refinement.ts:950-961`,
    `reviewAutoRefine()` `refinement.ts:963-1012`. 입력은 대화 40k 문자 절단뿐 — `refinement.ts:974`.
  - 플래너 입력에 외부 신호가 없다 — `refinement.ts:910-919` (앞의 S3 참조).
  - 완료 이벤트에도 결과 신호가 없다: `RefineCompleteEvent{type, id, summary, appliedEdits, scope}`
    — `prime:packages/coding-agent/src/core/extensions/types.ts:651-661`. `appliedEdits`는 **편집 개수**이고
    태스크 pass/fail이 아니다.
  - 확장 입력 `RefinePreparation`에도 없다 — `types.ts:522-535`.
- 접지 신호원은 evopi 쪽에 이미 있다(배선만 없다): `BenchmarkTrace.status: "pass"|"fail"|"error"|"running"` 및
  `reward: number|null` — `omp:packages/metaharness/src/benchmarks.ts:51-52`.
  edit 어댑터의 pass 판정 — `benchmarks.ts:161-162`, `:170-171`.
- 판정 근거: 환경 접지 신호가 refine 입력/출력 어디에도 없다 → **없음**.
  안전 함의: **접지 없이 evo-on을 켜면 논문 기준으로 성능이 떨어질 것으로 예측된다**(Table 4 Self-Generated 행).

### S9 평가 — 없음(prime) / 대체 자산 존재(omp)

- 논문: No-Evolve 대조군, pass rate (%) 주지표, seed 42 고정, **3회 평균**, 전 태스크셋
  — `paper:1741-1747`, Table 1 `paper:612-667`.
- prime: A/B 벤치 러너가 없다. 다만 **No-Evolve arm을 코드 수정 없이 얻을 수 있다**:
  `autoRefine.enabled` 기본 true, `false`로 opt-out — `prime:packages/coding-agent/src/core/settings-manager.ts:909`.
  세션 단위 차단 경로도 있다 — `agent-session.ts:7585` (`_autoRefineAllowedForSession()`),
  차단 시 refine 스킬과 host handler까지 함께 숨는다 — `agent-session.ts:9193-9195`, `:9232-9234`.
- 대체 자산(omp): `MetricDefinition{key,label,format,higherIsBetter}` — `omp:packages/metaharness/src/benchmarks.ts:8-13`,
  `BenchmarkDefinition{kind,label,metrics[]}` — `:16-20`, 기존 kind 3종 — `omp:packages/metaharness/src/store.ts:19`,
  edit kind 지표 2종 — `benchmarks.ts:30-34`, arm 요약 `summarizeArm()` / `passPct` / `costPerTask`
  — `omp:packages/metaharness/src/experiments.ts:91-123`.
- 판정 근거: prime 내부에는 **없음**. evopi의 D7 4-arm 설계(`evopi:docs/design/DECISIONS.md:110-114`)는
  metaharness 재사용 전제이므로 델타가 아니라 **전제 인프라**로 분류하는 것이 맞다 (추정: 분류 판단).

### 부록 판정: cross-model evolver 분리 — 부분

- 논문: Figure 6 (`paper:945-978`). Opus solver: Cross 76.0 > Same 75.3 > No-Evolve 70.7.
  Sonnet solver: Same 55.3 / Cross 55.7 **< No-Evolve 58.0** — "harness transfer depends not only on the
  skill artifact but also on the base solver's capability" (`paper:968-978`).
  Train-split transfer도 유효: 68.8 → 73.4 → (online) 75.0 — Figure 5 `paper:930-944`.
- prime 기본값은 **세션 모델 = evolver**: `const model = this.model;` — `agent-session.ts:8197`,
  그 모델로 플래닝 — `agent-session.ts:8256-8266`, 리뷰도 동일 모델 — `agent-session.ts:8012-8027`.
- 그러나 교체 확장점이 이미 완비되어 있다:
  - 훅: `session_before_refine` — `types.ts:537-549` (`skip?: boolean`, `proposal?: RefinementProposal`),
    발화 지점 `agent-session.ts:8229-8255`.
  - 예제: 더 싼 모델로 플래너를 교체하는 확장 —
    `prime:packages/coding-agent/examples/extensions/custom-refinement.ts:20-33` (모델 조회·인증),
    `:50-100` (프롬프트·파싱), `:99-100` (proposal 반환).
    반환 없으면 내장 플래너 폴백, `{skip:true}`면 라운드 억제 — `custom-refinement.ts:10-11`.
  - 반환 편집도 코어 apply 경로에서 재검증되어 안전하다 — `custom-refinement.ts:6-8`,
    `normalizeRefinementProposal()` `refinement.ts:637-663` + `validateEdit()` `refinement.ts:673-714`.
- 판정 근거: 기본 동작은 논문 SAME 설정이고 CROSS는 확장으로 구성 가능 → **부분**.

### 참고: 시드 §7 표와 실측의 차이

| §7 시드 항목 | 시드 예상 | **실측 판정** | 실측이 바꾼 점 |
|---|---|---|---|
| 외부 영속 하네스 | 동일 계열 | **부분** (S1) | 엔트리 스키마에 `trigger`/`evidence` 없고 `scope` 의미가 다름 — 시드보다 델타가 조금 크다 |
| 소규모 편집 갱신 | 부분 | **부분** (S5) | 확인. 추가 발견: 중복 create가 병합이 아니라 **에러**로 처리됨 (`refinement.ts:760-762`) |
| 실패 한정 반영 트리거 | 미확인 | **없음** (S4) | 확정. 트리거 어휘가 `turn_interval\|compact` (`refinement.ts:110`) |
| 배치 이중 컴파일 | 미확인 | **없음** (S6) | 확정. 추가 함정: `path` 기본값이 `"general"` 문자열 (`refinement.ts:776`) — 이름 충돌 |
| 주입 예산 + Select 모델 | 미확인 | **부분** (S2) | Inject는 동일, Select만 없음으로 **분해됨**. 기존 6개 절단은 예산이 아니라 표시 상한 |
| 접지 피드백 | 미확인 | **없음** (S8) | 확정. prime 루프는 논문 Self-Generated 설정과 동형 → Table 4 기준 위험 |
| 스킬당 예산 상한 | 미상 | **없음** (S7) | 확정. 적용 경로에 카운트 검사 0건 |
| cross-model evolver | 부분 | **부분** | 확인. 확장점 위치까지 특정 (`types.ts:537-549`, `custom-refinement.ts:20-108`) |
| — (시드에 없던 항목) | — | **부분** (S3) | 신규: 실행 컨텍스트 스키마에 `y`/`f` 슬롯 부재 (`types.ts:522-535`) |

---

## 3. 구현 델타 목록 ("없음" / "부분" 항목만)

| ID | 델타 | 판정 | 논문 근거 | prime 근거 |
|---|---|---|---|---|
| **D1** | 실패/부정 피드백 한정 Reflect 게이트 | 없음 | §3.2 식(6) `paper:425-431` | `refinement.ts:110`, `agent-session.ts:7908-7910`, `settings-manager.ts:905-920` |
| **D2** | 배치 이중 컴파일 (general/topic 2레벨) | 없음 | §3.3 `paper:515-526`, Alg.1 12-14 `paper:499-511` | 단일 1패스 `refinement.ts:927-934`, `path` 기본 `"general"` `refinement.ts:776` |
| **D3** | 주입 예산 `b` + 관련성 Select (별도 모델) | 부분(Select 없음) | 식(2) `paper:344-348`, Appendix F `paper:1615-1618` | 알파벳 절단 `refinement.ts:467-469`, `:481`, `:26` |
| **D4** | 접지 피드백 배선 (verifier/test → refine 입력) | 없음 | RQ4 Table 4 `paper:992-1034` | 입력 4블록에 `f` 없음 `refinement.ts:910-919`; `types.ts:522-535`, `:651-661` |
| **D5** | MERGE / SKIP 편집 연산 + 예산 강제 병합 | 부분 | 식(10) `paper:460-467`, E.2 `paper:1502-1510`, F `paper:1622-1625` | 3연산만 `refinement.ts:31`, `:674-677`; 중복 create = 에러 `:760-762`; 상한 검사 0건 `:716-811` |
| **D6** | 엔트리 스키마 `trigger`/`evidence`/`scope_hint` (+ md+yaml 포맷) | 부분 | Appendix F `paper:1531-1539`, 식(7) `paper:432-434` | `HarnessEntry` `refinement.ts:34-48`; 해당 필드는 이벤트에만 `:50-57`; JSON 저장 `:277-279` |
| **D7** | 실행 컨텍스트에 `y`(결과)·`f`(피드백) 슬롯 추가 | 부분 | 식(5) `paper:413-418` | `refinement.ts:906`, `:910-919`; `RefinePreparation` `types.ts:522-535` |
| **D8** | cross-model evolver 분리 (저비용 evolver) | 부분 | Fig.6 `paper:945-978`, Fig.5 `paper:930-944` | 세션 모델 고정 `agent-session.ts:8197`, `:8256-8266`; 확장점 `types.ts:537-549`, `custom-refinement.ts:20-108` |
| **D9** | 하네스 엔트리 총량 예산 상한 (general 5 / topic당 5) | 없음 | Appendix F `paper:1619-1625` | 표시 상한만 `refinement.ts:26-28`, `:440-442`; 적용 경로 무제한 `:716-811` |
| **D0** | 평가 배선 (No-Evolve arm, 3회 평균, seed 고정) | 없음(prime) | §4.1 `paper:569-588`, I.3 `paper:1741-1747` | `settings-manager.ts:909`로 arm 확보 가능; 러너는 `omp:packages/metaharness/*` |

D5·D9는 논문상 한 메커니즘(예산이 병합을 강제)이지만 **prime 판정이 갈리므로**(D5 부분 / D9 없음) 분리했다.
D0는 델타이자 다른 모든 델타의 측정 전제다.

---

## 4. 델타별 비용·인프라·안전·성능 가설·지표

신규 파일 수는 모두 **(추정)** 이다. prime 레포는 읽기 전용이므로, 비용 산정은
"evopi 쪽에 확장/백포트 파일을 새로 만드는 경우"를 기준으로 했다.
지표는 `MetricDefinition{key,label,format,higherIsBetter}` (`omp:packages/metaharness/src/benchmarks.ts:8-13`) 형태다.
`(기존)` 표시 지표는 metaharness edit kind에 이미 등록되어 있어 추가 계측이 필요 없다
(`benchmarks.ts:30-34`); 나머지는 `BENCHMARK_DEFINITIONS`의 `metrics[]`와 스냅샷 `metrics` 레코드
(`benchmarks.ts:16-20`, `:73`)에 **신규 등록이 필요**하다 (추정).

| ID | 구현 비용 (신규 파일, 추정) | 필요 인프라 | 안전 요구사항 | 코딩 트랙 성능 기여 가설 (논문 표) | 제안 지표 (MetricDefinition) |
|---|---|---|---|---|---|
| **D1** 실패 한정 게이트 | **1** — `session_before_refine`에서 실패 신호 없으면 `{skip:true}` 반환하는 확장 1파일 (`types.ts:544-549` 계약, `custom-refinement.ts` 패턴). 백포트로 `AutoRefineReason`에 `"failure"` 추가 시 0 신규 파일(기존 파일 수정) | 실패 신호원. 후보 2개: (a) metaharness trace `status`/`reward` (`benchmarks.ts:51-52`) (b) 세션 내 툴 실패 카운트 (**추정** — prime에 집계기 없음) | 오탐 시 refine이 완전 정지 → 기존 `turn_interval` 경로를 폴백으로 남길 것. `{skip:true}`는 `RefineSkippedError`로 소비되어 재시도되지 않으므로(`agent-session.ts:7995-8001`) 정지가 조용히 누적될 수 있음 | Table 3 (`paper:876-896`): No Propose 33.28 / 65.33 < full 34.02 / 67.00 → 제안 단계 품질이 성능에 기여. 단 **"실패 한정"의 독립 절제는 논문에 없다** — 근거는 §3.2 서술(`paper:436-449`)뿐 (**추정**: 코딩 트랙 기여는 노이즈 감소를 통한 간접 효과) | `{key:"refine_trigger_precision", label:"Refine trigger precision", format:"percent", higherIsBetter:true}` (실패 궤적에서 발동한 refine 비율) · `{key:"task_success_rate", …}` **(기존)** |
| **D2** 배치 이중 컴파일 | **2–3** — `compile-cross-task.ts`, `compile-task-type.ts`, 배치 큐/스트림 상태 1파일 | 배치 경계(논문 16 — `paper:1619-1621`)를 태스크 스트림에서 정의해야 함 → metaharness job의 trial 시퀀스 재사용 (`omp:packages/metaharness/src/runner.ts` readTrials, `benchmarks.ts:241-252`). 태스크 간 상태 공유 → 기존 전역 스토어 재사용 가능 (`refinement.ts:269-271`) | 전역 스토어 쓰기가 늘어남 → `refinements.jsonl` 롤백 로그 필수 (`refinement.ts:374-379`, 로드 `:381-400`). 낙관적 동시성 검사 유지 (`refinement.ts:736-749`). general 레벨은 "컨텍스트 한정 참조 금지"를 프롬프트로 강제 (`paper:1516-1519`) | Table 3 (`paper:882-896`): **SWE-bench Lite에서 General Only 66.67 > Topic Only 64.33**, full 67.00 vs No Evolve 63.67. 논문 해석: 리포지토리 디버깅·검증 절차는 general 쪽이 더 중요 (`paper:906-912`) → **코딩 트랙에 직접 유리한 가장 명확한 절제 근거** | `{key:"general_skill_hit_rate", label:"General skill hits", format:"percent", higherIsBetter:true}` · `{key:"topic_skill_hit_rate", label:"Topic skill hits", format:"percent", higherIsBetter:true}` · `{key:"task_success_rate", …}` **(기존)** |
| **D3** 예산 + Select 모델 | **1–2** — `select.ts`(관련성 선택 + 예산 절단) + 설정 확장. `formatHarnessStateForPrompt` 호출부 2곳(`system-prompt.ts:109`, `:148`)에 배선 | 별도(저비용) 모델 자격증명. 논문은 Sonnet 4.5 (`paper:1615-1618`). prime `modelRegistry.find()` + `getApiKeyAndHeaders()` 재사용 가능 (`custom-refinement.ts:25-33`) | 태스크마다 추가 LLM 호출 → 지연·비용 증가. `costPerTask` 회귀 감시 필수 (`omp:packages/metaharness/src/experiments.ts:101-102`, `:122-123`). Select 실패 시 기존 알파벳 절단으로 폴백 | **논문에 Select 절제 실험이 없다.** 근거는 (a) 예산이 병합을 강제한다는 서술 `paper:1622-1625` (b) RQ1의 "retrieved or evolved guidance can be noisy, overly specific" `paper:679-686` (c) EDS 카테고리에서 과잉 특수 지침이 성능을 깎음 Table 2 `paper:798-806` → (**추정**: 코딩 트랙 기여는 토큰·노이즈 절감 경유의 간접 효과, 가설 강도 약) | `{key:"injected_entry_count", label:"Injected entries per task", format:"number", higherIsBetter:false}` · `{key:"select_cost_usd", label:"Select model cost", format:"usd", higherIsBetter:false}` · `{key:"task_success_rate", …}` **(기존)** |
| **D4** 접지 피드백 | **1** — verifier/test 결과를 refine 입력에 주입하는 확장 1파일. `RefinePreparation`에 `f` 슬롯이 없으므로(`types.ts:522-535`) 확장이 직접 신호를 읽어 `proposal`을 만들거나(`types.ts:547-548`) 백포트로 필드를 추가해야 함(→ D7과 결합 시 0 추가 파일) | metaharness trace의 `status`/`reward` (`benchmarks.ts:51-52`), edit 어댑터 pass 판정 (`benchmarks.ts:161-171`). 논문 2단 세밀도: Minimal(pass/fail만) / Standard(+에러 트레이스) `paper:983-991` | **가장 강한 안전 요구.** 접지 없는 자가 판단은 No-Evolve보다 나쁘다 (Table 4: CL 29.54→27.96, SWE 63.67→61.67 — `paper:998-1009`). 따라서 **접지 배선 없이 evo-on arm을 돌리는 것 자체가 위험**하다. 또한 Standard(상세 에러)는 과잉 특수화를 유발할 수 있음 (`paper:1028-1034`) → 코딩 트랙 기본값을 Minimal로 두는 보수적 선택지 존재 | Table 4 (`paper:992-1009`): **SWE-bench Lite Minimal 67.33 / Standard 67.00 vs No Evolve 63.67** (+3.7~3.3pt). 코딩 트랙에서 **Minimal(pass/fail만)이 근소 우위** → 최소 배선으로 최대 이득. 논문에서 **효과 근거가 가장 직접적이고 강한 항목** | `{key:"grounded_refine_rate", label:"Grounded refinements", format:"percent", higherIsBetter:true}` (외부 pass/fail을 입력으로 받은 refine 비율) · `{key:"task_success_rate", …}` **(기존)** · `{key:"edit_success_rate", …}` **(기존)** |
| **D5** MERGE/SKIP | **0–1** — 백포트한 `refinement.ts` 상당 파일에 연산 2종 추가(신규 파일 0) 또는 별도 `compile-ops.ts` 1파일 | 없음 (순수 로컬 로직). 예산 인식 병합은 D9 선행 필요 | MERGE는 기존 엔트리 내용을 파괴할 수 있음 → before 스냅샷 롤백 경로 재사용 필수 (`refinement.ts:813-845`), 낙관적 동시성 검사 유지 (`:736-749`). SKIP은 무한 기각으로 학습을 정지시킬 수 있음 → 기각률 관측 필요 | **독립 절제 없음.** 근거는 식(10) `paper:460-467` + curator 계약 "Prefer merging over duplication, respect the budget" `paper:1506-1510` (**추정**: 기여는 하네스 비대화 억제 경유의 간접 효과) | `{key:"harness_entry_count", label:"Harness entries", format:"number", higherIsBetter:false}` · `{key:"merge_edit_share", label:"MERGE share of edits", format:"percent", higherIsBetter:true}` · `{key:"skip_edit_share", label:"SKIP share of proposals", format:"percent", higherIsBetter:false}` |
| **D6** 엔트리 스키마·포맷 | 스키마 필드만: **0** (기존 `metadata` 활용 또는 `HarnessEntry` 필드 추가 — `refinement.ts:34-48`). md+yaml 포맷 전환까지: **1–2** (스토어 직렬화 교체 — `refinement.ts:281-359` 상당) | 없음 | `schema` 버전 마이그레이션 필요 (`refinement.ts:59`, `:303`). 포맷 전환 시 기존 `harness_state.json` 읽기 하위호환 유지 (현재 손상 시 빈 상태로 degrade — `refinement.ts:289-301`). `scope` 이름 충돌(local/global vs cross-task/task-type) 해소 규약 필요 | **성능 근거 없음.** Appendix F는 "inspectable and easy to transfer across runs"라는 **검사성·이식성** 이유만 제시 (`paper:1531-1539`). 이식성은 Figure 5의 train-split transfer(68.8→73.4, `paper:930-944`)를 가능케 하는 전제 (**추정**) | `{key:"entry_trigger_coverage", label:"Entries with trigger", format:"percent", higherIsBetter:true}` (프록시, **추정**) — 태스크 성공률과의 인과 연결은 약함 |
| **D7** `y`/`f` 컨텍스트 슬롯 | **0–1** — `RefinePreparation` 확장 필드 추가(기존 파일 수정) 또는 컨텍스트 수집기 1파일. D4와 사실상 동일 배선 지점 | D4와 동일 신호원 | `f`가 대화 텍스트가 아닌 구조화 필드로 들어오면 프롬프트 주입 표면이 늘어남 → 신뢰 경계 문서화 (`prime:packages/coding-agent/docs/rlm-runtime.md:235-239`) | D4와 동일 (Table 4 `paper:992-1009`). D7은 스키마, D4는 정책 — **묶어서 1개 델타로 취급하는 선택지 존재** | D4 지표와 공유 |
| **D8** cross-model evolver | **1** — `custom-refinement.ts` 패턴 그대로의 확장 1파일 (`custom-refinement.ts:20-108`이 사실상 레퍼런스 구현) | 2번째 모델 자격증명. `modelRegistry` 재사용 (`custom-refinement.ts:25-33`) | **약한 solver에는 역효과**: Sonnet solver에서 Same 55.3 / Cross 55.7 **< No-Evolve 58.0** (`paper:968-973`). 따라서 solver 역량 전제를 명시하고 회귀 시 즉시 off. 반환 편집은 코어 apply에서 재검증되므로 손상 위험은 낮음 (`custom-refinement.ts:6-8`, `refinement.ts:637-663`, `:673-714`) | Figure 6 (`paper:963-967`): Opus solver **Cross 76.0 > Same 75.3 > No-Evolve 70.7** (SWE-bench Lite). Figure 5: train-split transfer 73.4 < online 75.0 (`paper:930-944`) → 온라인 갱신 우선, cross-model은 비용 절감 옵션 | `{key:"evolver_cost_usd", label:"Evolver cost", format:"usd", higherIsBetter:false}` · `{key:"task_success_rate", …}` **(기존)** |
| **D9** 예산 상한 강제 | **0–1** — 적용 경로에 카운트 검사 추가(기존 파일 수정) 또는 `budget.ts` 1파일 | 없음. topic 축이 필요하므로 D2 또는 `path` 필드 재해석 선행 (`refinement.ts:776`) | 상한 초과 시 동작 정의 필요(가장 오래된 것 삭제 vs MERGE 강제 vs 신규 SKIP). 무비판적 삭제는 학습 손실 → MERGE(D5) 선행이 안전. 상한을 curator 프롬프트에 입력으로 전달해야 논문과 동형 (`paper:1503-1505`) | Appendix F (`paper:1619-1625`): 예산이 병합을 강제하고 태스크 한정 기록 누적을 방지. **독립 절제 없음** (**추정**: 기여는 D3의 주입 노이즈 감소와 중첩) | `{key:"harness_entry_count", label:"Harness entries", format:"number", higherIsBetter:false}` · `{key:"budget_violation_rate", label:"Budget violations", format:"percent", higherIsBetter:false}` |
| **D0** 평가 배선 | **0** — `autoRefine.enabled:false`로 No-Evolve arm 확보 (`settings-manager.ts:909`), arm 등록은 job-name 접두 규약 (`omp:packages/metaharness/src/experiments.ts:296`) | metaharness 구동 (Bun 의존 — R7 미결, `evopi:docs/design/DECISIONS.md` 및 RUNBOOK R7 참조). 실 모델 키 | 동일 모델·파라미터 고정. seed 42, **3회 평균** (`paper:1741-1747`). 3회 미만이면 evo-on/off 차이를 유의하게 말할 수 없음 | 논문 protocol 그 자체. Table 1 (`paper:612-667`)의 No-Evolve 열이 대조군 정의 | `{key:"task_success_rate", …}` **(기존)** · `{key:"edit_success_rate", …}` **(기존)** · arm 요약은 `passPct`/`costPerTask` 재사용 (`experiments.ts:101-102`, `:122-123`) |

---

## 5. v1 후보 / v2 이연 후보 (선택지 — 결정은 메인 컨텍스트)

R4 3조건 (`RUNBOOK.md:170`): ① prime에 **"없음"** 판정인가 ② 신규 파일 **≤3개** 규모인가 ③ **metaharness 지표로 측정 가능**한가.

### 3조건 체크리스트

| ID | ① 없음 판정 | ② 신규 파일 ≤3 | ③ metaharness 측정 가능 | 전부 ✓ | 비고 |
|---|---|---|---|---|---|
| **D4** 접지 피드백 | ✓ (S8 = 없음) | ✓ 1 (추정) | ✓ 기존 `status:pass\|fail` 그대로 사용, `task_success_rate`로 최종 판정 | **✓✓✓** | 논문 근거 최강 (Table 4). 접지 없이 다른 델타를 켜는 것이 위험하므로 **다른 델타의 선행 조건 성격** |
| **D1** 실패 한정 게이트 | ✓ (S4 = 없음) | ✓ 1 (추정) | △→✓ `refine_trigger_precision`은 신규 계측 필요(추정), 최종 판정은 기존 `task_success_rate` | **✓✓✓** (③은 프록시 신규 계측 전제) | D4와 신호원이 동일 → **묶으면 파일 수 절감** |
| **D2** 배치 이중 컴파일 | ✓ (S6 = 없음) | △ 2–3 (추정, 상한 경계) | △→✓ hit-rate 2종 신규 계측 필요(추정), 최종 판정은 기존 지표 | **경계** | 코딩 트랙 절제 근거는 가장 명확(Table 3 SWE General Only 66.67). ②가 상한에 걸침 |
| **D9** 예산 상한 | ✓ (S7 = 없음) | ✓ 0–1 (추정) | ✓ `harness_entry_count` 신규(추정), 위반율 관측 가능 | **✓✓✓** (단 D5 또는 삭제 정책 선행 필요) | 단독 도입 시 "초과분 처리" 정책이 논문에 명시되지 않음 → MERGE(D5, ①=✗) 의존 위험 |
| **D0** 평가 배선 | ✓ (prime에 없음) | ✓ 0 | ✓ 정의상 | **✓✓✓** | 델타라기보다 **전제 인프라**. R7(Bun) 미결에 종속 |
| **D3** Select + 예산 | ✗ **부분** (Inject 존재, Select만 없음) | ✓ 1–2 (추정) | ✓ `injected_entry_count`, `select_cost_usd` | **①에서 탈락** | 단계를 "Select"로 쪼개면 ①=✓가 되지만, **판정 단위를 사후에 재정의하는 것이므로 보수적으로 ✗ 처리**했다 |
| **D7** `y`/`f` 슬롯 | ✗ 부분 | ✓ 0–1 | ✓ (D4와 공유) | ①에서 탈락 | **D4에 흡수시키는 것이 자연스럽다** (동일 배선 지점) |
| **D5** MERGE/SKIP | ✗ 부분 (create/update 존재) | ✓ 0–1 | ✓ `merge_edit_share` | ①에서 탈락 | 독립 성능 근거도 없음 |
| **D6** 엔트리 스키마·포맷 | ✗ 부분 | △ 0–2 | ✗ 성능 인과 지표 없음 (프록시만) | ①③ 탈락 | 논문에도 성능 근거 없음 |
| **D8** cross-model evolver | ✗ 부분 (확장점 존재) | ✓ 1 | ✓ `evolver_cost_usd` | ①에서 탈락 | Figure 6 근거는 강하나 **약한 solver에 역효과** — 리스크 항목 |

### 선택지 A — 최소 v1 (근거 최강만)

- v1: **D4** (+ 흡수: D7) , **D0**
- v2: D1, D2, D3, D5, D6, D8, D9
- 논리: 3조건 전부 ✓ 이면서 논문 효과 근거가 직접 절제(Table 4)로 존재하는 유일한 항목이 D4다.
  신규 파일 1개 수준이고 metaharness `status:pass|fail`을 그대로 쓴다.
  D7은 D4와 배선 지점이 같아 별 항목으로 세면 오히려 파일 수가 늘어난다.
- 리스크: evo-on arm의 이득 폭이 Table 4 SWE 기준 +3.3~3.7pt 예상이라 3회 평균에서 유의성이 나올지는
  샘플 수에 의존한다 (**추정**).

### 선택지 B — 접지 + 트리거 (신호원 공유 묶음)

- v1: **D4 + D1** (+ 흡수: D7), **D0**
- v2: D2, D3, D5, D6, D8, D9
- 논리: D1과 D4는 **같은 신호원**(외부 pass/fail)을 읽는다. 한 확장 파일에서 "실패면 refine 하고,
  그 실패 신호를 refine 입력에 넣는다"를 함께 구현하면 총 신규 파일 1~2개(추정)로 두 델타를 덮는다.
  둘 다 ①=✓(S4, S8 모두 "없음").
- 리스크: D1의 독립 성능 근거가 §3.2 서술뿐이다(`paper:436-449`). Table 3 No Propose 행은
  "제안 단계 제거"의 절제이지 "실패 한정"의 절제가 아니다 — 근거 강도를 과대평가하지 말 것.
  또한 `{skip:true}` 경로가 조용히 refine을 멈출 수 있다 (`agent-session.ts:7995-8001`).

### 선택지 C — 코딩 트랙 절제 근거 우선 (2레벨 포함)

- v1: **D4 + D1 + D2** (+ 흡수: D7), **D0**
- v2: D3, D5, D6, D8, D9
- 논리: 코딩 벤치마크(SWE-bench Lite)에서 **직접 절제 수치가 있는 두 항목이 D4(Table 4)와 D2(Table 3)** 다.
  D2의 General Only 66.67 vs No Evolve 63.67은 evopi 코딩 트랙 가설과 정확히 겹친다 (`paper:906-912`).
- 리스크: D2가 ② 상한(3파일)에 걸친다 — 배치 경계 정의까지 포함하면 초과 가능(**추정**).
  또한 D2는 전역 스토어 쓰기를 늘려 롤백/동시성 표면을 확대한다 (`refinement.ts:736-749`, `:374-379`).

### v2 이연 근거 요약

| ID | v2 이연 사유 |
|---|---|
| D3 | ① 부분 판정(Inject 존재). 논문에 Select 절제 실험 없음 → 이득 가설이 간접 |
| D5 | ① 부분 판정. 독립 성능 근거 없음. D9와 상호 의존 |
| D6 | ① 부분 판정 + ③ 성능 인과 지표 부재. 논문도 검사성·이식성만 주장 |
| D8 | ① 부분 판정(확장점 이미 존재). 약한 solver 역효과 리스크 (`paper:968-973`) |
| D9 | 3조건은 통과하나 초과분 처리 정책이 논문 미명시 → D5(v2) 의존. 단독 v1은 정책 공백 |
| D7 | D4에 흡수 권고 (별 항목 유지 시 ① 부분으로 탈락) |

---

## 6. 논문 근거가 없는 항목 · 추정 표기 목록

논문에 근거가 없는 항목은 **만들지 않았다**. 아래는 근거가 약하거나 추정이 개입한 지점의 전수 목록이다.

| 지점 | 성격 |
|---|---|
| 모든 "신규 파일 N개" 수치 | **추정** — 실제 구현 없이 배선 지점 개수로 산정 |
| D1의 코딩 트랙 기여 폭 | **추정** — 논문에 "실패 한정"의 독립 절제 없음. Table 3 No Propose는 다른 절제 |
| D3의 이득 가설 | **추정** — Select 절제 실험 없음. RQ1 노이즈 논지(`paper:679-686`) + Table 2 EDS 하락(`paper:798-806`)의 간접 추론 |
| D5·D9의 이득 가설 | **추정** — 예산·병합의 독립 절제 없음. Appendix E.2/F 서술만 |
| D6의 이득 가설 | **추정** — 논문은 성능이 아니라 검사성·이식성만 주장 (`paper:1531-1539`) |
| 신규 `MetricDefinition` 7종의 계측 실현성 | **추정** — `BENCHMARK_DEFINITIONS.metrics[]`와 스냅샷 `metrics`에 등록 필요 (`benchmarks.ts:16-20`, `:73`). 기존 등록 kind는 3종뿐 (`store.ts:19`) |
| D0을 "델타"가 아니라 "전제 인프라"로 분류 | **추정** — 분류 판단 |
| 실패 신호원 후보 (b) "세션 내 툴 실패 카운트" | **추정** — prime에 해당 집계기를 찾지 못했다 |
| D4 예상 이득 폭의 유의성 | **추정** — 3회 평균·샘플 수 의존 (`paper:1741-1747`) |
| 논문 미포함 사항 (참고) | 논문은 **자연어 지침 하네스만** 평가했고 실행 가능 코드 스킬·구조화 프로그램은 미검토 — Limitations `paper:1051-1061`. prime `HarnessEntry.kind:"skill"`은 **Python 참조를 강제**하므로(`refinement.ts:137`, 검증 `:689-712`) **prime 쪽이 논문 범위 밖이다.** 이 축의 성능 주장은 논문에서 끌어올 수 없다 |
| 멀티에이전트 하네스 | 논문 범위 밖 (`paper:1051-1057`). prime의 subagent kind(`refinement.ts:138`)에 대한 논문 근거는 없다 |
