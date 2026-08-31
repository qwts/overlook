import { seedLibrary, seedSemanticIndex, seedSynthetic } from './seed.js';
import type { LibraryService } from './library-service.js';
import type { LibraryParts } from './library-parts.js';

// Dev/E2E seed harness (#72/#74), extracted from the composition root. Both
// seeds are no-ops on a non-empty library — re-runs on the same profile must
// not duplicate content hashes.

type SeedDb = Parameters<typeof seedLibrary>[0];
type SeedBlobs = Parameters<typeof seedLibrary>[1];
type SeedKey = Parameters<typeof seedLibrary>[2];

export interface DevSeedOptions {
  readonly contentAvailable: boolean;
  readonly harnessEnv: (name: string) => string | undefined;
  /** Triggers the lazy library bootstrap and exposes the open parts. */
  readonly open: () => { db: SeedDb; blobStore: SeedBlobs; currentKey: () => SeedKey; photos: () => number } | undefined;
}

export function devSeedAccess(service: LibraryService, parts: LibraryParts | undefined): ReturnType<DevSeedOptions['open']> {
  if (parts === undefined) return undefined;
  return {
    db: parts.db,
    blobStore: parts.blobStore,
    currentKey: () => parts.keyStore.currentKey(),
    photos: () => service.stats().photos,
  };
}

export async function runDevSeeds(options: DevSeedOptions): Promise<void> {
  if (!options.contentAvailable) return;
  const seedCount = Number(options.harnessEnv('OVERLOOK_SEED') ?? '0');
  if (Number.isInteger(seedCount) && seedCount > 0) {
    const parts = options.open();
    if (parts !== undefined) {
      await parts.blobStore.init();
      await seedLibrary(parts.db, parts.blobStore, parts.currentKey(), seedCount);
    }
  }
  // Metadata-only rows sharing one blob — the 200K grid perf baseline (#74).
  const syntheticCount = Number(options.harnessEnv('OVERLOOK_SEED_SYNTHETIC') ?? '0');
  if (Number.isInteger(syntheticCount) && syntheticCount > 0) {
    const parts = options.open();
    if (parts !== undefined && parts.photos() === 0) {
      seedSynthetic(parts.db, parts.currentKey().id, 'synthetic', syntheticCount);
    }
  }
  const semanticDimension = Number(options.harnessEnv('OVERLOOK_SEMANTIC_QUERY_DIMENSION') ?? 'NaN');
  if (options.harnessEnv('OVERLOOK_E2E') !== undefined && Number.isSafeInteger(semanticDimension)) {
    const parts = options.open();
    if (parts !== undefined && parts.photos() > 0) seedSemanticIndex(parts.db, semanticDimension);
  }
}
