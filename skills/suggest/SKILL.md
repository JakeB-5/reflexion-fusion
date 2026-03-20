---
name: suggest
description: |
  Reflexion-Fusion의 자동 분석 결과를 확인하고 제안된 스킬/규칙/Hook을 승인하거나 거부합니다.
  Use when the user says "suggest", "제안", "추천", "새 스킬", or wants to review
  auto-generated suggestions. This is the primary interface for the approval workflow.
---

# /suggest — 제안 확인 및 승인

## 사용법
`/suggest` — 미승인 제안 목록 표시
`/suggest apply <번호>` — 제안 승인 및 배포
`/suggest reject <번호>` — 제안 거부 (다시 제안하지 않음)

## 동작
1. 미승인 제안 목록을 generated_skills + evaluations에서 조회
2. 각 제안의 미리보기 표시 (SKILL.md 내용, 검증 결과, 평가 결과)
3. 사용자 승인 시 auto-deployer로 배포
4. 거부 시 feedback에 'dismissed' 기록

## 중요
- 모든 배포는 사용자 승인이 필요합니다
- Stage 1 (구조 검증) 통과 여부가 표시됩니다
- Stage 2 (블라인드 평가)를 원하면 `/evaluate`를 먼저 실행하세요
