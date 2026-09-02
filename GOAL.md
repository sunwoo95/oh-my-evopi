# GOAL: oh-my-evopi

## 최종 목표
prime-agent 를 골격으로 oh-my-pi(omp) 의 TypeScript 자산을 선별 이식하고,
Evo-Harness 논문(arXiv 2608.15071) 의 델타를 적용한 코딩 어시스턴트 CLI `evopi`.

## 고정 제품 요구사항 (변경 불가)
- 설치: curl 원라이너 (prime install.sh 45KB, omp curl -fsSL https://omp.sh/install 참고)
- 실행 커맨드: `evopi`
- 설정/상태 경로: `~/.evopi` 단일화 (.omp, .prime 잔존 0건)
- 랜딩 ASCII 아트: 양쪽 참고, 직관적이면서 독창적으로 새로 디자인
- 모델 커넥팅: omp + prime 방식 **합집합**
  omp 측: auth-gateway, auth-broker, auth-storage, auth-retry, dialect, registry,
          usage, provider-details, oneshot-retry
  prime 측: models.generated(카탈로그), oauth, bedrock-provider, openrouter-reasoning,
           env-api-keys, mcp, cache-pricing
- 평가: 코딩 트랙 A/B (metaharness 기반). **ALFWorld 는 범위에서 제외.**

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
