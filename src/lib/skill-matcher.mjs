// src/lib/skill-matcher.mjs
// Skill-to-prompt matching — vector similarity with keyword fallback

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, vectorSearch, generateEmbeddings } from '../lib/db.mjs';

/**
 * Load skill .md files from global (~/.claude/commands/) and project (.claude/commands/) dirs.
 * @param {string|null} projectPath - Project root (optional)
 * @returns {Array<{name: string, scope: string, content: string, description: string|null, sourcePath: string}>}
 */
export function loadSkills(projectPath) {
  const skills = [];

  // Global skills
  const globalDir = join(process.env.HOME || '', '.claude', 'commands');
  if (existsSync(globalDir)) {
    for (const file of readdirSync(globalDir)) {
      if (!file.endsWith('.md')) continue;
      const sourcePath = join(globalDir, file);
      const content = readFileSync(sourcePath, 'utf-8');
      const description = content.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim() || null;
      skills.push({
        name: file.slice(0, -3), // strip .md
        scope: 'global',
        content,
        description,
        sourcePath,
      });
    }
  }

  // Project skills
  if (projectPath) {
    const projectDir = join(projectPath, '.claude', 'commands');
    if (existsSync(projectDir)) {
      for (const file of readdirSync(projectDir)) {
        if (!file.endsWith('.md')) continue;
        const sourcePath = join(projectDir, file);
        const content = readFileSync(sourcePath, 'utf-8');
        const description = content.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim() || null;
        skills.push({
          name: file.slice(0, -3),
          scope: 'project',
          content,
          description,
          sourcePath,
        });
      }
    }
  }

  return skills;
}

/**
 * Match a prompt against skills using vector similarity, falling back to keyword matching.
 * Vector threshold: distance < 0.76. Keyword threshold: 50%+ pattern words match.
 * @param {string} prompt
 * @param {Array} skills - from loadSkills()
 * @returns {Promise<{name: string, match: 'vector'|'keyword', confidence: number, scope: string}|null>}
 */
export async function matchSkill(prompt, skills) {
  // Primary: vector similarity
  try {
    const embeddings = await generateEmbeddings([prompt]);
    if (embeddings && embeddings.length > 0 && embeddings[0]) {
      const results = vectorSearch('skill_embeddings', 'vec_skill_embeddings', embeddings[0], 1);
      if (results.length > 0 && results[0].distance < 0.76) {
        const hit = results[0];
        return {
          name: hit.name,
          match: 'vector',
          confidence: 1 - hit.distance,
          scope: skills.find(s => s.name === hit.name)?.scope || 'global',
        };
      }
    }
  } catch {
    // Embedding daemon unavailable — fall through to keyword matching
  }

  // Fallback: keyword matching
  return keywordMatch(prompt, skills);
}

/**
 * Keyword-based matching: 50%+ of pattern words (3+ chars) must appear in the prompt.
 * @param {string} prompt
 * @param {Array} skills
 * @returns {{name, match, confidence, scope}|null}
 */
function keywordMatch(prompt, skills) {
  const promptLower = prompt.toLowerCase();

  for (const skill of skills) {
    const patterns = extractPatterns(skill.content);
    for (const pattern of patterns) {
      const words = pattern.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
      if (words.length === 0) continue;
      const matchCount = words.filter(w => promptLower.includes(w)).length;
      if (matchCount / words.length >= 0.5) {
        return {
          name: skill.name,
          match: 'keyword',
          confidence: matchCount / words.length,
          scope: skill.scope,
        };
      }
    }
  }

  return null;
}

/**
 * Parse "감지된 패턴" section from skill content.
 * Collects lines prefixed with "- " until the next heading.
 * @param {string} content
 * @returns {string[]}
 */
export function extractPatterns(content) {
  const patterns = [];
  const lines = content.split('\n');
  let inSection = false;

  for (const line of lines) {
    if (line.includes('감지된 패턴')) {
      inSection = true;
      continue;
    }
    if (line.startsWith('#')) {
      inSection = false;
      continue;
    }
    if (inSection && line.startsWith('- ')) {
      // Strip "- " prefix and optional surrounding quotes
      patterns.push(line.replace(/^- "?|"?$/g, '').trim());
    }
  }

  return patterns;
}

/**
 * UPSERT all current skills into skill_embeddings and regenerate vectors for new/updated entries.
 * Skips skills whose metadata and embedding are already current.
 */
export async function refreshSkillEmbeddings() {
  const db = getDb();
  const skills = loadSkills(process.env.CLAUDE_PROJECT_DIR || process.cwd());

  for (const skill of skills) {
    try {
      const existing = db.prepare(
        'SELECT id, updated_at FROM skill_embeddings WHERE name = ?'
      ).get(skill.name);

      const fileMtime = statSync(skill.sourcePath).mtime.toISOString();
      let skillId;

      if (!existing) {
        // New skill — insert metadata
        const keywords = extractPatterns(skill.content);
        const result = db.prepare(`
          INSERT INTO skill_embeddings (name, source_path, description, keywords, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(skill.name, skill.sourcePath, skill.description || null, JSON.stringify(keywords), fileMtime);
        skillId = result.lastInsertRowid;

      } else if (existing.updated_at < fileMtime) {
        // File changed — update metadata
        const keywords = extractPatterns(skill.content);
        db.prepare(`
          UPDATE skill_embeddings
          SET source_path = ?, description = ?, keywords = ?, updated_at = ?
          WHERE name = ?
        `).run(skill.sourcePath, skill.description || null, JSON.stringify(keywords), fileMtime, skill.name);
        skillId = existing.id;

      } else {
        // Up to date — skip if embedding already exists
        const hasEmbedding = db.prepare(
          'SELECT 1 FROM vec_skill_embeddings WHERE skill_id = ?'
        ).get(existing.id);
        if (hasEmbedding) continue;
        skillId = existing.id;
      }

      // Generate and store embedding for description + keywords
      const row = db.prepare('SELECT description, keywords FROM skill_embeddings WHERE id = ?').get(skillId);
      const keywords = JSON.parse(row.keywords || '[]');
      const text = [row.description || '', ...keywords].filter(Boolean).join(' ');
      if (!text) continue;

      const embeddings = await generateEmbeddings([text]);
      if (!embeddings || embeddings.length === 0 || !embeddings[0]) continue;

      const blob = Buffer.from(new Float32Array(embeddings[0]).buffer);
      db.prepare(`
        INSERT OR REPLACE INTO vec_skill_embeddings (skill_id, embedding) VALUES (?, ?)
      `).run(skillId, blob);

    } catch {
      // Skip this skill, continue with others
    }
  }
}
