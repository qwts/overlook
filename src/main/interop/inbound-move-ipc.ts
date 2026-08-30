import { ipcMain } from 'electron';

import { channels } from '../../shared/ipc/channels.js';
import { wrapHandler } from '../../shared/ipc/registry.js';
import type { InboundMoveController } from './inbound-move-controller.js';
import { liveLocalRuntimeState } from './live-local-state.js';

export function registerInboundMoveHandlers(getController: () => InboundMoveController, requireContentAccess: () => void): void {
  const admit = <T>(operation: () => T): T => {
    requireContentAccess();
    return operation();
  };
  ipcMain.handle(channels.interopStatus.name, (_event, request: unknown) =>
    wrapHandler(channels.interopStatus, () => admit(() => getController().status()))(request),
  );
  ipcMain.handle(channels.interopLocalStatus.name, (_event, request: unknown) =>
    wrapHandler(channels.interopLocalStatus, () => admit(() => liveLocalRuntimeState()))(request),
  );
  ipcMain.handle(channels.interopProviderConnect.name, (_event, request: unknown) =>
    wrapHandler(channels.interopProviderConnect, () => admit(() => getController().connectProvider()))(request),
  );
  ipcMain.handle(channels.interopProviderDisconnect.name, (_event, request: unknown) =>
    wrapHandler(channels.interopProviderDisconnect, () => admit(() => getController().disconnectProvider()))(request),
  );
  ipcMain.handle(channels.interopPairingSelect.name, (_event, request: unknown) =>
    wrapHandler(channels.interopPairingSelect, () => admit(() => getController().selectPairing()))(request),
  );
  ipcMain.handle(channels.interopPairingUnlock.name, (_event, request: unknown) =>
    wrapHandler(channels.interopPairingUnlock, ({ password }) => admit(() => getController().unlockPairing(password)))(request),
  );
  ipcMain.handle(channels.interopRefresh.name, (_event, request: unknown) =>
    wrapHandler(channels.interopRefresh, () => admit(() => getController().refresh()))(request),
  );
  ipcMain.handle(channels.interopStart.name, (_event, request: unknown) =>
    wrapHandler(channels.interopStart, ({ transferId }) => admit(() => getController().start(transferId)))(request),
  );
  ipcMain.handle(channels.interopPause.name, (_event, request: unknown) =>
    wrapHandler(channels.interopPause, () => admit(() => getController().pause()))(request),
  );
  ipcMain.handle(channels.interopResume.name, (_event, request: unknown) =>
    wrapHandler(channels.interopResume, () => admit(() => getController().resume()))(request),
  );
  ipcMain.handle(channels.interopCancel.name, (_event, request: unknown) =>
    wrapHandler(channels.interopCancel, () => admit(() => getController().cancel()))(request),
  );
  ipcMain.handle(channels.interopRetry.name, (_event, request: unknown) =>
    wrapHandler(channels.interopRetry, () => admit(() => getController().retry()))(request),
  );
}
