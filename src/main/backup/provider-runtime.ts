import { join } from 'node:path';

import type { SafeStorageLike } from '../crypto/keystore.js';
import { readOrMintLibraryId } from '../library/library-id.js';
import { bundledGoogleDriveClientId, bundledGoogleDriveClientSecret } from '../build-config.js';
import { createActiveProvider } from './active-provider.js';
import { GoogleDriveAuthClient } from './google-drive/auth-client.js';
import { createGoogleDriveConnect } from './google-drive/connect.js';
import { GoogleDriveProvider } from './google-drive/google-drive-provider.js';
import { GoogleDrivePathStore } from './google-drive/path-store.js';
import { GoogleDriveTokenStore } from './google-drive/token-store.js';
import { FaultInjectingProvider, MockProvider, ProviderRegistry } from './mock-provider.js';
import { createPCloudConnect, type PCloudConnectResult } from './pcloud/connect.js';
import { PCloudProvider } from './pcloud/pcloud-provider.js';
import { PCloudTokenStore } from './pcloud/token-store.js';
import { ProviderError, raceWithAbort, type ProviderAccountIdentity, type StorageProvider } from './provider.js';
import type {
  CustodyCredential,
  CustodyPreflight,
  CustodyRequirement,
  ProviderCapacityStatus,
  ProviderConnectionStatus,
  ProviderDescriptor,
} from '../../shared/backup/provider-descriptor.js';
import { ICloudDriveProvider } from './icloud-drive/icloud-drive-provider.js';
import { ICloudDriveAuthorityStore } from './icloud-drive/authority-store.js';
import type { ICloudDriveNativeBridge, ICloudDriveUnavailableReason } from './icloud-drive/native-bridge.js';

// Provider-selection + pCloud-custody runtime (#256), extracted from the
// composition root: which provider is active, who Connect targets, the
// library's remote identity, and the pCloud token/handshake lifecycle. All
// Electron dependencies are injected so node:test covers the policy.

export interface ProviderRuntimeOptions {
  readonly dataDir: () => string;
  /** Profile-level provider credential custody; unlike library data this
   * directory survives atomic library replacement during restore. */
  readonly credentialDir?: (() => string) | undefined;
  /** Preferred multi-provider custody root. Existing callers may keep
   * credentialDir as the pCloud-specific compatibility seam. */
  readonly providerCredentialDir?: ((providerId: string) => string) | undefined;
  readonly safeStorage: () => SafeStorageLike;
  readonly openExternal: (url: string) => Promise<void>;
  readonly setProviderId: (id: string | null) => void;
  readonly providerId: () => string | null;
  readonly isWorkActive?: (() => boolean) | undefined;
  readonly isPackaged: boolean;
  readonly harnessEnv: (name: string) => string | undefined;
  readonly googleDriveClientId?: (() => string | null) | undefined;
  readonly googleDriveClientSecret?: (() => string | null) | undefined;
  readonly pcloudEnabled: boolean;
  readonly pcloudClientId: () => string | null;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly iCloudDriveBridge: ICloudDriveNativeBridge;
  /** Fail-closed activation check (#741): before settings.providerId moves
   * to a DIFFERENT provider, the target must prove it holds every
   * remote-only object the library claims (see provider-switch-guard.ts).
   * Absent in tests that exercise pure selection mechanics. */
  readonly switchGuard?: ((target: { providerId: string; provider: StorageProvider }) => Promise<PCloudConnectResult>) | undefined;
  readonly custodyPreflight?: ((credential: CustodyCredential) => CustodyPreflight) | undefined;
  readonly markProviderRequired?: ((credential: CustodyCredential) => (() => void) | void) | undefined;
  readonly deleteUnreferencedAuthorities?: ((credential: CustodyCredential) => void) | undefined;
  readonly providerRequirements?: (() => readonly CustodyRequirement[]) | undefined;
  /** Test seams; production probes connection for at most 5s and capacity for 30s. */
  readonly statusTimeoutMs?: number | undefined;
  readonly storageTimeoutMs?: number | undefined;
}

const DEFAULT_STATUS_TIMEOUT_MS = 5_000;
const DEFAULT_STORAGE_TIMEOUT_MS = 30_000;

type AccountIdentityAttempt =
  | {
      readonly ok: true;
      readonly identity: ProviderAccountIdentity;
      readonly requiresSwitchGuard: boolean;
    }
  | { readonly ok: false; readonly reauthenticate: boolean; readonly result: PCloudConnectResult };

export class ProviderRuntime {
  private readonly options: ProviderRuntimeOptions;
  private tokenStoreInstance: PCloudTokenStore | undefined;
  private connectFlow: (() => Promise<PCloudConnectResult>) | undefined;
  private googleTokenStoreInstance: GoogleDriveTokenStore | undefined;
  private googlePathStoreInstance: GoogleDrivePathStore | undefined;
  private googleAuthInstance: GoogleDriveAuthClient | undefined;
  private googleConnectFlow: (() => Promise<PCloudConnectResult>) | undefined;
  private googleProviderInstance: GoogleDriveProvider | undefined;
  private iCloudAuthorityStoreInstance: ICloudDriveAuthorityStore | undefined;
  private iCloudDriveProviderInstance: ICloudDriveProvider | undefined;
  private registryInstance: ProviderRegistry | undefined;
  private readonly disconnectInFlight = new Map<string, Promise<PCloudConnectResult>>();
  private readonly storageInFlight = new Map<
    string,
    { readonly controller: AbortController; readonly promise: Promise<ProviderCapacityStatus> }
  >();

  constructor(options: ProviderRuntimeOptions) {
    this.options = options;
  }

  tokenStore(): PCloudTokenStore {
    if (this.tokenStoreInstance === undefined) {
      const safeStorage = this.options.safeStorage();
      const credentialDir = this.credentialDirectory('pcloud');
      this.tokenStoreInstance = new PCloudTokenStore({ safeStorage, dataDir: credentialDir });
      if (credentialDir !== this.options.dataDir() && this.tokenStoreInstance.load() === null) {
        const legacy = new PCloudTokenStore({ safeStorage, dataDir: this.options.dataDir() });
        const record = legacy.load();
        if (record !== null) {
          this.tokenStoreInstance.save(record);
          legacy.clear();
        }
      }
    }
    return this.tokenStoreInstance;
  }

  googleTokenStore(): GoogleDriveTokenStore {
    this.googleTokenStoreInstance ??= new GoogleDriveTokenStore({
      safeStorage: this.options.safeStorage(),
      dataDir: this.credentialDirectory('google-drive'),
    });
    return this.googleTokenStoreInstance;
  }

  private googlePathStore(): GoogleDrivePathStore {
    this.googlePathStoreInstance ??= new GoogleDrivePathStore(this.credentialDirectory('google-drive'));
    return this.googlePathStoreInstance;
  }

  private iCloudAuthorityStore(): ICloudDriveAuthorityStore {
    this.iCloudAuthorityStoreInstance ??= new ICloudDriveAuthorityStore(
      this.options.safeStorage(),
      this.credentialDirectory('icloud-drive'),
    );
    return this.iCloudAuthorityStoreInstance;
  }

  private googleAuth(): GoogleDriveAuthClient {
    this.googleAuthInstance ??= new GoogleDriveAuthClient({
      clientId: () => this.googleClientId(),
      clientSecret: () => this.googleClientSecret(),
      tokenStore: this.googleTokenStore(),
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
    });
    return this.googleAuthInstance;
  }

  private credentialDirectory(providerId: string): string {
    if (this.options.providerCredentialDir !== undefined) return this.options.providerCredentialDir(providerId);
    if (providerId === 'pcloud' && this.options.credentialDir !== undefined) return this.options.credentialDir();
    return join(this.options.dataDir(), `${providerId}-auth`);
  }

  private googleClientId(): string | null {
    const value = (this.options.googleDriveClientId?.() ?? bundledGoogleDriveClientId())?.trim() ?? '';
    return value.endsWith('.apps.googleusercontent.com') ? value : null;
  }

  private googleClientSecret(): string | null {
    const value = (this.options.googleDriveClientSecret?.() ?? bundledGoogleDriveClientSecret())?.trim() ?? '';
    return value === '' ? null : value;
  }

  private async connectPCloud(): Promise<PCloudConnectResult> {
    const clientId = this.pcloudClientId();
    if (!this.pcloudAvailable() || clientId === null) {
      return { ok: false, reason: 'pCloud is not enabled in this build.' };
    }
    // Activation (guarded, #741) runs after the token seals: a refused
    // switch keeps the fresh credential without moving the selection.
    this.connectFlow ??= createPCloudConnect({
      tokenStore: this.tokenStore(),
      clientId,
      openExternal: this.options.openExternal,
      onConnected: () => undefined,
    });
    const result = await this.connectFlow();
    if (!result.ok) return result;
    const provider = this.provider('pcloud');
    if (provider === undefined) return identityUnavailable('pCloud');
    const identity = await this.establishAccountIdentity('pcloud', provider);
    if (!identity.ok) return identity.result;
    return this.activate('pcloud', provider, identity);
  }

  private async connectGoogleDrive(): Promise<PCloudConnectResult> {
    this.googleConnectFlow ??= createGoogleDriveConnect({
      clientId: () => this.googleClientId(),
      clientSecret: () => this.googleClientSecret(),
      tokenStore: this.googleTokenStore(),
      authClient: this.googleAuth(),
      openExternal: this.options.openExternal,
      onConnected: () => {
        this.resetGoogleDriveAccountCache();
      },
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
    });
    const result = await this.googleConnectFlow();
    if (!result.ok) return result;
    const provider = this.provider('google-drive');
    if (provider === undefined) return identityUnavailable('Google Drive');
    const identity = await this.establishAccountIdentity('google-drive', provider);
    if (!identity.ok) return identity.result;
    return this.activate('google-drive', provider, identity);
  }

  private persistAccountIdentity(providerId: string, identity: ProviderAccountIdentity): boolean {
    try {
      if (providerId === 'pcloud') {
        const record = this.tokenStore().load();
        if (record === null) return false;
        this.tokenStore().save({ ...record, ...identity });
      } else if (providerId === 'google-drive') {
        const record = this.googleTokenStore().load();
        if (record === null) return false;
        this.googleTokenStore().save({ ...record, ...identity });
      } else if (providerId === 'icloud-drive') {
        this.iCloudAuthorityStore().save(identity);
      }
      return true;
    } catch {
      return false;
    }
  }

  private persistedAccountIdentity(providerId: string): ProviderAccountIdentity | null {
    const record =
      providerId === 'pcloud'
        ? this.tokenStore().load()
        : providerId === 'google-drive'
          ? this.googleTokenStore().load()
          : providerId === 'icloud-drive'
            ? this.iCloudAuthorityStore().loadRecord()
            : null;
    if (record?.accountId === undefined || record.accountLabel === undefined) return null;
    return { accountId: record.accountId, accountLabel: record.accountLabel };
  }

  private clearFailedAuthentication(providerId: string): boolean {
    try {
      if (providerId === 'pcloud') {
        this.tokenStore().clear();
      } else if (providerId === 'google-drive') {
        this.googleAuth().clear();
        this.resetGoogleDriveAccountCache();
      } else {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async establishAccountIdentity(providerId: string, provider: StorageProvider): Promise<AccountIdentityAttempt> {
    const previousIdentity = this.persistedAccountIdentity(providerId);
    try {
      const identity = await withAbortableDeadline(
        (signal) => provider.accountIdentity(signal),
        this.options.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS,
      );
      const accountChanged = previousIdentity !== null && previousIdentity.accountId !== identity.accountId;
      return {
        ok: true,
        identity,
        requiresSwitchGuard: this.activeId() !== providerId || (providerId !== 'mock' && (previousIdentity === null || accountChanged)),
      };
    } catch (error) {
      const authenticationFailed = error instanceof ProviderError && error.kind === 'auth';
      return {
        ok: false,
        reauthenticate: authenticationFailed && this.clearFailedAuthentication(providerId),
        result: identityUnavailable(provider.label),
      };
    }
  }

  /** Moves settings.providerId, fail-closed (#741): switching to a
   * different provider first proves the target holds every remote-only
   * object the library claims. Re-activating the same account skips the
   * proof; a changed account under the same provider ID does not. */
  private async activate(
    providerId: string,
    provider: StorageProvider,
    attempt: Extract<AccountIdentityAttempt, { readonly ok: true }>,
  ): Promise<PCloudConnectResult> {
    if (this.options.isWorkActive?.() === true) {
      return { ok: false, reason: 'Wait for the active backup or restore to finish before switching providers.' };
    }
    const iCloudProvider = provider instanceof ICloudDriveProvider ? provider : null;
    if (attempt.requiresSwitchGuard && this.options.providerId() === providerId) {
      this.options.setProviderId(null);
      if (this.options.providerId() === providerId) {
        return { ok: false, reason: 'Could not save the disconnected state. Try again.' };
      }
    }
    if (!this.persistAccountIdentity(providerId, attempt.identity)) {
      return providerId === 'icloud-drive' ? iCloudAuthoritySaveFailure() : identityUnavailable(provider.label);
    }
    iCloudProvider?.resetAccountAuthority(attempt.identity.accountId);
    if (this.options.switchGuard !== undefined && attempt.requiresSwitchGuard) {
      const verdict = await this.options.switchGuard({ providerId, provider });
      if (!verdict.ok) return verdict;
    }
    this.options.setProviderId(providerId);
    return { ok: true, reason: null };
  }

  async descriptors(): Promise<readonly ProviderDescriptor[]> {
    return Promise.all((this.registryInstance?.list() ?? []).map((provider) => this.descriptor(provider)));
  }

  provider(id: string): StorageProvider | undefined {
    return this.registryInstance?.get(id);
  }

  async restoreSources(providerId: string): Promise<readonly { libraryId: string; provider: StorageProvider }[]> {
    const provider = this.provider(providerId);
    const descriptor = (await this.descriptors()).find((candidate) => candidate.id === providerId);
    if (provider === undefined || descriptor?.available !== true) throw new Error(`provider is not available: ${providerId}`);
    const libraryIds = await provider.listLibraries();
    return libraryIds.map((libraryId) => ({ libraryId, provider: provider.forLibrary(libraryId) }));
  }

  /** Provider instances are remote-home scoped. Credentials intentionally
   * survive a switch, but the registry must be rebuilt for the new library
   * before status or data operations can observe it (#387). */
  resetLibraryBinding(): void {
    for (const operation of this.storageInFlight.values()) operation.controller.abort(new Error('library binding changed'));
    this.storageInFlight.clear();
    this.registryInstance = undefined;
    this.googleProviderInstance = undefined;
    this.iCloudDriveProviderInstance = undefined;
  }

  drainICloudDriveOperations(): Promise<void> {
    return this.options.iCloudDriveBridge.drain();
  }

  /** Connection authority is intentionally cheap (#721): provider capacity
   * lives behind storage(), so a completed OAuth flow can render
   * Connected without waiting on the provider network. */
  async status(providerId: string): Promise<ProviderConnectionStatus> {
    const provider = this.provider(providerId);
    if (provider === undefined) {
      throw new Error(`provider is not available: ${providerId}`);
    }
    const [descriptor, authState] = await Promise.all([
      this.descriptor(provider),
      withDeadline(provider.authState(), this.options.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS),
    ]);
    let identity = this.persistedAccountIdentity(providerId);
    if (providerId === 'mock' && authState === 'connected') {
      identity = await provider.accountIdentity().catch(() => null);
    }
    const connected = this.activeId() === providerId && authState === 'connected' && identity !== null;
    const custodyRequirements = this.options.providerRequirements?.().filter((requirement) => requirement.providerId === providerId) ?? [];
    return {
      provider: descriptor,
      connected,
      accountLabel: connected ? (identity?.accountLabel ?? null) : null,
      ...(custodyRequirements.length === 0 ? {} : { custodyRequirements }),
    };
  }

  /** Bounded, informational provider capacity (#721). Calls are single-flight
   * per provider; timeout or failure degrades only capacity and never mutates
   * provider selection or credential custody. */
  storage(providerId: string): Promise<ProviderCapacityStatus> {
    const pending = this.storageInFlight.get(providerId);
    if (pending !== undefined) return pending.promise;
    const controller = new AbortController();
    const promise = this.loadCapacity(providerId, controller)
      .catch(() => unavailableCapacity(providerId))
      .finally(() => {
        if (this.storageInFlight.get(providerId)?.promise === promise) this.storageInFlight.delete(providerId);
      });
    this.storageInFlight.set(providerId, { controller, promise });
    return promise;
  }

  private async loadCapacity(providerId: string, controller: AbortController): Promise<ProviderCapacityStatus> {
    const timeout = setTimeout(
      () => controller.abort(new Error('provider capacity timed out')),
      this.options.storageTimeoutMs ?? DEFAULT_STORAGE_TIMEOUT_MS,
    );
    timeout.unref();
    const provider = this.provider(providerId);
    try {
      if (provider === undefined || this.activeId() !== providerId) return emptyCapacity();
      if (provider.capabilities.quota === 'unknown') {
        return { ...emptyCapacity(), capacityRoute: providerId === 'icloud-drive' ? 'system-settings' : 'none' };
      }
      try {
        const forcedStall = !this.options.isPackaged && this.options.harnessEnv('OVERLOOK_PROVIDER_STORAGE_STALL') === providerId;
        const stalled = (): Promise<never> => new Promise<never>(() => undefined);
        const quota = await raceWithAbort(forcedStall ? stalled() : provider.quota(controller.signal), controller.signal);
        return {
          ...emptyCapacity(),
          capacity: quota.totalBytes === null ? null : { usedBytes: quota.usedBytes, totalBytes: quota.totalBytes },
        };
      } catch {
        return emptyCapacity();
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Routes to the OS surface that owns account capacity when Overlook cannot
   * report it in-app (#684). iCloud has no trustworthy account-quota API, so this
   * opens macOS System Settings → Apple Account → iCloud. A no-op (ok:false) for
   * providers whose capacity is reported in the card. */
  async openCapacitySettings(providerId: string): Promise<{ ok: boolean }> {
    if (providerId !== 'icloud-drive') return { ok: false };
    await this.options.openExternal('x-apple.systempreferences:com.apple.preferences.AppleIDPrefPane?iCloud');
    return { ok: true };
  }

  async connect(providerId: string): Promise<PCloudConnectResult> {
    if (this.options.isWorkActive?.() === true) {
      return { ok: false, reason: 'Wait for the active backup or restore to finish before switching providers.' };
    }
    const provider = this.provider(providerId);
    const descriptor = (await this.descriptors()).find((candidate) => candidate.id === providerId);
    if (provider === undefined || descriptor?.available !== true) {
      return { ok: false, reason: descriptor?.unavailableReason ?? 'This provider is not available on this device.' };
    }
    const providerState = await provider.authState();
    const activeProviderId = this.activeId();
    if (activeProviderId !== null && (activeProviderId !== providerId || providerState !== 'connected')) {
      const blocked = await this.custodyChangeBlocked(activeProviderId);
      if (blocked !== null) return blocked;
    }
    // Selecting a provider with existing sealed authority is activation, not a
    // new OAuth grant.
    if (providerState === 'connected') {
      const identity = await this.establishAccountIdentity(providerId, provider);
      if (!identity.ok) {
        if (identity.reauthenticate && providerId === 'pcloud') return this.connectPCloud();
        if (identity.reauthenticate && providerId === 'google-drive') return this.connectGoogleDrive();
        return identity.result;
      }
      return this.activate(providerId, provider, identity);
    }
    if (providerId === 'pcloud') {
      return this.connectPCloud();
    }
    if (providerId === 'google-drive') {
      return this.connectGoogleDrive();
    }
    if (providerId === 'icloud-drive' && provider instanceof ICloudDriveProvider) {
      const status = await this.iCloudStatus();
      if (!status.available || status.accountToken === null) {
        return { ok: false, reason: iCloudUnavailableCopy(status.reason ?? 'native-unavailable') };
      }
    }
    if (provider instanceof FaultInjectingProvider) {
      provider.disarm('auth-expired');
    }
    const identity = await this.establishAccountIdentity(providerId, provider);
    if (!identity.ok) return identity.result;
    return this.activate(providerId, provider, identity);
  }

  disconnect(providerId: string): Promise<PCloudConnectResult> {
    const pending = this.disconnectInFlight.get(providerId);
    if (pending !== undefined) return pending;
    const operation = Promise.resolve()
      .then(() => this.disconnectOnce(providerId))
      .finally(() => {
        if (this.disconnectInFlight.get(providerId) === operation) this.disconnectInFlight.delete(providerId);
      });
    this.disconnectInFlight.set(providerId, operation);
    return operation;
  }

  private async disconnectOnce(providerId: string): Promise<PCloudConnectResult> {
    if (this.options.isWorkActive?.() === true) {
      return { ok: false, reason: 'Wait for the active backup or restore to finish before disconnecting.' };
    }
    const credential = this.options.custodyPreflight === undefined ? null : await this.custodyCredential(providerId);
    if (this.options.custodyPreflight !== undefined && credential === null) return custodyUnavailable();
    if (credential !== null) {
      const custody = this.options.custodyPreflight?.(credential);
      const blocked = custody === undefined ? null : custodyBlocked(custody);
      if (blocked !== null) return blocked;
    }
    if (this.options.isWorkActive?.() === true) {
      return { ok: false, reason: 'Wait for the active backup or restore to finish before disconnecting.' };
    }
    const result = this.disconnectAuthorization(providerId);
    if (result.ok && credential !== null) this.options.deleteUnreferencedAuthorities?.(credential);
    return result;
  }

  private disconnectAuthorization(providerId: string): PCloudConnectResult {
    this.abortStorage(providerId);
    if (providerId === 'pcloud') return this.disconnectPCloud();
    try {
      if (providerId === 'google-drive') {
        this.googleAuth().clear();
        this.resetGoogleDriveAccountCache();
      }
      if (providerId === 'icloud-drive') {
        this.iCloudAuthorityStore().clear();
        this.iCloudDriveProviderInstance?.resetAccountAuthority();
      }
      if (this.options.providerId() === providerId) this.options.setProviderId(null);
      if (this.options.providerId() === providerId) {
        return { ok: false, reason: 'Could not save the disconnected state. Try again.' };
      }
      return { ok: true, reason: null };
    } catch {
      return { ok: false, reason: 'Could not remove this provider’s authorization from this device. Try again.' };
    }
  }

  async removeAuthorizationAnyway(providerId: string): Promise<PCloudConnectResult> {
    if (this.options.isWorkActive?.() === true) {
      return { ok: false, reason: 'Wait for the active backup or restore to finish before removing authorization.' };
    }
    const credential = await this.custodyCredential(providerId);
    if (credential === null) {
      return custodyUnavailable('Could not verify which provider account is being removed.');
    }
    if (this.options.isWorkActive?.() === true) {
      return { ok: false, reason: 'Wait for the active backup or restore to finish before removing authorization.' };
    }
    const rollbackRequired = this.options.markProviderRequired?.(credential);
    const result = this.disconnectAuthorization(providerId);
    if (!result.ok && this.samePersistedCredential(credential)) rollbackRequired?.();
    return result;
  }

  private async custodyChangeBlocked(providerId: string): Promise<PCloudConnectResult | null> {
    if (this.options.custodyPreflight === undefined) return null;
    const credential = await this.custodyCredential(providerId);
    if (credential === null) return custodyUnavailable();
    const custody = this.options.custodyPreflight(credential);
    return custodyBlocked(custody);
  }

  private async custodyCredential(providerId: string): Promise<CustodyCredential | null> {
    const persisted = this.persistedAccountIdentity(providerId);
    if (persisted !== null) return { providerId, accountId: persisted.accountId };
    const provider = this.provider(providerId);
    if (provider === undefined) return null;
    try {
      const identity = await provider.accountIdentity();
      return { providerId, accountId: identity.accountId };
    } catch {
      return null;
    }
  }

  private samePersistedCredential(credential: CustodyCredential): boolean {
    return this.persistedAccountIdentity(credential.providerId)?.accountId === credential.accountId;
  }

  private disconnectPCloud(): PCloudConnectResult {
    const store = this.tokenStore();
    const previous = store.load();
    try {
      store.clear();
    } catch {
      return { ok: false, reason: 'Could not remove the pCloud authorization from this device. Check file access and try again.' };
    }
    if (store.load() !== null) {
      return { ok: false, reason: 'Could not verify that the pCloud authorization was removed. Check status and try again.' };
    }

    try {
      if (this.options.providerId() === 'pcloud') this.options.setProviderId(null);
    } catch {
      // Verification below decides whether the write completed before the
      // exception. Never roll a completed disconnect back on an emit failure.
    }
    const selectionCleared = this.options.providerId() !== 'pcloud';
    const custodyCleared = store.load() === null;
    if (selectionCleared && custodyCleared) return { ok: true, reason: null };
    if (!selectionCleared) return this.rollbackPCloudCustody(previous);
    return {
      ok: false,
      reason: 'Disconnect could not be verified because pCloud authorization changed during the operation. Check status and try again.',
    };
  }

  private rollbackPCloudCustody(previous: ReturnType<PCloudTokenStore['load']>): PCloudConnectResult {
    if (previous !== null) {
      try {
        this.tokenStore().save(previous);
      } catch {
        return {
          ok: false,
          reason: 'Disconnect could not be completed or rolled back. Restart Overlook, check pCloud status, and try again.',
        };
      }
    }
    return { ok: false, reason: 'Could not save the disconnected state. pCloud remains connected; try again.' };
  }

  /** The library's remote identity (ADR-0007) — the same ULID as the local
   * library identity (ADR-0017 §2), read from <dataDir>/library-id. Since
   * #384 the registry mints it eagerly; the mint fallback here covers
   * pre-registry directories opened directly. */
  libraryId(): string {
    return readOrMintLibraryId(this.options.dataDir());
  }

  /** Who Connect targets while disconnected. The local mock exists only in
   * the explicit E2E harness; ordinary development matches the packaged
   * provider set. */
  defaultTarget(): string {
    const override = this.options.harnessEnv('OVERLOOK_PROVIDER');
    if (
      (override === 'mock' && this.mockEnabled()) ||
      (override === 'pcloud' && this.pcloudAvailable()) ||
      override === 'icloud-drive' ||
      (override === 'google-drive' && this.googleClientId() !== null)
    ) {
      return override;
    }
    if (this.mockEnabled()) return 'mock';
    if (this.pcloudAvailable()) return 'pcloud';
    if (this.googleClientId() !== null) return 'google-drive';
    return 'icloud-drive';
  }

  /** settings.providerId with the runtime correction: 'mock' is not a real
   * provider outside E2E (never registered), so a stale/default 'mock'
   * value reads as disconnected instead of silently "backing up" to a local
   * folder. */
  activeId(): string | null {
    const raw = this.options.providerId();
    if (raw === null) {
      return null;
    }
    if (raw === 'mock' && !this.mockEnabled()) {
      return null;
    }
    if (raw === 'pcloud' && !this.pcloudAvailable()) {
      return null;
    }
    if (raw === 'pcloud' && this.persistedAccountIdentity(raw) === null) {
      return null;
    }
    if (raw === 'google-drive' && this.googleClientId() === null) {
      return null;
    }
    if ((raw === 'google-drive' || raw === 'icloud-drive') && this.persistedAccountIdentity(raw) === null) {
      return null;
    }
    if (this.registryInstance !== undefined && this.registryInstance.get(raw) === undefined) {
      return null;
    }
    return raw;
  }

  /** The engine-facing provider registry. pCloud is present only in an
   * explicitly enabled build; the mock exists only in E2E. */
  buildProvider(build: { mockRootDir: string; fault: string | undefined; libraryId?: string | undefined }): StorageProvider {
    const registry = new ProviderRegistry();
    const libraryId = build.libraryId ?? this.libraryId();
    if (this.pcloudAvailable()) {
      registry.register(
        new PCloudProvider({
          auth: () => this.tokenStore().load(),
          libraryId,
          ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
        }),
      );
    }
    const googleProvider = new GoogleDriveProvider({
      auth: this.googleAuth(),
      paths: this.googlePathStore(),
      libraryId,
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
    });
    this.googleProviderInstance = googleProvider;
    registry.register(googleProvider);
    const iCloudProvider = new ICloudDriveProvider({
      bridge: this.options.iCloudDriveBridge,
      libraryId,
      accountToken: this.iCloudAuthorityStore().load(),
      requireExplicitAuthority: true,
    });
    this.iCloudDriveProviderInstance = iCloudProvider;
    registry.register(iCloudProvider);
    if (this.mockEnabled()) {
      const faulty = new FaultInjectingProvider(new MockProvider({ rootDir: build.mockRootDir, libraryId }));
      const fault = build.fault;
      if (
        fault === 'put' ||
        fault === 'verify-mismatch' ||
        fault === 'auth-expired' ||
        fault === 'identity-unavailable' ||
        fault === 'transient-get'
      ) {
        faulty.arm(fault);
      }
      registry.register(faulty);
    }
    this.registryInstance = registry;
    return createActiveProvider({ registry, activeId: () => this.activeId(), defaultId: () => this.defaultTarget() });
  }

  private mockEnabled(): boolean {
    return !this.options.isPackaged && this.options.harnessEnv('OVERLOOK_E2E') !== undefined;
  }

  private pcloudClientId(): string | null {
    const value = this.options.pcloudClientId()?.trim() ?? '';
    return value === '' ? null : value;
  }

  private pcloudAvailable(): boolean {
    return this.options.pcloudEnabled && this.pcloudClientId() !== null;
  }

  private resetGoogleDriveAccountCache(): void {
    if (this.googleProviderInstance === undefined) {
      this.googlePathStore().clear();
      return;
    }
    this.googleProviderInstance.resetAccountCache();
  }

  private async iCloudStatus() {
    try {
      return await withDeadline(this.options.iCloudDriveBridge.status(), this.options.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS);
    } catch {
      return { available: false as const, reason: 'native-unavailable' as const, accountToken: null, accountLabel: null };
    }
  }

  private async descriptor(provider: StorageProvider): Promise<ProviderDescriptor> {
    const googleUnavailable = provider.id === 'google-drive' && this.googleClientId() === null;
    const iCloudStatus = provider.id === 'icloud-drive' ? await this.iCloudStatus() : null;
    const iCloudUnavailable = provider.id === 'icloud-drive' && iCloudStatus?.available !== true;
    return {
      id: provider.id,
      label: provider.label,
      capabilities: provider.capabilities,
      available: !googleUnavailable && !iCloudUnavailable,
      unavailableReason: googleUnavailable
        ? 'Google Drive OAuth is not configured in this build.'
        : iCloudUnavailable
          ? iCloudUnavailableCopy(iCloudStatus?.reason ?? 'native-unavailable')
          : null,
    };
  }

  private abortStorage(providerId: string): void {
    const operation = this.storageInFlight.get(providerId);
    operation?.controller.abort(new Error('provider capacity cancelled'));
    this.storageInFlight.delete(providerId);
  }
}

function emptyCapacity(): ProviderCapacityStatus {
  return {
    capacity: null,
    capacityRoute: 'none',
  };
}

function identityUnavailable(providerLabel: string): PCloudConnectResult {
  return {
    ok: false,
    reason: `${providerLabel} could not verify the account identity. Check the connection and try again.`,
    code: 'identity-unavailable',
    retryable: true,
  };
}

function custodyUnavailable(reason = 'Could not verify custody for this provider account.'): PCloudConnectResult {
  return { ok: false, reason, code: 'custody-unavailable', retryable: true };
}

function restoreRequired(custody: CustodyPreflight): PCloudConnectResult {
  return {
    ok: false,
    reason: 'Restore all originals first before changing this provider account.',
    code: 'custody-restore-required',
    custody,
  };
}

function custodyBlocked(custody: CustodyPreflight): PCloudConnectResult | null {
  if (custody.unverifiedLibraries !== undefined && custody.unverifiedLibraries.length > 0) {
    return {
      ok: false,
      reason: 'Open each unverified library before changing this provider account.',
      code: 'custody-unavailable',
      retryable: true,
      custody,
    };
  }
  return custody.totalItems === 0 ? null : restoreRequired(custody);
}

function iCloudAuthoritySaveFailure(): PCloudConnectResult {
  return { ok: false, reason: 'Could not securely save this iCloud account authority. Check Keychain access and try again.' };
}

function unavailableCapacity(providerId: string): ProviderCapacityStatus {
  return {
    ...emptyCapacity(),
    capacityRoute: providerId === 'icloud-drive' ? 'system-settings' : 'none',
  };
}

function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('provider status timed out')), timeoutMs);
    timeout.unref();
    void operation.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

function withAbortableDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('provider identity timed out')), timeoutMs);
  timeout.unref();
  const pending = Promise.resolve().then(() => operation(controller.signal));
  return raceWithAbort(pending, controller.signal).finally(() => clearTimeout(timeout));
}

function iCloudUnavailableCopy(reason: ICloudDriveUnavailableReason): string {
  const copy: Record<ICloudDriveUnavailableReason, string> = {
    'unsupported-platform': 'iCloud Drive is available only on macOS.',
    'unsigned-build': 'iCloud Drive requires a provisioned signed macOS build.',
    'native-unavailable': 'iCloud Drive support is unavailable in this build.',
    unentitled: 'This build is not entitled for iCloud Drive.',
    'account-unavailable': 'Sign in to iCloud Drive in macOS Settings.',
  };
  return copy[reason];
}
