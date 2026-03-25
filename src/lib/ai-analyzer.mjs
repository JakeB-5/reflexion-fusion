// src/lib/ai-analyzer.mjs
// AI pattern analysis using Claude headless mode (claude --print)

import { execSync, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  getDb,
  queryEvents,
  contentHash,
  acquireAnalysisLock,
  releaseAnalysisLock,
  GLOBAL_DIR,
} from './db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_TEMPLATE = join(__dirname, '..', 'prompts', 'analyze.md');

/**
 * Compute SHA-256 hash of event list as CSV fingerprint.
 * Same events → same hash → cache hit, no redundant AI call.
 */
function computeInputHash(events) {
  const csv = events
    .map(e => `${e.type}:${e.ts}:${e.session_id || e.sessionId}:${JSON.stringify(e.data || e)}`)
    .join('\n');
  return contentHash(csv);
}

/**
 * Summarize event list into a compact object for prompt injection.
 * Keeps token usage bounded (max 100 prompts, session-wise tool sequences).
 */
function summarizeForPrompt(entries, maxPrompts = 100) {
  const prompts = entries
    .filter(e => e.type === 'prompt')
    .slice(-maxPrompts)
    .map(e => ({ ts: e.ts, text: e.text, project: e.project }));

  const tools = entries.filter(e => e.type === 'tool_use');
  const errors = entries.filter(e => e.type === 'tool_error');
  const summaries = entries.filter(e => e.type === 'session_summary');

  // Build per-session tool sequences
  const sessionTools = {};
  for (const t of tools) {
    const sid = t.session_id || t.sessionId;
    if (!sessionTools[sid]) sessionTools[sid] = [];
    sessionTools[sid].push(t.tool || t.toolName);
  }

  return {
    prompts,
    toolSequences: Object.values(sessionTools).map(seq => seq.join(' → ')),
    errors: errors.map(e => ({ tool: e.tool || e.toolName, error: e.error, raw: e.errorRaw })),
    sessionCount: summaries.length,
    toolTotal: tools.length,
  };
}

/**
 * Build analysis prompt from template file.
 * Injects: log summary, days, project, feedback history, existing skills.
 */
async function buildPrompt(logSummary, days, project, projectPath) {
  let template = readFileSync(PROMPT_TEMPLATE, 'utf-8');
  template = template.replace('{{days}}', String(days));
  template = template.replace('{{project}}', project || 'all');
  template = template.replace('{{log_data}}', JSON.stringify(logSummary, null, 2));

  // Feedback history (graceful fallback)
  let feedbackText = '피드백 이력 없음 (첫 분석)';
  try {
    const { getFeedbackSummary } = await import('./feedback-tracker.mjs');
    const summary = getFeedbackSummary();
    if (summary) feedbackText = JSON.stringify(summary, null, 2);
  } catch {
    // feedback-tracker not available
  }
  template = template.replace('{{feedback_history}}', feedbackText);

  // Existing skills (graceful fallback)
  let skillsText = '등록된 스킬 없음';
  try {
    const { loadSkills } = await import('./skill-matcher.mjs');
    const resolvedPath = projectPath || null;
    const skills = loadSkills(resolvedPath);
    if (skills && skills.length > 0) {
      skillsText = skills.map(s => `- ${s.name}: ${s.description || ''}`).join('\n');
    }
  } catch {
    // skill-matcher not available
  }
  template = template.replace('{{existing_skills}}', skillsText);

  return template;
}

/**
 * Extract JSON block from Claude response.
 * Handles ```json ... ``` fenced blocks or balanced brace matching.
 * Resilient to noisy output from other plugins mixed into stdout.
 */
function extractJSON(text) {
  // Prefer fenced ```json block (most reliable)
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (fenced) {
    try { JSON.parse(fenced[1]); return fenced[1]; } catch { /* fall through */ }
  }

  // Balanced brace extraction: find the first { and match balanced braces
  const start = text.indexOf('{');
  if (start === -1) return text;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try { JSON.parse(candidate); return candidate; } catch { /* try next */ }
      }
    }
  }

  // Last resort: greedy match
  const raw = text.match(/\{[\s\S]*\}/);
  return raw ? raw[0] : text;
}

/**
 * Run AI analysis on collected events.
 * Acquires advisory lock, checks cache, calls claude --print, caches result.
 *
 * @param {Object} options
 * @param {number} [options.days=7]        - Look-back window in days
 * @param {string|null} [options.project]  - Project name filter
 * @param {string|null} [options.projectPath] - Project path filter
 * @returns {Promise<Object>} {suggestions, clusters, workflows, errorPatterns} or {suggestions:[], error|reason}
 */
export async function runAnalysis(options = {}) {
  const { days = 7, project = null, projectPath = null } = options;

  // Advisory lock — prevent concurrent analysis runs
  if (!acquireAnalysisLock()) {
    return { suggestions: [], reason: 'analysis_locked' };
  }

  try {
    const db = getDb();

    // Query events in the look-back window
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const entries = queryEvents({ since, project, projectPath });

    // Require at least 5 prompt events
    const promptCount = entries.filter(e => e.type === 'prompt').length;
    if (promptCount < 5) {
      return { suggestions: [], reason: 'insufficient_data' };
    }

    // Content-addressable cache check (same input → skip AI call)
    const inputHash = computeInputHash(entries);
    const projectKey = project || 'all';

    const cached = db.prepare(`
      SELECT analysis FROM analysis_cache
      WHERE project = ? AND days = ? AND input_hash = ?
    `).get(projectKey, days, inputHash);

    if (cached) {
      return JSON.parse(cached.analysis);
    }

    // Build prompt with summarized data injected
    const logSummary = summarizeForPrompt(entries);
    const prompt = await buildPrompt(logSummary, days, project, projectPath);

    // Call Claude in headless mode
    const rawOutput = execSync('claude --print --model sonnet', {
      input: prompt,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120000,
    });

    const analysis = JSON.parse(extractJSON(rawOutput));

    // Persist result in analysis_cache (UPSERT)
    db.prepare(`
      INSERT INTO analysis_cache (ts, project, days, input_hash, analysis)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project, days, input_hash)
      DO UPDATE SET ts = excluded.ts, analysis = excluded.analysis
    `).run(new Date().toISOString(), projectKey, days, inputHash, JSON.stringify(analysis));

    return analysis;
  } catch (err) {
    return { suggestions: [], error: err.message };
  } finally {
    releaseAnalysisLock();
  }
}

/**
 * Spawn analysis as a detached background process (fire-and-forget).
 * Called from SessionEnd hook — must not block hook execution.
 *
 * @param {Object} options - Same options as runAnalysis
 */
export function runAnalysisAsync(options = {}) {
  const { days = 7, project = null, projectPath = null } = options;

  // Resolve absolute path to the runner script
  const runnerPath = join(__dirname, '..', '..', 'bin', 'analyze-runner.mjs');

  const args = [
    runnerPath,
    '--days', String(days),
    ...(project ? ['--project', project] : []),
    ...(projectPath ? ['--project-path', projectPath] : []),
  ];

  const child = spawn('node', args, {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();
}

/**
 * Retrieve most recent cached analysis from DB.
 * Called from SessionStart hook to inject context without triggering AI.
 *
 * @param {number} [maxAgeHours=24] - Maximum acceptable cache age
 * @param {string|null} [project]   - Project filter (null → 'all')
 * @returns {Object|null} Parsed analysis or null on miss/error
 */
export function getCachedAnalysis(maxAgeHours = 24, project = null) {
  try {
    const db = getDb();
    const cutoff = new Date(Date.now() - maxAgeHours * 3600000).toISOString();
    const projectKey = project || 'all';

    const row = db.prepare(`
      SELECT analysis FROM analysis_cache
      WHERE ts >= ? AND project = ?
      ORDER BY ts DESC LIMIT 1
    `).get(cutoff, projectKey);

    if (!row) return null;
    return JSON.parse(row.analysis);
  } catch {
    return null;
  }
}
