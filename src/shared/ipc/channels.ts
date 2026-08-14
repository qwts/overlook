import { z } from 'zod';

import { settingsPatchSchema, settingsSchema } from '../settings/settings.js';
import { libraryDescriptorSchema, libraryIdSchema } from '../library/registry.js';
import { mediaInfoSchema } from '../library/media-info.js';
import {
  relocationFailureReasonSchema,
  relocationModeSchema,
  relocationMoveResponseSchema,
  relocationStateSchema,
} from '../library/relocation.js';
import {
  providerConnectionStatusSchema,
  providerDescriptorSchema,
  providerIdSchema,
  providerCapacityStatusSchema,
} from '../backup/provider-descriptor.js';
import { diagnosticsChannels } from './diagnostics-channels.js';
import { llmChannels, llmEvents } from './llm-channels.js';
import { restoreDiscoverResponseSchema, restoreProgressSchema, restoreRunResponseSchema } from '../backup/restore-contract.js';
import { PHOTO_PURGE_AUTHORIZATION } from '../destructive-actions.js';
import { commandIdSchema, commandMenuContextSchema } from '../commands/menu-contract.js';
import { activityPageRequestSchema, activityPageResponseSchema } from '../activity/schemas.js';
import { historyExecuteRequestSchema, historyExecuteResponseSchema, historyStatusSchema } from '../history/schemas.js';
import { inspectorWindowChannels, windowEvents } from '../inspector-window-contract.js';
import { interopChannels, interopEvents } from './interop-channels.js';
import * as originalPolicy from './original-policy-channels.js';
import { albumChannels } from './album-channels.js';
import { boardChannels, boardEvents } from './board-channels.js';
import { embeddingChannels, embeddingEvents } from './embedding-channels.js';

// Central IPC contract registry: every renderer↔main channel and main→renderer
// event is declared here with request/response (or payload) schemas. Main
// registers handlers and preload exposes invokers for exactly this set —
// nothing else crosses the process boundary (#49).

export interface ChannelDefinition<TRequest extends z.ZodType, TResponse extends z.ZodType> {
  readonly name: string;
  readonly request: TRequest;
  readonly response: TResponse;
}

export interface EventDefinition<TPayload extends z.ZodType> {
  readonly name: string;
  readonly payload: TPayload;
}

function defineChannel<TRequest extends z.ZodType, TResponse extends z.ZodType>(
  name: string,
  request: TRequest,
  response: TResponse,
): ChannelDefinition<TRequest, TResponse> {
  return { name, request, response };
}

const defineEvent = <TPayload extends z.ZodType>(name: string, payload: TPayload): EventDefinition<TPayload> => ({ name, payload });

const pageCursorSchema = z.object({ sortKey: z.union([z.string(), z.number()]), id: z.string() });

const chipFiltersSchema = z.object({
  favorites: z.boolean().optional(),
  raw: z.boolean().optional(),
  offloaded: z.boolean().optional(),
  localOnly: z.boolean().optional(),
});

const sourceFilterSchema = z.enum(['all', 'favorites', 'recent', 'offloaded', 'deleted']);
const appLockStateSchema = z.enum(['unconfigured-unlocked', 'locked', 'unlocking', 'unlocked', 'locking', 'recovery-required']);
const appLockStatusSchema = z.object({
  state: appLockStateSchema,
  libraryId: z.string().nullable(),
  retryAfterMs: z.number().int().nonnegative(),
});
const touchIdUnavailableReasonSchema = z.enum([
  'unsupported-platform',
  'unsigned-build',
  'native-unavailable',
  'not-enrolled',
  'locked-out',
  'unavailable',
]);
const touchIdStatusSchema = z.object({
  available: z.boolean(),
  reason: touchIdUnavailableReasonSchema.nullable(),
  enabled: z.boolean(),
  reenrollmentRequired: z.boolean(),
});

const importSourceSchema = z.object({
  path: z.string(),
  label: z.string(),
  kind: z.enum(['volume', 'folder']),
});

const scanSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  newCount: z.number().int().nonnegative(),
  newBytes: z.number().int().nonnegative(),
  newRaw: z.number().int().nonnegative(),
  newJpg: z.number().int().nonnegative(),
  newOther: z.number().int().nonnegative(),
});

const googleDrivePickFailureSchema = z.enum([
  'cancelled',
  'unavailable',
  'busy',
  'authorization-failed',
  'no-supported-files',
  'download-failed',
]);

const importRunSummarySchema = z.object({
  imported: z.number().int().nonnegative(),
  moved: z.number().int().nonnegative(),
  retained: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
});

const syncStatusSchema = z.enum(['local', 'syncing', 'synced', 'offloaded', 'error']);
const backupIntegritySchema = z.object({
  checked: z.number().int().nonnegative(),
  repaired: z.number().int().nonnegative(),
  unrecoverable: z.number().int().nonnegative(),
  recoveryRepaired: z.boolean(),
  failed: z.boolean(),
});
const offloadSkipReasonSchema = z.enum([
  'missing-photo',
  'deleted',
  'provider-disconnected',
  'provider-expired',
  'provider-offline',
  'local',
  'syncing',
  'already-offloaded',
  'error',
  'dirty',
  'shared-original',
  'missing-original',
  'remote-missing',
  'remote-mismatch',
  'remote-unverified',
]);
const offloadPreflightItemSchema = z.object({
  photoId: z.string(),
  bytes: z.number().nonnegative(),
  eligible: z.boolean(),
  reason: offloadSkipReasonSchema.nullable(),
});
const offloadPreflightSchema = z.object({
  eligible: z.number().int().nonnegative(),
  ineligible: z.number().int().nonnegative(),
  estimatedFreedBytes: z.number().nonnegative(),
  items: z.array(offloadPreflightItemSchema).readonly(),
});
const restoreOriginalFailureReasonSchema = z.enum([
  'not-offloaded',
  'provider-disconnected',
  'provider-expired',
  'provider-offline',
  'download-failed',
  'verify-failed',
]);

const photoRecordSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  fileKind: z.enum(['jpeg', 'raw', 'png', 'heic', 'gif', 'webp', 'video', 'audio', 'other']),
  width: z.number(),
  height: z.number(),
  bytes: z.number(),
  contentHash: z.string(),
  camera: z.string().nullable(),
  lens: z.string().nullable(),
  iso: z.number().nullable(),
  aperture: z.string().nullable(),
  shutter: z.string().nullable(),
  focalLength: z.number().nullable(),
  takenAt: z.string().nullable(),
  gpsLat: z.number().nullable(),
  gpsLon: z.number().nullable(),
  place: z.string().nullable(),
  importedAt: z.string(),
  importSource: z.string(),
  favorite: z.boolean(),
  isOriginal: z.boolean(),
  keyId: z.number(),
  deletedAt: z.string().nullable(),
  previewFailure: z.enum(['corrupt', 'unsupported-codec', 'decode-failed']).nullable(),
  dimensionStatus: z.enum(['legacy', 'verified', 'metadata-mismatch', 'unavailable']),
  mediaInfo: mediaInfoSchema.nullable(),
  syncState: syncStatusSchema,
});

const protectedPhotoRecordSchema = photoRecordSchema.omit({
  contentHash: true,
  isOriginal: true,
  keyId: true,
  previewFailure: true,
  dimensionStatus: true,
  syncState: true,
});
const protectedPageCursorSchema = z.object({ position: z.number().int().nonnegative(), id: z.string().min(1) });

export const channels = {
  ping: defineChannel('demo:ping', z.object({ message: z.string() }), z.object({ echoed: z.string() })),
  getPlatform: defineChannel('app:get-platform', z.object({}), z.object({ platform: z.string() })),
  getLocale: defineChannel('app:get-locale', z.object({}), z.object({ locale: z.string() })),
  windowMinimize: defineChannel('window:minimize', z.object({}), z.object({})),
  windowToggleMaximize: defineChannel('window:toggle-maximize', z.object({}), z.object({ maximized: z.boolean() })),
  windowClose: defineChannel('window:close', z.object({}), z.object({})),
  ...inspectorWindowChannels,
  commandRendererReady: defineChannel('commands:renderer-ready', commandMenuContextSchema, z.object({})),
  commandContextUpdate: defineChannel('commands:context-update', commandMenuContextSchema, z.object({})),
  // Opens the project help externally. The macOS Help menu dispatches `help.open`
  // in main; the Windows/Linux titlebar Help menu reaches the same action here.
  helpOpen: defineChannel('help:open', z.object({}), z.object({})),
  appLockStatus: defineChannel('app-lock:status', z.object({}), appLockStatusSchema),
  appLockUnlock: defineChannel(
    'app-lock:unlock',
    z.object({ password: z.string().min(1).max(1024) }),
    z.object({
      ok: z.boolean(),
      reason: z.enum(['wrong-password', 'recovery-required', 'throttled']).nullable(),
      retryAfterMs: z.number().int().nonnegative(),
    }),
  ),
  appLockConfigure: defineChannel('app-lock:configure', z.object({ password: z.string().min(8).max(1024) }), appLockStatusSchema),
  appLockNow: defineChannel('app-lock:lock-now', z.object({}), appLockStatusSchema),
  appLockChangePassword: defineChannel(
    'app-lock:change-password',
    z.object({ currentPassword: z.string().min(1).max(1024), nextPassword: z.string().min(8).max(1024) }),
    z.object({ changed: z.boolean() }),
  ),
  appLockRemove: defineChannel('app-lock:remove', z.object({ password: z.string().min(1).max(1024) }), z.object({ removed: z.boolean() })),
  ...interopChannels,
  appLockPickRecovery: defineChannel('app-lock:pick-recovery', z.object({}), z.object({ path: z.string().nullable() })),
  appLockRecover: defineChannel(
    'app-lock:recover',
    z.object({
      path: z.string().min(1),
      recoveryPassword: z.string().min(1).max(1024),
      nextPassword: z.string().min(8).max(1024),
    }),
    z.object({ recovered: z.boolean(), reason: z.enum(['invalid', 'wrong-password', 'mismatch']).nullable() }),
  ),
  appLockTouchIdStatus: defineChannel('app-lock:touch-id-status', z.object({}), touchIdStatusSchema),
  appLockTouchIdEnable: defineChannel(
    'app-lock:touch-id-enable',
    z.object({ password: z.string().min(1).max(1024) }),
    z.object({
      enabled: z.boolean(),
      reason: z.union([touchIdUnavailableReasonSchema, z.enum(['wrong-password', 'recovery-required'])]).nullable(),
    }),
  ),
  appLockTouchIdDisable: defineChannel('app-lock:touch-id-disable', z.object({}), z.object({ disabled: z.boolean() })),
  appLockTouchIdUnlock: defineChannel(
    'app-lock:touch-id-unlock',
    z.object({}),
    z.object({
      ok: z.boolean(),
      reason: z
        .enum(['not-enabled', 'cancelled', 'failed', 'locked-out', 'unavailable', 'enrollment-changed', 'recovery-required'])
        .nullable(),
    }),
  ),
  // Library contract (#71) — the renderer's typed window into the library.
  libraryPage: defineChannel(
    'library:page',
    z.object({
      source: sourceFilterSchema,
      limit: z.number().int().positive().max(500),
      cursor: pageCursorSchema.optional(),
      recentSince: z.string().optional(),
      query: z.string().optional(),
      chips: chipFiltersSchema.optional(),
      order: z.enum(['date', 'name', 'size']).optional(),
      albumId: z.string().optional(),
    }),
    z.object({ photos: z.array(photoRecordSchema).readonly(), nextCursor: pageCursorSchema.nullable() }),
  ),
  libraryGet: defineChannel('library:get', z.object({ id: z.string() }), z.object({ photo: photoRecordSchema.nullable() })),
  libraryRepairDimensions: defineChannel(
    'library:repair-dimensions',
    z.object({
      id: z.string().min(1),
      width: z.number().int().positive().max(1_000_000),
      height: z.number().int().positive().max(1_000_000),
    }),
    z.object({ repaired: z.boolean(), pendingCount: z.number().int().nonnegative() }),
  ),
  libraryToggleFavorite: defineChannel(
    'library:toggle-favorite',
    z.object({ id: z.string() }),
    z.object({ favorite: z.boolean(), pendingCount: z.number().int().nonnegative() }),
  ),
  ...originalPolicy.originalPolicyChannels,
  libraryCounts: defineChannel(
    'library:counts',
    z.object({ recentSince: z.string() }),
    z.object({
      all: z.number(),
      favorites: z.number(),
      recent: z.number(),
      offloaded: z.number(),
      deleted: z.number(),
    }),
  ),
  libraryAlbums: defineChannel(
    'library:albums',
    z.object({}),
    z.object({ albums: z.array(z.object({ id: z.string(), name: z.string(), count: z.number().int().nonnegative() })).readonly() }),
  ),
  activityPage: defineChannel('activity:page', activityPageRequestSchema, activityPageResponseSchema),
  historyStatus: defineChannel('history:status', z.object({}), historyStatusSchema),
  historyUndo: defineChannel('history:undo', historyExecuteRequestSchema, historyExecuteResponseSchema),
  historyRedo: defineChannel('history:redo', historyExecuteRequestSchema, historyExecuteResponseSchema),
  protectedAlbumsList: defineChannel(
    'protected-album:list',
    z.object({}),
    z.object({
      albums: z
        .array(
          z.object({
            id: z.string().min(1),
            label: z.literal('Protected album'),
            locked: z.boolean(),
          }),
        )
        .readonly(),
    }),
  ),
  protectedAlbumProtect: defineChannel(
    'protected-album:protect',
    z.object({ albumId: z.string().min(1), password: z.string().min(1).max(1024) }),
    z.object({
      ok: z.boolean(),
      albumId: z.string().nullable(),
      reason: z.enum(['not-found', 'empty', 'conflict', 'wrong-password', 'cancelled', 'failed']).nullable(),
    }),
  ),
  protectedAlbumUnprotect: defineChannel(
    'protected-album:unprotect',
    z.object({ albumId: z.string().min(1).max(256), password: z.string().min(1).max(1024) }),
    z.object({
      ok: z.boolean(),
      albumId: z.string().nullable(),
      reason: z.enum(['not-found', 'empty', 'conflict', 'wrong-password', 'cancelled', 'failed']).nullable(),
    }),
  ),
  protectedAlbumChangePassword: defineChannel(
    'protected-album:change-password',
    z.object({
      albumId: z.string().min(1).max(256),
      currentPassword: z.string().min(1).max(1024),
      nextPassword: z.string().min(1).max(1024),
    }),
    z.object({ changed: z.boolean() }),
  ),
  protectedAlbumPickRecovery: defineChannel('protected-album:pick-recovery', z.object({}), z.object({ path: z.string().nullable() })),
  protectedAlbumRecover: defineChannel(
    'protected-album:recover',
    z.object({
      albumId: z.string().min(1).max(256),
      path: z.string().min(1),
      recoveryPassword: z.string().min(1).max(1024),
      nextPassword: z.string().min(1).max(1024),
    }),
    z.object({ recovered: z.boolean(), reason: z.enum(['not-found', 'wrong-recovery-key', 'invalid-record']).nullable() }),
  ),
  protectedAlbumCancelWorkflow: defineChannel('protected-album:cancel-workflow', z.object({}), z.object({ cancelled: z.boolean() })),
  protectedAlbumUnlock: defineChannel(
    'protected-album:unlock',
    z.object({ albumId: z.string().min(1).max(256), password: z.string().min(1).max(1024) }),
    z.object({ ok: z.boolean(), outcome: z.enum(['opened', 'protection-completed', 'removal-completed']).nullable() }),
  ),
  protectedAlbumRelock: defineChannel(
    'protected-album:relock',
    z.object({ albumId: z.string().min(1).max(256) }),
    z.object({ relocked: z.boolean() }),
  ),
  protectedAlbumSummary: defineChannel(
    'protected-album:summary',
    z.object({ albumId: z.string().min(1).max(256) }),
    z.object({ id: z.string(), name: z.string(), count: z.number().int().nonnegative(), createdAt: z.string() }),
  ),
  protectedAlbumPage: defineChannel(
    'protected-album:page',
    z.object({
      albumId: z.string().min(1).max(256),
      limit: z.number().int().positive().max(500),
      cursor: protectedPageCursorSchema.optional(),
      query: z.string().optional(),
      source: z.enum(['all', 'favorites', 'deleted']).optional(),
    }),
    z.object({ photos: z.array(protectedPhotoRecordSchema).readonly(), nextCursor: protectedPageCursorSchema.nullable() }),
  ),
  protectedAlbumGet: defineChannel(
    'protected-album:get',
    z.object({ albumId: z.string().min(1).max(256), photoId: z.string().min(1) }),
    z.object({ photo: protectedPhotoRecordSchema }),
  ),
  protectedAlbumToggleFavorite: defineChannel(
    'protected-album:toggle-favorite',
    z.object({ albumId: z.string().min(1).max(256), photoId: z.string().min(1) }),
    z.object({ favorite: z.boolean() }),
  ),
  protectedAlbumDelete: defineChannel(
    'protected-album:delete',
    z.object({ albumId: z.string().min(1).max(256), photoIds: z.array(z.string().min(1)).min(1) }),
    z.object({ deleted: z.number().int().nonnegative() }),
  ),
  protectedAlbumRestore: defineChannel(
    'protected-album:restore',
    z.object({ albumId: z.string().min(1).max(256), photoIds: z.array(z.string().min(1)).min(1) }),
    z.object({ restored: z.number().int().nonnegative() }),
  ),
  protectedAlbumExportPickDestination: defineChannel(
    'protected-album:export-pick-destination',
    z.object({}),
    z.object({ path: z.string().nullable() }),
  ),
  protectedAlbumExportRun: defineChannel(
    'protected-album:export-run',
    z.object({
      albumId: z.string().min(1).max(256),
      photoIds: z.array(z.string().min(1)).min(1),
      destination: z.string().min(1),
      format: z.enum(['original', 'jpeg']).optional(),
    }),
    z.object({
      exported: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      cancelled: z.number().int().nonnegative(),
      previewTranscodes: z.number().int().nonnegative(),
    }),
  ),
  protectedAlbumExportCancel: defineChannel('protected-album:export-cancel', z.object({}), z.object({})),
  // Soft delete + restore (#120): safe by default — rows move to Trash and
  // come back intact. Purge (the destructive path) is #121.
  libraryDelete: defineChannel(
    'library:delete',
    z.object({ photoIds: z.array(z.string()).min(1) }),
    originalPolicy.photoDeleteResultSchema,
  ),
  libraryRestore: defineChannel(
    'library:restore',
    z.object({ photoIds: z.array(z.string()).min(1) }),
    z.object({ restored: z.number().int().nonnegative() }),
  ),
  // Permanent purge (#121): the main process requires the ADR-0023 ceremony
  // acknowledgement even from stale or directly-invoked renderers.
  libraryPurge: defineChannel(
    'library:purge',
    z.object({
      photoIds: z.array(z.string()).min(1),
      authorization: z.literal(PHOTO_PURGE_AUTHORIZATION),
    }),
    originalPolicy.purgeSummarySchema,
  ),
  // Albums CRUD (#117): first-class library objects. Deleting an album
  // never deletes photos (Clear-vs-Delete rules); membership edits dirty
  // the ledger (manifest-relevant, ADR-0007).
  ...albumChannels,
  ...boardChannels,
  ...embeddingChannels,
  // Import sources (#84): discovery + the source-card scan. Copying is #87.
  importListSources: defineChannel('import:list-sources', z.object({}), z.object({ sources: z.array(importSourceSchema).readonly() })),
  importScanSource: defineChannel('import:scan-source', z.object({ path: z.string() }), scanSummarySchema),
  // Folder source (#237): the OS directory picker behind the dialog's
  // "Choose a folder" dropzone; null = cancelled.
  importPickFolder: defineChannel('import:pick-folder', z.object({}), z.object({ path: z.string().nullable() })),
  // Dropped files (#237): scan an explicit file list (window drag-and-drop).
  importScanFiles: defineChannel('import:scan-files', z.object({ paths: z.array(z.string()).min(1) }), scanSummarySchema),
  // Google Picker (#465): only opaque selection IDs and aggregate counts
  // cross the renderer boundary; OAuth tokens, Drive IDs, and staged paths
  // remain main-process-only.
  importGoogleDrivePick: defineChannel(
    'import:google-drive-pick',
    z.object({}),
    z.union([
      z.object({
        status: z.literal('ready'),
        selectionId: z.string().uuid(),
        summary: scanSummarySchema,
        skipped: z.number().int().nonnegative(),
      }),
      z.object({ status: googleDrivePickFailureSchema }),
    ]),
  ),
  importGoogleDriveCancelPick: defineChannel('import:google-drive-cancel-pick', z.object({}), z.object({})),
  importGoogleDriveRun: defineChannel('import:google-drive-run', z.object({ selectionId: z.string().uuid() }), importRunSummarySchema),
  importGoogleDriveDiscard: defineChannel('import:google-drive-discard', z.object({ selectionId: z.string().uuid() }), z.object({})),
  // Renderer readiness handshake for queued OS/Finder open-file batches.
  // Content admission keeps queued paths sealed behind app lock.
  importExternalReady: defineChannel('import:external-ready', z.object({}), z.object({})),
  // Import engine (#87, extended by #237/#489): main-approved source paths
  // may Move through verify-before-delete; renderer-supplied drops copy only.
  importRun: defineChannel(
    'import:run',
    z
      .object({
        path: z.string().optional(),
        files: z.array(z.string()).min(1).optional(),
        mode: z.enum(['copy', 'move']),
      })
      .refine((run) => (run.path === undefined) !== (run.files === undefined), {
        message: 'exactly one of path or files',
      })
      .refine((run) => run.files === undefined || run.mode === 'copy', {
        message: 'dropped files are copy-only',
      }),
    importRunSummarySchema,
  ),
  // Cancel semantics (#88): finish the file in flight, keep completed.
  importCancel: defineChannel('import:cancel', z.object({}), z.object({})),
  // Recovery key (#240, ADR-0008): fingerprint + password-encrypted
  // backup/import of the library master key.
  keysStatus: defineChannel('keys:status', z.object({}), z.object({ fingerprint: z.string() })),
  keysExport: defineChannel(
    'keys:export',
    // Main-side floor (security review P3-1): the dialog's strength gate is
    // renderer-side courtesy; the store never seals under a trivial secret.
    z.object({ password: z.string().min(8).max(1024) }),
    // null path = the user cancelled the save dialog.
    z.object({ path: z.string().nullable() }),
  ),
  keysPickFile: defineChannel('keys:pick-file', z.object({}), z.object({ path: z.string().nullable() })),
  keysImport: defineChannel(
    'keys:import',
    z.object({ path: z.string(), password: z.string().min(1).max(1024) }),
    z.object({
      installed: z.boolean(),
      fingerprint: z.string().nullable(),
      reason: z.enum(['invalid', 'wrong-password', 'mismatch', 'no-library']).nullable(),
    }),
  ),
  // Disaster recovery (#290): recovery material stays in main behind an
  // opaque discovery session; renderer receives metadata and typed errors.
  restoreProfileStatus: defineChannel('restore:profile-status', z.object({}), z.object({ fresh: z.boolean() })),
  restorePickKey: defineChannel('restore:pick-key', z.object({}), z.object({ path: z.string().nullable() })),
  restoreDiscover: defineChannel(
    'restore:discover',
    // Either the separately saved recovery key, or this machine's own open
    // keystore (localKey) — a resident master key restores the backups it
    // sealed without demanding the exported file (#741 follow-up).
    z.union([
      z.object({ providerId: providerIdSchema, keyPath: z.string().min(1), password: z.string().min(1).max(1024) }),
      // password (#754): fresh app-password authority for the resident key.
      // Optional in the schema because unconfigured locks have no password;
      // the main process refuses local-key discovery without it whenever a
      // lock is configured.
      z.object({ providerId: providerIdSchema, localKey: z.literal(true), password: z.string().min(1).max(1024).optional() }),
    ]),
    restoreDiscoverResponseSchema,
  ),
  restoreRun: defineChannel(
    'restore:run',
    z.object({ sessionId: z.string().min(1), libraryId: z.string().min(1), allowReplace: z.boolean() }),
    restoreRunResponseSchema,
  ),
  restoreCancel: defineChannel('restore:cancel', z.object({}), z.object({})),
  // Export engine (#97): decrypt-on-export to a chosen folder.
  exportPickDestination: defineChannel('export:pick-destination', z.object({}), z.object({ path: z.string().nullable() })),
  exportRun: defineChannel(
    'export:run',
    z.object({ photoIds: z.array(z.string()).min(1), destination: z.string(), format: z.enum(['original', 'jpeg']).optional() }),
    z.object({
      exported: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      cancelled: z.number().int().nonnegative(),
      previewTranscodes: z.number().int().nonnegative(),
    }),
  ),
  exportCancel: defineChannel('export:cancel', z.object({}), z.object({})),
  // Backup engine (#105): the toolbar's manual trigger. 'disconnected'
  // (#114): providerId null blocks manual runs too, not just auto-backup.
  backupRun: defineChannel(
    'backup:run',
    z.object({}),
    z.object({
      uploaded: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      skipped: z.enum(['wifi', 'disconnected']).nullable(),
      integrity: backupIntegritySchema,
    }),
  ),
  // Offload / verified restore (#107, user workflow #281).
  backupOffloadPreflight: defineChannel(
    'backup:offload-preflight',
    z.object({ photoIds: z.array(z.string()).min(1) }),
    offloadPreflightSchema,
  ),
  backupOffload: defineChannel(
    'backup:offload',
    z.object({ photoIds: z.array(z.string()).min(1) }),
    z.object({
      offloaded: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      freedBytes: z.number().nonnegative(),
      results: z
        .array(
          z.object({
            photoId: z.string(),
            outcome: z.enum(['offloaded', 'skipped', 'failed']),
            reason: z.union([offloadSkipReasonSchema, z.literal('delete-failed')]).nullable(),
          }),
        )
        .readonly(),
    }),
  ),
  backupRehydrate: defineChannel('backup:rehydrate', z.object({ photoId: z.string() }), z.object({ ok: z.boolean() })),
  backupKeepDownloaded: defineChannel('backup:keep-downloaded', z.object({ photoId: z.string() }), z.object({ ok: z.boolean() })),
  backupReleaseEphemeral: defineChannel('backup:release-ephemeral', z.object({ photoId: z.string() }), z.object({ ok: z.boolean() })),
  backupEphemeralStatus: defineChannel(
    'backup:ephemeral-status',
    z.object({ photoId: z.string() }),
    z.object({ stage: z.enum(['fetching', 'verifying', 'ready', 'released', 'error']).nullable() }),
  ),
  backupPrepareEphemeral: defineChannel(
    'backup:prepare-ephemeral',
    z.object({ photoId: z.string() }),
    z.object({ custody: z.enum(['durable', 'ephemeral']) }),
  ),
  backupRestoreOriginals: defineChannel(
    'backup:restore-originals',
    z.object({ photoIds: z.array(z.string()).min(1).optional() }),
    z.object({
      restored: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      results: z
        .array(
          z.object({
            photoId: z.string(),
            outcome: z.enum(['restored', 'skipped', 'failed']),
            reason: restoreOriginalFailureReasonSchema.nullable(),
          }),
        )
        .readonly(),
    }),
  ),
  backupProviders: defineChannel(
    'backup:providers',
    z.object({}),
    z.object({ providers: z.array(providerDescriptorSchema).readonly(), defaultProviderId: providerIdSchema }),
  ),
  // Connection authority is prompt and independent from provider capacity
  // (#721). A completed OAuth flow must never wait on inventory or quota.
  backupProviderStatus: defineChannel('backup:provider-status', z.object({ providerId: providerIdSchema }), providerConnectionStatusSchema),
  backupProviderStorage: defineChannel('backup:provider-storage', z.object({ providerId: providerIdSchema }), providerCapacityStatusSchema),
  // Provider connect/disconnect (#254): connect runs whatever handshake the
  // registered provider needs — local providers connect instantly while
  // interactive providers open a system-browser OAuth flow. Tokens never cross
  // this boundary; the renderer only learns ok/reason.
  backupConnect: defineChannel(
    'backup:connect',
    z.object({ providerId: providerIdSchema }),
    z.object({ ok: z.boolean(), reason: z.string().nullable() }),
  ),
  backupDisconnect: defineChannel(
    'backup:disconnect',
    z.object({ providerId: providerIdSchema }),
    z.object({ ok: z.boolean(), reason: z.string().nullable() }),
  ),
  // Capacity route (#684): when a provider has no in-app account-capacity figure
  // (iCloud), the card routes the user to the OS surface that owns it. Main opens
  // a fixed System Settings URL — no renderer-supplied URL crosses the boundary.
  backupOpenCapacitySettings: defineChannel(
    'backup:open-capacity-settings',
    z.object({ providerId: providerIdSchema }),
    z.object({ ok: z.boolean() }),
  ),
  ...llmChannels,
  // Settings store (#111): typed get + validated partial patch. The locked
  // key (thumbnailsOnImport) is a literal, so a patch flipping it rejects
  // at this boundary.
  settingsGet: defineChannel('settings:get', z.object({}), z.object({ settings: settingsSchema })),
  settingsSet: defineChannel('settings:set', z.object({ patch: settingsPatchSchema }), z.object({ settings: settingsSchema })),
  ...diagnosticsChannels,
  libraryStats: defineChannel(
    'library:stats',
    z.object({}),
    z.object({
      photos: z.number(),
      bytes: z.number(),
      pending: z.number().int().nonnegative(),
      lastBackupAt: z.string().nullable(),
      offloadedBytes: z.number().nonnegative(),
    }),
  ),
  // Multi-library registry (#384, ADR-0017 §1/§2): list/create/select/remove
  // registry entries and read the active library. open selects what the next
  // bootstrap opens — the live in-process switch is #385.
  libraryRegistryList: defineChannel('library-registry:list', z.object({}), z.object({ libraries: z.array(libraryDescriptorSchema) })),
  libraryRegistryCreate: defineChannel(
    'library-registry:create',
    z.object({ name: z.string().min(1).max(120), path: z.string().min(1).nullable() }),
    z.object({ library: libraryDescriptorSchema }),
  ),
  // open = the live switch (#385/#386). Designed refusals (locked, backup
  // running, target locked elsewhere/missing) are RESPONSE outcomes, not
  // thrown errors — IPC failures cross the bridge as detail-free codes, and
  // the switcher needs the reason (and host) to render a recoverable state.
  libraryRegistryOpen: defineChannel(
    'library-registry:open',
    z.object({ id: libraryIdSchema }),
    z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), library: libraryDescriptorSchema, requiresRestart: z.boolean() }),
      z.object({
        ok: z.literal(false),
        reason: z.enum(['switch-in-progress', 'locked', 'provider-busy', 'locked-elsewhere', 'missing']),
        /** Hostname holding the target's lock — 'locked-elsewhere' only. */
        host: z.string().nullable(),
      }),
    ]),
  ),
  libraryRegistryRemove: defineChannel('library-registry:remove', z.object({ id: libraryIdSchema }), z.object({ removed: z.boolean() })),
  libraryRegistryCurrent: defineChannel('library-registry:current', z.object({}), z.object({ library: libraryDescriptorSchema })),
  // Register an EXISTING library directory (#386). path null = main opens the
  // native directory picker; cancellation is an outcome, not an error.
  libraryRegistryAdd: defineChannel(
    'library-registry:add',
    z.object({ path: z.string().min(1).nullable() }),
    z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), library: libraryDescriptorSchema }),
      z.object({ ok: z.literal(false), reason: z.enum(['cancelled', 'not-a-library', 'already-registered']) }),
    ]),
  ),
  /** Native directory picker for the create flow's location (#386). */
  libraryRegistryPickLocation: defineChannel('library-registry:pick-location', z.object({}), z.object({ path: z.string().nullable() })),
  // Library relocation (#483, ADR-0022 §1): journaled move with an atomic
  // registry path rewrite as the commit point. Designed refusals (the §5
  // preflight matrix, verification failure, cancellation) are RESPONSE
  // outcomes like the switch — the wizard renders reason + detail, and
  // moved-cleanup-pending is a success variant reporting both paths.
  libraryRelocationMove: defineChannel(
    'library-relocation:move',
    z.object({ id: libraryIdSchema, destPath: z.string().min(1) }),
    relocationMoveResponseSchema,
  ),
  /** Cancel the in-flight move for a library — honored at file boundaries,
   * only ever before the registry commit (ADR-0022 §4). */
  libraryRelocationCancel: defineChannel(
    'library-relocation:cancel',
    z.object({ id: libraryIdSchema }),
    z.object({ cancelled: z.boolean() }),
  ),
  /** Explicitly resumes a marker-bound pre-commit copy journal. */
  libraryRelocationResume: defineChannel('library-relocation:resume', z.object({ id: libraryIdSchema }), relocationMoveResponseSchema),
  /** Discards only staging bound to the live pre-commit journal. */
  libraryRelocationDiscard: defineChannel(
    'library-relocation:discard',
    z.object({ id: libraryIdSchema }),
    z.object({ result: z.enum(['discarded', 'nothing-pending']) }),
  ),
  /** Dry-run preflight for the wizard's Review step (#483): resolves the
   * method chip (rename vs copy), space meter, and the ADR-0017 §5 network
   * warning — no lock, no journal, no bytes moved. */
  libraryRelocationPreflight: defineChannel(
    'library-relocation:preflight',
    z.object({ id: libraryIdSchema, destPath: z.string().min(1) }),
    z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        mode: relocationModeSchema,
        requiredBytes: z.number().nonnegative(),
        items: z.number().int().nonnegative(),
        freeBytes: z.number().nonnegative(),
        network: z.boolean(),
        lockedBy: z.string().nullable(),
      }),
      z.object({ ok: z.literal(false), reason: relocationFailureReasonSchema, detail: z.string() }),
    ]),
  ),
  /** Retry source removal after moved-cleanup-pending (#483 acceptance 10). */
  libraryRelocationFinishCleanup: defineChannel(
    'library-relocation:finish-cleanup',
    z.object({ id: libraryIdSchema }),
    z.object({ result: z.enum(['cleaned', 'nothing-pending']) }),
  ),
  /** Journals on disk — the resume banner's work list (states are ADR-0022
   * §2; pre-commit entries offer resume/discard, committed entries offer
   * finish-cleanup). */
  libraryRelocationPending: defineChannel(
    'library-relocation:pending',
    z.object({}),
    z.object({
      pending: z.array(
        z.object({
          libraryId: libraryIdSchema,
          /** Null only for a corrupt journal — surfaced, never guessed at. */
          state: relocationStateSchema.nullable(),
          sourcePath: z.string().nullable(),
          destPath: z.string().nullable(),
          corrupt: z.boolean(),
          resumable: z.boolean(),
        }),
      ),
    }),
  ),
} as const;

export const events = {
  ...windowEvents,
  commandInvoked: defineEvent('commands:invoked', z.object({ id: commandIdSchema })),
  appLockStateChanged: defineEvent('app-lock:state-changed', appLockStatusSchema),
  appLockTouchIdChanged: defineEvent('app-lock:touch-id-changed', touchIdStatusSchema),
  ...interopEvents,
  ...boardEvents,
  ...embeddingEvents,
  // Targeted library pushes (#71) — never refetch-the-world signals.
  // `derivativeOnly` marks a change that only regenerated a thumb/poster
  // derivative (a captured video poster, a repaired preview) with no membership
  // or metadata change — the renderer refreshes just those tiles' images and
  // must NOT refetch/replace the page (which would reset scroll and drop the
  // lightbox/selection for items beyond page 1). #744 review.
  libraryChanged: defineEvent('library:changed', z.object({ photoIds: z.array(z.string()), derivativeOnly: z.boolean().optional() })),
  ...originalPolicy.originalPolicyEvents,
  photoSyncStateChanged: defineEvent(
    'library:sync-state-changed',
    z.object({ updates: z.array(z.object({ id: z.string(), syncState: syncStatusSchema })) }),
  ),
  storageChanged: defineEvent('library:storage-changed', z.object({})),
  ephemeralOriginalState: defineEvent(
    'backup:ephemeral-original-state',
    z.object({ photoId: z.string(), stage: z.enum(['fetching', 'verifying', 'ready', 'released', 'error']) }),
  ),
  pendingCountChanged: defineEvent('library:pending-count', z.object({ count: z.number().int().nonnegative() })),
  // Progressive scan counts for big cards (#84).
  scanProgress: defineEvent(
    'import:scan-progress',
    scanSummarySchema.extend({ path: z.string(), scanned: z.number().int().nonnegative(), done: z.boolean() }),
  ),
  // The import dialog's two aggregate bars (#87): copy+encrypt+record, then
  // thumbnails — both n/total over the batch.
  importCopyProgress: defineEvent(
    'import:copy-progress',
    z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  ),
  importThumbProgress: defineEvent(
    'import:thumb-progress',
    z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  ),
  importExternalPaths: defineEvent('import:external-paths', z.object({ paths: z.array(z.string()).min(1).max(100_000).readonly() })),
  // Export progress (#97): n/total over the batch.
  exportProgress: defineEvent('export:progress', z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() })),
  // Relocation item/byte progress per library (#483): drives the wizard's
  // staged tracks; phases mirror ADR-0022 §4 order.
  relocationProgress: defineEvent(
    'library-relocation:progress',
    z.object({
      libraryId: libraryIdSchema,
      phase: z.enum(['preflight', 'copying', 'verifying', 'committing', 'cleaning']),
      copiedItems: z.number().int().nonnegative(),
      totalItems: z.number().int().nonnegative(),
      copiedBytes: z.number().nonnegative(),
      totalBytes: z.number().nonnegative(),
    }),
  ),
  // Backup completion (#106): drives the red toast + retry on failures.
  // `auto` keeps automatic successes quiet (#116) — an auto-backup's green
  // toast must never replace the import-complete toast; failures stay loud.
  backupCompleted: defineEvent(
    'backup:completed',
    z.object({
      uploaded: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      manifestUploaded: z.boolean(),
      auto: z.boolean(),
      integrity: backupIntegritySchema,
    }),
  ),
  // Settings changes (#111) push the full snapshot — consumers (dialog,
  // sidebar, backup engine surface) re-render from one truth.
  settingsChanged: defineEvent('settings:changed', z.object({ settings: settingsSchema })),
  ...llmEvents,
  // Backup progress (#105): per-item + aggregate for the sidebar card.
  backupProgress: defineEvent(
    'backup:progress',
    z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative(), photoId: z.string().nullable() }),
  ),
  restoreProgress: defineEvent('restore:progress', restoreProgressSchema),
  protectedAlbumsChanged: defineEvent('protected-album:changed', z.object({})),
  protectedWorkflowProgress: defineEvent(
    'protected-album:workflow-progress',
    z.object({
      operation: z.enum(['protect', 'unprotect']),
      stage: z.enum(['preparing', 'copying', 'verifying', 'committing', 'purging', 'complete']),
      done: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
  ),
} as const;

export type PingRequest = z.output<typeof channels.ping.request>;
export type PingResponse = z.output<typeof channels.ping.response>;
export type FocusChangedPayload = z.output<typeof events.focusChanged.payload>;
