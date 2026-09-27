import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

interface RendererTokenViolation {
  readonly file: string;
  readonly line: number;
  readonly property: string;
}

interface RendererLiteralViolation extends RendererTokenViolation {
  readonly value: string;
}

interface RendererTokensModule {
  findUndefinedCustomProperties(files: readonly { file: string; source: string }[]): RendererTokenViolation[];
  findLiteralScaleValues(files: readonly { file: string; source: string }[]): RendererLiteralViolation[];
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

test('renderer scale gate reports literal radii, font weights, and font sizes with lines (#1289, #1288)', async () => {
  const tokens = await checker();
  assert.deepEqual(
    tokens.findLiteralScaleValues([
      { file: 'src/styles/tokens/spacing.css', source: ':root { --radius-1: 4px; }\n.x { border-radius: 4px; }' },
      {
        file: 'src/example/example.css',
        source: [
          '/* border-radius: 3px; */',
          '.a { border-radius: var(--radius-1); font-weight: var(--weight-medium); }',
          '.b { border-radius: 50%; }',
          '.c { border-top-left-radius: 2px; }',
          '.d { font-weight: 700 !important; }',
          '.e { border-radius: inherit; font-weight: unset; }',
          '.f { border-radius: var(--radius-1) var(--radius-2); }',
          '.g { font: var(--type-meta); font-size: var(--text-sm); }',
          '.h { font: 700 12px sans-serif; }',
          '.i { font: inherit; }',
          '.j { font-size: 9px; }',
          '.k { font-size: var(--text-xs); font-size: inherit; }',
        ].join('\n'),
      },
      { file: 'src/example/Example.tsx', source: "const style = { borderRadius: '3px' };" },
    ]),
    [
      { file: 'src/example/example.css', line: 3, property: 'border-radius', value: '50%' },
      { file: 'src/example/example.css', line: 4, property: 'border-top-left-radius', value: '2px' },
      { file: 'src/example/example.css', line: 5, property: 'font-weight', value: '700' },
      { file: 'src/example/example.css', line: 7, property: 'border-radius', value: 'var(--radius-1) var(--radius-2)' },
      { file: 'src/example/example.css', line: 9, property: 'font', value: '700 12px sans-serif' },
      { file: 'src/example/example.css', line: 11, property: 'font-size', value: '9px' },
    ],
  );
});
