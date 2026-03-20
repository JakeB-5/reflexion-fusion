// src/lib/auto-deployer.mjs
// User-approved deployment of skills, rules, and hook workflows

import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
} from 'fs';
import { join, dirname } from 'path';
import { getDb, GLOBAL_DIR } from './db.mjs';

// Global Claude commands directory
const GLOBAL_COMMANDS_DIR = join(process.env.HOME || '', '.claude', 'commands');

// Claude settings.json path
const SETTINGS_PATH = join(process.env.HOME || '', '.claude', 'settings.json');

// Auto-generated hooks directory
const AUTO_HOOKS_DIR = join(GLOBAL_DIR, 'hooks', 'auto');

// ── Safety helpers ──────────────────────────────────────────────────────────

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Create a .bak backup of a file before overwriting it.
 * Returns the backup path.
 */
function backupFile(filePath) {
  const backupPath = `${filePath}.bak`;
  if (existsSync(filePath)) {
    copyFileSync(filePath, backupPath);
  }
  return backupPath;
}

/**
 * Write content to a file after backing it up.
 * On JSON parse failure after write (for settings files), auto-rollback.
 *
 * @param {string} filePath
 * @param {string} content
 * @param {boolean} [validateJson=false] - Verify content is valid JSON after write
 */
function safeWrite(filePath, content, validateJson = false) {
  backupFile(filePath);
  writeFileSync(filePath, content, 'utf-8');

  if (validateJson) {
    try {
      JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      // Auto-rollback: restore backup
      const backupPath = `${filePath}.bak`;
      if (existsSync(backupPath)) {
        copyFileSync(backupPath, filePath);
      }
      throw new Error(`JSON validation failed after write to ${filePath} — rolled back`);
    }
  }
}

/**
 * Load and parse settings.json, returning {} on missing/invalid file.
 */
function loadSettings() {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

// ── Deployment DB helpers ───────────────────────────────────────────────────

/**
 * Mark a generated_skill row as deployed.
 */
function markDeployed(db, skillName, deployedPath) {
  db.prepare(`
    UPDATE generated_skills
    SET deployed = 1, deployed_path = ?
    WHERE skill_name = ?
  `).run(deployedPath, skillName);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Deploy a SKILL.md to the appropriate commands directory.
 * Backs up any existing file at the target path before writing.
 *
 * @param {Object} skill - Row from generated_skills (skill_name, file_path, project_path, ...)
 * @param {'global'|'project'} [scope='global'] - Deployment scope
 * @returns {{deployedPath: string, backedUp: boolean, conflict: boolean}}
 */
export function deploySkill(skill, scope = 'global') {
  const db = getDb();
  const safeName = (skill.skill_name || skill.name || 'unknown')
    .replace(/[^a-z0-9-_]/gi, '-')
    .toLowerCase();
  const fileName = `${safeName}.md`;

  // Resolve target directory based on scope
  let commandsDir;
  if (scope === 'project' && skill.project_path) {
    commandsDir = join(skill.project_path, '.claude', 'commands');
  } else {
    commandsDir = GLOBAL_COMMANDS_DIR;
  }

  ensureDir(commandsDir);

  const deployedPath = join(commandsDir, fileName);
  const conflict = existsSync(deployedPath);

  // Read source content
  const sourcePath = skill.file_path;
  if (!existsSync(sourcePath)) {
    throw new Error(`Source skill file not found: ${sourcePath}`);
  }
  const content = readFileSync(sourcePath, 'utf-8');

  // Backup existing + write
  safeWrite(deployedPath, content);

  // Update DB
  markDeployed(db, skill.skill_name || skill.name, deployedPath);

  return { deployedPath, backedUp: conflict, conflict };
}

/**
 * Add a rule line to CLAUDE.md's "## 자동 감지된 규칙" section.
 * Creates the section if it does not exist. Backs up before editing.
 *
 * @param {Object} rule - {rule: string, scope: 'global'|'project', projectPath?: string}
 * @param {'global'|'project'} [scope='global']
 * @returns {{claudeMdPath: string, created: boolean}}
 */
export function deployClaudeMdRule(rule, scope = 'global') {
  // Resolve CLAUDE.md path
  let claudeMdPath;
  if (scope === 'project' && rule.projectPath) {
    claudeMdPath = join(rule.projectPath, '.claude', 'CLAUDE.md');
    ensureDir(join(rule.projectPath, '.claude'));
  } else {
    claudeMdPath = join(process.env.HOME || '', '.claude', 'CLAUDE.md');
    ensureDir(join(process.env.HOME || '', '.claude'));
  }

  const SECTION_HEADER = '## 자동 감지된 규칙';
  const ruleText = (rule.rule || '').trim();

  if (!ruleText) {
    throw new Error('Rule text is empty');
  }

  let content = '';
  let created = false;

  if (existsSync(claudeMdPath)) {
    content = readFileSync(claudeMdPath, 'utf-8');
  } else {
    created = true;
  }

  if (content.includes(SECTION_HEADER)) {
    // Append rule under existing section
    content = content.replace(
      SECTION_HEADER,
      `${SECTION_HEADER}\n- ${ruleText}`
    );
  } else {
    // Create section at end of file
    const separator = content.trim() ? '\n\n' : '';
    content = `${content.trimEnd()}${separator}${SECTION_HEADER}\n- ${ruleText}\n`;
  }

  safeWrite(claudeMdPath, content);

  return { claudeMdPath, created };
}

/**
 * Deploy a hook workflow script to ~/.reflexion-fusion/hooks/auto/<name>.mjs
 * and register it in ~/.claude/settings.json using nested object format.
 *
 * @param {Object} hook - {name: string, code: string, hookEvent: string, description?: string, timeout?: number}
 * @returns {{hookPath: string, settingsUpdated: boolean}}
 */
export function deployHookWorkflow(hook) {
  const safeName = (hook.name || `hook-${Date.now()}`)
    .replace(/[^a-z0-9-_]/gi, '-')
    .toLowerCase();
  const hookFileName = `${safeName}.mjs`;

  ensureDir(AUTO_HOOKS_DIR);

  const hookPath = join(AUTO_HOOKS_DIR, hookFileName);
  safeWrite(hookPath, hook.code || '');

  // Update ~/.claude/settings.json
  const settings = loadSettings();

  // Ensure hooks object exists with nested event structure
  if (!settings.hooks) settings.hooks = {};

  const event = hook.hookEvent || 'PostToolUse';
  const matcher = hook.matcher || '.*';
  const timeout = hook.timeout || 5000;

  if (!settings.hooks[event]) {
    settings.hooks[event] = [];
  }

  // Avoid duplicate entries for the same hook name
  settings.hooks[event] = settings.hooks[event].filter(
    h => h.command !== `node ${hookPath}`
  );

  settings.hooks[event].push({
    matcher,
    hooks: [
      {
        type: 'command',
        command: `node ${hookPath}`,
        timeout,
      },
    ],
  });

  // Validate JSON before writing
  const settingsJson = JSON.stringify(settings, null, 2);
  JSON.parse(settingsJson); // throws if invalid

  ensureDir(dirname(SETTINGS_PATH));
  safeWrite(SETTINGS_PATH, settingsJson, true);

  return { hookPath, settingsUpdated: true };
}

/**
 * Rollback a deployment by restoring the .bak file at the deployed path.
 *
 * @param {number} deploymentId - generated_skills row id
 * @returns {{restored: boolean, path: string|null}}
 */
export function rollback(deploymentId) {
  const db = getDb();

  const row = db.prepare(
    'SELECT deployed_path, skill_name FROM generated_skills WHERE id = ?'
  ).get(deploymentId);

  if (!row || !row.deployed_path) {
    return { restored: false, path: null };
  }

  const backupPath = `${row.deployed_path}.bak`;

  if (!existsSync(backupPath)) {
    return { restored: false, path: row.deployed_path };
  }

  copyFileSync(backupPath, row.deployed_path);

  // Reset deployed state in DB
  db.prepare('UPDATE generated_skills SET deployed = 0, deployed_path = NULL WHERE id = ?')
    .run(deploymentId);

  return { restored: true, path: row.deployed_path };
}

/**
 * List pending skills awaiting user approval for a project.
 * Joins generated_skills with evaluations to include verdict info.
 *
 * @param {string|null} [projectPath] - Filter by project path (null = all)
 * @returns {Array<Object>}
 */
export function listPendingApprovals(projectPath) {
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      gs.id,
      gs.ts,
      gs.skill_name,
      gs.suggestion_id,
      gs.project_path,
      gs.file_path,
      gs.version,
      gs.source_patterns,
      gs.evaluation_id,
      gs.approved,
      gs.deployed,
      e.overall_verdict,
      e.status AS eval_status,
      e.iteration AS eval_iteration
    FROM generated_skills gs
    LEFT JOIN evaluations e ON gs.evaluation_id = e.id
    WHERE gs.approved = 0
      AND gs.deployed = 0
      AND (gs.project_path IS ? OR ? IS NULL)
    ORDER BY gs.ts DESC
  `).all(projectPath || null, projectPath || null);

  return rows;
}
