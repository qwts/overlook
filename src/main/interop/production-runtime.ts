import { LiveLocalBridge, type LiveLocalBridgeOptions } from './live-local-bridge.js';
import { registerICloudNativeHost, type NativeHostRegistrationOptions } from './icloud-native-registration.js';
import { configurePCloudInteropFeature, type PCloudInteropFeatureOptions } from './feature-runtime.js';
import { configureInteropPairing, liveLocalBootstrapState } from './runtime.js';
import { configureProductionInboundMove, createProductionLiveLocalOperation } from './inbound-move-production.js';
import { LiveLocalJournalSessionHandler } from './live-local-journal-session.js';
import { setLiveLocalRuntimeState } from './live-local-state.js';
import { events } from '../../shared/ipc/channels.js';
import { broadcast } from '../app-window.js';

export interface ProductionInteropOptions {
  readonly pcloud: PCloudInteropFeatureOptions;
  readonly nativeHost: NativeHostRegistrationOptions;
  readonly liveLocal: Omit<LiveLocalBridgeOptions, 'bootstrapState'> & { readonly enabled: boolean };
}

export interface StartedProductionInterop {
  lock(): Promise<void>;
  unlock(): void;
  close(): Promise<void>;
}

export async function startProductionInterop(options: ProductionInteropOptions): Promise<StartedProductionInterop> {
  configureInteropPairing(options.liveLocal.profileDirectory);
  configureProductionInboundMove(options.pcloud.library, options.pcloud.imports, options.pcloud.pairingFixture, options.pcloud.imported);
  configurePCloudInteropFeature(options.pcloud);
  await registerICloudNativeHost(options.nativeHost);
  const { enabled, ...liveLocal } = options.liveLocal;
  const publish = (state: Parameters<typeof setLiveLocalRuntimeState>[0]) => {
    const parsed = setLiveLocalRuntimeState(state);
    broadcast((window) => window.webContents.send(events.interopLocalStatusChanged.name, parsed));
  };
  const journalSessions = new LiveLocalJournalSessionHandler({
    createOperation: ({ open, redemption, store }) => createProductionLiveLocalOperation(store, redemption.operation, open.operationId),
    stateChanged: publish,
  });
  const bridge = enabled
    ? new LiveLocalBridge({
        ...liveLocal,
        bootstrapState: liveLocalBootstrapState,
        onSession: (session) => journalSessions.handle(session),
        availabilityChanged: (status) => publish({ status, operation: null, operationId: null, remoteSessionId: null, retryable: true }),
      })
    : null;
  await bridge?.start();
  return {
    lock: () => bridge?.lock() ?? Promise.resolve(),
    unlock: () => bridge?.unlock(),
    close: () => bridge?.close() ?? Promise.resolve(),
  };
}
