# Fusion Plugin Implementation Plan (v2)

> Skill-Creator + Reflexion 통합 Claude Code 플러그인
> Consensus: Planner v2 (Architect + Critic 피드백 반영)

## RALPLAN-DR Summary

### Principles (5)
1. **Quality Over Quantity** — 나쁜 스킬 10개보다 좋은 스킬 1개가 낫다. 모든 자동 생성 스킬은 블라인드 평가를 통과해야 배포. **사용자 승인 없이 스킬/규칙/Hook을 자동 적용하지 않는다(SHALL NOT)** — Reflexion constitution 준수
2. **Non-Blocking Hooks** — Hook은 절대로 사용자 작업을 방해하지 않는다. exit 0 보장, 5s/10s timeout 엄수, 동기 AI 호출 금지
3. **DB-Mediated Async** — Hook과 Agent 간 통신은 반드시 SQLite DB를 통한 비동기. 직접 호출 없음, 느슨한 결합
4. **Adaptive Plugin Architecture** — 플러그인 규격 우선, 미확인 시 settings.json 직접 편집 방식(Reflexion 현행)으로 fallback. 어느 쪽이든 사용자 경험 일관성 유지
5. **Privacy by Default** — 로컬 임베딩(오프라인), 경로/숫자/문자열 정규화, `<private>` 태그 제거. 데이터가 외부로 나가지 않음

### Decision Drivers (Top 3)
1. **아키텍처 통합성** — Hook 기반 데이터 수집 + Agent 기반 평가를 하나의 일관된 패키지로 결합해야 함
2. **평가 품질** — Skill-Creator의 Grader/Comparator/Analyzer 에이전트 패턴을 정확히 재현해야 블라인드 비교 50%+ 승률 달성 가능
3. **배포 안전성** — 자동 생성된 스킬/규칙/Hook이 기존 Claude Code 설정을 훼손하지 않아야 하며, 배포 전 반드시 사용자 승인 필요

### Viable Options (3)

#### Option A: Monolithic Plugin (선택)
**Approach:** 단일 플러그인 패키지에 hooks, skills, agents, lib, MCP server를 모두 포함. 플러그인 규격이 미확인 시 install.mjs fallback 포함.

**Pros:**
- 설치가 단순 (플러그인 지원 시 `claude plugin add` 한 번, 미지원 시 `node install.mjs`)
- 모든 컴포넌트가 동일한 node_modules 공유
- Hook 등록, skill 제공, MCP 서버를 일괄 관리

**Cons:**
- 패키지 크기가 커질 수 있음 (sqlite-vec, transformers.js)
- 업데이트 시 전체 재배포
- 플러그인 규격이 기대와 다를 경우 fallback 경로 필요

#### Option B: Core + Satellite 패키지
**Approach:** npm 코어 패키지(DB, 분석, 평가 로직) + 플러그인 래퍼(hooks, skills)를 분리

**Pros:**
- 코어 로직 독립 테스트 및 재사용 가능
- 독립적 배포 주기 (코어 업데이트가 플러그인 재배포 불필요)
- 테스트 격리 용이 (코어만 단위 테스트)

**Cons:**
- 설치 복잡도 증가 (npm install + plugin add 2단계)
- 코어↔플러그인 간 버전 동기화 문제
- 사용자가 원한 "플러그인 한 번 설치" 경험과 충돌
- 코어와 플러그인 간 경로 참조가 복잡해짐

**기각 근거:** 사용자가 Deep Interview R1에서 "새로운 통합 제품"을, R5에서 "플러그인 설치"를 선택. 설치 복잡도와 버전 동기화 비용이 테스트 격리 이점을 상회함. 단, **플러그인 규격이 미지원일 경우 Option B가 유효한 fallback**이 될 수 있으므로 완전 기각이 아닌 조건부 기각.

#### Option C: Reflexion 확장 + Skill-Creator 패턴 차용
**Approach:** 기존 Reflexion 코드베이스에 Skill-Creator의 평가 에이전트 로직을 추가

**Pros:**
- 기존 251개 테스트와 검증된 코드 활용
- 개발 비용 최소

**Cons:**
- Reflexion은 Hook 기반 이벤트 수집 전용 설계. 에이전트 기반 평가는 다른 실행 모델 필요 (동기적 다단계 실행 vs 비동기 단발 훅)
- Reflexion의 `ai-analyzer.mjs`는 단일 Claude headless 호출로 분석. 평가 파이프라인은 Grader→Comparator→Analyzer 다단계 호출 필요
- 기존 3개 의존성 제한 원칙과 충돌 (Deep Interview R2에서 해제됨)
- 코드베이스 복잡도가 기하급수적 증가 (8 hooks + 8 libs + 3 agents + evaluator)

**기각 근거:** Deep Interview R4 (Contrarian Mode)에서 확인 — Hook과 Agent의 실행 모델이 근본적으로 다르며 (비동기 단발 vs 동기 다단계), 기존 코드에 억지로 끼워넣으면 아키텍처 정합성이 깨진다.

---

## Requirements Summary

Deep Interview 스펙 기반 (모호도 17%):
- **새로운 Claude Code 플러그인** (전체 재작성, Reflexion 참조만)
- **DB 기반 비동기 아키텍처** (Hook → SQLite → Batch Analyzer → Agent)
- **Skill-Creator 평가 에이전트** (Grader/Comparator/Analyzer 그대로 차용)
- **3가지 출력** (SKILL.md, CLAUDE.md 규칙, Hook 워크플로우)
- **하이브리드 타이밍** (세션 종료 후 백그라운드 + 온디맨드)
- **새 프로젝트 경로** (Reflexion과 분리)
- **사용자 승인 필수** — 배포 전 반드시 `/suggest` 스킬을 통한 사용자 확인

---

## Milestones

| Milestone | Phases | 목표 | 독립 검증 기준 |
|-----------|--------|------|---------------|
| **v0.1 — 수집 + 분석 + 생성** | Phase 0-3 | 데이터 수집, 패턴 감지, 스킬/규칙/Hook 초안 생성 | 이벤트 DB 기록, 분석 캐시 생성, SKILL.md 초안 출력 |
| **v0.2 — 평가 + 승인 배포** | Phase 4-5 | 2단계 평가 게이트, 사용자 승인 후 배포 | 블라인드 비교 pass, `/suggest`로 승인→배포 동작 |
| **v0.3 — UI + E2E** | Phase 6-8 | 스킬 UI, 전체 E2E | 전체 파이프라인 동작, 80%+ 커버리지 |

---

## Plugin Directory Structure

```
~/projects/reflexion-fusion/          # 새 프로젝트 루트
├── .claude-plugin/
│   └── plugin.json                   # 플러그인 매니페스트 (Phase 0에서 규격 검증)
├── # (.mcp.json 제거됨 — MCP 불필요, 스킬이 PRIMARY UI)
├── hooks/
│   └── hooks.json                    # Hook 등록 정의 (플러그인 규격)
├── bin/
│   └── install.mjs                   # Fallback 설치 스크립트 (settings.json 직접 편집)
├── skills/
│   ├── evaluate/
│   │   └── SKILL.md                  # /evaluate: 온디맨드 스킬 평가 트리거
│   ├── suggest/
│   │   └── SKILL.md                  # /suggest: 제안 확인 + 승인/거부 (PRIMARY UI)
│   └── fusion-status/
│       └── SKILL.md                  # /fusion-status: 시스템 상태 확인
├── agents/
│   ├── grader.md                     # Grader 에이전트 프롬프트
│   ├── comparator.md                 # Comparator 에이전트 프롬프트
│   └── analyzer.md                   # Analyzer 에이전트 프롬프트
├── src/
│   ├── hooks/                        # Hook 스크립트 (8개)
│   │   ├── prompt-logger.mjs
│   │   ├── tool-logger.mjs
│   │   ├── error-logger.mjs
│   │   ├── pre-tool-guide.mjs
│   │   ├── subagent-context.mjs
│   │   ├── subagent-tracker.mjs
│   │   ├── session-summary.mjs
│   │   └── session-analyzer.mjs
│   ├── lib/                          # 코어 라이브러리
│   │   ├── db.mjs                    # SQLite + sqlite-vec + config
│   │   ├── error-kb.mjs             # 에러 KB (정규화, 3단계 검색)
│   │   ├── skill-matcher.mjs        # 스킬-프롬프트 매칭 (벡터+키워드)
│   │   ├── ai-analyzer.mjs          # Claude headless 분석 + 캐시
│   │   ├── skill-generator.mjs      # SKILL.md 생성 (Skill-Creator 포맷)
│   │   ├── skill-validator.mjs      # 1차 게이트: 로컬 구조 검증 (무비용)
│   │   ├── evaluator.mjs            # 2차 게이트: 평가 오케스트레이터 (유비용)
│   │   ├── auto-deployer.mjs        # 승인된 스킬/규칙/Hook 배포
│   │   ├── feedback-tracker.mjs     # 피드백 추적
│   │   ├── embedding-server.mjs     # 임베딩 데몬 (Unix socket)
│   │   ├── embedding-client.mjs     # 임베딩 클라이언트
│   │   └── batch-embeddings.mjs     # 배치 임베딩 프로세서
│   ├── prompts/                      # AI 프롬프트 템플릿
│   │   ├── analyze.md               # 패턴 분석 프롬프트
│   │   └── generate-skill.md        # 스킬 생성 프롬프트
│   # (mcp/ 제거됨 — 스킬이 PRIMARY UI, MCP 불필요)
├── tests/                            # 테스트 (Vitest)
│   ├── unit/
│   │   ├── db.test.mjs
│   │   ├── error-kb.test.mjs
│   │   ├── skill-matcher.test.mjs
│   │   ├── skill-generator.test.mjs
│   │   ├── skill-validator.test.mjs
│   │   ├── evaluator.test.mjs
│   │   ├── auto-deployer.test.mjs
│   │   └── feedback-tracker.test.mjs
│   ├── integration/
│   │   ├── hook-pipeline.test.mjs
│   │   ├── analysis-pipeline.test.mjs
│   │   └── evaluation-pipeline.test.mjs
│   └── e2e/
│       └── full-lifecycle.test.mjs
├── package.json
├── vitest.config.mjs
├── CLAUDE.md
└── README.md
```

---

## DB Schema (v2)

Reflexion v9 스키마를 기반으로 확장. Architect/Critic 피드백 반영.

```sql
-- FK 활성화
PRAGMA foreign_keys = ON;

-- 기존 (Reflexion 계승)
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  v INTEGER DEFAULT 1,
  type TEXT NOT NULL,
  ts TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project TEXT,
  project_path TEXT,
  data JSON NOT NULL
);
-- Indexes: (session_id, ts), (project_path, type, ts), (type, ts)

CREATE TABLE error_kb (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  error_normalized TEXT NOT NULL UNIQUE,
  error_raw TEXT,
  resolution TEXT,
  resolved_by TEXT,
  tool_sequence TEXT,
  use_count INTEGER DEFAULT 0,
  last_used TEXT
);

CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  v INTEGER DEFAULT 1,
  ts TEXT NOT NULL,
  suggestion_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('accepted','rejected','dismissed')),
  suggestion_type TEXT,
  summary TEXT
);

CREATE TABLE analysis_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  project TEXT,
  days INTEGER,
  input_hash TEXT,
  analysis JSON NOT NULL
);
-- Unique: (project, days, input_hash)

CREATE TABLE skill_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  source_path TEXT NOT NULL,
  description TEXT,
  keywords TEXT,
  updated_at TEXT NOT NULL
);

-- FTS5 + vec0
CREATE VIRTUAL TABLE events_fts USING fts5(type, text, content='events', content_rowid='id');
CREATE VIRTUAL TABLE vec_error_kb USING vec0(error_kb_id INTEGER PRIMARY KEY, embedding float[384]);
CREATE VIRTUAL TABLE vec_skill_embeddings USING vec0(skill_id INTEGER PRIMARY KEY, embedding float[384]);

-- 신규: 평가 결과 (v2: status, project_path 추가)
CREATE TABLE evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  v INTEGER DEFAULT 1,
  ts TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  suggestion_id TEXT,
  project_path TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','validating','grading','comparing','analyzing','complete','failed')),
  validation JSON,            -- 1차 게이트: 로컬 구조 검증 결과
  grading JSON,               -- 2차 게이트: Grader 결과
  comparison JSON,             -- 2차 게이트: Comparator 결과
  analysis JSON,               -- 2차 게이트: Analyzer 결과
  overall_verdict TEXT CHECK(overall_verdict IN ('pass','fail','improve')),
  iteration INTEGER DEFAULT 1,
  deployed_at TEXT,
  error_message TEXT           -- 실패 시 에러 메시지
);

-- 신규: 생성된 스킬 이력 (v2: project_path 추가, content→file_path)
CREATE TABLE generated_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  v INTEGER DEFAULT 1,
  ts TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  suggestion_id TEXT,
  project_path TEXT,
  file_path TEXT NOT NULL,     -- SKILL.md 파일 경로 (DB 비대화 방지)
  version INTEGER DEFAULT 1,
  source_patterns JSON,
  evaluation_id INTEGER REFERENCES evaluations(id),
  approved INTEGER DEFAULT 0,  -- 사용자 승인 여부
  deployed INTEGER DEFAULT 0,
  deployed_path TEXT
);

-- 보존 정책: evaluations, generated_skills는 180일 보존
```

---

## Implementation Steps

### Phase 0: Plugin Spec Verification (차단 조건)

> **이 단계를 통과해야만 Phase 1 진행 가능**

**Step 0.1: 플러그인 규격 확인**
- Claude Code 플러그인 API 문서 확인 또는 실제 테스트
- `.claude-plugin/plugin.json` 포맷 검증
- `hooks/hooks.json`의 Hook 자동 등록 지원 여부 확인
- `claude plugin add <path>` 명령어 동작 확인

**Step 0.2: 결과에 따른 경로 선택**

| 결과 | 경로 |
|------|------|
| 플러그인 규격 확인됨 | → Option A 진행 (plugin.json + hooks.json) |
| 플러그인 규격 미확인 / 미지원 | → Fallback: `bin/install.mjs`로 settings.json 직접 편집 (Reflexion 현행 패턴). 스킬은 `~/.claude/commands/`에 직접 복사 |
| 부분 지원 (스킬만 지원, 훅 미지원 등) | → 하이브리드: 지원되는 기능은 플러그인, 나머지는 install.mjs |

**Step 0.3: Fallback install.mjs 작성**
- Reflexion의 `bin/install.mjs` 참조
- `~/.claude/settings.json`에 8개 Hook 등록 (중첩 객체 구조 정확히 준수)
- 기존 Reflexion Hook과의 충돌 감지 + 경고
- `--uninstall`, `--purge` 옵션 제공

**검증:** 최소 1개의 Hook이 실제로 Claude Code에서 트리거되는지 확인

### Phase 1: Project Scaffold & Core Infrastructure (v0.1 시작)

**Step 1.1: 프로젝트 초기화**
- `~/projects/reflexion-fusion/` 디렉토리 생성
- `package.json` (name: `reflexion-fusion`, type: module, engines: node>=18)
- `vitest.config.mjs` 설정
- Phase 0 결과에 따라 플러그인 매니페스트 또는 install.mjs 배치
- `CLAUDE.md` (프로젝트 가이드)

**Step 1.2: DB 모듈 (`src/lib/db.mjs`)**
- Reflexion의 `db.mjs` 로직을 독립적으로 재구현 (copy-paste 아닌 clean-room)
- 테이블 생성 (v2 스키마: events, error_kb, feedback, analysis_cache, skill_embeddings, evaluations, generated_skills)
- `PRAGMA foreign_keys = ON` + vec0/FTS5 초기화
- WAL 모드 + `busy_timeout = 5000` (Reflexion과 동일)
- 분석 race condition 방지: `analysis_lock` 파일 기반 advisory lock
- `readStdin()`, `insertEvent()`, `queryEvents()`, `vectorSearch()` 등 공통 유틸
- DB 크기 관리: `pruneOldData(retentionDays=90, evaluationRetentionDays=180)`

**Step 1.3: 임베딩 시스템 (`src/lib/embedding-*.mjs`)**
- embedding-server.mjs (Unix socket, 384-dim, 30min idle)
- embedding-client.mjs (auto-start, 10s timeout)
- batch-embeddings.mjs (detached background)

**테스트:** `tests/unit/db.test.mjs` — 테이블 생성, CRUD, 벡터 검색, config, advisory lock, pruning

### Phase 2: Data Collection Layer (Hooks)

**Step 2.1: 수집 Hooks (4개, 5s timeout)**
- `prompt-logger.mjs` — UserPromptSubmit: 프롬프트 수집 + 스킬 매칭
- `tool-logger.mjs` — PostToolUse: 도구 사용 기록 + 해결 감지
- `error-logger.mjs` — PostToolUseFailure: 에러 수집 + KB 3단계 검색
- `pre-tool-guide.mjs` — PreToolUse(Edit|Write|Bash|Task): 파일별 에러 히스토리

**Step 2.2: 세션 Hooks (2개, 10s timeout)**
- `session-summary.mjs` — SessionEnd: 세션 요약 + **분석+생성만 트리거** (평가는 트리거하지 않음) + 배치 임베딩
- `session-analyzer.mjs` — SessionStart: 캐시 주입 + 이전 세션 컨텍스트 + 데몬 시작 + **미승인 제안이 있으면 알림**

**Step 2.3: 서브에이전트 Hooks (2개, 5s timeout)**
- `subagent-context.mjs` — SubagentStart: 에러 패턴 + AI 규칙 주입
- `subagent-tracker.mjs` — SubagentStop: 에이전트 성능 추적

**Step 2.4: 보조 라이브러리**
- `error-kb.mjs` — normalizeError, searchErrorKB(3-stage), recordResolution
- `skill-matcher.mjs` — loadSkills, matchSkill(vector+keyword), refreshSkillEmbeddings
- `feedback-tracker.mjs` — recordFeedback, getFeedbackSummary

**테스트:** `tests/unit/error-kb.test.mjs`, `tests/unit/skill-matcher.test.mjs`, `tests/integration/hook-pipeline.test.mjs`

### Phase 3: Analysis & Generation Layer

**Step 3.1: AI 분석기 (`src/lib/ai-analyzer.mjs`)**
- `runAnalysis(options)` — Claude headless (`claude --print --model sonnet`)
- 이벤트 쿼리 → advisory lock 획득 → SHA-256 캐시 확인 → 프롬프트 생성 → 실행 → 결과 캐시 → lock 해제
- `runAnalysisAsync(options)` — detached background spawn (lock 포함)
- `getCachedAnalysis(maxAgeHours, project)` — 캐시 조회
- 분석 트리거 조건: `promptCount >= 5` (기존 3에서 상향)

**Step 3.2: 분석 프롬프트 (`src/prompts/analyze.md`)**
- Reflexion 프롬프트를 참조하되 독립 작성
- 입력: `{{days}}`, `{{project}}`, `{{log_data}}`, `{{feedback_history}}`, `{{existing_skills}}`
- 패턴 감지: 프롬프트 클러스터(3+회), 도구 시퀀스(3+세션), 에러 패턴
- 제안 생성: skill | claude_md | hook (각각 JSON 포맷)
- 품질 게이트: freq >= 3, 기존 스킬과 벡터 유사도 < 0.76이면 중복으로 필터

**Step 3.3: 스킬 생성기 (`src/lib/skill-generator.mjs`)**
- `generateSkill(suggestion)` — Claude headless로 SKILL.md 생성
- `generateClaudeMdRule(suggestion)` — CLAUDE.md 규칙 텍스트 생성
- `generateHookWorkflow(suggestion)` — Hook 워크플로우 코드 생성
- 생성된 파일은 `~/.reflexion-fusion/generated/` 에 저장 (DB에는 file_path만)

**Step 3.4: 스킬 생성 프롬프트 (`src/prompts/generate-skill.md`)**

프롬프트 핵심 구조:
```
## 입력
- suggestion: {type, summary, evidence, action, priority}
- example_prompts: 감지된 반복 프롬프트 원문 (최대 5개)
- example_tools: 감지된 도구 시퀀스 (최대 3개)
- existing_skills: 기존 스킬 목록 (중복 방지)

## 출력 형식
YAML frontmatter (name, description, compatibility) + Markdown body

## 품질 기준
- description은 트리거 조건을 구체적으로 명시 (30-100단어)
- body는 500줄 이하
- Progressive Disclosure: 메타데이터 → body → 참조 리소스
- 실행 가능한 지시사항 (imperative mood)
- "why" 설명 포함
```

**테스트:** `tests/unit/skill-generator.test.mjs`, `tests/integration/analysis-pipeline.test.mjs`

**v0.1 마일스톤 검증:** 이벤트 수집 → DB 기록 → 분석 트리거 → SKILL.md 초안 생성까지 동작

### Phase 4: Evaluation Pipeline (v0.2 시작)

**2단계 게이트 전략 (Architect synthesis 반영)**

#### Stage 1: 로컬 구조 검증 (무비용, 자동)

**Step 4.1: 스킬 검증기 (`src/lib/skill-validator.mjs`)**
- `validateStructure(skillFilePath)` — YAML frontmatter 파싱 성공 여부
- `validateRequiredFields(frontmatter)` — name, description 필수 필드 존재
- `validateDescriptionQuality(description)` — 길이(30-100단어), 트리거 조건 포함 여부
- `validateDuplication(skill, existingSkills)` — 벡터 유사도 < 0.76 (중복 아님 확인)
- `validateBodyLength(body)` — 500줄 이하
- 결과: `{valid: bool, errors: string[], warnings: string[]}`
- **자동 실행**: 스킬 생성 직후 바로 실행. 통과해야 DB에 `evaluations` 레코드 생성

#### Stage 2: Claude headless 평가 (유비용, 온디맨드만)

> **중요: Stage 2는 자동 트리거되지 않음. 사용자가 `/evaluate` 스킬로 명시적으로 요청해야 실행**

**Step 4.2: 에이전트 프롬프트 작성**
- `agents/grader.md` — Skill-Creator 플러그인의 `agents/grader.md` 참조 (캐시된 플러그인 위치: `~/.claude/plugins/cache/claude-plugins-official/skill-creator/`)
  - 스킬 실행 트랜스크립트 판독
  - assertion별 PASS/FAIL 판정 + 근거
  - 출력: grading.json
- `agents/comparator.md` — Skill-Creator 플러그인의 `agents/comparator.md` 참조
  - 블라인드 A/B 비교 (어느 것이 자동 생성인지 모른 채)
  - content + structure 루브릭 (1-5점)
  - 출력: comparison.json
- `agents/analyzer.md` — Skill-Creator 플러그인의 `agents/analyzer.md` 참조
  - 승자 강점 / 패자 약점 분석
  - 구체적 개선 제안 생성
  - 출력: analysis.json

**Step 4.3: 평가 오케스트레이터 (`src/lib/evaluator.mjs`)**
- `evaluateSkill(skillFilePath, options)` — 전체 평가 파이프라인:
  1. `evaluations.status = 'grading'` 업데이트
  2. 테스트 프롬프트 2~3개 자동 생성 (Claude headless 1회)
  3. 생성 스킬 적용/미적용 실행 (Claude headless `--system-prompt`로 SKILL.md 내용 주입)
  4. Grader가 각 실행 결과 판정 → `status = 'comparing'`
  5. Comparator가 두 결과를 블라인드 비교 → `status = 'analyzing'`
  6. 결과에 따라:
     - pass → `status = 'complete'`, `overall_verdict = 'pass'`
     - fail → Analyzer 개선 제안 → 재생성 (최대 3회, 이전 Analyzer 피드백을 generate-skill.md 프롬프트에 주입)
     - 중간 실패 → `status = 'failed'`, `error_message` 기록
- `evaluateOnDemand(skillName)` — 기존 스킬의 온디맨드 평가
- **비용 제한**: 프로젝트당 일 5회 평가 (config에서 조정 가능)
- **비용 추정**: 1 스킬 평가 당 약 50K-100K 토큰 (sonnet 기준, ~$0.15-$0.30)

**Step 4.4: Description 최적화**
- train/test 60/40 분리 (수집된 프롬프트 기반)
- description 변형 → 매칭 정확도 측정 → 최고 성과 선택
- 최대 5회 반복

**테스트:** `tests/unit/skill-validator.test.mjs`, `tests/unit/evaluator.test.mjs`, `tests/integration/evaluation-pipeline.test.mjs`

### Phase 5: User-Approved Deployment

> **핵심 변경: 자동 배포 → 승인 후 배포 (constitution 준수)**

**Step 5.1: 승인 흐름**
```
1. SessionEnd → 분석 + 생성 + Stage 1 검증 (자동)
2. 다음 SessionStart → "N개의 새 제안이 있습니다" 알림
3. 사용자가 /suggest 실행 → 제안 목록 + 미리보기
4. 사용자가 승인 → auto-deployer 실행
5. 사용자가 거부 → feedback 기록, 다시 제안하지 않음
```

**Step 5.2: 배포기 (`src/lib/auto-deployer.mjs`)**
- `deploySkill(skill, scope)` — `~/.claude/commands/<name>.md` 또는 `<project>/.claude/commands/`
- `deployClaudeMdRule(rule, scope)` — 해당 CLAUDE.md에 "## 자동 감지된 규칙" 섹션
- `deployHookWorkflow(hook)` — Hook 코드 파일 + hooks 등록 (settings.json 중첩 객체 구조 준수)
- **모든 배포 전**: 기존 파일 백업 (`.bak`), 이름 충돌 시 접미사 추가
- **자동 롤백 조건**: 배포 후 파일 파싱 실패 시 즉시 `.bak`에서 복원
- `rollback(deploymentId)` — 수동 롤백 (백업에서 복원)

**Step 5.3: 안전장치**
- settings.json 수정 시 `JSON.parse` 검증 후 `fs.writeFileSync` (atomic write 패턴)
- 기존 Reflexion Hook과의 충돌 감지: 동일 이벤트에 `reflexion` 경로 Hook이 등록되어 있으면 경고
- 배포 기록: `generated_skills.approved = 1, deployed = 1, deployed_path = ...`

**테스트:** `tests/unit/auto-deployer.test.mjs`

**v0.2 마일스톤 검증:** `/evaluate`로 평가 실행 → `/suggest`로 승인 → `~/.claude/commands/`에 스킬 설치

### Phase 6: Plugin Skills (v0.3 시작)

**Step 6.1: `/evaluate` 스킬 (`skills/evaluate/SKILL.md`)**
- 온디맨드 스킬 평가 트리거 (Stage 2)
- `$ARGUMENTS`로 스킬 이름 또는 제안 번호 지정
- 평가 결과 + 비용 추정을 사용자에게 보고
- 일일 평가 한도 표시

**Step 6.2: `/suggest` 스킬 (`skills/suggest/SKILL.md`) — PRIMARY UI**
- 미승인 제안 목록 + SKILL.md 미리보기
- 각 제안에 대해: 승인(배포) / 거부(다시 안 봄) / 보류
- Stage 1 통과 여부, Stage 2 평가 결과(있으면) 표시
- 피드백 기록

**Step 6.3: `/fusion-status` 스킬 (`skills/fusion-status/SKILL.md`)**
- 수집된 이벤트 통계
- 최근 분석 결과 요약
- 평가 이력 및 배포된 스킬 목록
- 시스템 건강 상태 (DB 크기, 임베딩 데몬, 캐시 히트율)
- 일일 평가 사용량 / 한도

### ~~Phase 7: MCP Server~~ (제거됨)

> v0.2에서 MCP 서버 제거. 스킬(/suggest, /evaluate, /fusion-status)이 PRIMARY UI이며,
> MCP는 스킬과 100% 기능 중복이므로 불필요한 복잡도로 판단하여 삭제.
> 관련 파일: src/mcp/server.mjs, .mcp.json 삭제 완료.

### Phase 8: E2E Testing & Documentation

**Step 8.1: E2E 테스트**
- `tests/e2e/full-lifecycle.test.mjs`
  - Mock 이벤트 삽입 → 분석 트리거 → 스킬 생성 → Stage 1 검증 → (Stage 2 mock) → 승인 → 배포 전체 흐름
  - 블라인드 비교 시뮬레이션

**Step 8.2: 문서화**
- `README.md` — 설치 (플러그인 / fallback), 사용법, 아키텍처, 비용 안내
- `CLAUDE.md` — 프로젝트 개발 가이드

**v0.3 마일스톤 검증:** 전체 파이프라인 E2E 동작, 80%+ 커버리지

---

## Migration Strategy (Reflexion → Fusion)

### 시나리오 1: Reflexion 미설치 상태
- Fusion 직접 설치. 마이그레이션 불필요.

### 시나리오 2: Reflexion 설치됨 → Fusion으로 전환
1. `node ~/.reflexion/bin/install.mjs --uninstall` (기존 Hook 제거)
2. Fusion 설치 (`claude plugin add` 또는 `node install.mjs`)
3. **DB 마이그레이션 (선택)**: `node bin/migrate.mjs --from ~/.reflexion/data/reflexion.db`
   - events, error_kb, feedback, analysis_cache, skill_embeddings 테이블 복사
   - evaluations, generated_skills는 새로 시작
4. 기존 `~/.reflexion/` 디렉토리는 보존 (사용자가 수동 삭제)

### 시나리오 3: 양쪽 동시 사용
- **지원하지 않음.** 동일 이벤트에 이중 Hook 등록 시 DB 이중 기록, 성능 저하 발생.
- `install.mjs` 및 `/fusion-status`에서 기존 Reflexion Hook 감지 → 충돌 경고 표시.

---

## Acceptance Criteria (Testable, v2)

| # | Criterion | Verification | Milestone |
|---|-----------|-------------|-----------|
| AC-1 | SKILL.md가 YAML frontmatter + markdown 표준 준수 | 파서 테스트: frontmatter 필수 필드 검증 | v0.1 |
| AC-2 | Grader가 실행 트랜스크립트를 읽고 pass/fail 판정 | 통합 테스트: mock 트랜스크립트로 판정 검증 | v0.2 |
| AC-3 | Comparator가 블라인드 비교 수행 | 통합 테스트: A/B 입력 순서 무관 결과 일관성 | v0.2 |
| AC-4 | 블라인드 비교 자동 생성 스킬 50%+ 승률 | E2E 테스트: 5개 스킬 생성/비교, 과반 pass. 비교 대상: Reflexion의 기존 `apply.mjs`가 생성하는 스킬 | v0.3 |
| AC-5 | Description 최적화 (train/test 60/40) | 단위 테스트: 분리 비율 + 최적화 루프 검증 | v0.2 |
| AC-6 | 감지→생성→검증→**승인**→배포 흐름 동작 | E2E 테스트: `/suggest` 승인 후 배포 확인 | v0.3 |
| AC-7 | SessionEnd→SessionStart 분석 주입 | 통합 테스트: 세션 훅 시퀀스 검증 | v0.1 |
| AC-8 | 승인된 스킬이 `~/.claude/commands/`에 설치 | 단위 테스트: 파일 생성 + 내용 검증 | v0.2 |
| AC-9 | CLAUDE.md 규칙이 승인 후 추가 | 단위 테스트: 기존 내용 보존 + 규칙 추가 | v0.2 |
| AC-10 | Hook 워크플로우가 승인 후 등록 | 단위 테스트: settings.json 중첩 구조 업데이트 검증 | v0.2 |
| AC-11 | 3회+ 반복 패턴 감지 | 단위 테스트: 빈도 필터 검증 | v0.1 |
| AC-12 | 벡터 유사도 중복 방지 (< 0.76) | 단위 테스트: 유사 제안 필터링 | v0.1 |
| AC-13 | 설치/제거 동작 (플러그인 또는 install.mjs) | Phase 0 검증 + 수동 테스트 | v0.1 |
| AC-14 | 테스트 커버리지 80%+ | `vitest --coverage` | v0.3 |
| AC-15 | 기존 설정 훼손 없음 + Reflexion 충돌 감지 | 통합 테스트: 설정 백업/복원 + 충돌 경고 검증 | v0.1 |
| AC-16 | Stage 1 구조 검증이 저품질 생성물 60%+ 필터링 | 단위 테스트: 의도적 불량 SKILL.md로 검증 | v0.2 |
| AC-17 | 평가 비용 프로젝트당 일 5회 제한 | 단위 테스트: 한도 초과 시 거부 검증 | v0.2 |

---

## Risks and Mitigations (v2)

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| **플러그인 규격 불일치** | Critical | Medium | Phase 0에서 사전 검증. Fallback: install.mjs (settings.json 직접 편집) |
| **기존 Reflexion Hook 충돌** | High | High | 충돌 감지 + 경고. 동시 사용 미지원 명시. 마이그레이션 가이드 제공 |
| **"전체 한 번에" 일정 위험** | High | Medium | 3개 마일스톤(v0.1/v0.2/v0.3)으로 분리. 각 마일스톤에서 독립 검증 |
| Claude headless 타임아웃 (120s) | Medium | Medium | 재시도 로직 (3회), 입력 크기 제한, 오프라인 시 graceful skip |
| sqlite-vec 네이티브 빌드 실패 | Medium | Low | prebuild 바이너리, 벡터 검색 없이 keyword fallback |
| **평가 비용 (Claude API)** | Medium | Medium | 2단계 게이트 (Stage 1 무비용 필터), 프로젝트당 일 5회 제한, 비용 투명 표시. 추정: 1 평가 당 ~$0.15-$0.30 |
| 동시 DB 접근 충돌 | Low | Medium | WAL 모드 + busy_timeout(5000ms) + advisory lock (분석 race condition 방지) |
| settings.json 손상 | High | Low | JSON.parse 검증 + atomic write + .bak 백업 + 자동 롤백 |
| 자동 생성 스킬 저품질 | Medium | Medium | 2단계 게이트 + 사용자 승인 필수 (constitution 준수). 자기참조적 평가 한계 인식 |
| **테스트 프롬프트 자동 생성 품질** | High | Medium | Skill-Creator 패턴 참조, 충분한 컨텍스트(원본 패턴 + 사용 예시) 제공. v0.2에서 실효성 검증 |
| 스킬 적용 시뮬레이션 메커니즘 | High | Medium | `claude --print --system-prompt` 방식 PoC를 Phase 4 첫 단계에서 검증 |
| 오프라인 환경 | Low | Low | AI 호출 실패 시 graceful degradation — 수집만 계속, 분석/생성/평가 skip |

---

## Verification Steps (v2)

1. **Phase 0**: 플러그인 규격 PoC — Hook 1개가 실제 트리거되는지 확인
2. **v0.1**: `npm test` (Phase 1-3 테스트), 이벤트 수집 → 분석 → SKILL.md 초안 확인
3. **v0.2**: Stage 1 검증 통과율, `/evaluate` 실행 → Grader/Comparator 동작 확인, `/suggest` 승인→배포
4. **v0.3**: E2E 전체 흐름, `vitest --coverage` 80%+, Reflexion 충돌 감지 테스트
5. **수동 검증**: 실제 Claude Code 세션에서 3-5개 세션 사용 후 제안 품질 확인

---

## ADR: Architecture Decision Record (v2)

### Decision
Monolithic 패키지로 Reflexion의 Hook 기반 데이터 수집과 Skill-Creator의 Agent 기반 평가를 통합한다. 플러그인 규격이 미확인 시 install.mjs fallback을 제공한다. 배포는 반드시 사용자 승인을 거친다.

### Drivers
- 사용자는 단일 설치 경험을 원함
- Hook↔Agent 통신은 SQLite DB를 매개로 비동기 처리
- 평가 품질은 Skill-Creator 수준 유지 (블라인드 비교)
- Constitution 준수: 사용자 승인 없이 자동 배포 금지

### Alternatives Considered
1. **Reflexion 확장 (Option C)** — Hook의 비동기 단발 실행 모델과 Agent의 동기 다단계 실행 모델이 근본적으로 다름. 기존 코드에 억지로 통합하면 아키텍처 정합성 파괴. Deep Interview R4 확인.
2. **Core+Satellite 분리 (Option B)** — 코어 재사용성과 테스트 격리 장점이 있으나, 설치 2단계 + 버전 동기화 비용이 사용자 경험 이점을 상회. 단, 플러그인 규격 미지원 시 fallback으로 재검토 가능.
3. **Skill-Creator 어댑터** — Skill-Creator 플러그인 수정 불가 제약으로 기각.

### Why Chosen
- 단일 설치 경험 (플러그인 또는 install.mjs)
- DB 기반 비동기로 Hook과 Agent 간 느슨한 결합
- 2단계 게이트로 비용 제어와 품질 보증 양립
- 사용자 승인 게이트로 constitution 준수

### Consequences
- 패키지 크기 증가 (네이티브 의존성)
- 초기 개발 비용 높음 (전체 재작성)
- 유지보수는 단일 레포로 단순화
- 플러그인 규격 미확인 리스크 존재 (Phase 0에서 해소)

### Follow-ups
- Phase 0 결과에 따른 경로 확정
- 평가 비용 실측 후 제한 정책 조정
- Reflexion 사용자 마이그레이션 가이드 작성
- 임베딩 모델 경량화 검토

---

## Changelog

- v1.0: Planner 초안 작성 (Deep Interview 스펙 기반)
- v2.0: Architect + Critic 피드백 반영
  - [CRITICAL] Phase 0 추가: 플러그인 규격 사전 검증 + fallback 경로
  - [CRITICAL] 자동 배포 → 사용자 승인 후 배포 (constitution 준수)
  - [MAJOR] Option B 공정 재평가 + Option C 추가
  - [MAJOR] Reflexion 마이그레이션 전략 섹션 추가
  - [MAJOR] 2단계 게이트 전략 (Stage 1 로컬 검증 + Stage 2 온디맨드 평가)
  - [MAJOR] 3개 마일스톤(v0.1/v0.2/v0.3) 분리
  - [MAJOR] evaluations 테이블: status, project_path, error_message 추가
  - [MAJOR] generated_skills: content→file_path, project_path, approved 추가
  - [MINOR] busy_timeout = 5000 (Reflexion 일치)
  - [MINOR] advisory lock 추가 (분석 race condition 방지)
  - [MINOR] DB 크기 관리 (evaluations 180일 보존)
  - [MINOR] 비용 추정 명시 (~$0.15-$0.30/평가)
  - [MINOR] Skills vs MCP 역할 구분 명확화 (/suggest = PRIMARY UI, MCP = 프로그래밍 접근)
  - [MINOR] 스킬 생성 프롬프트 구조 명시
  - [MINOR] AC-4 비교 대상 명시 (Reflexion apply.mjs 출력)
  - [MINOR] AC-6 재정의 ("사람 개입 없이" → "승인 후 배포")
  - [MINOR] AC-16, AC-17 추가
