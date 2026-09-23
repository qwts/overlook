import { PhotosRepository } from '../db/photos-repository.js';
import { OriginalAvailabilityRepository } from '../db/original-availability.js';
import { run } from '../db/sql.js';
import type { LibraryParts } from './library-parts.js';

/** Explicit E2E fixture: real missing ciphertext beside an ordinary upload
 * error whose original remains present. Production never invokes this. */
export async function seedOriginalRecovery(parts: Pick<LibraryParts, 'db' | 'blobStore'>): Promise<void> {
  const photo = new PhotosRepository(parts.db).get('01J8SEEDPHOTO0001');
  if (photo === undefined) throw new Error('original recovery seed requires at least three photos');
  await parts.blobStore.deleteOriginal(photo.contentHash);
  new OriginalAvailabilityRepository(parts.db).repair(photo.id, 'error');
  run(parts.db, "UPDATE sync_ledger SET status = 'error' WHERE photo_id = '01J8SEEDPHOTO0002'");
}
