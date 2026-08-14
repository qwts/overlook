import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { IconName, IconProps } from '../../src/renderer/src/components/Icon.js';
import type { SwitchProps } from '../../src/renderer/src/components/Switch.js';

register(new URL('../css-loader.mjs', import.meta.url));

// Icon.tsx and Switch.tsx are in the unit-coverage include, but the DOM
// compile's source maps do not remap into that lane. Rendering them here
// is what actually credits those files against the line floor.

test('every Icon glyph and both Switch label modes render', async () => {
  const { ICON_NAMES, Icon } = (await import('../../src/renderer/src/components/Icon.js')) as {
    ICON_NAMES: readonly IconName[];
    Icon: (props: IconProps) => ReactElement;
  };
  const { Switch } = (await import('../../src/renderer/src/components/Switch.js')) as {
    Switch: (props: SwitchProps) => ReactElement;
  };
  for (const name of ICON_NAMES) {
    // The coverage-lane Icon stub is a plain function, not React.FC — createElement's
    // overload set types the result as error; the markup assert is the contract.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- see above
    const svg = renderToStaticMarkup(createElement(Icon, { name, size: 16 }));
    assert.match(svg, /^<svg/u, `${name} renders an svg`);
  }
  const labeled = renderToStaticMarkup(createElement(Switch, { checked: true, label: 'On', onChange: () => undefined }));
  assert.match(labeled, /role="switch"/u);
  const accessible = renderToStaticMarkup(createElement(Switch, { checked: false, accessibleLabel: 'Back up', disabled: true }));
  assert.match(accessible, /aria-label="Back up"/u);
});
