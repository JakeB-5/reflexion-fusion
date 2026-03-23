# Reflexion-Fusion

A Claude Code plugin that automatically detects usage patterns, generates skills, evaluates them via blind comparison, and deploys approved skills — all in one integrated system.

## Core Principles

- **Quality Over Quantity**: Only skills that pass a blind evaluation gate become deployment candidates.
- **User Approval Required**: No automatic deployment. All deployments require explicit user approval via `/suggest`.
- **Non-Blocking Hooks**: Every hook exits with code 0, even on errors. Claude Code is never interrupted.
- **Privacy by Default**: Local embeddings, path/number/string normalization — no data leaves your machine.

---

## Installation

### Plugin (recommended)

```bash
claude plugin add ~/projects/reflexion-fusion
```

### Fallback (direct settings.json registration)

```bash
node bin/install.mjs
```

### Uninstall

```bash
# Remove hooks (preserve data)
node bin/install.mjs --uninstall

# Full removal (hooks + data)
node bin/install.mjs --uninstall --purge
```

---

## Usage

### `/suggest` — Review & Approve Suggestions (PRIMARY UI)

Review auto-detected skill suggestions and approve them for deployment.

```
/suggest
/suggest apply <number>    # Approve and deploy
/suggest reject <number>   # Dismiss (won't be suggested again)
```

- Lists pending skill suggestions with evaluation results (pass / improve / fail) and source patterns.
- Approved skills are immediately deployed to `~/.claude/commands/`.

### `/evaluate` — On-Demand Blind Evaluation

Trigger a blind evaluation for a specific skill.

```
/evaluate <skill-name>
```

- Runs Stage 1 (structural validation) → Stage 2 (blind AI grading) sequentially.
- Daily limit: 5 evaluations per project (cost control).

### `/fusion-status` — System Status

Check current system state and statistics.

```
/fusion-status
```

- Displays collected event counts, pending suggestions, recent deployments, embedding server status, and DB path.

---

## Architecture

```
[Claude Code Hooks]
      │ (UserPromptSubmit, PostToolUse, PostToolUseFailure, SessionEnd, ...)
      ▼
[SQLite DB — ~/.reflexion-fusion/data/reflexion-fusion.db]
      │
      ▼
[Batch Analyzer — background, triggered after session end]
      │
      ▼ Pattern Detection
      │
  ┌───┴────────────────────┐
  ▼                        ▼
[SKILL.md Generator]  [CLAUDE.md Rule Generator]
  │
  ▼
[Stage 1: Local Validation]         ← free, synchronous
  │ pass
  ▼
[Stage 2: Blind AI Evaluation]      ← on-demand, Claude headless
  │  ┌──────────────────┐
  │  │ verdict: improve  │──→ regenerateSkill() ──→ re-evaluate (up to 3x)
  │  └──────────────────┘
  │ verdict: pass
  ▼
[/suggest → User Approval]
  │ approved
  ▼
[Auto Deployer → ~/.claude/commands/<skill>.md]
```

### Two-Stage Gate

| Stage | When | Cost | What |
|-------|------|------|------|
| Stage 1 | After generation, local | Free | Structure validation, required fields, description quality, duplicate detection |
| Stage 2 | On-demand via `/evaluate` or `/suggest` | AI tokens | Blind grading, baseline comparison, overall verdict |

### Duplicate Detection & Skill Improvement

When generating a new skill, the system first checks for existing skills with the same name. If a match is found, the existing skill is **improved** instead of creating a duplicate — the new analysis is merged with the existing content and the version is incremented.

### Hook Event Mapping

| Event | Hook Script | Purpose |
|-------|-------------|---------|
| `UserPromptSubmit` | `prompt-logger.mjs` | Prompt collection + skill matching |
| `PostToolUse` | `tool-logger.mjs` | Tool usage pattern collection |
| `PostToolUseFailure` | `error-logger.mjs` | Error collection + KB search |
| `PreToolUse` | `pre-tool-guide.mjs` | Per-file error history injection |
| `SubagentStart` | `subagent-context.mjs` | Error pattern + AI rule injection |
| `SubagentStop` | `subagent-tracker.mjs` | Agent performance tracking |
| `SessionEnd` | `session-summary.mjs` | Session summary + batch analysis trigger |
| `SessionStart` | `session-analyzer.mjs` | Cache injection + daemon startup |

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js >= 18, ES Modules (`.mjs`) |
| Storage | SQLite (`better-sqlite3`) + `sqlite-vec` (384-dim vectors), WAL mode |
| Analysis | Claude headless mode (`claude --print --model sonnet`) |
| Embedding | `@xenova/transformers` + `paraphrase-multilingual-MiniLM-L12-v2` (384-dim, offline) |
| Plugin Format | Claude Code plugin (`.claude-plugin/plugin.json` + `hooks/hooks.json`) |

### Dependencies (3 total)

```
better-sqlite3       — SQLite bindings
sqlite-vec           — Vector search extension
@xenova/transformers  — Local embedding generation
```

---

## Runtime Data Layout

```
~/.reflexion-fusion/
├── config.json                    # System config (enabled, retentionDays, analysisModel)
├── data/
│   └── reflexion-fusion.db        # SQLite DB (events, error_kb, feedback, ...)
└── generated/                     # Auto-generated skill drafts
```

---

## Development

### Running Tests

```bash
# Node 22 recommended (v24 has better-sqlite3 build issues)
nvm use 22

npm install
npm test                    # vitest run --no-cache
npm run test:coverage       # with coverage report
```

### Test Structure

```
tests/
├── unit/            # Per-module unit tests (in-memory DB)
├── integration/     # Cross-module pipeline tests
└── e2e/             # Full lifecycle tests (AI calls mocked)
```

### Code Conventions

- Code comments: English
- Git commit messages: English (Conventional Commits)
- All hooks: `try-catch + process.exit(0)` required
- No synchronous AI calls inside hooks (background `spawn` only)

---

## License

MIT
