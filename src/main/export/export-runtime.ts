import { access, statfs } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import type { KeyResolver } from '../crypto/envelope.js';
import type { ExportFacade } from '../ipc.js';
import { ExportEngine, writeFileCleanly, type ExportMetadataMode } from './export-engine.js';
import { transcodeToJpeg } from './transcode.js';
import { BoardExportCancelledError, exportBoardPng } from './board-export.js';
import type { PhotoRecord } from '../../shared/library/types.js';
import type { BoardExportRequest, BoardExportResult } from '../../shared/moodboard/export-contract.js';

export type DrainableExportFacade = ExportFacade & { close(): void; drain(): Promise<void> };

export interface ExportRuntimeOptions {
  readonly repo: {
    readonly get: (id: string) => PhotoRecord | undefined;
    readonly exportableIds: () => readonly string[];
  };
  readonly blobs: { readonly getStream: (contentHash: string, resolveKey: KeyResolver, photoId: string) => Readable };
  readonly resolveKey: KeyResolver;
  readonly openOriginal: (photo: PhotoRecord) => Promise<{
    readonly stream: Readable;
    readonly release?: (() => Promise<void>) | undefined;
  }>;
  /** Encrypted companion custody (#484); absent = no sidecar export. */
  readonly sidecarsFor?:
    ((photoId: string) => readonly { readonly fileName: string; readonly contentHash: string; readonly bytes: number }[]) | undefined;
  readonly sidecarStream?: ((photoId: string, contentHash: string) => Readable) | undefined;
  readonly progress: (done: number, total: number) => void;
  readonly pickDestination: () => Promise<string | null>;
}

export function createExportRuntime(options: ExportRuntimeOptions): DrainableExportFacade {
  const engine = new ExportEngine({
    repo: options.repo,
    blobs: options.blobs,
    resolveKey: options.resolveKey,
    openOriginal: options.openOriginal,
    ...(options.sidecarsFor === undefined ? {} : { sidecarsFor: options.sidecarsFor }),
    ...(options.sidecarStream === undefined ? {} : { sidecarStream: options.sidecarStream }),
    writeFile: writeFileCleanly,
    exists: async (filePath) =>
      access(filePath).then(
        () => true,
        () => false,
      ),
    freeBytes: async (dir) => {
      const stats = await statfs(dir);
      return stats.bavail * stats.bsize;
    },
    joinPath: (dir, name) => path.join(dir, name),
    transcodeJpeg: transcodeToJpeg,
    bufferStream: async (stream) => buffer(stream),
    events: { progress: options.progress },
  });
  let controller: AbortController | null = null;
  let turn: Promise<unknown> = Promise.resolve();
  let closed = false;
  const schedule = (
    photoIds: () => readonly string[],
    destination: string,
    format: 'original' | 'jpeg' = 'original',
    metadata: ExportMetadataMode = 'original',
  ) => {
    const task = async () => {
      if (closed) throw new Error('export service is closed');
      controller = new AbortController();
      try {
        const summary = await engine.exportPhotos(photoIds(), destination, controller.signal, format, metadata);
        return {
          exported: summary.exported,
          failed: summary.failed,
          cancelled: summary.cancelled,
          previewTranscodes: summary.previewTranscodes,
          failures: [...summary.failures],
        };
      } finally {
        controller = null;
      }
    };
    const next = turn.then(task, task);
    turn = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const scheduleBoard = (request: BoardExportRequest): Promise<BoardExportResult> => {
    const task = async (): Promise<BoardExportResult> => {
      if (closed) throw new Error('export service is closed');
      controller = new AbortController();
      try {
        return await exportBoardPng(
          request,
          {
            getPhoto: options.repo.get,
            openOriginal: options.openOriginal,
            writeFile: writeFileCleanly,
            exists: async (filePath) =>
              access(filePath).then(
                () => true,
                () => false,
              ),
            freeBytes: async (directory) => {
              const stats = await statfs(directory);
              return stats.bavail * stats.bsize;
            },
            joinPath: (directory, fileName) => path.join(directory, fileName),
            progress: options.progress,
          },
          controller.signal,
        );
      } catch (error) {
        if (!(error instanceof BoardExportCancelledError)) throw error;
        return {
          exported: false,
          cancelled: true,
          rendered: 0,
          skipped: 0,
          skippedLocked: 0,
          skippedUnavailable: 0,
          fileName: null,
          path: null,
        };
      } finally {
        controller = null;
      }
    };
    const next = turn.then(task, task);
    turn = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  return {
    run: (photoIds, destination, format, metadata) => schedule(() => photoIds, destination, format, metadata),
    runAll: (destination, metadata) => schedule(options.repo.exportableIds, destination, 'original', metadata),
    runBoard: scheduleBoard,
    cancel: () => controller?.abort(),
    close: () => {
      closed = true;
      controller?.abort();
    },
    drain: () =>
      turn.then(
        () => undefined,
        () => undefined,
      ),
    pickDestination: options.pickDestination,
  };
}
