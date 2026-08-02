import type { z } from 'zod';

import type { channels, events, FocusChangedPayload, PingRequest, PingResponse } from './channels.js';
import type { llmChannels } from './llm-channels.js';

type Req<C extends { request: z.ZodType }> = z.input<C['request']>;
type Res<C extends { response: z.ZodType }> = z.output<C['response']>;

// The complete surface preload exposes as `window.overlook`. The renderer
// consumes this as a type only — the implementation lives in src/preload.
export interface OverlookApi {
  readonly ping: (request: PingRequest) => Promise<PingResponse>;
  readonly onFocusChanged: (listener: (payload: FocusChangedPayload) => void) => () => void;
  readonly commands: {
    readonly ready: (context: Req<typeof channels.commandRendererReady>) => Promise<void>;
    readonly updateContext: (context: Req<typeof channels.commandContextUpdate>) => Promise<void>;
    readonly onInvoked: (listener: (payload: z.output<typeof events.commandInvoked.payload>) => void) => () => void;
  };
  /** Opens the project help externally (the Windows/Linux titlebar Help menu's
   * `help.open` path; macOS dispatches the same command from its native menu). */
  readonly help: {
    readonly open: () => Promise<void>;
  };
  readonly getPlatform: () => Promise<string>;
  /** Active UI locale resolved in main (setting → OS → en; ADR-0020 §2). */
  readonly getLocale: () => Promise<string>;
  readonly minimizeWindow: () => Promise<void>;
  readonly toggleMaximizeWindow: () => Promise<boolean>;
  readonly closeWindow: () => Promise<void>;
  readonly inspectorWindow: {
    readonly open: (request: Req<typeof channels.inspectorWindowOpen>) => Promise<void>;
    readonly update: (request: Req<typeof channels.inspectorWindowUpdate>) => Promise<void>;
    readonly close: () => Promise<void>;
    readonly step: (delta: 1 | -1) => Promise<void>;
    readonly snapshot: () => Promise<Res<typeof channels.inspectorWindowSnapshot>>;
    readonly onChanged: (listener: (payload: z.output<typeof events.inspectorWindowChanged.payload>) => void) => () => void;
    readonly onClosed: (listener: () => void) => () => void;
    readonly onStepRequested: (listener: (delta: 1 | -1) => void) => () => void;
  };
  readonly appLock: {
    readonly status: () => Promise<Res<typeof channels.appLockStatus>>;
    readonly unlock: (request: Req<typeof channels.appLockUnlock>) => Promise<Res<typeof channels.appLockUnlock>>;
    readonly configure: (request: Req<typeof channels.appLockConfigure>) => Promise<Res<typeof channels.appLockConfigure>>;
    readonly lockNow: () => Promise<Res<typeof channels.appLockNow>>;
    readonly changePassword: (request: Req<typeof channels.appLockChangePassword>) => Promise<Res<typeof channels.appLockChangePassword>>;
    readonly remove: (request: Req<typeof channels.appLockRemove>) => Promise<Res<typeof channels.appLockRemove>>;
    readonly pickRecovery: () => Promise<Res<typeof channels.appLockPickRecovery>>;
    readonly recover: (request: Req<typeof channels.appLockRecover>) => Promise<Res<typeof channels.appLockRecover>>;
    readonly touchIdStatus: () => Promise<Res<typeof channels.appLockTouchIdStatus>>;
    readonly touchIdEnable: (request: Req<typeof channels.appLockTouchIdEnable>) => Promise<Res<typeof channels.appLockTouchIdEnable>>;
    readonly touchIdDisable: () => Promise<Res<typeof channels.appLockTouchIdDisable>>;
    readonly touchIdUnlock: () => Promise<Res<typeof channels.appLockTouchIdUnlock>>;
    readonly onChanged: (listener: (payload: z.output<typeof events.appLockStateChanged.payload>) => void) => () => void;
    readonly onTouchIdChanged: (listener: (payload: z.output<typeof events.appLockTouchIdChanged.payload>) => void) => () => void;
  };
  readonly interop: {
    readonly status: () => Promise<Res<typeof channels.interopStatus>>;
    readonly connectProvider: (
      request: Req<typeof channels.interopProviderConnect>,
    ) => Promise<Res<typeof channels.interopProviderConnect>>;
    readonly disconnectProvider: (
      request: Req<typeof channels.interopProviderDisconnect>,
    ) => Promise<Res<typeof channels.interopProviderDisconnect>>;
    readonly selectPairing: () => Promise<Res<typeof channels.interopPairingSelect>>;
    readonly unlockPairing: (request: Req<typeof channels.interopPairingUnlock>) => Promise<Res<typeof channels.interopPairingUnlock>>;
    readonly refresh: () => Promise<Res<typeof channels.interopRefresh>>;
    readonly start: (request: Req<typeof channels.interopStart>) => Promise<Res<typeof channels.interopStart>>;
    readonly pause: () => Promise<Res<typeof channels.interopPause>>;
    readonly resume: () => Promise<Res<typeof channels.interopResume>>;
    readonly cancel: () => Promise<Res<typeof channels.interopCancel>>;
    readonly retry: () => Promise<Res<typeof channels.interopRetry>>;
    readonly onChanged: (listener: (payload: z.output<typeof events.interopStatusChanged.payload>) => void) => () => void;
  };
  readonly library: {
    readonly page: (request: Req<typeof channels.libraryPage>) => Promise<Res<typeof channels.libraryPage>>;
    readonly selectAll: (request: Req<typeof channels.librarySelectAll>) => Promise<Res<typeof channels.librarySelectAll>>;
    readonly selectionRange: (request: Req<typeof channels.librarySelectionRange>) => Promise<Res<typeof channels.librarySelectionRange>>;
    readonly get: (request: Req<typeof channels.libraryGet>) => Promise<Res<typeof channels.libraryGet>>;
    readonly repairDimensions: (
      request: Req<typeof channels.libraryRepairDimensions>,
    ) => Promise<Res<typeof channels.libraryRepairDimensions>>;
    readonly toggleFavorite: (request: Req<typeof channels.libraryToggleFavorite>) => Promise<Res<typeof channels.libraryToggleFavorite>>;
    readonly setOriginal: (request: Req<typeof channels.librarySetOriginal>) => Promise<Res<typeof channels.librarySetOriginal>>;
    readonly counts: (request: Req<typeof channels.libraryCounts>) => Promise<Res<typeof channels.libraryCounts>>;
    readonly stats: () => Promise<Res<typeof channels.libraryStats>>;
    readonly albums: () => Promise<Res<typeof channels.libraryAlbums>>;
    readonly delete: (request: Req<typeof channels.libraryDelete>) => Promise<Res<typeof channels.libraryDelete>>;
    readonly restore: (request: Req<typeof channels.libraryRestore>) => Promise<Res<typeof channels.libraryRestore>>;
    readonly purge: (request: Req<typeof channels.libraryPurge>) => Promise<Res<typeof channels.libraryPurge>>;
    readonly originalDeletePreflight: (
      request: Req<typeof channels.libraryOriginalDeletePreflight>,
    ) => Promise<Res<typeof channels.libraryOriginalDeletePreflight>>;
    readonly originalDeleteAuthorize: (
      request: Req<typeof channels.libraryOriginalDeleteAuthorize>,
    ) => Promise<Res<typeof channels.libraryOriginalDeleteAuthorize>>;
    readonly originalDeleteCommit: (
      request: Req<typeof channels.libraryOriginalDeleteCommit>,
    ) => Promise<Res<typeof channels.libraryOriginalDeleteCommit>>;
    readonly originalDeleteCancel: (request: Req<typeof channels.libraryOriginalDeleteCancel>) => Promise<void>;
    readonly onChanged: (listener: (payload: z.output<typeof events.libraryChanged.payload>) => void) => () => void;
    readonly onOriginalClassificationChanged: (listener: (payload: { photoIds: string[] }) => void) => () => void;
    readonly onSyncStateChanged: (
      listener: (payload: { updates: { id: string; syncState: 'local' | 'syncing' | 'synced' | 'offloaded' | 'error' }[] }) => void,
    ) => () => void;
    readonly onStorageChanged: (listener: () => void) => () => void;
    readonly onPendingCountChanged: (listener: (payload: { count: number }) => void) => () => void;
  };
  readonly activity: {
    readonly page: (request: Req<typeof channels.activityPage>) => Promise<Res<typeof channels.activityPage>>;
  };
  readonly history: {
    readonly status: () => Promise<Res<typeof channels.historyStatus>>;
    readonly undo: (request: Req<typeof channels.historyUndo>) => Promise<Res<typeof channels.historyUndo>>;
    readonly redo: (request: Req<typeof channels.historyRedo>) => Promise<Res<typeof channels.historyRedo>>;
  };
  readonly albums: {
    readonly create: (request: Req<typeof channels.albumCreate>) => Promise<Res<typeof channels.albumCreate>>;
    readonly rename: (request: Req<typeof channels.albumRename>) => Promise<Res<typeof channels.albumRename>>;
    readonly delete: (request: Req<typeof channels.albumDelete>) => Promise<Res<typeof channels.albumDelete>>;
    readonly addPhotos: (request: Req<typeof channels.albumAddPhotos>) => Promise<Res<typeof channels.albumAddPhotos>>;
    readonly removePhotos: (request: Req<typeof channels.albumRemovePhotos>) => Promise<Res<typeof channels.albumRemovePhotos>>;
    readonly movePhotos: (request: Req<typeof channels.albumMovePhotos>) => Promise<Res<typeof channels.albumMovePhotos>>;
    readonly reorder: (request: Req<typeof channels.albumReorder>) => Promise<Res<typeof channels.albumReorder>>;
  };
  readonly boards: {
    readonly list: () => Promise<Res<typeof channels.boardList>>;
    readonly get: (request: Req<typeof channels.boardGet>) => Promise<Res<typeof channels.boardGet>>;
    readonly save: (request: Req<typeof channels.boardSave>) => Promise<Res<typeof channels.boardSave>>;
    readonly delete: (request: Req<typeof channels.boardDelete>) => Promise<Res<typeof channels.boardDelete>>;
    readonly onReload: (listener: (payload: z.output<typeof events.boardsReload.payload>) => void) => () => void;
  };
  readonly protectedAlbums: {
    readonly list: () => Promise<Res<typeof channels.protectedAlbumsList>>;
    readonly protect: (request: Req<typeof channels.protectedAlbumProtect>) => Promise<Res<typeof channels.protectedAlbumProtect>>;
    readonly unprotect: (request: Req<typeof channels.protectedAlbumUnprotect>) => Promise<Res<typeof channels.protectedAlbumUnprotect>>;
    readonly changePassword: (
      request: Req<typeof channels.protectedAlbumChangePassword>,
    ) => Promise<Res<typeof channels.protectedAlbumChangePassword>>;
    readonly pickRecovery: () => Promise<Res<typeof channels.protectedAlbumPickRecovery>>;
    readonly recover: (request: Req<typeof channels.protectedAlbumRecover>) => Promise<Res<typeof channels.protectedAlbumRecover>>;
    readonly cancelWorkflow: () => Promise<Res<typeof channels.protectedAlbumCancelWorkflow>>;
    readonly unlock: (request: Req<typeof channels.protectedAlbumUnlock>) => Promise<Res<typeof channels.protectedAlbumUnlock>>;
    readonly relock: (request: Req<typeof channels.protectedAlbumRelock>) => Promise<Res<typeof channels.protectedAlbumRelock>>;
    readonly summary: (request: Req<typeof channels.protectedAlbumSummary>) => Promise<Res<typeof channels.protectedAlbumSummary>>;
    readonly page: (request: Req<typeof channels.protectedAlbumPage>) => Promise<Res<typeof channels.protectedAlbumPage>>;
    readonly get: (request: Req<typeof channels.protectedAlbumGet>) => Promise<Res<typeof channels.protectedAlbumGet>>;
    readonly toggleFavorite: (
      request: Req<typeof channels.protectedAlbumToggleFavorite>,
    ) => Promise<Res<typeof channels.protectedAlbumToggleFavorite>>;
    readonly delete: (request: Req<typeof channels.protectedAlbumDelete>) => Promise<Res<typeof channels.protectedAlbumDelete>>;
    readonly restore: (request: Req<typeof channels.protectedAlbumRestore>) => Promise<Res<typeof channels.protectedAlbumRestore>>;
    readonly pickExportDestination: () => Promise<Res<typeof channels.protectedAlbumExportPickDestination>>;
    readonly export: (request: Req<typeof channels.protectedAlbumExportRun>) => Promise<Res<typeof channels.protectedAlbumExportRun>>;
    readonly cancelExport: () => Promise<Res<typeof channels.protectedAlbumExportCancel>>;
    readonly onChanged: (listener: () => void) => () => void;
    readonly onProgress: (listener: (payload: z.output<typeof events.protectedWorkflowProgress.payload>) => void) => () => void;
  };
  readonly backup: {
    readonly run: (request: Req<typeof channels.backupRun>) => Promise<Res<typeof channels.backupRun>>;
    readonly onProgress: (listener: (payload: z.output<typeof events.backupProgress.payload>) => void) => () => void;
    readonly onCompleted: (listener: (payload: z.output<typeof events.backupCompleted.payload>) => void) => () => void;
    readonly offloadPreflight: (
      request: Req<typeof channels.backupOffloadPreflight>,
    ) => Promise<Res<typeof channels.backupOffloadPreflight>>;
    readonly offload: (request: Req<typeof channels.backupOffload>) => Promise<Res<typeof channels.backupOffload>>;
    readonly rehydrate: (request: Req<typeof channels.backupRehydrate>) => Promise<Res<typeof channels.backupRehydrate>>;
    readonly keepDownloaded: (request: Req<typeof channels.backupKeepDownloaded>) => Promise<Res<typeof channels.backupKeepDownloaded>>;
    readonly releaseEphemeral: (
      request: Req<typeof channels.backupReleaseEphemeral>,
    ) => Promise<Res<typeof channels.backupReleaseEphemeral>>;
    readonly ephemeralStatus: (request: Req<typeof channels.backupEphemeralStatus>) => Promise<Res<typeof channels.backupEphemeralStatus>>;
    readonly prepareEphemeral: (
      request: Req<typeof channels.backupPrepareEphemeral>,
    ) => Promise<Res<typeof channels.backupPrepareEphemeral>>;
    readonly onEphemeralState: (listener: (payload: z.output<typeof events.ephemeralOriginalState.payload>) => void) => () => void;
    readonly restoreOriginals: (
      request: Req<typeof channels.backupRestoreOriginals>,
    ) => Promise<Res<typeof channels.backupRestoreOriginals>>;
    readonly providers: () => Promise<Res<typeof channels.backupProviders>>;
    readonly providerStatus: (request: Req<typeof channels.backupProviderStatus>) => Promise<Res<typeof channels.backupProviderStatus>>;
    readonly providerStorage: (request: Req<typeof channels.backupProviderStorage>) => Promise<Res<typeof channels.backupProviderStorage>>;
    readonly connect: (request: Req<typeof channels.backupConnect>) => Promise<Res<typeof channels.backupConnect>>;
    readonly disconnect: (request: Req<typeof channels.backupDisconnect>) => Promise<Res<typeof channels.backupDisconnect>>;
    readonly openCapacitySettings: (
      request: Req<typeof channels.backupOpenCapacitySettings>,
    ) => Promise<Res<typeof channels.backupOpenCapacitySettings>>;
  };
  readonly export: {
    readonly pickDestination: (request: Req<typeof channels.exportPickDestination>) => Promise<Res<typeof channels.exportPickDestination>>;
    readonly run: (request: Req<typeof channels.exportRun>) => Promise<Res<typeof channels.exportRun>>;
    readonly cancel: (request: Req<typeof channels.exportCancel>) => Promise<Res<typeof channels.exportCancel>>;
    readonly onProgress: (listener: (payload: z.output<typeof events.exportProgress.payload>) => void) => () => void;
  };
  readonly keys: {
    readonly status: () => Promise<Res<typeof channels.keysStatus>>;
    readonly export: (request: Req<typeof channels.keysExport>) => Promise<Res<typeof channels.keysExport>>;
    readonly pickFile: () => Promise<Res<typeof channels.keysPickFile>>;
    readonly import: (request: Req<typeof channels.keysImport>) => Promise<Res<typeof channels.keysImport>>;
  };
  readonly restore: {
    readonly profileStatus: () => Promise<Res<typeof channels.restoreProfileStatus>>;
    readonly pickKey: () => Promise<Res<typeof channels.restorePickKey>>;
    readonly discover: (request: Req<typeof channels.restoreDiscover>) => Promise<Res<typeof channels.restoreDiscover>>;
    readonly run: (request: Req<typeof channels.restoreRun>) => Promise<Res<typeof channels.restoreRun>>;
    readonly cancel: (request: Req<typeof channels.restoreCancel>) => Promise<Res<typeof channels.restoreCancel>>;
    readonly onProgress: (listener: (payload: z.output<typeof events.restoreProgress.payload>) => void) => () => void;
  };
  readonly settings: {
    readonly get: () => Promise<Res<typeof channels.settingsGet>>;
    readonly set: (request: Req<typeof channels.settingsSet>) => Promise<Res<typeof channels.settingsSet>>;
    readonly onChanged: (listener: (payload: z.output<typeof events.settingsChanged.payload>) => void) => () => void;
  };
  readonly embedding: {
    readonly status: () => Promise<Res<typeof channels.embeddingStatus>>;
    readonly enable: () => Promise<Res<typeof channels.embeddingEnable>>;
    readonly disable: () => Promise<Res<typeof channels.embeddingDisable>>;
    readonly pause: () => Promise<Res<typeof channels.embeddingPause>>;
    readonly resume: () => Promise<Res<typeof channels.embeddingResume>>;
    readonly onChanged: (listener: (payload: z.output<typeof events.embeddingStatusChanged.payload>) => void) => () => void;
  };
  readonly diagnostics: {
    readonly list: () => Promise<Res<typeof channels.diagnosticsList>>;
    readonly delete: (request: Req<typeof channels.diagnosticsDelete>) => Promise<Res<typeof channels.diagnosticsDelete>>;
    readonly purge: () => Promise<Res<typeof channels.diagnosticsPurge>>;
    readonly export: (request: Req<typeof channels.diagnosticsExport>) => Promise<Res<typeof channels.diagnosticsExport>>;
  };
  // Opt-in LLM assistant provider custody (ADR-0018 §7, #393). estimate/ask/spend
  // and the llm:inflight subscriber arrive with the Q&A slice.
  readonly llm: {
    readonly providers: () => Promise<Res<typeof llmChannels.llmProviders>>;
    readonly connect: (request: Req<typeof llmChannels.llmConnect>) => Promise<Res<typeof llmChannels.llmConnect>>;
    readonly disconnect: (request: Req<typeof llmChannels.llmDisconnect>) => Promise<Res<typeof llmChannels.llmDisconnect>>;
  };
  readonly libraries: {
    readonly list: () => Promise<Res<typeof channels.libraryRegistryList>>;
    readonly create: (request: Req<typeof channels.libraryRegistryCreate>) => Promise<Res<typeof channels.libraryRegistryCreate>>;
    readonly open: (request: Req<typeof channels.libraryRegistryOpen>) => Promise<Res<typeof channels.libraryRegistryOpen>>;
    readonly remove: (request: Req<typeof channels.libraryRegistryRemove>) => Promise<Res<typeof channels.libraryRegistryRemove>>;
    readonly current: () => Promise<Res<typeof channels.libraryRegistryCurrent>>;
    readonly add: (request: Req<typeof channels.libraryRegistryAdd>) => Promise<Res<typeof channels.libraryRegistryAdd>>;
    readonly pickLocation: () => Promise<Res<typeof channels.libraryRegistryPickLocation>>;
    // Relocation (#483, ADR-0022)
    readonly move: (request: Req<typeof channels.libraryRelocationMove>) => Promise<Res<typeof channels.libraryRelocationMove>>;
    readonly renameFolder: (request: Req<typeof channels.libraryRelocationRename>) => Promise<Res<typeof channels.libraryRelocationRename>>;
    readonly probeMove: (
      request: Req<typeof channels.libraryRelocationPreflight>,
    ) => Promise<Res<typeof channels.libraryRelocationPreflight>>;
    readonly cancelMove: (request: Req<typeof channels.libraryRelocationCancel>) => Promise<Res<typeof channels.libraryRelocationCancel>>;
    readonly resumeMove: (request: Req<typeof channels.libraryRelocationResume>) => Promise<Res<typeof channels.libraryRelocationResume>>;
    readonly discardMove: (
      request: Req<typeof channels.libraryRelocationDiscard>,
    ) => Promise<Res<typeof channels.libraryRelocationDiscard>>;
    readonly finishMoveCleanup: (
      request: Req<typeof channels.libraryRelocationFinishCleanup>,
    ) => Promise<Res<typeof channels.libraryRelocationFinishCleanup>>;
    readonly pendingMoves: () => Promise<Res<typeof channels.libraryRelocationPending>>;
    readonly onMoveProgress: (listener: (payload: z.output<typeof events.relocationProgress.payload>) => void) => () => void;
  };
  readonly import: {
    readonly listSources: () => Promise<Res<typeof channels.importListSources>>;
    readonly scanSource: (request: Req<typeof channels.importScanSource>) => Promise<Res<typeof channels.importScanSource>>;
    readonly pickFolder: () => Promise<Res<typeof channels.importPickFolder>>;
    readonly scanFiles: (request: Req<typeof channels.importScanFiles>) => Promise<Res<typeof channels.importScanFiles>>;
    readonly pickGoogleDrive: () => Promise<Res<typeof channels.importGoogleDrivePick>>;
    readonly cancelGoogleDrivePick: () => Promise<Res<typeof channels.importGoogleDriveCancelPick>>;
    readonly runGoogleDrive: (request: Req<typeof channels.importGoogleDriveRun>) => Promise<Res<typeof channels.importGoogleDriveRun>>;
    readonly discardGoogleDrive: (
      request: Req<typeof channels.importGoogleDriveDiscard>,
    ) => Promise<Res<typeof channels.importGoogleDriveDiscard>>;
    readonly externalReady: () => Promise<void>;
    readonly onExternalPaths: (listener: (payload: z.output<typeof events.importExternalPaths.payload>) => void) => () => void;
    /** Sandboxed renderers can't read File.path — the preload maps a
     * DataTransfer File to its filesystem path (webUtils) for drops (#237). */
    readonly pathForFile: (file: File) => string;
    readonly run: (request: Req<typeof channels.importRun>) => Promise<Res<typeof channels.importRun>>;
    readonly cancel: (request: Req<typeof channels.importCancel>) => Promise<Res<typeof channels.importCancel>>;
    readonly onScanProgress: (listener: (payload: z.output<typeof events.scanProgress.payload>) => void) => () => void;
    readonly onCopyProgress: (listener: (payload: z.output<typeof events.importCopyProgress.payload>) => void) => () => void;
    readonly onThumbProgress: (listener: (payload: z.output<typeof events.importThumbProgress.payload>) => void) => () => void;
  };
}
