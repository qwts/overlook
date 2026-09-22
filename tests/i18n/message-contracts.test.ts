import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIntl, createIntlCache, defineMessage, defineMessages, type IntlShape } from 'react-intl';

import { en } from '../../src/shared/i18n/generated/en.js';

const numeric = defineMessage<{ value: number | bigint }>({ id: 'test.numeric', defaultMessage: '{value, number}' });

const messages = defineMessages({
  count: { id: 'coverage.dialog.skips', defaultMessage: '{count, plural, one {# will be skipped} other {# will be skipped}}' },
  rich: { id: 'sidebar.notConnected', defaultMessage: '{provider} not connected — <cta>Connect</cta>' },
  plain: { id: 'activity.empty', defaultMessage: 'Library activity will appear here.' },
});

// This function is compiled, never executed. Unused @ts-expect-error directives
// fail typecheck if an overload starts accepting invalid interpolation values.
function invalidCalls(intl: IntlShape): void {
  // @ts-expect-error Numeric ICU contracts do not accept string operands.
  intl.formatMessage(numeric, { value: 'two' });
  // @ts-expect-error The plural count is required.
  intl.formatMessage(messages.count);
  // @ts-expect-error ICU plural operands must be numbers.
  intl.formatMessage(messages.count, { count: 'two' });
  // @ts-expect-error The rich-text callback is required.
  intl.formatMessage(messages.rich, { provider: 'Drive' });
  // @ts-expect-error A rich-text tag cannot be replaced with a primitive value.
  intl.formatMessage(messages.rich, { provider: 'Drive', cta: 'Connect' });
  // @ts-expect-error Plain messages have no interpolation arguments.
  intl.formatMessage(messages.plain, { extra: 'unexpected' });
  // @ts-expect-error Registered IDs also enforce their contracts without defineMessages.
  intl.formatMessage({ id: 'coverage.dialog.skips' }, { count: 'two' });
}
void invalidCalls;

test('generated FormatJS contracts preserve plain, plural and rich-text rendering (#1170)', () => {
  const intl = createIntl(
    {
      locale: 'en',
      messages: en,
      onError: (error) => {
        throw error;
      },
    },
    createIntlCache(),
  );
  assert.equal(intl.formatMessage(numeric, { value: 2n }), '2');
  assert.equal(intl.formatMessage(numeric, { value: 2 }), '2');
  assert.equal(intl.formatMessage(messages.plain), 'Library activity will appear here.');
  assert.equal(intl.formatMessage(messages.count, { count: 2 }), '2 will be skipped');
  assert.equal(intl.formatMessage(messages.rich, { provider: 'Drive', cta: (parts) => parts }), 'Drive not connected — Connect');
});
