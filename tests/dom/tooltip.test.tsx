import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { Tooltip } from '../../src/renderer/src/components/Tooltip.js';

// #1290: a toolbar control's tooltip is disabled at some collapse levels. A
// bubble shown before disabling must not come back, stale, on re-enabling.
test('a tooltip disabled while shown stays hidden when re-enabled until shown again', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = async (disabled: boolean): Promise<void> => {
    await act(async () => {
      root.render(
        <Tooltip label="Import photos" disabled={disabled}>
          <button type="button">Import</button>
        </Tooltip>,
      );
      await Promise.resolve();
    });
  };
  const button = (): HTMLButtonElement => {
    const found = host.querySelector('button');
    assert.ok(found);
    return found;
  };

  await render(false);
  await act(async () => {
    button().focus();
    await Promise.resolve();
  });
  assert.equal(host.querySelector('[role="tooltip"]')?.textContent, 'Import photos');
  assert.ok(button().getAttribute('aria-describedby'));

  await render(true);
  assert.equal(host.querySelector('[role="tooltip"]'), null);
  await render(false);
  assert.equal(host.querySelector('[role="tooltip"]'), null);
  assert.equal(button().getAttribute('aria-describedby'), null);

  await act(async () => {
    button().blur();
    button().focus();
    await Promise.resolve();
  });
  assert.equal(host.querySelector('[role="tooltip"]')?.textContent, 'Import photos');

  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  host.remove();
});
