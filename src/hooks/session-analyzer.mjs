#!/usr/bin/env node
// src/hooks/session-analyzer.mjs
// Hook: SessionStart — inject cached analysis + previous session context, start embedding daemon
// Timeout: 10s

import { queryEvents, getProjectName, getProjectPath, readStdin, isEnabled } from '../lib/db.mjs';

try {
  const input = await readStdin();
  if (!isEnabled()) process.exit(0);

  const projectPath = getProjectPath(input.cwd);
  const project = getProjectName(projectPath);
  const isResume = input.source === 'resume';
  const contextParts = [];

  // 1. Inject cached AI analysis (maxAge 24h, lazy import)
  try {
    const { getCachedAnalysis } = await import('../lib/ai-analyzer.mjs');
    const analysis = getCachedAnalysis(24, project);
    if (analysis?.suggestions?.length > 0) {
      let msg = '[Reflexion-Fusion] AI 패턴 분석 결과:\n';
      for (const s of analysis.suggestions.slice(0, 3)) {
        msg += `- [${s.type}] ${s.summary} [id: ${s.id}]\n`;
      }
      msg += '\n사용자에게 이 개선 제안을 알려주세요.';
      msg += '\n사용자가 승인하면 `node ~/.reflexion-fusion/bin/apply.mjs <번호>` 로 적용하세요.';
      msg += '\n사용자가 거부하면 `node ~/.reflexion-fusion/bin/dismiss.mjs <id>` 로 기록하세요.';
      contextParts.push(msg);
    }
  } catch {
    // ai-analyzer.mjs not available yet — skip silently
  }

  // 2. Previous session context
  const recentSummaries = queryEvents({ type: 'session_summary', projectPath, limit: 1 });

  if (recentSummaries.length > 0) {
    const rawRow = recentSummaries[0];
    // Merge top-level row fields with JSON data field
    const prev = (() => {
      try { return { ...rawRow, ...JSON.parse(rawRow.data) }; } catch { return rawRow; }
    })();

    const totalTools = Object.values(prev.toolCounts || {}).reduce((a, b) => a + b, 0);
    const parts = [`[Reflexion-Fusion] 이전 세션 컨텍스트 (${prev.ts}):`];
    parts.push(`- 프롬프트 ${prev.promptCount || 0}개, 도구 ${totalTools}회 사용`);

    if (prev.lastPrompts?.length > 0) {
      parts.push(`- 이전 세션 마지막 작업: ${prev.lastPrompts.map(p => `"${p}"`).join(', ')}`);
    }
    if (prev.lastEditedFiles?.length > 0) {
      parts.push(`- 수정 중이던 파일: ${prev.lastEditedFiles.join(', ')}`);
    }
    if (prev.errorCount > 0) {
      const errPreview = (prev.uniqueErrors || []).slice(0, 2).join(', ');
      parts.push(`- 미해결 에러 ${prev.errorCount}건: ${errPreview}`);
    }
    if (isResume && prev.uniqueErrors?.length > 0) {
      parts.push(`- [RESUME] 미해결 에러 상세: ${prev.uniqueErrors.join(', ')}`);
    }

    const topTools = Object.entries(prev.toolCounts || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t, c]) => `${t}(${c})`)
      .join(', ');
    if (topTools) parts.push(`- 주요 도구: ${topTools}`);

    contextParts.push(parts.join('\n'));
  }

  // 3. Auto-start embedding daemon if not already running
  try {
    const { isServerRunning, startServer } = await import('../lib/embedding-client.mjs');
    if (!await isServerRunning()) {
      await startServer();
    }
  } catch {
    // embedding-client not available or daemon start failed — skip silently
  }

  if (contextParts.length > 0) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: contextParts.join('\n\n')
      }
    }));
  }

  process.exit(0);
} catch {
  process.exit(0);
}
