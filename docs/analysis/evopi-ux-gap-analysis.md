# evopi UX 격차 분석 — 인기 OSS 코딩 도구 대비 (2026-09-07)

> 입력: `docs/analysis/harness-comparison.md`(6자 매트릭스), `docs/analysis/opencode-oh-my-openagent-arch.md`(신규 실측),
> `docs/design/NEXT-STEPS.md`(트랙 A/D). 범위는 **아키텍처 재비교가 아니라 UX(설정 표면·발견성·투명성·CLI 상호작용) 격차**로 한정.
> Cursor/Aider/Cline/Windsurf 는 사용자 지시로 비교 대상에서 제외. Codex CLI 는 로컬 근거가 얇아(§ 하단 표에서만 언급)
> 우선순위 산정의 1차 비교 대상에서는 제외하고 opencode+oh-my-openagent 를 주 비교 대상으로 삼는다.
> 근거는 모두 `파일:라인`(evopi) 또는 `절대경로:라인`(opencode, 저장소 외부) 인용. 미확인은 명시.
> (2026-09-07 추가) 사용자 지시로 **CLI 실행 중 상호작용 UX**(승인 프롬프트 등)도 범위에 포함 — G6, evopi
> `src/modes/interactive/` TUI 컴포넌트·`permission-gate.ts` 실측 기반, 비교 대상 없이 evopi 자체 코드 내
> 불일치(사후 렌더러는 있는데 사전 프롬프트는 안 씀)로 근거를 세운다.

## 0. 먼저 배제한 항목 — 관측된 강점(격차 아님)

계획 초안에는 "세션/멀티세션 관측성"을 격차 후보로 넣었으나, 실측 결과 **evopi 가 이미 동등하거나 더 견고**하다.
opencode 는 `plugins/herdr-agent-state.js`(외부 herdr 데몬에 유닉스 소켓 리포트, working/idle/blocked)를 서드파티
플러그인으로 얹는다(opencode-oh-my-openagent-arch.md §4.2). evopi 는 같은 통합을
**빌트인으로 내장**했고 — 파일 기반 중복 리포터 감지(`hasFileBasedHerdrIntegration`,
`herdr-agent-state.ts:38-43`), 재시도 유예창을 포함한 상태 판정(`:73-80`) — 이 부분은 자기 자랑용 스코어보드가
아니라 "이미 해결된 항목을 다시 격차로 잘못 세우지 않기 위한" 배제 기록이다. 아래 5개 항목만 실제 격차로 다룬다.

## 1. 우선순위 요약

| # | 격차 | 심각도(체감 마찰) | 실행 가능성(제약 하) |
|---|---|---|---|
| G1 | 권한 티어가 **명령 패턴 단위**로 세분화되지 않음 | 높음 | 높음 (설정 스키마 확장만, 골격 무수정) |
| G2 | 서브에이전트가 **명명된 역할/모델/권한 선언**이 없음 (즉석 함수 호출만) | 높음 | 중 (표현 계층 추가, 실행 경로는 이미 존재) |
| G3 | 모델/카테고리 라우팅을 **한 파일에서 보고 바꾸는 표면**이 없음 | 중 | 중 (기존 카탈로그·auth-pool 재사용, 뷰만 신설) |
| G4 | 스킬 메타데이터에 **risk/tags/포터블 호환 필드**가 없음 | 중 | 높음 (프론트매터 스키마 확장 + 문서화) |
| G5 | 확장(익스텐션) 배포가 **파일 배치**뿐, 패키지명 설치 UX 없음 | 낮음 | 낮음 (레지스트리/버전 관리 신규 인프라 필요) |
| G6 | 승인 프롬프트가 **원문 텍스트만 보여주고 이진(Yes/No)** — diff 미리보기·인라인 승격 없음 | 높음 | 높음 (기존 diff 렌더러 재사용 + 다이얼로그 옵션 추가) |

## 2. G1 — 권한 티어의 명령 패턴 그래뉼러리티

**evopi 현재**: 승인은 `read/write/exec` 3툴티어 + `hazard` 위험축, 프리셋 `dev/strict/yolo`
(`permission-gate.ts:360-366`). 세분화 단위는 **툴 이름 하나**(`approval.toolTiers[toolName]`,
`permission-gate.ts:618-641`, `settings-manager.ts:82,95`)이고, 이를 벗어나는 예외는 `permissionGate.allow[]` —
**전역** 정규식 배열 하나가 하자드·티어 프롬프트 모두에 동일하게 적용된다(`permission-gate.ts:32-33 주석`,
`:739-747 compileAllow`). evopi 의 등록 툴이 실질적으로 `ipython` 하나뿐이라(evopi-harness-inventory.md:39),
"이 명령 패턴은 자동, 저 패턴은 확인, 이 명령군은 원천 차단"을 **역할별로 다르게** 표현할 방법이 없다 — 있는 건
전역 화이트리스트 하나뿐.

**opencode+oh-my-openagent**: `agents/*.md` 4개 파일이 `bash: {"npm *": allow, "git diff*": allow, "*": ask}` 형태의
글롭 패턴→allow/ask/deny 맵을 **서브에이전트마다 다르게** 선언한다 — coder(패키지매니저·읽기전용 git 자동, 나머지
확인) < researcher(검색류만 자동) < reviewer(읽기전용만 자동, 나머지는 확인이 아니라 **원천 차단**)
(opencode-oh-my-openagent-arch.md §3.3). 이 강도 차이가 프론트매터 몇 줄로 "읽으면 바로 보이는" 형태다.

**격차의 본질**: evopi 는 위험도 판정(정규식 하자드 감지)은 이미 세밀하지만, **"무엇을 자동 허용할지"의 표현 단위가
툴 하나**다. 서브에이전트별로 다른 정책을 주려면 지금은 코드를 새로 쓰는 수밖에 없다.

**CLAUDE.md 제약 하 실행 가능성**: `~/.evopi` 단일 경로·prime 골격 무수정·evo-off 무영향 원칙과 충돌하지 않는다 —
`ApprovalSettings`(`settings-manager.ts:85`)에 `toolTiers` 옆에 명령 패턴 맵을 추가하고
`classifyToolCall`(`permission-gate.ts:618`)에서 `extractShellCommand`(`:263`)로 뽑은 텍스트를 그 맵으로 먼저
검사하도록 확장하면 된다 — 새 스킬/서브에이전트 정의가 자기 패턴 맵을 갖는 구조는 **G2 와 자연히 결합**된다(§3).
D5(승인 티어, NS Phase M24)가 이미 이 방향의 절반을 만들어놓았으므로 v2 항목으로 트랙 A/D 에 자연스럽게 들어간다.

## 3. G2 — 서브에이전트 롤스터의 투명성

**evopi 현재**: 서브에이전트는 커널에서 `rlm.run(prompt, *, isolated=None, **kwargs)`
(evopi-runtime/src/rlm/__init__.py:96)로 **즉석 호출**되고, `list_subagents()`(:174)는 현재 살아있는 인스턴스
레지스트리를 보여줄 뿐 "역할/모델/권한이 미리 선언된 목록"이 아니다. 사용자가 "이 프로젝트에 어떤 서브에이전트
타입이 있고 각각 무슨 모델·무슨 권한을 쓰는지" 확인할 파일이 없다 — 매 호출의 `**kwargs` 에 묻혀 있다.

**opencode+oh-my-openagent**: `agents/*.md` 4개 + `oh-my-openagent.json` 의 10개 에이전트가 **이름·모델·폴백·권한을
파일 하나로 선언**한다(오케스트레이터가 `permission.task.<name>: allow` 로 호출 가능 목록까지 명시,
opencode-oh-my-openagent-arch.md §3.1,§3.3). 이 목록 자체가 "이 시스템에 어떤 에이전트가 있는가"에 대한 답이다.

**격차의 본질**: evopi 의 서브에이전트 실행 경로(`_createInlineRlmSubagentRuntime`, agent-session.ts:9510)는 이미
동작하지만, **선언적 표현 계층**이 없어서 재사용 가능한 역할이 프롬프트 텍스트 관례로만 존재한다(예: `.evopi/agent`
프로젝트 스킬 어딘가에 "리뷰어 역할" 문구가 있을 수는 있으나 구조화되어 있지 않음, 미확인).

**CLAUDE.md 제약 하 실행 가능성**: prime 골격(agent-loop) 무수정 원칙에 부합 — `rlm.run` 호출부 자체는 손대지
않고, 그 위에 "이름 있는 프리셋"을 얹는 표현 계층만 추가하면 된다(예: `.evopi/agent/subagents/<name>.md`
프론트매터로 model/permission/patternMap 선언 → `rlm.run(role="researcher")` 가 그 프리셋을 로드). evo 레이어와
무관하므로 evo off 에도 영향 없음. G1 의 명령 패턴 맵을 이 프론트매터에 얹으면 두 격차가 한 설계로 닫힌다.

## 4. G3 — 모델/카테고리 라우팅의 설정 표면

**evopi 현재**: 모델 연결 인프라는 opencode+oh-my-openagent 보다 **기능적으로 이미 앞서 있다** — 66(prime 기준
32) 프로바이더 카탈로그, `auth-pool`(env.ts:34, pool.ts:47) 크리덴셜 풀 로테이션, `dialect-mode.ts`(:65) 11종
인밴드 툴콜 방언, `databricks-auth.ts`(:93,:159) 전용 캐시까지. 그런데 "이 역할/이 작업 성격에는 이 모델, 실패하면
이 폴백" 을 **사람이 한 파일에서 읽고 고칠 수 있는 표면**은 없다 — 풀 로테이션은 같은 모델의 키 여러 개를 순환하는
것이고(`CredentialPool`, pool.ts:47), oh-my-openagent 식의 "역할별 다른 모델 + 명시적 폴백 체인"과는 축이 다르다.

**opencode+oh-my-openagent**: `oh-my-openagent.json` 이 10-에이전트 개별 모델/폴백 표(§3.1)와, 그와 **완전히
분리된** 8-카테고리(quick/deep/artistry 등 작업 성격별) 모델+폴백 표(§3.2)를 각각 명시적 JSON 배열로 노출한다.
카테고리→호출 매핑 로직 자체는 npm 패키지 내부라 미확인이지만, **설정 표면**(무엇이 무엇에 매핑되는지 보고 고치는
파일)은 로컬에서 확인 가능하고 사람이 읽을 수 있다.

**격차의 본질**: evopi 가 부족한 건 라우팅 능력이 아니라 **그 능력의 가시적 설정 표면**이다. 지금은 "이 역할에
이 모델을 쓰겠다"는 결정이 인프라 능력(있음)과 사용자 대면 선언(없음) 사이에서 실종된다.

**CLAUDE.md 제약 하 실행 가능성**: 기존 `ModelRegistry`(model-registry.ts:463)·`auth-pool`을 그대로 재사용하고
그 위에 "역할→모델→폴백" 선언 파일 하나(G2 의 서브에이전트 프리셋과 같은 파일이어도 됨)와 "작업성격 카테고리"
선택자(옵션, evo 게이트 뒤에 둘 수 있음)만 추가하는 문제라 실행 비용은 중간 — 새 인프라가 필요 없고 표현 계층만
필요하다는 점에서 G1/G2 와 같은 패턴.

## 5. G4 — 스킬 생태계의 발견성/포터블 메타데이터

**evopi 현재**: 번들 스킬 16개(Python 11, Markdown 5), 프론트매터는 `name`+`description` 뿐
(예: `packages/coding-agent/skills/{agent-message,edit,goal,...}/SKILL.md:1-3`, 실측 8개 파일 전부 동일 2필드).
위험도(예: 파괴적 동작 가능성)·출처(공식/커뮤니티/개인)·다른 CLI 에서도 쓸 수 있는지에 대한 선언이 전혀 없다.

**opencode 스킬 생태계**: 1,460개 스킬 디렉터리, 프론트매터에 `risk`(unknown/safe/critical/none/offensive),
`source`(community/personal/official 등), `tags`, `date_added`, 그리고 **165개 파일에 `tools:` 크로스-CLI 호환
목록**(예: `007/SKILL.md` → `[claude-code, antigravity, cursor, gemini-cli, codex-cli]`) — 컨벤션이 아직
불안정하지만(opencode-oh-my-openagent-arch.md §5, `tools:` 의미가 파일마다 "포터빌리티"/"허용 도구"로 혼용) 존재
자체가 evopi 보다 진전돼 있다. 규모 대비 신뢰성 우려가 커서 `skill-audit` 라는 자기감사 스킬까지 나온 상태.

**격차의 본질**: evopi 는 스킬 **개수**가 부족한 게 문제가 아니라(16개는 의도적으로 얇게 유지되는 것으로 보임),
**있는 스킬의 위험도·출처를 사용자가 설치/활성화 전에 판단할 근거가 프론트매터에 없다**는 점, 그리고 프로젝트
스킬을 작성할 때 "이게 다른 코딩 CLI 에서도 쓰이나"를 선언할 자리가 없다는 점.

**CLAUDE.md 제약 하 실행 가능성**: 순수 프론트매터 스키마 확장(`skills.ts:loadSkillsFromDir`, :275 주변에
optional 필드 파싱 추가)이라 비용이 가장 낮다. opencode 처럼 1,460개를 유통할 필요는 없음 — 그 규모 자체가
`skill-audit` 을 낳은 리스크 요인이므로, evopi 는 "적지만 각 스킬에 risk/source 필드가 붙어 있다"는 더 작고 더
신뢰 가능한 버전을 목표로 삼을 수 있다. `tools:` 필드는 프로젝트 스킬(`.evopi/agent/skills`)에 한해 문서 목적
메타데이터로 우선 추가 — 실제 크로스-CLI 로딩 기능까지 만들 필요는 없다(v2).

## 6. G6 — 승인 프롬프트의 사전 미리보기·승격 UX

**evopi 현재**: write/exec-tier 나 hazard 승인이 필요할 때(`policy === "ask"`), TUI 는 원문 명령/편집 텍스트를 그냥
truncate 해서 보여주고 `ctx.ui.select(prompt, ["No", "Yes"])` 로 이진 선택만 받는다
(`permission-gate.ts:851-854`). `select()` 의 시그니처 자체가 `options: string[]` 뿐이라
(`extensions/types.ts:116`) "이번만 허용"과 "이 패턴은 항상 허용"을 구분할 자리가 없다 — 승인하면 그 순간만
넘어가고, 같은 명령이 다음 턴에 또 나오면 또 물어본다. 이 프롬프트 자체 안에서 결정을 영구화(설정 파일에 반영)할
길이 없어, 사용자는 반복 승인을 피하려면 대화를 멈추고 `~/.evopi/agent/settings.json` 을 직접 열어 고쳐야 한다.

**같은 코드베이스 안의 불일치가 근거**: evopi TUI 는 이미 리치 diff 렌더러(`renderDiff`/`renderRichDiff`,
`components/diff.ts`)를 갖고 있고, 이를 실행 **결과**를 보여줄 때는 적극적으로 쓴다 — `ipython-cell.ts:677-717`
(셀 실행 후 diff 표시), `edit-summary.ts:6`·`refinement-outcome-message.ts:6,102`(편집/정련 결과 diff). 그런데 편집이
일어나기 **전** 승인을 구하는 시점(`permission-gate.ts:851-853`)에는 같은 렌더러를 쓰지 않고 원문 텍스트만 보여준다
— "무엇이 바뀔지 미리 보고 승인한다"가 아니라 "무슨 명령인지 텍스트로 읽고 승인한다"에 머물러 있다.

**격차의 본질**: 이건 비교 대상 툴 실측이 필요 없는, evopi 자체 코드 안의 능력-사용 불일치다 — diff 렌더링
능력은 이미 있는데 그게 필요한 순간(승인 직전)에는 안 쓰인다. 그리고 G1(명령 패턴 세분화)이 나중에 구현되더라도,
프롬프트에서 즉시 "이 패턴은 항상 허용"을 눌러 그 결과가 설정 파일에 반영되는 흐름이 없으면 세분화된 설정 자체를
발견·수정할 경로가 여전히 파일 편집뿐이다 — G1 은 "무엇을 세분화할 수 있는가", G6 은 "그 세분화를 프롬프트에서
바로 만들 수 있는가"로 서로 다른 층위의 문제.

**CLAUDE.md 제약 하 실행 가능성**: 높음. `ctx.ui.select` 호출부(`permission-gate.ts:851-854`)의 옵션 배열에
"Always allow this pattern" 을 추가하고, 선택 시 G1 에서 추가하는 명령 패턴 맵(또는 현재의
`permissionGate.allow[]`)에 항목을 append 하는 것만으로 된다 — 새 UI 컴포넌트 불필요, `ctx.ui.select` 를 그대로
사용. write-tier 프롬프트의 텍스트 구성부만 `renderDiff`(이미 임포트 가능한 로컬 모듈)로 바꾸면 diff 미리보기도
붙는다. prime 골격·evo 게이트와 무관해 D3/D7 원칙과 충돌 없음.

## 7. G5 — 확장(익스텐션) 배포의 UX

**evopi 현재**: 확장은 고정 디렉터리 스캔으로만 로드된다 — `discoverAndLoadExtensions`(loader.ts:568)가
`<cwd>/.evopi/agent/extensions`(`:587-588`), `~/.evopi/agent/extensions`(`:590-591`), 설정에 명시된 추가 경로만
훑는다(`loadExtensions`, `:434`). 공유하려면 파일을 복사해 넣으라고 안내하는 수밖에 없다 — 이름으로 설치하거나
버전을 지정하는 경로가 없다.

**opencode**: `plugin` 은 그냥 npm 패키지명 배열이다(`opencode.json:3-6`) — `oh-my-openagent@latest` 처럼 이름과
버전으로 설치·고정한다. npm 생태계 전체가 배포/버전관리 인프라를 대신 해준다.

**격차의 본질**: evopi 가 이 UX 를 따라가려면 자체 레지스트리나 최소한 "npm 패키지를 익스텐션으로 취급"하는
로더 경로가 필요하다 — 이는 새 인프라(신뢰 경계, 서명/검증 등)를 여는 일이라 다른 4개보다 비용·리스크가 크다.

**CLAUDE.md 제약 하 실행 가능성**: 낮음으로 평가 — Rust/Bazel/bun/Nix 부재나 evo-off 무영향 원칙과는 무관하지만,
"임의 npm 패키지를 로드"는 원본 레포 2개 무수정 원칙과는 별개로 새로운 공급망 신뢰 문제를 만든다. 이번 UXP 제안서
(top 3-5)에는 포함하지 않고 v2 백로그로만 기록.

## 8. 결론 — UXP 로 넘길 상위 항목

G1·G2·G3 은 서로 강하게 결합돼 있다(같은 "역할 프리셋 파일"이 명령 패턴 맵 + 모델/폴백 + 권한을 함께 선언할 수
있음) — `docs/design/UXP-evopi-ux-proposal.md` 의 제안 1로 묶는다. G4 는 독립적이고 비용이 가장 낮아 제안 2.
G6 은 비교 대상 없이 evopi 자체 코드 내 불일치(diff 렌더러는 있는데 승인 전에는 안 씀)로 근거가 서고 실행
가능성도 높아 제안 4(CLI 상호작용 UX). G5 는 v2 백로그로만 남기고 이번 제안서의 상위 3-5개에는 포함하지
않는다(비용/리스크 대비 우선순위 낮음).
