// src/lib/skill-validator.mjs
// Stage 1 local structural validation — free, no AI, runs before any generation cost

import { readFileSync } from 'fs';
import { getDb, vectorSearch, generateEmbeddings } from './db.mjs';

// Minimum similarity distance below which a skill is considered a duplicate
// (cosine distance: 0 = identical, 2 = opposite — lower is more similar)
const DUPLICATE_THRESHOLD = 0.76;

// Action verbs that indicate an actionable skill description
const ACTION_VERBS = [
  'use', 'run', 'create', 'add', 'generate', 'build', 'fix', 'check', 'update',
  'install', 'set', 'apply', 'configure', 'initialize', 'init', 'deploy', 'test',
  'migrate', 'refactor', 'analyze', 'validate', 'format', 'lint', 'setup',
  '사용', '실행', '생성', '추가', '빌드', '수정', '확인', '업데이트', '설치',
  '설정', '적용', '초기화', '배포', '테스트', '분석', '검증',
];

/**
 * Parse YAML frontmatter from SKILL.md content.
 * Splits on /^---$/m delimiters and extracts key: value pairs.
 *
 * @param {string} content - Raw file content
 * @returns {{frontmatter: Object, body: string, raw: string}}
 */
function parseFrontmatter(content) {
  const parts = content.split(/^---\s*$/m);
  // Expect: ['', '<yaml>', '<body>'] for a file that starts with ---
  if (parts.length < 3) {
    return { frontmatter: {}, body: content, raw: '' };
  }

  const raw = parts[1];
  const body = parts.slice(2).join('---').trim();
  const frontmatter = {};

  // Parse key: value and key: | (block scalar) pairs
  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const keyMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (!keyMatch) { i++; continue; }

    const key = keyMatch[1];
    const valueInline = keyMatch[2].trim();

    if (valueInline === '|' || valueInline === '>') {
      // Multi-line block scalar: collect indented lines
      const blockLines = [];
      i++;
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i] === '')) {
        blockLines.push(lines[i].replace(/^  /, ''));
        i++;
      }
      frontmatter[key] = blockLines.join('\n').trim();
    } else {
      frontmatter[key] = valueInline;
      i++;
    }
  }

  return { frontmatter, body, raw };
}

/**
 * Parse and validate the overall structure of a SKILL.md file.
 *
 * @param {string} skillFilePath - Absolute path to the .md file
 * @returns {{valid: boolean, frontmatter: Object, body: string, errors: string[], warnings: string[]}}
 */
export function validateStructure(skillFilePath) {
  const errors = [];
  const warnings = [];

  let content;
  try {
    content = readFileSync(skillFilePath, 'utf-8');
  } catch (err) {
    return { valid: false, frontmatter: {}, body: '', errors: [`Cannot read file: ${err.message}`], warnings };
  }

  if (!content.trim()) {
    return { valid: false, frontmatter: {}, body: '', errors: ['File is empty'], warnings };
  }

  // Must start with --- frontmatter delimiter
  if (!content.trimStart().startsWith('---')) {
    errors.push('Missing YAML frontmatter (file must start with ---)');
    return { valid: false, frontmatter: {}, body: content, errors, warnings };
  }

  const { frontmatter, body, raw } = parseFrontmatter(content);

  if (!raw.trim()) {
    errors.push('YAML frontmatter block is empty');
  }

  if (!body.trim()) {
    warnings.push('Markdown body is empty — skill has no instructions');
  }

  // Line count check
  const lineCount = content.split('\n').length;
  if (lineCount > 500) {
    warnings.push(`File exceeds 500 lines (${lineCount} lines) — consider condensing`);
  }

  const fieldResult = validateRequiredFields(frontmatter);
  errors.push(...fieldResult.errors);

  const descResult = validateDescriptionQuality(frontmatter.description || '');
  warnings.push(...descResult.warnings);
  if (!descResult.valid) errors.push(...(descResult.errors || []));

  return {
    valid: errors.length === 0,
    frontmatter,
    body,
    errors,
    warnings,
  };
}

/**
 * Validate required YAML frontmatter fields.
 * Checks: name (non-empty string), description (string, 30-500 chars).
 *
 * @param {Object} frontmatter - Parsed frontmatter object
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateRequiredFields(frontmatter) {
  const errors = [];

  // name
  if (!frontmatter.name || typeof frontmatter.name !== 'string') {
    errors.push('Missing required field: name');
  } else if (!frontmatter.name.trim()) {
    errors.push('Field "name" must not be empty');
  }

  // description
  if (!frontmatter.description || typeof frontmatter.description !== 'string') {
    errors.push('Missing required field: description');
  } else {
    const len = frontmatter.description.trim().length;
    if (len < 30) {
      errors.push(`Field "description" is too short (${len} chars, minimum 30)`);
    } else if (len > 500) {
      errors.push(`Field "description" is too long (${len} chars, maximum 500)`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Evaluate the quality of the description field.
 * Checks: word count (5-100), presence of action verbs.
 *
 * @param {string} description - Raw description text
 * @returns {{valid: boolean, warnings: string[]}}
 */
export function validateDescriptionQuality(description) {
  const warnings = [];

  if (!description || !description.trim()) {
    return { valid: false, warnings: ['Description is empty'] };
  }

  const words = description.trim().split(/\s+/);
  if (words.length < 5) {
    warnings.push(`Description is very short (${words.length} words, recommend 5+)`);
  }
  if (words.length > 100) {
    warnings.push(`Description is very long (${words.length} words, recommend under 100)`);
  }

  const lower = description.toLowerCase();
  const hasActionVerb = ACTION_VERBS.some(v => lower.includes(v));
  if (!hasActionVerb) {
    warnings.push('Description lacks action verbs — consider using "Use when...", "Run...", "Create..." patterns');
  }

  return { valid: true, warnings };
}

/**
 * Check whether a skill is a near-duplicate of an existing one via vector similarity.
 * Uses skill_embeddings vec table with cosine distance (threshold < 0.76 = duplicate).
 *
 * @param {string} skillName    - Name of the skill being validated
 * @param {string} description  - Description text to embed and compare
 * @returns {Promise<{isDuplicate: boolean, similarSkill: Object|null, distance: number|null}>}
 */
export async function validateDuplication(skillName, description) {
  if (!description || !description.trim()) {
    return { isDuplicate: false, similarSkill: null, distance: null };
  }

  try {
    const embeddings = await generateEmbeddings([description]);
    if (!embeddings || embeddings.length === 0) {
      // Embedding server unavailable — skip vector check
      return { isDuplicate: false, similarSkill: null, distance: null };
    }

    const results = vectorSearch('skill_embeddings', 'vec_skill_embeddings', embeddings[0], 3);

    // Exclude exact name match from duplicate check (re-validation of same skill)
    const candidates = results.filter(r => r.name !== skillName);
    if (candidates.length === 0) {
      return { isDuplicate: false, similarSkill: null, distance: null };
    }

    const closest = candidates[0];
    const isDuplicate = closest.distance < DUPLICATE_THRESHOLD;

    return {
      isDuplicate,
      similarSkill: isDuplicate ? closest : null,
      distance: closest.distance,
    };
  } catch {
    // Non-fatal — skip duplication check on error
    return { isDuplicate: false, similarSkill: null, distance: null };
  }
}

/**
 * Run all validations on a SKILL.md file and return an aggregate result.
 * Order: structure → required fields → description quality → duplication.
 *
 * @param {string} skillFilePath - Absolute path to the .md file
 * @returns {Promise<{valid: boolean, errors: string[], warnings: string[]}>}
 */
export async function validateAll(skillFilePath) {
  // Stage 1: structural validation (synchronous, free)
  const structResult = validateStructure(skillFilePath);
  const errors = [...structResult.errors];
  const warnings = [...structResult.warnings];

  // Stop early if structure is broken — no point running further checks
  if (!structResult.valid) {
    return { valid: false, errors, warnings };
  }

  const { frontmatter } = structResult;

  // Stage 2: duplication check (async, requires embedding server)
  const dupResult = await validateDuplication(
    frontmatter.name,
    frontmatter.description || ''
  );

  if (dupResult.isDuplicate && dupResult.similarSkill) {
    errors.push(
      `Skill "${frontmatter.name}" is too similar to existing skill "${dupResult.similarSkill.name}" ` +
      `(distance: ${dupResult.distance?.toFixed(3)})`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
