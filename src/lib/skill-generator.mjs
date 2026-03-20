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
    const rows = db.prepare('SELECT name FROM generated_skills').all();
    return rows.map(r => r.name);
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
      INSERT INTO generated_skills (ts, name, file_path, suggestion_id, deployed)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(name) DO UPDATE SET
        ts = excluded.ts,
        file_path = excluded.file_path,
        suggestion_id = excluded.suggestion_id
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
