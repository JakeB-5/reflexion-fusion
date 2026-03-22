#!/usr/bin/env node
// src/hooks/session-summary.mjs
// Hook: SessionEnd — compute session summary, trigger async analysis + batch embeddings
// Timeout: 10s

import { insertEvent, queryEvents, getProjectName, getProjectPath, readStdin, isEnabled, pruneOldEvents } from '../lib/db.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __hookDir = dirname(fileURLToPath(import.meta.url));

try {
  const input = await readStdin();
  if (!isEnabled()) process.exit(0);

  const projectPath = getProjectPath(input.cwd);
  const project = getProjectName(projectPath);

  // Skip heavy analysis on /clear (session was cleared, not naturally ended)
  const skipAnalysis = input.reason === 'clear';

  // Fetch all events for this session
  const rawRows = queryEvents({ sessionId: input.session_id });
  const sessionEntries = rawRows.map(row => {
    try { return { ...row, ...JSON.parse(row.data) }; } catch { return row; }
  });

  const prompts = sessionEntries.filter(e => e.type === 'prompt');
  const tools = sessionEntries.filter(e => e.type === 'tool_use');
  const errors = sessionEntries.filter(e => e.type === 'tool_error');

  // Tool usage counts
  const toolCounts = {};
  for (const t of tools) {
    if (t.tool) toolCounts[t.tool] = (toolCounts[t.tool] || 0) + 1;
  }

  // Chronological tool sequence (queryEvents returns DESC)
  const toolsSorted = [...tools].sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const toolSequence = toolsSorted.map(t => t.tool).filter(Boolean);

  // Record session summary event
  insertEvent({
    v: 1,
    type: 'session_summary',
    ts: new Date().toISOString(),
    sessionId: input.session_id,
    project,
    projectPath,
    promptCount: prompts.length,
    toolCounts,
    toolSequence,
    errorCount: errors.length,
    uniqueErrors: [...new Set(errors.map(e => e.error).filter(Boolean))],
    lastPrompts: prompts.slice(0, 3).map(p => (p.text || '').slice(0, 100)),
    lastEditedFiles: [...new Set(
      tools
        .filter(t => t.tool === 'Edit' || t.tool === 'Write')
        .map(t => t.meta?.file)
        .filter(Boolean)
    )].slice(0, 5),
    reason: input.reason || 'unknown'
  });

  // Trigger async AI analysis if enough prompts accumulated
  if (!skipAnalysis && prompts.length >= 5) {
    try {
      const analyzeScript = join(__hookDir, '..', '..', 'bin', 'analyze-runner.mjs');
      const child = spawn('node', [analyzeScript, '--days', '7', '--project', project, '--project-path', projectPath], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
    } catch {
      // Spawn failed — non-blocking
    }
  }

  // Trigger batch embeddings (detached, always)
  try {
    const batchScript = join(__hookDir, '..', 'lib', 'batch-embeddings.mjs');
    const batchChild = spawn('node', [batchScript, projectPath], {
      detached: true,
      stdio: 'ignore'
    });
    batchChild.unref();
  } catch {
    // Spawn failed — non-blocking
  }

  // Probabilistic DB pruning (10% chance per session end)
  if (Math.random() < 0.1) {
    try { pruneOldEvents(); } catch { /* non-blocking */ }
  }

  process.exit(0);
} catch {
  process.exit(0);
}
