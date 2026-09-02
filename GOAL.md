# GOAL: oh-my-evopi (v2 — 2026-09-02 감사 반영)

> 개정 이력: v1(착수 시점, RUNBOOK v4 §5-1) → **v2** — 초기 목표 정합성 감사
> (docs/design/AUDIT-initial-goal.md) 결과 반영: 논문 기반 확정(D8), 모델 커넥팅
> 요구의 3단 상태 정본화, 감사 추적 절 신설.

## 최종 목표
prime-agent 를 골격으로 oh-my-pi(omp) 의 TypeScript 자산을 선별 이식하고,
Evo-Harness 논문(arXiv **2608.15071**, 확정 — D8) 의 델타를 적용한 코딩 어시스턴트
CLI `evopi`. 초기 구상의 arXiv 2608.05446(EvoHarness-RL)은 본체가 SFT+GRPO **학습**
이라 frozen-solver CLI 조건에서 이식 불가 판정 — 무학습 이식 가능 개념 3종
(Belief/Progress/Experience 뷰, harness annealing, cost-aware 주입)은 v2 백로그
(cost-aware 주입은 B3/M17 로 선반영). 경위·판정: AUDIT §C1, DECISIONS D8.

## 고정 제품 요구사항 (v2 정본)
- 설치: curl 원라이너 (prime install.sh 45KB, omp curl -fsSL https://omp.sh/install 참고)
- 실행 커맨드: `evopi`
- 설정/상태 경로: `~/.evopi` 단일화 (.omp, .prime 잔존 0건)
- 랜딩 ASCII 아트: 양쪽 참고, 직관적이면서 독창적으로 새로 디자인
- 모델 커넥팅: omp + prime 방식 **합집합** — 감사 후 3단 상태로 정본화:
  - **이식+배선 완료 (prime 측 전부)**: models.generated(카탈로그), oauth,
    bedrock-provider, openrouter-reasoning, env-api-keys, mcp, cache-pricing
  - **이식 완료 + 배선 (수정 계획 B1·B2, M15-M16)**: omp dialect(11방언 in-band 툴콜),
    omp auth-storage(풀)+auth-retry(=auth-pool)
  - **v2 이연 [자동확정]**: auth-gateway, auth-broker (Bun.serve 사이드카 — Phase 3),
    usage, provider-details, registry 선언 패턴 (감사 P3 소급 판정 — prime 측
    cache-pricing/models.generated 가 부분 커버)
  - **이식 후보 (수정 계획 B4, M18)**: oneshot-retry (235줄, Bun 0건)
- 평가: 코딩 트랙 A/B (metaharness 기반). **ALFWorld 는 범위에서 제외.**

## 감사 추적 (2026-09-02)
초기 목표 정합성 감사: **docs/design/AUDIT-initial-goal.md** (판정: C3 RLM·C4 python
직접 검증 PASS / C2 pi 생태계 구조 PASS·실효 PARTIAL / C1 논문 15071 확정).

| 갭 | 내용 | 계획 | 상태 |
|---|---|---|---|
| GAP-1 | 논문 05446→15071 무기록 전환 | P1a(소급 확정)·P1b(무학습 개념 백로그) | P1a 완료, P1b=B5 |
| GAP-2 | 휴면 백포트 3종(dialect·auth-pool·mnemopi) | P2a=B1(M15)·P2b=B2(M16)·P2c=B3(M17) | 계획 승인 |
| GAP-3 | 고정 요구 4종 무판정 탈락 | P3(소급 판정)·B4(oneshot-retry, M18) | P3 완료, B4 계획 승인 |
| GAP-4 | 실 A/B 평가 SKIP(키 부재) | P4=B6(실행 조건 문서화, 실행은 키 확보 시) | 계획 승인 |

## 참조 소스
1. REPO-A: /opt/workspace/local/sw4kim/my-agent/oh-my-pi      ← TS 자산 공급원 (읽기 전용)
2. REPO-B: /opt/workspace/local/sw4kim/my-agent/prime-agent   ← 골격 (읽기 전용)
3. PAPERS: /opt/workspace/local/sw4kim/my-agent/papers        ← Evo-Harness 1편
4. REF   : ./refs/  (Claude Code 아키텍처 slide PNG, evo-harness.txt)
5. 분석 문서: ../oh-my-pi-analysis.md, ../PRIME_AGENT_ANALYSIS.md (단독 포크 전략 2종),
   ../evo-harness-paper-summary.md (논문 요약 + R4 델타 시드),
   ../RUNBOOK.md 「병합 설계 분석」 (병합 전략 — 충돌 시 코드 실측이 우선)

## 진행 규칙 (엄수 — GOAL 모드)
- **무인 순차 실행.** Phase 종료 시 STOP 하지 않는다. RUNBOOK의
  「GOAL 모드 실행 규칙」의 자동 판정 정책·검증 루프·정지 조건을 따른다.
- **이번 구현 사이클에서 git 작업(init/commit/tag)은 사용자 지시로 제외한다.**
  RUNBOOK의 git tag 지점은 REVIEW.md 에 "체크포인트 도달" 기록으로 대체.
- 산출물은 파일로 남긴다. 채팅 컨텍스트를 상태 저장소로 쓰지 않는다.
- 게이트 자동 판정은 DECISIONS.md에 [자동확정]으로, 사후 리뷰 항목은 REVIEW.md에,
  3회 실패 항목은 BLOCKERS.md에 기록한다.
- 추측 금지. 근거 없는 주장은 "미확인" + 파일경로:라인 인용.
- 원본 레포 2개는 읽기 전용. 절대 수정 금지.
- 구현은 최소 모듈 단위. 모듈 1개 = 구현 + 검증 + spec 대조 통과 후 다음.
- 이미 확정된 D1/D2/D4/D5/D7 과 이식 등급표는 재론하지 않는다.

## 서브에이전트 3종
- omp-analyst   : REPO-A 등급 A/B/C 패키지 심화  → docs/analysis/omp.md
- prime-analyst : REPO-B 커널·harness·샌드박스   → docs/analysis/prime.md
- evo-analyst   : 논문 ↔ prime 델타 분석          → docs/analysis/evo.md

## 산출물 경로
docs/analysis/{omp,prime,evo}.md, OPEN-QUESTIONS.md
docs/diagrams/{omp-harness,prime-harness}.png (+ .dot)
docs/design/{DECISIONS,PORTING,PROVENANCE}.md
docs/specs/SPEC.md
docs/plans/PLAN.md
docs/eval/{RESULTS,RELEASE-CHECK}.md
REVIEW.md    ← 사후 리뷰 항목 누적 (GOAL 모드)
BLOCKERS.md  ← 3회 실패·판정 불가 항목 (GOAL 모드)

## Phase 4 중점 항목 (반드시 깊게)
prime 의 IPython 커널 (= "python interpreter",
위치: packages/coding-agent/src/core/kernel/):
- bootstrap.ts(916): uv 부트스트랩, 기본 패키지, Python 스킬 설치·정렬
- repl-manager.ts(1502): REPL 수명주기, 셀 실행, 출력 캡처, 에러 처리
- state-snapshot.ts(47) + kernel-state.dill|json: 상태 직렬화·복원
- boot-gate.ts(34): 부팅 게이트 조건
- Python 스킬 계약: SKILL.md + pyproject.toml + src/<import_name>/__init__.py
- rlm.harness 연결: refine 스킬이 커널에서 호출되는 경로 (await refine.run())
- **D3: 프로세스 샌드박싱을 이 커널에 결합하는 방법 — 유일한 설계 공백**
