import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import type { RestoreMissingObject } from '../../shared/backup/restore-contract.js';
import type { StorageProvider } from './provider.js';

function quarantinePath(generation: number, path: string): string {
  return `quarantine/gen-${String(generation)}/${path}`;
}

/** After a heal restore, record the gap list and move corrupt objects out of
 * the live backup prefix. Missing objects are already gone. Nothing is
 * permanently purged — `delete` is the provider's recoverable Trash (#994). */
export async function healRemoteGaps(
  provider: StorageProvider,
  generation: number,
  missing: readonly RestoreMissingObject[],
): Promise<void> {
  if (missing.length === 0) return;
  const report = Buffer.from(
    JSON.stringify({
      version: 1,
      generation,
      generatedAt: new Date().toISOString(),
      missing,
    }),
  );
  await provider.put(quarantinePath(generation, 'gaps.json'), Readable.from([report]));
  for (const item of missing) {
    if (item.reason === 'not-found') continue;
    try {
      const bytes = await buffer(await provider.getStream(item.path));
      await provider.put(quarantinePath(generation, item.path), Readable.from([bytes]));
    } catch {
      // Copy is best-effort. The live object is still moved to Trash below
      // so the backup prefix is corrected without a permanent purge.
    }
    try {
      await provider.delete(item.path);
    } catch {
      // The healed local library already holds the verified set.
    }
  }
}
