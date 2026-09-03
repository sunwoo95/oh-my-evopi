# SELF-EVAL — evopi 프레임워크 자가평가 라운드 (SE Phase, 2026-09-03)

> 정책: docs/design/DECISIONS.md 「SE Phase 시작」. 각 라운드 = 측정 → 결함 1건 수정 → 검증 → 기록.
> 모든 수치는 실행 출력. evo 레이어(EVOPI_EVO)와 무관한 프레임워크 품질만 다룬다.

## 스코어카드 (Round 0 베이스라인)

| # | 축 | 지표 | R0 값 | 목표 |
|---|---|---|---|---|
| G1 | 타입/린트 | tsgo(coding-agent, ai) · biome | 0 / 0 / 0 | 유지 |
| G2 | 테스트 | vitest 배치(process-stress 제외) pass/fail | 측정 중 | fail 0 (root-uid 환경 결함 제외) |
| G3 | 빌드 | build exit · bundle 크기 | 0 · 15M | 유지 |
| S1 | 보안 | 커널 spawn env 에 포함되는 LLM 비밀키 env 수 | 상속 전부 (repl-manager.ts:257) | 0 (opt-out 제외) |
| S2 | 보안 | 위험 명령 코퍼스 탐지율 (permission-gate) | 7 패턴 | omp CRITICAL 계열 커버 |
| R1 | 견고성 | ipython 셀 실행 타임아웃 | 없음 | 설정 가능 + 초과 시 커널 회수 |
| R2 | 견고성 | 커널 stderr 누적 상한 | 무제한 (repl-manager.ts:332) | 상한 |
| P1 | 성능 | `evopi --version` 시작시간(5회) | 0.37–0.42s | 회귀 없음 |
| H1 | 위생 | 문서-코드 불일치 건수 (RESULTS.md faux 등) | ≥1 | 0 |
| H2 | 위생 | F3 게이트(.omp/.prime 소유 리터럴) | 0 | 0 |

## 라운드 기록

### Round 1 — S1 커널 비밀키 필터 (repl-manager env 상속)
- 결함: `spawn(python,…,{env:{...process.env}})` 가 호스트의 LLM 프로바이더 키 전부를 커널(=모델 작성 코드)에 노출.
- 수정: `src/core/kernel/kernel-env.ts` 신설 — 에이전트 측 자격증명 30종 + `EVOPI_API_KEY_POOL_*` 접두를 기본 차단,
  프로젝트용 자격증명(GH_TOKEN, AWS IAM, GOOGLE_APPLICATION_CREDENTIALS, SERPER_API_KEY)은 유지. opt-out
  `EVOPI_KERNEL_INHERIT_SECRETS=1` / `KernelManagerOptions.inheritSecrets`. 차단 목록은 커널 stderr 진단에 1회 기록.
- 검증: `test/kernel-env.test.ts` 5/5 + 커널 스위트 53/53, tsgo 0, biome 0. **S1: 상속 전부 → 0 (opt-out 제외)**.

### Round 2 — G2 테스트 부채 20건 정리
- 분류: 환경 유래 7(root uid EACCES 3, lsof 부재 1, 샌드박스 ambient `AWS_BEARER_TOKEN_BEDROCK` 3) · 테스트 부채 13
  (리브랜딩 잔재 9, Prime 온보딩 강등(DEMOTE) 미반영 2, hashline_edit 등록(M6) 미반영 2). 제품 결함 0.
- 수정: 기대값을 evopi 계약으로 갱신(daemon-socket·node-version-check·version-check·acp 3·regressions 2), 온보딩
  테스트 2건을 provider-agnostic 계약으로 재작성, root 환경 3건 `skipIf(uid 0)`, `test/setup/isolate-provider-env.ts`
  (vitest setupFiles) 로 ambient 프로바이더 자격증명 격리, lsof apt 설치.
- 검증: 전체 스위트 **4,659 pass / 0 fail** (skip 58, 파일 345). 잔존 "1 error" = prime-team-selector 단독 4/4 통과 → 간헐 경합(Round 10).

### Round 3 — R2 커널 stderr 누적 상한
- 결함: `kernelStderr += …` 무제한 누적(사용처는 `slice(-1024)` 만).
- 수정: `MAX_KERNEL_STDERR_CHARS = 64 KiB` 테일 유지 `appendKernelStderr()`. 검증: tsgo 0, `+=` 잔존 0.

### Round 4 — R1 ipython 셀 실행 타임아웃 + 초과 시 커널 회수
- 결함: 사용자 셀에 시간 상한 없음, abort 는 호스트 측 정산만 → SIGINT 무시 루프는 영구 점유.
- 수정: `ExecuteOptions.timeoutMs` → 만료 시 인터럽트, 셀이 여전히 active 면 `killChildToIdle()`(다음 셀이 스냅샷 복원
  후 재부팅). 결과 `status:"error"`, `ename:"KernelCellTimeout"`. 설정 `kernel.cellTimeoutMs`(기본 30분, 0=해제),
  env `EVOPI_KERNEL_CELL_TIMEOUT_MS`(off 가능) 우선. ipython 툴 → agent-session 배선.
- 검증: 설정 3/3 + 실커널 2/2(`time.sleep` 루프 = 인터럽트·네임스페이스 유지 / `SIG_IGN` 루프 = 회수 후 `'alive'`),
  tsgo 0, biome 0.

### Round 5 — S2 permission-gate 커버리지 (intent 계층)
- 결함: (a) 위험 패턴 7종만(omp CRITICAL 계열의 `--no-preserve-root`·`curl|sh`·`/etc/passwd` 덮어쓰기·shutdown·nc -e 등 미탐)
  (b) **ipython 셀의 `bash("…")`(rlm.bash — evopi 주 셸 경로) 호출을 검사 대상에서 누락** — `!`/os.system/subprocess 만 봄.
- 수정: 패턴 21종(블록 디바이스 raw write, `/etc/{passwd,shadow,sudoers}`, 다운로드 파이프→셸 3형, kill -9 1/-1,
  shutdown/reboot/halt/poweroff/init 0, nc -e/-c, shred/cryptsetup, `chmod/chown -R … /`) + 셀 마커 5종
  (`!`, `bash(`, os.system/popen/exec*/spawn*, subprocess, pexpect). 일상 명령 9종 오탐 없음 테스트로 고정.
- 검증: `test/permission-gate.test.ts` 13/13 (신규 3: 위험 21 · 무해 9 · 셀 추출), tsgo 0, biome 0.

### Round 6 — H1 문서-코드 정합
- 결함: 신규 안전 기본값(비밀키 필터·셀 타임아웃·게이트)의 사용자 문서 부재; RESULTS.md 의 "pi-ai 에 mock 없음" 서술이
  `providers/faux.ts` 존재와 불일치.
- 수정: `docs/settings.md` "Kernel (Python REPL)" 절(`kernel.cellTimeoutMs` + env 3종), `docs/rlm-runtime.md` Trust Boundary
  에 커널 env·셀 제한 절, README "Safe-by-default kernel" 불릿, RESULTS.md 서술 정정(faux 는 있으나 세션 모델 경유라 도달 불가).
- 검증: 문서 grep — 신규 env 3종 모두 settings.md 에 존재. **H1 불일치 ≥1 → 0**.

### Round 7 — 셸 스크립트 정적 검사 (install.sh / evopi.sh / test.sh)
- 측정: shellcheck(-S warning) install.sh 7건(EUID-in-sh 4 · 미사용 변수 2 · SC2209 1), evopi.sh 0, test.sh 0.
- 판정: EUID 4건은 `${EUID:-$(id -u)}` 폴백으로 안전(false positive) → 근거 주석 + disable; SC2209 는 리터럴 모드명 → disable;
  미사용 변수 `evopi_italic`·`evopi_screen_status` 는 dead code → 제거.
- 검증: shellcheck 0 · `bash -n`/`sh -n` 0 · `check:installer` 통과.

### Round 8 — S2 보호 경로 쓰기 게이트 (intent 계층)
- 결함: `.env`·`.git/`·`~/.ssh`·키 파일(.pem/.key)·`~/.evopi/agent/auth.json` 을 셀/명령이 **변경**해도 게이트가 개입하지 않음
  (omp protected-paths 대응물 부재).
- 수정: `protectedPathWrite(text)` — 변경 마커(edit(·open(…,"w")·write_text·shutil/os/pathlib 삭제·rename·chmod·셸 리다이렉션·rm/mv/cp/
  chmod/tee/sed -i) 가 있을 때만 보호 경로 8종 매칭. 읽기(dotenv·cat .env)·`.env.example` 류·비민감 파일 쓰기는 통과.
  tool_call 핸들러가 위험 명령과 동일 정책(block/warn/off, no-UI 즉시 차단)으로 처리, 사유에 경로 명시.
- 검증: permission-gate 16/16 (신규 3: 변경 9종 탐지 · 읽기/무해 9종 통과 · 셀 차단 통합), tsgo 0, biome 0.

### Round 9 — G2 안정성: 지연 로더 unhandled rejection
- 결함: `initTheme()` 이 `cli-highlight`(≈350ms)·`typebox/compile` 지연 import 를 `void` 로 발사하고 catch 가 없음 → 로드 실패
  (또는 호스트가 먼저 종료)가 unhandled rejection. 전체 스위트에서 "1 error"(EnvironmentTeardownError, startup-notices /
  prime-team-selector 등 짧은 테스트에서 랜덤 발생)의 원인. 제품에서도 실패한 지연 로드가 영구 미해결로 남는 구조.
- 수정: 두 로더에 `.catch(() => { promise = undefined })` — 실패 시 다음 호출에서 재시도, `highlightCode` 는 이미 plain-text 폴백.
- 검증: 관련 4 스위트 통과, tsgo 0. 전체 스위트 "Errors 1 → 0" 은 최종 회귀 실행에서 확인.

### Round 10 — 게이트 파이프라인 확장: `check:shell`
- 결함: 셸 진입점(install.sh/evopi.sh/test.sh)이 `npm run check` 밖 — Round 7 의 정적 검사가 일회성으로 끝남.
- 수정: `scripts/check-shell.mjs`(셔뱅 기반 `bash -n`/`sh -n` + shellcheck -S warning; shellcheck 부재 시 skip 보고) 를 `check` 체인에
  추가(`check:shell`). 검증: 3 스크립트 통과, `npm run check` 전체 green.

### Round 11 — 디스크/레포 위생
- 결함: `packages/coding-agent/core` — 4.7 GB ELF 코어덤프가 작업 트리에 잔존(.gitignore 로 추적만 차단된 상태).
- 수정: ELF 헤더 확인 후 삭제(4,990,849,024 B 회수). `git status --ignored` 스트레이 = .claude/, .husky/_/, docs/plans/ 만(정상).

### Round 12 — 릴리스 체크 (전체 게이트 + 회귀)
- `npm run build` exit 0 (kernel-env 가 번들 청크 1개에 포함) · `npm run check`(biome·tsgo·installer·browser-smoke·shell) exit 0.
- 시작시간 `--version` 5회 0.367–0.423s (R0 0.368–0.416 — 회귀 없음) · bundle 15M (동일).
- 전체 스위트(coding-agent, process-stress 제외): **4,668 pass / 0 fail / 60 skip / Errors 0** (R0: 4,637 pass / 20 fail / 1 error).
- 실커널 스위트: state-roundtrip · cell-timeout · mcp-shutdown 9/9.

## 스코어카드 (최종)

| # | 축 | R0 | 최종 | 라운드 |
|---|---|---|---|---|
| G1 | tsgo / biome | 0/0 | 0/0 | — |
| G2 | vitest fail / errors | 20 / 1 | **0 / 0** | R2, R9 |
| G3 | build / bundle | 0 / 15M | 0 / 15M | R12 |
| S1 | 커널에 노출되는 프로바이더 키 | 전부 | **0** (opt-out) | R1 |
| S2 | 위험 명령 패턴 / 셀 셸 마커 / 보호 경로 | 7 / 3 / 0 | **21 / 5 / 8** | R5, R8 |
| R1 | 셀 타임아웃 | 없음 | 30분 기본 + 회수 | R4 |
| R2 | 커널 stderr 상한 | 무제한 | 64 KiB | R3 |
| P1 | 시작시간 | 0.37–0.42s | 0.37–0.42s | R12 |
| H1 | 문서-코드 불일치 | ≥1 | 0 | R6 |
| H2 | shellcheck 경고 / F3 | 7 / 0 | **0** / 0 (check:shell 게이트) | R7, R10 |
| — | 디스크 | 4.7 GB 코어덤프 | 회수 | R11 |

## 자동화 (C2)

위 최종 스코어카드는 `scripts/self-eval.mjs` 가 JSON 으로 수집한다 — `npm run self-eval -- --skip-tests`(수 초) /
`npm run self-eval`(vitest 포함, 수 분) / `--write` 로 `eval/self-eval/<version>.json` 베이스라인 저장 /
`--baseline <file>` 로 릴리스 간 비교표, `--fail-on-regression` 으로 하드 지표(vitest fail 증가·tsgo·biome 오류·F3 비승인 히트) 게이트.
CI `build-check` 잡이 `--skip-tests` 결과를 `self-eval` 아티팩트로 저장한다. 사용법은 `eval/self-eval/README.md`.
