import { z } from 'zod';

import { COMMANDS, type CommandId } from './registry.js';

const commandIds = new Set<string>(COMMANDS.map(({ id }) => id));

export const commandIdSchema = z.custom<CommandId>((value) => typeof value === 'string' && commandIds.has(value), 'unknown command id');

export const commandMenuContextSchema = z
  .object({
    surface: z.enum(['locked', 'onboarding', 'grid', 'lightbox']),
    dialog: z.enum(['none', 'import', 'export', 'settings', 'libraries', 'other']),
    editable: z.boolean(),
    hasLibrary: z.boolean(),
    hasPhotos: z.boolean(),
    hasTarget: z.boolean(),
    targetTrashable: z.boolean(),
    /** The active route is an album (#689 Photo menu "Remove from Album"). */
    inAlbum: z.boolean(),
    /** Protected albums have their own authorized export boundary. */
    protectedAlbumOpen: z.boolean(),
    selectionCount: z.number().int().nonnegative().max(100_000),
    appLockConfigured: z.boolean(),
    providerBusy: z.boolean(),
    pcloudEnabled: z.boolean(),
    inspectorOpen: z.boolean(),
    view: z.enum(['grid', 'list', 'moodboard']),
    source: z.enum(['all', 'favorites', 'recent', 'offloaded', 'deleted']),
  })
  .strict();

export type CommandMenuContext = z.output<typeof commandMenuContextSchema>;

export const EMPTY_COMMAND_MENU_CONTEXT: CommandMenuContext = {
  surface: 'onboarding',
  dialog: 'none',
  editable: false,
  hasLibrary: false,
  hasPhotos: false,
  hasTarget: false,
  targetTrashable: false,
  inAlbum: false,
  protectedAlbumOpen: false,
  selectionCount: 0,
  appLockConfigured: false,
  providerBusy: false,
  pcloudEnabled: false,
  inspectorOpen: false,
  view: 'grid',
  source: 'all',
};
