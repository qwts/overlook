import { defineMessages, type IntlShape } from 'react-intl';

import { commandById, type CommandId } from '../../../shared/commands/registry.js';

const messages = defineMessages({
  skipped: {
    id: 'commands.photo.keys.skipped',
    defaultMessage:
      'Skipped {locked, plural, one {# locked photo} other {# locked photos}} and {missing, plural, one {# unavailable photo} other {# unavailable photos}}.',
  },
  unavailable: { id: 'commands.photo.keys.unavailable', defaultMessage: 'Could not verify photo keys. Try again.' },
  locked: { id: 'commands.photo.keys.locked', defaultMessage: 'The selected photos need keys that are not on this device.' },
  retry: { id: 'commands.photo.keys.retry', defaultMessage: 'Retry photo keys' },
  checking: { id: 'commands.photo.keys.checking', defaultMessage: 'Checking photo keys…' },
});

export { messages as photoKeyMessages };

/** Invocation-time read; presentation snapshots never authorize pixel operations. */
export async function photoCommandTargets(
  command: CommandId,
  photoIds: readonly string[],
  intl: IntlShape,
): Promise<{ readonly photoIds: readonly string[]; readonly notice: string | null }> {
  if (photoIds.length === 0) return { photoIds: [], notice: null };
  if (commandById(command).requiresPhotoKey !== true) return { photoIds, notice: null };
  try {
    const result = await window.overlook.library.photoKeySelection({ photoIds: [...photoIds] });
    return {
      photoIds: result.photoIds,
      notice:
        result.locked > 0 || result.missing > 0
          ? intl.formatMessage(messages.skipped, { locked: result.locked, missing: result.missing })
          : null,
    };
  } catch {
    return { photoIds: [], notice: intl.formatMessage(messages.unavailable) };
  }
}
