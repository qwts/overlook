import { seedLibrary, seedSemanticIndex, seedSynthetic } from './seed.js';
import type { LibraryService } from './library-service.js';
import type { LibraryParts } from './library-parts.js';

// Dev/E2E seed harness (#72/#74), extracted from the composition root. Both
// seeds are no-ops on a non-empty library — re-runs on the same profile must
// not duplicate content hashes.

type SeedDb = Parameters<typeof seedLibrary>[0];
type SeedBlobs = Parameters<typeof seedLibrary>[1];
type SeedKey = Parameters<typeof seedLibrary>[2];

export interface DevSeedParts {
  readonly db: SeedDb;
  readonly blobStore: SeedBlobs;
  readonly currentKey: () => SeedKey;
  /** Rotation (#517 e2e): photos from OVERLOOK_SEED_RETIRED_KEY_FROM on seal
   * under a key that is retired again once seeding ends. */
  readonly rotate: () => SeedKey;
  /** Re-registers keys minted during seeding with the keyring (#517). */
  readonly reconcileKeyring: () => void;
  readonly photos: () => number;
}

export interface DevSeedOptions {
  readonly contentAvailable: boolean;
  readonly harnessEnv: (name: string) => string | undefined;
  /** Triggers the lazy library bootstrap and exposes the open parts. */
  readonly open: () => DevSeedParts | undefined;
}

export function devSeedAccess(
  service: LibraryService,
  parts: LibraryParts | undefined,
  reconcileKeyring: () => void,
): ReturnType<DevSeedOptions['open']> {
  if (parts === undefined) return undefined;
  return {
    db: parts.db,
    blobStore: parts.blobStore,
    currentKey: () => parts.keyStore.currentKey(),
    rotate: () => parts.keyStore.rotate(),
    reconcileKeyring,
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
      const retiredFrom = Number(options.harnessEnv('OVERLOOK_SEED_RETIRED_KEY_FROM') ?? 'NaN');
      const plan = Number.isInteger(retiredFrom) && retiredFrom >= 0 && retiredFrom < seedCount;
      let sealing = parts.currentKey();
      const seeded = await seedLibrary(parts.db, parts.blobStore, sealing, seedCount, (index) => {
        if (plan && index === retiredFrom) sealing = parts.rotate();
        return sealing;
      });
      if (plan && seeded.photos > 0) {
        parts.rotate();
        parts.reconcileKeyring();
      }
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
