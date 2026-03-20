#!/usr/bin/env node
// src/hooks/pre-tool-guide.mjs
// Hook: PreToolUse (Edit|Write|Bash|Task) — proactive guidance from error history
// Timeout: 5s

import { getDb, readStdin, isEnabled } from '../lib/db.mjs';

try {
  const input = await readStdin();
  if (!isEnabled()) process.exit(0);

  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const parts = [];

  // 1. Edit/Write: query error_kb for this file's error history
  if (['Edit', 'Write'].includes(toolName) && toolInput.file_path) {
    const filePath = toolInput.file_path;
    const fileName = filePath.split('/').pop();
    const db = getDb();

    // Get up to 5 recent errors for this file from the events table
    const recentErrors = db.prepare(`
      SELECT json_extract(data, '$.error') AS error,
             json_extract(data, '$.tool') AS tool,
             ts
      FROM events
      WHERE type = 'tool_error'
        AND json_extract(data, '$.errorRaw') LIKE ?
      ORDER BY ts DESC
      LIMIT 5
    `).all(`%${fileName}%`);

    if (recentErrors.length > 0) {
      parts.push(`[Reflexion-Fusion] 이 파일 관련 최근 에러 이력:`);
      for (const row of recentErrors) {
        if (!row.error) continue;
        parts.push(`- ${row.error} (${row.tool || '?'})`);

        // Check KB for resolution
        const kb = db.prepare(`
          SELECT error_normalized, resolution FROM error_kb
          WHERE error_normalized = ? AND resolution IS NOT NULL
          LIMIT 1
        `).get(row.error);

        if (kb?.resolution) {
          try {
            const res = JSON.parse(kb.resolution);
            if (res.toolSequence) {
              parts.push(`  해결 경로: ${res.toolSequence.join(' → ')}`);
            } else if (res.resolvedBy) {
              parts.push(`  해결 방법: ${res.resolvedBy}`);
            }
          } catch {
            parts.push(`  해결 방법: ${kb.resolution}`);
          }
        }
      }
    }

    // Also check error_kb directly by filename pattern
    const kbResults = db.prepare(`
      SELECT error_normalized, resolution FROM error_kb
      WHERE error_normalized LIKE ? AND resolution IS NOT NULL
      ORDER BY last_used DESC
      LIMIT 2
    `).all(`%${fileName}%`);

    for (const kb of kbResults) {
      // Skip if already mentioned from events query above
      if (parts.some(p => p.includes(kb.error_normalized))) continue;
      parts.push(`[Reflexion-Fusion] KB 이력 - ${kb.error_normalized}`);
      try {
        const res = JSON.parse(kb.resolution);
        if (res.toolSequence) parts.push(`  해결 경로: ${res.toolSequence.join(' → ')}`);
        else if (res.resolvedBy) parts.push(`  해결 방법: ${res.resolvedBy}`);
      } catch {
        parts.push(`  해결 방법: ${kb.resolution}`);
      }
    }
  }

  // 2. Bash: warn if a recent session bash error has a known resolution
  if (toolName === 'Bash' && toolInput.command) {
    const db = getDb();
    const recentBashError = db.prepare(`
      SELECT json_extract(data, '$.error') AS error
      FROM events
      WHERE type = 'tool_error'
        AND session_id = ?
        AND json_extract(data, '$.tool') = 'Bash'
      ORDER BY ts DESC
      LIMIT 1
    `).get(input.session_id);

    if (recentBashError?.error) {
      const kb = db.prepare(`
        SELECT error_normalized, resolution FROM error_kb
        WHERE error_normalized = ? AND resolution IS NOT NULL
        LIMIT 1
      `).get(recentBashError.error);

      if (kb) {
        parts.push(`[Reflexion-Fusion] 이 세션의 Bash 에러 이력: ${kb.error_normalized}`);
        try {
          const res = JSON.parse(kb.resolution);
          if (res.toolSequence) parts.push(`  이전 해결 경로: ${res.toolSequence.join(' → ')}`);
        } catch { /* resolution is plain text */ }
      }
    }
  }

  if (parts.length > 0) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: parts.join('\n')
      }
    }));
  }

  process.exit(0);
} catch {
  process.exit(0);
}
