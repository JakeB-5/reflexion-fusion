# SKILL.md 생성

## 입력

- 제안: {{suggestion}}
- 예시 프롬프트: {{example_prompts}}
- 예시 도구 시퀀스: {{example_tools}}
- 기존 스킬 목록: {{existing_skills}}

## 출력 형식

YAML frontmatter와 Markdown body로 구성된 SKILL.md 파일을 생성하세요.
`\`\`\`skill` 코드 블록 안에 전체 내용을 작성하세요.

### YAML Frontmatter (필수)

```
---
name: skill-name
description: |
  트리거 조건을 구체적으로 명시하세요 (30~100단어).
  "Use when..." 패턴을 사용하세요.
  언제, 어떤 상황에서 이 스킬을 사용하는지 명확히 기술하세요.
---
```

### Markdown Body 작성 규칙

- 500줄 이하로 작성하세요.
- Progressive Disclosure 구조: 핵심 지시사항 → 세부 단계 → 참조 리소스
- Imperative mood(지시형)으로 작성하세요. 예: "Run", "Create", "Check"
- "why"(이유)를 각 주요 단계에 포함하세요.
- 구체적인 파일 경로, 명령어, 코드 예시를 포함하세요.
- 추상적이거나 모호한 표현을 피하세요.

## 품질 기준

- description은 트리거 조건을 구체적으로 명시해야 합니다.
- 실행 가능한 지시사항만 포함하세요.
- 기존 스킬 목록과 차별화되는 내용을 작성하세요.
- 일반적인 조언("코드를 잘 작성하세요")은 포함하지 마세요.

## 출력 예시

```skill
---
name: ts-project-init
description: |
  Use when setting up a new TypeScript project from scratch or when asked to
  initialize TypeScript configuration. Triggers on prompts like "TS 초기화",
  "타입스크립트 셋업", "새 TS 프로젝트 만들어줘".
---

## TypeScript 프로젝트 초기화

### 1단계: 기본 설정

Run the following to initialize the project with strict TypeScript settings:

...
```

SKILL.md 내용만 출력하세요. 다른 텍스트는 포함하지 마세요.
