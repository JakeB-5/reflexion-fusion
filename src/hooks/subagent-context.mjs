#!/usr/bin/env node
// src/hooks/subagent-context.mjs
// Hook: SubagentStart — inject error patterns + AI rules for code-working agents
// Timeout: 5s

import { getDb, getProjectName, getProjectPath, readStdin, isEnabled } from '../lib/db.mjs';

// Agent types that benefit from error pattern injection
const CODE_AGENTS = [
  'executor', 'code-reviewer', 'debugger', 'test-engineer',
  'executor-low', 'executor-high', 'architect', 'build-fixer'
];

try {
  const input = await readStdin();
  if (!isEnabled()) process.exit(0);

  const agentType = input.agent_type || '';

  // Only inject context for code-working agents
  if (!CODE_AGENTS.some(a => agentType.includes(a))) {
    process.exit(0);
  }

  const projectPath = getProjectPath(input.cwd);
  const project = getProjectName(projectPath);
  const parts = [];
  const db = getDb();

  // 1. Top 3 error patterns for this project (ordered by use_count DESC)
  const topErrors = db.prepare(`
    SELECT ek.error_normalized, ek.resolution, ek.use_count
    FROM error_kb ek
    INNER JOIN events e ON json_extract(e.data, '$.error') = ek.error_normalized
    WHERE e.project_path = ? AND ek.resolution IS NOT NULL
    GROUP BY ek.id
    ORDER BY ek.use_count DESC
    LIMIT 3
  `).all(projectPath);

  if (topErrors.length > 0) {
    parts.push('이 프로젝트의 주요 에러 패턴:');
    for (const err of topErrors) {
      parts.push(`- ${err.error_normalized}`);
      try {
        const res = JSON.parse(err.resolution);
        if (res.toolSequence) {
          parts.push(`  해결: ${res.resolvedBy || 'resolved'} → ${res.toolSequence.join(', ')}`);
        } else if (res.resolvedBy) {
          parts.push(`  해결: ${res.resolvedBy}`);
        }
      } catch {
        parts.push(`  해결: ${String(err.resolution).slice(0, 150)}`);
      }
    }
  }

  // 2. Cached AI analysis rules (lazy import — ai-analyzer.mjs may not exist yet)
  try {
    const { getCachedAnalysis } = await import('../lib/ai-analyzer.mjs');
    const analysis = getCachedAnalysis(48, project);
    if (analysis?.suggestions) {
      const rules = analysis.suggestions
        .filter(s => s.type === 'claude_md' && (!s.project || s.project === project))
        .slice(0, 3);
      if (rules.length > 0) {
        parts.push('적용할 프로젝트 규칙:');
        rules.forEach(r => parts.push(`- ${r.rule || r.summary}`));
      }
    }
  } catch {
    // ai-analyzer.mjs not available yet — skip silently
  }

  if (parts.length > 0) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
        additionalContext: parts.join('\n').slice(0, 500)
      }
    }));
  }

  process.exit(0);
} catch {
  process.exit(0);
}
