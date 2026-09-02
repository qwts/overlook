import eslintReact from '@eslint-react/eslint-plugin';
import js from '@eslint/js';
import formatjs from 'eslint-plugin-formatjs';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'out/**',
      'storybook-static/**',
      '.test-dist/**',
      '.test-dist-dom/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'node_modules/**',
      // Agent worktrees carry in-progress copies of the repo; linting them from the
      // main checkout breaks local gates on unrelated work (prettier already ignores
      // .claude/ via .prettierignore).
      '.claude/**',
      // Vendored design handoff (reference material, not source) — #173.
      'design/handoff/**',
      // Test fixtures are inputs, not source (the #86 crash-worker is plain
      // JS loaded directly by worker_threads, outside any tsconfig).
      'tests/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    // Escalated from the default 'warn'. Every a11y suppression in src/renderer carries
    // either "verified correct" or the issue that owns the debt; this is what stops one
    // outliving its fix. When #399 adds the lightbox's keyboard wake path, the disable
    // above it stops matching anything and the build FAILS until it is deleted — the
    // same ratchet idea as the violation budget, applied to exemptions (ADR-0001).
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Size discipline, repo-wide from day one (greenfield: no legacy exemptions).
      // Keep the 800 budget in sync with scripts/check-new-file-size.mjs — that script
      // guards new/untracked files with a physical-line count; this rule is what stops
      // EXISTING files growing past the cap (it skips blanks/comments, so it is the
      // slightly looser bound of the pair).
      'max-lines': ['error', { max: 800, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // React correctness for the renderer (#51): hooks rules are
    // non-negotiable; @eslint-react (the eslint-10-compatible successor to
    // eslint-plugin-react) covers JSX/runtime pitfalls type-aware.
    files: ['src/renderer/**/*.tsx', 'src/renderer/**/*.ts'],
    extends: [reactHooks.configs.flat.recommended, eslintReact.configs['recommended-type-checked'], jsxA11y.flatConfigs.strict],
    // `PasswordField` renders a native `<input>`, so a `<label>` wrapping it IS
    // associated with a control (implicit nesting). jsx-a11y can't see inside a custom
    // component, so without this it false-positives `label-has-associated-control` on
    // every PasswordField wrapper — and inconsistently, depending on incidental sibling
    // structure (PR #451 review). Mapping it to `input` makes the rule model reality.
    // NOTE: this does NOT make those labels fully correct — audit finding 17 (#400) is a
    // SEPARATE criterion (2.5.3): PasswordField's `label` prop emits an `aria-label` that
    // overrides the visible text. No lint rule catches that; it is tracked by #400 and the
    // audit, not here. Do not read a green `label-has-associated-control` as "#400 fixed".
    settings: { 'jsx-a11y': { components: { PasswordField: 'input' } } },
    rules: {
      // The static half of the a11y gate (#398 follow-up). axe (story + E2E lanes) can
      // only judge what renders; these rules judge the SOURCE, so a regression is caught
      // at authoring time instead of after it reaches a story. `strict` over
      // `recommended`: the extra rules are what flag pointer-only handlers, where this
      // codebase's real 2.1.1 debt lives (audit findings 2 and 19). Note the limit —
      // these rules only see handlers in their fixed handler sets (onClick, onMouse*,
      // onKey*), so `onWheel`-only interactions like the lightbox's zoomed-pan (#449) are
      // invisible to them and stay owned by the audit and E2E lanes, not this gate.
      //
      // Every remaining site is annotated inline with either "verified correct" or the
      // issue that owns the debt — no blanket suppressions. `no-autofocus` is the one
      // rule off wholesale, because it is wrong for this app:
      // its 10 hits are all a modal taking initial focus, which is what the APG requires
      // and what the audit files as an S1 BUG where it is missing (finding 1, Lightbox).
      // Leaving it on would gate against the fix.
      'jsx-a11y/no-autofocus': 'off',
    },
  },
  {
    // Message hygiene for the i18n catalog (#403, ADR-0020 §1). These fire only
    // on react-intl's message APIs (`<FormattedMessage>`, `defineMessages`,
    // `intl.formatMessage`), so they are silent until a surface is migrated and
    // then guarantee every message is extractable: an explicit id and a
    // defaultMessage, no auto-hashed ids. The complementary "no NEW hardcoded
    // literal" ratchet is a per-file budget in scripts/check-i18n-budget.mjs
    // (it reuses this plugin's literal detector), because ESLint has no native
    // per-file shrink-only count.
    files: ['src/renderer/**/*.tsx', 'src/renderer/**/*.ts'],
    plugins: { formatjs },
    rules: {
      // Require an explicit id on every message (no auto-hashed ids — the ADR
      // wants readable, namespaced ids like `settings.title`) and a literal
      // defaultMessage so extraction is deterministic.
      'formatjs/enforce-id': 'error',
      'formatjs/enforce-default-message': ['error', 'literal'],
    },
  },
  // Process-boundary layering (#49), the full matrix from CLAUDE.md
  // §Architecture: every process dir may import src/shared; shared is
  // process-free; nothing else crosses — the typed IPC bridge is the only
  // channel. One override per layer so each direction is actually enforced.
  ...[
    { files: 'src/renderer/**', banned: ['**/main/**', '**/main', '**/preload/**', '**/preload'] },
    { files: 'src/preload/**', banned: ['**/main/**', '**/main', '**/renderer/**'] },
    { files: 'src/shared/**', banned: ['**/main/**', '**/main', '**/preload/**', '**/preload', '**/renderer/**'] },
    { files: 'src/main/**', banned: ['**/renderer/**', '**/preload/**', '**/preload'] },
  ].map(({ files, banned }) => ({
    files: [files],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: banned,
              message: `${files} may import src/shared only; cross-process traffic rides the typed IPC bridge.`,
            },
          ],
        },
      ],
    },
  })),
  {
    // node:test's test()/describe() return promises that the runner itself awaits;
    // requiring `void`/`await` on every registration is pure noise. Scope the
    // exemption to exactly those calls so a missed await on an async helper or
    // assertion inside a test still fails lint.
    files: ['tests/**/*.ts', 'tests/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [{ from: 'package', name: ['test', 'describe', 'it', 'suite'], package: 'node:test' }],
        },
      ],
    },
  },
  {
    // Compiled message catalogs are one line per string and grow with the
    // product; splitting them would only hide the size in the generator. They
    // are regenerated by `npm run i18n:extract`, never edited by hand, and the
    // extraction gate keeps them in step with the source JSON (#505).
    files: ['src/shared/i18n/generated/**/*.ts', 'src/main/i18n/generated/**/*.ts'],
    rules: { 'max-lines': 'off' },
  },
  {
    // Plain-JS Node scripts, blocking renderer bootstrap scripts, and this config
    // file are outside the TS project;
    // type-aware rules can't apply. no-undef is off for Node globals (console),
    // matching image-trail — TS owns undefined-identifier checking for source.
    files: ['**/*.mjs', '**/*.cjs', 'src/renderer/public/**/*.js', 'eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-undef': 'off',
    },
  },
);
