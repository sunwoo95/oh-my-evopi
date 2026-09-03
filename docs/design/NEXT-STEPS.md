# NEXT-STEPS — v0.10.0 이후 후속 작업 (2026-09-03)

> 입력: docs/eval/SELF-EVAL.md(SE 12라운드 잔여), docs/analysis/harness-comparison.md §4(리스크 R-1~R-4),
> docs/analysis/evoharness-rl-assessment.md §3(P1~P8), omp-master-arch.md(운영 성숙도 갭). 우선순위 = 리스크 해소 효과 ÷ 비용.
> 각 항목은 착수 시 DECISIONS.md 에 M-phase 트리거를 기록하고, evo-off 무영향·prime 골격 무수정 원칙을 지킨다.

## 0. 현재 상태 (재배포 점검 결과)
- v0.10.0 = main `04d6a94` / gh-pages `ea2aafe`. 작업 트리 clean, 게시 타르볼에 docs·CHANGELOG 반영 확인 → 추가 재배포 불필요.
- 이번 커밋: CI(`ci.yml`)에 shellcheck 설치 추가 → `npm run check`의 `check:shell`이 CI에서 실제 강제됨(로컬 skip 폴백은 유지).

## 1. 트랙 A — 안전·견고성 (SE 잔여, 우선)

| # | 항목 | 왜 | 무엇을 | 검증 | 비용 |
|---|---|---|---|---|---|
| A1 | **OS 샌드박스 승격 (R-2, D3 재검토)** | 집행 계층이 아직 "컨테이너 경계 전제" 문서로만 존재. 현 환경은 unprivileged userns 차단이라 bwrap 검증 불가 | userns 가용 호스트(또는 `--cap-add SYS_ADMIN` 컨테이너)에서 D3 3종 스모크(uv 부트스트랩·커널 부팅·dill 저장/복원) 재실행 → 통과 시 `examples/extensions/sandbox` 를 빌트인으로 승격, `sandbox-probe` 가 available 이면 bash 래핑 자동 활성. 커널 프로세스 자체를 bwrap 안에서 spawn 하는 옵션(`kernel.sandbox: "bwrap"`)도 같은 프로브 뒤에 둠 | 프로브 available 환경에서 `rm -rf /` 가 EROFS 로 실패하는 통합 테스트; 프로브 unavailable 환경은 기존 폴백 바이트 동일 | 중 (환경 확보가 관건) |
| A2 | 커널 env allowlist 모드 | R1 은 denylist(알려진 키만 차단). 미지의 `*_API_KEY`/`*_TOKEN` 은 통과 | `kernel.envPolicy: "denylist"(기본) \| "allowlist"` — allowlist 는 PATH/HOME/LANG/LC_*/TERM/TMPDIR/XDG_*/EVOPI_*/VIRTUAL_ENV + 사용자 지정만 전달 | kernel-env 테스트 확장, websearch(SERPER) 스킬이 allowlist 에서 명시 추가 시 동작 | 소 |
| A3 | 게이트 오탐 완화 | `rm -rf <임시 dir>` 도 UI 확인을 요구(no-UI 면 차단). eval/무인 실행에서 마찰 | `rm -rf` 는 대상이 `/`, `~`, `$HOME`, `*`, `..`, 절대경로-비 cwd 일 때만 위험 판정; cwd 하위 상대경로는 통과. 프로젝트 `.evopi/agent/settings.json` 의 `permissionGate.allow[]` 정규식 화이트리스트 | 기존 16 테스트 유지 + 오탐/정탐 코퍼스 20건 추가 | 소 |
| A4 | 셀 타임아웃 UX | 30분 기본이 장시간 테스트/학습 셀과 충돌 가능 | 타임아웃 임박(80%) 시 툴 결과에 경고 스트림, `/kernel timeout <ms>` 슬래시로 세션 내 조정, 타임아웃 발생 시 TUI notify | 실커널 테스트 1건 추가 | 소 |
| A5 | 위험 명령 텔레메트리 | 차단/경고 빈도를 모르면 A3 튠 불가 | 게이트 결정을 세션 로그(jsonl)에 `permission_gate` 이벤트로 기록(명령 해시만, 원문은 로컬) | 로그 스키마 테스트 | 소 |

## 2. 트랙 B — 하네스 진화 (EvoHarness-RL 이식, evo-off 무영향)

순서는 assessment §5 권고 그대로. 전부 `EVOPI_EVO`/`harness.*` 게이트 뒤 optional.

| # | 항목 | 논문 근거 | 구현 지점 | 검증 |
|---|---|---|---|---|
| B1 | **Progress 원장 (P1)** — 서브골·상태 ≤8 리스트, 커널 `commit(subgoal, status)`, 매 턴 `PLAN` 블록 | `paper:154-156, 243-250, 814`; SW 환경 Progress 우위 `paper:650-651` | `HarnessEntry.metadata.bpe="progress"` 태깅 + `formatHarnessStateForPrompt` 3구획 렌더(selectEntries seam) + `rlm.harness` CRUD 재사용; `GoalState` 와 연동 | 원장 단위 테스트 + 시스템 프롬프트 스냅샷(evo off 바이트 동일) |
| B2 | **recall pull (P2)** — `recall(query)` 커널 함수(jaccard top-3/kind, mnemopi 재사용), `usage_count++` | `paper:252-256, 766-768, 815` | harness.py `recall()` + 스키마 필드 `usage_count`; harness-select.ts 의 jaccard 재사용 | Python 테스트 + host_request 왕복 |
| B3 | 성공-무경험 트리거 (P5) — recall 히트 0 ∧ pass → note 의무 | `paper:879-882` | grounded-refine 3분기에 (d) 추가 | 단위 테스트(모의 신호) |
| B4 | 통합 어휘 + 예산 (P4·P3) — ADD/UPDATE/REMOVE/**SKIP**, kind 별 상한 80 + LFU eviction | `paper:768-770, 817-819, 904-925`; evo.md D5·D9 | refinement.ts 플래너 프롬프트·applyRefinementProposal 카운트 검사 | 회귀: refinement 스위트 + 롤백 |
| B5 | BPE arm 측정 (P7) — `evopi-bpe` arm 추가, kind:"edit" 지표 | Base 이득은 ALFWorld 에서만 실측(`paper:331,386`) | eval/arms.md 잡네임 규약 | **API 키 확보 시** 4-arm+1 × 3회 (GAP-4 해소와 동시) |
| B6 | Belief 결정적 트래커 (P6) — `track(path\|"world")` = git diff·마지막 테스트·편집 로그 요약(LLM 0) | `paper:236-241, 763-765` | 커널 Python 함수(rlm.bash 재사용) | B5 에서 상태 검증형 실패가 보일 때만 착수 |
| B7 | 로컬 소형 모델 lane (P8) — qwen3 dialect + models.json baseUrl 로 Qwen3-8B 연결 | frozen Qwen3-8B 도 Base 로 +8.5/+27.6 | 설정만(코드 0) + 문서 레시피 | "≈Opus" 기대 금지, B5 와 함께 실측 |

## 3. 트랙 C — 평가·측정 (모든 성능 주장의 전제)

| # | 항목 | 내용 |
|---|---|---|
| C1 | **실 A/B 실행 (R-4, GAP-4)** | API 키(셸 export) 확보 → `eval/` 4-arm(omp/prime/evooff/evoon) × seed 고정 × 3회 → RESULTS.md 의 SKIP 을 실측으로 대체. evo 델타·BPE 이득 주장은 이때까지 논문 인용 상태 |
| C2 | 자가평가 스코어카드 자동화 | SELF-EVAL 의 지표(테스트 fail/error, 게이트 패턴 수, 시작시간, 번들, shellcheck)를 `scripts/self-eval.mjs` 로 수집해 JSON 출력 → 릴리스마다 비교. CI 아티팩트로 저장 |
| C3 | kernel-heavy 스위트 CI 편입 | 현재 기본 실행에서 제외(`!kernel-heavy`). CI 별도 job 으로 `test:kernel`(uv 부트스트랩 캐시 포함) 실행 → R4 타임아웃 회귀를 CI 가 잡도록 |

## 4. 트랙 D — 운영 성숙도 (omp 대비 갭, v2 백로그)

| # | 항목 | omp 대응물 | 비고 |
|---|---|---|---|
| D1 | 서브에이전트 worktree 격리 | `task/isolation-runner.ts` + pi-iso COW | Rust 없이 `git worktree` 만으로 시작(COW 는 이연). Claude Code 맵의 "Worktrees" 박스 공백 해소 |
| D2 | steering 3중 큐 · 3층 abort | `agent-loop.ts:2336-2352` | prime agent-loop 수정이 필요 → **골격 무수정 원칙과 충돌**. 상류(prime) 제안 또는 sdk 레이어 우회 검토 후 결정 |
| D3 | 프리픽스 캐시 안정화 | append-only-context.ts | 시스템 프롬프트 재조립 6지점이 캐시를 깨는지 측정 먼저(C2 에 캐시 히트율 지표 추가) |
| D4 | 편집 체크포인트/되감기 | Claude Code 체크포인트 · omp checkpoint/rewind 툴 | 커널 edit 스킬이 diff 를 display 로 방출하므로 세션 아티팩트에 before 스냅샷 저장 → `/rewind` |
| D5 | approval 티어(read/write/exec × always-ask/write/yolo) | `tools/approval.ts` | 현 block/warn/off 3모드를 티어 기반으로 확장 |

## 5. 트랙 E — 문서·배포 위생

- E1 세미나 덱(`docs/seminar`)에 v0.10.0 안전 기본값 슬라이드 1장 추가(Sessions & Permissions 갱신) — 참조 시나리오 유지.
- E2 릴리스 자동화: 현재 수동(`npm version` → sync → build → pack → gh-pages 오버레이). `release.yml` 이 태그 push 로 같은 일을 하므로 다음 릴리스는 `git tag v0.10.1 && git push --tags` 경로로 검증(수동 절차와 산출물 sha 비교).
- E3 `npm version … -ws --include-workspace-root` 가 exit 1 을 반환하면서도 전부 갱신되는 현상 원인 확인(락파일 경고 추정) — 릴리스 스크립트에서 검사 로직으로 흡수.

## 6. 권고 실행 순서
A3(오탐 완화, 무인 실행 마찰 제거) → C2(스코어카드 자동화) → B1(Progress 원장) → B2(recall pull) → A2(allowlist) → C1/B5(키 확보 시 실측) → A1(샌드박스, 환경 확보 시) → D1 → 나머지.
착수 단위는 SE 라운드와 동일: 측정 → 1건 수정 → 회귀 → REVIEW 기록.
