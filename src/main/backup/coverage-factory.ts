import { CoverageRepository } from '../db/coverage-repository.js';
import { SidecarRepository } from '../db/sidecar-repository.js';
import { CoverageService, type CoverageDeps } from './coverage-service.js';
import type { ProviderRuntime } from './provider-runtime.js';

type FactoryDeps = Omit<CoverageDeps, 'repo' | 'providerConnected' | 'providerIdentity' | 'now' | 'sleep'>;

/**
 * Backup coverage (#506, ADR-0033): wires the ledger-side service to the
 * database repositories and the provider runtime. The provider delete rides
 * the engine's post-manifest settle hook; everything else here is local.
 */
export function createCoverageService(
  db: ConstructorParameters<typeof CoverageRepository>[0],
  runtime: () => Pick<ProviderRuntime, 'activeId' | 'status'>,
  deps: FactoryDeps,
): CoverageService {
  const coverageRepo = new CoverageRepository(db);
  const sidecarRepo = new SidecarRepository(db);
  return new CoverageService({
    ...deps,
    repo: {
      rows: (photoIds) => coverageRepo.rows(photoIds),
      excluding: () => coverageRepo.excluding(),
      includedReferences: (hash) => coverageRepo.includedReferences(hash),
      sidecarHashesForPhoto: (photoId) => sidecarRepo.listForPhoto(photoId).map((row) => row.contentHash),
    },
    providerConnected: () => runtime().activeId() !== null,
    providerIdentity: async () => {
      const activeId = runtime().activeId();
      if (activeId === null) return { provider: null, account: null };
      const status = await runtime().status(activeId);
      return { provider: status.provider.label, account: status.accountLabel };
    },
    now: () => new Date().toISOString(),
    sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}

/** The IPC accessor: the engine builds the service, so ensure it first. */
export function requireCoverageService(ensureEngine: () => unknown, current: () => CoverageService | undefined): CoverageService {
  ensureEngine();
  const service = current();
  if (service === undefined) throw new Error('backup coverage is unavailable before the library opens');
  return service;
}
