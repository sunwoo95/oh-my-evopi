# SPEC v1 — oh-my-evopi

> v1.0 (2026-09-02, STEP 11). 변경 이력: 초판 — 게이트 판정(D3 폴백/R4/R5/R6/Phase 3) 전부 반영.
> 근거 문서: DECISIONS.md(판정 기록), PORTING.md(매핑·충돌), PROVENANCE.md(출처),
> analysis/{omp,prime,evo}.md. 이 SPEC과 PORTING이 충돌하면 DECISIONS 판정이 우선.

## 1. 고정 기능 요구사항 (5종)

| # | 요구 | 완료 조건 (검증 명령) |
|---|---|---|
| F1 | curl 원라이너 설치 | `env HOME=/tmp/evopi-test bash install.sh` 성공, `~/.evopi` 외 상태 생성 0건 |
| F2 | 실행 커맨드 `evopi` | `evopi --version` 성공 (bin 이름 evopi) |
| F3 | `~/.evopi` 단일 경로 | 코드 `rg '\.omp\|\.prime' packages/ --glob '!*.md'` 0건 + 격리 HOME 리허설에서 `.omp`/`.prime` 미생성 |
| F4 | ASCII 랜딩 독자 디자인 | 기동 화면에 신규 로고 (prime 나비·omp와 상이 — 육안) |
| F5 | 모델 커넥팅 합집합 | prime 카탈로그/OAuth/bedrock 동작 + evopi-auth-pool(다중 크레덴셜 로테이션) + dialect(오픈모델 파싱) 로드 확인 |

## 2. 아키텍처 (Phase 2 다이어그램과 일치)

prime-harness.png 의 구조를 기본으로 다음 3점만 변경:
1. 모델 커넥터에 `evopi-auth-pool` + `dialect` 계층 추가 (omp-harness.png 좌측 개념 이식)
2. harness(evo) 클러스터에 `grounded-refine` 확장 (metaharness pass/fail → refine 입력)
3. 평가 클러스터 = metaharness 사본 (bun 격리, 제품 밖 `eval/`)

## 3. 모듈 목록과 완료 조건 (PLAN.md의 위상 정렬 입력)

| 모듈 | 내용 | 완료 조건 |
|---|---|---|
| M1 골격 복사 | prime 트리 → oh-my-evopi 루트 (.git/node_modules/dist 제외), prime-agent-runtime→evopi-runtime | `npm install` 성공 + `npm run build` 성공 |
| M2 리브랜딩 | piConfig `{"name":"evopi","configDir":".evopi/agent"}`, bin `evopi`, 패키지 스코프 `@evopi/*` | `node dist... --version` 류 부팅 + CONFIG_DIR_NAME=.evopi/agent 확인 (config 단위 검사) |
| M3 브랜딩 문자열 | evopi.sh(←prime-agent.sh), install.sh 함수 접두·문자열, self-update 리포인트/비활성 | `bash -n` + rg 잔존 검사 (F3 게이트) |
| M4 ASCII 랜딩 | prime-logo.ts 교체 (신규 디자인) | 기동 화면 육안 (F4) |
| M5 natives-loader | leaf .node 직접 require + AVX2 감지 + null 폴백 (1파일) | 6함수 로드·호출 스모크 (R6 스모크 재현) |
| M6 hashline 백포트 | packages/hashline 사본 + natives-loader 배선 + edit 툴 `--tools` 게이트 등록 | hashline 단위 테스트(원본 테스트 이식) + edit 툴 로드 |
| M7 mnemopi 백포트 | core/{mmr,shmr,vector-index}+스토어, natives-loader 배선 (병존) | 3함수 경로 단위 테스트 |
| M8 dialect 백포트 | omp dialect → packages/ai, evopi-compat 로컬 타입로 catalog 절단 | 파서 단위 테스트(방언 샘플) + `rg 'Bun\.'` 0건 |
| M9 auth-pool 백포트 | evopi-auth-pool (auth-storage 개명 + retry), prime auth.json 1차/풀 2차 | 풀 로테이션 단위 테스트 + Bun 0건 |
| M10 sandbox/permission | capability 프로브 + bash 래핑 확장(가능 환경 한정) + permission-gate 번들 [R3 게이트] | 프로브가 현 환경에서 "불가" 감지 + gate가 tool_call block 수행 (통합 테스트) |
| M11 grounded-refine | R4 v1 델타 (D4+D1+D7): 실패 신호 게이트 + 신호 주입 + 폴백 [evo 플래그] | evo off 시 전 기능 동작 + 확장 로드 시 신호 주입 확인 (모의 신호) |
| M12 metaharness 격리 | eval/metaharness 사본, bun 구동, 피실험 CLI 경로 설정 (Q2 실측 포함) | `bun install` + 러너 기동 (--help 수준) [R7 최종 판정] |
| M13 스킬 md 3종 | omp .omp/skills 복사 | 스킬 로더 인식 |
| M14 설치 스크립트 | F1 격리 리허설 | STEP 15 체크 |

## 4. evo 레이어 명세 (D7: optional — evo off 로 전 기능 동작)

- 플래그: `--evo on|off` (또는 settings `evo.enabled`). **off 기본값** —
  off = prime autoRefine 기본 동작도 함께 비활성(`autoRefine.enabled:false` 매핑)하여
  순수 대조군 확보.
- on = grounded-refine 확장 활성:
  - **D1**: `session_before_refine` 훅에서 외부 실패 신호(파일/환경변수로 주입되는
    pass/fail — metaharness trace 연동) 없으면 `{skip:true}`. 신호원 자체가 미구성이면
    기존 turn_interval 경로 유지 (조용한 정지 방지 — evo.md 안전 지적).
  - **D4(+D7)**: 신호가 있으면 refine 플래너 입력에 `<external_feedback>` 블록
    (Minimal: pass/fail, Standard 옵트인: +진단 텍스트) 주입.
  - 각 evo 요소의 논문 인용: D1=식(6) paper:425-431, D4=Table 4 paper:992-1034.
  - "이게 없어도 동작하는가" = 예 (확장 미로드 시 prime 원본 경로).
- **금지**: 접지 신호 미배선 상태의 evo-on arm 구성 (DECISIONS R4 안전 구속).

## 5. IPython 커널 명세

- prime 커널 무변경 (uv 부트스트랩 R5 해소, 스킬 계약 SKILL.md+pyproject.toml+src/,
  dill 스냅샷 저장·복원 — 베이스라인 스모크 통과 실측).
- D3 [폴백]: 커널 비격리. sandbox 확장은 프로브 게이트. eval 프로파일 = 컨테이너 전제 문서화.
- 부팅 검증: 격리 HOME에서 kernel-venv 생성 + ipython 툴 1회 실행 + kernel-state.dill 생성.

## 6. 권한 2계층 (D4 결정) + 프로파일

- 의도 계층: permission-gate 확장 (tool_call block). R3 판정은 M10 착수 시
  통합 테스트로 [자동확정]/[폴백-경고만].
- 집행 계층: 가능 환경=bwrap bash 래핑, 현 환경=컨테이너 경계 (D3 판정).
- 프로파일: strict(모두 승인)/dev(기본)/eval(무인 — 컨테이너 전제 + 자동 승인).

## 7. 평가 명세 (metaharness·A/B 4-arm)

- kind:"edit" 재사용 (task_success_rate, edit_success_rate — 기존 지표).
- arm: `evopi-omp` / `evopi-prime` / `evopi-evooff` / `evopi-evoon` (armOf 규약).
- 동일 모델·파라미터, seed 고정, 가능하면 3회 반복 (논문 I.3).
- evoon arm은 grounded 신호 배선 필수 (§4 금지 조항).
- 키 부재 시: faux 프로바이더 스모크로 대체하고 RESULTS.md에 SKIP 사유 기록.

## 8. PROVENANCE 참조

전 개념의 출처는 docs/design/PROVENANCE.md — 신규 개념 추가 시 그 표를 먼저 갱신할 것.
