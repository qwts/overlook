import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import type { KeyResolver } from '../crypto/envelope.js';
import type { TranscodeResult } from './transcode.js';
import type { PhotoRecord } from '../../shared/library/types.js';
import type { PhotoCustodyStatus } from '../../shared/backup/custody-status.js';
import { assetOwnerOf } from '../../shared/library/asset-owner.js';

// Export engine (#97): the decrypt counterpart to import — selected photos
// become real files in a chosen folder. Streaming decrypt straight to the
// destination (plaintext only ever exists where the user asked for it),
// original filenames with a recorded numbered suffix on collision, progress
// n/total per file, and cancellation that finishes the file in flight and
// keeps everything completed. v1 decision (recorded on #97): no
// encrypted-export format — the dialog's decrypt-off switch disables Export.

export type ExportFormat = 'original' | 'jpeg';
export type ExportMetadataMode = 'original' | 'overlook' | 'none';

function xml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}

/** Creates a portable XMP projection of Overlook-authored metadata. The
 * original file and retained source sidecars are never modified. */
export function authoredMetadataXmp(photo: PhotoRecord): Buffer | null {
  if (photo.title === null && photo.description === null && photo.tags.length === 0) return null;
  const title =
    photo.title === null ? '' : `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xml(photo.title)}</rdf:li></rdf:Alt></dc:title>`;
  const description =
    photo.description === null
      ? ''
      : `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xml(photo.description)}</rdf:li></rdf:Alt></dc:description>`;
  const tags =
    photo.tags.length === 0
      ? ''
      : `<dc:subject><rdf:Bag>${photo.tags.map((tag) => `<rdf:li>${xml(tag)}</rdf:li>`).join('')}</rdf:Bag></dc:subject>`;
  return Buffer.from(
    `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/">${title}${description}${tags}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`,
    'utf8',
  );
}

export interface ExportedFile {
  readonly photoId: string;
  readonly fileName: string;
  /** True when a collision forced a numbered suffix. */
  readonly renamed: boolean;
  /** True when a RAW transcoded from its embedded preview (#98) —
   * resolution honestly capped at preview size. */
  readonly fromPreview: boolean;
  /** Companion sidecars written beside this original (#484). */
  readonly sidecarNames: readonly string[];
}

export interface ExportSummary {
  readonly exported: number;
  readonly failed: number;
  readonly cancelled: number;
  /** How many exports were preview-capped RAW transcodes (#98). */
  readonly previewTranscodes: number;
  /** Companion sidecars written beside their originals (#484). */
  readonly sidecarsExported: number;
  readonly files: readonly ExportedFile[];
  /** Every source item that could not produce a destination file. */
  readonly failures: readonly ExportFailure[];
}

export interface ExportFailure {
  readonly photoId: string;
  readonly fileName: string;
  readonly reason: string;
  readonly custody?: PhotoCustodyStatus | undefined;
}

export class ExportPreflightError extends Error {
  override readonly name = 'ExportPreflightError';
}

export interface ExportEngineDeps {
  readonly repo: { readonly get: (id: string) => PhotoRecord | undefined };
  readonly blobs: { readonly getStream: (contentHash: string, resolveKey: KeyResolver, photoId: string) => Readable };
  /** Encrypted companion custody (#484); absent = no sidecar support. Only
   * 'original' format exports companions — a transcode is a baked export
   * whose recipe no longer applies (ADR-0031 §6). */
  readonly sidecarsFor?:
    ((photoId: string) => readonly { readonly fileName: string; readonly contentHash: string; readonly bytes: number }[]) | undefined;
  readonly sidecarStream?: ((photoId: string, contentHash: string) => Readable) | undefined;
  readonly resolveKey: KeyResolver;
  /** Policy-aware original custody. Production uses this so offloaded
   * originals export from verified temporary ciphertext without becoming
   * durable; legacy/unit seams fall back to blobs.getStream. */
  readonly openOriginal?:
    ((photo: PhotoRecord) => Promise<{ readonly stream: Readable; readonly release?: (() => Promise<void>) | undefined }>) | undefined;
  /** Streams plaintext to `path`; rejects on IO failure (fs seam). */
  readonly writeFile: (path: string, plaintext: Readable) => Promise<void>;
  readonly exists: (path: string) => Promise<boolean>;
  /** Free bytes on the destination volume (statfs seam). */
  readonly freeBytes: (dir: string) => Promise<number>;
  readonly joinPath: (dir: string, name: string) => string;
  /** sharp transcode seam (#98) — src/main/export/transcode.ts in prod. */
  readonly transcodeJpeg: (bytes: Buffer, fileKind: PhotoRecord['fileKind']) => Promise<TranscodeResult>;
  /** Buffers a decrypt stream (transcode needs whole files). */
  readonly bufferStream: (stream: Readable) => Promise<Buffer>;
  readonly events: { progress(done: number, total: number): void };
  /** Protected domains supply a redacted sink; ordinary exports retain the
   * existing filename/error diagnostics. */
  readonly failure?: ((photoId: string, error: unknown) => void) | undefined;
  readonly custodyStatus?: ((photoId: string, error: unknown) => Promise<PhotoCustodyStatus | undefined>) | undefined;
}

async function failureCustody(
  resolver: ExportEngineDeps['custodyStatus'],
  photoId: string,
  error: unknown,
): Promise<PhotoCustodyStatus | undefined> {
  try {
    return await resolver?.(photoId, error);
  } catch {
    return undefined;
  }
}

/**
 * The default writeFile seam: streams to `path` (never clobbering), and on
 * ANY failure — ENOSPC past the preflight, device errors, an authentication
 * failure mid-decrypt — removes the partial file so the destination never
 * holds a truncated "original" (PR #194 review).
 */
export async function writeFileCleanly(path: string, plaintext: Readable): Promise<void> {
  try {
    await pipeline(plaintext, createWriteStream(path, { flags: 'wx' }));
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}

/** IMG_4021.RAF + '.jpg' → IMG_4021.jpg */
function reExtension(fileName: string, extension: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot <= 0 ? `${fileName}${extension}` : `${fileName.slice(0, dot)}${extension}`;
}

/** IMG_4021.RAF → IMG_4021 (2).RAF */
function withSuffix(fileName: string, counter: number): string {
  const dot = fileName.lastIndexOf('.');
  return dot <= 0 ? `${fileName} (${String(counter)})` : `${fileName.slice(0, dot)} (${String(counter)})${fileName.slice(dot)}`;
}

export class ExportEngine {
  constructor(private readonly deps: ExportEngineDeps) {}

  async exportPhotos(
    photoIds: readonly string[],
    destination: string,
    signal?: AbortSignal,
    format: ExportFormat = 'original',
    metadata: ExportMetadataMode = 'original',
  ): Promise<ExportSummary> {
    const photos = photoIds.map((id) => this.deps.repo.get(id));
    // Free-space preflight: the sum of plaintext sizes must fit BEFORE any
    // bytes move — a mid-batch ENOSPC helps nobody. Sidecar bytes count too.
    const needed =
      photos.reduce((sum, photo) => sum + (photo?.bytes ?? 0), 0) +
      (format === 'original' && metadata === 'original'
        ? photos.reduce(
            (sum, photo) =>
              sum +
              (photo === undefined ? 0 : (this.deps.sidecarsFor?.(photo.id) ?? []).reduce((inner, sidecar) => inner + sidecar.bytes, 0)),
            0,
          )
        : 0) +
      (metadata === 'overlook'
        ? photos.reduce((sum, photo) => sum + (photo === undefined ? 0 : (authoredMetadataXmp(photo)?.length ?? 0)), 0)
        : 0);
    const free = await this.deps.freeBytes(destination);
    if (needed > free) {
      throw new ExportPreflightError(`destination needs ${String(needed)} bytes free, has ${String(free)}`);
    }

    const files: ExportedFile[] = [];
    const failures: ExportFailure[] = [];
    const total = photoIds.length;
    let done = 0;
    let failed = 0;
    let cancelled = 0;
    for (const [index, id] of photoIds.entries()) {
      if (signal?.aborted === true) {
        // Cancel finishes the file in flight (we only check between files)
        // and keeps everything completed.
        cancelled = total - index;
        break;
      }
      const photo = photos[index];
      let releaseOriginal: (() => Promise<void>) | undefined;
      try {
        if (photo === undefined) {
          throw new Error(`photo ${id} is not in the library`);
        }
        const opened = this.deps.openOriginal === undefined ? null : await this.deps.openOriginal(photo);
        const stream = opened?.stream ?? this.deps.blobs.getStream(photo.contentHash, this.deps.resolveKey, assetOwnerOf(photo));
        releaseOriginal = opened?.release;
        let plaintext: Readable = stream;
        let targetName = photo.fileName;
        let fromPreview = false;
        if (format === 'jpeg') {
          const { jpeg, fromPreview: capped } = await this.deps.transcodeJpeg(await this.deps.bufferStream(stream), photo.fileKind);
          plaintext = Readable.from([jpeg]);
          targetName = reExtension(photo.fileName, '.jpg');
          fromPreview = capped;
        }
        const fileName = await this.resolveCollision(destination, targetName);
        await this.deps.writeFile(this.deps.joinPath(destination, fileName), plaintext);
        const sidecarNames =
          metadata === 'overlook'
            ? await this.exportAuthoredMetadata(photo, destination, fileName)
            : metadata === 'original' && format === 'original'
              ? await this.exportSidecars(photo, destination, fileName)
              : [];
        files.push({ photoId: photo.id, fileName, renamed: fileName !== targetName, fromPreview, sidecarNames });
      } catch (error) {
        failed += 1;
        const reason = error instanceof Error ? error.message : String(error);
        const custody = photo === undefined ? undefined : await failureCustody(this.deps.custodyStatus, photo.id, error);
        failures.push({ photoId: id, fileName: photo?.fileName ?? id, reason, ...(custody === undefined ? {} : { custody }) });
        if (this.deps.failure === undefined) {
          console.error(`[overlook] export failed for ${photo?.fileName ?? id}: ${reason}`);
        } else {
          this.deps.failure(id, error);
        }
      } finally {
        await releaseOriginal?.();
      }
      done += 1;
      this.deps.events.progress(done, total);
    }
    return {
      exported: files.length,
      failed,
      cancelled,
      previewTranscodes: files.filter((file) => file.fromPreview).length,
      sidecarsExported: files.reduce((sum, file) => sum + file.sidecarNames.length, 0),
      files,
      failures,
    };
  }

  /** Writes each companion beside the exported original, named from the
   * original's RESOLVED stem so a suffixed export keeps its group together
   * (`IMG (2).RAF` → `IMG (2).xmp`), with per-file collision fallback. */
  private async exportSidecars(photo: PhotoRecord, destination: string, resolvedName: string): Promise<readonly string[]> {
    const sidecars = this.deps.sidecarsFor?.(photo.id) ?? [];
    if (sidecars.length === 0 || this.deps.sidecarStream === undefined) return [];
    const dot = resolvedName.lastIndexOf('.');
    const stem = dot <= 0 ? resolvedName : resolvedName.slice(0, dot);
    const written: string[] = [];
    for (const sidecar of sidecars) {
      const sidecarDot = sidecar.fileName.lastIndexOf('.');
      const extension = sidecarDot <= 0 ? '' : sidecar.fileName.slice(sidecarDot);
      const target = await this.resolveCollision(destination, `${stem}${extension}`);
      await this.deps.writeFile(this.deps.joinPath(destination, target), this.deps.sidecarStream(photo.id, sidecar.contentHash));
      written.push(target);
    }
    return written;
  }

  private async exportAuthoredMetadata(photo: PhotoRecord, destination: string, resolvedName: string): Promise<readonly string[]> {
    const xmp = authoredMetadataXmp(photo);
    if (xmp === null) return [];
    const dot = resolvedName.lastIndexOf('.');
    const stem = dot <= 0 ? resolvedName : resolvedName.slice(0, dot);
    const target = await this.resolveCollision(destination, `${stem}.xmp`);
    await this.deps.writeFile(this.deps.joinPath(destination, target), Readable.from([xmp]));
    return [target];
  }

  private async resolveCollision(destination: string, fileName: string): Promise<string> {
    if (!(await this.deps.exists(this.deps.joinPath(destination, fileName)))) {
      return fileName;
    }
    for (let counter = 1; ; counter += 1) {
      const candidate = withSuffix(fileName, counter);
      if (!(await this.deps.exists(this.deps.joinPath(destination, candidate)))) {
        return candidate;
      }
    }
  }
}
