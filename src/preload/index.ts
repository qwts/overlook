import { contextBridge, ipcRenderer, webUtils } from 'electron';

import type { OverlookApi } from '../shared/ipc/api.js';
import { channels, events } from '../shared/ipc/channels.js';
import { llmChannels } from '../shared/ipc/llm-channels.js';
import { createInvoker, createSubscriber, type SubscribeTransport } from '../shared/ipc/registry.js';

// contextBridge is the only thing that belongs in this process. The renderer
// never sees ipcRenderer — only the typed, schema-validated surface below.

const invokeTransport = (channelName: string, request: unknown): Promise<unknown> => ipcRenderer.invoke(channelName, request);

const subscribeTransport: SubscribeTransport = (eventName, listener) => {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
    listener(payload);
  };
  ipcRenderer.on(eventName, wrapped);
  return () => {
    ipcRenderer.removeListener(eventName, wrapped);
  };
};

const getPlatform = createInvoker(channels.getPlatform, invokeTransport);
const getLocale = createInvoker(channels.getLocale, invokeTransport);
const minimizeWindow = createInvoker(channels.windowMinimize, invokeTransport);
const toggleMaximizeWindow = createInvoker(channels.windowToggleMaximize, invokeTransport);
const closeWindow = createInvoker(channels.windowClose, invokeTransport);
const inspectorWindowOpen = createInvoker(channels.inspectorWindowOpen, invokeTransport);
const inspectorWindowUpdate = createInvoker(channels.inspectorWindowUpdate, invokeTransport);
const inspectorWindowClose = createInvoker(channels.inspectorWindowClose, invokeTransport);
const inspectorWindowStep = createInvoker(channels.inspectorWindowStep, invokeTransport);
const inspectorWindowSnapshot = createInvoker(channels.inspectorWindowSnapshot, invokeTransport);
const commandRendererReady = createInvoker(channels.commandRendererReady, invokeTransport);
const commandContextUpdate = createInvoker(channels.commandContextUpdate, invokeTransport);
const helpOpen = createInvoker(channels.helpOpen, invokeTransport);

const libraryStats = createInvoker(channels.libraryStats, invokeTransport);
const settingsGet = createInvoker(channels.settingsGet, invokeTransport);
const embeddingStatus = createInvoker(channels.embeddingStatus, invokeTransport);
const embeddingEnable = createInvoker(channels.embeddingEnable, invokeTransport);
const embeddingDisable = createInvoker(channels.embeddingDisable, invokeTransport);
const embeddingPause = createInvoker(channels.embeddingPause, invokeTransport);
const embeddingResume = createInvoker(channels.embeddingResume, invokeTransport);
const diagnosticsList = createInvoker(channels.diagnosticsList, invokeTransport);
const diagnosticsPurge = createInvoker(channels.diagnosticsPurge, invokeTransport);
const llmProviders = createInvoker(llmChannels.llmProviders, invokeTransport);
const libraryRegistryList = createInvoker(channels.libraryRegistryList, invokeTransport);
const libraryRegistryCurrent = createInvoker(channels.libraryRegistryCurrent, invokeTransport);
const libraryRegistryPickLocation = createInvoker(channels.libraryRegistryPickLocation, invokeTransport);
const libraryRelocationPending = createInvoker(channels.libraryRelocationPending, invokeTransport);
const backupProviders = createInvoker(channels.backupProviders, invokeTransport);
const backupProviderStatus = createInvoker(channels.backupProviderStatus, invokeTransport);
const backupProviderStorage = createInvoker(channels.backupProviderStorage, invokeTransport);
const backupConnect = createInvoker(channels.backupConnect, invokeTransport);
const backupDisconnect = createInvoker(channels.backupDisconnect, invokeTransport);
const backupOpenCapacitySettings = createInvoker(channels.backupOpenCapacitySettings, invokeTransport);
const libraryAlbums = createInvoker(channels.libraryAlbums, invokeTransport);
const boardList = createInvoker(channels.boardList, invokeTransport);
const historyStatus = createInvoker(channels.historyStatus, invokeTransport);
const protectedAlbumsList = createInvoker(channels.protectedAlbumsList, invokeTransport);
const protectedAlbumPickRecovery = createInvoker(channels.protectedAlbumPickRecovery, invokeTransport);
const protectedAlbumCancelWorkflow = createInvoker(channels.protectedAlbumCancelWorkflow, invokeTransport);
const protectedAlbumExportPickDestination = createInvoker(channels.protectedAlbumExportPickDestination, invokeTransport);
const protectedAlbumExportCancel = createInvoker(channels.protectedAlbumExportCancel, invokeTransport);
const importListSources = createInvoker(channels.importListSources, invokeTransport);
const importPickFolder = createInvoker(channels.importPickFolder, invokeTransport);
const importGoogleDrivePick = createInvoker(channels.importGoogleDrivePick, invokeTransport);
const importGoogleDriveCancelPick = createInvoker(channels.importGoogleDriveCancelPick, invokeTransport);
const importExternalReady = createInvoker(channels.importExternalReady, invokeTransport);
const keysStatus = createInvoker(channels.keysStatus, invokeTransport);
const keysPickFile = createInvoker(channels.keysPickFile, invokeTransport);
const restoreProfileStatus = createInvoker(channels.restoreProfileStatus, invokeTransport);
const restorePickKey = createInvoker(channels.restorePickKey, invokeTransport);
const appLockStatus = createInvoker(channels.appLockStatus, invokeTransport);
const appLockNow = createInvoker(channels.appLockNow, invokeTransport);
const appLockPickRecovery = createInvoker(channels.appLockPickRecovery, invokeTransport);
const appLockTouchIdStatus = createInvoker(channels.appLockTouchIdStatus, invokeTransport);
const appLockTouchIdDisable = createInvoker(channels.appLockTouchIdDisable, invokeTransport);
const appLockTouchIdUnlock = createInvoker(channels.appLockTouchIdUnlock, invokeTransport);
const interopStatus = createInvoker(channels.interopStatus, invokeTransport);
const interopPairingSelect = createInvoker(channels.interopPairingSelect, invokeTransport);
const interopRefresh = createInvoker(channels.interopRefresh, invokeTransport);
const interopPause = createInvoker(channels.interopPause, invokeTransport);
const interopResume = createInvoker(channels.interopResume, invokeTransport);
const interopCancel = createInvoker(channels.interopCancel, invokeTransport);
const interopRetry = createInvoker(channels.interopRetry, invokeTransport);

const overlook: OverlookApi = {
  ping: createInvoker(channels.ping, invokeTransport),
  onFocusChanged: createSubscriber(events.focusChanged, subscribeTransport),
  commands: Object.freeze({
    ready: async (context) => {
      await commandRendererReady(context);
    },
    updateContext: async (context) => {
      await commandContextUpdate(context);
    },
    onInvoked: createSubscriber(events.commandInvoked, subscribeTransport),
  }),
  help: Object.freeze({
    open: async () => {
      await helpOpen({});
    },
  }),
  inspectorWindow: Object.freeze({
    open: async (request) => {
      await inspectorWindowOpen(request);
    },
    update: async (request) => {
      await inspectorWindowUpdate(request);
    },
    close: async () => {
      await inspectorWindowClose({});
    },
    step: async (delta) => {
      await inspectorWindowStep({ delta });
    },
    snapshot: async () => inspectorWindowSnapshot({}),
    onChanged: createSubscriber(events.inspectorWindowChanged, subscribeTransport),
    onClosed: (listener) => createSubscriber(events.inspectorWindowClosed, subscribeTransport)(listener),
    onStepRequested: (listener) =>
      createSubscriber(events.inspectorWindowStepRequested, subscribeTransport)(({ delta }) => listener(delta)),
  }),
  appLock: Object.freeze({
    status: async () => appLockStatus({}),
    unlock: createInvoker(channels.appLockUnlock, invokeTransport),
    configure: createInvoker(channels.appLockConfigure, invokeTransport),
    lockNow: async () => appLockNow({}),
    changePassword: createInvoker(channels.appLockChangePassword, invokeTransport),
    remove: createInvoker(channels.appLockRemove, invokeTransport),
    pickRecovery: async () => appLockPickRecovery({}),
    recover: createInvoker(channels.appLockRecover, invokeTransport),
    touchIdStatus: async () => appLockTouchIdStatus({}),
    touchIdEnable: createInvoker(channels.appLockTouchIdEnable, invokeTransport),
    touchIdDisable: async () => appLockTouchIdDisable({}),
    touchIdUnlock: async () => appLockTouchIdUnlock({}),
    onChanged: createSubscriber(events.appLockStateChanged, subscribeTransport),
    onTouchIdChanged: createSubscriber(events.appLockTouchIdChanged, subscribeTransport),
  }),
  interop: Object.freeze({
    status: async () => interopStatus({}),
    connectProvider: createInvoker(channels.interopProviderConnect, invokeTransport),
    disconnectProvider: createInvoker(channels.interopProviderDisconnect, invokeTransport),
    selectPairing: async () => interopPairingSelect({}),
    unlockPairing: createInvoker(channels.interopPairingUnlock, invokeTransport),
    refresh: async () => interopRefresh({}),
    start: createInvoker(channels.interopStart, invokeTransport),
    pause: async () => interopPause({}),
    resume: async () => interopResume({}),
    cancel: async () => interopCancel({}),
    retry: async () => interopRetry({}),
    onChanged: createSubscriber(events.interopStatusChanged, subscribeTransport),
  }),
  library: Object.freeze({
    page: createInvoker(channels.libraryPage, invokeTransport),
    get: createInvoker(channels.libraryGet, invokeTransport),
    repairDimensions: createInvoker(channels.libraryRepairDimensions, invokeTransport),
    toggleFavorite: createInvoker(channels.libraryToggleFavorite, invokeTransport),
    setOriginal: createInvoker(channels.librarySetOriginal, invokeTransport),
    counts: createInvoker(channels.libraryCounts, invokeTransport),
    stats: async () => libraryStats({}),
    albums: async () => libraryAlbums({}),
    delete: createInvoker(channels.libraryDelete, invokeTransport),
    restore: createInvoker(channels.libraryRestore, invokeTransport),
    purge: createInvoker(channels.libraryPurge, invokeTransport),
    originalDeletePreflight: createInvoker(channels.libraryOriginalDeletePreflight, invokeTransport),
    originalDeleteAuthorize: createInvoker(channels.libraryOriginalDeleteAuthorize, invokeTransport),
    originalDeleteCommit: createInvoker(channels.libraryOriginalDeleteCommit, invokeTransport),
    originalDeleteCancel: async (request) => {
      await createInvoker(channels.libraryOriginalDeleteCancel, invokeTransport)(request);
    },
    onChanged: createSubscriber(events.libraryChanged, subscribeTransport),
    onOriginalClassificationChanged: createSubscriber(events.originalClassificationChanged, subscribeTransport),
    onSyncStateChanged: createSubscriber(events.photoSyncStateChanged, subscribeTransport),
    onStorageChanged: createSubscriber(events.storageChanged, subscribeTransport),
    onPendingCountChanged: createSubscriber(events.pendingCountChanged, subscribeTransport),
  }),
  activity: Object.freeze({
    page: createInvoker(channels.activityPage, invokeTransport),
  }),
  history: Object.freeze({
    status: async () => historyStatus({}),
    undo: createInvoker(channels.historyUndo, invokeTransport),
    redo: createInvoker(channels.historyRedo, invokeTransport),
  }),
  albums: Object.freeze({
    create: createInvoker(channels.albumCreate, invokeTransport),
    rename: createInvoker(channels.albumRename, invokeTransport),
    delete: createInvoker(channels.albumDelete, invokeTransport),
    addPhotos: createInvoker(channels.albumAddPhotos, invokeTransport),
    removePhotos: createInvoker(channels.albumRemovePhotos, invokeTransport),
    movePhotos: createInvoker(channels.albumMovePhotos, invokeTransport),
    reorder: createInvoker(channels.albumReorder, invokeTransport),
  }),
  boards: Object.freeze({
    list: async () => boardList({}),
    get: createInvoker(channels.boardGet, invokeTransport),
    save: createInvoker(channels.boardSave, invokeTransport),
    delete: createInvoker(channels.boardDelete, invokeTransport),
    onReload: createSubscriber(events.boardsReload, subscribeTransport),
  }),
  protectedAlbums: Object.freeze({
    list: async () => protectedAlbumsList({}),
    protect: createInvoker(channels.protectedAlbumProtect, invokeTransport),
    unprotect: createInvoker(channels.protectedAlbumUnprotect, invokeTransport),
    changePassword: createInvoker(channels.protectedAlbumChangePassword, invokeTransport),
    pickRecovery: async () => protectedAlbumPickRecovery({}),
    recover: createInvoker(channels.protectedAlbumRecover, invokeTransport),
    cancelWorkflow: async () => protectedAlbumCancelWorkflow({}),
    unlock: createInvoker(channels.protectedAlbumUnlock, invokeTransport),
    relock: createInvoker(channels.protectedAlbumRelock, invokeTransport),
    summary: createInvoker(channels.protectedAlbumSummary, invokeTransport),
    page: createInvoker(channels.protectedAlbumPage, invokeTransport),
    get: createInvoker(channels.protectedAlbumGet, invokeTransport),
    toggleFavorite: createInvoker(channels.protectedAlbumToggleFavorite, invokeTransport),
    delete: createInvoker(channels.protectedAlbumDelete, invokeTransport),
    restore: createInvoker(channels.protectedAlbumRestore, invokeTransport),
    pickExportDestination: async () => protectedAlbumExportPickDestination({}),
    export: createInvoker(channels.protectedAlbumExportRun, invokeTransport),
    cancelExport: async () => protectedAlbumExportCancel({}),
    onChanged: createSubscriber(events.protectedAlbumsChanged, subscribeTransport),
    onProgress: createSubscriber(events.protectedWorkflowProgress, subscribeTransport),
  }),
  backup: Object.freeze({
    run: createInvoker(channels.backupRun, invokeTransport),
    onProgress: createSubscriber(events.backupProgress, subscribeTransport),
    onCompleted: createSubscriber(events.backupCompleted, subscribeTransport),
    offloadPreflight: createInvoker(channels.backupOffloadPreflight, invokeTransport),
    offload: createInvoker(channels.backupOffload, invokeTransport),
    rehydrate: createInvoker(channels.backupRehydrate, invokeTransport),
    keepDownloaded: createInvoker(channels.backupKeepDownloaded, invokeTransport),
    releaseEphemeral: createInvoker(channels.backupReleaseEphemeral, invokeTransport),
    ephemeralStatus: createInvoker(channels.backupEphemeralStatus, invokeTransport),
    prepareEphemeral: createInvoker(channels.backupPrepareEphemeral, invokeTransport),
    onEphemeralState: createSubscriber(events.ephemeralOriginalState, subscribeTransport),
    restoreOriginals: createInvoker(channels.backupRestoreOriginals, invokeTransport),
    providers: async () => backupProviders({}),
    providerStatus: backupProviderStatus,
    providerStorage: backupProviderStorage,
    connect: backupConnect,
    disconnect: backupDisconnect,
    openCapacitySettings: backupOpenCapacitySettings,
  }),
  export: Object.freeze({
    pickDestination: createInvoker(channels.exportPickDestination, invokeTransport),
    run: createInvoker(channels.exportRun, invokeTransport),
    cancel: createInvoker(channels.exportCancel, invokeTransport),
    onProgress: createSubscriber(events.exportProgress, subscribeTransport),
  }),
  keys: Object.freeze({
    status: async () => keysStatus({}),
    export: createInvoker(channels.keysExport, invokeTransport),
    pickFile: async () => keysPickFile({}),
    import: createInvoker(channels.keysImport, invokeTransport),
  }),
  restore: Object.freeze({
    profileStatus: async () => restoreProfileStatus({}),
    pickKey: async () => restorePickKey({}),
    discover: createInvoker(channels.restoreDiscover, invokeTransport),
    run: createInvoker(channels.restoreRun, invokeTransport),
    cancel: createInvoker(channels.restoreCancel, invokeTransport),
    onProgress: createSubscriber(events.restoreProgress, subscribeTransport),
  }),
  settings: Object.freeze({
    get: async () => settingsGet({}),
    set: createInvoker(channels.settingsSet, invokeTransport),
    onChanged: createSubscriber(events.settingsChanged, subscribeTransport),
  }),
  embedding: Object.freeze({
    status: async () => embeddingStatus({}),
    enable: async () => embeddingEnable({ consent: true }),
    disable: async () => embeddingDisable({}),
    pause: async () => embeddingPause({}),
    resume: async () => embeddingResume({}),
    onChanged: createSubscriber(events.embeddingStatusChanged, subscribeTransport),
  }),
  diagnostics: Object.freeze({
    list: async () => diagnosticsList({}),
    delete: createInvoker(channels.diagnosticsDelete, invokeTransport),
    purge: async () => diagnosticsPurge({}),
    export: createInvoker(channels.diagnosticsExport, invokeTransport),
  }),
  // Opt-in LLM assistant (ADR-0018 §7, #393): provider custody. Keys cross
  // inbound on connect and never come back out; the Q&A surface lands next.
  llm: Object.freeze({
    providers: async () => llmProviders({}),
    connect: createInvoker(llmChannels.llmConnect, invokeTransport),
    disconnect: createInvoker(llmChannels.llmDisconnect, invokeTransport),
  }),
  libraries: Object.freeze({
    list: async () => libraryRegistryList({}),
    create: createInvoker(channels.libraryRegistryCreate, invokeTransport),
    open: createInvoker(channels.libraryRegistryOpen, invokeTransport),
    remove: createInvoker(channels.libraryRegistryRemove, invokeTransport),
    current: async () => libraryRegistryCurrent({}),
    add: createInvoker(channels.libraryRegistryAdd, invokeTransport),
    pickLocation: async () => libraryRegistryPickLocation({}),
    // Relocation (#483, ADR-0022): move/cancel/cleanup + journal-backed
    // pending list for the resume banner; progress drives the wizard tracks.
    move: createInvoker(channels.libraryRelocationMove, invokeTransport),
    renameFolder: createInvoker(channels.libraryRelocationRename, invokeTransport),
    probeMove: createInvoker(channels.libraryRelocationPreflight, invokeTransport),
    cancelMove: createInvoker(channels.libraryRelocationCancel, invokeTransport),
    resumeMove: createInvoker(channels.libraryRelocationResume, invokeTransport),
    discardMove: createInvoker(channels.libraryRelocationDiscard, invokeTransport),
    finishMoveCleanup: createInvoker(channels.libraryRelocationFinishCleanup, invokeTransport),
    pendingMoves: async () => libraryRelocationPending({}),
    onMoveProgress: createSubscriber(events.relocationProgress, subscribeTransport),
  }),
  import: Object.freeze({
    listSources: async () => importListSources({}),
    scanSource: createInvoker(channels.importScanSource, invokeTransport),
    pickFolder: async () => importPickFolder({}),
    scanFiles: createInvoker(channels.importScanFiles, invokeTransport),
    pickGoogleDrive: async () => importGoogleDrivePick({}),
    cancelGoogleDrivePick: async () => importGoogleDriveCancelPick({}),
    runGoogleDrive: createInvoker(channels.importGoogleDriveRun, invokeTransport),
    discardGoogleDrive: createInvoker(channels.importGoogleDriveDiscard, invokeTransport),
    externalReady: async () => {
      await importExternalReady({});
    },
    onExternalPaths: createSubscriber(events.importExternalPaths, subscribeTransport),
    // The documented sandbox pattern for drag-and-drop paths: the renderer
    // hands the File across the bridge and webUtils resolves it here (#237).
    pathForFile: (file: File) => webUtils.getPathForFile(file),
    run: createInvoker(channels.importRun, invokeTransport),
    cancel: createInvoker(channels.importCancel, invokeTransport),
    onScanProgress: createSubscriber(events.scanProgress, subscribeTransport),
    onCopyProgress: createSubscriber(events.importCopyProgress, subscribeTransport),
    onThumbProgress: createSubscriber(events.importThumbProgress, subscribeTransport),
  }),
  getPlatform: async () => (await getPlatform({})).platform,
  getLocale: async () => (await getLocale({})).locale,
  minimizeWindow: async () => {
    await minimizeWindow({});
  },
  toggleMaximizeWindow: async () => (await toggleMaximizeWindow({})).maximized,
  closeWindow: async () => {
    await closeWindow({});
  },
};

contextBridge.exposeInMainWorld('overlook', Object.freeze(overlook));
