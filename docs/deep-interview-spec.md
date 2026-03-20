# Deep Interview Spec: Skill-Creator + Reflexion Fusion Plugin

## Metadata
- Interview ID: di-skillcreator-reflexion-fusion
- Rounds: 12
- Final Ambiguity Score: 17%
- Type: brownfield
- Generated: 2026-03-21
- Threshold: 20%
- Status: PASSED

## Clarity Breakdown

| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.90 | 35% | 0.315 |
| Constraint Clarity | 0.75 | 25% | 0.188 |
| Success Criteria | 0.85 | 25% | 0.213 |
| Context Clarity | 0.80 | 15% | 0.120 |
| **Total Clarity** | | | **0.835** |
| **Ambiguity** | | | **16.5%** |

---

## Goal

Reflexion(자동 패턴 분석/제안 시스템)과 Skill-Creator(수동 스킬 제작/평가 워크벤치)를 융합한 **새로운 Claude Code 플러그인**을 만든다. 이 플러그인은 사용자의 Claude Code 사용 패턴을 자동 수집하고, AI 분석으로 패턴을 감지하며, Skill-Creator 품질의 스킬을 자동 생성하고, 블라인드 평가로 품질을 검증한 뒤 자동 배포하는 **완전한 스킬 라이프사이클**을 구현한다.

### 핵심 아키텍처

```
[Claude Code Hooks] ──write──> [SQLite DB] ──read──> [Batch Analyzer]
                                                          │
                                                    패턴 감지
                                                          │
                                              ┌───────────┼───────────┐
                                              ▼           ▼           ▼
                                        [SKILL.md     [CLAUDE.md  [Hook
                                         Generator]    Generator]  Generator]
                                              │
                                              ▼
                                     [Evaluation Pipeline]
                                     ├── Grader (실행+판정)
                                     ├── Comparator (블라인드 비교)
                                     └── Analyzer (개선 제안)
                                              │
                                              ▼
                                     [Auto Deploy]
                                     ├── ~/.claude/commands/*.md
                                     ├── ~/.claude/CLAUDE.md
                                     └── hooks/auto/
```

### 통신 패턴

- **DB 기반 비동기**: Hooks → DB 저장 → Batch Analyzer가 DB를 읽어 패턴 감지 → 에이전트 트리거
- 느슨한 결합, Reflexion 패턴 계승
- 실시간 레이어(에러 KB, 스킬 매칭)는 Hook 내에서 직접 DB 조회

### 실행 타이밍

- **기본**: 세션 종료 후 백그라운드 (SessionEnd hook → detached process)
- **온디맨드**: 사용자 명령으로 즉시 평가 실행 가능

---

## Constraints

- **배포 형태**: Claude Code 플러그인 (hooks 자동 등록, skills 제공)
- **의존성 제한 없음**: 필요한 만큼 자유롭게 추가 가능. 품질과 기능 우선
- **새 프로젝트 경로**: 현재 Reflexion 프로젝트와 겹치지 않는 별도 경로에 생성
- **전체 재작성**: Reflexion 코드는 참조만 활용, 플러그인 아키텍처에 맞게 새로 작성
- **Skill-Creator 평가 방식 채용**: Grader + Comparator + Analyzer 서브에이전트 패턴 그대로 차용
- **Hook 제약**: 수집 hooks는 5s timeout, 세션 hooks는 10s timeout, 모든 hooks는 exit 0 보장
- **비동기 AI**: Hook 내에서 Claude headless를 동기 호출하지 않음. 백그라운드/detached만 사용

---

## Non-Goals

- Reflexion 기존 프로젝트의 유지보수/개선 (참조만)
- Skill-Creator 플러그인 자체의 수정
- 웹 UI/대시보드 (CLI/플러그인 범위만)
- 클라우드 서비스/API 서버
- 멀티 사용자 지원 (로컬 단일 사용자 전용)

---

## Acceptance Criteria

### Priority 1: 품질 동등성 (Quality Parity)
- [ ] 자동 생성된 SKILL.md가 Skill-Creator의 YAML frontmatter + markdown 표준을 준수
- [ ] Grader 에이전트가 생성된 스킬의 실행 트랜스크립트를 읽고 pass/fail 판정
- [ ] Comparator 에이전트가 자동 생성 vs 기존 스킬을 블라인드 비교
- [ ] 블라인드 비교에서 자동 생성 스킬이 50% 이상 승률 달성
- [ ] Description 최적화로 트리거 정확도 자동 튜닝 (train/test 60/40 분리)

### Priority 2: E2E 파이프라인 (End-to-End)
- [ ] 패턴 감지 → 스킬 제안 → 생성 → 평가 → 배포가 사람 개입 없이 완료
- [ ] SessionEnd hook이 분석을 트리거하고, 다음 SessionStart에서 결과 주입
- [ ] 생성된 스킬이 `~/.claude/commands/`에 자동 설치
- [ ] 생성된 CLAUDE.md 규칙이 적절한 CLAUDE.md에 자동 추가
- [ ] 생성된 Hook 워크플로우가 settings.json에 자동 등록

### Priority 3: 발견 능력 (Discovery)
- [ ] 3회 이상 반복된 프롬프트 패턴을 자동 감지
- [ ] 반복적 도구 시퀀스를 Hook 워크플로우로 제안
- [ ] 반복적 에러 패턴에 대해 CLAUDE.md 규칙 제안
- [ ] 제안 수락률 60% 이상 달성 (feedback tracking 기반)
- [ ] 벡터 유사도 기반 중복 제안 방지

### 공통
- [ ] Claude Code 플러그인으로 설치 가능 (hook 자동 등록)
- [ ] 테스트 커버리지 80%+
- [ ] 설치/제거가 깔끔하게 동작
- [ ] 기존 Claude Code 설정을 훼손하지 않음

---

## Assumptions Exposed & Resolved

| Assumption | Challenge (Round) | Resolution |
|------------|-------------------|------------|
| Reflexion 확장이면 충분하다 | Hook+Agent 아키텍처가 근본적으로 다르다 (R4 Contrarian) | 재설계 필수 확인 |
| MVP 단계가 필요하다 | 최소한만 먼저 하면 되지 않나? (R6 Simplifier) | 전체 통합을 한 번에 구현 결정 |
| 의존성 3개 제한 유지 | 품질이 우선인가 미니말리즘이 우선인가? (R2) | 제한 없음, 품질 우선 |
| 블라인드 평가가 과도하다 | 간소화된 점수화만으로 충분하지 않나? (R8) | Skill-Creator 방식 그대로 유지 |
| 설계 문서만 산출물이다 | 실제 동작하는 코드가 필요한가? (R12) | 완성된 플러그인으로 제작 |

---

## Technical Context

### 참조 시스템: Reflexion

- **위치**: `/Users/jin/projects/reflexion/`
- **구성**: 8개 Hook 스크립트 + 8개 lib 모듈 + 4개 CLI 도구 + 251개 테스트
- **DB**: SQLite + sqlite-vec (384-dim 벡터), WAL mode
- **분석**: Claude headless mode (`claude --print --model sonnet`)
- **임베딩**: `@xenova/transformers` + `paraphrase-multilingual-MiniLM-L12-v2`
- **3가지 출력**: skills, CLAUDE.md rules, hook workflows

### 참조 시스템: Skill-Creator

- **형태**: Claude Code 플러그인 (에이전트 기반)
- **워크플로우**: Intent Capture → Interview → SKILL.md → Test Cases → Run & Evaluate → Improve
- **에이전트**: Grader (실행+판정), Comparator (블라인드 비교), Analyzer (개선 분석)
- **평가**: 블라인드 비교 + 통계 벤치마크 + Description 최적화 (train/test 60/40)
- **출력**: SKILL.md (YAML frontmatter + markdown instructions + scripts/references/assets)

### 통합 제품 기술 결정

| 항목 | 결정 |
|------|------|
| 런타임 | Node.js >= 18 (ES Modules) |
| 저장소 | SQLite + sqlite-vec (Reflexion 패턴 계승) |
| 배포 | Claude Code 플러그인 |
| 의존성 | 제한 없음 |
| AI 분석 | Claude headless mode (배치/백그라운드) |
| 평가 | Skill-Creator 에이전트 패턴 (Grader/Comparator/Analyzer) |
| 통신 | DB 기반 비동기 (Hook → DB → Analyzer → Agent) |
| 타이밍 | 세션 종료 후 백그라운드 + 온디맨드 |
| 코드 | 전체 재작성 (Reflexion 참조만) |
| 프로젝트 경로 | 새 경로 (Reflexion과 분리) |

---

## Ontology (Key Entities)

| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| Integrated Plugin | core domain | name, version, hooks, skills, agents | contains all other entities |
| Hook Layer | core domain | 8 event scripts, timeout, stdin/stdout | writes to DB, reads from DB |
| Batch Analyzer | core domain | pattern detection, AI analysis, caching | reads DB, triggers Generator |
| Skill Generator | core domain | SKILL.md template, frontmatter, instructions | produces Skill, triggers Evaluator |
| Evaluation Pipeline | core domain | Grader, Comparator, Analyzer agents | evaluates Skill, produces Report |
| Auto Deployer | core domain | target paths, settings.json updater | deploys Skill/Rule/Hook |
| Skill | core domain | name, trigger, content, quality score, type | created by Generator, evaluated by Pipeline |
| Pattern | supporting | frequency, tool sequence, error type, prompt cluster | detected by Analyzer |
| SKILL.md | supporting | YAML frontmatter, markdown, scripts, references | format of Skill output |
| Error KB | supporting | normalized error, resolution, vector embedding | searched by Hook, fed to Analyzer |
| Feedback | supporting | suggestion ID, accepted/rejected, usage rate | tracks Skill adoption |
| SQLite DB | infrastructure | events, error_kb, feedback, analysis_cache, skill_embeddings | central data store |
| Blind Evaluation | supporting | Grader result, Comparator verdict, Analyzer suggestion | quality gate |
| Full Pipeline | supporting | detect → generate → evaluate → deploy | E2E flow |
| Plugin Config | infrastructure | enabled, model, retention, thresholds | system settings |

## Ontology Convergence

| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 6 | 6 | - | - | N/A |
| 2 | 7 | 1 | 0 | 6 | 86% |
| 3 | 10 | 3 | 0 | 7 | 70% |
| 4 | 11 | 1 | 0 | 10 | 91% |
| 5 | 12 | 1 | 0 | 11 | 92% |
| 6 | 12 | 0 | 1 | 11 | 92% |
| 7 | 12 | 0 | 0 | 12 | 100% |
| 8 | 14 | 2 | 0 | 12 | 86% |
| 9 | 14 | 0 | 0 | 14 | 100% |
| 10 | 14 | 0 | 0 | 14 | 100% |
| 11 | 15 | 1 | 0 | 14 | 93% |
| 12 | 15 | 0 | 0 | 15 | 100% |

---

## Interview Transcript

<details>
<summary>Full Q&A (12 rounds)</summary>

### Round 1
**Q:** "융합"의 최종 결과물이 정확히 무엇인가요? 사용자가 이 시스템을 사용할 때 어떤 경험을 하게 되나요?
**A:** 새로운 통합 제품 — 기존 두 시스템의 기능을 재설계하여 하나의 시스템으로 통합
**Ambiguity:** 73% (Goal: 0.50, Constraints: 0.10, Criteria: 0.10, Context: 0.30)

### Round 2
**Q:** Reflexion의 '외부 의존성 3개 제한' 원칙을 유지해야 하나요?
**A:** 제한 없음 — 품질과 기능이 우선
**Ambiguity:** 67% (Goal: 0.50, Constraints: 0.35, Criteria: 0.10, Context: 0.30)

### Round 3
**Q:** 성공 기준은 무엇인가요?
**A:** 복합 기준 — 품질 동등성 + 발견 능력 + E2E 파이프라인, 단계적 달성
**Ambiguity:** 56% (Goal: 0.50, Constraints: 0.35, Criteria: 0.55, Context: 0.30)

### Round 4 [Contrarian Mode]
**Q:** Reflexion 확장만으로 80% 달성 가능하지 않나? 재설계가 정말 필요한가?
**A:** 재설계 필수 — Hook vs Agent 아키텍처가 근본적으로 다르다
**Ambiguity:** 50% (Goal: 0.65, Constraints: 0.35, Criteria: 0.55, Context: 0.35)

### Round 5
**Q:** 배포/설치 형태는?
**A:** Claude Code 플러그인 — hook 자동 등록 + 스킬 제공
**Ambiguity:** 45% (Goal: 0.65, Constraints: 0.55, Criteria: 0.55, Context: 0.35)

### Round 6 [Simplifier Mode]
**Q:** MVP로 먼저 만드는 게 낫지 않을까?
**A:** 전체 통합 (MVP 없이) — 감지→생성→평가→최적화→배포 전체를 한 번에
**Ambiguity:** 41% (Goal: 0.70, Constraints: 0.55, Criteria: 0.55, Context: 0.50)

### Round 7
**Q:** 복합 성공 기준의 우선순위는?
**A:** 품질 → E2E → 발견 — 나쁜 스킬을 많이 만드는 것보다 좋은 스킬을 적게 만드는 게 낫다
**Ambiguity:** 36% (Goal: 0.70, Constraints: 0.55, Criteria: 0.75, Context: 0.50)

### Round 8
**Q:** 블라인드 평가를 어떻게 구현할까?
**A:** Skill-Creator 방식 그대로 — Grader + Comparator + Analyzer 서브에이전트
**Ambiguity:** 32% (Goal: 0.80, Constraints: 0.55, Criteria: 0.75, Context: 0.50)

### Round 9
**Q:** 평가 프로세스의 실행 타이밍은?
**A:** 하이브리드 — 세션 종료 후 백그라운드 + 온디맨드 지원
**Ambiguity:** 28% (Goal: 0.80, Constraints: 0.70, Criteria: 0.75, Context: 0.50)

### Round 10
**Q:** Reflexion 기존 코드 중 어떤 모듈을 유지/재설계?
**A:** 전체 재작성 — Reflexion 코드를 참조만, 플러그인 아키텍처에 맞게 새로 작성
**Ambiguity:** 25% (Goal: 0.80, Constraints: 0.70, Criteria: 0.75, Context: 0.75)

### Round 11
**Q:** 핵심 아키텍처: 훅과 에이전트의 통신 방식은?
**A:** DB 기반 비동기 — Hook이 DB에 쓰고, Batch Analyzer가 읽어서 에이전트 트리거
**Ambiguity:** 21% (Goal: 0.90, Constraints: 0.70, Criteria: 0.75, Context: 0.75)

### Round 12
**Q:** 최종 산출물 형태는?
**A:** 완성된 플러그인 — 새 경로에 생성 (Reflexion 프로젝트와 분리)
**Ambiguity:** 17% (Goal: 0.90, Constraints: 0.75, Criteria: 0.85, Context: 0.80)

</details>
