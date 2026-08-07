import path from 'node:path';
import { buffer } from 'node:stream/consumers';
import { app, dialog, session } from 'electron';

import { events } from '../shared/ipc/channels.js';
import { activityBackupSnapshot, createActivityFacade } from './activity/activity-publication.js';
import { createHistoryService } from './history/history-runtime.js';
import { createEmitter } from '../shared/ipc/registry.js';
import { configureAppProfile } from './app-profile.js';
import { BlobStore, BlobStoreError } from './blobs/blob-store.js';
import { broadcast, registerWindowAllClosedQuit, reloadContentWindowsForLock, relaunchLocked } from './app-window.js';
import { KeyStore } from './crypto/keystore.js';
import { createAppLockRuntime, registerAppLockIpc } from './crypto/app-lock-runtime.js';
import { drainWithCancellationFence } from './crypto/library-shutdown.js';
import { TestFileCredentialAnchorStore } from './crypto/test-credential-anchor.js';
import { pickSafeStorage } from './crypto/safe-storage-runtime.js';
import { openLibraryDatabase } from './db/database.js';
import { PhotosRepository, verifySearchIndexAsync } from './db/photos-repository.js';
import { boardsSnapshot } from './db/board-repository.js';
import { run } from './db/sql.js';
import type { FullService } from './fullres/full-service.js';
import { createFullRuntime } from './fullres/full-runtime.js';
import { createExternalOpenRuntime, createHeadlessExternalOpenRuntime } from './import/external-open-runtime.js';
import type { ImportRuntime, ImportService } from './import/import-runtime.js';
import { createImportApplicationRuntime } from './import/import-application-runtime.js';
import type { RawRepairService } from './import/raw-repair-service.js';
import type { PosterCaptureService } from './import/poster-capture-service.js';
import { buildMaintenanceServices } from './import/maintenance-runtime.js';
import { ulid } from './import/ulid.js';
import { createAutoBackupScheduler } from './backup/auto-backup.js';
import { BackupEngine, sidecarBackupDeps, type BackupRunResult } from './backup/backup-engine.js';
import { createBackupAuditLogger } from './backup/backup-audit.js';
import { createBackupIntegrityRuntime } from './backup/integrity-runtime.js';
import { sealManifestJson } from './backup/manifest-sealer.js';
import { createRecoveryHealthCheck } from './backup/recovery-health.js';
import type { OffloadService } from './backup/offload.js';
import type { EphemeralOriginalService } from './backup/ephemeral-originals.js';
import { createOriginalCustodyRuntime } from './backup/original-custody-runtime.js';
import { createCustodyRoutingRuntime, refreshCustodyHints } from './backup/custody-routing-runtime.js';
import type { ProviderRuntime } from './backup/provider-runtime.js';
import { createProviderRuntime } from './backup/provider-runtime-factory.js';
import type { RestoreRuntime } from './backup/restore-runtime.js';
import { createRestoreRuntime } from './backup/restore-runtime-factory.js';
import { recoverInterruptedActivation, restorePaths } from './backup/restore-staging.js';
import { sealKeyStoreRecoveryBootstrap } from './backup/recovery-bootstrap.js';
import type { ConsistencyChecker } from './library/consistency.js';
import { createConsistencyChecker } from './library/consistency-factory.js';
import type { PurgeService } from './library/purge-service.js';
import { createPurgeService } from './library/purge-factory.js';
import { createPurgeRuntime, type DrainablePurgeFacade } from './library/purge-runtime.js';
import { StartupMaintenance } from './library/startup-maintenance.js';
import { SyncLedger } from './backup/sync-ledger.js';
import { createBackupClaimDeps } from './db/backup-claims.js';
import type { DrainableExportFacade } from './export/export-runtime.js';
import { createExportFacade } from './export/export-facade-factory.js';
import { pickRecoveryKeyPath } from './crypto/recovery-key-picker.js';
import { pickExportDestination } from './export/export-destination.js';
import { registerIpcHandlers, registerRelocationHandlers } from './ipc.js';
import { activateSettingsLibrary, configureSettingsLibrary, getSettingsStore } from './settings/settings-runtime.js';
import { throttlePercentOf } from '../shared/settings/settings.js';
import { LibraryService } from './library/library-service.js';
import { LibraryRegistryRuntime } from './library/library-registry-runtime.js';
import { acquireLibraryLock, readLockHolder } from './library/library-lock.js';
import { createLibraryLifecycle } from './library/library-lifecycle-wiring.js';
import { pickLibraryDirectory } from './library/library-picker.js';
import { AppLockHost } from './crypto/app-lock-host.js';
import { registerQuitTeardown, registerSingleInstance } from './app-bootstrap.js';
import { ProtectedRuntime } from './library/protected-runtime.js';
import { registerAppServices } from './register-app-services.js';
import { devSeedAccess, runDevSeeds } from './library/dev-seed.js';
import { ThumbService } from './thumbs/thumb-service.js';
import { exitForReleaseSmokeIfRequested } from './release-smoke.js';
import { registerEarlyRuntime } from './early-runtime.js';
import { installApplicationMenu, refreshApplicationMenu } from './application-menu.js';
import { interopRuntimeBusy, lockInteropRuntime } from './interop/runtime.js';
import { closeProductionInboundMoveLibrary } from './interop/inbound-move-production.js';
import { createProductionInteropAppRuntime } from './interop/production-app-runtime.js';
import { WorkTracker } from './work-tracker.js';
import type { LibraryParts } from './library/library-parts.js';
import type { EmbeddingRuntime } from './embedding/embedding-runtime.js';
import { createEmbeddingApplicationRuntime } from './embedding/embedding-application-runtime.js';
import type { EmbeddingService } from './embedding/embedding-service.js';

// Test/dev steering hooks (#72/#129) are unpackaged-only; runtime tuning stays outside this gate.
const harnessEnv = (name: string): string | undefined => (app.isPackaged ? undefined : process.env[name]);

// Configure the stable profile identity before the first userData lookup.
const userDataOverride = configureAppProfile(app, process.env['OVERLOOK_USER_DATA']);

const productionInterop = createProductionInteropAppRuntime({
  harnessEnv,
  library: () => requireParts('inbound Move'),
  imports: () => getImportService() && importRuntime,
  imported: () => scheduleAutoBackup(),
});
const externalOpen = productionInterop.nativeHostRequested
  ? createHeadlessExternalOpenRuntime()
  : createExternalOpenRuntime({ isolatedHarnessProfile: userDataOverride !== undefined && userDataOverride !== '' });

if (!productionInterop.nativeHostRequested) {
  registerSingleInstance();
  registerEarlyRuntime();
}

// Lazy bootstrap: no keychain or database access before the renderer's first library call.
let libraryService: LibraryService | undefined;

const registryRuntime = new LibraryRegistryRuntime({
  userDataDir: () => app.getPath('userData'),
  lockHolder: (dir) => readLockHolder(dir, instanceId),
});
const libraryDataDir = (): string => registryRuntime.dataDir();
configureSettingsLibrary(libraryDataDir);

// Per-library advisory lock (ADR-0017 §5, #385): acquired at open, released last in teardown.
const instanceId = ulid();
let releaseLibraryLock: (() => void) | undefined;

const emitExportProgress = createEmitter(events.exportProgress, (name, payload) => broadcast((win) => win.webContents.send(name, payload)));
const emitLibraryChanged = createEmitter(events.libraryChanged, (name, payload) => broadcast((win) => win.webContents.send(name, payload)));
const emitBoardsReload = createEmitter(events.boardsReload, (name, payload) => broadcast((win) => win.webContents.send(name, payload)));

let libraryParts: LibraryParts | undefined, releasedMaster: Buffer | undefined;

function getLibraryService(): LibraryService {
  if (libraryService === undefined) {
    const dataDir = registryRuntime.healActiveId().path;
    activateSettingsLibrary();
    releaseLibraryLock ??= acquireLibraryLock(dataDir, instanceId);
    const keyStore =
      releasedMaster === undefined
        ? KeyStore.open({ safeStorage: pickSafeStorage(), dataDir })
        : KeyStore.openWithMaster({ safeStorage: pickSafeStorage(), dataDir }, releasedMaster);
    // The DB key is KEY #1: stable across rotation (rotation only moves the
    // blob WRITE key), wrapped by the master key per ADR-0004. A dedicated
    // db-key slot can arrive later via migration if ever needed.
    const dbKey = keyStore.resolver()(1);
    if (dbKey === undefined) {
      throw new Error('library key #1 is missing; cannot key the database');
    }
    const db = openLibraryDatabase({ path: path.join(dataDir, 'library.db'), dbKey });
    registryRuntime.markOpened();
    refreshCustodyHints(db, registryRuntime);
    const store = new BlobStore({ dataDir });
    const blobStoreReady = store.init();
    // photos.key_id references keys(id): the current key's row must exist
    // before the FIRST real import on a fresh profile (#90 caught this —
    // previously only the dev seed wrote it). The wrapped key itself lives
    // in the keystore; this row is FK metadata.
    run(
      db,
      `INSERT OR IGNORE INTO keys (id, wrapped_key, created_at) VALUES (?, 'keystore-managed', ?)`,
      keyStore.currentKey().id,
      new Date().toISOString(),
    );
    const libraryId = getProviderRuntime().libraryId();
    const protectedRuntime = new ProtectedRuntime({
      dataDir,
      db,
      libraryId,
      ordinaryBlobs: store,
      masterKey: () => keyStore.masterKeyBytes(),
      resolveLibraryKey: () => keyStore.resolver(),
      currentLibraryKey: () => keyStore.currentKey(),
      oweManifest: () => {
        getBackupEngine();
        manifestSyncTrigger?.();
      },
      revokeOrdinary: (photoIds) => {
        for (const photoId of photoIds) {
          thumbService?.invalidate(photoId);
          fullService?.invalidate(photoId);
        }
      },
      progress: (done, total) => emitExportProgress({ done, total }),
      pickDestination: () => pickExportDestination(harnessEnv),
      failure: () => console.error('[overlook] protected export failed'),
      repairFailure: () => console.error('[overlook] protected migration repair failed'),
      workflowProgress: (progress) => broadcast((win) => win.webContents.send(events.protectedWorkflowProgress.name, progress)),
      workflowChanged: () => broadcast((win) => win.webContents.send(events.protectedAlbumsChanged.name, {})),
      ordinaryChanged: (photoIds) => {
        emitLibraryChanged({ photoIds: [...photoIds], membership: 'library' });
        notifyEmbeddingEligibilityChanged(photoIds);
      },
    });
    libraryParts = {
      db,
      blobStore: store,
      blobStoreReady,
      keyStore,
      protected: protectedRuntime,
    };
    const emitPending = createEmitter(events.pendingCountChanged, (name, payload) => {
      broadcast((win) => win.webContents.send(name, payload));
    });
    libraryService = new LibraryService(db, {
      libraryChanged: (photoIds, membership, albumIds) => {
        emitLibraryChanged({ photoIds: [...photoIds], membership, ...(albumIds === undefined ? {} : { albumIds: [...albumIds] }) });
        notifyEmbeddingEligibilityChanged(photoIds);
      },
      originalClassificationChanged: (photoIds) => {
        broadcast((win) => win.webContents.send(events.originalClassificationChanged.name, { photoIds: [...photoIds] }));
      },
      pendingCountChanged: (count) => {
        emitPending({ count });
        // Dirtying edits (favorite, album membership, restore) behave like
        // imports (#267): the debounced trigger runs under the same policy
        // gates (auto-backup setting, connected provider).
        if (count > 0) {
          scheduleAutoBackup();
        }
      },
    });
    startupMaintenance.schedule();
    if (getSettingsStore().get().semanticSearchEnabled) getEmbeddingService();
  }
  return libraryService;
}

/** Triggers the lazy bootstrap and asserts the parts exist — the shared
 * guard for every service accessor below. */
function requireParts(what: string): LibraryParts {
  getLibraryService();
  if (libraryParts === undefined) throw new Error(`library bootstrap failed; ${what} unavailable`);
  return libraryParts;
}

let importRuntime: ImportRuntime | undefined;
let rawRepairService: RawRepairService | undefined;
let posterCaptureService: PosterCaptureService | undefined;
function getImportService(): ImportService {
  if (importRuntime === undefined) {
    const parts = requireParts('import service');
    importRuntime = createImportApplicationRuntime({
      dataDir: libraryDataDir(),
      parts,
      harnessEnv,
      broadcast: (name, payload) => broadcast((win) => win.webContents.send(name, payload)),
      imported: () => {
        ensureMaintenanceServices();
        void posterCaptureService?.capture().catch(() => undefined);
        embeddingRuntime?.service.notifyWorkAvailable();
      },
      resumed: () => {
        getBackupEngine();
        autoBackupTrigger?.();
        embeddingRuntime?.service.notifyWorkAvailable();
      },
    });
  }
  return importRuntime.service;
}

// RAW/HEIC preview repair and video poster capture (ADR-0026 §6) are both
// post-import background passes over the same library parts; they share one
// bootstrap so the runtime factories stay thin.
function ensureMaintenanceServices(): void {
  if (rawRepairService !== undefined && posterCaptureService !== undefined) return;
  getImportService();
  const parts = libraryParts;
  const runtime = importRuntime;
  if (parts === undefined || runtime === undefined) throw new Error('library bootstrap failed; background maintenance unavailable');
  const emitPending = createEmitter(events.pendingCountChanged, (name, payload) => broadcast((win) => win.webContents.send(name, payload)));
  const services = buildMaintenanceServices({
    parts,
    runtime,
    invalidateThumb: (id) => thumbService?.invalidate(id),
    invalidateFull: (id) => fullService?.invalidate(id),
    emitChanged: (photoIds) => emitLibraryChanged({ photoIds: [...photoIds], membership: 'none' }),
    emitThumbsChanged: (photoIds) => emitLibraryChanged({ photoIds: [...photoIds], derivativeOnly: true }),
    emitPending: (count) => emitPending({ count }),
    scheduleAutoBackup,
    embeddingEligible: notifyEmbeddingEligibilityChanged,
  });
  rawRepairService = services.rawRepair;
  posterCaptureService = services.posterCapture;
}

let thumbService: ThumbService | undefined;

function getThumbService(): ThumbService {
  if (thumbService === undefined) {
    const parts = requireParts('thumb service');
    const repo = new PhotosRepository(parts.db);
    thumbService = new ThumbService({
      admit: (photoId) => repo.get(photoId) !== undefined,
      loadThumb: async (photoId, size) => {
        const photo = repo.get(photoId);
        if (photo === undefined) {
          return null;
        }
        try {
          const stream = parts.blobStore.getThumbStream(photo.contentHash, size, parts.keyStore.resolver(), photoId);
          return { bytes: await buffer(stream), contentHash: photo.contentHash };
        } catch (error) {
          if (error instanceof BlobStoreError) {
            return null; // No thumb in the store yet — M05 backfills.
          }
          throw error;
        }
      },
    });
  }
  return thumbService;
}

let fullService: FullService | undefined;

function getFullService(): FullService {
  if (fullService === undefined) {
    const parts = requireParts('full-res service');
    const repo = new PhotosRepository(parts.db);
    fullService = createFullRuntime({
      repo,
      blobs: parts.blobStore,
      resolveKey: parts.keyStore.resolver(),
      ephemeral: getEphemeralOriginalService,
      cacheMb: process.env['OVERLOOK_FULL_CACHE_MB'],
    });
  }
  return fullService;
}

function getProtectedRuntime(): ProtectedRuntime {
  return requireParts('protected runtime').protected;
}

let backupEngine: BackupEngine | undefined, closeCustodyRouting: (() => Promise<void>) | undefined;
let offloadService: OffloadService | undefined;
let ephemeralOriginalService: EphemeralOriginalService | undefined;
const activeBackupControllers = new Set<AbortController>();
const activeBackupRuns = new Set<Promise<BackupRunResult>>();
let providerRuntime: ProviderRuntime | undefined;
const providerWork = new WorkTracker(refreshApplicationMenu);

const custodyWorkActive = (): boolean => providerWork.busy() || interopRuntimeBusy();
const changeProviderWork = (delta: 1 | -1): void => {
  providerWork.change(delta);
  embeddingRuntime?.service.notifyWorkAvailable();
};

let embeddingRuntime: EmbeddingRuntime | undefined;

function notifyEmbeddingEligibilityChanged(photoIds: readonly string[]): void {
  embeddingRuntime?.service.notifyEligibilityChanged(photoIds);
}

function getEmbeddingService(): EmbeddingService {
  embeddingRuntime ??= createEmbeddingApplicationRuntime({
    parts: requireParts('embedding service'),
    importBusy: () => importRuntime?.service.busy() === true,
    custodyBusy: custodyWorkActive,
    broadcast: (name, payload) => broadcast((win) => win.webContents.send(name, payload)),
  });
  return embeddingRuntime.service;
}

function getProviderRuntime(): ProviderRuntime {
  providerRuntime ??= createProviderRuntime({
    dataDir: () => libraryDataDir(),
    isWorkActive: () => providerWork.busy(),
    harnessEnv,
    // Fail-closed switch activation (#741): see provider-switch-guard.ts.
    // Only an ALREADY-OPEN library's parts — never requireParts, which would
    // bootstrap an empty library into a fresh onboarding-restore profile.
    guardParts: () => libraryParts ?? null,
    libraryRegistry: registryRuntime,
  });
  return providerRuntime;
}

/** Fresh-profile onboarding must enumerate/connect providers without
 * bootstrapping an empty local library first. The browser scope is never
 * used for backup writes; discovered homes are re-scoped before restore. */
function ensureRestoreProviderRegistry(): ProviderRuntime {
  const runtime = getProviderRuntime();
  // iCloud Drive is present in every registry; optional providers cannot be
  // initialization sentinels because a disabled feature stays absent.
  if (runtime.provider('icloud-drive') === undefined) {
    runtime.buildProvider({
      mockRootDir: path.join(app.getPath('userData'), 'mock-remote'),
      fault: harnessEnv('OVERLOOK_BACKUP_FAULT'),
      libraryId: 'restore-browser',
    });
  }
  return runtime;
}
let autoBackupTrigger: (() => void) | undefined;

/** Dirtying EDITS auto-backup like imports do (#267) — before this, an
 * album add or favorite left the provider progress standing until a
 * manual run. Trailing debounce; convergence lives in autoBackupTrigger. */
const scheduleAutoBackup = createAutoBackupScheduler(() => {
  getBackupEngine();
  autoBackupTrigger?.();
});
let manifestSyncTrigger: (() => void) | undefined;
function markManifestDebt(): void {
  getBackupEngine();
  manifestSyncTrigger?.();
}
let purgeService: PurgeService | undefined;
let purgeRuntime: DrainablePurgeFacade | undefined;
let consistencyChecker: ConsistencyChecker | undefined;
const startupMaintenance = new StartupMaintenance({
  purge: () => getPurgeService().purgeExpired(),
  repair: () => consistencyChecker?.repair(),
  rawRepair: () => (ensureMaintenanceServices(), rawRepairService)?.repair(),
  posterCapture: () => (ensureMaintenanceServices(), posterCaptureService)?.capture(),
  verifySearchIndex: () => libraryParts && verifySearchIndexAsync(libraryParts.db),
});

function cancelScheduledLibraryWork(): void {
  scheduleAutoBackup.cancel();
  startupMaintenance.cancel();
}

// The backup cluster is built as one unit by getBackupEngine(); these
// accessors trigger it and assert the member exists.
function builtByBackupEngine<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`backup bootstrap failed; ${what} unavailable`);
  return value;
}
const getPurgeService = (): PurgeService => {
  getBackupEngine();
  return builtByBackupEngine(purgeService, 'purge');
};
const getPurgeRuntime = (): DrainablePurgeFacade => {
  getPurgeService();
  return builtByBackupEngine(purgeRuntime, 'purge runtime');
};
const getOffloadService = (): OffloadService => {
  getBackupEngine();
  return builtByBackupEngine(offloadService, 'offload');
};
const getEphemeralOriginalService = (): EphemeralOriginalService => {
  getBackupEngine();
  return builtByBackupEngine(ephemeralOriginalService, 'ephemeral originals');
};

function getBackupEngine(): BackupEngine {
  if (backupEngine === undefined) {
    const parts = requireParts('backup');
    const repo = new PhotosRepository(parts.db);
    const ledger = new SyncLedger(parts.db);
    const emitProgress = createEmitter(events.backupProgress, (name, payload) => {
      broadcast((win) => win.webContents.send(name, payload));
    });
    const emitCompleted = createEmitter(events.backupCompleted, (name, payload) => {
      broadcast((win) => win.webContents.send(name, payload));
    });
    // libraryChanged reuses the module-level emitter — one truth, no shadow.
    const audit = createBackupAuditLogger(path.join(libraryDataDir(), 'backup-audit.log'));
    const emitPending = createEmitter(events.pendingCountChanged, (name, payload) => {
      broadcast((win) => win.webContents.send(name, payload));
    });
    const provider = getProviderRuntime().buildProvider({
      mockRootDir: path.join(app.getPath('userData'), 'mock-remote'),
      fault: harnessEnv('OVERLOOK_BACKUP_FAULT'),
    });
    const custodyRouting = createCustodyRoutingRuntime({
      db: parts.db,
      backupTarget: provider,
      libraryId: () => getProviderRuntime().libraryId(),
      provider: (providerId) => getProviderRuntime().provider(providerId),
      backupTargetConnected: () => getProviderRuntime().activeId() !== null,
      status: (photoId) => ledger.status(photoId),
      now: () => new Date().toISOString(),
      masterKey: () => parts.keyStore.masterKeyBytes(),
      writeCustodyHints: (hints) => {
        registryRuntime.getRegistry().updateCustodyHints(registryRuntime.resolveActive().id, hints);
      },
      audit,
    });
    closeCustodyRouting = custodyRouting.close;
    const emitSyncStateChanged = createEmitter(events.photoSyncStateChanged, (name, payload) => {
      broadcast((win) => win.webContents.send(name, payload));
    });
    const integrityScrubber = createBackupIntegrityRuntime({
      db: parts.db,
      provider,
      ...custodyRouting.integrity,
      repo,
      blobs: parts.blobStore,
      resolveKey: parts.keyStore.resolver(),
      markVerified: (photoId) => ledger.repairStatus(photoId, 'offloaded'),
      markUnrecoverable: (photoId) => {
        ledger.repairStatus(photoId, 'error');
        emitSyncStateChanged({ updates: [{ id: photoId, syncState: 'error' }] });
      },
      audit,
    });
    backupEngine = new BackupEngine({
      provider,
      ledger,
      dirtyPhotos: () => repo.dirtyPhotos(),
      encryptedStream: (hash) => parts.blobStore.getEncryptedStream(hash),
      sealManifest: (json) => sealManifestJson(json, parts.keyStore.currentKey()),
      sealRecoveryBootstrap: (generatedAt) =>
        sealKeyStoreRecoveryBootstrap({ keyStore: parts.keyStore, libraryId: getProviderRuntime().libraryId(), generatedAt }),
      libraryId: () => getProviderRuntime().libraryId(),
      manifestSnapshot: () => repo.manifestSnapshot(),
      activitySnapshot: () => activityBackupSnapshot(parts.db),
      boardsSnapshot: () => boardsSnapshot(parts.db),
      ...sidecarBackupDeps(parts.db, parts.blobStore),
      // Live reads (#111): every run and every maybeAutoRun sees the
      // store's current values — no restart needed after a settings change.
      settings: () => {
        const current = getSettingsStore().get();
        return {
          throttlePercent: throttlePercentOf(current),
          wifiOnly: current.wifiOnly,
          // Disconnected (#114) means no automatic uploads — the switch is
          // disabled in the dialog for the same reason.
          autoBackupOnImport: current.autoBackupOnImport && getProviderRuntime().activeId() !== null,
        };
      },
      network: () => 'unknown',
      events: { progress: (done, total, photoId) => emitProgress({ done, total, photoId }) },
      now: () => Date.now(),
      sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      pendingCountChanged: (count) => emitPending({ count }),
      pendingCount: () => repo.pendingCount(),
      syncStateChanged: (updates) => emitSyncStateChanged({ updates: [...updates] }),
      audit,
      integrityScrub: () => integrityScrubber.scrub(),
      recoveryGenerationHealthy: createRecoveryHealthCheck(provider, () => getProviderRuntime().libraryId(), parts.keyStore),
      ...createBackupClaimDeps(parts.db, parts.blobStore),
      protectedBackup: parts.protected.backupBinding(provider, audit),
    });
    const emitEphemeralState = createEmitter(events.ephemeralOriginalState, (name, payload) => {
      broadcast((win) => win.webContents.send(name, payload));
    });
    const custody = createOriginalCustodyRuntime({
      provider,
      connected: () => getProviderRuntime().activeId() !== null,
      offloadAuthority: custodyRouting.offloadAuthority,
      custody: custodyRouting.resolver,
      custodyChanged: custodyRouting.custodyChanged,
      ledger,
      repo,
      blobs: parts.blobStore,
      blobsReady: parts.blobStoreReady,
      resolveKey: parts.keyStore.resolver(),
      reOffloadAfterViewing: () => getSettingsStore().get().reOffloadAfterViewing,
      workChanged: changeProviderWork,
      syncStateChanged: (updates) => emitSyncStateChanged({ updates: [...updates] }),
      storageChanged: () => broadcast((win) => win.webContents.send(events.storageChanged.name, {})),
      stateChanged: emitEphemeralState,
      invalidateFull: (photoId) => fullService?.invalidate(photoId),
      audit,
    });
    offloadService = custody.offload;
    ephemeralOriginalService = custody.ephemeral;
    purgeService = createPurgeService({
      db: parts.db,
      repo,
      blobStore: parts.blobStore,
      remoteProvider: custodyRouting.remoteProvider,
      custodyChanged: custodyRouting.custodyChanged,
      // Purging changes manifestSnapshot() — same owed-generation rule (and
      // quiet push) as soft delete (PR #218 review).
      oweManifest: () => manifestSyncTrigger?.(),
      libraryChanged: (photoIds) => {
        emitLibraryChanged({ photoIds: [...photoIds], membership: 'library' });
      },
      audit,
      retention: () => getSettingsStore().get().trashRetention,
    });
    purgeRuntime = createPurgeRuntime(purgeService, changeProviderWork);
    consistencyChecker = createConsistencyChecker({
      db: parts.db,
      repo,
      blobStore: parts.blobStore,
      provider,
      setStatus: (photoId, status) => {
        ledger.repairStatus(photoId, status);
      },
      libraryChanged: (photoIds) => {
        emitLibraryChanged({ photoIds: [...photoIds], membership: 'none' });
      },
      audit,
    });
    // Completion events drive the toasts (#106) and the card's bar clear
    // (#108). `auto` rides along so the renderer keeps automatic successes
    // QUIET — an auto-backup's green toast was racing (and replacing) the
    // import-complete toast (#116); failures stay loud for every trigger.
    const engine = backupEngine;
    const originalRun = engine.run.bind(engine);
    const runAndReportCore = async (auto: boolean, signal?: AbortSignal): Promise<BackupRunResult> => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted === true) controller.abort();
      else signal?.addEventListener('abort', abort, { once: true });
      activeBackupControllers.add(controller);
      changeProviderWork(1);
      try {
        const result = await originalRun(controller.signal);
        if (result.skipped === null) {
          emitCompleted({
            uploaded: result.uploaded,
            failed: result.failed,
            manifestUploaded: result.manifestUploaded,
            auto,
            integrity: result.integrity,
          });
        }
        return result;
      } finally {
        signal?.removeEventListener('abort', abort);
        activeBackupControllers.delete(controller);
        changeProviderWork(-1);
      }
    };
    const runAndReport = (auto: boolean, signal?: AbortSignal): Promise<BackupRunResult> => {
      const run = runAndReportCore(auto, signal);
      activeBackupRuns.add(run);
      const remove = () => activeBackupRuns.delete(run);
      void run.then(remove, remove);
      return run;
    };
    engine.run = (signal?: AbortSignal) => runAndReport(false, signal);
    // The auto-backup trigger (#105/#111): same single-flight run, marked
    // auto for the quiet-success rule above.
    autoBackupTrigger = () => {
      const current = getSettingsStore().get();
      if (current.autoBackupOnImport && getProviderRuntime().activeId() !== null) {
        void runAndReport(true)
          .then((result) => {
            // An edit landing MID-RUN joins the in-flight run without
            // uploading (the dirty set is the next run's queue) — re-arm
            // until clean so edits converge to zero (#267). A failing run
            // stops the loop: its rows sit in 'error' with the red toast,
            // and retry stays a user decision.
            if (result.skipped === null && result.failed === 0 && repo.pendingCount() > 0) {
              scheduleAutoBackup();
            }
          })
          .catch(() => undefined);
      }
    };
    // Not gated on autoBackupOnImport: this is manifest CORRECTNESS, not a
    // convenience upload. Push immediately only when the debt is PURE
    // (pending 0 — the toolbar is disabled, so nothing else would settle
    // it); with dirty rows the user's next backup carries the manifest,
    // and we never upload blobs they didn't ask for. Disconnected keeps
    // the debt for the next run.
    manifestSyncTrigger = () => {
      engine.oweManifest();
      if (getProviderRuntime().activeId() !== null && repo.pendingCount() === 0) {
        void runAndReport(true).catch(() => undefined);
      }
    };
  }
  return backupEngine;
}

let exportFacade: DrainableExportFacade | undefined;

function getExportFacade(): DrainableExportFacade {
  if (exportFacade === undefined) {
    const parts = requireParts('export');
    exportFacade = createExportFacade({
      db: parts.db,
      blobStore: parts.blobStore,
      resolveKey: parts.keyStore.resolver(),
      ephemeral: getEphemeralOriginalService,
      pickDestination: () => pickExportDestination(harnessEnv),
      progress: (done, total) => emitExportProgress({ done, total }),
    });
  }
  return exportFacade;
}

async function closeLibrary(mode: 'restore' | 'lock' | 'switch'): Promise<void> {
  autoBackupTrigger = undefined;
  manifestSyncTrigger = undefined;
  importRuntime?.service.close();
  exportFacade?.close();
  libraryParts?.protected.cancel();
  purgeRuntime?.close();
  rawRepairService?.close();
  posterCaptureService?.close();
  for (const controller of activeBackupControllers) controller.abort();
  await drainWithCancellationFence(cancelScheduledLibraryWork, [
    closeProductionInboundMoveLibrary(),
    importRuntime?.service.drain() ?? Promise.resolve(),
    exportFacade?.drain() ?? Promise.resolve(),
    libraryParts?.protected.drain() ?? Promise.resolve(),
    purgeRuntime?.drain() ?? Promise.resolve(),
    embeddingRuntime?.close() ?? Promise.resolve(),
    startupMaintenance.drain(),
    closeCustodyRouting?.() ?? Promise.resolve(),
    Promise.allSettled([
      ...activeBackupRuns,
      providerRuntime?.drainICloudDriveOperations(),
      providerRuntime?.drainReconnectVerifications(),
    ]),
    mode !== 'restore' ? (restoreRuntime?.close() ?? Promise.resolve()) : Promise.resolve(),
    mode !== 'restore' ? providerWork.idle() : Promise.resolve(),
    Promise.all([thumbService?.close() ?? Promise.resolve(), fullService?.close() ?? Promise.resolve()]),
    importRuntime?.pool.close() ?? Promise.resolve(),
    ...(mode !== 'restore' ? [session.defaultSession.clearCache()] : []),
    ...(mode === 'lock' ? [reloadContentWindowsForLock()] : []),
  ]);
  lockInteropRuntime();
  libraryParts?.protected.close();
  if (libraryParts !== undefined) {
    try {
      // Clean close checkpoints WAL (ADR-0017 §4): the closed directory is a
      // complete, copy/eject-safe unit with no live -wal/-shm sidecars.
      libraryParts.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // Checkpoint failure never blocks close — SQLite replays on next open.
    }
    libraryParts.db.close();
    libraryParts.keyStore.close();
  }
  providerRuntime?.renewReconnectVerificationLifecycle();
  [libraryService, libraryParts, importRuntime] = [undefined, undefined, undefined];
  [rawRepairService, posterCaptureService, thumbService, fullService] = [undefined, undefined, undefined, undefined];
  [backupEngine, offloadService, closeCustodyRouting] = [undefined, undefined, undefined];
  ephemeralOriginalService = undefined;
  [purgeService, purgeRuntime] = [undefined, undefined];
  [consistencyChecker, embeddingRuntime, exportFacade] = [undefined, undefined, undefined];
  if (mode !== 'restore') restoreRuntime = undefined;
  releaseLibraryLock?.();
  releaseLibraryLock = undefined;
}

// Live switch (#385) + relocation (#483): see library/switch-runtime.ts,
// library/relocation-runtime.ts, and library-lifecycle-wiring.ts for the
// contracts — both runtimes are built from this one deps bag.
const { switchLibrary, getRelocationRuntime, settleRelocationJournals, reportStartupFailures } = createLibraryLifecycle({
  registryRuntime,
  instanceId,
  safeStorage: pickSafeStorage,
  activeId: () => registryRuntime.resolveActive().id,
  openLibraryId: () => (libraryService === undefined ? null : registryRuntime.resolveActive().id),
  lockState: () => appLockHost?.snapshot().state,
  providerBusy: custodyWorkActive,
  closeLibrary: () => closeLibrary('switch'),
  activateSettings: () => {
    lockInteropRuntime();
    activateSettingsLibrary();
  },
  resetProviderBinding: () => getProviderRuntime().resetLibraryBinding(),
  appLockHost: () => appLockHost,
  buildAppLockController,
  reloadWindows: reloadContentWindowsForLock,
  harnessEnv,
});

let appLockHost: AppLockHost | undefined;

// Each controller is dataDir-bound; the host lets bound-once consumers (IPC,
// lifecycle, external-open) follow a library switch (#385, ADR-0017 §4).
function buildAppLockController(): ReturnType<typeof createAppLockRuntime> {
  return createAppLockRuntime({
    dataDir: libraryDataDir(),
    safeStorage: pickSafeStorage(),
    ...(harnessEnv('OVERLOOK_APP_LOCK_TEST_ANCHOR') === '1'
      ? { anchorStore: new TestFileCredentialAnchorStore(path.join(app.getPath('userData'), 'app-lock-test-anchor.json')) }
      : {}),
    openAuthorized: (masterKey) => {
      if (masterKey === undefined) return;
      const authorized = Buffer.from(masterKey);
      releasedMaster = authorized;
      try {
        getLibraryService();
      } finally {
        authorized.fill(0);
        releasedMaster = undefined;
      }
    },
    closeAuthorized: () => closeLibrary('lock'),
    failClosed: relaunchLocked,
  });
}

function getAppLockController(): AppLockHost {
  appLockHost ??= new AppLockHost(buildAppLockController());
  return appLockHost;
}

let restoreRuntime: RestoreRuntime | undefined;

function getRestoreRuntime(): RestoreRuntime {
  restoreRuntime ??= createRestoreRuntime({
    targetDir: libraryDataDir(),
    safeStorage: pickSafeStorage,
    // "Use this Mac's saved key" (#741 follow-up): an open library's own
    // keystore restores its cloud backups without the exported key file.
    localMasterKey: () => requireParts('restore key').keyStore.masterKeyBytes(),
    sources: (providerId) => ensureRestoreProviderRegistry().restoreSources(providerId),
    sessionId: ulid,
    progress: createEmitter(events.restoreProgress, (name, payload) => {
      broadcast((win) => win.webContents.send(name, payload));
    }),
    beforeActivate: () => closeLibrary('restore'),
    harnessEnv,
    workChanged: changeProviderWork,
  });
  return restoreRuntime;
}

void externalOpen.whenReady().then(async () => {
  if (await productionInterop.runNativeHost()) return;
  if (await exitForReleaseSmokeIfRequested(app)) return;
  await productionInterop.startDesktop();
  // Settle relocation journals FIRST (ADR-0022 §2): recovery may re-point the
  // registry (roll a commit forward), so it must run before resolveActive()
  // caches an entry and before anything opens or classifies libraries. A
  // corrupt registry falls through to resolveFailure()'s loud dialog below.
  await settleRelocationJournals();
  if (!reportStartupFailures((title, message) => dialog.showErrorBox(title, message))) {
    app.exit(1);
    return;
  }
  // Recover the activation rename crash window before IPC can classify/open the library.
  await recoverInterruptedActivation(restorePaths(libraryDataDir()));
  const lock = getAppLockController();
  await lock.initialize();
  installApplicationMenu(lock, custodyWorkActive);
  externalOpen.followAuthorization(lock);
  registerIpcHandlers(() => getSettingsStore().get().language);
  registerRelocationHandlers(getRelocationRuntime);
  registerAppLockIpc({
    controller: lock,
    currentMaster: () => {
      return requireParts('master key').keyStore.masterKeyBytes();
    },
    libraryId: () => getProviderRuntime().libraryId(),
    dataDir: () => libraryDataDir(),
    pickRecovery: () => pickRecoveryKeyPath(harnessEnv('OVERLOOK_KEY_IMPORT_SOURCE')),
    send: (name, payload) => broadcast((win) => win.webContents.send(name, payload)),
    settings: () => getSettingsStore().get(),
  });
  registerAppServices({
    dataDir: () => libraryDataDir(),
    harnessEnv,
    requireContentAccess: () => lock.requireContentAccess(),
    allowKeyImport: () => lock.snapshot().state === 'unconfigured-unlocked',
    getLibrary: getLibraryService,
    getActivity: () => createActivityFacade(requireParts('activity').db, () => manifestSyncTrigger?.()),
    getHistory: () =>
      createHistoryService(requireParts('history'), getLibraryService(), markManifestDebt, (boardId) => emitBoardsReload({ boardId })),
    libraries: {
      ...registryRuntime.facade({
        openLibraryId: () => (libraryService === undefined ? null : registryRuntime.resolveActive().id),
        safeStorage: pickSafeStorage,
        pickDirectory: () => pickLibraryDirectory(harnessEnv('OVERLOOK_PICK_LIBRARY_DIR')),
      }),
      open: switchLibrary,
    },
    getProtected: getProtectedRuntime,
    getThumbs: getThumbService,
    getFull: getFullService,
    getImport: getImportService,
    getEmbedding: getEmbeddingService,
    getExport: getExportFacade,
    getKeyStore: () => {
      return requireParts('key store').keyStore;
    },
    getRestore: getRestoreRuntime,
    getPurge: getPurgeRuntime,
    activeLibraryId: () => registryRuntime.resolveActive().id,
    authorizationEpoch: () => lock.authorizationEpoch(),
    lockState: () => lock.snapshot().state,
    authorizePassword: (password) => lock.authorize(password),
    safeStorage: pickSafeStorage,
    providerBusy: custodyWorkActive,
    pcloudEnabled: productionInterop.pcloud.enabled,
    onManifestChanged: markManifestDebt,
    onImported: () => {
      getBackupEngine();
      autoBackupTrigger?.();
      embeddingRuntime?.service.notifyWorkAvailable();
    },
    onImportRendererReady: externalOpen.rendererReady,
    broadcast: (name, payload) => broadcast((win) => win.webContents.send(name, payload)),
    backup: {
      runtime: ensureRestoreProviderRegistry,
      run: () => getBackupEngine().run(),
      offloadService: getOffloadService,
      ephemeralOriginalService: getEphemeralOriginalService,
      workChanged: changeProviderWork,
    },
  });
  await runDevSeeds({
    contentAvailable: lock.snapshot().state === 'unconfigured-unlocked' || lock.snapshot().state === 'unlocked',
    harnessEnv,
    open: () => devSeedAccess(getLibraryService(), libraryParts),
  });
  externalOpen.finishBootstrap();
});

if (!productionInterop.nativeHostRequested) {
  registerWindowAllClosedQuit();
  registerQuitTeardown({
    isLibraryOpen: () => libraryService !== undefined,
    lockState: () => appLockHost?.snapshot().state,
    close: () => closeLibrary('lock'),
  });
}

app.on('will-quit', () => {
  lockInteropRuntime();
  externalOpen.close();
  restoreRuntime?.dispose();
  void importRuntime?.pool.close();
});
