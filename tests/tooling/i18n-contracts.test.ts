import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

interface ContractsModule {
  messageArguments(elements: readonly unknown[]): Record<string, string>;
  renderMessageContracts(ast: Record<string, readonly unknown[]>): string;
}
const contracts = (await import(pathToFileURL(join(process.cwd(), 'scripts/i18n-contracts.mjs')).href)) as ContractsModule;

test('ICU contracts collect nested select/plural branches and rich-text children (#1170)', () => {
  assert.deepEqual(
    contracts.messageArguments([
      {
        type: 5,
        value: 'kind',
        options: {
          other: {
            value: [
              {
                type: 6,
                value: 'count',
                options: { other: { value: [{ type: 7 }, { type: 8, value: 'link', children: [{ type: 1, value: 'label' }] }] } },
              },
            ],
          },
        },
      },
      { type: 3, value: 'day' },
      { type: 4, value: 'time' },
      { type: 0, value: 'literal' },
    ]),
    { count: 'number', day: 'Date | number', kind: 'string', label: 'MessageValue', link: 'MessageTag', time: 'Date | number' },
  );
});

test('repeated ICU placeholders keep their strictest compatible type regardless of order (#1170)', () => {
  for (const types of [
    [1, 3, 2],
    [2, 3, 1],
    [1, 5],
    [5, 1],
  ]) {
    assert.deepEqual(contracts.messageArguments(types.map((type) => ({ type, value: 'value' }))), {
      value: types.includes(5) ? 'string' : 'number',
    });
  }
  for (const types of [
    [1, 8],
    [8, 1],
    [2, 5],
    [5, 2],
  ]) {
    assert.throws(() => contracts.messageArguments(types.map((type) => ({ type, value: 'value' }))), /collision|Incompatible/u);
  }
  assert.throws(() => contracts.messageArguments([{ type: 99 }]), /Unsupported ICU AST/u);
});

test('contract output is stable and derives no-argument IDs from the source catalog (#1170)', () => {
  const plain = [{ type: 0, value: 'Plain' }];
  const argument = [{ type: 1, value: 'name' }];
  const output = contracts.renderMessageContracts({ z: plain, b: argument, a: argument });
  assert.equal(output, contracts.renderMessageContracts({ a: argument, b: argument, z: plain }));
  assert.ok(output.indexOf('"a":') < output.indexOf('"b":'));
  assert.doesNotMatch(output, /"z":/u);
  assert.match(output, /keyof typeof en/u);
  assert.match(output, /Record<never, never>/u);
});
