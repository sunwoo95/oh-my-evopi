# opencode + oh-my-openagent 아키텍처 실측 (외부 비교 대상)

> 대상: `/opt/workspace/local/sw4kim/opencode/` (사용자 런타임 설정/상태 디렉터리, oh-my-evopi 저장소 **외부**, 읽기 전용 조사).
> 인용 규칙: 모든 인용은 `(로컬 실측, 저장소 외부) 절대경로:라인` 형식. 일반 지식으로 보충한 항목만 §8에서
> `(공개 자료/일반 지식 기준(미검증))`로 분리 표기. 확인 못한 항목은 "미확인 (로컬 자료로 검증 불가)".
> ⚠ `opencode.json`/`*.bak` 에 평문 Databricks API 키가 있음 — 본 문서는 경로만 인용하고 값은 절대 기재하지 않음.

## 1. 한 줄 결론

opencode 는 "설정 파일(JSON) + Markdown 에이전트 정의 + JS 플러그인"으로 구성을 선언하는 얇은 코어이고, `oh-my-openagent` 는
그 위에 npm 패키지 하나(`oh-my-openagent@latest`)를 plugin 배열에 얹는 것만으로 10-에이전트 롤스터·8-카테고리 모델
라우팅·TUI 확장을 주입하는 서드파티 메타하네스다 — evopi가 prime-agent 를 감싸는 구조와 축은 같지만, opencode 쪽은
"권한 세분화(에이전트별 tool/bash allow-ask-deny)"와 "모델 라우팅(카테고리·폴백체인)"이 완전히 분리된 두 개의 독립 설정
평면(`agents/*.md` vs `oh-my-openagent.json`)으로 존재한다는 점이 특징이다.

## 2. opencode 자체 (베이스 툴)

- **provider/model 설정 형태**: `opencode.json` 최상위에 전역 `model`/`small_model`, `provider.<id>.options.{apiKey,baseURL}`,
  `provider.<id>.models.<slug>.{name,reasoning}` 3중 구조.
  (로컬 실측, 저장소 외부) `/opt/workspace/local/sw4kim/opencode/opencode.json:7-8` (전역 model/small_model),
  `:18-24` (provider.databricks — `apiKey` 값은 평문 존재, 여기서는 경로만 인용, 값 미기재),
  `:25-46` (models 맵, 6개 슬러그: sonnet-4-6/haiku-4-5/gemini-3-flash/gemini-3-1-flash-lite/gpt-5-3-codex/gpt-5-4).
  `$schema: https://opencode.ai/config.json` 로 공개 스키마를 참조 (`:2`).
- **agent.plan/agent.build**: opencode 코어 자체가 `plan`/`build` 두 "모드"를 1급 개념으로 갖고 각각 별도 모델을 배정한다
  — 즉 oh-my-openagent 의 에이전트 개념과는 별도로, opencode 코어 레벨에서 "계획 모드 vs 실행 모드"의 모델 분리가 이미
  존재함을 시사한다. (로컬 실측) `/opt/workspace/local/sw4kim/opencode/opencode.json:9-16` (`agent.plan.model`,
  `agent.build.model`). 이는 Claude Code 의 "Plan mode(읽기전용) / 기본 모드" 구분과 유사한 축이나, opencode 는 이를
  **모델 배정 단위**로 설정 파일에 노출한다는 점이 다르다.
- **플러그인 로딩**: `plugin` 은 단순 문자열 배열(npm 패키지명@버전) — `opencode-gemini-auth@latest`,
  `oh-my-openagent@latest`. (로컬 실측) `:3-6`. 코어가 이 배열을 순회하며 각 npm 패키지의 export(예: `GeminiFixPlugin`,
  `HerdrAgentStatePlugin` — §4 참조)를 로드하는 npm-package-as-plugin 방식.
- **`tui.json` 의 별도 plugin 배열**: 루트 설정과 별개로 TUI 프로세스만을 위한 plugin 목록이 존재, 값은
  `oh-my-openagent/tui` — 같은 npm 패키지의 **서브패스**를 TUI 전용으로 지정한다. (로컬 실측) `tui.json:1-5`. 이는
  opencode 가 "코어 프로세스"와 "TUI 프로세스"를 분리해 각자 별도의 플러그인 로딩 지점을 갖는다는 뜻이고, 실제로
  `@opencode-ai/plugin` 의 `exports` 도 `.`(코어)/`./tui`(TUI) 를 분리 노출하며(로컬 실측)
  `node_modules/@opencode-ai/plugin/package.json:9-19`, `@opencode-ai/sdk` 는 `exports` 에 `./client`/`./server`
  를 별도 노출한다(로컬 실측) `node_modules/@opencode-ai/sdk/package.json:11-19` — SDK 레벨에서 client/server 모듈이
  명시적으로 분리돼 있다. 코어가 Go/TS 중 무엇인지는 이 파일들로 확정 불가(§8)하나, "TUI-코어 프로세스/모듈 경계
  분리" 자체는 로컬 자료로 확인된다.

## 3. oh-my-openagent 레이어

### 3.1 에이전트 롤스터 (10개, `oh-my-openagent.json`)

| 에이전트 | 배정 모델 | fallback | superpowers 스펙 상 역할 추정 |
|---|---|---|---|
| sisyphus | gemini-3-flash | – | 오케스트레이션/게이트웨이 (①) |
| oracle | gpt-5-3-codex | – | 자문/디버거 (②) |
| librarian | gemini-3-flash | claude-haiku-4-5 | 문서 조회 |
| explore | gemini-3-1-flash-lite | 동일(gemini-lite) | grep/파일 고속 스캔 |
| multimodal-looker | claude-sonnet-4-6 | – | 비전/이미지 판독 |
| prometheus | gpt-5-3-codex | – | 플래너 |
| metis | gpt-5-3-codex | – | 사전분석/설계 |
| momus | claude-sonnet-4-6 | – | 리뷰어 |
| atlas | gemini-3-1-flash-lite | 동일 | todo 추적 |
| sisyphus-junior | gemini-3-flash | haiku-4-5 → gemini-lite (2단) | 실행(집행) 담당 |

(로컬 실측) `/opt/workspace/local/sw4kim/opencode/oh-my-openagent.json:3-57` (agents 블록 전체).
역할 열은 opencode.json 자체엔 없고 설계 문서에서 가져온 것 — (로컬 실측)
`/opt/workspace/local/sw4kim/opencode/docs/superpowers/specs/2026-06-01-opencode-model-routing-design.md:25-37`
(각 에이전트 옆에 "orchestration/planner/pre-planner-analysis/advisor-debugger/reviewer/vision/docs/execution/grep/todo-tracking"
한 줄 역할 주석이 붙어 있음). `sisyphus-junior` 만 유일하게 2단 폴백 체인을 가짐 (`:47-55`).

### 3.2 카테고리 기반 모델 라우팅 (8개, 폴백 체인 포함)

| 카테고리 | 1차 모델 | 폴백 체인 |
|---|---|---|
| visual-engineering | claude-sonnet-4-6 | 없음 |
| ultrabrain | gpt-5-3-codex | 없음 |
| deep | gpt-5-3-codex | → sonnet-4-6 → gemini-lite (2단) |
| artistry | claude-sonnet-4-6 | → gpt-5-3-codex → claude-haiku-4-5 (2단) |
| quick | gemini-3-1-flash-lite | 없음 |
| unspecified-low | gemini-3-1-flash-lite | → 동일 모델 재시도 1단 |
| unspecified-high | claude-haiku-4-5 | → 동일 모델 재시도 1단 |
| writing | claude-haiku-4-5 | → 동일 모델 재시도 1단 |

(로컬 실측) `/opt/workspace/local/sw4kim/opencode/oh-my-openagent.json:58-114`. "카테고리"는 **에이전트와 별개의 축** —
개별 에이전트가 아니라 작업 성격(품질/속도 트레이드오프 라벨)별로 모델을 배정하는 두 번째 라우팅 테이블이며, 코드 상
"어떤 호출이 어느 카테고리로 태깅되는지"의 매핑 로직은 oh-my-openagent 의 npm 패키지 내부(미설치 상태, 로컬엔 존재하지
않음)에 있어 **미확인**. `unspecified-low/high/writing` 은 폴백이 "같은 모델을 한 번 더 시도"인데, 이는 실질적으로
장애 재시도(retry)이지 진짜 대체 모델 전환이 아니다 — 설계상 프로덕션 폴백 체인이 카테고리별로 성숙도가 다름을 보여준다.

### 3.3 `agents/*.md` 의 별도 권한-등급 축

`oh-my-openagent.json`(모델 라우팅)과 완전히 분리된 두 번째 설정 평면이 `agents/*.md` 4개 파일이다. 여기서는
`mode: primary|subagent`, 도구별 `edit: allow|deny`, **bash 글롭 패턴별** `allow|ask|deny` 3단계 권한 문법을 쓴다:

- `mode`: `orchestrator.md:3` 만 `primary`, `coder.md`/`researcher.md`/`reviewer.md` (각 `:3`) 는 `subagent`. primary
  에이전트는 `permission.task.<subagent-name>: allow` 로 호출 가능한 서브에이전트를 화이트리스트로 명시한다 —
  (로컬 실측) `orchestrator.md:7-13` (`task.researcher/coder/reviewer/general/explore: allow`).
- `edit`: 파일 편집 on/off. `coder.md:7` = `allow`, `researcher.md:7`/`reviewer.md:7` = `deny`.
- `bash`: **글롭 패턴 키 → allow/ask/deny 값**의 맵, 뒤의 `"*"` 가 나머지 전부를 잡는 fallthrough — 강도가 3단계로
  다르다: `coder.md:8-15`(`npm */bun */pnpm */yarn */git diff*/git status*/git log*`: `allow`, `"*"`: `ask` — 패키지매니저·
  읽기전용 git 자동허용, 그 외 매번 확인) < `researcher.md:8-12`(`git */grep */find */rg *`: `allow`, `"*"`: `ask` —
  검색류만 자동허용) < `reviewer.md:8-13`(`git diff*/git log*/git status/cat *`: `allow`, `"*"`: **`deny`** — 읽기전용
  서브에이전트라 fallthrough 를 원천 차단, 앞의 둘보다 한 단계 강함). `orchestrator.md` 는 `permission.bash` 필드
  자체가 없음 — plan 상 원래 "직접 실행 금지, 전부 위임"이었다가 "단순 작업은 직접 처리 허용"으로 바뀐 이력이 있고
  (§7), 그 결과 bash 세부 권한 없이 `task.*` 위임 화이트리스트만 남음. 패턴 매칭 우선순위(구체적 패턴 vs 선언순서)는
  **미확인**.

특히 **bash 를 글롭 패턴 단위로 3단계(allow/ask/deny) 세분화**한다는 점이 UX 관점에서 눈에 띈다 — evopi RUNBOOK 의
"명령 화이트리스트/ask-once" 개념과 견줄 대상이며, 서브에이전트별로 "읽기전용 git/grep 은 자동, 그 외는 확인, 위험군은
원천 차단"을 프론트매터 몇 줄로 표현한다.

## 4. 플러그인 시스템 실측

두 플러그인 모두 npm 패키지가 아니라 `plugins/*.js` 로컬 파일로 존재하며, `opencode.json` 의 `plugin` 배열에는 이름이
없다 — 즉 이 둘은 `plugin` 디렉터리에 두는 것만으로 자동 로드되는 별도 슬롯으로 보인다 (파일명 자체가 로더 계약인지는
미확인).

### 4.1 `gemini-fix.js` — 프로바이더 호환성 패치 (요청/응답 페이로드 가로채기)

전역 `globalThis.fetch` 를 자체 구현으로 교체하는 monkey-patch. (로컬 실측) `/opt/workspace/local/sw4kim/opencode/plugins/gemini-fix.js:1,103`.
URL에 `serving-endpoints` 가 포함된 요청만 가로채 세 가지를 한다:
1. **Codex 모델 브리징**: `model` 이름에 `codex` 포함 시, Chat Completions 형식(`messages`)을 Databricks Responses API
   형식(`input`)으로 변환하고 URL을 `/serving-endpoints/responses` 로 재경로화한 뒤, 응답을 다시 Chat Completions
   포맷(`choices[0].message`)으로 역변환 — 스트리밍/논스트리밍 둘 다 지원 (`:111-239`).
2. **JSON 스키마 필드 제거**: 요청 바디에서 `$schema`/`exclusiveMinimum`/`stream_options` 키를 재귀 삭제 (`:7-21`, `:245-247`)
   — Databricks 게이트웨이가 이 키들을 거부하는 것을 우회하는 것으로 추정.
3. **`thought_signature` 재주입**: Gemini 응답에서 `thought_signature`/`thoughtSignature`(또는 `google.thought_signature`)
   를 찾아(`findThoughtSignature`, `:23-49`) 메시지 콘텐츠+툴콜을 키로 한 `Map` 에 저장했다가, 다음 요청에서 동일 키의
   어시스턴트 메시지에 그 값을 다시 주입(`injectSignature`, `:70-101`) — 멀티턴에서 Gemini 의 "thinking" 서명이
   유지되도록 하는 상태 보존형 패치. 스트리밍 응답은 `ReadableStream` 을 가로채 델타를 누적하며 종료 시점에 서명을
   매핑한다 (`:289-381`).

### 4.2 `herdr-agent-state.js` — 외부 대시보드용 라이프사이클 리포터 (유닉스 소켓)

`HERDR_ENV=1` 이고 `HERDR_SOCKET_PATH`/`HERDR_PANE_ID` 환경변수가 모두 설정된 경우에만 동작 (그 외엔 빈 `{}` 반환).
(로컬 실측) `/opt/workspace/local/sw4kim/opencode/plugins/herdr-agent-state.js:74-81`. opencode 의 이벤트 훅(`event`
콜백, `dispose` 콜백)을 구현해 `session.*`/`permission.*`/`question.*` 이벤트를 "herdr" 라는 외부 프로세스에
`node:net` 유닉스 도메인 소켓으로 보고한다 (`:7, 56-71`). 프로토콜은 JSON-RPC 형태의 단발 요청:
```json
{"id":"herdr:opencode:<ts>:<rand6>", "method":"pane.report_agent",
 "params":{"pane_id":"...", "source":"herdr:opencode", "agent":"opencode",
           "state":"working|idle|blocked", "seq": <int>, "agent_session_id":"..."}}
```
(로컬 실측) `:31-54`. `dispose` 시엔 `method: "pane.release_agent"` 로 별도 해제 요청(`:84-86`). 상태값 매핑:
`permission.asked`/`question.asked` → `blocked`(`:93-96`), `permission.replied`(reject) → `idle`, (once/always) →
`working`(`:97-105`), `session.status`(busy/retry→working, idle→idle)(`:118-129`). 소켓 경로/pane id 네이밍으로 볼 때
"herdr" 는 다중 tmux/터미널 pane 각각에서 도는 여러 opencode 인스턴스의 상태(작업중/유휴/권한대기)를 한 대시보드에서
관측하는 멀티페인 오케스트레이션 도구로 추정 — herdr 자체의 구현은 로컬에 없어 **미확인**.

## 5. 스킬 생태계 실측

`skills/` 디렉터리: 총 1464개 서브디렉터리, `SKILL.md` 존재 1460개(4개는 비어있거나 다른 구조로 추정, 미확인).
(로컬 실측) `find … -maxdepth 2 -iname SKILL.md | wc -l` = 1460 vs `ls -d */ | wc -l` = 1464.

**프론트매터 필드(YAML)** — 샘플 20개 + 전체 grep 통계로 확인된 실제 키: `name`, `id`, `description`, `category`,
`risk`, `source`, `source_repo`, `source_type`, `author`, `date_added`, `tags`(리스트), `tools`(리스트),
`license`/`license_source`, `homepage`, `docs`, `metadata`(인라인 JSON), `version`. 파일마다 부분집합만 사용 —
공통 표준 스키마 강제는 없어 보임(미확인: 검증 스크립트 존재 여부).

- **`risk` 값 분포** (전체 grep, 1460개 중): `unknown` 720, `safe` 551, `critical` 136, `none` 26, `offensive` 25
  (+ 인용부호 변형 소수). (로컬 실측) `grep -h "^risk:" */SKILL.md | sort | uniq -c`. `offensive` 는 침투테스트류
  (`active-directory-attacks/SKILL.md:2`, `idor-testing/SKILL.md:2` — 둘 다 "AUTHORIZED USE ONLY" 배너 포함,
  `:8`/`:8`), `critical` 은 금전/통신 API 등 (`agentphone/SKILL.md:6` — 전화/SMS/과금 API).
- **`source` 값**: 대부분 `community`(1176) 또는 `personal`(29), 그 외 `self`/`original`/`official`, 또는 **URL 자체가
  값**(예: `claude-api/SKILL.md:9` — `source: "https://github.com/anthropics/skills"`, 커뮤니티 저장소
  `vibeship-spawner-skills (Apache 2.0)` 55개, `Dimillian/Skills (MIT)` 14개). `personal` 예: `00-andruia-consultant/SKILL.md:7`
  (스페인어 컨설턴트 페르소나), `10-andruia-skill-smith/SKILL.md:7`.
- **`tools:` 크로스툴 호환 목록** — 165개 파일에 존재. 토큰 빈도(전체): `claude` 95, `cursor` 93, `gemini` 68, `codex` 46,
  `antigravity` 24, `windsurf` 10, `copilot` 9, `codex-cli` 8, `gemini-cli`/`claude-code` 6/6, 기타(`cline`, `opencode`,
  `pipecat`, `mistral`, `llama`, `grok` 등) 1~2개씩. 예: `007/SKILL.md:9-15` — `tools: [claude-code, antigravity, cursor,
  gemini-cli, codex-cli]` (보안 감사 스킬); `ilya-sutskever/SKILL.md:8-14`·`warren-buffett/SKILL.md:8-14` — 동일 5종
  목록(페르소나 스킬, `author: renat`); `skill-audit/SKILL.md:11` — `tools: [claude, cursor, codex, gemini, copilot]`
  (약칭 네이밍, `-code`/`-cli` 접미사 없음). 주의: **컨벤션이 통일돼 있지 않다** — 일부는 CLI 식별자(`claude-code`,
  `codex-cli`, `gemini-cli`), 다수는 약칭(`claude`, `cursor`, `codex`, `gemini`)이고, 표본 중 일부 파일에서는 Claude Code
  고유의 "allowed tool/MCP 이름" 의미로 같은 키가 오버로드되는 사례도 관측됨(예: `mcp__claude_ai_Figma__*` 형태) — 즉
  "어떤 CLI 에서 쓸 수 있는가"라는 포터빌리티 선언과 "어떤 실행 도구를 호출하는가"라는 권한 선언이 같은 키로 혼용돼
  스키마가 아직 안정화되지 않았다.
- **부속 자산**: `references/` 서브디렉터리 125개, `scripts/` 70개, `assets/` 16개, 셋 다 갖는 디렉터리는 없음(교차
  카운트 결과 `references ∩ scripts` = 39개). 대다수(1460개 중 references/scripts/assets 어느 것도 없는) 스킬은
  `SKILL.md` 단독 파일. 다국어(`humanize-chinese`, 스페인어 andruia 계열, 포르투갈어 renat 계열) 및 다중 언어 SDK
  묶음(`claude-api/` 하위에 `csharp/curl/go/java/php/python/ruby/typescript/shared/` 서브디렉터리, `LICENSE.txt` 포함)도
  존재 — `claude-api` 는 `source: "https://github.com/anthropics/skills"` 로 출처가 명시된 공식 배포 스킬.
- **규모 대비 신뢰성 논의 스킬 자체 존재**: `skill-audit/SKILL.md:9` 설명문 — "7.5% of 14,706 skills are malicious"를
  인용하며 서드파티 스킬 사전 설치 보안 스캐너를 자칭. 즉 이 생태계 자체가 "설치 전 악성 여부 감사"를 필요로 할
  정도로 크고 검증되지 않은 유통망이라는 자기지시적 증거.
- **`date_added` 분포**: 680개가 `2026-02-27` 한 날짜에 집중(대량 일괄 임포트로 추정), 소수가 `2026-03`/`04`/`05`에
  분산 — 스킬 저장소가 한 번의 대량 시딩 이후 개별 추가되는 패턴. (로컬 실측) `grep -h "^date_added:" */SKILL.md | …`.

## 6. 세션 연속성 (`.omo/run-continuation/`)

파일 1개만 존재: `ses_17f513dc9ffehsvHu4eQR3zHdu.json`. 최상위 키: `sessionID`(문자열), `updatedAt`(문자열, 타임스탬프),
`sources`(객체) → `sources.background-task`(객체) → `{state, updatedAt}`. (로컬 실측)
`/opt/workspace/local/sw4kim/opencode/.omo/run-continuation/ses_17f513dc9ffehsvHu4eQR3zHdu.json` (전체 구조, 값은
민감하지 않으나 본문 인용은 생략, 키 구조만 기재). 즉 세션당 파일 1개, "백그라운드 작업" 소스 하나의 상태/갱신시각만
추적하는 최소 스키마 — 다른 `sources.*` 키 종류(예: 다른 백그라운드 작업 유형)가 있는지는 표본 1개로는 **미확인**.

## 7. superpowers 문서 관행 (spec+plan 페어)

`docs/superpowers/{specs,plans}/` 에 같은 날짜·같은 주제로 spec 1개 + plan 1개가 페어로 존재 — 이번 설정에는 두 페어:
`2026-06-01-opencode-model-routing-{design.md(spec)/*.md(plan)}`, `2026-06-01-gateway-flash-routing-{design/plan}`.
- **spec**(`*-design.md`): 목표(Goals)·설계 세부(변경할 파일별 diff 의도)·(두 번째 스펙엔) mermaid 아키텍처 다이어그램·
  검증 계획(`jq`/`opencode debug paths`)까지 포함. (로컬 실측)
  `/opt/workspace/local/sw4kim/opencode/docs/superpowers/specs/2026-06-01-gateway-flash-routing-design.md:10-22` (mermaid 그래프),
  `:62-65` (검증 계획).
- **plan**(파일 상단에 고정 문구): `> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
  (recommended) or superpowers:executing-plans …`. (로컬 실측)
  `/opt/workspace/local/sw4kim/opencode/docs/superpowers/plans/2026-06-01-opencode-model-routing.md:3`,
  동일 문구 `2026-06-01-gateway-flash-routing.md:3`. Task 단위로 분해되고 각 Step 은 체크박스(`- [ ]`) + 실행할 명령
  + "Expected:" 절로 구성 — 실행형 러너(다른 에이전트/스킬)가 그대로 소비할 수 있는 형식.
- 두 번째 페어(gateway-flash-routing)는 첫 페어(model-routing) 이후의 **정책 롤백/조정**임이 문면에서 드러난다 —
  plan 내 각 Step 에 "(Note: This is already done, but kept here for validation and completeness)" 라는 문구가
  반복돼(`2026-06-01-gateway-flash-routing.md:40, 51`), 실제 설정 변경이 이미 별도 경로로 적용된 뒤 문서만 사후
  정합화한 것으로 보인다 — 즉 이 프로젝트에서 spec/plan 문서가 항상 "실행 전 계획"으로만 쓰이는 것은 아니고, 사후
  기록/검증 문서로도 재사용됨.
- 두 개의 실제 설정 변경 결과가 현재 `opencode.json`/`oh-my-openagent.json`/`agents/orchestrator.md` 파일들과 일치하는지
  대조: `orchestrator.md` 의 "단순 작업은 직접 처리, 복잡한 것만 위임" 가이드라인(§3.3 인용) 은 plan의
  Task 3 변경사항과 표현이 거의 동일 — (로컬 실측) `agents/orchestrator.md:41-42` vs
  `docs/superpowers/plans/2026-06-01-gateway-flash-routing.md:70-71` — 실제로 적용됐음을 확인.

## 8. 불확실/미확인

- opencode 코어의 실제 구현 언어/런타임(코어가 Go 인지, TypeScript+Bun 인지, 둘의 경계가 어디인지) — 로컬에는
  npm 패키지(`@opencode-ai/plugin`, `@opencode-ai/sdk`, 둘 다 TS 빌드 산출물)만 있고 코어 바이너리 자체는 이 디렉터리에
  없음. **미확인 (로컬 자료로 검증 불가)**. 다만 "TUI 프로세스"와 "SDK client/server 모듈 분리"는 §2에서 로컬 실측으로
  확인됨.
  - `(공개 자료/일반 지식 기준(미검증))`: opencode(sst) 는 공개적으로 Go 로 작성된 TUI(Bubble Tea 계열) + TypeScript/Bun
    서버 코어의 클라이언트-서버 아키텍처로 알려져 있음 — 이 문서의 로컬 실측(§2의 client/server export 분리, 별도
    tui plugin 슬롯)과 방향은 일치하나가, 정확한 언어 배정은 이 로컬 디렉터리만으로는 검증할 수 없음.
- `HERDR_*` 환경변수를 세팅하는 "herdr" 본체(대시보드 프로세스)의 구현/UI — 로컬에 코드 없음. **미확인**.
- `oh-my-openagent` npm 패키지 본체(카테고리→모델 매핑을 실제로 어떻게 호출부에서 태깅하는지, agents 10개가 서로를
  어떻게 호출/체이닝하는지의 런타임 로직) — `node_modules/` 에 설치돼 있지 않아 설정 파일 표면만 보임. **미확인**.
- `plugins/*.js` 가 `plugin` 배열에 이름이 없는데도 로드되는 메커니즘(디렉터리 스캔 여부, 파일명 규칙) — **미확인**.
- `agents/*.md` 의 bash 패턴 매칭 우선순위(구체적 패턴 vs `"*"` 의 evaluation 순서) — **미확인**.
- `.bkit/audit/*.jsonl`, `.antigravitycli/` 디렉터리는 존재를 확인했으나 본 조사 범위 밖이라 내용 미열람 — **미확인**.
