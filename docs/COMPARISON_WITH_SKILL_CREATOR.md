# Skill-Creator vs Reflexion 비교 분석

> 작성일: 2026-03-21

## 개요

두 프로젝트 모두 **Claude Code의 스킬/워크플로우를 개선**하는 도구이지만, 접근 방식이 근본적으로 다르다.

- **Skill-Creator**: Claude Code 공식 플러그인. 사용자가 주도하여 스킬을 설계·제작·평가·최적화하는 워크벤치.
- **Reflexion**: 사용 패턴(프롬프트, 도구, 에러)을 자동 수집·분석하여 스킬/규칙/Hook을 제안하는 자동 개선 시스템.

---

## 핵심 차이: 수동 vs 자동

| 관점 | **Skill-Creator** | **Reflexion** |
|------|-------------------|---------------|
| **철학** | 사람이 주도하는 스킬 제작 워크벤치 | 사용 패턴에서 자동으로 학습/제안 |
| **트리거** | 유저가 `/skill-creator` 호출 | Hook이 세션 중 자동 수집 |
| **입력** | 유저의 의도 → 인터뷰 → SKILL.md 작성 | 프롬프트/도구/에러 로그 자동 수집 |
| **출력** | 단일 스킬 (SKILL.md + evals) | 스킬 + CLAUDE.md 규칙 + Hook 워크플로우 |
| **평가** | 블라인드 비교, 통계 벤치마크, A/B grading | 에러 KB 벡터 검색, 패턴 빈도 분석 |
| **아키텍처** | 에이전트 기반 (grader, comparator, analyzer) | Hook 기반 (8개 이벤트) + SQLite + 벡터DB |
| **의존성** | Claude Code 내장 (플러그인) | Node.js + SQLite + 로컬 임베딩 모델 |
| **데이터** | 테스트 케이스 (evals.json) | 세션 로그 전체 (프롬프트, 도구, 에러) |

---

## Skill-Creator 상세

### 무엇을 하는가

사용자가 스킬의 의도를 설명하면, 인터뷰 → SKILL.md 작성 → 테스트 → 평가 → 개선의 반복 사이클로 고품질 스킬을 제작한다.

### 핵심 워크플로우

1. **Capture Intent** — 스킬의 목적, 트리거 조건, 출력 형식 파악
2. **Interview & Research** — 엣지 케이스, 성공 기준, 의존성 탐색
3. **Write SKILL.md** — 스킬 정의 파일 생성 (이름, 설명, 지시사항)
4. **Test Cases** — 2~3개 현실적 테스트 프롬프트 → `evals/evals.json`
5. **Run & Evaluate** — 스킬 적용/미적용 병렬 실행 (베이스라인 비교)
6. **Improve** — 피드백 분석 후 반복 개선
7. **Scale** — 테스트셋 확장
8. **Optimize Description** — 트리거 정확도 자동 튜닝

### 에이전트 구성

| 에이전트 | 역할 |
|----------|------|
| **Grader** | 실행 트랜스크립트 읽고 assertion 평가, pass/fail 판정 |
| **Comparator** | 두 출력을 블라인드 비교 (어느 스킬이 만든 건지 모른 채 평가) |
| **Analyzer** | 블라인드 해제 후 승자/패자 분석, 개선 제안 생성 |

### 스킬 파일 구조

```
skill-name/
├── SKILL.md          # 필수: YAML 프론트매터 + 마크다운 지시사항
├── scripts/          # 선택: 결정적 작업용 실행 코드
├── references/       # 선택: 필요 시 로드하는 참조 문서
└── assets/           # 선택: 템플릿, 아이콘 등
```

### 강점

- **정밀한 품질 제어** — 블라인드 비교와 통계적 벤치마크로 스킬 품질 정량 측정
- **Description 최적화** — train/test 분리(60/40)로 과적합 방지하며 트리거 정확도 자동 튜닝 (최대 5회 반복)
- **즉시 사용** — 설치 없이 `/skill-creator`로 바로 시작
- **Progressive Disclosure** — Level 1(메타데이터) → Level 2(SKILL.md) → Level 3(번들 리소스)로 컨텍스트 효율화

---

## Reflexion 상세

### 무엇을 하는가

Claude Code 세션의 프롬프트, 도구 사용, 에러를 자동 수집하고, AI 분석을 통해 반복 패턴을 발견하여 커스텀 스킬, CLAUDE.md 규칙, Hook 워크플로우를 제안한다.

### Dual-Layer 아키텍처

**Layer 1: Real-time Assistance (세션 중)**
- 에러 KB 벡터 검색 → 즉시 해결책 제시
- 스킬 매칭 → 프롬프트에 최적 스킬 추천
- 서브에이전트에 에러 패턴 주입
- 파일별 에러 히스토리 표시

**Layer 2: Batch Analysis (세션 간)**
- Claude headless mode로 AI 패턴 분석
- 커스텀 스킬 / CLAUDE.md 규칙 / Hook 워크플로우 제안 생성
- 384차원 벡터 배치 임베딩

### 8개 Hook 이벤트

| Hook | 스크립트 | 역할 |
|------|---------|------|
| `UserPromptSubmit` | prompt-logger.mjs | 프롬프트 수집 + 스킬 매칭 |
| `PostToolUse` | tool-logger.mjs | 도구 사용 + 해결 감지 |
| `PostToolUseFailure` | error-logger.mjs | 에러 수집 + KB 검색 |
| `PreToolUse` | pre-tool-guide.mjs | 파일별 에러 히스토리 표시 |
| `SubagentStart` | subagent-context.mjs | 에러 패턴 + AI 규칙 주입 |
| `SubagentStop` | subagent-tracker.mjs | 에이전트 성능 추적 |
| `SessionEnd` | session-summary.mjs | 요약 + AI 분석 트리거 |
| `SessionStart` | session-analyzer.mjs | 캐시 주입 + 임베딩 데몬 시작 |

### 3가지 출력 타입

- **커스텀 스킬** — 반복적 도구 시퀀스 감지 시 `~/.claude/commands/*.md`에 저장
- **CLAUDE.md 규칙** — 반복적 지시/패턴 감지 시 CLAUDE.md에 저장
- **Hook 워크플로우** — 반복적 이벤트 시퀀스 감지 시 `~/.reflexion/hooks/auto/`에 저장

### 기술 스택

| 구성요소 | 기술 |
|----------|------|
| 런타임 | Node.js >= 18 (ES Modules) |
| 저장소 | SQLite + sqlite-vec (384차원 벡터) |
| 임베딩 | `@xenova/transformers` (MiniLM-L12-v2, 오프라인) |
| 분석 | Claude CLI headless mode |
| 의존성 | 3개 (`better-sqlite3`, `sqlite-vec`, `@xenova/transformers`) |

### 강점

- **자동 발견** — 유저가 뭘 만들어야 하는지 몰라도 패턴을 감지해서 제안
- **Real-time 지원** — 세션 중 에러 발생 시 즉시 KB 검색으로 해결책 제시
- **범위가 넓음** — 스킬뿐 아니라 CLAUDE.md 규칙, Hook 워크플로우까지 생성
- **프라이버시** — 로컬 임베딩 (오프라인), 데이터가 외부로 나가지 않음
- **엔지니어링 성숙도** — 251개 테스트, 80%+ 커버리지, SDD 스펙 기반 개발

---

## 기술적 접근 차이

| | Skill-Creator | Reflexion |
|---|---|---|
| **검색** | 없음 (유저가 직접 정의) | 384차원 벡터 유사도 (MiniLM) |
| **분석** | 서브에이전트 병렬 실행 | Claude headless batch + SQLite 쿼리 |
| **저장** | 파일 기반 (JSON) | SQLite + sqlite-vec |
| **테스트** | 자체 eval 프레임워크 | 251개 테스트, 80%+ 커버리지 |
| **설계 문서** | README + 스키마 레퍼런스 | DESIGN.md (3,869줄) + SDD 스펙 19개 |

---

## 상호 보완 관계

이 둘은 경쟁이 아니라 **파이프라인**으로 연결될 수 있다:

```
Reflexion (패턴 감지/제안) → Skill-Creator (정밀 제작/평가/최적화)
```

- **Reflexion**이 "이런 스킬이 필요할 것 같다"고 제안하면
- **Skill-Creator**가 해당 스킬을 체계적으로 만들고, 테스트하고, 최적화

통합 시 **자동 감지 → 자동 생성 → 자동 평가**의 완전한 스킬 라이프사이클 구현 가능.

### 통합 시나리오

```
[세션 진행 중]
  ↓
Reflexion Hook이 반복 패턴 감지
  ↓
"파일 생성 후 항상 lint + format 실행" 패턴 발견
  ↓
Skill-Creator에 전달: 의도 + 수집된 예시
  ↓
SKILL.md 자동 생성 + eval 테스트 실행
  ↓
블라인드 비교로 품질 검증
  ↓
Description 최적화로 트리거 정확도 튜닝
  ↓
완성된 스킬 배포
```

---

## 결론

| 기준 | 추천 |
|------|------|
| 특정 스킬을 정밀하게 만들고 싶다 | **Skill-Creator** |
| 어떤 스킬이 필요한지 모르겠다 | **Reflexion** |
| 에러 반복을 줄이고 싶다 | **Reflexion** |
| 스킬 품질을 정량적으로 측정하고 싶다 | **Skill-Creator** |
| 둘 다 쓸 수 있다면 | **Reflexion → Skill-Creator 파이프라인** |
