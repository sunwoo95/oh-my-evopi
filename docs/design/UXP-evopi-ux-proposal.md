# UXP — evopi UX 개선 제안서 (2026-09-07)

> 입력: `docs/analysis/evopi-ux-gap-analysis.md`(G1-G6), `docs/analysis/opencode-oh-my-openagent-arch.md`,
> `docs/analysis/harness-comparison.md`(6자 매트릭스), `docs/design/NEXT-STEPS.md`(트랙 A/D). 대상 4개 제안은
> gap 분석의 G1+G2+G3(결합), G4, G6 을 그대로 승계 — 아키텍처 변경이 아니라 **표현/설정 계층 추가**로 범위를 좁힌다.
> G5(패키지명 익스텐션 설치)는 공급망 신뢰 문제를 새로 열어 이번 3-5개에서 제외, v2 백로그로만 기록.
> (2026-09-07 추가) 사용자 지시로 CLI 실행 중 상호작용 UX 도 범위에 포함 — G6/제안 4 는 설정 표면이 아니라
> **승인 프롬프트 자체**를 다룬다.
> 프로토타입: `docs/design/UXP-evopi-ux-proposal.md`(본 문서) + 아래 Artifact(4화면, 정적 HTML). 실제 코드 구현은
> 이 사이클의 범위가 아니다.

## 제안 1 — 서브에이전트 역할 프리셋 (G2 + G1)

**현재 UX**: 서브에이전트는 커널에서 `rlm.run(prompt, isolated=...)` 즉석 호출로만 존재한다
(evopi-runtime/src/rlm/__init__.py:96). 역할·모델·권한이 어디에도 선언돼 있지 않아 "이 프로젝트에 어떤
서브에이전트가 있는가"라는 질문에 파일 하나로 답할 수 없다. 권한은 툴 이름 단위(`approval.toolTiers[toolName]`,
permission-gate.ts:618-641)와 전역 정규식 화이트리스트(`permissionGate.allow[]`, :739-747)뿐이라, 서브에이전트마다
다른 명령 정책("리뷰어는 git diff/log 만 자동, 나머지 차단" 같은)을 표현할 자리가 없다.

**제안 UX**: `.evopi/agent/subagents/<name>.md` 프론트매터로 역할을 선언한다 — `model`(+`fallback[]`),
`permission.bash`(글롭 패턴 → `auto/ask/deny`, opencode `agents/*.md` 문법과 유사하게), `permission.edit`
(auto/ask/deny). `rlm.run(role="reviewer", prompt=...)` 가 이 프리셋을 로드해 모델·패턴 맵을 적용한다. 선언이
없으면 지금과 완전히 동일하게 동작(하위호환, opt-in). `/subagents` 슬래시로 현재 선언된 역할 목록을 나열.

**근거**: opencode-oh-my-openagent-arch.md §3.1(10-에이전트 개별 모델+폴백), §3.3(bash 글롭 패턴 3단계,
coder<researcher<reviewer 강도 차이) — 실측, 저장소 외부. evopi 측 실행 경로는 이미 존재
(`_createInlineRlmSubagentRuntime`, agent-session.ts:9510) — 이 제안은 새 실행 경로가 아니라 **그 위에 얹는
선언 계층**.

**예상 범위/비용**: 중. 신규: 프론트매터 파서(스킬 로더의 `loadSkillsFromDir` 패턴 재사용 가능, skills.ts:275
참조 구조), `rlm.run` 의 `role` 커워드가 프리셋을 `classifyToolCall`(permission-gate.ts:618)의 `toolTiers` 대신
패턴 맵으로 라우팅하도록 하는 분기, `/subagents` 슬래시 1개. 기존 `agent-loop`/`AgentSession` 골격 무수정 —
`sdk.ts:288-345`의 `streamFn` 클로저에 프리셋의 model/fallback 만 끼워 넣으면 된다(D3/D7 원칙과 동일한 seam).

**리스크**: 프론트매터 패턴 맵과 기존 `permissionGate.allow[]`/`toolTiers` 3개 소스가 동시에 존재하게 되므로
우선순위 해석 규칙을 명확히 문서화해야 함(안 그러면 opencode 의 "bash 패턴 매칭 우선순위 미확인" 문제를 그대로
재현). evo-off 무영향 원칙은 이 기능이 evo 게이트와 무관하므로 자동 충족.

## 제안 2 — 모델/카테고리 라우팅 설정 뷰 (G3)

**현재 UX**: 모델 연결 인프라(카탈로그, auth-pool 크리덴셜 로테이션, dialect 11종, Databricks 캐시)는 이미
opencode+oh-my-openagent 보다 기능이 많지만, "역할 A 에는 모델 X, 실패하면 Y" 를 사람이 **읽고 고치는 표면**이
없다 — 능력은 있는데 그 능력을 겨냥할 조준경이 없는 상태.

**제안 UX**: 제안 1의 `.evopi/agent/subagents/<name>.md` 프론트매터의 `model`/`fallback[]` 필드가 이미 이
표면의 절반이다. 여기에 opencode 의 "카테고리(작업 성격)" 축처럼, 역할과 무관하게 **작업 성격**(예: `quick`,
`deep`)별 기본 모델+폴백을 정하는 선택적 최상위 설정(`~/.evopi/agent/model-routing.json` 또는 기존
`settings.json` 의 `modelRouting.<category>` 키) 을 추가하고, `/model routing` 슬래시로 현재 표를 그대로
출력한다(설정 파일을 그대로 pretty-print — 새 저장소를 만들지 않음).

**근거**: opencode-oh-my-openagent-arch.md §3.2(8-카테고리 라우팅+폴백 표, `oh-my-openagent.json:58-114`) — 이
축이 에이전트 축과 완전히 분리돼 있다는 설계 자체가 evopi 에 없는 "표현"이다. evopi 측 재사용 대상:
`ModelRegistry`(model-registry.ts:463), `auth-pool`(env.ts:34, pool.ts:47).

**예상 범위/비용**: 중. 새 인프라 없음 — 기존 카탈로그/풀에 라우팅 룰(역할/카테고리 → 모델 이름) 매핑 테이블
하나와 그걸 읽는 조회 함수, 그리고 `/model routing` 뷰만 추가. evo 게이트 뒤에 둘지 여부는 선택(안전하게는
게이트 뒤, D7 원칙 유지).

**리스크**: 카테고리 판정(어떤 호출이 어느 카테고리인지 태깅하는 로직)을 opencode 조사에서도 "미확인"으로
남겼듯, 이 축은 판정 로직 없이 "역할이 명시하면 그 카테고리" 정도로 단순하게 시작해야 한다 — oh-my-openagent
수준의 자동 태깅을 처음부터 목표하면 범위가 커진다(v2로 이연 권고).

## 제안 3 — 스킬 프론트매터 확장 + 브라우저 (G4)

**현재 UX**: 번들 스킬 16개의 프론트매터는 `name`+`description` 두 필드뿐(실측: agent-message, agent-observe,
attach-image, compact, edit, goal, linear, notion, prime-intellect 등 SKILL.md 1-3행 전부 동일 패턴). 위험도·
출처·다른 CLI 호환 여부를 선언할 자리가 없어, 프로젝트 스킬을 추가하는 사용자도 그런 메타데이터를 남길 표준이
없다.

**제안 UX**: 프론트매터에 선택적 필드 3개만 추가 — `risk`(safe/unknown/critical, opencode 값 재사용),
`source`(bundled/project/community), `tags`(리스트). `tools:` 크로스-CLI 호환 필드는 **문서화 목적으로만**
프로젝트 스킬에 한해 허용(실제 로딩 기능은 만들지 않음 — opencode 조사에서도 이 필드의 의미가 파일마다 혼용돼
불안정함을 확인했으므로, evopi 는 처음부터 "포터빌리티 선언"이라는 단일 의미로 좁혀 문서에 명시). `/skills` 슬래시
가 목록을 risk/source 컬럼과 함께 표로 출력.

**근거**: opencode-oh-my-openagent-arch.md §5 — risk 값 분포(unknown 720/safe 551/critical 136/기타), `tools:`
165개 파일·컨벤션 불안정성, 자기감사 스킬(`skill-audit`) 존재 자체가 "메타데이터 없이 스킬을 늘리면 신뢰 문제가
생긴다"는 반증. evopi 는 규모를 좇지 않고(16개 유지) 메타데이터만 선행 도입해 그 실수를 피한다.

**예상 범위/비용**: 낮음. `skills.ts:loadSkillsFromDir`(:275) 프론트매터 파서에 optional 필드 3개 추가, 번들
16개 스킬에 `risk: safe`(전부 evopi 자체 스킬이므로) + `source: bundled` 채움, `/skills` 뷰 1개.

**리스크**: 거의 없음 — 순수 부가 필드, 하위호환. 유일한 주의점은 필드 의미를 문서(`docs/`)에 못박아 opencode
처럼 `tools:` 의미가 표류하지 않게 하는 것.

## 제안 4 — 승인 프롬프트 diff 미리보기 + 인라인 "항상 허용" (G6)

**현재 UX**: write/exec-tier 나 hazard 승인이 필요할 때(`policy === "ask"`), TUI 는 원문 명령/편집 텍스트를
truncate 해서 보여주고 `ctx.ui.select(prompt, ["No", "Yes"])` 로 이진 선택만 받는다(permission-gate.ts:851-854).
`select()` 시그니처가 `options: string[]` 뿐이라(extensions/types.ts:116) "이번만 허용"과 "이 패턴은 항상 허용"을
구분할 자리가 없다 — 매번 승인해도 같은 명령이 다음 턴에 다시 물어본다. 결정을 영구화하려면 대화를 멈추고
`~/.evopi/agent/settings.json` 을 직접 열어 고치는 수밖에 없다.

**제안 UX**: (a) `ctx.ui.select` 호출부의 텍스트 구성을 원문 truncate 대신 이미 존재하는 `renderDiff`
(components/diff.ts:80)로 바꿔, 실행 결과 화면(`ipython-cell.ts:677-717` 등)과 동일한 리치 diff 를 승인 **전**에
보여준다. (b) 옵션 배열에 세 번째 선택지 `"Always allow this pattern"` 을 추가 — 선택 시 해당 명령/편집 패턴을
`permissionGate.allow[]`(현재) 또는 제안 1의 명령 패턴 맵(구현되면)에 append 하고 설정 파일에 즉시 반영한다.
새 UI 컴포넌트는 필요 없다 — 기존 `ctx.ui.select` 그대로 옵션만 3개로 늘리는 것.

**근거**: 비교 대상 툴 조사가 필요 없는, evopi 자체 코드 안의 능력-사용 불일치 — diff 렌더러는 있는데 승인
직전(가장 필요한 순간)에는 안 쓰인다(`evopi-ux-gap-analysis.md` §6). G1(명령 패턴 세분화)이 나중에 들어와도,
프롬프트에서 즉시 그 결과를 만들 경로가 없으면 세분화 자체를 발견·수정하는 길은 여전히 파일 편집뿐이다 — G1 은
"무엇을 세분화할 수 있는가", G6/제안 4 는 "그 세분화를 프롬프트에서 바로 만들 수 있는가"로 층위가 다르다.

**예상 범위/비용**: 낮음. `permission-gate.ts:851-854`의 프롬프트 텍스트 조립부를 `renderDiff` 호출로 교체(write
경로에 한정, exec/hazard 는 명령 텍스트라 diff 대상이 아니므로 그대로 truncate 유지), `select()` 옵션 배열에
문자열 1개 추가 + 선택 시 `permissionGate.allow[]` append 로직(설정 매니저에 이미 있는 쓰기 경로 재사용,
settings-manager.ts). 새 인프라·새 훅 이벤트 불필요.

**리스크**: "항상 허용"이 패턴을 지나치게 넓게(예: 명령 전체를 그대로 정규식화) 만들면 D5 승인 티어의 취지를
약화시킬 수 있음 — 패턴 생성 시 프리픽스만 취하는 등 최소 일반화 규칙을 정해야 함. exec-tier 승인에는 diff 가
없으므로 (a)는 write-tier 전용으로 범위를 좁혀야 한다(hazard 명령까지 diff 를 억지로 씌우면 오히려 정보가
왜곡됨). evo-off 무영향 원칙과는 무관 — permission-gate 는 evo 게이트 밖의 컴포넌트.

## 제외 항목 (v2 백로그)

- **G5 확장 배포 UX**(패키지명 설치) — 공급망 신뢰 경계를 새로 여는 문제라 이번 3개보다 비용·리스크가 크다.
  `docs/design/NEXT-STEPS.md` 트랙 D 후속 후보로만 기록.

## 트랙 A/D 연계

제안 1의 명령 패턴 맵은 **D5(승인 티어, NS Phase M24)의 자연스러운 v2 확장**이다 — D5 가 이미
`read/write/exec × hazard` 축과 프리셋(`dev/strict/yolo`)을 만들어놓았으므로, 이번 제안은 "프리셋을 서브에이전트
별로 다르게 가질 수 있게" 하는 다음 단계다. 제안 1/2 모두 D2(steering 미러링, agent-session.ts 무수정 seam)와
같은 패턴 — prime 골격을 건드리지 않고 표현 계층만 추가하는 이식 방식을 그대로 따른다.

## 프로토타입

`docs/design/UXP-evopi-ux-proposal.md`(본 문서)와 짝을 이루는 정적 HTML 프로토타입 4화면 — (a) 서브에이전트
역할 프리셋 + 명령 패턴 권한(제안 1), (b) 모델/카테고리 라우팅 뷰(제안 2), (c) 스킬 브라우저(제안 3), (d) 승인
프롬프트 diff 미리보기 + "Always allow this pattern"(제안 4). 파일: `docs/design/uxp-prototype.html`(로컬).
Artifact 발행은 이 세션 인증 방식(ANTHROPIC_AUTH_TOKEN) 제약으로 보류 — `DECISIONS.md` [폴백] 참조.

- Artifact: (발행 보류 — 로컬 HTML 로 대체)
