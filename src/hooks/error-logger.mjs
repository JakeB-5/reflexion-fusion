#!/usr/bin/env node
// src/hooks/error-logger.mjs
// Hook: PostToolUseFailure — record tool errors + real-time KB lookup
// Timeout: 5s

import { insertEvent, getProjectName, getProjectPath, readStdin, isEnabled } from '../lib/db.mjs';
import { normalizeError, searchErrorKB } from '../lib/error-kb.mjs';

try {
  const input = await readStdin();
  if (!isEnabled()) process.exit(0);

  const projectPath = getProjectPath(input.cwd);
  const project = getProjectName(projectPath);
  const normalized = normalizeError(input.error || '');

  // 1. Record error event
  insertEvent({
    v: 1,
    type: 'tool_error',
    ts: new Date().toISOString(),
    sessionId: input.session_id,
    project,
    projectPath,
    tool: input.tool_name,
    error: normalized,
    errorRaw: (input.error || '').slice(0, 500)
  });

  // 2. Real-time KB search with 2s timeout
  const kbMatch = await Promise.race([
    searchErrorKB(normalized),
    new Promise(resolve => setTimeout(() => resolve(null), 2000))
  ]);

  if (kbMatch) {
    // Format resolution text — handle JSON or plain string resolutions
    let resText = kbMatch.resolution || '';
    try {
      const res = JSON.parse(kbMatch.resolution);
      if (res.toolSequence) {
        resText = `${res.resolvedBy || 'resolved'}: ${res.toolSequence.join(' → ')}`;
      } else if (res.resolvedBy) {
        resText = res.resolvedBy;
      }
    } catch {
      // Resolution is plain text — use as-is
    }

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure',
        additionalContext:
          `[Reflexion-Fusion 에러 KB] 이전에 동일 에러를 해결한 이력이 있습니다:\n` +
          `- 에러: ${kbMatch.error_normalized}\n` +
          `- 해결 방법: ${resText}\n` +
          `이 정보를 참고하여 해결을 시도하세요.`
      }
    }));
  }

  process.exit(0);
} catch {
  // Non-blocking: always exit 0
  process.exit(0);
}
