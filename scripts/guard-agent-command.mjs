#!/usr/bin/env node

// Agent command hook (Claude Code, Cursor): denies shell commands that would
// run Photos test entrypoints WITHOUT the process-tree guard
// (scripts/run-guarded.mjs). The guarded npm scripts are the allowed path.
// Ported from Image Trail (qwts/image-trail), which added this after a
// memory-runaway incident there; Photos runs the same class of test
// (Electron-hosted `node:test`, happy-dom DOM suite, Playwright-driven
// Electron E2E), so the same protection is adopted here proactively.
//
// Protocols (selected with --protocol=claude|cursor):
//   claude — Claude Code PreToolUse hook. Reads {tool_input:{command}} on
//     stdin; denies via hookSpecificOutput.permissionDecision.
//   cursor — Cursor beforeShellExecution hook. Reads {command} on stdin;
//     replies {permission:"deny"|"allow", ...}.
//
// Fail-open by design: a malformed payload allows the command rather than
// bricking every shell call — the guard wrapper itself is the primary control;
// this hook only closes the direct-entrypoint bypass.

import process from 'node:process';
import { pathToFileURL } from 'node:url';

const GUIDANCE =
  'Use the guarded npm scripts instead: npm test, npm run test:dom / test:cov / test:stories / ' +
  'test:stories:ci / test:e2e / test:perf. They wrap scripts/run-guarded.mjs (aggregate RSS ' +
  'ceiling, heap cap, timeout, one-run-per-worktree). See docs/agent-process-guard.md.';

const BLOCKED = [
  {
    // Direct Electron-hosted node:test invocations (the incident path):
    // ELECTRON_RUN_AS_NODE=1 electron --test ...
    pattern: /\belectron\b[^\n;&|]*\s--test(?![\w-])/u,
    what: 'direct `electron --test` invocation',
  },
  {
    // Direct plain node:test invocations (test:dom:run: node --import ... --test).
    pattern: /\bnode\b[^\n;&|]*\s--test(?![\w-])/u,
    what: 'direct `node --test` invocation',
  },
  {
    // Running compiled test output directly (.test-dist / .test-dist-dom).
    pattern: /\bnode\b[^\n;&|]*\.test-dist(-dom)?\b/u,
    what: 'direct execution of compiled tests in .test-dist(-dom)',
  },
  {
    pattern: /\bplaywright\s+test\b/u,
    what: 'direct Playwright invocation',
  },
  {
    pattern: /\btest-storybook\b/u,
    what: 'direct Storybook test-runner invocation',
  },
  {
    pattern: /(^|[\s;(&|])(npx\s+)?c8\s/u,
    what: 'direct c8 coverage invocation',
  },
  {
    // Inner/unguarded npm scripts (test:unit:run, test:dom:run, *:inner).
    pattern: /\bnpm\s+run\s+[\w:.-]*:(run|inner)(?![\w:-])/u,
    what: 'unguarded inner npm script',
  },
];

export function evaluateCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return { allow: true };
  // Explicit guard invocations (e.g. rerunning with custom limits) are the
  // sanctioned path even when the wrapped command matches a blocked pattern.
  if (command.includes('run-guarded.mjs')) return { allow: true };
  for (const { pattern, what } of BLOCKED) {
    if (pattern.test(command)) {
      return {
        allow: false,
        reason: `Blocked ${what}: it bypasses the repository process-tree memory guard. ${GUIDANCE}`,
      };
    }
  }
  return { allow: true };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function respond(protocol, verdict) {
  if (protocol === 'cursor') {
    const body = verdict.allow
      ? { permission: 'allow' }
      : {
          permission: 'deny',
          agentMessage: verdict.reason,
          userMessage: 'Blocked an unguarded test command (see docs/agent-process-guard.md).',
        };
    process.stdout.write(`${JSON.stringify(body)}\n`);
    return;
  }
  if (!verdict.allow) {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: verdict.reason,
        },
      })}\n`,
    );
  }
}

async function main() {
  const protocol = process.argv.includes('--protocol=cursor') ? 'cursor' : 'claude';
  let verdict = { allow: true };
  try {
    const input = JSON.parse(await readStdin());
    const command = protocol === 'cursor' ? input.command : input.tool_input?.command;
    verdict = evaluateCommand(command);
  } catch {
    // Fail open (see header).
  }
  respond(protocol, verdict);
}

// Compare this module's URL against the entrypoint, not against its own
// filename: `import.meta.url.endsWith('guard-agent-command.mjs')` is true for
// every import, so any importer ran main() and blocked forever on stdin. Same
// form as the other scripts here.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
