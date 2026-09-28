import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { Switch } from '../../src/renderer/src/components/Switch.js';
import { Field } from '../../src/renderer/src/settings/Field.js';
import { SettingsGroup, settingsGroupProblems } from '../../src/renderer/src/settings/SettingsGroup.js';

// #1296 (Pass C spec, Group): a region named by its h3, described by its
// hint, holding at least two Field rows at the same indent; groups and rows
// never nest.

let root: Root | undefined;

afterEach(() => {
  if (root !== undefined) {
    act(() => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
});

function render(element: ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

const row = (label: string): ReactElement => (
  <Field key={label} label={label}>
    <Switch checked={false} />
  </Field>
);

test('a group is a region named by its heading and described by its hint', () => {
  const container = render(
    <SettingsGroup heading="All Photos" hint="These rules change only what All Photos shows.">
      {row('Show unavailable items')}
      {row('Minimum size')}
    </SettingsGroup>,
  );
  const section = container.querySelector('section');
  assert.ok(section);
  const heading = section.querySelector('h3');
  assert.equal(heading?.textContent, 'All Photos');
  assert.equal(section.getAttribute('aria-labelledby'), heading.id);
  const hint = document.getElementById(section.getAttribute('aria-describedby') ?? '');
  assert.equal(hint?.textContent, 'These rules change only what All Photos shows.');
  // A prose sentence: selectable, no-drag, UI type (AGENTS.md).
  assert.ok(hint.classList.contains('prose-note'));
  assert.equal(section.querySelectorAll(':scope > .ovl-settings__field').length, 2);
  assert.deepEqual(settingsGroupProblems(section), []);
});

test('the group rules catch too few rows, nested groups, and nested rows', () => {
  const container = render(
    <SettingsGroup heading="Outer">
      {row('Only row')}
      <SettingsGroup heading="Inner">
        {row('A')}
        {row('B')}
      </SettingsGroup>
      <Field label="Wrapper" layout="stacked">
        {row('Nested')}
      </Field>
    </SettingsGroup>,
  );
  const [outer, inner] = Array.from(container.querySelectorAll('section'));
  assert.ok(outer && inner);
  // Outer has two direct rows (Only row, Wrapper), so only the nesting fails.
  assert.deepEqual(settingsGroupProblems(outer), ['contains another SettingsGroup', 'contains a Field nested in another Field']);
  assert.deepEqual(settingsGroupProblems(inner), ['is nested in another SettingsGroup']);
});

test('one row is too few for a group', () => {
  const container = render(<SettingsGroup heading="Lonely">{row('Only row')}</SettingsGroup>);
  const section = container.querySelector('section');
  assert.ok(section);
  assert.deepEqual(settingsGroupProblems(section), ['needs at least 2 Field rows directly inside it, found 1']);
});
