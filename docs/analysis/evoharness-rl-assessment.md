# EvoHarness-RL(arXiv 2608.05446) 집중 점검 — "Qwen3-8B ≈ Opus" 주장과 evopi 이식 가능성 (2026-09-03)

> 원문: `refs/evoharness-rl.{pdf,txt}` (v1, 2026-08-05, UIUC + Meta AI, 16p). 인용은 `paper:라인`(txt 기준).
> evopi 코드 인용은 `파일:라인`. 사용자 제공 BPE 대응 분석(2026-09-03)의 인용은 전부 실코드와 일치함을 확인했다.
> 선행: docs/design/DECISIONS.md D8(15071 채택, 05446 무학습 개념 3종은 v2 백로그), docs/analysis/harness-comparison.md.

## 0. 결론 먼저

1. **"Qwen3-8B 가 Opus 에 근사"는 조건부 진술이다.** 96.9% 는 (a) Claude Opus 가 만든 87개 시연 궤적으로 SFT, (b) 같은 6개
   태스크 가족의 ALFWorld 에서 GRPO 150 epoch(8×H200), (c) 실험 스토어 통합도 Opus 가 수행 — 이 셋을 다 갖춘 뒤의 **seen split** 수치다
   (`paper:305-333, 748-754, 772-787, 808-833`). 즉 "8B 가 Opus 급"이 아니라 **"Opus 를 교사·큐레이터로 둔 8B 가 훈련 분포 안에서
   Opus 급"** 이다. unseen split 은 86.6% (`paper:388`), Opus 의 unseen 수치는 미보고.
2. **frozen solver 에 바로 옮길 수 있는 것은 "프롬프트 시점 BPE 하네스(EvoHarness-Base)"이고, 그 이득은 실측되어 있다**:
   Opus +2.1 / GPT-4.1 +22.1 / GPT-5 +25.7 / frozen Qwen3-8B +8.5(seen)·+27.6(unseen) (`paper:313-318, 331, 385-386`).
   학습(SFT·GRPO)과 그 산물인 **harness annealing 은 이식 불가** — 파라미터가 바뀌어야 생기는 현상이다 (`paper:426-447`).
3. evopi 는 BPE 의 **Experience 축은 이미 강하고(하네스 원장 + refine + 접지), Progress 축은 구조가 없고(서브골 리스트 부재),
   Belief 축은 커널 네임스페이스에 암묵**이다. 논문 스스로 소프트웨어 환경에선 Progress 가 가장 중요하다고 명시(`paper:650-651`)
   하므로, evopi 가 가져갈 1순위는 **Progress 구조화 + recall 을 push→pull 로** 이며, 이는 모두 evo-off 무영향 확장으로 구현 가능하다.
4. 코딩 트랙 이득은 **미검증**이다. 논문은 ALFWorld 단일 환경(70스텝, 규칙 기반 belief 파서, 키워드 검색)이고 소프트웨어 환경은
   Appendix A 의 추측 한 문단뿐 (`paper:647-653`). evopi 는 4-arm 에 BPE arm 을 추가해 직접 측정해야 한다.

## 1. 주장의 해부 — 무엇이 96.9% 를 만들었나

| 구성 | 값 | 근거 | frozen evopi 에서 |
|---|---|---|---|
| 정책 모델 | Qwen3-8B (유일한 학습 대상) | `paper:748-750` | 이식 불가 (파라미터 고정) — 단 evopi 는 qwen3 dialect 로 오픈모델 구동 가능 |
| 교사 | Claude Opus 가 같은 BPE 인터페이스로 500게임 → 성공 87궤적, 1,153 next-action 쌍, 하네스 호출 18%(commit 202/recall 114/note 55/track 34) | `paper:772-780` | 시연 수집·SFT 불가. 단 "Opus 가 하네스를 어떻게 쓰는가"의 분포는 프롬프트 규칙으로 근사 가능 |
| 통합 모델 | Claude Opus (epoch 경계에서 ADD/UPDATE/REMOVE/SKIP) | `paper:751-754, 911-925` | **이식 가능** — evopi refine 플래너가 이미 이 역할(create/update/delete). MERGE/SKIP 어휘만 추가(evo.md D5) |
| RL | GRPO 150 epoch, G=8, 128궤적/step, 보상 = 10·성공 + 효율 + 다양성(코사인 annealing) − 스팸 − 형식 | `paper:276-291, 820-841` | 이식 불가 |
| 벤치 | ALFWorld seen 140 태스크, 6 가족, Tmax 70 | `paper:305-307, 811` | 코딩 트랙과 무관 — GOAL.md 가 ALFWorld 제외 |
| 결과 | ReAct 47.9 → Base 56.4 → SFT 68.6 → RL 96.9 (seen) / 50.0 → 77.6 → 69.4 → 86.6 (unseen) | `paper:320,331-333,385-388` | **Base 단계만 해당** |

주목할 점 두 가지:
- **unseen 에서 SFT 가 Base 보다 나쁘다**(69.4 < 77.6, `paper:414-416`) — 교사 패턴 모방은 새 환경에서 "언제 접근할지"를 못 배운다.
  RL 이 이를 회복(86.6). 즉 "언제"의 정책은 학습 없이 좋아지지 않으며, frozen solver 는 **프롬프트 규칙 + 결정적 트리거**로 대체해야 한다.
- 절제(`paper:372-376`, frozen Qwen3-8B): Experience 제거가 가장 큰 손실(48.6), Belief 제거(50.0), Progress 제거(50.7). 셋 모두 Base(56.4)
  보다 나쁘다 → 세 구획은 시너지. 단 이 수치는 ALFWorld 특성(객체 위치 prior 재사용)에 기인하며, 코딩에서는 논문이 Progress 우위를 예측.

## 2. BPE ↔ evopi 대응 (사용자 분석 검증 + 보강)

사용자 분석의 판정(Belief 약함 / Progress 부분 / Experience 강함, 액션 4종 대응표)은 **코드와 일치**한다. 아래는 보강·정정 사항.

| 논문 요소 | evopi 현재 | 보강 사실 |
|---|---|---|
| Belief 저장소 + `track` | 없음. 커널 네임스페이스(dill 스냅샷)와 로컬 memory 엔트리(refinement.ts:141)가 암묵 대응 | 논문 belief 트래커는 **LLM 호출 0 의 규칙 파서**(`paper:763-765`). 코딩 환경 등가물 = `git status/diff`·테스트 결과·편집 로그 — 전부 커널에서 결정적으로 조회 가능. 별도 스토어 없이 `track(path)` 함수 하나로 구현 가능 |
| Progress `(gᵢ, σᵢ)` + `commit` | `GoalState{status, objective, tokenBudget…}` 단일 목표(goals.ts:10-19), `goal.get/create/complete`(agent-session.ts:2953-2964, 9238). 서브골 구조 **없음**(goals.ts grep 0) | 논문은 상한 8 의 bounded 리스트(`paper:814`)를 **매 턴 PLAN 뷰로 렌더**(`paper:890-898`). evopi 는 로컬 memory 자유 텍스트에 의존 → 구조화가 1순위 갭 |
| Experience + `recall`/`note` | 하네스 원장 4종(prompt/memory/skill/subagent), refine create/update/delete, 롤백, refinements.jsonl, 접지(D4) | (a) evopi 는 **push**(kind 별 6개 시스템 프롬프트 상주, refinement.ts:26) vs 논문 **pull**(recall 쿼리, top-3/카테고리, `paper:815`). (b) 논문은 **usage count + LFU eviction, 카테고리당 80 상한**(`paper:768-770, 817-819`) — evopi 원장에 usage/eviction **없음**(harness.py·refinement.ts grep 0) = evo.md D9 미해소. (c) note 는 버퍼 → 통합 모델이 ADD/UPDATE/REMOVE/SKIP(`paper:904-925`) — evopi refine 은 SKIP/MERGE 부재(D5) |
| 액션 비용 | 논문: 하네스 액션 = 환경 액션과 **같은 스텝 예산**(`paper:219-222`) | evopi 는 하네스 액션이 **ipython 셀 안의 Python 호출**이라 모델 턴을 소비하지 않는다 — `commit()`·`note()` 를 환경 액션과 같은 셀에 묶을 수 있음. 논문의 "언제 접근할지" 비용 문제가 구조적으로 완화되는 evopi 고유 이점 |
| note 의무 조건 | `paper:879-882`: recall 비어 있었는데 찾음 / recall 과 다른 곳에서 찾음 / 절차 없이 완료 → note 필수 | evopi 대응 = grounded-refine 의 실패 한정(D1)과 방향이 반대(성공 시 기록). **성공-but-recall-빈 경우**를 결정적 트리거로 추가 가능 |
| annealing | 학습 중 호출 빈도 6→1/에피소드(`paper:439-447`), commit/note 가 먼저 사라지고 recall 은 잔존(`paper:635-639`) | frozen 에서 불성립. 무학습 대체 = (i) 7일 반감기 MMR(이미 있음) (ii) LFU eviction (iii) refinements.jsonl 기반 미사용 엔트리 통합 잡 |
| cost-aware | GRPO 효율 보상(`paper:281-282`) | evopi B3(M17) MMR + charBudget 은 **읽기 측 토큰 예산**만. 쓰기 측은 고정 규칙(25턴/compact/외부 실패) |

## 3. evopi 가 가져갈 수 있는 것 / 없는 것

### 가져갈 수 있는 것 (전부 frozen-solver·evo-off 무영향 확장으로 구현 가능)

| # | 항목 | 논문 근거 | evopi 구현 지점 | 비용 |
|---|---|---|---|---|
| P1 | **Progress 원장** — 로컬 하네스에 `progress` 뷰(서브골·상태 ≤8), `commit(subgoal, status)` Python 함수, 매 턴 `PLAN` 블록 렌더 | `paper:154-156, 243-250, 814` / 소프트웨어 환경 Progress 우위 `paper:650-651` | `HarnessEntry.metadata.bpe="progress"` 태깅(refinement.ts:43 metadata 존재) + `formatHarnessStateForPrompt` 3구획 렌더(selectEntries seam :444) + `rlm.harness` CRUD 재사용 | 1~2 파일. 복원은 dill 아닌 원장(세션 재개 시 유지) |
| P2 | **recall 을 pull 로** — `recall(query)` Python 함수(키워드/jaccard top-3 per kind, mnemopi 재사용), 호출 시 usage_count++ | `paper:252-256, 766-768, 815` | harness.py 에 `recall()` + `usage_count` 필드; harness-select.ts 의 jaccard 재사용 | 1 파일 + 스키마 필드 |
| P3 | **예산·eviction** — kind 별 상한(예 80) + LFU, 초과 시 통합 라운드 제안 | `paper:768-770, 817-819` | applyRefinementProposal 에 카운트 검사(evo.md D9), usage_count 로 LFU | D5(MERGE/SKIP) 선행 권장 |
| P4 | **note 버퍼 + 통합 어휘 ADD/UPDATE/REMOVE/SKIP** — 세션 중 `note()` 는 버퍼, 세션 종료/compact 시 저비용 모델이 통합 | `paper:904-925` | grounded-refine 플래너 프롬프트에 4연산 + SKIP 허용; `session_before_refine` 계약 그대로 | evo.md D5+D8 |
| P5 | **성공-무경험 트리거** — recall 이 비었는데 태스크 성공 → note 의무 | `paper:879-882` | grounded-refine 3분기에 (d) 추가: status=pass ∧ recall 히트 0 → 절차 note | 0~1 파일 |
| P6 | **Belief = 결정적 트래커** — `track(path|"world")` 가 git diff·마지막 테스트 결과·편집 로그를 요약 반환(LLM 0) | `paper:236-241, 763-765` | 커널 Python 함수(rlm.bash 재사용). 저장소 신설 불요 | 소형. 우선순위 최하(사용자 분석과 동일 판단) |
| P7 | **BPE arm 평가** — 4-arm 에 `evopi-bpe`(P1+P2 프롬프트 시점) 추가, kind:"edit" 지표로 Base 이득 측정 | `paper:331, 386` 이 ALFWorld 에서만 실측 | eval/arms.md 잡네임 규약만 | 키 확보 시 |
| P8 | **소형 오픈모델 lane** — qwen3 dialect(identity.ts:41) + models.json baseUrl 로 로컬 Qwen3-8B 를 solver 로 연결, P1~P6 하네스와 조합 | `paper:331, 386`: frozen Qwen3-8B 도 Base 로 +8.5/+27.6 | 코드 변경 0 (설정만) | 성능은 미검증 — Table 1 의 "≈Opus" 는 기대 금지 |

### 가져갈 수 없는 것 (정직 기록)
- **SFT+GRPO 학습 본체**와 **harness annealing**: frozen solver 조건에서 정의상 불성립. DECISIONS D8 판정 유지.
- **"Qwen3-8B ≈ Opus" 수치**: 훈련 분포(ALFWorld seen)·교사(Opus)·통합기(Opus) 3중 조건부. 코딩 트랙 전이 근거 없음.
  가중치·코드 공개 여부 원문에 언급 없음(`paper` 전문 grep 0) → 체크포인트 도입 불가.
- **ALFWorld 특유 요소**: 객체-위치 prior(search_priorities, `paper:957-963`), admissible commands. 코딩 등가물은 "파일 위치 prior"
  정도로 약하며 별도 설계 필요.

## 4. evopi 의 상대 장점 / 개선점 (harness-comparison.md §3-4 + 본 점검 종합)

**장점 (Claude Code · omp · prime 대비)**
1. **접지된 자기진화** — 4자 중 유일하게 외부 pass/fail 을 하네스 편집 입력으로 배선(D4). prime 은 자가 판단(Self-Generated), omp 는 스킬
   자동 저작(autolearn)이나 접지 없음, Claude Code 는 MEMORY.md 갱신만.
2. **대조군 내장** — `EVOPI_EVO=off` = prime 바이트 동일. 진화 효과를 측정할 수 있는 구조가 코드에 있다(D7).
3. **하네스 액션의 비용 구조** — 단일 ipython 툴이라 commit/note/recall 이 모델 턴을 소비하지 않는다(§2). 05446 이 RL 로 풀어야 했던
   "언제 접근할지" 문제가 구조적으로 절반은 해소된다.
4. **오픈모델 lane** — dialect 11종 + 풀 로테이션으로 소형 모델·다중 키 운용이 가능. 05446 의 소형 모델 전제와 정합.
5. **배포 위생** — node 전용(Bun 0), curl 원라이너, `~/.evopi` 단일 경로. omp(Bun 1,282회·Rust napi 9 crate) 대비 설치 표면이 작다.

**개선점 (우선순위순)**
1. **Progress 구조화(P1)** — 논문·사용자 분석·코드 실측이 모두 가리키는 최대 갭. 서브골 상태가 없어 장기 작업에서 "무엇을 했고 무엇이
   막혔는지"가 컨텍스트 윈도우에만 있다.
2. **recall pull + 예산·eviction(P2·P3)** — 원장이 append-only 성향(저장 상한 0건). 논문 Figure 4 의 "compact yet diverse" 상태가 안 나온다.
3. **리스크 R-1~R-3**(harness-comparison §4) — 커널 env 상속, OS 샌드박스 부재, 셀 타임아웃 부재. 소형 모델 lane 을 열수록 R-1·R-3 의
   중요도가 올라간다(로컬 모델은 더 자주 무한루프·위험 명령을 생성).
4. **운영 성숙도 갭(omp 대비)** — steering 3중 큐·3층 abort, TTSR, approval 티어, COW worktree, 프리픽스 캐시 안정화는 evopi 에 없다.
   v2 백로그 유지(등급표 D/E).
5. **실측 부재(R-4)** — evo 델타·BPE 이득 모두 논문 수치 인용 상태. P7 arm 을 포함한 A/B 실행이 선행돼야 우선순위 재조정이 가능.

## 5. 권고 실행 순서
P1(Progress 원장) → P2(recall pull) → P5(성공-무경험 트리거, D1 보완) → P4/P3(통합 어휘 + 예산) → P7(BPE arm 측정) → P8(로컬 Qwen3 lane 실측).
P6(Belief)은 P7 결과에서 Clean/Cool 류(상태 검증형) 실패가 보일 때만. 전부 `EVOPI_EVO`/`harness.*` 게이트 뒤 optional — D7 유지.
결정 기록은 착수 시 DECISIONS.md M-phase 로(본 문서는 근거 분석).
