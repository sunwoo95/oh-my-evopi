# oh-my-pi (omp) 심화 분석 — Phase 1 (omp-analyst)

> 작성: 2026-09-02. 대상: /opt/workspace/local/sw4kim/my-agent/oh-my-pi (v18.1.2, 읽기 전용).
> 전제: 이식 등급표 확정(재론 없음). 사전 조감은 ../../../oh-my-pi-analysis.md — 본 문서는
> 백포트 실무에 필요한 심화 실측만 담는다. R6은 이미 [자동확정 — prebuilt natives 채택]
> (DECISIONS.md)이므로 mnemopi/hashline은 "재구현 설계"가 아니라 **계약 문서화**만 수행.
> ※ 주의: 세션 중단으로 본 문서는 메인 컨텍스트의 표적 실측으로 작성됨 — 등급 A 모듈별
> 공개 인터페이스 전수는 백포트 모듈 착수 시점에 해당 파일을 직접 읽어 보완할 것.

## 1. 등급 A — packages/ai

### 1.1 구성 (백포트 대상 서브시스템)
- `src/auth-storage.ts`, `src/auth/` (sqlite-credential-store.ts 포함) — SQLite(agent.db)
  다중 크레덴셜 저장·로테이션. ⚠ prime `core/auth-storage.ts`(auth.json)와 **동명이역**
  — 병합 리스크 1순위 (RUNBOOK 병합 설계 분석 §D-1, `evopi-auth-pool`로 개명 이식 예정).
- `src/auth-retry.ts`, `src/oneshot-retry.ts` — 401/사용량 초과 시 형제 크레덴셜 재시도.
- `src/auth-broker/`, `src/auth-gateway/` — 컨테이너용 크레덴셜 사이드카 격리.
- `src/dialect/` — 오픈모델 in-band 툴콜 방언 파싱(harmony/qwen3/glm/kimi/deepseek).
- `src/registry/` — 프로바이더 선언 1파일 패턴(~80종) + `registry/oauth/` 플로우.
- `src/usage/`, `src/provider-details.ts`, `src/error/`.

### 1.2 pi-catalog 결합 절단면 (백포트 시 치환 대상)
`rg "from '@oh-my-pi/pi-catalog" packages/ai/src/` → **import 라인 54개** (파일 다수).
핵심 절단면(대표 인용):
- `src/types.ts:1-2` — `export * from "@oh-my-pi/pi-catalog/effort"`, `export * from ".../types"`
  → **omp ai의 공개 타입 자체가 catalog 재수출**. Api/Model/Provider/Usage 타입의 원천이
  catalog(`types.ts:37`)다. 백포트 시 prime pi-ai의 동명 타입으로 매핑하는 어댑터 필수.
- `src/stream.ts:6-17` — compat/anthropic, effort, hosts, model-thinking,
  provider-models(CATALOG_PROVIDERS), wire/codex 의존.
- `src/dialect/types.ts:1,4` — `Dialect` 타입이 catalog/identity 유래,
  `src/dialect/demotion.ts:1` — `preferredDialect`.
- `src/auth-storage.ts:11` — `planRequirementFor` (compat/behavior),
  `src/auth/sqlite-credential-store.ts:10-11` — wire/alibaba-token-plan, wire/cloudflare-ai-gateway.
- `src/usage/shared.ts:1`, `src/usage/openai-codex-reset.ts:21` — `toNumber` (utils — 사소).
→ 절단 전략에 주는 사실: **dialect·auth 계층의 catalog 의존은 대부분 "타입+순수 헬퍼"**
  (identity/effort/utils/wire 파서)라 어댑터 계층으로 치환 가능. **stream.ts는 catalog
  데이터(CATALOG_PROVIDERS)를 실제 소비**하므로 백포트 범위에서 제외하는 편이 안전
  (evopi의 스트림 계약 소유자는 prime pi-ai — DECISIONS 확정).

### 1.3 [R7 근거] Bun API 사용처 전수 — ★v3 추정("5파일") 대폭 정정★
`rg -l 'Bun\.' packages/ai/src/` → **30파일**. API 종류 분포(총 114회):
```
Bun.env 40 / Bun.hash 21 / Bun.sleep 12 / Bun.file 6 / Bun.deepEquals 6 /
Bun.Server 6 / Bun.serve 5 / Bun.WebSocket 5 / Bun.write 3 / Bun.Image 3 /
Bun.spawn 2 / Bun.WebSocketOptions 2 / Bun.zstdCompressSync 1 / Bun.sha 1 /
Bun.CryptoHasher 1
```
node 대체 난이도 계층 (사실 기록 — 판정은 메인 컨텍스트):
- **자명(1줄 심)**: Bun.env→process.env(40), Bun.sleep→setTimeout(12),
  Bun.file/write→fs(9), Bun.deepEquals→util.isDeepStrictEqual(6),
  Bun.hash/sha/CryptoHasher→node:crypto(23), Bun.zstdCompressSync→node:zlib zstd(1).
  → 114회 중 ~91회가 이 계층.
- **구조적(재작성 필요)**: Bun.serve/Server/WebSocket(16회 — auth-broker/server.ts,
  auth-gateway/server.ts 의 HTTP/WS 서버) → node:http + ws 패키지로 재작성.
  Bun.Image(3, 이미지 처리), Bun.spawn(2 → child_process).
- **분포 특성**: 서버 계열은 auth-broker/auth-gateway에 국소화 — **백포트 v1 범위를
  auth-storage/retry/dialect/registry로 한정하면 구조적 포팅은 회피 가능** (broker/gateway는
  v2). 단 auth-storage.ts 자체도 Bun 사용 파일 목록에 포함 — `bun:sqlite` 의존 여부는
  백포트 착수 시 확인 필요 (미확인: node:sqlite 또는 better-sqlite3 대체 검토).

## 2. 등급 A — packages/metaharness

### 2.1 [R7 근거] Bun API — 코어 전반 확인
사용 파일 8개: store.ts, launch-args.ts, server.ts, runner.ts, tb/{trial,vmon,dataset,agent}.ts.
종류: Bun.file 9 / Bun.write 3 / Bun.spawn 3 / Bun.sleep 2 / Bun.serve 2 /
Bun.Archive 2 / Bun.which 1 / Bun.sleepSync 1 / Bun.TOML 1 / Bun.Glob 1 / Bun.CryptoHasher 1.
→ Bun.Archive/TOML/Glob/serve 는 node 표준 대체가 없거나 재작성 필요.
  **R7 기본 정책(metaharness는 bun으로 격리 실행)과 정합** — 포팅 대신 bun 구동.

### 2.2 벤치마크 정의 계약 (benchmarks.ts:7-46 실측 인용)
```ts
interface MetricDefinition { key; label; format: "percent"|"number"|"usd"; higherIsBetter }
interface BenchmarkDefinition { kind: BenchmarkKind; label; metrics: MetricDefinition[] }
BENCHMARK_DEFINITIONS = [
  { kind:"harbor", metrics:[success_rate] },
  { kind:"edit", label:"TypeScript edit",
    metrics:[task_success_rate, edit_success_rate] },   // ← 코딩 트랙 1순위 재사용 대상
  { kind:"snapcompact", metrics:[f1, exact_match] } ]
interface BenchmarkTrace { name; task; status:"pass"|"fail"|"error"|"running";
  reward: number|null; costUsd; durationMs; detail; tracePath }
```
- 주석 실측: "storage and UI do not hard-code benchmark semantics" (benchmarks.ts:7)
  — 새 kind 추가는 BENCHMARK_DEFINITIONS 배열 1엔트리 + store.ts BenchmarkKind 유니온
  + 어댑터(스냅샷 생성기) 1개.
- **접지 피드백 신호원**: `BenchmarkTrace.status` pass/fail — evo 델타 D4(접지 배선)의
  입력이 여기 이미 존재 (evo.md 판정과 합치).

### 2.3 arm/실험 규약 (experiments.ts 실측 인용)
- `experimentOf(jobName)` = 첫 `-` 앞 접두사 (`:59-62`), `armOf(jobName)` = 접두사 제거
  나머지 (`:64-68`). 예: `sb2-n8`, `sb2-gemini` → 실험 `sb2`, arm `n8`/`gemini`.
- A/B 4-arm 등록은 job-name만 규약에 맞추면 됨: 예 `evopi-omp` / `evopi-prime` /
  `evopi-evooff` / `evopi-evoon` (실험 `evopi`, arm 4종). 추가 코드 불필요.
- `canonicalArmOf` (`:249`) 존재 — arm 정규화 로직 있음 (상세 미확인).

## 3. 등급 B — mnemopi 3함수 계약 (R6 채택으로 재구현 불요 — 계약만)

| 호출부 | 시그니처 (index.d.ts 실측) | 용도 |
|---|---|---|
| `src/core/mmr.ts:1,57` | `mmrRerankIndices(contents: string[], scores: Float64Array, lambdaParam: number, topK: number): Uint32Array` | MMR 재랭킹 (recall 다양성) |
| `src/core/shmr.ts:3,181` | `cosineSimilarityPairs(vectors: Float64Array(평탄), count, dim, threshold): Uint32Array(쌍 인덱스)` | 중복 메모리 병합 후보 |
| `src/core/vector-index.ts:1,76` | `vectorIndexTopK(matrix: Float32Array, dimensions, query: Float64Array, limit): {indices, scores}` | 벡터 검색 top-K |
호출 스모크 검증 완료 (DECISIONS.md R6 기록: 6/6 통과, 의미론 정확).

## 4. 등급 C — hashline 계약 (R6 채택으로 대체 불요 — 계약만)

| 호출부 | 함수 | 용도 |
|---|---|---|
| `src/recovery.ts:9,65` | `diffLineRuns(oldText, newText): DiffRun[]{count,added,removed}` | stale 앵커 복구용 라인 diff |
| `src/syntax.ts:12,38` | `nodeChainAt({code, path?, lang?, line}): NodeSpan[]{startLine,endLine,kind}` | 라인의 AST 노드 체인 (innermost-first) |
| `src/syntax.ts:63,95` | `enclosingBlockBoundaries({code, path?, lang?, ranges:[{startLine,endLine}]}): number[]\|null` | 표시 범위를 감싸는 블록 경계 |
- 언어 추론: `path` 확장자 우선, `lang` 별칭 폴백 (index.d.ts BlockRangeOptions 주석).
- hashline 편집 포맷 본체(`[path#4hex]` 앵커 문법·stale 거부)는 순수 TS —
  natives 의존은 위 3함수(복구·구문 경계)뿐이므로 R6 채택으로 전체 백포트 가능.

## 5. 경로·설치·CLI

- **브랜딩 시임** `packages/utils/src/dirs.ts`: `APP_NAME="omp"`(:21),
  `CONFIG_DIR_NAME=".omp"`(:24), `USER_AGENT="omp/${VERSION}"`(:33),
  env 오버라이드 `PI_CONFIG_DIR`(:282), 로그 파일명 `${APP_NAME}.<date>.<pid>.log`(:593).
  → evopi는 omp를 포크하지 않으므로 이 시임은 **잔존 검사 목록**(STEP 15)으로만 사용.
- **경로**: 유저 `~/.omp/{logs, agent/agent.db, auth-gateway.token}` /
  프로젝트 `.omp/{commands, skills, tools}` (레포 루트 실측 — ls 확인).
- **스킬 3종** `.omp/skills/{semantic-compression, system-prompts, tool-prompt-optimization}`
  — 순수 md, evopi로 그대로 복사 가능 (등급 A 자산).
- **설치**: `scripts/install.sh` + `curl -fsSL https://omp.sh/install | sh` (README.md:40),
  Windows `irm https://omp.sh/install.ps1 | iex` (README.md:85).
- **CLI 엔트리**: `packages/coding-agent/package.json:30-32` `"bin": {"omp": "src/cli.ts"}`.
- **ASCII 랜딩**: 미확인 — setup-wizard/scenes/glyph.ts 는 글리프 프리셋 픽커였음(오탐).
  evopi 랜딩은 독자 디자인이 요구사항이므로 원본 위치 특정은 불요 (참고용 후속 조사만).

## RECONFIRM 근거 (R7)

사실만 기록 (판정은 메인 컨텍스트):
1. omp ai의 Bun 사용은 30파일·114회 — v3 추정 5파일은 grep 범위 오류였음.
   단, ~80%가 1줄 심으로 대체 가능한 계열(env/sleep/file/hash/deepEquals)이고
   구조적 재작성(serve/WebSocket)은 auth-broker/auth-gateway 서버 2개에 국소화.
2. v1 백포트 범위(auth-storage/retry, dialect, registry 선언 패턴)로 한정하면
   구조적 Bun 의존은 대부분 회피 — 단 auth-storage의 sqlite 바인딩(bun:sqlite 여부)은
   착수 시 확인 필요.
3. metaharness는 Bun.Archive/TOML/Glob/serve 등 대체 불가/고비용 API가 코어에 있어
   node 포팅 비용이 높다 — bun 격리 실행이 저비용 (bun 1.4.0 설치 완료).
