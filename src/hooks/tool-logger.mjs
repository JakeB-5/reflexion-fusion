#!/usr/bin/env node
// src/hooks/tool-logger.mjs
// Hook: PostToolUse — record tool usage + detect error resolutions
// Timeout: 5s

import { insertEvent, queryEvents, getProjectName, getProjectPath, readStdin, isEnabled } from '../lib/db.mjs';
import { recordResolution } from '../lib/error-kb.mjs';

try {
  const input = await readStdin();
  if (!isEnabled()) process.exit(0);

  const projectPath = getProjectPath(input.cwd);
  const project = getProjectName(projectPath);
  const meta = extractToolMeta(input.tool_name, input.tool_input);

  // 1. Record tool_use event
  insertEvent({
    v: 1,
    type: 'tool_use',
    ts: new Date().toISOString(),
    sessionId: input.session_id,
    project,
    projectPath,
    tool: input.tool_name,
    meta,
    success: true
  });

  // 2. Resolution detection — check if this tool use resolves a recent error
  try {
    const rawRows = queryEvents({ sessionId: input.session_id, limit: 50 });

    // queryEvents returns DESC; re-sort chronologically for sequence analysis
    const sessionEntries = rawRows
      .map(row => {
        try { return { ...row, ...JSON.parse(row.data) }; } catch { return row; }
      })
      .sort((a, b) => new Date(a.ts) - new Date(b.ts));

    // Same-tool resolution: error from this tool followed by success
    const sameToolErrors = sessionEntries.filter(
      e => e.type === 'tool_error' && e.tool === input.tool_name
    );

    if (sameToolErrors.length > 0) {
      const lastError = sameToolErrors[sameToolErrors.length - 1];
      const errorIdx = sessionEntries.indexOf(lastError);
      const toolsBetween = sessionEntries
        .slice(errorIdx + 1)
        .filter(e => e.type === 'tool_use')
        .slice(0, 5)
        .map(e => e.tool);

      recordResolution(lastError.error, {
        tool: input.tool_name,
        sessionId: input.session_id,
        resolvedBy: 'success_after_error',
        errorRaw: lastError.errorRaw || null,
        filePath: meta?.file || null,
        toolSequence: toolsBetween,
        promptContext: sessionEntries
          .filter(e => e.type === 'prompt')
          .slice(-1)[0]?.text?.slice(0, 200) || null
      });
    }

    // Cross-tool resolution: errors from other tools resolved with help from current tool
    const pendingErrors = sessionEntries.filter(
      e => e.type === 'tool_error' && e.tool !== input.tool_name
    );

    for (const pendingError of pendingErrors) {
      const errorIdx = sessionEntries.indexOf(pendingError);
      const laterSuccesses = sessionEntries
        .slice(errorIdx + 1)
        .filter(e => e.type === 'tool_use' && e.tool === pendingError.tool && e.success);

      if (laterSuccesses.length > 0) {
        const firstSuccess = laterSuccesses[0];
        const helpingTools = sessionEntries
          .slice(errorIdx + 1, sessionEntries.indexOf(firstSuccess))
          .filter(e => e.type === 'tool_use')
          .map(e => e.tool);

        if (helpingTools.includes(input.tool_name)) {
          recordResolution(pendingError.error, {
            tool: pendingError.tool,
            sessionId: input.session_id,
            resolvedBy: 'cross_tool_resolution',
            errorRaw: pendingError.errorRaw || null,
            helpingTool: input.tool_name,
            filePath: meta?.file || null,
            toolSequence: helpingTools
          });
        }
      }
    }
  } catch {
    // Silent fail — resolution detection is best-effort
  }

  process.exit(0);
} catch {
  process.exit(0);
}

function extractToolMeta(tool, toolInput) {
  if (!toolInput) return {};

  switch (tool) {
    case 'Bash': {
      const cmd = (toolInput.command || '').split(/\s+/)[0];
      return { command: cmd };
    }

    case 'Read':
    case 'Write':
    case 'Edit': {
      const filePath = toolInput.file_path;
      if (!filePath) return {};
      // Sanitize sensitive file paths
      const sensitivePatterns = [
        /\/.env$/, /\/.env\./, /\/\.env$/, /\/credentials\.json$/,
        /\.key$/, /\.pem$/, /\/id_rsa/
      ];
      const isSensitive = sensitivePatterns.some(p => p.test(filePath));
      return { file: isSensitive ? '[SENSITIVE_PATH]' : filePath };
    }

    case 'Grep':
    case 'Glob':
      return { pattern: toolInput.pattern };

    case 'Task':
      return {
        agentType: toolInput.subagent_type,
        model: toolInput.model
      };

    default:
      return {};
  }
}
