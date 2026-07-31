import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import type { evaluateAgentContext as EvaluateAgentContext, paragraphs as Paragraphs } from '../../scripts/check-agent-context.mjs';
import type { GuardVerdict } from '../../scripts/guard-agent-command.mjs';

const root = process.cwd();

interface GuardModule {
  readonly evaluateCommand: (command: unknown) => GuardVerdict;
}

// Loaded from the repository root at runtime: the compiled test lives under
// .test-dist, where a relative specifier would resolve to a path that does not
// exist (the macos-signing.test.ts precedent).
function guardModule(): Promise<GuardModule> {
  return import(pathToFileURL(join(root, 'scripts/guard-agent-command.mjs')).href) as Promise<GuardModule>;
}

interface AgentContextModule {
  readonly paragraphs: typeof Paragraphs;
  readonly evaluateAgentContext: typeof EvaluateAgentContext;
}

function agentContextModule(): Promise<AgentContextModule> {
  return import(pathToFileURL(join(root, 'scripts/check-agent-context.mjs')).href) as Promise<AgentContextModule>;
}

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function json(path: string): unknown {
  return JSON.parse(source(path));
}

interface HookCommand {
  readonly type?: string;
  readonly command?: string;
}

interface HookMatcher {
  readonly matcher?: string;
  readonly hooks?: readonly HookCommand[];
}

interface ClaudeSettings {
  readonly permissions?: { readonly allow?: readonly string[] };
  readonly hooks?: Record<string, readonly HookMatcher[]>;
}

// #718 / ENG-0006: agent primitives are code and get the same review-as-code
// treatment. These are contract tests, not style checks — `e1d86f6a`
// ("governance: sync .codex from playbook-engineering") replaced
// .claude/settings.json wholesale and silently dropped the process-guard hook,
// leaving AGENTS.md and docs/agent-process-guard.md describing an enforcement
// point that no longer existed. A wholesale rewrite now fails here first.
describe('agent primitives (#718, ENG-0006)', () => {
  test('Claude Code registers the process-guard hook on Bash', () => {
    const settings = json('.claude/settings.json') as ClaudeSettings;
    const preToolUse = settings.hooks?.['PreToolUse'] ?? [];
    const bash = preToolUse.find((entry) => entry.matcher === 'Bash');
    assert.ok(bash, '.claude/settings.json must register a PreToolUse hook matching Bash');
    const commands = (bash.hooks ?? []).map((hook) => hook.command ?? '');
    assert.ok(
      commands.some((command) => command.includes('guard-agent-command.mjs') && command.includes('--protocol=claude')),
      'the Bash PreToolUse hook must invoke scripts/guard-agent-command.mjs --protocol=claude',
    );
  });

  test('the worktree-identity hook survives alongside it', () => {
    const settings = json('.claude/settings.json') as ClaudeSettings;
    const commands = (settings.hooks?.['WorktreeCreate'] ?? []).flatMap((entry) => (entry.hooks ?? []).map((hook) => hook.command ?? ''));
    assert.ok(
      commands.some((command) => command.includes('claude-worktree-create')),
      'WorktreeCreate must still mint the per-worktree bot identity (ENG-0016)',
    );
  });

  test('Cursor registers the same guard on its own protocol', () => {
    const hooks = json('.cursor/hooks.json') as {
      readonly hooks?: { readonly beforeShellExecution?: readonly HookCommand[] };
    };
    const commands = (hooks.hooks?.beforeShellExecution ?? []).map((hook) => hook.command ?? '');
    assert.ok(
      commands.some((command) => command.includes('guard-agent-command.mjs') && command.includes('--protocol=cursor')),
      '.cursor/hooks.json must invoke the shared guard with --protocol=cursor',
    );
  });

  test('tool permissions stay least-privilege: no blanket Bash or wildcard allow', () => {
    const allow = ((json('.claude/settings.json') as ClaudeSettings).permissions?.allow ?? []).map(String);
    for (const rule of allow) {
      assert.notEqual(rule, '*', 'a wildcard allow defeats the permission prompt entirely');
      assert.notEqual(rule, 'Bash', 'blanket Bash allow defeats the process-guard hook');
      assert.doesNotMatch(rule, /^Bash\(\*\)$/u, 'blanket Bash allow defeats the process-guard hook');
    }
  });

  test('the guard actually denies the entrypoints the hooks exist to block', async () => {
    const { evaluateCommand } = await guardModule();
    for (const command of [
      'ELECTRON_RUN_AS_NODE=1 electron --test .test-dist/**/*.test.js',
      'node --test .test-dist-dom/index.js',
      'npx playwright test',
      'test-storybook --ci',
      'npm run test:unit:run',
    ]) {
      assert.equal(evaluateCommand(command).allow, false, `expected the guard to deny: ${command}`);
    }
    assert.equal(evaluateCommand('npm run test:cov').allow, true);
    assert.equal(evaluateCommand('node scripts/run-guarded.mjs -- npm run test:unit:inner').allow, true);
  });

  test('a copied list item is caught, not hidden inside its list (PR #863 review)', async () => {
    const { evaluateAgentContext, paragraphs } = await agentContextModule();

    const bullet =
      '- Never invoke `electron --test`, `node --test`, `.test-dist`/`.test-dist-dom` output, `playwright test`, ' +
      '`test-storybook`, or `c8` directly, and never call `:run`/`:inner` npm scripts.';
    const list = `## Guard\n\n- A short first bullet that is on its own too brief to count.\n${bullet}\n- A short trailing bullet.\n`;

    // Each bullet is its own unit; the list is never one blob.
    assert.ok(paragraphs(list).some((unit) => unit.includes('never invoke')));

    const failures = evaluateAgentContext({
      readText: (file) => (file === 'AGENTS.md' ? list : `See AGENTS.md.\n\n${bullet}\n`),
      readDir: () => [],
    });
    assert.ok(
      failures.some((failure) => failure.includes('CLAUDE.md') && failure.includes('repeats')),
      `expected the copied bullet to be reported, got: ${JSON.stringify(failures)}`,
    );
  });

  test('every vendor adapter points at the canonical agent-context file', () => {
    for (const path of ['CLAUDE.md', '.github/copilot-instructions.md']) {
      assert.match(source(path), /AGENTS\.md/u, `${path} must point at AGENTS.md (ENG-0006 item 1)`);
    }
  });
});
