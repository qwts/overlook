import { defineMessages, type IntlShape } from 'react-intl';

import type { PreviewFailureReason } from '../../../shared/library/preview.js';

const messages = defineMessages({
  deferred: { id: 'preview.pending.original', defaultMessage: 'Previews pending — original required on this device' },
  generic: { id: 'preview.unavailable', defaultMessage: 'Preview unavailable' },
  corrupt: { id: 'preview.unavailable.corrupt', defaultMessage: 'Preview unavailable — file is corrupt' },
  unsupportedCodec: {
    id: 'preview.unavailable.unsupportedCodec',
    defaultMessage: 'Preview unavailable — HEIC codec is unsupported',
  },
  decodeFailed: { id: 'preview.unavailable.decodeFailed', defaultMessage: 'Preview unavailable — image decode failed' },
});

export function previewFailureLabel(intl: IntlShape, failure: PreviewFailureReason | null | undefined): string {
  if (failure === 'deferred-original') return intl.formatMessage(messages.deferred);
  if (failure === 'corrupt') return intl.formatMessage(messages.corrupt);
  if (failure === 'unsupported-codec') return intl.formatMessage(messages.unsupportedCodec);
  if (failure === 'decode-failed') return intl.formatMessage(messages.decodeFailed);
  return intl.formatMessage(messages.generic);
}
