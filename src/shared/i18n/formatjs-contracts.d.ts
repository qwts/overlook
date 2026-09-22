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
declare module '@formatjs/intl' {
  function defineMessages<const D extends Record<string, MessageDescriptor & { id: keyof FormatjsIntl.MessageArguments }>>(
    messages: D,
  ): { readonly [K in keyof D]: Readonly<D[K]> & TypedMessageDescriptor<FormatjsIntl.MessageArguments[D[K]['id']]> };
}
