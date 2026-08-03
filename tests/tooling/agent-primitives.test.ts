import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import type { evaluateAgentContext as EvaluateAgentContext, paragraphs as Paragraphs } from '../../scripts/check-agent-context.mjs';

const root = process.cwd();

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
// leaving AGENTS.md and the guard docs describing an enforcement point that no
// longer existed.
//
// The guard's own wiring is asserted by the conformance test that ships with it
// (`tools/agent-guard/tests/conformance.test.mjs`, wired into `test:run`), and is
// deliberately not restated here — a shared fact asserted in two places is the
// ENG-0006 bug this file exists to prevent. What stays here is what is specific
// to this repo's primitives.
describe('agent primitives (#718, ENG-0006)', () => {
  test('the worktree-identity hook survives alongside the guard', () => {
    const settings = json('.claude/settings.json') as ClaudeSettings;
    const commands = (settings.hooks?.['WorktreeCreate'] ?? []).flatMap((entry) => (entry.hooks ?? []).map((hook) => hook.command ?? ''));
    assert.ok(
      commands.some((command) => command.includes('claude-worktree-create')),
      'WorktreeCreate must still mint the per-worktree bot identity (ENG-0016)',
    );
  });

  // Every harness that drives this repo needs its own adapter file, and Codex is
  // the one that had none: the enforcement point used to be the npm scripts
  // alone there, and Codex sessions caused half the memory incidents behind
  // ENG-0138. A vendor adapter this repo supports but does not wire is the gap.
  test('Codex has a hooks adapter, not just written rules', () => {
    const hooks = json('.codex/hooks.json') as {
      readonly hooks?: Record<string, readonly HookMatcher[]>;
    };
    const commands = (hooks.hooks?.['PreToolUse'] ?? []).flatMap((entry) => (entry.hooks ?? []).map((hook) => hook.command ?? ''));
    assert.ok(
      commands.some((command) => command.includes('guard-agent-command.mjs') && command.includes('--protocol=codex')),
      '.codex/hooks.json must invoke the shared guard with --protocol=codex',
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

  // The conformance test only protects this repo if this repo actually runs it.
  test('the guard conformance test is wired into the test command', () => {
    const scripts = (json('package.json') as { readonly scripts?: Record<string, string> }).scripts ?? {};
    assert.match(scripts['test:guard:conformance'] ?? '', /tools\/agent-guard\/tests\/conformance\.test\.mjs/u);
    assert.match(scripts['test:run'] ?? '', /test:guard:conformance/u);
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
