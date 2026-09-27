import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { Button } from '../../src/renderer/src/components/Button.js';
import { Segmented } from '../../src/renderer/src/components/Segmented.js';
import { Slider } from '../../src/renderer/src/components/Slider.js';
import { Switch } from '../../src/renderer/src/components/Switch.js';
import { Field, FieldSelect } from '../../src/renderer/src/settings/Field.js';

// #1295 (Pass C spec, Names): an auto row's control is named by the row's
// label and described by its hint, with no wrapper group; a stacked row stays
// a group named by the label; buttons keep their own names.

let root: Root | undefined;

afterEach(() => {
  if (root !== undefined) {
    act(() => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
});

function render(element: ReactElement): void {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

function text(ids: string | null): string {
  return (ids ?? '')
    .split(' ')
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
}

test('an auto row names each kind of control by its label and describes it by its hint', () => {
  render(
    <>
      <Field label="Lock when hidden" hint="Also lock when the app is hidden or minimized.">
        <Switch checked={false} />
      </Field>
      <Field label="Auto-lock" hint="Lock after input has been idle.">
        <Segmented value="5" options={['1', '5']} onChange={() => undefined} />
      </Field>
      <Field label="Language" hint="Applies after restart.">
        <FieldSelect value="" onChange={() => undefined}>
          <option value="">System</option>
        </FieldSelect>
      </Field>
      <Field label="Upload bandwidth limit" hint="Unlimited">
        <Slider value={100} onChange={() => undefined} />
      </Field>
    </>,
  );
  const controls = [
    ['[role="switch"]', 'Lock when hidden', 'Also lock when the app is hidden or minimized.'],
    ['[role="radiogroup"]', 'Auto-lock', 'Lock after input has been idle.'],
    ['select', 'Language', 'Applies after restart.'],
    ['input[type="range"]', 'Upload bandwidth limit', 'Unlimited'],
  ] as const;
  for (const [selector, name, description] of controls) {
    const control = document.querySelector(selector);
    assert.ok(control, selector);
    assert.equal(control.getAttribute('aria-label'), null, `${selector} has no second copy of its label`);
    assert.equal(text(control.getAttribute('aria-labelledby')), name, selector);
    assert.equal(text(control.getAttribute('aria-describedby')), description, selector);
  }
  assert.equal(document.querySelectorAll('[role="group"]').length, 0);
  assert.ok(document.querySelector('select')?.classList.contains('ovl-settings__select'));
});

test('a row with no hint names its control and describes nothing', () => {
  render(
    <Field label="Sort order">
      <Segmented value="date" options={['date', 'name']} onChange={() => undefined} />
    </Field>,
  );
  const group = document.querySelector('[role="radiogroup"]');
  assert.equal(text(group?.getAttribute('aria-labelledby') ?? null), 'Sort order');
  assert.equal(group?.getAttribute('aria-describedby'), null);
});

test('a button in an auto row keeps its name and is described by the row', () => {
  render(
    <Field label="App password" hint="Required on launch and after every lock.">
      <Button>Change…</Button>
    </Field>,
  );
  const button = document.querySelector('button');
  assert.equal(button?.textContent, 'Change…');
  assert.equal(button.getAttribute('aria-labelledby'), null);
  assert.equal(text(button.getAttribute('aria-describedby')), 'App password Required on launch and after every lock.');
});

test('a stacked row is a group named by its label; its controls name themselves', () => {
  render(
    <Field layout="stacked" label="Share diagnostics" hint="Anonymous crash reports only.">
      <Switch checked={false} accessibleLabel="Share diagnostics" />
      <Button>Review report</Button>
    </Field>,
  );
  const group = document.querySelector('[role="group"]');
  assert.ok(group);
  assert.equal(text(group.getAttribute('aria-labelledby')), 'Share diagnostics');
  assert.equal(text(group.getAttribute('aria-describedby')), 'Anonymous crash reports only.');
  const control = document.querySelector('[role="switch"]');
  assert.equal(control?.getAttribute('aria-label'), 'Share diagnostics');
  assert.equal(control.getAttribute('aria-labelledby'), null);
  assert.equal(document.querySelector('button:not([role])')?.getAttribute('aria-describedby'), null);
  assert.ok(document.querySelector('.ovl-settings__field--stacked'));
});

test('a control that names itself keeps its name inside an auto row', () => {
  render(
    <Field label="Backup provider">
      <Segmented label="Provider" value="a" options={['a', 'b']} onChange={() => undefined} />
    </Field>,
  );
  const group = document.querySelector('[role="radiogroup"]');
  assert.equal(group?.getAttribute('aria-label'), 'Provider');
  assert.equal(group.getAttribute('aria-labelledby'), null);
});

test('hints are sans, muted, and capped at a reading measure, never meta type', () => {
  const css = readFileSync(new URL('../../../src/renderer/src/settings/settings.css', import.meta.url), 'utf8');
  const hint = /\.ovl-settings__fieldHint\s*\{([^}]*)\}/u.exec(css)?.[1] ?? '';
  assert.match(hint, /font-family:\s*var\(--font-ui\)/u);
  assert.match(hint, /color:\s*var\(--text-muted\)/u);
  assert.match(hint, /max-width:\s*60ch/u);
  assert.doesNotMatch(hint, /--type-meta/u);
  assert.match(css, /\.ovl-settings__fieldText\s*\{[^}]*flex:\s*1 1 220px/u);
  assert.doesNotMatch(css, /ovl-settings__field--wide/u);
});
