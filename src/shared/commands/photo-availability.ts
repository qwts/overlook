import { commandById, type CommandId } from './registry.js';

/** Presentation for a known single photo, not authorization for a bulk request. */
export function photoCommandAvailability(
  commandId: CommandId,
  locked: boolean,
): {
  readonly enabled: boolean;
  readonly reason: 'locked' | null;
} {
  return locked && commandById(commandId).requiresPhotoKey === true
    ? { enabled: false, reason: 'locked' }
    : { enabled: true, reason: null };
}

export const LOCKED_PHOTO_COMMAND_REASON = {
  id: 'inspector.custody.locked',
  defaultMessage: 'LOCKED — KEY #{id} IS NOT ON THIS DEVICE',
} as const;
