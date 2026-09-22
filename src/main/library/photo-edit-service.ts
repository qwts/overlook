import { previousEditState } from '../../shared/library/edit-revert.js';
import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { EditBakeDebtRepository } from '../db/edit-bake-debt-repository.js';
import { markDirty } from '../backup/sync-ledger.js';
import { EditRevisionRepository, type EditHead } from '../db/edit-revision-repository.js';
import type { PhotosRepository } from '../db/photos-repository.js';
import type { ThumbnailOutcome } from '../import/thumbnail-service.js';
import {
  EDIT_AUTHOR_PRODUCT,
  EDIT_REVISION_FORMAT_VERSION,
  canonicalJson,
  editOperationSchema,
  foldOperations,
  type EditOperation,
  type EditRevisionDocument,
  type EditTransform,
} from '../../shared/library/edit-revision.js';
import type { EditMutationResult } from '../../shared/ipc/photo-edit-channels.js';
import type { PhotoRecord } from '../../shared/library/types.js';

// Persisted edits (#493, ADR-0031 §2). Save appends an immutable revision
// whose parent is the current head and advances the head in one transaction;
// a stack equal to the head's is a no-op (nothing written, nothing dirtied).
// Reset is a new empty revision; Revert is a new revision copying an earlier
// stack — history is append-only. Every head change re-bakes the thumb and
// mid derivatives with the transform and dirties the backup ledger so the
// manifest carries the new revision (§7). Derivative failures never touch
// the durable head: the revision stays authoritative and the derivatives
// are regenerated on the next successful save or repair.

export interface PhotoEditServiceDeps {
  readonly db: BetterSqlite3.Database;
  readonly repo: PhotosRepository;
  /** Plaintext original bytes, or null when the original is not local (offloaded). */
  readonly loadOriginal: (photo: PhotoRecord) => Promise<Buffer | null>;
  readonly regenerate: (photo: PhotoRecord, bytes: Buffer, transform: EditTransform, headId: string) => Promise<ThumbnailOutcome>;
  readonly appVersion: string;
  readonly newId: () => string;
  readonly now: () => string;
  /** The head advanced: invalidate caches, refresh tiles, owe a manifest. */
  readonly changed: (
    photoId: string,
    derivatives: EditMutationResult['derivatives'],
    membership: 'none' | 'library',
    previewStateChanged: boolean,
  ) => void;
}

export type EditMutationKind = 'save' | 'reset' | 'revert';

export class PhotoEditService {
  private readonly bakeDebt: EditBakeDebtRepository;
  private readonly revisions: EditRevisionRepository;

  constructor(private readonly deps: PhotoEditServiceDeps) {
    this.revisions = new EditRevisionRepository(deps.db);
    this.bakeDebt = new EditBakeDebtRepository(deps.db);
  }

  head(photoId: string): EditHead {
    return this.revisions.head(photoId);
  }

  async save(photoId: string, operations: readonly EditOperation[]): Promise<EditMutationResult> {
    return this.advance(
      photoId,
      operations.map((operation) => editOperationSchema.parse(operation)),
    );
  }

  async reset(photoId: string): Promise<EditMutationResult> {
    return this.advance(photoId, []);
  }

  async revert(photoId: string, revisionId?: string): Promise<EditMutationResult> {
    if (revisionId === undefined) {
      const current = this.revisions.head(photoId);
      const target = previousEditState(current.head, current.history);
      if (target === null) throw new Error('no supported earlier edit state');
      return this.advance(photoId, target.operations);
    }
    const row = this.revisions.get(revisionId);
    if (row === null || row.photoId !== photoId) throw new Error(`revision ${revisionId} does not belong to photo ${photoId}`);
    const head = this.revisions.head(photoId);
    const target = head.history.find((revision) => revision.id === revisionId);
    if (target === undefined) throw new Error(`revision ${revisionId} not found`);
    if (target.unsupported !== null) throw new Error(`revision ${revisionId} is unsupported: ${target.unsupported}`);
    return this.advance(photoId, target.operations);
  }

  private async advance(photoId: string, operations: readonly EditOperation[]): Promise<EditMutationResult> {
    const photo = this.deps.repo.get(photoId);
    if (photo === undefined) throw new Error(`photo ${photoId} not found`);
    const current = this.revisions.head(photoId);
    const unchanged =
      current.head === null
        ? operations.length === 0
        : current.head.unsupported === null && canonicalJson(current.head.operations) === canonicalJson(operations);
    if (unchanged) {
      return { ...current, changed: false, derivatives: 'unchanged', pendingCount: this.deps.repo.pendingCount() };
    }
    const document: EditRevisionDocument = {
      version: EDIT_REVISION_FORMAT_VERSION,
      id: this.deps.newId(),
      parentId: current.head?.id ?? null,
      operations,
      author: { product: EDIT_AUTHOR_PRODUCT, version: this.deps.appVersion },
      createdAt: this.deps.now(),
      importedFrom: null,
    };
    this.deps.db.transaction(() => {
      this.revisions.append(photoId, document);
      markDirty(this.deps.db, photoId);
    })();
    const derivatives = await this.bake(photo, foldOperations(operations), document.id);
    let availabilityChanged = false;
    let previewStateChanged = false;
    if (derivatives === 'regenerated' && this.revisions.head(photoId).head?.id === document.id) {
      this.bakeDebt.settle(photoId, document.id);
      const currentPhoto = this.deps.repo.get(photoId);
      previewStateChanged = currentPhoto !== undefined && currentPhoto.previewFailure !== null;
      availabilityChanged = previewStateChanged && currentPhoto?.dimensionStatus !== 'unavailable';
      this.deps.repo.clearPreviewRepairDebt(photoId);
      this.deps.repo.setPreviewFailure(photoId, null);
    }
    this.deps.changed(photoId, derivatives, availabilityChanged ? 'library' : 'none', previewStateChanged);
    return { ...this.revisions.head(photoId), changed: true, derivatives, pendingCount: this.deps.repo.pendingCount() };
  }

  private async bake(photo: PhotoRecord, transform: EditTransform, headId: string): Promise<EditMutationResult['derivatives']> {
    let bytes: Buffer | null;
    try {
      bytes = await this.deps.loadOriginal(photo);
    } catch {
      return 'failed';
    }
    if (bytes === null) return 'deferred';
    try {
      const outcome = await this.deps.regenerate(photo, bytes, transform, headId);
      return outcome.generated ? 'regenerated' : 'failed';
    } catch {
      return 'failed';
    } finally {
      bytes.fill(0);
    }
  }
}
