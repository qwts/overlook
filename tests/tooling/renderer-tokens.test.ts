import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

interface RendererTokenViolation {
  readonly file: string;
  readonly line: number;
  readonly property: string;
}

interface RendererTokensModule {
  findUndefinedCustomProperties(files: readonly { file: string; source: string }[]): RendererTokenViolation[];
}

async function checker(): Promise<RendererTokensModule> {
  return (await import(pathToFileURL(join(process.cwd(), 'scripts/check-renderer-tokens.mjs')).href)) as RendererTokensModule;
}

const TOKENS = { file: 'src/styles/tokens/colors.css', source: ':root { --text-body: #fff; --radius-2: 6px; }' };

test('renderer custom-property gate reports undefined var() names with lines, fallback or not (#1286)', async () => {
  const tokens = await checker();
  assert.deepEqual(
    tokens.findUndefinedCustomProperties([
      TOKENS,
      {
        file: 'src/example/example.css',
        source:
          '/* var(--commented-out) */\n.good { color: var(--text-body); }\n.bad { border-radius: var(--radius-md); }\n.fallback { color: var(--text-primary, #fff); }',
      },
    ]),
    [
      { file: 'src/example/example.css', line: 3, property: '--radius-md' },
      { file: 'src/example/example.css', line: 4, property: '--text-primary' },
    ],
  );
});

test('renderer custom-property gate accepts only tokens and properties a component writes at runtime (#1286)', async () => {
  const tokens = await checker();
  assert.deepEqual(
    tokens.findUndefinedCustomProperties([
      TOKENS,
      {
        file: 'src/grid/grid.css',
        source:
          '.grid { margin: calc(var(--ovl-depth) * 1px); width: var(--ovl-size); }\n.row { --ovl-local: 4px; gap: var(--ovl-local); color: var(--ovl-labelled); }',
      },
      {
        file: 'src/grid/Grid.tsx',
        source: "const style = { '--ovl-depth': depth } as CSSProperties;\nnode.style.setProperty('--ovl-size', `${size}px`);",
      },
      { file: 'src/grid/copy.ts', source: "const hint = 'Set --ovl-labelled first';\nconst name = '--ovl-labelled';" },
    ]),
    [
      { file: 'src/grid/grid.css', line: 2, property: '--ovl-local' },
      { file: 'src/grid/grid.css', line: 2, property: '--ovl-labelled' },
    ],
  );
});
