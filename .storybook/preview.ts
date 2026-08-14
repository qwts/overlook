import type { Decorator, Preview } from '@storybook/react-vite';
import { createElement } from 'react';

// The token styles entry is the same one the renderer loads (#54): stories
// render on both first-party themes with no Storybook token duplication.
import '../src/renderer/src/styles/index.css';
import budget from '../tests/a11y/violation-budget.json' with { type: 'json' };
import { localeGlobalType, withIntl } from './intl-decorator';
import { contrastGlobalType, themeGlobalType, withTheme } from './theme-decorator';
import { AnnouncerProvider } from '../src/renderer/src/components/LiveAnnouncer';

const withAnnouncer: Decorator = (Story) => createElement(AnnouncerProvider, null, createElement(Story));

const preview: Preview = {
  decorators: [withTheme, withIntl, withAnnouncer],
  globalTypes: { ...localeGlobalType, ...themeGlobalType, ...contrastGlobalType },
  parameters: {
    layout: 'fullscreen',
    // Point the a11y panel at the SAME tag set the budget is counted against, read from
    // the budget file itself rather than restated here. A panel auditing axe's defaults
    // would show best-practice rules that CI does not count and omit `target-size`, which
    // CI does — so it would report violations nobody is asked to fix while staying silent
    // on ones that fail the build. One source of truth or the two lanes drift.
    a11y: {
      options: { runOnly: { type: 'tag', values: budget.tags } },
      // Two lanes want opposite things from this one parameter:
      //
      //  - The AUTHORING panel must be live, which is the whole reason the addon is here.
      //  - The test-runner must NOT also render a verdict. The addon runs its own axe
      //    pass and knows nothing about the budget, so in CI every already-budgeted
      //    violation printed "Found 1 a11y violations" beside a green run — which is how
      //    people learn to ignore a11y output. test-runner.ts owns the verdict: it counts
      //    per rule, per surface, against the ratchet.
      //
      // `test: 'off'` silences the runner but ALSO blanks the panel ("Accessibility tests
      // are disabled for this story") — one switch drives both. So the lane picks:
      // STORYBOOK_A11Y_TEST=off is set only by `test:stories:ci`, and the default keeps
      // the panel working for everyone running Storybook by hand.
      //
      // Caveat when reading the panel: axe's `color-contrast` only judges what is
      // actually RENDERED, so a cramped canvas (small window, panel docked at the bottom)
      // under-reports — ExportDialog/Options shows 0 violations squeezed and the real 1
      // once the canvas has room. The panel is a hint; CI is the count. Never conclude a
      // surface is clean from a panel reading alone.
      test: (import.meta.env['STORYBOOK_A11Y_TEST'] as 'off' | 'todo' | 'error' | undefined) ?? 'todo',
    },
  },
};

export default preview;
