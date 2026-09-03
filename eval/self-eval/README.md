# self-eval — SELF-EVAL 스코어카드 스냅샷

`scripts/self-eval.mjs` 가 docs/eval/SELF-EVAL.md 의 최종 스코어카드(G1 tsgo/biome, G2 vitest, G3 번들, S1 커널 비밀키 필터,
S2 게이트 패턴 수, R1 셀 타임아웃, R2 stderr 상한, P1 시작시간, H2 shellcheck, F3 `.omp/`·`.prime/` 리터럴)를 JSON 으로 수집한다.
이 디렉터리의 `<version>.json` 은 릴리스마다 저장하는 베이스라인이다. CI(`build-check`)는 `--skip-tests` 결과를 `self-eval` 아티팩트로 올린다.

- 빠른 측정(테스트 제외, 수 초): `npm run self-eval -- --skip-tests`
- 전체 측정(coding-agent vitest 포함, 수 분): `npm run self-eval`
- 베이스라인 저장: `npm run self-eval -- --write` → `eval/self-eval/<root package.json version>.json` (`--out <file>` 로 경로 지정)
- 릴리스 비교: `npm run self-eval -- --baseline eval/self-eval/0.10.0.json` → stderr 에 markdown 비교표(metric/baseline/current/delta)
- 게이트: `--fail-on-regression` 을 붙이면 vitest 실패 증가(베이스라인 대비)·tsgo 오류·biome 오류·F3 비승인 히트가 있을 때 exit 1
- 스크립트는 측정만 한다(tsgo `--noEmit`, biome `--write` 없음, 번들은 재빌드하지 않고 크기만 측정). node 내장 모듈만 사용.
