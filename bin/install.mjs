#!/usr/bin/env node
// Fallback installer — registers hooks in ~/.claude/settings.json
// Used when Claude Code plugin API is unavailable

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const SETTINGS_PATH = join(process.env.HOME || '', '.claude', 'settings.json');

const HOOKS = [
  { event: 'UserPromptSubmit', script: 'prompt-logger.mjs', timeout: 5, matcher: '*' },
  { event: 'PostToolUse', script: 'tool-logger.mjs', timeout: 5, matcher: '*' },
  { event: 'PostToolUseFailure', script: 'error-logger.mjs', timeout: 5, matcher: '*' },
  { event: 'PreToolUse', script: 'pre-tool-guide.mjs', timeout: 5, matcher: 'Edit|Write|Bash|Task' },
  { event: 'SubagentStart', script: 'subagent-context.mjs', timeout: 5, matcher: '*' },
  { event: 'SubagentStop', script: 'subagent-tracker.mjs', timeout: 5, matcher: '*' },
  { event: 'SessionEnd', script: 'session-summary.mjs', timeout: 10, matcher: '*' },
  { event: 'SessionStart', script: 'session-analyzer.mjs', timeout: 10, matcher: '*' },
];

const MARKER = 'reflexion-fusion';

function loadSettings() {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

function saveSettings(settings) {
  const dir = dirname(SETTINGS_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Backup before writing
  if (existsSync(SETTINGS_PATH)) {
    copyFileSync(SETTINGS_PATH, SETTINGS_PATH + '.bak');
  }

  const json = JSON.stringify(settings, null, 2);
  // Verify JSON is valid before writing
  JSON.parse(json);
  writeFileSync(SETTINGS_PATH, json);
}

function detectReflexionConflict(settings) {
  const hooks = settings.hooks || {};
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      const hookList = matcher.hooks || [];
      for (const hook of hookList) {
        if (hook.command && hook.command.includes('reflexion') && !hook.command.includes('reflexion-fusion')) {
          return { event, command: hook.command };
        }
      }
    }
  }
  return null;
}

function install() {
  const settings = loadSettings();

  // Check for Reflexion conflict
  const conflict = detectReflexionConflict(settings);
  if (conflict) {
    console.warn(`\n⚠️  기존 Reflexion 훅이 감지되었습니다:`);
    console.warn(`   이벤트: ${conflict.event}`);
    console.warn(`   명령: ${conflict.command}`);
    console.warn(`   동시 사용은 지원되지 않습니다.`);
    console.warn(`   먼저 Reflexion을 제거하세요: node ~/.reflexion/bin/install.mjs --uninstall\n`);
    process.exit(1);
  }

  if (!settings.hooks) settings.hooks = {};

  for (const { event, script, timeout, matcher } of HOOKS) {
    if (!settings.hooks[event]) settings.hooks[event] = [];

    // Remove existing fusion hooks
    settings.hooks[event] = settings.hooks[event].filter(m => {
      if (!m.hooks) return true;
      m.hooks = m.hooks.filter(h => !h.command || !h.command.includes(MARKER));
      return m.hooks.length > 0;
    });

    // Add new hook
    const scriptPath = join(PROJECT_ROOT, 'src', 'hooks', script);
    settings.hooks[event].push({
      matcher,
      hooks: [{
        type: 'command',
        command: `node "${scriptPath}"`,
        timeout,
      }],
    });
  }

  saveSettings(settings);

  // Create data directories
  const globalDir = join(process.env.HOME || '', '.reflexion-fusion');
  for (const sub of ['data', 'generated']) {
    const dir = join(globalDir, sub);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // Copy skills to ~/.claude/commands/
  const skillsDir = join(PROJECT_ROOT, 'skills');
  const commandsDir = join(process.env.HOME || '', '.claude', 'commands');
  if (!existsSync(commandsDir)) mkdirSync(commandsDir, { recursive: true });

  let skillCount = 0;
  if (existsSync(skillsDir)) {
    for (const skillName of readdirSync(skillsDir)) {
      const skillFile = join(skillsDir, skillName, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      const targetPath = join(commandsDir, `${skillName}.md`);
      copyFileSync(skillFile, targetPath);
      skillCount++;
    }
  }

  console.log('✅ Reflexion-Fusion 설치 완료');
  console.log(`   훅 ${HOOKS.length}개 등록됨`);
  console.log(`   스킬 ${skillCount}개 설치됨 → ${commandsDir}`);
  console.log(`   데이터 경로: ${globalDir}`);
}

async function uninstall(purge = false) {
  const settings = loadSettings();

  if (settings.hooks) {
    for (const event of Object.keys(settings.hooks)) {
      if (!Array.isArray(settings.hooks[event])) continue;
      settings.hooks[event] = settings.hooks[event].filter(m => {
        if (!m.hooks) return true;
        m.hooks = m.hooks.filter(h => !h.command || !h.command.includes(MARKER));
        return m.hooks.length > 0;
      });
      if (settings.hooks[event].length === 0) {
        delete settings.hooks[event];
      }
    }
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
  }

  saveSettings(settings);

  // Remove installed skills from ~/.claude/commands/
  const skillsDir = join(PROJECT_ROOT, 'skills');
  const commandsDir = join(process.env.HOME || '', '.claude', 'commands');
  if (existsSync(skillsDir) && existsSync(commandsDir)) {
    for (const skillName of readdirSync(skillsDir)) {
      const targetPath = join(commandsDir, `${skillName}.md`);
      if (existsSync(targetPath)) {
        const { unlinkSync } = await import('node:fs');
        unlinkSync(targetPath);
      }
    }
  }

  console.log('✅ Reflexion-Fusion 훅 + 스킬 제거 완료');

  if (purge) {
    const globalDir = join(process.env.HOME || '', '.reflexion-fusion');
    const { rmSync } = await import('node:fs');
    if (existsSync(globalDir)) {
      rmSync(globalDir, { recursive: true });
      console.log(`   데이터 디렉토리 삭제됨: ${globalDir}`);
    }
  }
}

// --- CLI ---
const args = process.argv.slice(2);
if (args.includes('--uninstall')) {
  await uninstall(args.includes('--purge'));
} else {
  install();
}
