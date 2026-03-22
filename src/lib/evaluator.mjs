// src/lib/evaluator.mjs
// Evaluation orchestrator — 2-stage gate strategy (validation → blind grading)

import { execSync } from 'child_process';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.mjs';
import { validateAll } from './skill-validator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, '..', 'prompts');
const AGENTS_DIR = join(__dirname, '..', '..', 'agents');

// Daily evaluation limit per project (prevents runaway AI costs)
const DAILY_EVAL_LIMIT = 5;

// Max retry iterations for improve verdict
const MAX_ITERATIONS = 3;

// ── Prompt loading helpers ──────────────────────────────────────────────────

/**
 * Load agent prompt file, with inline fallback if file is absent.
 */
function loadPrompt(agentName, fallback) {
  // Try agents/<agentName>/<agentName>.md first, then src/prompts/<agentName>.md
  const candidates = [
    join(AGENTS_DIR, agentName, `${agentName}.md`),
    join(PROMPTS_DIR, `${agentName}.md`),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf-8');
  }
  return fallback;
}

// ── Claude headless helper ──────────────────────────────────────────────────

/**
 * Run claude --print with a prompt (and optional --system-prompt).
 * Returns raw stdout string.
 *
 * @param {string} prompt
 * @param {string} [systemPrompt]
 * @returns {string}
 */
function runClaude(prompt, systemPrompt) {
  const args = ['--print', '--model', 'sonnet'];
  if (systemPrompt) {
    args.push('--system-prompt', systemPrompt);
  }
  return execSync(`claude ${args.join(' ')}`, {
    input: prompt,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120000,
  });
}

/**
 * Extract JSON object from Claude response (fenced or raw).
 */
function extractJSON(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch { /* fall through */ }
  }
  const raw = text.match(/\{[\s\S]*\}/);
  if (raw) {
    try { return JSON.parse(raw[0]); } catch { /* fall through */ }
  }
  return null;
}

// ── DB helpers ──────────────────────────────────────────────────────────────

/**
 * Insert or update an evaluation row, returning its id.
 */
function upsertEvaluation(db, skillName, projectPath, suggestionId) {
  const existing = db.prepare(
    'SELECT id FROM evaluations WHERE skill_name = ? AND project_path IS ? AND status != ?'
  ).get(skillName, projectPath || null, 'complete');

  if (existing) {
    db.prepare('UPDATE evaluations SET ts = ?, status = ?, error_message = NULL WHERE id = ?')
      .run(new Date().toISOString(), 'pending', existing.id);
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO evaluations (v, ts, skill_name, suggestion_id, project_path, status, iteration)
    VALUES (1, ?, ?, ?, ?, 'pending', 1)
  `).run(new Date().toISOString(), skillName, suggestionId || null, projectPath || null);

  return result.lastInsertRowid;
}

function setStatus(db, evalId, status) {
  db.prepare('UPDATE evaluations SET status = ? WHERE id = ?').run(status, evalId);
}

function setFailed(db, evalId, message) {
  db.prepare('UPDATE evaluations SET status = ?, error_message = ? WHERE id = ?')
    .run('failed', message, evalId);
}

function setComplete(db, evalId, fields) {
  db.prepare(`
    UPDATE evaluations
    SET status = 'complete',
        validation = ?,
        grading = ?,
        comparison = ?,
        analysis = ?,
        overall_verdict = ?,
        iteration = ?
    WHERE id = ?
  `).run(
    JSON.stringify(fields.validation || null),
    JSON.stringify(fields.grading || null),
    JSON.stringify(fields.comparison || null),
    JSON.stringify(fields.analysis || null),
    fields.verdict || null,
    fields.iteration || 1,
    evalId,
  );
}

// ── Stage helpers ───────────────────────────────────────────────────────────

/**
 * Generate 2-3 representative test prompts for the given skill content.
 * Returns array of prompt strings.
 */
function generateTestPrompts(skillContent) {
  const prompt = [
    '아래 SKILL.md 내용을 보고 이 스킬을 트리거할 수 있는 사용자 프롬프트 2~3개를 생성하세요.',
    '각 프롬프트는 실제 사용자가 Claude Code에 입력할 법한 자연어 문장이어야 합니다.',
    '',
    '## SKILL.md',
    skillContent,
    '',
    '## 출력 형식 (JSON만 출력)',
    '```json',
    '{"prompts": ["프롬프트1", "프롬프트2", "프롬프트3"]}',
    '```',
  ].join('\n');

  try {
    const raw = runClaude(prompt);
    const parsed = extractJSON(raw);
    if (parsed && Array.isArray(parsed.prompts)) return parsed.prompts.slice(0, 3);
  } catch { /* fall through */ }

  // Fallback: generic prompts derived from skill description
  return ['이 스킬의 기능을 실행해주세요.', '해당 작업을 도와주세요.'];
}

/**
 * Run a test prompt with a given system prompt (or without), return response.
 */
function runTestCase(userPrompt, systemPrompt) {
  try {
    return runClaude(userPrompt, systemPrompt);
  } catch (err) {
    return `[error: ${err.message}]`;
  }
}

/**
 * Grade skill-applied vs baseline responses.
 * Returns {score: number, reasoning: string, verdict: 'pass'|'fail'|'improve'}
 */
function gradeResponses(skillContent, testPrompt, baselineResponse, skillResponse) {
  const graderPrompt = loadPrompt('grader', [
    '당신은 AI 어시스턴트 응답의 품질을 평가하는 전문 평가자입니다.',
    '',
    '## 평가 기준',
    '1. 정확성 (Accuracy): 사용자 요청을 올바르게 이해하고 수행했는가?',
    '2. 완전성 (Completeness): 필요한 단계를 모두 포함했는가?',
    '3. 명확성 (Clarity): 지시가 명확하고 따르기 쉬운가?',
    '',
    '## 스킬 내용',
    skillContent,
    '',
    '## 테스트 프롬프트',
    testPrompt,
    '',
    '## 기준선 응답 (스킬 없음)',
    baselineResponse,
    '',
    '## 스킬 적용 응답',
    skillResponse,
    '',
    '## 출력 형식 (JSON만 출력)',
    '```json',
    '{"baseline_score": 0~10, "skill_score": 0~10, "reasoning": "평가 이유", "verdict": "pass|fail|improve"}',
    '```',
  ].join('\n'));

  try {
    const raw = runClaude(graderPrompt);
    const parsed = extractJSON(raw);
    if (parsed && parsed.verdict) return parsed;
  } catch { /* fall through */ }

  return { baseline_score: 5, skill_score: 5, reasoning: 'grading failed', verdict: 'improve' };
}

/**
 * Compare overall evaluation results across all test cases.
 * Returns {verdict: 'pass'|'fail'|'improve', summary: string, suggestions: string[]}
 */
function compareResults(skillContent, gradingResults) {
  const comparatorPrompt = loadPrompt('comparator', [
    '당신은 스킬 평가 결과를 종합적으로 분석하는 전문가입니다.',
    '',
    '## 스킬 내용',
    skillContent,
    '',
    '## 개별 테스트 케이스 채점 결과',
    JSON.stringify(gradingResults, null, 2),
    '',
    '위 결과를 바탕으로 이 스킬의 최종 평가를 내려주세요.',
    '- pass: 모든 또는 대부분의 테스트에서 스킬이 기준선보다 명확히 개선됨',
    '- improve: 일부 개선되었으나 수정이 필요한 부분 있음',
    '- fail: 스킬이 도움이 되지 않거나 오히려 해를 끼침',
    '',
    '## 출력 형식 (JSON만 출력)',
    '```json',
    '{"verdict": "pass|fail|improve", "summary": "종합 평가 요약", "suggestions": ["개선사항1", "개선사항2"]}',
    '```',
  ].join('\n'));

  try {
    const raw = runClaude(comparatorPrompt);
    const parsed = extractJSON(raw);
    if (parsed && parsed.verdict) return parsed;
  } catch { /* fall through */ }

  return { verdict: 'improve', summary: 'comparison failed', suggestions: [] };
}

/**
 * Analyze failure and produce improvement suggestions.
 * Returns {suggestions: string[], revised_description: string}
 */
function analyzeFailure(skillContent, gradingResults, comparisonResult) {
  const analyzerPrompt = loadPrompt('analyzer', [
    '당신은 스킬 품질 개선 전문가입니다. 아래 평가 결과를 바탕으로 스킬을 어떻게 개선해야 하는지 분석하세요.',
    '',
    '## 현재 스킬 내용',
    skillContent,
    '',
    '## 채점 결과',
    JSON.stringify(gradingResults, null, 2),
    '',
    '## 비교 분석 결과',
    JSON.stringify(comparisonResult, null, 2),
    '',
    '## 출력 형식 (JSON만 출력)',
    '```json',
    '{"suggestions": ["구체적 개선사항1", "구체적 개선사항2"], "revised_description": "개선된 description 텍스트"}',
    '```',
  ].join('\n'));

  try {
    const raw = runClaude(analyzerPrompt);
    const parsed = extractJSON(raw);
    if (parsed) return parsed;
  } catch { /* fall through */ }

  return { suggestions: ['스킬 내용을 더 구체적으로 작성하세요.'], revised_description: '' };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Full evaluation pipeline for a SKILL.md file.
 * 2-stage gate: Stage 1 (structural validation) → Stage 2 (blind AI grading).
 * Up to MAX_ITERATIONS retry loops on 'improve' verdict.
 *
 * @param {string} skillFilePath - Absolute path to the SKILL.md file
 * @param {Object} [options]
 * @param {string} [options.projectPath] - Project path for DB tracking
 * @param {string} [options.suggestionId] - Linked suggestion ID
 * @returns {Promise<{verdict: 'pass'|'fail'|'improve', evaluation: Object}>}
 */
export async function evaluateSkill(skillFilePath, options = {}) {
  const { projectPath = null, suggestionId = null } = options;
  const db = getDb();

  // Extract skill name from file path
  const skillName = skillFilePath.replace(/^.*[\\/]/, '').replace(/\.md$/, '');

  // Create evaluation record
  const evalId = upsertEvaluation(db, skillName, projectPath, suggestionId);

  // ── Stage 1: Structural validation ─────────────────────────────────────
  setStatus(db, evalId, 'validating');

  let validationResult;
  try {
    validationResult = await validateAll(skillFilePath);
  } catch (err) {
    setFailed(db, evalId, `validation error: ${err.message}`);
    return {
      verdict: 'fail',
      evaluation: { id: evalId, stage: 'validation', error: err.message },
    };
  }

  if (!validationResult.valid) {
    setFailed(db, evalId, `validation failed: ${validationResult.errors.join('; ')}`);
    return {
      verdict: 'fail',
      evaluation: {
        id: evalId,
        stage: 'validation',
        errors: validationResult.errors,
        warnings: validationResult.warnings,
      },
    };
  }

  // ── Stage 2: Blind AI grading ───────────────────────────────────────────
  setStatus(db, evalId, 'grading');

  let skillContent;
  try {
    skillContent = readFileSync(skillFilePath, 'utf-8');
  } catch (err) {
    setFailed(db, evalId, `cannot read skill file: ${err.message}`);
    return {
      verdict: 'fail',
      evaluation: { id: evalId, stage: 'grading', error: err.message },
    };
  }

  let iteration = 1;
  let finalVerdict = 'fail';
  let finalGrading = null;
  let finalComparison = null;
  let finalAnalysis = null;

  while (iteration <= MAX_ITERATIONS) {
    // Update iteration counter
    db.prepare('UPDATE evaluations SET iteration = ? WHERE id = ?').run(iteration, evalId);

    // Generate test prompts (1 Claude call)
    const testPrompts = generateTestPrompts(skillContent);

    // Run skill applied vs baseline (2 calls per test prompt)
    const gradingResults = [];
    for (const testPrompt of testPrompts) {
      setStatus(db, evalId, 'grading');

      const baselineResponse = runTestCase(testPrompt, undefined);
      const skillResponse = runTestCase(testPrompt, skillContent);

      const grading = gradeResponses(skillContent, testPrompt, baselineResponse, skillResponse);
      gradingResults.push({ testPrompt, baselineResponse, skillResponse, grading });
    }

    finalGrading = gradingResults;

    // Compare results
    setStatus(db, evalId, 'comparing');
    const comparison = compareResults(skillContent, gradingResults);
    finalComparison = comparison;

    if (comparison.verdict === 'pass') {
      finalVerdict = 'pass';
      break;
    }

    if (comparison.verdict === 'fail') {
      // Analyze failure before giving up
      setStatus(db, evalId, 'analyzing');
      finalAnalysis = analyzeFailure(skillContent, gradingResults, comparison);
      finalVerdict = 'fail';
      break;
    }

    // verdict === 'improve': run analyzer, regenerate skill, and loop
    setStatus(db, evalId, 'analyzing');
    finalAnalysis = analyzeFailure(skillContent, gradingResults, comparison);
    finalVerdict = 'improve';

    // Regenerate skill content based on analyzer feedback
    if (finalAnalysis && finalAnalysis.suggestions && finalAnalysis.suggestions.length > 0) {
      try {
        const { regenerateSkill } = await import('./skill-generator.mjs');
        skillContent = regenerateSkill(
          skillContent,
          finalAnalysis.suggestions,
          finalAnalysis.revised_description,
        );
        writeFileSync(skillFilePath, skillContent, 'utf-8');
      } catch {
        // Regeneration failure is non-fatal — continue with current content
      }
    }

    if (iteration >= MAX_ITERATIONS) break;
    iteration++;
  }

  // Persist final result
  setComplete(db, evalId, {
    validation: validationResult,
    grading: finalGrading,
    comparison: finalComparison,
    analysis: finalAnalysis,
    verdict: finalVerdict,
    iteration,
  });

  return {
    verdict: finalVerdict,
    evaluation: {
      id: evalId,
      iteration,
      validation: validationResult,
      grading: finalGrading,
      comparison: finalComparison,
      analysis: finalAnalysis,
    },
  };
}

/**
 * Find a skill by name in generated_skills and run evaluateSkill on it.
 *
 * @param {string} skillName - Skill name to look up
 * @param {Object} [options] - Same options as evaluateSkill
 * @returns {Promise<{verdict: string, evaluation: Object}>}
 */
export async function evaluateOnDemand(skillName, options = {}) {
  const db = getDb();

  const row = db.prepare(
    'SELECT file_path, project_path, suggestion_id FROM generated_skills WHERE skill_name = ? ORDER BY ts DESC LIMIT 1'
  ).get(skillName);

  if (!row) {
    return {
      verdict: 'fail',
      evaluation: { error: `Skill not found in generated_skills: ${skillName}` },
    };
  }

  if (!existsSync(row.file_path)) {
    return {
      verdict: 'fail',
      evaluation: { error: `Skill file missing on disk: ${row.file_path}` },
    };
  }

  return evaluateSkill(row.file_path, {
    projectPath: options.projectPath || row.project_path,
    suggestionId: options.suggestionId || row.suggestion_id,
  });
}

/**
 * Check how many evaluations have been run today for the given project.
 * Returns true if under the daily limit, false if at or over.
 *
 * @param {string|null} projectPath
 * @returns {boolean} true = within limit, false = limit reached
 */
export function checkDailyLimit(projectPath) {
  try {
    const db = getDb();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const count = db.prepare(`
      SELECT COUNT(*) as cnt FROM evaluations
      WHERE ts >= ?
        AND (project_path IS ? OR ? IS NULL)
    `).get(todayStart.toISOString(), projectPath || null, projectPath || null);

    return (count?.cnt ?? 0) < DAILY_EVAL_LIMIT;
  } catch {
    return true; // fail open — don't block on DB errors
  }
}
