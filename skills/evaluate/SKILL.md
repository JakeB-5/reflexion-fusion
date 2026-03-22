---
name: evaluate
description: |
  스킬의 품질을 블라인드 평가합니다. Grader/Comparator/Analyzer 에이전트를 사용하여
  자동 생성된 스킬을 기존 스킬과 비교 평가합니다. Use when the user says "evaluate",
  "평가", "스킬 품질", or wants to verify a generated skill's quality.
---

# /evaluate — 스킬 블라인드 평가

## 사용법
`/evaluate [스킬이름 또는 제안번호]`

## 동작
1. 대상 스킬의 Stage 1 (구조 검증) 확인
2. 테스트 프롬프트 2-3개 자동 생성
3. 스킬 적용/미적용 병렬 실행
4. Grader → Comparator → Analyzer 순차 평가
5. 결과 보고 (pass/fail/improve + 상세 점수)

## 비용 안내
- 1회 평가 당 약 50K-100K 토큰 (sonnet 기준)
- 프로젝트당 일 5회 제한

## 내부 API
- `evaluateSkill(filePath, options)` — 파일 경로 기반 평가 (Stage 1 → Stage 2)
- `evaluateOnDemand(skillName, options)` — 스킬 이름으로 DB 조회 후 평가
- `checkDailyLimit(projectPath)` — 일일 평가 한도 확인

## 주의
- Stage 2 평가는 Claude API를 사용합니다
- `/suggest`로 먼저 제안 목록을 확인하세요
