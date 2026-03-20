#!/usr/bin/env node
// src/mcp/server.mjs
// MCP server for programmatic access to Reflexion-Fusion via JSON-RPC over stdio

import { createInterface } from 'node:readline';
import { statSync } from 'node:fs';

// --- MCP protocol helpers ---

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function err(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: 'analyze',
    description: 'Trigger on-demand AI pattern analysis on collected events',
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Look-back window in days (default: 7)',
        },
        project: {
          type: 'string',
          description: 'Filter by project name (optional)',
        },
        projectPath: {
          type: 'string',
          description: 'Filter by project path (optional)',
        },
      },
    },
  },
  {
    name: 'list-suggestions',
    description: 'Query pending (unapproved) suggestions from generated_skills',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Filter by project path (optional)',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default: 20)',
        },
      },
    },
  },
  {
    name: 'approve-suggestion',
    description: 'Approve and deploy a generated skill suggestion',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'generated_skills row id to approve',
        },
        projectPath: {
          type: 'string',
          description: 'Target project path for deployment (optional)',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'dismiss-suggestion',
    description: 'Record dismissal of a suggestion in feedback (will not be suggested again)',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'generated_skills row id to dismiss',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'status',
    description: 'Return system stats: event counts, pending suggestions, daily eval usage',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// --- Tool handlers ---

async function handleAnalyze(args) {
  const { runAnalysisAsync } = await import('../lib/ai-analyzer.mjs');
  runAnalysisAsync({
    days: args.days || 7,
    project: args.project || null,
    projectPath: args.projectPath || null,
  });
  return { triggered: true, message: 'Analysis started in background' };
}

async function handleListSuggestions(args) {
  const { getDb } = await import('../lib/db.mjs');
  const db = getDb();
  const limit = args.limit || 20;

  let sql = `
    SELECT
      gs.id,
      gs.ts,
      gs.skill_name,
      gs.suggestion_id,
      gs.project_path,
      gs.file_path,
      gs.version,
      gs.approved,
      gs.deployed,
      e.overall_verdict,
      e.status AS eval_status
    FROM generated_skills gs
    LEFT JOIN evaluations e ON gs.evaluation_id = e.id
    WHERE gs.approved = 0 AND gs.deployed = 0
  `;
  const params = [];

  if (args.projectPath) {
    sql += ' AND gs.project_path = ?';
    params.push(args.projectPath);
  }

  sql += ' ORDER BY gs.ts DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  return { suggestions: rows, count: rows.length };
}

async function handleApproveSuggestion(args) {
  const { getDb } = await import('../lib/db.mjs');
  const { recordFeedback } = await import('../lib/feedback-tracker.mjs');
  const db = getDb();

  const row = db.prepare('SELECT * FROM generated_skills WHERE id = ?').get(args.id);
  if (!row) {
    throw new Error(`Suggestion id=${args.id} not found`);
  }
  if (row.deployed) {
    return { alreadyDeployed: true, deployedPath: row.deployed_path };
  }

  // Attempt to use auto-deployer if available; fall back to marking approved only
  let deployedPath = null;
  try {
    const { deploySkill } = await import('../lib/auto-deployer.mjs');
    const result = await deploySkill(row, { projectPath: args.projectPath || row.project_path });
    deployedPath = result.deployedPath;

    db.prepare(`
      UPDATE generated_skills SET approved = 1, deployed = 1, deployed_path = ? WHERE id = ?
    `).run(deployedPath, args.id);
  } catch {
    // auto-deployer not yet available — mark approved only
    db.prepare('UPDATE generated_skills SET approved = 1 WHERE id = ?').run(args.id);
  }

  recordFeedback(
    row.suggestion_id || String(row.id),
    'accepted',
    { suggestionType: 'skill', summary: row.skill_name }
  );

  return {
    approved: true,
    deployed: deployedPath !== null,
    deployedPath,
    skillName: row.skill_name,
  };
}

async function handleDismissSuggestion(args) {
  const { getDb } = await import('../lib/db.mjs');
  const { recordFeedback } = await import('../lib/feedback-tracker.mjs');
  const db = getDb();

  const row = db.prepare('SELECT * FROM generated_skills WHERE id = ?').get(args.id);
  if (!row) {
    throw new Error(`Suggestion id=${args.id} not found`);
  }

  recordFeedback(
    row.suggestion_id || String(row.id),
    'dismissed',
    { suggestionType: 'skill', summary: row.skill_name }
  );

  return { dismissed: true, skillName: row.skill_name };
}

async function handleStatus() {
  const { getDb, DB_PATH } = await import('../lib/db.mjs');
  const db = getDb();

  // Event counts by type
  const eventCounts = db.prepare(`
    SELECT type, COUNT(*) as count FROM events GROUP BY type
  `).all();

  const totalEvents = eventCounts.reduce((sum, r) => sum + r.count, 0);
  const byType = Object.fromEntries(eventCounts.map(r => [r.type, r.count]));

  // Recent 7-day event count
  const since7d = new Date(Date.now() - 7 * 86400000).toISOString();
  const recentEvents = db.prepare(
    'SELECT COUNT(*) as count FROM events WHERE ts >= ?'
  ).get(since7d);

  // Pending suggestions
  const pendingSuggestions = db.prepare(`
    SELECT COUNT(*) as count FROM generated_skills WHERE approved = 0 AND deployed = 0
  `).get();

  // Evaluation stats
  const evalStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN overall_verdict = 'pass' THEN 1 ELSE 0 END) as passed,
      SUM(CASE WHEN overall_verdict = 'fail' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN overall_verdict = 'improve' THEN 1 ELSE 0 END) as improve
    FROM evaluations
  `).get();

  // Daily eval usage (today)
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const dailyEvals = db.prepare(`
    SELECT COUNT(*) as count FROM evaluations WHERE ts >= ?
  `).get(todayStart.toISOString());

  // DB file size
  let dbSizeBytes = 0;
  try {
    dbSizeBytes = statSync(DB_PATH).size;
  } catch { /* ignore */ }

  // Latest analysis timestamp
  const latestAnalysis = db.prepare(
    'SELECT ts FROM analysis_cache ORDER BY ts DESC LIMIT 1'
  ).get();

  return {
    events: {
      total: totalEvents,
      byType,
      last7Days: recentEvents.count,
    },
    suggestions: {
      pending: pendingSuggestions.count,
    },
    evaluations: {
      total: evalStats.total,
      passed: evalStats.passed,
      failed: evalStats.failed,
      improve: evalStats.improve,
      dailyUsage: dailyEvals.count,
      dailyLimit: 5,
    },
    analysis: {
      lastRunAt: latestAnalysis ? latestAnalysis.ts : null,
    },
    system: {
      dbSizeBytes,
      dbSizeMB: Math.round(dbSizeBytes / 1024 / 1024 * 100) / 100,
    },
  };
}

// --- Dispatch ---

async function callTool(name, args) {
  switch (name) {
    case 'analyze':           return handleAnalyze(args);
    case 'list-suggestions':  return handleListSuggestions(args);
    case 'approve-suggestion': return handleApproveSuggestion(args);
    case 'dismiss-suggestion': return handleDismissSuggestion(args);
    case 'status':            return handleStatus();
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
  }
}

// --- Main loop ---

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line.trim());
  } catch {
    // Ignore malformed input
    return;
  }

  const { id, method, params } = msg;

  try {
    if (method === 'initialize') {
      ok(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'reflexion-fusion', version: '1.0.0' },
      });
      return;
    }

    if (method === 'tools/list') {
      ok(id, { tools: TOOLS });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const result = await callTool(toolName, toolArgs);
        ok(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (toolErr) {
        const code = toolErr.code || -32603;
        err(id, code, toolErr.message);
      }
      return;
    }

    // Method not found
    err(id, -32601, `Method not found: ${method}`);
  } catch (fatal) {
    err(id ?? null, -32603, String(fatal));
  }
});

rl.on('close', () => {
  process.exit(0);
});
