import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { ICloudDriveAuthorityStore } from '../backup/icloud-drive/authority-store.js';
import type { ICloudDriveNativeBridge, ICloudDriveNativeStatus } from '../backup/icloud-drive/native-bridge.js';
import type { SafeStorageLike } from '../crypto/keystore.js';
import { BridgeICloudNativeAuthority } from './icloud-native-authority.js';
import { ICloudNativeHost } from './icloud-native-host.js';
import { assertAuthorizedNativeHostInvocation, type NativeHostInvocation } from './icloud-native-registration.js';
import { runNativeMessage } from './native-messaging.js';

export interface RunICloudNativeHostOptions {
  readonly invocation: NativeHostInvocation;
  readonly extensionId: string | null;
  readonly platform: NodeJS.Platform;
  readonly packaged: boolean;
  readonly profileDirectory: string;
  readonly safeStorage: SafeStorageLike;
  readonly bridge: ICloudDriveNativeBridge;
  readonly input: Readable;
  readonly output: Writable;
}

function hostAvailability(status: ICloudDriveNativeStatus): { readonly entitled: boolean; readonly available: boolean } {
  return {
    entitled: status.reason !== 'unentitled',
    available: status.available,
  };
}

/** Executes one sendNativeMessage request and exits after the bridge drains.
 * The ordinary desktop composition root is never started in this mode. */
export async function runICloudNativeHost(options: RunICloudNativeHostOptions): Promise<void> {
  const authority = new BridgeICloudNativeAuthority({
    bridge: options.bridge,
    accountAuthority: new ICloudDriveAuthorityStore(
      options.safeStorage,
      join(options.profileDirectory, 'interop', 'provider-auth', 'icloud-drive'),
    ),
    stagingDirectory: join(options.profileDirectory, 'interop', 'native-staging'),
  });
  try {
    await runNativeMessage(options.input, options.output, async (value) => {
      assertAuthorizedNativeHostInvocation(options.invocation);
      const availability = await options.bridge
        .status()
        .then(hostAvailability)
        .catch(() => ({ entitled: false, available: false }));
      const host = new ICloudNativeHost({
        expectedExtensionId: options.extensionId ?? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        platform: options.platform,
        signed: options.packaged,
        entitled: availability.entitled,
        iCloudAvailable: availability.available,
        authority,
      });
      return host.handle(value);
    });
  } finally {
    await options.bridge.drain();
  }
}
