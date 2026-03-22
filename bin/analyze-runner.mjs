#!/usr/bin/env node
// bin/analyze-runner.mjs
// Background analysis runner — spawned by hooks, not run directly by users

import { runAnalysis } from '../src/lib/ai-analyzer.mjs';

const args = process.argv.slice(2);
const options = {};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i + 1]) { options.days = parseInt(args[i + 1], 10); i++; }
  if (args[i] === '--project' && args[i + 1]) { options.project = args[i + 1]; i++; }
  if (args[i] === '--project-path' && args[i + 1]) { options.projectPath = args[i + 1]; i++; }
}

try {
  await runAnalysis(options);
} catch {
  // Silent failure — background process
}
