// src/lib/skill-generator.mjs
// SKILL.md generation using Claude headless mode (claude --print)

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb, GENERATED_DIR } from './db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_TEMPLATE = join(__dirname, '..', 'prompts', 'generate-skill.md');
const CLAUDE_MD_TEMPLATE = join(__dirname, '..', 'prompts', 'generate-claude-md.md');
const HOOK_TEMPLATE = join(__dirname, '..', 'prompts', 'generate-hook.md');

/**
 * Extract content from a fenced ```skill block or the raw response.
 */
function extractSkillContent(text) {
  const fenced = text.match(/```skill\s*([\s\S]*?)\s*```/);
  if (fenced) return fenced[1].trim();
  // Fallback: look for YAML frontmatter start
  const raw = text.match(/(---[\s\S]*)/);
  return raw ? raw[1].trim() : text.trim();
}

/**
 * Extract JSON block from Claude response.
 */
function extractJSON(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (fenced) return fenced[1];
  const raw = text.match(/\{[\s\S]*\}/);
  return raw ? raw[0] : text;
}

/**
 * Load existing skill names from the generated_skills table for dedup context.
 */
function loadExistingSkillNames() {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT skill_name FROM generated_skills').all();
    return rows.map(r => r.skill_name);
  } catch {
    return [];
  }
}

/**
 * Ensure the generated skills directory exists.
 */
function ensureGeneratedDir() {
  if (!existsSync(GENERATED_DIR)) {
    mkdirSync(GENERATED_DIR, { recursive: true });
  }
}

/**
 * Call Claude headless with a prompt, return raw output string.
 */
function callClaude(prompt) {
  return execSync('claude --print --model sonnet', {
    input: prompt,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120000,
  });
}

/**
 * Find an existing generated skill with the same name.
 * Used as a duplicate detection gate before generating a new skill.
 *
 * @param {Object} suggestion - Suggestion from analysis
 * @returns {{skillName: string, content: string, filePath: string, id: number}|null}
 */
export function findExistingSkill(suggestion) {
  if (!suggestion.skillName) return null;

  try {
    const db = getDb();
    const row = db.prepare(
      'SELECT id, skill_name, file_path FROM generated_skills WHERE skill_name = ? ORDER BY ts DESC LIMIT 1'
    ).get(suggestion.skillName);

    if (row && existsSync(row.file_path)) {
      return {
        skillName: row.skill_name,
        content: readFileSync(row.file_path, 'utf-8'),
        filePath: row.file_path,
        id: row.id,
      };
    }
  } catch {
    // DB/file errors are non-fatal for dedup check
  }

  return null;
}

/**
 * Regenerate/improve an existing SKILL.md based on evaluation feedback.
 * Used by the evaluator's improve loop and the duplicate-detection path.
 *
 * @param {string} existingContent - Current SKILL.md content
 * @param {string[]} suggestions - Improvement suggestions from analyzer
 * @param {string} [revisedDescription] - Optional improved description text
 * @returns {string} Improved SKILL.md content
 */
export function regenerateSkill(existingContent, suggestions = [], revisedDescription) {
  const prompt = [
    '아래 SKILL.md의 내용을 개선하세요. 평가 결과 다음과 같은 개선사항이 도출되었습니다.',
    '',
    '## 현재 SKILL.md',
    existingContent,
    '',
    '## 개선 제안',
    ...suggestions.map((s, i) => `${i + 1}. ${s}`),
    '',
    ...(revisedDescription ? ['## 개선된 설명', revisedDescription, ''] : []),
    '## 지시사항',
    '- 기존 스킬의 name과 핵심 목적을 유지하세요.',
    '- 개선 제안을 반영하여 description, 감지된 패턴, 지시사항을 개선하세요.',
    '- YAML frontmatter 형식을 유지하세요 (---로 시작/끝).',
    '- 개선된 SKILL.md 전체 내용만 출력하세요 (설명 없이).',
  ].join('\n');

  const rawOutput = callClaude(prompt);
  return extractSkillContent(rawOutput);
}

/**
 * Generate a SKILL.md file from a suggestion via Claude headless.
 * Saves the file to ~/.reflexion-fusion/generated/<name>.md and records it in DB.
 *
 * @param {Object} suggestion - Suggestion object from analysis (type must be 'skill')
 * @param {string[]} [examplePrompts=[]] - Representative prompts from the cluster
 * @param {string[]} [exampleTools=[]]   - Representative tool sequences
 * @returns {Promise<{filePath: string, skillName: string, content: string}>}
 */
export async function generateSkill(suggestion, examplePrompts = [], exampleTools = []) {
  const existingSkills = loadExistingSkillNames();

  // Duplicate detection: improve existing skill instead of creating new
  const existing = findExistingSkill(suggestion);
  if (existing) {
    const improvedContent = regenerateSkill(
      existing.content,
      [suggestion.summary || suggestion.action || 'Improve based on new pattern analysis'],
    );
    writeFileSync(existing.filePath, improvedContent, 'utf-8');

    // Bump version in DB
    try {
      const db = getDb();
      db.prepare(
        'UPDATE generated_skills SET ts = ?, version = version + 1 WHERE id = ?'
      ).run(new Date().toISOString(), existing.id);
    } catch {
      // Non-fatal
    }

    return { filePath: existing.filePath, skillName: existing.skillName, content: improvedContent };
  }

  // Build prompt from template
  let template = readFileSync(SKILL_TEMPLATE, 'utf-8');
  template = template.replace('{{suggestion}}', JSON.stringify(suggestion, null, 2));
  template = template.replace('{{example_prompts}}', JSON.stringify(examplePrompts, null, 2));
  template = template.replace('{{example_tools}}', JSON.stringify(exampleTools, null, 2));
  template = template.replace(
    '{{existing_skills}}',
    existingSkills.length > 0 ? existingSkills.join('\n') : '없음'
  );

  const rawOutput = callClaude(template);
  const content = extractSkillContent(rawOutput);

  // Derive skill name from suggestion or frontmatter
  let skillName = suggestion.skillName;
  if (!skillName) {
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    skillName = nameMatch ? nameMatch[1].trim() : `skill-${Date.now()}`;
  }

  // Sanitize name for use as filename
  const safeName = skillName.replace(/[^a-z0-9-_]/gi, '-').toLowerCase();
  const fileName = `${safeName}.md`;

  ensureGeneratedDir();
  const filePath = join(GENERATED_DIR, fileName);
  writeFileSync(filePath, content, 'utf-8');

  // Record in generated_skills table
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO generated_skills (ts, skill_name, file_path, suggestion_id, deployed)
      VALUES (?, ?, ?, ?, 0)
    `).run(new Date().toISOString(), skillName, filePath, suggestion.id || null);
  } catch {
    // DB insert failure is non-fatal — file is already written
  }

  return { filePath, skillName, content };
}

/**
 * Generate a CLAUDE.md rule text from a suggestion via Claude headless.
 * Returns the rule string and its intended scope.
 *
 * @param {Object} suggestion - Suggestion object (type must be 'claude_md')
 * @returns {Promise<{rule: string, scope: 'global'|'project'}>}
 */
export async function generateClaudeMdRule(suggestion) {
  // Use inline prompt when template file is absent (graceful fallback)
  let template;
  try {
    template = readFileSync(CLAUDE_MD_TEMPLATE, 'utf-8');
    template = template.replace('{{suggestion}}', JSON.stringify(suggestion, null, 2));
  } catch {
    template = [
      '다음 제안을 바탕으로 CLAUDE.md에 추가할 지침 규칙을 생성하세요.',
      '',
      '## 제안',
      JSON.stringify(suggestion, null, 2),
      '',
      '## 출력 형식',
      'JSON으로만 응답하세요:',
      '```json',
      '{"rule": "규칙 텍스트", "scope": "global|project"}',
      '```',
    ].join('\n');
  }

  const rawOutput = callClaude(template);

  try {
    const parsed = JSON.parse(extractJSON(rawOutput));
    return {
      rule: parsed.rule || suggestion.rule || suggestion.summary,
      scope: parsed.scope === 'project' ? 'project' : 'global',
    };
  } catch {
    // Parse failure — use suggestion data directly
    return {
      rule: suggestion.rule || suggestion.summary || suggestion.action || '',
      scope: 'global',
    };
  }
}

/**
 * Generate hook workflow code from a suggestion via Claude headless.
 * Returns executable hook code, the target event, and a description.
 *
 * @param {Object} suggestion - Suggestion object (type must be 'hook')
 * @returns {Promise<{code: string, hookEvent: string, description: string}>}
 */
export async function generateHookWorkflow(suggestion) {
  let template;
  try {
    template = readFileSync(HOOK_TEMPLATE, 'utf-8');
    template = template.replace('{{suggestion}}', JSON.stringify(suggestion, null, 2));
  } catch {
    template = [
      '다음 제안을 바탕으로 Claude Code 훅 워크플로우 스크립트를 생성하세요.',
      '',
      '## 제안',
      JSON.stringify(suggestion, null, 2),
      '',
      '## 출력 형식',
      'JSON으로만 응답하세요:',
      '```json',
      '{',
      '  "code": "// Node.js ES module hook script\\n...",',
      '  "hookEvent": "PostToolUse|PreToolUse|SessionEnd|...",',
      '  "description": "훅 동작 설명"',
      '}',
      '```',
    ].join('\n');
  }

  const rawOutput = callClaude(template);

  try {
    const parsed = JSON.parse(extractJSON(rawOutput));
    return {
      code: parsed.code || suggestion.hookCode || '',
      hookEvent: parsed.hookEvent || suggestion.hookEvent || 'PostToolUse',
      description: parsed.description || suggestion.summary || '',
    };
  } catch {
    return {
      code: suggestion.hookCode || '',
      hookEvent: suggestion.hookEvent || 'PostToolUse',
      description: suggestion.summary || '',
    };
  }
}
