import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseCssColor } from '../../src/shared/theme/css-color.js';

describe('user-theme CSS color parser (#396)', () => {
  test('parses every accepted v1 color family into canonical numeric CSS', () => {
    for (const value of [
      '#336699cc',
      'rgb(20% 40% 60% / 80%)',
      'hsl(210 50% 40% / .8)',
      'oklch(0.5 0.1 250 / 0.8)',
      'color(display-p3 0.2 0.4 0.6 / 0.8)',
    ]) {
      const parsed = parseCssColor(value);
      assert.match(parsed.css, /^rgb\([\d.]+% [\d.]+% [\d.]+% \/ 0\.8\)$/);
      assert.equal(parsed.alpha, 0.8);
      assert.ok(parsed.srgb.every((channel) => channel >= 0 && channel <= 1));
    }
  });

  test('never passes source syntax through to the canonical value', () => {
    assert.equal(parseCssColor('#fff').css, 'rgb(100% 100% 100%)');
    for (const hostile of [
      'var(--surface-window)',
      'calc(1 + 1)',
      'url(https://example.com/a)',
      'red; background: url(https://example.com)',
      'color(srgb 0 0 0){}',
      '@import "https://example.com/x.css"',
    ]) {
      assert.throws(() => parseCssColor(hostile));
    }
  });

  test('rejects unsupported spaces and out-of-range channels', () => {
    assert.throws(() => parseCssColor('color(xyz 0 0 0)'), /unsupported color\(\) space/);
    assert.throws(() => parseCssColor('rgb(256 0 0)'), /between 0 and 255/);
    assert.throws(() => parseCssColor('oklch(1.1 0.1 0)'), /between 0 and 1/);
  });
});
