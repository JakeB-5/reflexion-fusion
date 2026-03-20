# CLAUDE.md — Reflexion-Fusion

## Project Overview

Reflexion-Fusion is a Claude Code plugin that fuses Reflexion (automatic pattern analysis) with Skill-Creator (evaluation agents) into a complete skill lifecycle system: pattern detection → skill generation → blind evaluation → approved deployment.

## Tech Stack

- **Runtime**: Node.js >= 18 (ES Modules, .mjs)
- **Storage**: SQLite (better-sqlite3) + sqlite-vec (384-dim vectors), WAL mode
- **Analysis**: Claude headless mode (`claude --print --model sonnet`)
- **Embedding**: @xenova/transformers + paraphrase-multilingual-MiniLM-L12-v2 (384-dim, offline)
- **Plugin**: Claude Code plugin format (.claude-plugin/plugin.json + hooks/hooks.json)

## Build & Test

```bash
npm install
npm test                    # vitest run --no-cache
npm run test:coverage       # with coverage report
node bin/install.mjs        # fallback install (settings.json)
node bin/install.mjs --uninstall  # remove hooks
```

## Architecture

```
[Hooks] ──write──> [SQLite DB] ──read──> [Batch Analyzer]
                                              │
                                        Pattern Detection
                                              │
                                    ┌─────────┼─────────┐
                                    ▼         ▼         ▼
                              [SKILL.md   [CLAUDE.md  [Hook
                               Generator]  Generator]  Generator]
                                    │
                              [Stage 1: Local Validation]
                                    │
                              [Stage 2: Blind Evaluation] ← on-demand only
                                    │
                              [/suggest → User Approval]
                                    │
                              [Auto Deploy]
```

### Key Principles

1. **Quality Over Quantity** — Blind evaluation gate. User approval required (SHALL NOT auto-deploy)
2. **Non-Blocking Hooks** — exit 0 always, 5s/10s timeouts, no sync AI calls
3. **DB-Mediated Async** — Hooks → DB → Analyzer → Agents (loose coupling)
4. **Privacy by Default** — Local embeddings, path/number/string normalization

## Language Policy

- User communication: Korean
- Code comments: English
- Git commit messages: English

## Conventions

- All hooks must try-catch + exit(0)
- No Claude headless calls inside hooks (background/detached only)
- busy_timeout = 5000ms for SQLite
- Vector similarity threshold: 0.76 (cosine distance)
