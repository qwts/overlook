import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

register(new URL('../css-loader.mjs', import.meta.url));

interface IconModule {
  readonly ICON_NAMES: readonly string[];
  readonly Icon: (props: { readonly name: string; readonly size: number }) => ReactElement;
}

interface SwitchModule {
  readonly Switch: (props: {
    readonly checked: boolean;
    readonly label?: string;
    readonly accessibleLabel?: string;
    readonly disabled?: boolean;
    readonly onChange?: (checked: boolean) => void;
  }) => ReactElement;
}

// Typed as string so root `tsc --noEmit` (no jsx) cannot resolve the .tsx
// sources. The unit compile still emits them via tsconfig.test.json.
const iconSpecifier: string = '../../src/renderer/src/components/Icon.js';
const switchSpecifier: string = '../../src/renderer/src/components/Switch.js';

// Icon.tsx and Switch.tsx are in the unit-coverage include, but the DOM
// compile's source maps do not remap into that lane. Rendering them here
// is what actually credits those files against the line floor.

test('every Icon glyph and both Switch label modes render', async () => {
  const { ICON_NAMES, Icon } = (await import(iconSpecifier)) as IconModule;
  const { Switch } = (await import(switchSpecifier)) as SwitchModule;
  for (const name of ICON_NAMES) {
    const svg = renderToStaticMarkup(createElement(Icon, { name, size: 16 }));
    assert.match(svg, /^<svg/u, `${name} renders an svg`);
  }
  const labeled = renderToStaticMarkup(createElement(Switch, { checked: true, label: 'On', onChange: () => undefined }));
  assert.match(labeled, /role="switch"/u);
  const accessible = renderToStaticMarkup(createElement(Switch, { checked: false, accessibleLabel: 'Back up', disabled: true }));
  assert.match(accessible, /aria-label="Back up"/u);
});
