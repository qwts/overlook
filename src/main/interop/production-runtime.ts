import { LiveLocalBridge, type LiveLocalBridgeOptions } from './live-local-bridge.js';
import { registerICloudNativeHost, type NativeHostRegistrationOptions } from './icloud-native-registration.js';
import { configurePCloudInteropFeature, type PCloudInteropFeatureOptions } from './feature-runtime.js';
import { configureInteropPairing, liveLocalBootstrapState } from './runtime.js';

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
  configurePCloudInteropFeature(options.pcloud);
  await registerICloudNativeHost(options.nativeHost);
  const { enabled, ...liveLocal } = options.liveLocal;
  const bridge = enabled ? new LiveLocalBridge({ ...liveLocal, bootstrapState: liveLocalBootstrapState }) : null;
  await bridge?.start();
  return {
    lock: () => bridge?.lock() ?? Promise.resolve(),
    unlock: () => bridge?.unlock(),
    close: () => bridge?.close() ?? Promise.resolve(),
  };
}
