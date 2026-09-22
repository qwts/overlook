import { photoCommandAvailability } from './photo-availability.js';
import { QUICK_ACTION_COMMANDS, commandById, type QuickActionCommandId, type QuickActionExposure } from './registry.js';

export interface QuickActionVisibilityState {
  readonly modifierHeld: boolean;
  readonly targetId: string | null;
}

export type QuickActionVisibilityEvent =
  | { readonly type: 'modifier'; readonly held: boolean }
  | { readonly type: 'target'; readonly id: string | null }
  | { readonly type: 'dismiss' };

export const initialQuickActionVisibility: QuickActionVisibilityState = {
  modifierHeld: false,
  targetId: null,
};

export function reduceQuickActionVisibility(
  state: QuickActionVisibilityState,
  event: QuickActionVisibilityEvent,
): QuickActionVisibilityState {
  if (event.type === 'modifier') {
    return event.held ? { ...state, modifierHeld: true } : initialQuickActionVisibility;
  }
  if (event.type === 'target') return { ...state, targetId: event.id };
  return { ...state, targetId: null };
}

export interface QuickActionAvailabilityResult {
  readonly enabled: boolean;
  readonly reason: 'library-only' | 'trash-only' | 'locked' | null;
}

export function quickActionAvailability(
  commandId: QuickActionCommandId,
  location: 'library' | 'trash',
  locked = false,
): QuickActionAvailabilityResult {
  const exposure = quickActionExposure(commandId);
  if (exposure.availability === 'anywhere' || exposure.availability === location) {
    return photoCommandAvailability(commandId, locked);
  }
  return location === 'trash' ? { enabled: false, reason: 'library-only' } : { enabled: false, reason: 'trash-only' };
}

export function quickActionTargetIds(
  commandId: QuickActionCommandId,
  surfacedPhotoId: string,
  selection: readonly string[],
): readonly string[] {
  const exposure = quickActionExposure(commandId);
  return exposure.target === 'selection-if-included' && selection.includes(surfacedPhotoId) ? selection : [surfacedPhotoId];
}

function quickActionExposure(commandId: QuickActionCommandId): QuickActionExposure {
  const exposure = commandById(commandId).quickAction;
  if (exposure === undefined) throw new Error(`command is not a Quick Action: ${commandId}`);
  return exposure;
}

export function configuredQuickActions(ids: readonly QuickActionCommandId[]) {
  const byId = new Map(QUICK_ACTION_COMMANDS.map((command) => [command.id, command]));
  return ids.map((id) => byId.get(id)).filter((command): command is (typeof QUICK_ACTION_COMMANDS)[number] => command !== undefined);
}
