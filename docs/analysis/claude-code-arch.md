# Claude Code 마스터 아키텍처 추출 보고서

- 출처: `refs/claude-code-architecture.pdf` (45p, AWS Korea 최우형, "Claude Code Architecture — 다이어그램으로 보는 에이전트 하네스 구조" [PDF p.1]),
  `refs/slide5.png` / `slide6.png` / `slide7.png`
- 인용 규칙: `[PDF p.N]` 은 **물리적 PDF 페이지**(1~45). 슬라이드 하단 footer 번호와 다르다
  (예: PDF p.6 = footer 3, PDF p.8 = footer 4, PDF p.11 = footer 5 … PDF p.43 = footer 25). 검증: pdftotext 로 45p 분리 후 footer 매핑 확인.
- slide5 = 「02 전체 아키텍쳐 맵」 섹션 표지 [slide5], slide6 = 전체 아키텍처 맵 (PDF p.6 과 동일 도식) [slide6], slide7 = 「03 Agent Loop」 섹션 표지 [slide7].
- 자료의 1차 출처는 Anthropic 공식 문서(code.claude.com/docs), agentskills.io, modelcontextprotocol.io 로 명시됨 [PDF p.44].
- 자료가 다루지 않는 항목은 "자료 미기재"로 표기. 일반 지식 보충은 마지막 절에만 격리.

---

## (a) 설계 철학 (자료 기술 그대로)

Claude Code 는 "Claude 모델을 감싸는 에이전트 하네스(Agentic Harness)"로, 모델에 도구(tools)·컨텍스트 관리·실행 환경을 제공해
언어 모델을 실제로 코드를 작성하고 검증하는 코딩 에이전트로 전환한다 [PDF p.4]. 네 가지 성격을 표방한다: Terminal-native(CLI 에서 직접 동작,
IDE/CI-CD/웹으로 확장), Codebase-aware(프로젝트 전체 파일·git 상태·의존 관계를 에이전틱 검색으로 파악), Tool-driven(파일 편집·셸·웹 검색 등 도구로
실제 작업을 수행하고 반복), Human-in-loop(수정/실행 전 명시적 권한, 체크포인트로 모든 변경 되돌리기 가능) [PDF p.4]. 구조는 "Master Agent Loop 을
중심으로 한 여덟 개 레이어" [PDF p.6][slide6] 이고, 요약 구호는 "1 loop(수집-행동-검증) / 2 축(모델+도구) / 4 확장(Skills/MCP/Hooks/Subagents) /
사람 통제(권한+체크포인트)" [PDF p.43]. 확장 프리미티브의 설계 원칙은 "가장 단순한 프리미티브부터(Skills → Subagents → MCP → Hooks 순),
컨텍스트는 가볍게, 경계는 명확하게, 강제는 결정적으로, 관찰하고 측정하며 개선" [PDF p.41]. "Same loop, everywhere" — 루프/도구/기능은 어디서나 동일하고
달라지는 것은 실행 위치와 인터페이스뿐 [PDF p.22].

## (b) 아키텍처 다이어그램의 구성 박스 (도식 용어 그대로) [PDF p.6][slide6]

- 중심: **Master Agent Loop** — "Gather - Act - Verify"; 하단 라벨 "Claude 모델 + 도구"
- **INPUT LAYER**: User Interface (CLI/IDE/CI-CD) · Session Mgr (Resume/Fork) · Permission (Ask/Allow/Deny) → 루프로 `request`
- **KNOWLEDGE LAYER**: CLAUDE.md (always on) · Auto Memory (MEMORY.md) · Skills (on-demand) · Context Win (compaction) → 루프로 `feeds`
- **OBSERVABILITY**: Hooks (lifecycle) · Background (non-block) ↔ 루프 `observe/spawn`
- **MULTI-AGENT**: Subagents (isolated ctx) · Worktrees (parallel) ↔ 루프 `observe/spawn`
- **EXECUTION LAYER**: Tool Dispatch (typed registry) · Prompt Cache (~10% cost) · Streaming (real-time) ← 루프 `execute`
- **INTEGRATION**: MCP Runtime (auto-discover) · Ext Servers (FS/Git/Custom); Execution→Integration→Output 화살표, 하단 `register / result`
- **OUTPUT LAYER**: Task Result (Verified output / Memory updated)
- 8 레이어 요약 카드: Core / Input / Knowledge / Execution / Multi-Agent / Observability / Integration / Output [PDF p.43]
- 종단 흐름(End-to-End): 1 Prompt(Input) → 2 Permission(Input) → 3 Gather Context(Knowledge) → 4 Take Action(Execution) → 5 Verify(Core Loop)
  → 6 Task Result(Output); Hooks 가 전 과정 관찰/검증/차단; 미완이면 루프 반복(메모리 갱신) [PDF p.42]

---

## 1. 제어 루프 (Control loop)

- 핵심 루프: 사용자 프롬프트 → Gather Context(파일/코드 검색) → Take Action(편집/명령/도구) → Verify Results(테스트/타입체크) → Complete.
  "학습한 내용으로 다음 단계 결정(반복)" 피드백 화살표가 Gather 로 되돌아감 [PDF p.8]. 단계는 서로 섞이며 작업 성격에 따라 적응적으로 동작:
  질문형 작업은 컨텍스트 수집만, 버그 수정은 세 단계 다회 반복, 리팩터링은 검증 단계 비중 증가 [PDF p.8].
- 턴 구조: 자료에 "턴"의 정의는 Hooks cadence 로만 드러남 — 세션 1회(SessionStart/SessionEnd), 턴 1회(UserPromptSubmit → Stop → StopFailure),
  도구 호출마다(PreToolUse → PostToolUse → PostToolUseFailure) [PDF p.35]. CLAUDE.md 는 "매 턴 로드" [PDF p.13][PDF p.14].
- 실행 파이프라인: Model(tool_use 블록 생성) → Tool Dispatch(도구별 핸들러로 라우팅, typed registry) → Execute(파일/셸/웹/git) → Result(결과를
  컨텍스트로 환원) → "결과 피드백(루프 반복)" [PDF p.30].
- 스트리밍: "Streaming Runtime — 실시간 출력, 독립적 도구 호출은 병렬 실행" [PDF p.30]; 도식 박스 "Streaming (real-time)" [PDF p.6][slide6].
- 단일 스레드 vs 멀티에이전트: 메인 에이전트가 "계획 + 통합"을 맡고 특화 서브에이전트(Backend/Frontend/Test/Review 예시)를 spawn(자체 fresh 컨텍스트),
  완료 시 요약만 반환하여 메인 컨텍스트를 오염시키지 않음("Delegate, don't bloat"); 병렬 동시 실행·실패 격리 [PDF p.32]. Worktrees(parallel) 로
  병렬 세션 [PDF p.6][slide6]; "원본 유지 + 분기: git worktree 로 병렬 세션 동시 실행" [PDF p.23]. Background(non-block) 박스 존재 [PDF p.6][slide6]
  — 세부 설명은 자료 미기재.
- Esc: "언제든 중단/재지시" [PDF p.8].

## 2. 도구 시스템 & 실행 엔진

- 내장 도구 5 카테고리(+오케스트레이션, "5 + α"): FILE(읽기·편집·생성·이름변경·재구성), SEARCH(패턴/정규식 검색·코드베이스 탐색),
  EXECUTION(셸 명령·서버 기동·테스트·git), WEB(웹 검색·문서 가져오기·에러 조회), CODE INTEL(타입 오류·정의 이동·참조 — 플러그인) [PDF p.11].
  "도구가 없으면 텍스트만 생성. 도구로 읽고 편집하고 실행하며, 각 결과가 루프로 피드백" [PDF p.11].
- 실행 방식: 모델이 구조화된 `tool_use` 블록을 내보내고 핸들러가 해석·실행; Tool Dispatch 는 "도구별 핸들러로 라우팅 (typed registry)";
  Execute 는 "파일/셸/웹/git 수행" [PDF p.30]. Prompt Cache(5분, 1시간): 안정적 프리픽스 재사용, 캐시 읽기 비용 약 10% [PDF p.30];
  도식 라벨 "Prompt Cache ~10% cost" [PDF p.6][slide6]. 출처 표기: "Anthropic Claude Docs (code.claude.com), Prompt Caching" [PDF p.30].
- Hook 은 "실제 셸로 실행됨. 잘못된 exit code 가 에이전트를 멈출 수 있어 격리 환경에서 먼저 검증" [PDF p.15].
- 샌드박싱: 실행 환경 3종 — Local(내 머신에서 실행, 파일/도구 전체 접근, 기본값), Cloud(Anthropic 관리 VM 에서 실행, 작업 오프로드),
  Remote Control(브라우저로 제어하되 내 머신에서 로컬 실행) [PDF p.22]. 서브에이전트 실행 컨텍스트는 "격리 샌드박스", MCP 는 "외부 프로세스",
  Hooks 는 "로컬 훅 러너" [PDF p.40]. 도구 실행 자체의 OS 수준 샌드박스(seccomp/bwrap 등) 메커니즘은 **자료 미기재**.

## 3. 컨텍스트 관리

- 컨텍스트 윈도우 구성: "대화 히스토리, 파일 내용, 명령 출력, CLAUDE.md, 자동 메모리, 로드된 Skills, 시스템 지시" [PDF p.26];
  도식 "대화 + 파일 + 출력 + 메모리 + Skills + 시스템 지시 / 채워지면 자동 압축 / `/context` 로 사용량 확인" [PDF p.26].
  시스템 프롬프트 조립 순서/세부는 **자료 미기재**.
- CLAUDE.md: "프로젝트 영속 컨텍스트. 규칙, 명령, 구조를 매 세션 자동 로드. 항상 읽어야 할 때 사용" [PDF p.13]; 로드 시점 "세션 시작 + 매 턴",
  트리거 "자동(조건 없음)" [PDF p.14]; "항상 로드, 하위 디렉터리 우선" [PDF p.26]; "영구적으로 적용할 규칙은 대화가 아니라 CLAUDE.md 에" [PDF p.26];
  비대화 주의 — 매 턴 로드되므로 간결 유지 [PDF p.15]. Configs 비교표: 매 세션 로드, 단일 도구, 프로젝트 규칙 용도 [PDF p.19].
- Auto Memory: "MEMORY.md 첫 200줄/25KB" 를 세션 시작 시 로드 [PDF p.26]; 도식 "Auto Memory (MEMORY.md)" [PDF p.6][slide6].
- Skills: 설명만 보이고 본문은 온디맨드 [PDF p.26]. Progressive Disclosure 3단계 — Level 1 이름+설명(약 30-50 토큰, 항상), Level 2 SKILL.md 본문
  (매칭 시, 5,000 토큰 미만 권장), Level 3 scripts/references(본문이 요구할 때만); "스킬이 수백 개여도 컨텍스트 부풀림 없음" [PDF p.17].
- Subagents: "독립 컨텍스트, 요약만 반환" [PDF p.26][PDF p.32].
- Auto-compaction: 한계 근접 → 오래된 도구 출력 제거(tool outputs 우선 정리) → 대화 요약(필요 시 compaction) → 핵심 보존·작업 지속
  (요청/코드 유지, 초기 상세 지시는 유실 가능) [PDF p.27]. Compact Instructions: CLAUDE.md 섹션으로 보존 지정; `/compact focus` 로 요약 초점 지정 [PDF p.27].
- MCP 도구 정의는 deferred — tool search 로 온디맨드, 평소엔 이름만 소비; `/mcp` 로 서버별 컨텍스트 비용 확인 [PDF p.27][PDF p.37].

## 4. 권한/안전 모델

- 권한 모드 4종(Shift+Tab 순환): Default(파일 편집/셸 명령 전 매번 확인), Auto-accept edits(편집/일반 FS 명령 자동, 그 외 확인),
  Plan mode(읽기 전용 도구만, 계획 후 승인), Auto mode(백그라운드 안전성 검사, research preview) [PDF p.23]. 도식 "Permission (Ask/Allow/Deny)" [PDF p.6][slide6].
- 허용목록: "`.claude/settings.json` 으로 특정 명령 사전 허용, 조직에서 개인까지 정책 스코프 계층" [PDF p.23].
- 체크포인트: 편집 전 파일 스냅샷 자동 저장, Esc 두 번으로 되감기; git 과 별개이며 파일 변경만 커버(외부 부수효과는 체크포인트 불가) [PDF p.23].
- Hooks 를 게이트로: 이벤트 발생 시 JSON 컨텍스트 전달, 핸들러가 "검사 후 결정(허용/차단)"을 반환 가능; PreToolUse = "실행 전 검증/차단" [PDF p.35];
  Hook 은 "settings.json 의 결정적 코드… 린트, 시크릿 차단, 로깅" [PDF p.13]; 예시 `pre-tool-security-scan` [PDF p.40]; PermissionRequest 이벤트 존재 [PDF p.35].
  "규칙은 Hooks 로(결정적 강제)" [PDF p.41]. 주의: "치명적 동작 차단과 무한 루프 주의. 안전 기본값, 멱등성, 철저한 테스트" [PDF p.41].
- Skills 프론트매터 `allowed_tools` 로 도구 접근 권한 제어 [PDF p.18].
- 샌드박스: §2 참조 (실행 환경 3종 [PDF p.22], 서브에이전트 격리 샌드박스 [PDF p.40]); 그 외 세부 **자료 미기재**.

## 5. 확장성

- 4 확장 프리미티브: Skills / MCP / Hooks / Subagents [PDF p.43]; 확장 레이어 "4개" [PDF p.4]. 결정 트리: 지식 vs 행동? → 지식: 항상(CLAUDE.md, 프리미티브 아님)
  vs 조건부(SKILLS); 행동: 내부(부모 컨텍스트=표준 도구 / 격리=SUBAGENTS) vs 외부(모델 결정=MCP / 결정적=HOOKS) [PDF p.39].
- 비교 매트릭스 [PDF p.40]: Skills(조건부 작업 지식, 모델이 컨텍스트로 판단, 같은 대화 컨텍스트, 실패 영향 낮음, 예 `pr-review-checklist`, 지연 Low) /
  Subagents(격리 추론·위임, 모델이 명시적 위임, 격리 샌드박스, 실패 중간, 예 `code-auditor`, Medium) / MCP(모델이 호출하는 외부, 외부 프로세스, 실패 높음
  — 네트워크/인증/장애, 예 `github, postgres`, Med-High) / Hooks(결정적 강제·자동화, 이벤트 트리거, 로컬 훅 러너, 실패 높음 — 흐름 차단/손상, 예 `pre-tool-security-scan`, Low-Med).
- Hooks: 셸 명령 또는 HTTP 핸들러 [PDF p.35]. 12 이벤트: SessionStart, SessionEnd, UserPromptSubmit, Stop, StopFailure, PreToolUse, PostToolUse,
  PostToolUseFailure, SubagentStart, SubagentStop, PermissionRequest, Notification, PreCompact, PostCompact [PDF p.35] (열거는 14개이나 자료 표기는 "12 events").
- Slash commands: SKILL.md `name` 이 "그대로 /slash-command 가 됨" [PDF p.16][PDF p.18]. 자료에 언급된 명령: `/model` [PDF p.11], `/context` [PDF p.26],
  `/compact focus` [PDF p.27], `/mcp` [PDF p.27][PDF p.37], `/agents`(서브에이전트 구성) [PDF p.32]. 독립적 커스텀 slash command 파일 체계는 **자료 미기재**(Skills 로 통합 서술).
- Skills: Anthropic 공개 오픈 표준, 규격 agentskills.io, Cursor/GitHub/JetBrains 등 16+ 도구 채택 [PDF p.16]. 구조 `.claude/skills/<name>/SKILL.md`(필수),
  `scripts/`, `references/`, `assets/` [PDF p.18]. 프론트매터 name / description(자동 매칭 트리거, 가장 중요) / allowed_tools / agent(서브에이전트로 실행) /
  hooks(라이프사이클 콜백) [PDF p.18]. 권장 500줄·5,000 토큰 이하, Git 으로 팀 공유 [PDF p.18]. 경로는 도구별(.claude / .cursor / .agents) [PDF p.19].
- MCP: 표준 프로토콜, MCP 서버가 도구를 노출하면 Claude(MCP 클라이언트)가 auto-discover 해 호출; 서버 예 Filesystem/Git·GitHub/Database/Sentry/Custom, 3000+ 생태계 [PDF p.37];
  "시작 시 연결", "오픈 프로토콜", 용도 API/DB/서비스 [PDF p.19].
- Subagents: §1 참조 [PDF p.32]; `/agents` 로 구성 [PDF p.32].
- Plugins: "코드 인텔리전스(플러그인)" 한 줄 언급만 [PDF p.11]. 플러그인 체계 자체는 **자료 미기재**.

## 6. 자기개선 / 학습 (하네스 자체의 영속적 자기정련)

- 자료가 명시하는 영속 상태: CLAUDE.md(영속 규칙, 사람이 작성) [PDF p.13][PDF p.26], Auto Memory(MEMORY.md, 세션 시작 시 첫 200줄/25KB 로드) [PDF p.26],
  세션 JSONL(로컬 영구 저장, Resume/Fork) [PDF p.22][PDF p.23]. Output Layer 의 Task Result 는 "Verified output / Memory updated" [PDF p.6][slide6];
  End-to-End 는 "미완이면 다음 단계 결정하며 루프 반복(메모리 갱신)", 최종 "검증된 산출물 + 갱신된 메모리" [PDF p.42][PDF p.43].
- 즉 자료상 학습은 **메모리 파일 갱신 수준**이다. 하네스(프롬프트·도구·정책)를 자동으로 개선하는 메커니즘, MEMORY.md 를 누가/어떻게 쓰는지(모델 자동 기록 여부),
  평가 피드백 기반 자기수정 루프는 **자료 미기재**. 설계 원칙의 "관찰하고 측정하며 개선" [PDF p.41] 은 사람(운영자) 대상 권고로 서술됨.

## 7. 모델 연결성

- 모델 라우팅: "Sonnet 은 대부분의 코딩 작업을, Opus 는 복잡한 아키텍처 추론을 담당. `/model` 명령으로 세션 중 전환" [PDF p.11].
- 프로바이더/인증(API key, Bedrock/Vertex 등), 자동 라우팅 정책, 폴백: **자료 미기재**. (참고: 자료 자체는 AWS Korea 발표지만 Bedrock 연결은 언급 없음 [PDF p.1][PDF p.44].)

## 8. 런타임/툴체인 & 배포

- 인터페이스 8+: 터미널(CLI), 데스크톱 앱, VS Code/JetBrains, claude.ai/code(웹), Remote Control, Slack, CI-CD(GitHub Actions), tag @claude(PR) [PDF p.22];
  도식 "User Interface CLI/IDE/CI-CD" [PDF p.6][slide6].
- 실행 환경: Local / Cloud(Anthropic 관리 VM) / Remote Control [PDF p.22]. 세션은 `~/.claude` JSONL 로 로컬 영구 저장 [PDF p.22][PDF p.23].
- 세션 연속성: Resume(같은 ID 에 메시지 추가), Fork(`--fork-session`, 새 ID 로 히스토리 복사) [PDF p.23].
- 구현 언어·런타임(Node/Bun 등), 설치 방식, 패키징/배포 채널: **자료 미기재**.

## 9. 평가 / 텔레메트리

- 관찰성은 Hooks 로 정의: PostToolUse = "포맷/테스트/로깅", Notification 이벤트, Hook 용도로 "로깅" [PDF p.13][PDF p.35]; Observability 레이어 = "라이프사이클 이벤트로
  결정론적 통제" [PDF p.43]. 컨텍스트 사용량 점검 `/context`, MCP 서버별 비용 `/mcp` [PDF p.26][PDF p.27].
- 벤치마크/평가 하네스, 원격 텔레메트리(OpenTelemetry 등), 사용량 통계 수집: **자료 미기재**.

---

## (c) 가장 특징적인 아키텍처 선택 5가지

1. **단일 Master Agent Loop(Gather-Act-Verify) 를 중심에 두고 8 레이어가 request/feeds/execute/observe·spawn 으로 둘러싸는 허브 구조**; 인터페이스·실행 환경이 달라도 같은 루프
   ("Same loop, everywhere") [PDF p.6][slide6][PDF p.22].
2. **컨텍스트 진입 시점을 4개 파일 종류로 분리**: CLAUDE.md(항상, 매 턴) / SKILL.md(description 매칭 시) / Prompt(지금) / Hook(이벤트) — "무엇을·어떻게·지금·자동으로"
   [PDF p.13][PDF p.14]. Skills 는 3단계 Progressive Disclosure 로 30-50 토큰 메타데이터만 상주 [PDF p.17].
3. **결정적 강제는 Hooks, 판단은 모델**: 12 라이프사이클 이벤트에 셸/HTTP 핸들러가 JSON 을 받아 허용/차단을 반환; 프리미티브 선택 트리에서 "외부: 모델 결정=MCP vs 결정적=Hooks"
   [PDF p.35][PDF p.39][PDF p.41].
4. **컨텍스트 격리형 멀티에이전트**: 서브에이전트는 fresh 컨텍스트에서 실행하고 요약만 반환("Delegate, don't bloat"), git worktree 로 병렬 세션 [PDF p.32][PDF p.23][PDF p.6].
5. **사람 통제 + 되감기**: 4 권한 모드(Default/Auto-accept/Plan/Auto), settings.json 사전 허용의 조직→개인 정책 계층, 편집 전 자동 스냅샷 체크포인트(Esc Esc) [PDF p.23][PDF p.4].
   부수적으로 비용/지연 설계(Prompt Cache ~10%, 스트리밍·독립 도구 병렬, MCP 도구 deferred 로딩) [PDF p.30][PDF p.27].

---

## 자료 외 보충(미확인)

아래는 자료에 없으며 일반 지식에 기반한 보충이다. 본 프로젝트 근거로 쓰지 말고 필요 시 별도 확인할 것.

- §2 샌드박스: 자료는 OS 수준 격리 기법을 말하지 않는다. Claude Code 문서에는 Bash 도구용 샌드박스 설정이 존재한다고 알려져 있으나 본 자료로는 미확인.
- §5 Hooks 개수: 자료 표기 "12 events" 와 열거된 14개 이름이 불일치한다 [PDF p.35]. 어느 쪽이 정확한지는 공식 문서(code.claude.com/docs) 확인 필요.
- §7 프로바이더: Claude Code 가 Anthropic API 외에 Amazon Bedrock / Google Vertex AI 를 환경변수로 선택할 수 있다는 것은 일반 지식이며 본 자료 미기재.
- §8 런타임: Claude Code 가 npm 으로 배포되는 Node 기반 CLI 라는 것은 일반 지식이며 본 자료 미기재.
- §9 텔레메트리: OpenTelemetry 기반 사용량/비용 메트릭 내보내기가 문서화되어 있다는 것은 일반 지식이며 본 자료 미기재.
- §6 Auto Memory: 모델이 세션 중 학습한 내용을 MEMORY.md 에 자동으로 기록한다는 동작은 일반 지식이며, 자료는 "첫 200줄/25KB 로드"만 말한다 [PDF p.26].
