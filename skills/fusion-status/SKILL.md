---
name: fusion-status
description: |
  Reflexion-Fusion 시스템의 상태를 확인합니다. 수집 통계, 분석 결과, 평가 이력,
  배포된 스킬 목록을 보여줍니다. Use when the user says "fusion status", "상태",
  "시스템 현황", or wants to check the health of the reflexion-fusion system.
---

# /fusion-status — 시스템 상태

## 표시 항목
1. **수집 통계**: 총 이벤트 수, 프롬프트/도구/에러 비율, 최근 7일 추이
2. **분석 결과**: 최근 분석 시간, 감지된 패턴 수, 미승인 제안 수
3. **평가 이력**: 총 평가 수, pass/fail 비율, 일일 사용량/한도
4. **배포된 스킬**: 활성 스킬 목록, 사용률, 피드백 수락률
5. **시스템 건강**: DB 크기, 임베딩 데몬 상태, 캐시 히트율
6. **Reflexion 충돌**: 기존 Reflexion 훅 감지 여부
