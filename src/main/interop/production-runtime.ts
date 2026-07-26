import { registerICloudNativeHost, type NativeHostRegistrationOptions } from './icloud-native-registration.js';
import { configurePCloudInteropFeature, type PCloudInteropFeatureOptions } from './feature-runtime.js';

export interface ProductionInteropOptions {
  readonly pcloud: PCloudInteropFeatureOptions;
  readonly nativeHost: NativeHostRegistrationOptions;
}

export async function startProductionInterop(options: ProductionInteropOptions): Promise<void> {
  configurePCloudInteropFeature(options.pcloud);
  await registerICloudNativeHost(options.nativeHost);
}
