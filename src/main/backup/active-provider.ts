import type { StorageProvider } from './provider.js';

// The active-provider delegator (#256). The backup engine, offload service,
// and consistency checker each hold ONE provider for their lifetime, but the
// user can switch providers mid-session without rebuilding the engine, so
// they get a facade that re-reads the current choice on every
// call and forwards to the registered instance.

export interface ActiveProviderOptions {
  readonly registry: { get(id: string): StorageProvider | undefined };
  /** The user's current choice (settings.providerId, corrected); null while
   * disconnected. */
  readonly activeId: () => string | null;
  /** Who Connect targets while disconnected — also the fallback when the
   * active id names a provider this build never registered. */
  readonly defaultId: () => string;
}

export function createActiveProvider(options: ActiveProviderOptions): StorageProvider {
  const delegate = (): StorageProvider => {
    const chosen = options.registry.get(options.activeId() ?? options.defaultId()) ?? options.registry.get(options.defaultId());
    if (chosen === undefined) {
      throw new Error('no storage provider registered');
    }
    return chosen;
  };
  return {
    get id() {
      return delegate().id;
    },
    get label() {
      return delegate().label;
    },
    get capabilities() {
      return delegate().capabilities;
    },
    listLibraries: (signal) => delegate().listLibraries(signal),
    forLibrary: (libraryId) => delegate().forLibrary(libraryId),
    authState: () => delegate().authState(),
    accountIdentity: (signal) => delegate().accountIdentity(signal),
    put: (path, bytes) => delegate().put(path, bytes),
    getStream: (path) => delegate().getStream(path),
    probe: (path, signal) => delegate().probe(path, signal),
    list: (prefix, signal) => delegate().list(prefix, signal),
    delete: (path) => delegate().delete(path),
    quota: (signal) => delegate().quota(signal),
    verify: (path) => delegate().verify(path),
  };
}
