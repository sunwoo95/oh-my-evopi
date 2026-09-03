# Claude Code 전체 아키텍처 맵 (사용자 제공 슬라이드, 2026-09-03)

> 원제: "전체 아키텍처 맵 — Master Agent Loop을 중심으로 한 여덟 개 레이어".
> 사용자가 채팅으로 제공한 PNG를 텍스트로 전사. Claude Code 비교 분석의 정본 레이아웃.

## 중심
- **Master Agent Loop** — "Gather - Act - Verify". 하단 라벨 "Claude 모델 + 도구".

## 레이어 (박스 · 부제)
| 레이어 | 박스 | 부제 |
|---|---|---|
| INPUT LAYER | User Interface | CLI/IDE/CI-CD |
| | Session Mgr | Resume/Fork |
| | Permission | Ask/Allow/Deny |
| OBSERVABILITY | Hooks | lifecycle |
| | Background | non-block |
| MULTI-AGENT | Subagents | isolated ctx |
| | Worktrees | parallel |
| KNOWLEDGE LAYER | CLAUDE.md | always on |
| | Auto Memory | MEMORY.md |
| | Skills | on-demand |
| | Context Win | compaction |
| EXECUTION LAYER | Tool Dispatch | typed registry |
| | Prompt Cache | ~10% cost |
| | Streaming | real-time |
| INTEGRATION | MCP Runtime | auto-discover |
| | Ext Servers | FS/Git/Custom |
| OUTPUT LAYER | Task Result | Verified output / Memory updated |

## 엣지
- Input → Loop: `request`
- Observability/Multi-agent ↔ Loop: `observe/spawn`
- Knowledge → Loop: `feeds`
- Loop → Execution: `execute`
- Execution → Integration → Output: `register / result`

## 시각 스타일
- 다크 배경(#0f1115 계열), 레이어 = 둥근 사각 컨테이너(회색 테두리), 레이어 제목 = 오렌지 소문자 캡션,
  중심 루프 박스와 Output 박스 = 오렌지 테두리 강조, 화살표 오렌지(주 경로)/회색(보조).
