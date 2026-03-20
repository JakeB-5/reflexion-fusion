# Reflexion-Fusion

## 개요

Skill-Creator + Reflexion 융합 Claude Code 플러그인입니다.

자동 패턴 감지 → 스킬 생성 → 블라인드 평가 → 승인 배포 전 과정을 하나의 시스템으로 통합합니다.

### 핵심 원칙

- **품질 우선**: 블라인드 평가 게이트를 통과한 스킬만 배포 대상이 됩니다.
- **사용자 승인 필수**: 자동 배포 없음. 모든 배포는 사용자가 `/suggest`로 직접 승인합니다.
- **비차단 훅**: 모든 훅은 오류 발생 시에도 `exit 0`으로 종료되며 Claude 동작을 방해하지 않습니다.
- **프라이버시 기본**: 로컬 임베딩, 경로/숫자/문자열 정규화로 민감 정보를 보호합니다.

---

## 설치

### Plugin 방식 (권장)

```bash
claude plugin add ~/projects/reflexion-fusion
```

### Fallback 방식 (settings.json 직접 등록)

```bash
node bin/install.mjs
```

### 제거

```bash
# 훅 제거 (데이터 보존)
node bin/install.mjs --uninstall

# 완전 제거 (훅 + 데이터 모두 삭제)
node bin/install.mjs --uninstall --purge
```

---

## 사용법

### `/suggest` — 제안 확인 및 승인 (PRIMARY UI)

자동 감지된 스킬 제안 목록을 확인하고 배포를 승인합니다.

```
/suggest
```

- 대기 중인 스킬 제안을 번호 목록으로 표시합니다.
- 각 제안에는 평가 결과(pass / improve / fail)와 소스 패턴이 표시됩니다.
- 번호를 입력해 승인하면 즉시 `~/.claude/commands/`에 배포됩니다.

### `/evaluate` — 온디맨드 블라인드 평가

특정 스킬을 즉시 평가합니다. Stage 2 AI 평가를 수동으로 트리거합니다.

```
/evaluate <skill-name>
```

- Stage 1 (구조 검증) → Stage 2 (블라인드 AI 채점) 순서로 실행됩니다.
- 일일 평가 한도: 프로젝트당 5회 (비용 제어).

### `/fusion-status` — 시스템 상태

현재 시스템 상태와 통계를 확인합니다.

```
/fusion-status
```

- 수집된 이벤트 수, 대기 중인 제안, 최근 배포 이력을 표시합니다.
- 임베딩 서버 상태와 DB 경로도 함께 확인할 수 있습니다.

---

## 아키텍처

```
[Claude Code 훅]
      │ (UserPromptSubmit, PostToolUse, PostToolUseFailure, SessionEnd, ...)
      ▼
[SQLite DB — ~/.reflexion-fusion/data/reflexion-fusion.db]
      │
      ▼
[Batch Analyzer — session 종료 후 백그라운드 실행]
      │
      ▼ 패턴 감지
      │
  ┌───┴────────────────────┐
  ▼                        ▼
[SKILL.md 생성기]    [CLAUDE.md 규칙 생성기]
  │
  ▼
[Stage 1: 로컬 구조 검증]       ← 무비용, 동기
  │ 통과
  ▼
[Stage 2: 블라인드 AI 평가]     ← 온디맨드, Claude headless
  │ verdict: pass
  ▼
[/suggest → 사용자 승인]
  │ 승인
  ▼
[Auto Deployer → ~/.claude/commands/<skill>.md]
```

### 2단계 게이트

| 단계 | 실행 시점 | 비용 | 내용 |
|------|-----------|------|------|
| Stage 1 | 생성 직후, 로컬 | 무료 | 구조 검증, 필수 필드, 설명 품질, 중복 탐지 |
| Stage 2 | `/evaluate` 또는 `/suggest` 시 온디맨드 | AI 토큰 | 블라인드 채점, 기준선 비교, 종합 판정 |

### 훅 이벤트 매핑

| 이벤트 | 훅 스크립트 | 용도 |
|--------|------------|------|
| `UserPromptSubmit` | `prompt-logger.mjs` | 프롬프트 수집 + 스킬 매칭 |
| `PostToolUse` | `tool-logger.mjs` | 도구 사용 패턴 수집 |
| `PostToolUseFailure` | `error-logger.mjs` | 오류 수집 + KB 검색 |
| `PreToolUse` | `pre-tool-guide.mjs` | 파일별 오류 이력 주입 |
| `SubagentStart` | `subagent-context.mjs` | 오류 패턴 + AI 규칙 주입 |
| `SubagentStop` | `subagent-tracker.mjs` | 에이전트 성능 추적 |
| `SessionEnd` | `session-summary.mjs` | 세션 요약 + 배치 분석 트리거 |
| `SessionStart` | `session-analyzer.mjs` | 캐시 주입 + 데몬 시작 |

---

## 기술 스택

| 구성 요소 | 기술 |
|-----------|------|
| 런타임 | Node.js >= 18, ES Modules (`.mjs`) |
| 저장소 | SQLite (`better-sqlite3`) + `sqlite-vec` (384차원 벡터), WAL 모드 |
| 분석 | Claude headless mode (`claude --print --model sonnet`) |
| 임베딩 | `@xenova/transformers` + `paraphrase-multilingual-MiniLM-L12-v2` (384차원, 오프라인) |
| 플러그인 형식 | Claude Code plugin (`.claude-plugin/plugin.json` + `hooks/hooks.json`) |

### 외부 의존성 (3개 고정)

```
better-sqlite3   — SQLite 바인딩
sqlite-vec       — 벡터 확장
@xenova/transformers — 로컬 임베딩
```

---

## 파일 시스템 레이아웃

```
~/.reflexion-fusion/
├── config.json                    # 시스템 설정 (enabled, retentionDays, analysisModel)
├── data/
│   └── reflexion-fusion.db        # SQLite DB (events, error_kb, feedback, ...)
├── hooks/                         # 8개 훅 스크립트
│   ├── prompt-logger.mjs
│   ├── tool-logger.mjs
│   ├── error-logger.mjs
│   ├── pre-tool-guide.mjs
│   ├── subagent-context.mjs
│   ├── subagent-tracker.mjs
│   ├── session-summary.mjs
│   └── session-analyzer.mjs
└── hooks/auto/                    # 자동 생성 훅 워크플로 (apply.mjs가 동적 생성)
```

---

## 개발

### 테스트 실행

```bash
# Node 22 권장 (v24는 better-sqlite3 빌드 문제)
nvm use 22

# 의존성 설치
npm install

# 전체 테스트 실행
npm test

# 커버리지 포함
npm run test:coverage
```

### 테스트 구조

```
tests/
├── unit/            # 모듈별 단위 테스트 (in-memory DB 사용)
├── integration/     # 모듈 간 통합 테스트
└── e2e/             # 전체 라이프사이클 테스트 (AI 호출 모킹)
```

### 코드 컨벤션

- 코드 주석: 영어
- 사용자 커뮤니케이션: 한국어
- 커밋 메시지: 영어 (Conventional Commits)
- 모든 훅: `try-catch + process.exit(0)` 필수
- 훅 내 동기 AI 호출 금지 (백그라운드 `spawn`만 허용)

---

## 라이선스

MIT
