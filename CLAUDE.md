# oh-my-evopi 작업 규칙

- 목표와 Phase 규칙은 GOAL.md. 세션 시작 시 읽어라.
- 결정 사항은 docs/design/DECISIONS.md. D1/D2/D4/D5/D7 과 이식 등급표는 확정이므로
  다시 묻지 마라.
- RECONFIRM(D3, R3, R4, R6, R7 — R5는 해소됨) 은 RUNBOOK 「GOAL 모드 실행 규칙」의
  자동 판정 정책으로 처리한다. 멈추지 말고, 판정 기준을 실행(스모크 테스트 포함)해
  결과를 DECISIONS.md에 [자동확정]/[폴백]으로 기록한 뒤 진행한다.
- Phase 시작 시 DECISIONS.md 를 읽고 이번 Phase 의 트리거와 적용할 정책을 먼저 기록해라.
- 서브에이전트는 RECONFIRM 항목에 결론을 쓰지 않는다. 근거만 파일에 남기고
  판정은 메인 컨텍스트가 정책 표를 적용해 수행한다.
- **git 작업(init/commit/tag)은 이번 구현 사이클에서 사용자 지시로 제외.**
  체크포인트 도달은 REVIEW.md 에 기록한다.

## 고정 제약
- 설정 경로는 ~/.evopi 하나뿐. 코드에 .omp / .prime 이 남으면 실패로 간주.
- 실행 커맨드는 evopi. 설치는 curl 원라이너.
- 원본 레포 2개는 읽기 전용. 절대 수정 금지.
- evo 레이어는 optional. evo off 로 전 기능 동작해야 한다.
- ALFWorld 는 범위 밖이다. 평가는 코딩 트랙 A/B 만.
- pi-natives(napi) 의존 코드는 그대로 쓸 수 없다. 이식 등급표를 따른다.

## 환경 제약
- x86_64 / Ubuntu 24.04 / node 24 / uv 0.12.5. root 계정, apt 사용 가능.
- graphviz/bwrap/socat/rg 설치 완료 (2026-09-02). `file` 명령 없음 — PDF 검증은 헤더 바이트.
- Rust/Bazel/bun/Nix 툴체인 없음. 등급 E 는 v2 이연.
  단 prebuilt pi-natives(npm) 존재 — R6 결정 전에는 등급 B/C 를 착수하지 마라.
- omp ai/metaharness 는 Bun API 를 쓴다 — R7 결정 전에는 이식 방식을 확정하지 마라.
- pip 직접 설치는 PEP 668 로 실패한다. Python 패키지는 uv venv 로.
- 다이어그램은 graphviz(dot) 만. mermaid 사용 불가.
  DOT 에 fontname="Noto Sans CJK KR" 필수.
- 렌더 후 PNG 존재를 확인하고 Read 로 열어 가독성을 점검한다.

## 근거 규칙
- 파일경로:라인 인용 필수. 확인 못한 것은 "미확인".
- 환경 관련 주장은 실제로 명령을 실행하고 출력을 붙인다.
