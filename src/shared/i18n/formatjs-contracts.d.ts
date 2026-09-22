import type { MessageDescriptor, TypedMessageDescriptor } from '@formatjs/intl';
import type { SourceMessageArguments } from './generated/en.js';

declare global {
  namespace FormatjsIntl {
    // Declaration merging requires an interface for the upstream registry extension point.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface MessageArguments extends SourceMessageArguments {}
  }
}

// Bind literal source-catalog IDs to their generated ICU argument contracts.
// Upstream defineMessages inference otherwise assigns an empty argument contract.
// Remove this bridge when upstream infers registered IDs, retaining the negative
// compile checks in tests/i18n/message-contracts.test.ts. Root tsconfig.files keeps
// this registry present even in projects that replace the inherited include list.
declare module '@formatjs/intl' {
  function defineMessages<const D extends Record<string, MessageDescriptor & { id: keyof FormatjsIntl.MessageArguments }>>(
    messages: D,
  ): { readonly [K in keyof D]: Readonly<D[K]> & TypedMessageDescriptor<FormatjsIntl.MessageArguments[D[K]['id']]> };
}
