import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  COLLAPSE_STEP_DOWN_SPARE_PX,
  settleCollapseLevel,
  type ToolbarCollapseLevel,
} from '../../src/renderer/src/shell/toolbar-collapse.js';

// #1290: the collapse levels' settle rule, against a row whose content needs
// these widths at levels 0–4 (roughly this build's, with Back up and Lock).
const NEEDS = [1066, 936, 764, 700, 470] as const;

function rowAt(width: number): (level: ToolbarCollapseLevel, spare: number) => boolean {
  return (level, spare) => width >= NEEDS[level] + spare;
}

test('a row that fits at level 0 stays expanded', () => {
  assert.equal(settleCollapseLevel(0, rowAt(1280)), 0);
});

test('an overflowing row steps up through as many levels as it needs', () => {
  assert.equal(settleCollapseLevel(0, rowAt(1065)), 1);
  assert.equal(settleCollapseLevel(0, rowAt(900)), 2);
  assert.equal(settleCollapseLevel(0, rowAt(480)), 4);
});

test('level 4 is the last level, even when nothing fits', () => {
  assert.equal(settleCollapseLevel(0, rowAt(200)), 4);
});

test('a row steps down only when the lower level fits with room to spare', () => {
  assert.equal(COLLAPSE_STEP_DOWN_SPARE_PX, 16);
  assert.equal(settleCollapseLevel(1, rowAt(1066)), 1);
  assert.equal(settleCollapseLevel(1, rowAt(1081)), 1);
  assert.equal(settleCollapseLevel(1, rowAt(1082)), 0);
  assert.equal(settleCollapseLevel(4, rowAt(1440)), 0);
});

test('holding within ±8px of a step does not flicker', () => {
  let level = settleCollapseLevel(0, rowAt(1072));
  assert.equal(level, 0);
  level = settleCollapseLevel(level, rowAt(1058));
  assert.equal(level, 1);
  for (const width of [1074, 1058, 1074, 1066]) {
    level = settleCollapseLevel(level, rowAt(width));
    assert.equal(level, 1, `at ${width}px`);
  }
});

test('a sweep moves through every level in order and back', () => {
  const down: number[] = [];
  let level: ToolbarCollapseLevel = 0;
  for (let width = 1440; width >= 480; width -= 40) {
    level = settleCollapseLevel(level, rowAt(width));
    if (down.at(-1) !== level) down.push(level);
  }
  assert.deepEqual(down, [0, 1, 2, 3, 4]);
  const up: number[] = [];
  for (let width = 480; width <= 1440; width += 40) {
    level = settleCollapseLevel(level, rowAt(width));
    if (up.at(-1) !== level) up.push(level);
  }
  assert.deepEqual(up, [4, 3, 2, 1, 0]);
});

test('no toolbar rule lets the row wrap', () => {
  const css = readFileSync('src/renderer/src/shell/shell.css', 'utf8');
  const toolbarRules = css.match(/[^{}]*\.ovl-toolbar[^{}]*\{[^}]*\}/g) ?? [];
  assert.ok(toolbarRules.length > 0);
  for (const rule of toolbarRules) assert.doesNotMatch(rule, /flex-wrap:\s*wrap/, rule);
});
