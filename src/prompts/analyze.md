# Reflexion-Fusion 패턴 분석

## 입력 데이터

- 분석 기간: {{days}}일
- 프로젝트: {{project}}
- 피드백 이력: {{feedback_history}}
- 기존 스킬: {{existing_skills}}

## 분석 대상 로그

{{log_data}}

## 지시사항

아래 4가지 패턴을 분석하세요:

1. **프롬프트 클러스터**: 의미적으로 유사한 프롬프트 (3회 이상 반복)
   - 표면적 키워드가 달라도 의도가 같으면 같은 클러스터로 묶으세요.
   - 예: "TS 초기화", "타입스크립트 셋업", "새 TS 프로젝트" → 같은 클러스터

2. **도구 워크플로우**: 반복적 도구 시퀀스 (3개 이상 세션에서 동일 패턴)
   - Read → Edit 같은 기본 패턴은 제외하세요.
   - "Grep → Read → Edit → Bash(test)" 같은 목적이 있는 워크플로우만 포함하세요.

3. **에러 패턴**: 반복적 에러와 해결 방법
   - 동일하거나 유사한 에러가 반복되면 방지 규칙을 도출하세요.
   - 에러 메시지의 정규화된 형태와 원본을 모두 고려하세요.
   - 규칙은 CLAUDE.md에 추가할 수 있는 자연어 지침으로 작성하세요.

4. **효과성 메트릭**: 제안 수락률, 스킬 사용률
   - 피드백 이력에서 수락률이 낮은 제안 유형은 줄이세요.
   - 사용률이 낮은 기존 스킬과 중복되는 제안은 하지 마세요.

## 제안 품질 기준

- 빈도 3회 이상인 패턴만 제안하세요.
- 기존 스킬 목록과 중복되는 제안은 제외하세요.
- 단일 세션에서만 발생한 에러는 제외하세요.
- 최대 5개 제안을 생성하세요.
- "코드를 더 잘 작성하세요" 같은 일반적 조언은 하지 마세요.

## 출력 형식

JSON으로만 응답하세요. 다른 텍스트는 포함하지 마세요.

```json
{
  "suggestions": [
    {
      "type": "skill|claude_md|hook",
      "id": "suggest-N",
      "summary": "제안 요약",
      "evidence": "근거 (빈도, 패턴)",
      "action": "구체적 적용 방법",
      "priority": 1,
      "skillName": "name (skill 유형만)",
      "rule": "규칙 텍스트 (claude_md 유형만)",
      "hookCode": "코드 (hook 유형만)",
      "hookEvent": "PostToolUse (hook 유형만)"
    }
  ],
  "clusters": [
    {
      "id": "cluster-0",
      "summary": "클러스터 요약",
      "intent": "setup|feature-add|bug-fix|refactor|query",
      "count": 5,
      "examples": ["프롬프트 원문1", "프롬프트 원문2"],
      "firstSeen": "ISO8601",
      "lastSeen": "ISO8601"
    }
  ],
  "workflows": [
    {
      "pattern": "Grep → Read → Edit → Bash(test)",
      "count": 4,
      "purpose": "코드 검색 후 수정 및 테스트",
      "sessions": 3
    }
  ],
  "errorPatterns": [
    {
      "pattern": "정규화된 에러 패턴",
      "count": 3,
      "tools": ["Bash"],
      "proposedRule": "CLAUDE.md에 추가할 규칙"
    }
  ]
}
```
