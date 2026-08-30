import type { SafeStorageLike } from '../crypto/keystore.js';
import { FilesystemInteropObjectStore } from './filesystem-object-store.js';
import { InteropPairingBundleStore, InteropPairingCustodian } from './pairing-custody.js';
import { InteropPCloudRuntime } from './pcloud-runtime.js';
import { LiveLocalError, type LiveLocalBootstrapRequest, type LiveLocalBootstrapState } from './live-local-security.js';

export interface InteropRuntimeOptions {
  readonly profileDirectory: string;
  readonly safeStorage: SafeStorageLike;
  readonly openExternal: (url: string) => Promise<void>;
  readonly pcloudClientId: string;
  readonly pcloudFixtureRoot?: string | undefined;
}

/** Profile-scoped interoperability authority. Library runtimes borrow its
 * custody but cannot replace provider credentials or retain pairing keys. */
export class InteropRuntime {
  readonly pairing: InteropPairingCustodian;
  readonly pcloud: InteropPCloudRuntime;
  #workCount = 0;

  constructor(options: InteropRuntimeOptions, pairing = configureInteropPairing(options.profileDirectory)) {
    this.pairing = pairing;
    this.pcloud = new InteropPCloudRuntime({
      ...options,
      clientId: options.pcloudClientId,
      pairing: this.pairing,
      isWorkActive: () => this.#workCount > 0,
      ...(options.pcloudFixtureRoot === undefined || options.pcloudFixtureRoot === ''
        ? {}
        : { objectStore: new FilesystemInteropObjectStore(options.pcloudFixtureRoot) }),
    });
  }

  busy(): boolean {
    return this.#workCount > 0 || this.pcloud.busy();
  }

  workChanged(delta: 1 | -1): void {
    const next = this.#workCount + delta;
    if (next < 0) throw new Error('Interoperability work counter underflow.');
    this.#workCount = next;
  }

  lock(): void {
    this.pairing.lock();
  }
}

let profileRuntime: InteropRuntime | undefined;
let profilePairing: InteropPairingCustodian | undefined;

export function configureInteropPairing(profileDirectory: string): InteropPairingCustodian {
  profilePairing ??= new InteropPairingCustodian(new InteropPairingBundleStore(profileDirectory));
  return profilePairing;
}

export function configureInteropRuntime(
  profileDirectory: string,
  safeStorage: SafeStorageLike,
  openExternal: (url: string) => Promise<void>,
  pcloudClientId: string,
  pcloudFixtureRoot?: string,
): InteropRuntime {
  profileRuntime ??= new InteropRuntime({ profileDirectory, safeStorage, openExternal, pcloudClientId, pcloudFixtureRoot });
  return profileRuntime;
}

export function getInteropRuntime(): InteropRuntime {
  if (profileRuntime === undefined) throw new Error('Interoperability runtime is not configured.');
  return profileRuntime;
}

export function getInteropPairing(): InteropPairingCustodian {
  if (profilePairing === undefined) throw new Error('Interoperability pairing is not configured.');
  return profilePairing;
}

export function interopRuntimeBusy(): boolean {
  return profileRuntime?.busy() === true;
}

export function lockInteropRuntime(): void {
  profileRuntime?.lock();
  if (profileRuntime === undefined) profilePairing?.lock();
}

export function liveLocalBootstrapState(request: LiveLocalBootstrapRequest): LiveLocalBootstrapState {
  const state = profilePairing?.state();
  if (state?.status !== 'unlocked') return 'locked';
  if (state.pairingId !== request.pairingId) throw new LiveLocalError('Live local bootstrap pairing did not match.', 'wrong-authority');
  return 'running';
}
