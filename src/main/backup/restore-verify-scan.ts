import type { StorageProvider } from './provider.js';
import type { RestoreCandidate } from './restore-discovery.js';
import type { RestoreProgress } from './restore-types.js';

export interface ScanTicker {
  tick(photoId: string | null): void;
}

export function verifyObjectCount(candidate: RestoreCandidate): number {
  const sidecars = 'sidecars' in candidate.manifest ? candidate.manifest.sidecars.length : 0;
  const protectedObjects =
    candidate.manifest.schema === 2
      ? 0
      : candidate.manifest.protectedPhotos.reduce(
          (sum, photo) => sum + photo.objects.filter((object) => object.status === 'synced').length,
          0,
        );
  return candidate.manifest.photos.length + sidecars + protectedObjects;
}

export function addPresenceFingerprint(fingerprints: string[], path: string, bytes: number): void {
  fingerprints.push(`${path}\u0000${String(bytes)}`);
}

function parentPrefix(path: string): string | null {
  const slash = path.lastIndexOf('/');
  return slash > 0 ? path.slice(0, slash) : null;
}

export async function listObjectBytes(
  provider: StorageProvider,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const prefixes = new Set<string>();
  for (const path of paths) {
    const prefix = parentPrefix(path);
    if (prefix !== null) prefixes.add(prefix);
  }
  const listed = new Map<string, number>();
  for (const prefix of prefixes) {
    for (const entry of await provider.list(prefix, signal)) {
      listed.set(entry.path, entry.bytes);
    }
  }
  return listed;
}

export async function presentBytes(
  provider: StorageProvider,
  listed: ReadonlyMap<string, number>,
  path: string,
  signal?: AbortSignal,
): Promise<number> {
  const hit = listed.get(path);
  if (hit !== undefined) return hit;
  return (await provider.probe(path, signal)).bytes;
}

export function createScanTicker(
  total: number,
  emit: (stage: RestoreProgress['stage'], done: number, total: number, photoId: string | null) => void,
): ScanTicker {
  let done = 0;
  emit('verifying', 0, total, null);
  return {
    tick: (photoId) => {
      done += 1;
      emit('verifying', done, total, photoId);
    },
  };
}
