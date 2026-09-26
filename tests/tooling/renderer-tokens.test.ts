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

test('renderer custom-property gate reports undefined var() names with lines (#1286)', async () => {
  const tokens = await checker();
  assert.deepEqual(
    tokens.findUndefinedCustomProperties([
      { file: 'src/styles/tokens/colors.css', source: ':root { --text-body: #fff; --radius-2: 6px; }' },
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

test('renderer custom-property gate accepts component-local and script-set properties (#1286)', async () => {
  const tokens = await checker();
  assert.deepEqual(
    tokens.findUndefinedCustomProperties([
      { file: 'src/grid/grid.css', source: '.grid { --tile-gap: 4px; gap: var(--tile-gap); width: var(--tile-size); }' },
      { file: 'src/grid/Grid.tsx', source: "const style = { '--tile-size': `${size}px` } as CSSProperties;" },
    ]),
    [],
  );
});
