import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import type { ExtractedMetadata } from './exif.js';
import type { ThumbnailOutcome, ThumbnailRequest } from './thumbnail-service.js';
import type { EnvelopeKey, KeyResolver } from '../crypto/envelope.js';
import type { SidecarRecord } from '../db/sidecar-repository.js';
import { probeMediaInfo, sniffImageKind, sniffVideoKind } from '../../shared/library/media-signatures.js';
import type { MediaInfo } from '../../shared/library/media-info.js';
import type { SidecarRole } from '../../shared/library/sidecar-files.js';
import type { FileKind, PhotoInsert, PhotoRecord } from '../../shared/library/types.js';

// Import engine (#87): source files → encrypted, verified library records —
// interruptible at any point without loss. The journal (import-journal.ts)
// records every per-file stage transition; a relaunch resumes the batch and
// every stage is safe to redo: content-hash dedupe skips finished files, the
// blob store's no-replace publish tolerates re-stores, and a row committed
// under our own photoId is recognized and carried forward instead of
// re-inserted. Move deletes a source file ONLY after that file's blob
// verifies by full decrypt-and-rehash AND its row is committed — per file,
// never end-of-batch, so a crash mid-import never costs an unverified file.

export type ImportMode = 'copy' | 'move';

/** pending → recorded (blob + row committed) → thumbed → done. Duplicates
 * and failures jump straight to done with their status set. */
export type ImportFileStage = 'pending' | 'recorded' | 'thumbed' | 'done';

/** One companion's journaled custody state (#484): contentHash lands after
 * the encrypted put; sourceDeleted after the verified Move delete. */
export interface ManifestSidecar {
  readonly path: string;
  readonly fileName: string;
  readonly role: SidecarRole;
  contentHash?: string | undefined;
  sourceDeleted?: boolean | undefined;
}

export interface ManifestFile {
  readonly path: string;
  readonly fileName: string;
  readonly kind: FileKind;
  stage: ImportFileStage;
  status?: 'imported' | 'duplicate' | 'failed' | 'cancelled' | undefined;
  contentHash?: string | undefined;
  photoId?: string | undefined;
  error?: string | undefined;
  moveLease?: MoveCompensationCandidate | undefined;
  sidecars?: ManifestSidecar[] | undefined;
}

export interface MoveCompensationCandidate {
  readonly photoId: string;
  readonly contentHash: string;
  readonly sourcePath: string;
  readonly byteCharge: number;
  readonly parentIdentity: string;
}

export interface ImportManifest {
  readonly batchId: string;
  readonly mode: ImportMode;
  readonly source: string;
  /** Private staged cloud source; removed only after the journal clears. */
  readonly cleanupPath?: string | undefined;
  readonly files: ManifestFile[];
}

export interface ImportSummary {
  readonly imported: number;
  /** Imported sources deleted after verified encrypted custody. */
  readonly moved: number;
  /** Sources intentionally left in place (Copy, duplicate, failed, or cancelled). */
  readonly retained: number;
  readonly duplicates: number;
  readonly failed: number;
  /** User-cancelled remainder — never started, sources untouched (#88). */
  readonly cancelled: number;
  /** Companion sidecars in verified encrypted custody (#484). */
  readonly sidecars: number;
  readonly photoIds: readonly string[];
  /** Main-process-only inverse custody; IPC response schemas discard it. */
  readonly moveCompensations: readonly MoveCompensationCandidate[];
}

export interface ImportProgressEvents {
  /** Aggregate stream 1 (dialog contract): copy+encrypt+record, n/total. */
  copyProgress(done: number, total: number): void;
  /** Aggregate stream 2: thumbnails, n/total. */
  thumbProgress(done: number, total: number): void;
}

/** One file's complete journaled state, addressed by manifest position. */
export interface ImportJournalUpdate {
  readonly index: number;
  readonly file: ManifestFile;
}

/** Persistence contract (import-journal.ts): per-file transitions APPEND —
 * a batch of any size never rewrites its whole manifest per stage. */
export interface ImportJournalStore {
  readonly read: () => Promise<ImportManifest | null>;
  readonly begin: (manifest: ImportManifest) => Promise<void>;
  readonly update: (updates: readonly ImportJournalUpdate[]) => Promise<void>;
  readonly clear: () => Promise<void>;
}

export interface ImportEngineDeps {
  /** Returns an owned plaintext buffer; the engine zeroizes it after use. */
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly deleteFile: (path: string) => Promise<void>;
  readonly journal: ImportJournalStore;
  readonly repo: {
    readonly hasContentHash: (hash: string) => boolean;
    readonly get: (id: string) => PhotoRecord | undefined;
    readonly insert: (photo: PhotoInsert) => void;
    /** Idempotent per (photo, content) — resume-safe (#484). */
    readonly insertSidecar: (record: SidecarRecord) => void;
    readonly repairGeneratedDimensions: (id: string, width: number, height: number) => boolean;
    readonly setDimensionStatus: (id: string, status: PhotoRecord['dimensionStatus']) => boolean;
    readonly setPreviewFailure: (id: string, failure: PhotoRecord['previewFailure']) => boolean;
  };
  readonly blobs: {
    readonly putOriginal: (
      plaintext: Readable,
      key: EnvelopeKey,
      photoId: string,
    ) => Promise<{ readonly keyId: number; readonly bytes: number }>;
    readonly verifyOriginal: (contentHash: string, resolveKey: KeyResolver, photoId: string) => Promise<boolean>;
    readonly putSidecar: (
      plaintext: Readable,
      key: EnvelopeKey,
      photoId: string,
    ) => Promise<{ readonly contentHash: string; readonly keyId: number; readonly bytes: number }>;
    readonly verifySidecar: (photoId: string, contentHash: string, resolveKey: KeyResolver) => Promise<boolean>;
  };
  readonly generateThumbs: (request: ThumbnailRequest) => Promise<ThumbnailOutcome>;
  readonly extractMetadata: (bytes: Buffer, kind: FileKind) => Promise<ExtractedMetadata>;
  readonly currentKey: () => EnvelopeKey;
  readonly resolveKey: KeyResolver;
  readonly newId: () => string;
  readonly now: () => string;
  readonly events: ImportProgressEvents;
  readonly cleanupSource?: ((path: string) => Promise<void>) | undefined;
  readonly sourceExists: (path: string) => boolean;
  readonly parentIdentity: (path: string) => Promise<string>;
}

export interface ImportFileInput {
  readonly path: string;
  readonly fileName: string;
  readonly kind: FileKind;
  /** Companions discovered beside the file (#484); absent for sources
   * without filesystem adjacency. */
  readonly sidecars?: readonly { readonly path: string; readonly fileName: string; readonly role: SidecarRole }[];
}

export class ImportEngine {
  constructor(private readonly deps: ImportEngineDeps) {}

  /** Resumes a journaled interrupted batch; null when there is none. */
  async resume(signal?: AbortSignal): Promise<ImportSummary | null> {
    const manifest = await this.deps.journal.read();
    if (manifest === null) {
      return null;
    }
    // Re-begin = compaction: one fresh snapshot, so the replay log can never
    // grow without bound across repeated crash/resume cycles.
    await this.deps.journal.begin(manifest);
    return this.run(manifest, signal);
  }

  async importFiles(
    files: readonly ImportFileInput[],
    mode: ImportMode,
    source: string,
    signal?: AbortSignal,
    cleanupPath?: string,
  ): Promise<ImportSummary> {
    const manifest: ImportManifest = {
      batchId: this.deps.newId(),
      mode,
      source,
      ...(cleanupPath === undefined ? {} : { cleanupPath }),
      files: files.map((file) => ({
        path: file.path,
        fileName: file.fileName,
        kind: file.kind,
        stage: 'pending' as const,
        ...(file.sidecars === undefined || file.sidecars.length === 0
          ? {}
          : { sidecars: file.sidecars.map((sidecar) => ({ ...sidecar })) }),
      })),
    };
    await this.deps.journal.begin(manifest);
    return this.run(manifest, signal);
  }

  private async run(manifest: ImportManifest, signal?: AbortSignal): Promise<ImportSummary> {
    const total = manifest.files.length;
    // Progress counters advance with each stage transition — emitting is
    // O(1), never a scan of the whole batch per event.
    let copied = manifest.files.filter((file) => file.stage !== 'pending').length;
    let thumbed = manifest.files.filter((file) => file.stage === 'thumbed' || file.stage === 'done').length;
    const setStage = (file: ManifestFile, stage: ImportFileStage): void => {
      if (file.stage === 'pending' && stage !== 'pending') copied += 1;
      if (file.stage !== 'thumbed' && file.stage !== 'done' && (stage === 'thumbed' || stage === 'done')) thumbed += 1;
      file.stage = stage;
    };
    const emitProgress = (): void => {
      this.deps.events.copyProgress(copied, total);
      this.deps.events.thumbProgress(thumbed, total);
    };
    for (const [index, file] of manifest.files.entries()) {
      if (signal?.aborted === true) {
        // User cancel (#88 semantics): the current file already finished —
        // keep everything completed, finalize the rest as cancelled, and
        // clear the journal below. (A CRASH leaves no abort signal; its
        // journal survives untouched for resume.)
        const finalized: ImportJournalUpdate[] = [];
        for (const [remainingIndex, remaining] of manifest.files.entries()) {
          if (remaining.stage === 'pending' && remaining.status === undefined) {
            remaining.status = 'cancelled';
            setStage(remaining, 'done');
            finalized.push({ index: remainingIndex, file: remaining });
          }
        }
        await this.deps.journal.update(finalized);
        emitProgress();
        break;
      }
      if (file.stage === 'done') {
        continue;
      }
      const persist = async (): Promise<void> => {
        await this.deps.journal.update([{ index, file }]);
        emitProgress();
      };
      try {
        await this.advance(file, manifest, setStage, persist);
      } catch (error) {
        // A per-file failure is recorded and the batch continues; the source
        // file is never deleted on any failed path (cleanup is the LAST
        // stage and only runs after verification).
        file.error = error instanceof Error ? error.message : String(error);
        // Surfaced in the main-process log — the summary only carries counts.
        console.error(`[overlook] import failed for ${file.fileName}: ${file.error}`);
        if (file.status === 'imported') {
          // The row is committed — this photo IS in the library (PR #183
          // review). Keep it imported and leave the stage where it failed:
          // the retained journal retries the remaining stages on resume.
        } else {
          file.status = 'failed';
          setStage(file, 'done');
        }
        await persist();
      }
    }
    if (manifest.files.every((file) => file.stage === 'done')) {
      emitProgress();
      await this.deps.journal.clear(); // batch complete — clear journal
      if (manifest.cleanupPath !== undefined) {
        // Cleanup cannot change a completed import into a failure. A leftover
        // private stage is reaped at the next startup.
        await this.deps.cleanupSource?.(manifest.cleanupPath).catch((error: unknown) => {
          console.error('[overlook] import staging cleanup failed', error);
        });
      }
    }
    const imported = manifest.files.filter((file) => file.status === 'imported').length;
    const moved =
      manifest.mode === 'move' ? manifest.files.filter((file) => file.status === 'imported' && file.stage === 'done').length : 0;
    return {
      imported,
      moved,
      retained: manifest.files.length - moved,
      duplicates: manifest.files.filter((file) => file.status === 'duplicate').length,
      failed: manifest.files.filter((file) => file.status === 'failed').length,
      cancelled: manifest.files.filter((file) => file.status === 'cancelled').length,
      sidecars: manifest.files
        .filter((file) => file.status === 'imported')
        .reduce((sum, file) => sum + (file.sidecars?.filter((sidecar) => sidecar.contentHash !== undefined).length ?? 0), 0),
      photoIds: manifest.files.flatMap((file) => (file.status === 'imported' && file.photoId !== undefined ? [file.photoId] : [])),
      moveCompensations: manifest.files.flatMap((file) => (file.stage === 'done' && file.moveLease !== undefined ? [file.moveLease] : [])),
    };
  }

  private async advance(
    file: ManifestFile,
    manifest: ImportManifest,
    setStage: (file: ManifestFile, stage: ImportFileStage) => void,
    persist: () => Promise<void>,
  ): Promise<void> {
    if (manifest.mode === 'move' && file.stage === 'thumbed' && file.moveLease !== undefined && !this.deps.sourceExists(file.path)) {
      const verified = await this.deps.blobs.verifyOriginal(file.moveLease.contentHash, this.deps.resolveKey, file.moveLease.photoId);
      if (!verified) throw new Error(`blob verification failed for ${file.fileName}; source recovery remains pending`);
      // The original's source is already gone; companion sources may remain
      // from a crash between the two deletes (#484).
      await this.deleteMovedSidecarSources(file, manifest, persist);
      setStage(file, 'done');
      await persist();
      return;
    }
    const bytes = await this.deps.readFile(file.path);
    try {
      const contentHash = createHash('sha256').update(bytes).digest('hex');
      file.contentHash = contentHash;
      // Signature-first classification (ADR-0026 §2): the scanner's
      // extension-derived kind is a hint; recognized byte signatures win, so
      // a spoofed suffix records the format the bytes actually are. The name
      // and extension stay untouched (custody, §4). Deterministic from bytes,
      // so resumed batches re-derive the same answer.
      // Video kinds are signature-confirmed too (0x47 TS cadence, #548): a
      // still-image signature wins first, then a container signature, and only
      // then the extension hint — so a valid transport stream classifies as
      // video by content, while a spoofed `.ts` that is really a JPEG records
      // jpeg (ADR-0026 §2).
      const sniffed = sniffImageKind(bytes) ?? sniffVideoKind(bytes);
      // Container kinds (video/audio) MUST be confirmed by content. A suffix-only
      // `.ts`/`.mts`/`.m2ts` that is neither an image nor a valid transport
      // stream is not an import candidate (ADR-0026 §2): reject it as a failed
      // item — no partial row, never a suffix-classified fake video.
      if (sniffed === null && (file.kind === 'video' || file.kind === 'audio')) {
        throw new Error(`${file.fileName}: content is not a recognized media signature`);
      }
      const kind = sniffed ?? file.kind;
      const mediaInfo = probeMediaInfo(bytes, kind);

      if (file.stage === 'pending') {
        // A resumed file whose row already committed under OUR photoId (crash
        // in the insert→journal window) is ours to finish, not a duplicate.
        if (file.photoId !== undefined && this.deps.repo.get(file.photoId) !== undefined) {
          file.status = 'imported';
          setStage(file, 'recorded');
          await persist();
        } else if (this.deps.repo.hasContentHash(contentHash)) {
          file.status = 'duplicate';
          setStage(file, 'done');
          await persist();
          return;
        } else {
          // Journal the id BEFORE the side effects so a resume can recognize
          // its own half-finished work.
          file.photoId ??= this.deps.newId();
          await persist();
          const key = this.deps.currentKey();
          const ref = await this.deps.blobs.putOriginal(Readable.from([bytes]), key, file.photoId);
          const meta = await this.deps.extractMetadata(bytes, kind);
          // Single transaction per file (repo.insert): the row and its dirty
          // sync-ledger entry commit together or not at all — partial records
          // are never visible to queries.
          this.deps.repo.insert(this.toRecord(file, kind, mediaInfo, manifest.source, meta, ref.bytes, ref.keyId));
          file.status = 'imported';
          setStage(file, 'recorded');
          await persist();
        }
      }

      if (file.stage === 'recorded') {
        // Companion custody (#484) rides the recorded stage so a resume redoes
        // it safely: putSidecar's no-replace publish and the OR IGNORE row
        // insert are both idempotent. Sidecar bytes never persist as durable
        // plaintext — read, encrypt, zeroize.
        await this.importSidecars(file, persist);
        // Idempotent on resume: putThumb's no-replace publish tolerates redone
        // derivatives; a placeholder outcome is an imported photo, not a fail.
        const outcome = await this.deps.generateThumbs({
          photoId: file.photoId ?? '',
          bytes,
          contentHash,
          key: this.deps.currentKey(),
          fileKind: kind,
        });
        if (outcome.width !== null && outcome.height !== null) {
          this.deps.repo.repairGeneratedDimensions(file.photoId ?? '', outcome.width, outcome.height);
        } else {
          this.deps.repo.setDimensionStatus(file.photoId ?? '', 'unavailable');
        }
        if (kind === 'heic' || kind === 'gif' || kind === 'webp') {
          // Formats whose poster comes from decoding the original directly:
          // a placeholder outcome is an imported photo with an honest,
          // actionable display state (ADR-0026 §6), never a failed import.
          this.deps.repo.setPreviewFailure(file.photoId ?? '', outcome.generated ? null : (outcome.failure ?? 'decode-failed'));
        }
        setStage(file, 'thumbed');
        await persist();
      }

      if (file.stage === 'thumbed') {
        if (manifest.mode === 'move') {
          // The Move contract (README §5): the source is deleted only after
          // THIS file's blob decrypts and re-hashes clean — never sooner.
          const verified = await this.deps.blobs.verifyOriginal(contentHash, this.deps.resolveKey, file.photoId ?? '');
          if (!verified) {
            throw new Error(`blob verification failed for ${file.fileName}; source retained`);
          }
          file.moveLease = {
            photoId: file.photoId ?? '',
            contentHash,
            sourcePath: file.path,
            byteCharge: bytes.length,
            parentIdentity: await this.deps.parentIdentity(file.path),
          };
          // Persist inverse custody before the cross-filesystem delete. A
          // restart can finish from the verified encrypted original even if
          // the process dies immediately after unlink succeeds.
          await persist();
          await this.deps.deleteFile(file.path);
          // Companion sources go the same way: verified encrypted custody
          // first, delete second, per sidecar (#484).
          await this.deleteMovedSidecarSources(file, manifest, persist);
        }
        setStage(file, 'done');
        await persist();
      }
    } finally {
      bytes.fill(0);
    }
  }

  /** Encrypts each companion into the photo's sidecar custody and records
   * its row (#484). Idempotent: no-replace publish + OR IGNORE insert. A
   * vanished/unreadable companion fails the file honestly (the photo's own
   * row stays imported; resume retries). */
  private async importSidecars(file: ManifestFile, persist: () => Promise<void>): Promise<void> {
    const sidecars = file.sidecars ?? [];
    if (sidecars.length === 0 || file.photoId === undefined) return;
    let changed = false;
    for (const sidecar of sidecars) {
      if (sidecar.contentHash !== undefined) continue;
      const bytes = await this.deps.readFile(sidecar.path);
      try {
        const key = this.deps.currentKey();
        const ref = await this.deps.blobs.putSidecar(Readable.from([bytes]), key, file.photoId);
        this.deps.repo.insertSidecar({
          photoId: file.photoId,
          role: sidecar.role,
          fileName: sidecar.fileName,
          contentHash: ref.contentHash,
          bytes: ref.bytes,
          keyId: ref.keyId,
          importedAt: this.deps.now(),
        });
        sidecar.contentHash = ref.contentHash;
        changed = true;
      } finally {
        bytes.fill(0);
      }
    }
    if (changed) await persist();
  }

  /** Move mode: a companion source is deleted only after ITS encrypted copy
   * decrypts and re-hashes clean — same per-file contract as the original.
   * A source shared across owners (an XMP beside a RAW+JPG pair attaches to
   * both) is deleted only by its LAST pending owner (PR #849 review): an
   * early unlink would strand the next owner's custody read after its photo
   * row already committed. */
  private async deleteMovedSidecarSources(file: ManifestFile, manifest: ImportManifest, persist: () => Promise<void>): Promise<void> {
    const sidecars = file.sidecars ?? [];
    if (sidecars.length === 0 || file.photoId === undefined) return;
    let changed = false;
    for (const sidecar of sidecars) {
      if (sidecar.contentHash === undefined || sidecar.sourceDeleted === true) continue;
      if (!this.deps.sourceExists(sidecar.path)) {
        sidecar.sourceDeleted = true;
        changed = true;
        continue;
      }
      if (this.sidecarSourceStillNeeded(sidecar.path, file, manifest)) {
        continue; // a later owner still has to read it; that owner deletes
      }
      const verified = await this.deps.blobs.verifySidecar(file.photoId, sidecar.contentHash, this.deps.resolveKey);
      if (!verified) {
        throw new Error(`sidecar verification failed for ${sidecar.fileName}; source retained`);
      }
      await this.deps.deleteFile(sidecar.path);
      sidecar.sourceDeleted = true;
      changed = true;
    }
    if (changed) await persist();
  }

  /** True while another non-terminal manifest file references the same
   * companion source without recorded custody yet. */
  private sidecarSourceStillNeeded(path: string, current: ManifestFile, manifest: ImportManifest): boolean {
    return manifest.files.some(
      (other) =>
        other !== current &&
        other.stage !== 'done' &&
        (other.sidecars ?? []).some((sidecar) => sidecar.path === path && sidecar.contentHash === undefined),
    );
  }

  private toRecord(
    file: ManifestFile,
    kind: FileKind,
    mediaInfo: MediaInfo | null,
    source: string,
    meta: ExtractedMetadata,
    bytes: number,
    keyId: number,
  ): PhotoInsert {
    return {
      id: file.photoId ?? '',
      fileName: file.fileName,
      fileKind: kind,
      mediaInfo,
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      bytes,
      contentHash: file.contentHash ?? '',
      camera: meta.camera,
      lens: meta.lens,
      iso: meta.iso,
      aperture: meta.aperture,
      shutter: meta.shutter,
      focalLength: meta.focalLength,
      takenAt: meta.takenAt,
      gpsLat: meta.gpsLat,
      gpsLon: meta.gpsLon,
      place: null, // never fabricated — GPS is stored, not geocoded (ADR-0006)
      importedAt: this.deps.now(),
      importSource: source,
      keyId,
    };
  }
}
