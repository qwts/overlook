import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { markDirty } from '../backup/sync-ledger.js';
import { EditRevisionRepository } from '../db/edit-revision-repository.js';
import type { PhotosRepository } from '../db/photos-repository.js';
import { VariantRepository, type VariantFamily } from '../db/variant-repository.js';
import type { ThumbnailOutcome } from '../import/thumbnail-service.js';
import {
  EDIT_AUTHOR_PRODUCT,
  EDIT_REVISION_FORMAT_VERSION,
  IDENTITY_TRANSFORM,
  type EditRevisionDocument,
  type EditTransform,
} from '../../shared/library/edit-revision.js';
import type { DuplicateResult } from '../../shared/ipc/variant-channels.js';
import type { PhotoRecord } from '../../shared/library/types.js';

// Variants (#496, ADR-0031 §1 + §3). Duplicate creates a sibling variant
// over the same original asset: a new photos row (metadata copied as a
// starting point; favorite, the Original marker, and the trash state are
// not), the source's head edit stack copied as the variant's own root
// revision, and its own derivatives baked under its derivative key with
// that transform. The original bytes are neither read for custody nor
// rewritten; when they are not local the bake is deferred exactly as a
// saved edit is (#493) and the row still exists. Promote picks the family
// representative — reversible metadata, custody untouched (§3).

export interface VariantServiceDeps {
  readonly db: BetterSqlite3.Database;
  readonly repo: PhotosRepository;
  /** Plaintext original bytes, or null when the original is not local (offloaded). */
  readonly loadOriginal: (photo: PhotoRecord) => Promise<Buffer | null>;
  readonly regenerate: (photo: PhotoRecord, bytes: Buffer, transform: EditTransform) => Promise<ThumbnailOutcome>;
  readonly appVersion: string;
  readonly newId: () => string;
  readonly now: () => string;
  /** Rows were added: refresh the grid page and owe a manifest. */
  readonly created: (photoIds: readonly string[]) => void;
  /** A family's metadata changed (Promote): refresh those rows only. */
  readonly changed: (photoIds: readonly string[]) => void;
}

export class VariantService {
  private readonly revisions: EditRevisionRepository;
  private readonly variants: VariantRepository;

  constructor(private readonly deps: VariantServiceDeps) {
    this.revisions = new EditRevisionRepository(deps.db);
    this.variants = new VariantRepository(deps.db);
  }

  family(photoId: string): VariantFamily {
    return this.variants.family(this.photo(photoId).contentHash);
  }

  promote(photoId: string): VariantFamily {
    const photo = this.photo(photoId);
    this.variants.promote(photo.contentHash, photo.id);
    const family = this.variants.family(photo.contentHash);
    this.deps.changed(family.variants.map((variant) => variant.id));
    return family;
  }

  async duplicate(photoIds: readonly string[]): Promise<DuplicateResult> {
    const created: { sourceId: string; photoId: string; derivatives: DuplicateResult['created'][number]['derivatives'] }[] = [];
    let skipped = 0;
    let unsupported = 0;
    for (const sourceId of photoIds) {
      const source = this.deps.repo.get(sourceId);
      if (source === undefined || source.deletedAt !== null) {
        skipped += 1;
        continue;
      }
      const head = this.revisions.head(source.id).head;
      if (head !== null && head.unsupported !== null) {
        // Fail closed (§3): a stack this build cannot evaluate is neither
        // dropped nor replaced by an identity stand-in that would claim to
        // be the source's presentation.
        unsupported += 1;
        continue;
      }
      const id = this.deps.newId();
      const now = this.deps.now();
      const operations = head === null ? [] : head.operations;
      this.deps.db.transaction(() => {
        this.variants.duplicate(source, id, now);
        if (operations.length > 0) {
          const document: EditRevisionDocument = {
            version: EDIT_REVISION_FORMAT_VERSION,
            id: this.deps.newId(),
            parentId: null,
            operations,
            author: { product: EDIT_AUTHOR_PRODUCT, version: this.deps.appVersion },
            createdAt: now,
            importedFrom: null,
          };
          this.revisions.append(id, document);
        }
        markDirty(this.deps.db, id);
      })();
      const variant = this.deps.repo.get(id);
      if (variant === undefined) throw new Error(`variant ${id} was not created`);
      const derivatives = await this.bake(variant, head === null ? IDENTITY_TRANSFORM : head.transform);
      created.push({ sourceId: source.id, photoId: id, derivatives });
    }
    if (created.length > 0) this.deps.created(created.map((entry) => entry.photoId));
    return { created, skipped, unsupported, pendingCount: this.deps.repo.pendingCount() };
  }

  private async bake(variant: PhotoRecord, transform: EditTransform): Promise<DuplicateResult['created'][number]['derivatives']> {
    let bytes: Buffer | null;
    try {
      bytes = await this.deps.loadOriginal(variant);
    } catch {
      return 'failed';
    }
    if (bytes === null) return 'deferred';
    try {
      const outcome = await this.deps.regenerate(variant, bytes, transform);
      return outcome.generated ? 'regenerated' : 'failed';
    } catch {
      return 'failed';
    } finally {
      bytes.fill(0);
    }
  }

  private photo(photoId: string): PhotoRecord {
    const photo = this.deps.repo.get(photoId);
    if (photo === undefined) throw new Error(`photo ${photoId} not found`);
    return photo;
  }
}
