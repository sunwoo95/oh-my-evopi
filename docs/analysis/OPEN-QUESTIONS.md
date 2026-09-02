# OPEN-QUESTIONS — Phase 1 분석의 모순·미확인 항목

> 작성: 2026-09-02. 출처: docs/analysis/{omp,prime,evo}.md 교차 검토.

## 해소된 모순

1. **RUNBOOK v3 "omp ai의 Bun 사용 5파일" ↔ omp.md 실측 30파일·114회.**
   → v3의 grep 범위 오류. omp.md §1.3이 정본. RUNBOOK 해당 행 정정 완료 (2026-09-02).
   R7 함의: "5파일 포팅" 전제는 무효이나, ~80%가 1줄 심 계열이고 구조적 재작성
   (Bun.serve/WebSocket)은 auth-broker/gateway 2서버에 국소화 → v1 백포트 범위를
   auth-storage/retry·dialect·registry로 한정하면 기본 정책(제품 node 전용) 유지 가능.
2. **evo-harness-paper-summary.md §7 시드 "스킬당 예산 상한 미상" ↔ evo.md S7 실측.**
   → prime 적용 경로에 카운트 검사 0건 (표시 상한만 존재) — "없음" 확정.

## 미확인 (후속 STEP에서 검증)

| # | 항목 | 확인 시점 | 리스크 |
|---|---|---|---|
| Q1 | omp `auth-storage.ts`의 sqlite 바인딩이 `bun:sqlite`인지 (node:sqlite/better-sqlite3 대체 필요 여부) | STEP 13 auth 모듈 착수 시 | 백포트 비용 증가 (중) |
| Q2 | metaharness `kind:"edit"` 어댑터가 피실험 CLI를 무엇으로 spawn 하는가 — omp 바이너리 전제인지, 임의 커맨드 주입 가능한지 (A/B 4-arm의 실질 관건) | STEP 13 평가 모듈 착수 시 | A/B 설계 변경 (상) |
| Q3 | `canonicalArmOf` (experiments.ts:249) 정규화 규칙 — arm 명명에 영향 | STEP 14 | 낮음 |
| Q4 | evo.md 제안 신규 MetricDefinition 7종의 계측 실현성 (BENCHMARK_DEFINITIONS 등록 절차는 확인, 스냅샷 생성기 개조 범위 미확인) | STEP 11 R4 판정 시 ③ 조건에 반영 | v1 델타 범위 (중) |
| Q5 | omp ASCII 랜딩 위치 (glyph.ts는 오탐) | 불요 — evopi는 독자 디자인 요구사항. 참고용만 | 없음 |
| Q6 | prime 커널 spawn이 `...process.env` 전체 상속 (repl-manager.ts:257) — API 키가 커널에 노출 | STEP 13 커널 모듈에서 env 필터링 개선 후보 (v1 범위 판단 필요) | 보안 (중, D3 폴백과 연동) |
| Q7 | prime.md §5 잔여 참조 항목 (packages/ai 모듈별 상세) — 백포트 어댑터 설계 시 원본 직접 재확인 | STEP 10/13 | 낮음 |

## 안전 함의 (설계 구속)

- **evo.md S8**: prime refine = 논문 Self-Generated 동형 → **접지 배선(D4) 없이 evo-on arm을
  구성하지 말 것** (Table 4: Self-Generated는 No-Evolve보다 악화). STEP 11 R4 판정과
  SPEC evo 레이어 명세에 구속 조건으로 반영한다.
- **evo.md D8**: cross-model evolver는 약한 solver에 역효과 — v2로 미루고 solver 역량
  전제를 문서화.
