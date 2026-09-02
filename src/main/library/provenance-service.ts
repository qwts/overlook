import type { ProvenanceRepository } from '../db/provenance-repository.js';
import type { PhotosRepository } from '../db/photos-repository.js';
import type { ProvenancePayload } from '../../shared/ipc/provenance-channels.js';
import { buildProvenanceEvidence, provenanceIsStale, type ProvenanceSource } from '../../shared/library/provenance.js';
import type { PhotoRecord } from '../../shared/library/types.js';

// Provenance evaluation (#495, ADR-0031 §5). Evidence is derived locally
// from the original bytes and any XMP sidecars in custody, bound to the
// subject hash and evaluator version, and stored with the photo. A read
// re-evaluates when the stored record is missing or stale (the bytes or the
// evaluator changed); when the original is not local the stale record is
// still shown, flagged, and the evaluation reports `deferred` instead of
// inventing an Unknown. No path here can reach a network.

export interface ProvenanceServiceDeps {
  readonly repo: PhotosRepository;
  readonly provenance: ProvenanceRepository;
  /** Plaintext original bytes, or null when the original is not local (offloaded). */
  readonly loadOriginal: (photo: PhotoRecord) => Promise<Buffer | null>;
  /** Plaintext XMP sidecars in the photo's custody (may be empty). */
  readonly loadSidecarXmp: (photo: PhotoRecord) => Promise<readonly Buffer[]>;
  readonly extract: (bytes: Buffer, sidecarXmp: readonly Buffer[]) => Promise<readonly ProvenanceSource[]>;
  readonly now: () => string;
  /** A record was written: the backup manifest owes a generation (§7). */
  readonly changed: (photoId: string) => void;
}

export class ProvenanceService {
  constructor(private readonly deps: ProvenanceServiceDeps) {}

  /** The stored record without evaluating anything. */
  current(photoId: string): ProvenancePayload {
    const photo = this.photo(photoId);
    return this.payload(photo, 'evaluated');
  }

  /** The current record, evaluating first when it is missing or stale. */
  async get(photoId: string): Promise<ProvenancePayload> {
    const photo = this.photo(photoId);
    const stored = this.deps.provenance.get(photoId);
    const fresh = stored !== null && stored.evidence !== null && !provenanceIsStale(stored.evidence, photo.contentHash);
    if (fresh || (stored !== null && stored.unsupported !== null)) return this.payload(photo, 'evaluated');
    return this.evaluate(photo);
  }

  /** Re-evaluates unconditionally (the Inspector's Re-check). */
  async refresh(photoId: string): Promise<ProvenancePayload> {
    return this.evaluate(this.photo(photoId));
  }

  private async evaluate(photo: PhotoRecord): Promise<ProvenancePayload> {
    const bytes = await this.deps.loadOriginal(photo);
    if (bytes === null) return this.payload(photo, 'deferred');
    try {
      const sidecars = await this.deps.loadSidecarXmp(photo);
      try {
        const sources = await this.deps.extract(bytes, sidecars);
        const evidence = buildProvenanceEvidence({ subjectHash: photo.contentHash, evaluatedAt: this.deps.now(), sources });
        this.deps.provenance.put(photo.id, evidence);
        this.deps.changed(photo.id);
      } finally {
        for (const sidecar of sidecars) sidecar.fill(0);
      }
    } finally {
      bytes.fill(0);
    }
    return this.payload(photo, 'evaluated');
  }

  private payload(photo: PhotoRecord, status: ProvenancePayload['status']): ProvenancePayload {
    const stored = this.deps.provenance.get(photo.id);
    const evidence = stored?.evidence ?? null;
    return {
      photoId: photo.id,
      evidence,
      unsupported: stored?.unsupported ?? null,
      stale: evidence !== null && provenanceIsStale(evidence, photo.contentHash),
      status,
    };
  }

  private photo(photoId: string): PhotoRecord {
    const photo = this.deps.repo.get(photoId);
    if (photo === undefined) throw new Error(`photo ${photoId} not found`);
    return photo;
  }
}
