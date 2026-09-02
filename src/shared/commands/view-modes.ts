import type { CommandId } from './registry.js';
import type { ViewMode } from '../library/app-state.js';

// The view-mode commands and the view each one selects, in the order the
// toolbar's view control and the View menu list them. The toolbar projects
// its options from this table and the native command router executes the
// same commands through it (ADR-0024 parity), so a label, an icon, or a mode
// can never drift between the two surfaces.
export const VIEW_MODE_BY_COMMAND = {
  'view.mode.grid': 'grid',
  'view.mode.list': 'list',
  'view.mode.feed': 'feed',
  'view.mode.moodboard': 'moodboard',
} as const satisfies Partial<Record<CommandId, ViewMode>>;

export type ViewModeCommandId = keyof typeof VIEW_MODE_BY_COMMAND;

export const VIEW_MODE_COMMAND_IDS: readonly ViewModeCommandId[] = [
  'view.mode.grid',
  'view.mode.list',
  'view.mode.feed',
  'view.mode.moodboard',
];
