import path from 'node:path';

import { app, shell } from 'electron';

import { ProviderRuntime } from './provider-runtime.js';
import { createProviderSwitchGuard } from './provider-switch-binding.js';
import type { LibraryParts } from '../library/library-parts.js';
import { pickSafeStorage } from '../crypto/safe-storage-runtime.js';
import { getSettingsStore } from '../settings/settings-runtime.js';
import { createNativeICloudDriveBridge } from './icloud-drive/native-bridge.js';
import { DeterministicICloudDriveBridge } from './icloud-drive/deterministic-bridge.js';
import { pcloudFeatureConfig } from '../build-config.js';
import type { CustodyCredential, CustodyPreflight, CustodyRequirement } from '../../shared/backup/provider-descriptor.js';
import { createCustodyPolicyRuntime } from './custody-policy-runtime.js';
import { custodyHintPreflight } from './custody-gate.js';
import type { LibraryRegistryRuntime } from '../library/library-registry-runtime.js';
import type { CustodyReconnectResult } from './custody-reconnect.js';
import type { ProviderAccountIdentity, StorageProvider } from './provider.js';
import { refreshCustodyHints } from './custody-routing-runtime.js';

// ProviderRuntime wiring (#256), extracted from the composition root.
// Provider credentials are profile-level (they survive library replacement
// and switches); the library dataDir is a live thunk so the runtime follows
// the active library (#384/#385).

export interface ProviderRuntimeFactoryDeps {
  readonly dataDir: () => string;
  readonly isWorkActive: () => boolean;
  readonly harnessEnv: (name: string) => string | undefined;
  /** The ALREADY-OPEN library's parts for the fail-closed switch guard
   * (#741), or null when none is open. Must never bootstrap a library —
   * a fresh onboarding-restore profile stays empty (PR #743 review). */
  readonly guardParts?: (() => LibraryParts | null) | undefined;
  readonly libraryRegistry?: Pick<LibraryRegistryRuntime, 'resolveActive' | 'getRegistry'> | undefined;
  readonly custodyPreflight?: ((credential: CustodyCredential) => CustodyPreflight) | undefined;
  readonly markProviderRequired?: ((credential: CustodyCredential) => (() => void) | void) | undefined;
  readonly deleteUnreferencedAuthorities?: ((credential: CustodyCredential) => void) | undefined;
  readonly providerRequirements?: (() => readonly CustodyRequirement[]) | undefined;
  readonly pauseCustodyReconnectProofs?: (() => Promise<() => void>) | undefined;
  readonly verifyCustodyReconnect?:
    | ((input: {
        readonly provider: StorageProvider;
        readonly identity: ProviderAccountIdentity;
        readonly signal?: AbortSignal;
      }) => Promise<CustodyReconnectResult>)
    | undefined;
}

export function createProviderRuntime(deps: ProviderRuntimeFactoryDeps): ProviderRuntime {
  const providerForOpenLibrary = (provider: StorageProvider): StorageProvider => {
    const parts = deps.guardParts?.();
    const registry = deps.libraryRegistry;
    if (parts === null || parts === undefined || registry === undefined) return provider;
    return provider.forLibrary(registry.resolveActive().id);
  };
  const custodyPolicy = () => {
    const parts = deps.guardParts?.();
    const registry = deps.libraryRegistry;
    if (parts === null || parts === undefined || registry === undefined) return null;
    return createCustodyPolicyRuntime({
      db: parts.db,
      activeLibrary: () => registry.resolveActive(),
      libraries: () => registry.getRegistry().list(),
      libraryId: () => registry.resolveActive().id,
      masterKey: () => parts.keyStore.masterKeyBytes(),
      custodyChanged: () => refreshCustodyHints(parts.db, registry),
    });
  };
  const custodyPreflight = (credential: CustodyCredential): CustodyPreflight => {
    const policy = custodyPolicy();
    if (policy !== null) return policy.preflight(credential);
    const libraries = deps.libraryRegistry?.getRegistry().list() ?? [];
    return custodyHintPreflight(credential, libraries);
  };
  const pcloud = pcloudFeatureConfig(deps.harnessEnv);
  const iCloudDriveBridge =
    deps.harnessEnv('OVERLOOK_ICLOUD_FAKE') === '1'
      ? new DeterministicICloudDriveBridge()
      : createNativeICloudDriveBridge({ platform: process.platform, packaged: app.isPackaged });
  return new ProviderRuntime({
    dataDir: deps.dataDir,
    providerCredentialDir: (providerId) => path.join(app.getPath('userData'), 'provider-auth', providerId),
    safeStorage: pickSafeStorage,
    openExternal: async (url) => shell.openExternal(url),
    setProviderId: (id) => getSettingsStore().set({ providerId: id }),
    providerId: () => getSettingsStore().get().providerId,
    isWorkActive: deps.isWorkActive,
    isPackaged: app.isPackaged,
    harnessEnv: deps.harnessEnv,
    googleDriveClientId: () => deps.harnessEnv('OVERLOOK_GOOGLE_DRIVE_CLIENT_ID') ?? null,
    pcloudEnabled: pcloud.enabled,
    pcloudClientId: () => pcloud.clientId,
    storageTimeoutMs: storageTimeout(deps.harnessEnv('OVERLOOK_PROVIDER_STORAGE_TIMEOUT_MS')),
    iCloudDriveBridge,
    scopeProviderForOpenLibrary: providerForOpenLibrary,
    switchGuard:
      deps.guardParts === undefined ? undefined : createProviderSwitchGuard({ parts: deps.guardParts, libraryDataDir: deps.dataDir }),
    custodyPreflight: deps.custodyPreflight ?? custodyPreflight,
    markProviderRequired: deps.markProviderRequired ?? ((credential) => custodyPolicy()?.markProviderRequired(credential)),
    deleteUnreferencedAuthorities: deps.deleteUnreferencedAuthorities ?? ((credential) => custodyPolicy()?.deleteUnreferenced(credential)),
    providerRequirements: deps.providerRequirements ?? (() => custodyPolicy()?.requirements() ?? []),
    pauseCustodyReconnectProofs: deps.pauseCustodyReconnectProofs,
    verifyCustodyReconnect:
      deps.verifyCustodyReconnect ??
      (async (input) => {
        const policy = custodyPolicy();
        return policy === null ? { ok: true } : policy.verifyReconnect(input);
      }),
  });
}

function storageTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const milliseconds = Number(value);
  return Number.isInteger(milliseconds) && milliseconds >= 10 && milliseconds <= 30_000 ? milliseconds : undefined;
}
