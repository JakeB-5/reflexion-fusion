#!/usr/bin/env node
// src/hooks/prompt-logger.mjs
// Hook: UserPromptSubmit — record prompts + skill auto-detection
// Timeout: 5s

import { insertEvent, getProjectName, getProjectPath, readStdin, loadConfig, stripPrivateTags, isEnabled } from '../lib/db.mjs';

try {
  const input = await readStdin();
  if (!isEnabled()) process.exit(0);

  const config = loadConfig();
  const projectPath = getProjectPath(input.cwd);
  const project = getProjectName(projectPath);

  // Privacy: strip private tags; optionally redact full prompt text
  const rawPrompt = config.collectPromptText === false ? '[REDACTED]' : (input.prompt || '');
  const promptText = stripPrivateTags(rawPrompt);

  // 1. Record prompt event
  insertEvent({
    v: 1,
    type: 'prompt',
    ts: new Date().toISOString(),
    sessionId: input.session_id,
    project,
    projectPath,
    text: promptText,
    charCount: promptText.length
  });

  // 2. Skill auto-detection (lazy import — skill-matcher.mjs may not exist yet)
  if (promptText.length > 0) {
    try {
      const { loadSkills, matchSkill } = await import('../lib/skill-matcher.mjs');
      const skills = loadSkills(projectPath);
      if (skills.length > 0) {
        const matched = await Promise.race([
          matchSkill(input.prompt || promptText, skills),
          new Promise(resolve => setTimeout(() => resolve(null), 2000))
        ]);
        if (matched) {
          const scope = matched.scope === 'global' ? '전역' : '프로젝트';
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext:
                `[Reflexion-Fusion] 관련 스킬: \`/${matched.name}\` (${scope})\n` +
                `이 작업과 관련된 커스텀 스킬이 있습니다. 사용자에게 이 스킬 사용을 제안해주세요.`
            }
          }));
        }
      }
    } catch {
      // skill-matcher.mjs not available yet — skip silently
    }
  }

  // 3. Track explicit skill invocations (prompt starts with /)
  if ((input.prompt || '').startsWith('/')) {
    const skillName = input.prompt.split(/\s+/)[0].slice(1);
    if (skillName) {
      insertEvent({
        v: 1,
        type: 'skill_used',
        ts: new Date().toISOString(),
        sessionId: input.session_id,
        project,
        projectPath,
        skillName
      });
    }
  }

  process.exit(0);
} catch {
  // Non-blocking: always exit 0
  process.exit(0);
}
