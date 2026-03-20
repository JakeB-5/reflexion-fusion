#!/usr/bin/env node
// src/hooks/subagent-tracker.mjs
// Hook: SubagentStop — silent performance tracking, no output
// Timeout: 5s

import { insertEvent, getProjectName, getProjectPath, readStdin, isEnabled } from '../lib/db.mjs';

try {
  const input = await readStdin();
  if (!isEnabled()) process.exit(0);

  insertEvent({
    v: 1,
    type: 'subagent_stop',
    ts: new Date().toISOString(),
    sessionId: input.session_id,
    project: getProjectName(getProjectPath(input.cwd)),
    projectPath: getProjectPath(input.cwd),
    agentId: input.agent_id,
    agentType: input.agent_type
    // Note: SubagentStop API does not provide error/success info
  });

  process.exit(0);
} catch {
  process.exit(0);
}
