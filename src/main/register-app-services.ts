import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { app, dialog } from 'electron';
import type { BrowserWindow } from 'electron';

import { events } from '../shared/ipc/channels.js';
import { createEmitter } from '../shared/ipc/registry.js';
import { createBackupFacade, type BackupFacadeOptions } from './backup/backup-facade.js';
import type { FullService } from './fullres/full-service.js';
import { registerFullProtocol } from './fullres/full-protocol.js';
import type { ImportService } from './import/import-service.js';
import { ulid } from './import/ulid.js';
import type { KeyStore } from './crypto/keystore.js';
import { createRecoveryKeyFacade } from './crypto/recovery-key-facade.js';
import { pickRecoveryKeyPath } from './crypto/recovery-key-picker.js';
import type { DrainableExportFacade } from './export/export-runtime.js';
import { ExportDestinationAuthority } from './export/export-destination-authority.js';
import type { ActivityFacade } from './activity/activity-publication.js';
import type { HistoryService } from './history/history-service.js';
import {
  registerAlbumHandlers,
  registerBoardHandlers,
  registerBackupHandlers,
  registerDiagnosticsHandlers,
  registerExportHandlers,
  registerImportHandlers,
  registerKeysHandlers,
  registerLibraryHandlers,
  registerLibraryRegistryHandlers,
  type LibraryRegistryFacade,
  registerProtectedAlbumHandlers,
  registerPurgeHandlers,
  registerRestoreHandlers,
  registerSettingsHandlers,
} from './ipc.js';
import { registerOriginalPolicyHandlers } from './library/original-deletion-ipc.js';
import { registerLlmHandlers } from './llm/llm-ipc.js';
import { getLlmFacade } from './llm/llm-runtime.js';
import { registerActivityHandlers } from './activity/activity-ipc.js';
import { registerHistoryHandlers } from './history/history-ipc.js';
import type { LibraryService } from './library/library-service.js';
import type { DrainablePurgeFacade } from './library/purge-runtime.js';
import type { ProtectedRuntime } from './library/protected-runtime.js';
import { createRestoreFacade } from './backup/restore-facade.js';
import type { RestoreRuntime } from './backup/restore-runtime.js';
import { getSettingsStore } from './settings/settings-runtime.js';
import { registerThumbProtocol } from './thumbs/thumb-protocol.js';
import type { ThumbService } from './thumbs/thumb-service.js';
import { getDiagnosticsService } from './diagnostics/diagnostics-runtime.js';
import { OriginalDeletionService } from './library/original-deletion-service.js';
import type { AppLockState, AppAuthorizationResult } from './crypto/app-lock-controller.js';
import { registerInboundMoveHandlers } from './interop/inbound-move-ipc.js';
import { getProductionInboundMoveController } from './interop/inbound-move-production.js';
import { registerEmbeddingHandlers } from './embedding/embedding-ipc.js';
import type { EmbeddingService } from './embedding/embedding-service.js';
import type { NativeDragOutService } from './native-drag/native-drag-service.js';
import { registerNativeDragHandlers } from './native-drag/native-drag-ipc.js';
import type { PhotoKitService } from './photo-kit/photo-kit-service.js';
import { registerPhotoKitHandlers } from './photo-kit/photo-kit-ipc.js';
import type { FileProviderService } from './file-provider/file-provider-service.js';
import { registerFileProviderHandlers } from './file-provider/file-provider-ipc.js';

export interface AppServicesOptions {
  readonly dataDir: () => string;
  readonly harnessEnv: (name: string) => string | undefined;
  readonly requireContentAccess: () => void;
  readonly allowKeyImport: () => boolean;
  readonly onRecoveryKeyExported?: (() => void) | undefined;
  readonly getLibrary: () => LibraryService;
  readonly getActivity: () => ActivityFacade;
  readonly getHistory: () => HistoryService;
  readonly libraries: LibraryRegistryFacade;
  readonly getProtected: () => ProtectedRuntime;
  readonly getThumbs: () => ThumbService;
  readonly getFull: () => FullService;
  readonly getImport: () => ImportService;
  readonly getEmbedding: () => EmbeddingService;
  readonly getExport: () => DrainableExportFacade;
  readonly getNativeDrag: () => NativeDragOutService;
  readonly getPhotoKit: () => PhotoKitService;
  readonly getFileProvider: () => FileProviderService;
  readonly getKeyStore: () => KeyStore;
  readonly safeStorage: Parameters<typeof createRecoveryKeyFacade>[0]['safeStorage'];
  readonly getRestore: () => RestoreRuntime;
  readonly getPurge: () => DrainablePurgeFacade;
  readonly activeLibraryId: () => string;
  readonly authorizationEpoch: () => number;
  readonly lockState: () => AppLockState;
  readonly authorizePassword: (password: string) => Promise<AppAuthorizationResult>;
  readonly backup: BackupFacadeOptions;
  readonly providerBusy: () => boolean;
  readonly pcloudEnabled: boolean;
  readonly onManifestChanged: () => void;
  readonly onImported: () => void;
  readonly onImportRendererReady: () => void;
  readonly broadcast: (name: string, payload: unknown) => void;
}

async function pickImportFolder(options: AppServicesOptions): Promise<string | null> {
  const fixture = options.harnessEnv('OVERLOOK_IMPORT_FOLDER');
  if (fixture !== undefined && fixture !== '') return fixture;
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

async function confirmImportMove(
  options: AppServicesOptions,
  source: { path?: string | undefined; files?: readonly string[] | undefined },
  parent: BrowserWindow | null,
): Promise<boolean> {
  // Browser tests cannot operate native dialogs; this switch is fixed by the
  // main-process test harness environment and is unavailable to the renderer.
  if (!app.isPackaged && options.harnessEnv('OVERLOOK_E2E') !== undefined) return true;
  if (parent === null) return false;
  const lineBreak = String.fromCharCode(10);
  const sourceDescription = source.path ?? source.files?.join(lineBreak) ?? '';
  const result = await dialog.showMessageBox(parent, {
    type: 'warning',
    buttons: ['Cancel', 'Move originals'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Confirm moving originals',
    message: 'Move these originals into Overlook?',
    detail: [
      'Requested source paths:',
      sourceDescription,
      '',
      'The originals will be deleted only after their encrypted copies are verified.',
    ].join(lineBreak),
  });
  return result.response === 1;
}

async function pickKeyExport(options: AppServicesOptions): Promise<string | null> {
  const fixture = options.harnessEnv('OVERLOOK_KEY_EXPORT_DESTINATION');
  if (fixture !== undefined && fixture !== '') return fixture;
  const result = await dialog.showSaveDialog({ defaultPath: 'overlook-recovery.key' });
  return result.canceled ? null : (result.filePath ?? null);
}

async function pickDiagnosticsExport(options: AppServicesOptions): Promise<string | null> {
  const fixture = options.harnessEnv('OVERLOOK_DIAGNOSTICS_EXPORT_DESTINATION');
  if (fixture !== undefined && fixture !== '') return fixture;
  const result = await dialog.showSaveDialog({ defaultPath: 'overlook-diagnostics.jsonl' });
  return result.canceled ? null : (result.filePath ?? null);
}

export function registerAppServices(options: AppServicesOptions): void {
  const exportDestinationAuthority = new ExportDestinationAuthority();
  const originalDeletion = new OriginalDeletionService({
    getPhoto: (photoId) => options.getLibrary().get(photoId),
    activeLibraryId: options.activeLibraryId,
    authorizationEpoch: options.authorizationEpoch,
    lockState: options.lockState,
    authorizePassword: options.authorizePassword,
    deletePermanently: (photoIds) => options.getPurge().deletePermanently(photoIds),
  });
  registerLibraryHandlers(options.getLibrary, options.onManifestChanged, options.getActivity);
  registerAlbumHandlers(options.getLibrary, ulid, options.getActivity, options.onManifestChanged);
  registerBoardHandlers(options.getLibrary, options.getActivity, options.onManifestChanged);
  registerActivityHandlers(options.getActivity, options.requireContentAccess);
  registerHistoryHandlers(options.getHistory, options.requireContentAccess);
  registerProtectedAlbumHandlers(
    () => options.getProtected().library,
    () => options.getProtected().exports(),
    () => options.getProtected().workflow,
    () => pickRecoveryKeyPath(options.harnessEnv('OVERLOOK_KEY_IMPORT_SOURCE')),
    readFile,
    exportDestinationAuthority,
  );
  registerThumbProtocol(options.getThumbs, options.requireContentAccess, () => options.getProtected().media());
  registerFullProtocol(options.getFull, options.requireContentAccess, () => options.getProtected().media());
  registerImportHandlers(
    options.getImport,
    () => pickImportFolder(options),
    options.onImported,
    options.onImportRendererReady,
    options.getActivity,
    (source, parent) => confirmImportMove(options, source, parent),
  );
  registerEmbeddingHandlers(options.getEmbedding, options.requireContentAccess);
  registerExportHandlers(options.getExport, options.getActivity, exportDestinationAuthority);
  registerNativeDragHandlers(options.getNativeDrag, options.requireContentAccess);
  registerPhotoKitHandlers(options.getPhotoKit, options.requireContentAccess, options.onImported, options.getActivity);
  registerFileProviderHandlers(options.getFileProvider, options.requireContentAccess);
  registerKeysHandlers(() =>
    createRecoveryKeyFacade({
      keyStore: options.getKeyStore,
      safeStorage: options.safeStorage,
      dataDir: options.dataDir,
      allowImport: options.allowKeyImport,
      pickExportDestination: () => pickKeyExport(options),
      pickImportSource: () => pickRecoveryKeyPath(options.harnessEnv('OVERLOOK_KEY_IMPORT_SOURCE')),
      onExported: options.onRecoveryKeyExported,
    }),
  );
  registerRestoreHandlers(() =>
    createRestoreFacade({
      coordinator: () => options.getRestore().coordinator,
      fresh: () => !existsSync(path.join(options.dataDir(), 'library.db')),
      pickKey: () => pickRecoveryKeyPath(options.harnessEnv('OVERLOOK_KEY_IMPORT_SOURCE')),
      busy: options.providerBusy,
      lockState: options.lockState,
      authorizePassword: options.authorizePassword,
      recordDiagnostic: (occurrence) => getDiagnosticsService().record(occurrence),
    }),
  );
  registerPurgeHandlers(() => ({ purge: (photoIds) => options.getPurge().purge(photoIds) }), options.getActivity);
  registerOriginalPolicyHandlers(options.getLibrary, () => originalDeletion);
  registerLibraryRegistryHandlers(() => options.libraries);
  registerSettingsHandlers(() => getSettingsStore());
  registerLlmHandlers(getLlmFacade);
  registerDiagnosticsHandlers(getDiagnosticsService, () => pickDiagnosticsExport(options));
  const emitSettingsChanged = createEmitter(events.settingsChanged, options.broadcast);
  getSettingsStore().subscribe((settings) => emitSettingsChanged({ settings }));
  registerBackupHandlers(() => createBackupFacade(options.backup));
  if (options.pcloudEnabled) {
    registerInboundMoveHandlers(getProductionInboundMoveController, options.requireContentAccess);
  }
}
