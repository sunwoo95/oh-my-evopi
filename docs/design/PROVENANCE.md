# PROVENANCE — evopi 핵심 개념 출처 추적

> 규칙: 출처 불명 개념 금지. [개념 / 출처 / 원본 위치 / 변경 여부 / 변경 이유].
> 출처 표기: `prime`=prime-agent v0.9.1(MIT), `omp`=oh-my-pi v18.1.2(MIT),
> `paper`=arXiv 2608.15071 v2, `evopi`=신규.
> 라이선스: 양쪽 MIT — 저작권 고지(Mario Zechner, Prime Intellect, Can Bölük/Stencil Labs)
> 유지, THIRD-PARTY-NOTICES 동봉 (omp natives leaf 포함).

| 개념 | 출처 | 원본 위치 | 변경 | 변경 이유 |
|---|---|---|---|---|
| 에이전트 루프 (steering/follow-up/continuation) | prime | packages/agent/src/agent-loop.ts | 없음 | — |
| 스트림 이벤트 계약 (start→delta→done, 실패=이벤트) | prime (pi 유래) | packages/ai/src/{types,stream}.ts | 없음 | — |
| 모델 카탈로그 | prime | packages/ai/src/models.generated.ts | 없음 | 카탈로그 소유자=prime (DECISIONS Phase 3) |
| OAuth 3종·bedrock·env-api-keys·cache-pricing·faux | prime | packages/ai/src/{oauth,bedrock-provider,env-api-keys,cache-pricing,providers/faux}.ts | 없음 | — |
| IPython 커널 (uv 부트스트랩·dill 스냅샷·프로토콜 v3) | prime | packages/coding-agent/src/core/kernel/ + prime-agent-runtime/src/rlm/ | 없음 (D3 폴백로 spawn env 필터 옵션 후보) | D2 확정 |
| 단일 ipython 툴 철학 | prime | src/core/tools/ipython.ts | 유지 + hashline edit를 --tools 선택 툴로 추가 | 철학 충돌을 플래그로 회피 (병합 분석 §B) |
| continual harness (HarnessEntry·refinements.jsonl·autoRefine) | prime | src/core/refinement/refinement.ts, skills/refine/ | 유지 + grounded-refine 확장 추가 | R4 델타 |
| 세션 JSONL 트리·컴팩션 | prime | src/core/{session-manager,compaction}/ | 없음 | D5 확정 |
| 데몬 (슈퍼바이저/워커) | prime | src/modes/daemon/ | **동결** (수정 금지) | 병합 분석 §A |
| TUI 차분 렌더링 | prime (pi 유래) | packages/tui | 없음 | 등급 D |
| piConfig 리브랜딩 메커니즘 | prime | packages/coding-agent/package.json:6-9 + src/config.ts:475-530 | 값 변경: `{"name":"evopi","configDir":".evopi/agent"}` | 요구사항 (~/.evopi 단일화) |
| install.sh 터미널 UI 설치기 | prime | install.sh (45KB) | 함수 접두사·로고·문자열 치환 | 리브랜딩 |
| ASCII 랜딩 | **evopi 신규** (양쪽 참고) | (prime: src/themes/prime-logo.ts 자리) | 신규 디자인 | 요구사항 (독창적 디자인) |
| 다중 크레덴셜 풀 (라운드로빈·사용량 랭킹·형제 재시도) | omp | packages/ai/src/{auth-storage.ts,auth/,auth-retry.ts,oneshot-retry.ts} | **개명 evopi-auth-pool** + catalog import 절단 + Bun 심 | 충돌 C1·C2·C3 |
| 오픈모델 dialect 파싱 (harmony/qwen3/glm/kimi/deepseek) | omp | packages/ai/src/dialect/ | catalog/identity 의존 절단 (로컬 타입) | 충돌 C2 |
| hashline 편집 포맷 ([path#4hex] 앵커·stale 거부) | omp | packages/hashline | natives 호출을 natives-loader 경유로 | R6 |
| mnemopi 메모리 (MMR·중복 병합·벡터 검색) | omp | packages/mnemopi/src/core/ | natives-loader 경유, MCP 겸용은 v2 | R6·병존 결정 |
| pi-natives prebuilt 바이너리 | omp (Stencil Labs 빌드) | dep=meta `@oh-my-pi/pi-natives@18.1.2`(optionalDependencies, natives-loader) → 플랫폼 leaf 자동 설치 | **원본 래퍼 미사용** — evopi natives-loader 신설 | 래퍼가 Bun 전용 (R6 판정 기록). 리스크: 버전 종속·Bazel 산출물 블랙박스. ⚠ 재설치 함정: `.npmrc min-release-age=7`이 최근 수정된 패키지 스펙을 `npm:null@*`로 손상 → clean install은 `npm install --min-release-age=0` 필요 (M14/STEP15 리허설 시 유의) |
| natives-loader (leaf 직접 로드·AVX2 감지·graceful null) | **evopi 신규** | packages/natives-loader | 신규 | R6 결정 2항 |
| metaharness (벤치 러너·arm 규약·대시보드) | omp | packages/metaharness | 사본 격리 (bun 전용, 제품 밖) + 피실험 CLI 경로 설정 | R7 정책 |
| 프롬프트 스킬 3종 (semantic-compression 등) | omp | .omp/skills/ | 경로만 이동 | 등급 A |
| 실패 한정 refine 트리거 | paper §3.2 식(6) | (prime에 없음 — evo.md S4) | **evopi 신규** grounded-refine 확장 내 | R4 델타 D1 |
| 접지 피드백 배선 (verifier/test → refine 입력) | paper RQ4 Table 4 | (prime에 없음 — evo.md S8) | **evopi 신규** grounded-refine 확장 내 (+ y/f 슬롯 = D7 흡수) | R4 델타 D4 — 논문 근거 최강 |
| No-Evolve 대조군·3회 평균·seed 고정 평가 규약 | paper §4.1·I.3 | (러너는 omp metaharness) | 4-arm 등록 (D0) | R4 전제 인프라 |
| general/topic 2레벨 컴파일·Select 모델·예산 상한·MERGE/SKIP·md+yaml 엔트리·cross-model evolver | paper §3.2-3.4 | — | **v2 백로그** (미구현) | R4 판정 (3조건 미충족 — DECISIONS) |
| sandbox (bwrap bash 래핑) | prime 예제 + @anthropic-ai/sandbox-runtime | examples/extensions/sandbox/ | capability 프로브 + graceful degradation 추가 | D3 폴백 |
| permission-gate (의도 계층 allowlist) | prime 예제 | examples/extensions/permission-gate.ts | 번들 확장으로 승격 | R3 (착수 시 판정) |
| 컨테이너 경계 = 집행 계층 (eval 프로파일) | **evopi 신규 (환경 실측)** | DECISIONS D3 판정 기록 | 신규 문서화 | bwrap 불가 환경 실증 |
