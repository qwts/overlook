import { isAbsolute, relative, resolve } from 'node:path';

import {
  defaultVolumeListerDeps,
  folderSource,
  listVolumes,
  scanCandidates,
  scanFiles,
  scanSource,
  type ImportSource,
  type ScannedFile,
  type SourceScanProgress,
  type SourceScanSummary,
} from './source-scanner.js';
import type { GoogleDriveImportSource, GoogleDrivePickFailure, GoogleDriveStagedSelection } from './google-drive-source.js';
import type { ImportEngine, ImportMode, ImportSummary } from './import-engine.js';
import type { PhotosRepository } from '../db/photos-repository.js';

// Import domain service (#84/#87): source discovery, scanning, and batch
// runs behind the typed IPC boundary. The engine owns crash-safety; this
// layer owns "which files" (a fresh scan's NEW files) and event fan-out.

export interface ImportServiceEvents {
  scanProgress(path: string, progress: SourceScanProgress): void;
  copyProgress(done: number, total: number): void;
  thumbProgress(done: number, total: number): void;
  /** Batch landed: ids for the library:changed push + pending recount. */
  imported(photoIds: readonly string[]): void;
}

export interface ImportScanners {
  readonly source: typeof scanSource;
  readonly files: typeof scanFiles;
}

const defaultScanners: ImportScanners = { source: scanSource, files: scanFiles };

export type GoogleDriveImportPickResult =
  | {
      readonly status: 'ready';
      readonly selectionId: string;
      readonly summary: SourceScanSummary;
      readonly skipped: number;
    }
  | { readonly status: GoogleDrivePickFailure };

export class ImportService {
  /** One journal, one writer: batches and resumes run strictly in turn —
   * overlapping runs would overwrite or clear each other's resume state
   * (PR #183 review). */
  private turn: Promise<unknown> = Promise.resolve();
  private controller: AbortController | null = null;
  private readonly scanControllers = new Set<AbortController>();
  private readonly scans = new Set<Promise<unknown>>();
  private readonly googleSelections = new Map<string, GoogleDriveStagedSelection>();
  private readonly selectionCleanups = new Set<Promise<unknown>>();
  private googlePickEpoch = 0;
  private googlePickScanController: AbortController | null = null;
  private closed = false;

  constructor(
    private readonly repo: PhotosRepository,
    private readonly events: ImportServiceEvents,
    private readonly engine: ImportEngine,
    // Test/dev fixture source (#90 → #129 F1): the composition root supplies
    // this ONLY in unpackaged builds (gated via harnessEnv). A packaged app
    // gets no injector, so the fixture folder can never be surfaced by env.
    private readonly fixtureSource: () => string | undefined = () => undefined,
    private readonly scanners: ImportScanners = defaultScanners,
    private readonly googleDrive?: GoogleDriveImportSource,
    private readonly libraryRoot?: string,
  ) {}

  private assertMoveOutsideLibrary(files: readonly { readonly path: string }[], mode: ImportMode): void {
    if (mode !== 'move' || this.libraryRoot === undefined) return;
    const root = resolve(this.libraryRoot);
    if (
      files.some((file) => {
        const relation = relative(root, resolve(file.path));
        return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
      })
    ) {
      throw new Error('Move sources cannot be inside the active library');
    }
  }

  private trackScan<T>(scan: (signal: AbortSignal) => Promise<T>, controller = new AbortController()): Promise<T> {
    if (this.closed) return Promise.reject(new Error('import service is closed'));
    this.scanControllers.add(controller);
    const work = Promise.resolve().then(() => scan(controller.signal));
    this.scans.add(work);
    const remove = (): void => {
      this.scanControllers.delete(controller);
      this.scans.delete(work);
    };
    void work.then(remove, remove);
    return work;
  }

  private async serialize<T>(task: () => Promise<T>): Promise<T> {
    const admitted = (): Promise<T> => {
      if (this.closed) return Promise.reject(new Error('import service is closed'));
      return task();
    };
    const next = this.turn.then(admitted, admitted);
    this.turn = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async listSources(): Promise<ImportSource[]> {
    const sources = await listVolumes(defaultVolumeListerDeps());
    // Harness hook (#90, OVERLOOK_* family): surface a fixture folder as the
    // first source — the mock-file-dialog seam the import E2E drives. The
    // injector is unpackaged-only (#129 F1); it returns undefined otherwise.
    const fixture = this.fixtureSource();
    if (fixture !== undefined && fixture !== '') {
      // The fixture stands in for the mounted card, so it poses as a volume
      // — the dialog's SD segment surfaces it and Move stays testable (#237).
      return [{ ...folderSource(fixture), kind: 'volume' }, ...sources];
    }
    return sources;
  }

  /** The manual choose-folder path shares the source shape. */
  sourceForFolder(path: string): ImportSource {
    return folderSource(path);
  }

  async scanSource(path: string): Promise<SourceScanSummary> {
    const { summary } = await this.trackScan((signal) =>
      this.scanners.source(
        path,
        { hasContentHash: (hash) => this.repo.hasContentHash(hash) },
        (progress) => {
          this.events.scanProgress(path, progress);
        },
        signal,
      ),
    );
    return summary;
  }

  /** Runs a batch over the source's NEW files (fresh scan → engine). */
  async run(path: string, mode: ImportMode): Promise<ImportSummary> {
    return this.serialize(async () => {
      const controller = new AbortController();
      this.controller = controller;
      try {
        // The signal reaches the fresh scan too — Cancel during hashing on a
        // big card must stop the I/O promptly (PR #186 review); the engine
        // then finalizes whatever the truncated scan surfaced as cancelled.
        const { files } = await this.scanners.source(
          path,
          { hasContentHash: (hash) => this.repo.hasContentHash(hash) },
          () => undefined,
          controller.signal,
        );
        const fresh = files
          .filter((file) => file.isNew)
          .map(({ path: filePath, fileName, kind, sidecars }) => ({
            path: filePath,
            fileName,
            kind,
            ...(sidecars.length === 0 ? {} : { sidecars }),
          }));
        this.assertMoveOutsideLibrary(fresh, mode);
        const existing = files.length - fresh.length;
        const result = await this.engine.importFiles(fresh, mode, path, controller.signal);
        const summary = { ...result, duplicates: result.duplicates + existing, retained: result.retained + existing };
        if (summary.photoIds.length > 0) {
          this.events.imported(summary.photoIds);
        }
        return summary;
      } finally {
        this.controller = null;
      }
    });
  }

  /** Dropped files/folders share the same verified per-file Move boundary as
   * selected folders. Expansion never deletes a directory or sibling. */
  async runFiles(paths: readonly string[], mode: ImportMode): Promise<ImportSummary> {
    return this.serialize(async () => {
      const controller = new AbortController();
      this.controller = controller;
      try {
        const { files } = await this.scanners.files(
          paths,
          { hasContentHash: (hash) => this.repo.hasContentHash(hash) },
          () => undefined,
          controller.signal,
        );
        const fresh = files
          .filter((file) => file.isNew)
          .map(({ path: filePath, fileName, kind, sidecars }) => ({
            path: filePath,
            fileName,
            kind,
            ...(sidecars.length === 0 ? {} : { sidecars }),
          }));
        this.assertMoveOutsideLibrary(fresh, mode);
        const existing = files.length - fresh.length;
        const result = await this.engine.importFiles(fresh, mode, 'dropped', controller.signal);
        const summary = { ...result, duplicates: result.duplicates + existing, retained: result.retained + existing };
        if (summary.photoIds.length > 0) {
          this.events.imported(summary.photoIds);
        }
        return summary;
      } finally {
        this.controller = null;
      }
    });
  }

  /** PhotoKit hands Overlook-owned plaintext staging to the ordinary
   * journaled import path. Copy-only keeps the Apple Photos source intact;
   * cleanupPath survives crashes until the journal finishes or resumes. */
  async runPhotoKitFiles(
    assets: readonly {
      readonly path: string;
      readonly createdAt: string | null;
      readonly latitude: number | null;
      readonly longitude: number | null;
    }[],
    cleanupPath: string,
    onJournaled: () => void,
    cleanupPreflightFailure: () => Promise<void>,
  ): Promise<ImportSummary> {
    return this.serialize(async () => {
      const controller = new AbortController();
      this.controller = controller;
      try {
        let files: readonly ScannedFile[];
        try {
          ({ files } = await this.scanners.files(
            assets.map(({ path }) => path),
            { hasContentHash: (hash) => this.repo.hasContentHash(hash) },
            () => undefined,
            controller.signal,
          ));
        } catch (error) {
          await cleanupPreflightFailure().catch((cleanupError: unknown) => {
            console.error('[overlook] PhotoKit preflight cleanup failed', cleanupError);
          });
          throw error;
        }
        const metadata = new Map(assets.map((asset) => [asset.path, asset]));
        const fresh = files
          .filter((file) => file.isNew)
          .map(({ path: filePath, fileName, kind, sidecars }) => {
            const source = metadata.get(filePath);
            const sourceMetadata = {
              ...(source?.createdAt === null || source?.createdAt === undefined ? {} : { takenAt: source.createdAt }),
              ...(source?.latitude === null || source?.latitude === undefined ? {} : { gpsLat: source.latitude }),
              ...(source?.longitude === null || source?.longitude === undefined ? {} : { gpsLon: source.longitude }),
            };
            return {
              path: filePath,
              fileName,
              kind,
              ...(sidecars.length === 0 ? {} : { sidecars }),
              ...(Object.keys(sourceMetadata).length === 0 ? {} : { sourceMetadata }),
            };
          });
        const existing = files.length - fresh.length;
        const scannedPaths = new Set(files.map((file) => file.path));
        const unsupported = assets.filter((asset) => !scannedPaths.has(asset.path)).length;
        const result = await this.engine.importFiles(fresh, 'copy', 'Apple Photos', controller.signal, cleanupPath, onJournaled);
        const summary = {
          ...result,
          duplicates: result.duplicates + existing,
          failed: result.failed + unsupported,
          retained: result.retained + existing + unsupported,
        };
        if (summary.photoIds.length > 0) this.events.imported(summary.photoIds);
        return summary;
      } finally {
        this.controller = null;
      }
    });
  }

  /** Dropped-file scan (#237): the dialog's Dropped card numbers. */
  async scanDropped(paths: readonly string[]): Promise<SourceScanSummary> {
    const { summary } = await this.trackScan((signal) =>
      this.scanners.files(paths, { hasContentHash: (hash) => this.repo.hasContentHash(hash) }, undefined, signal),
    );
    return summary;
  }

  async pickGoogleDrive(): Promise<GoogleDriveImportPickResult> {
    if (this.closed) throw new Error('import service is closed');
    if (this.googleDrive === undefined) return { status: 'unavailable' };
    const epoch = this.googlePickEpoch;
    const picked = await this.googleDrive.pick();
    if (picked.status !== 'ready') return picked;
    if (epoch !== this.googlePickEpoch) {
      await this.googleDrive.discard(picked.selection);
      return { status: 'cancelled' };
    }
    const controller = new AbortController();
    this.googlePickScanController = controller;
    if (epoch !== this.googlePickEpoch) controller.abort();
    try {
      const { summary } = await this.trackScan(
        (signal) => scanCandidates(picked.selection.files, { hasContentHash: (hash) => this.repo.hasContentHash(hash) }, undefined, signal),
        controller,
      );
      if (summary.total === 0) {
        await this.googleDrive.discard(picked.selection);
        return { status: 'no-supported-files' };
      }
      this.googleSelections.set(picked.selection.id, picked.selection);
      return {
        status: 'ready',
        selectionId: picked.selection.id,
        summary,
        skipped: picked.selection.skipped,
      };
    } catch (error) {
      await this.googleDrive.discard(picked.selection);
      if (controller.signal.aborted) return { status: 'cancelled' };
      throw error;
    } finally {
      if (this.googlePickScanController === controller) this.googlePickScanController = null;
    }
  }

  async discardGoogleDrive(selectionId: string): Promise<void> {
    const selection = this.googleSelections.get(selectionId);
    if (selection === undefined || this.googleDrive === undefined) return;
    this.googleSelections.delete(selectionId);
    await this.googleDrive.discard(selection);
  }

  cancelGoogleDrivePick(): void {
    this.googlePickEpoch += 1;
    this.googleDrive?.cancelPick();
    this.googlePickScanController?.abort();
  }

  async runGoogleDrive(selectionId: string): Promise<ImportSummary> {
    const selection = this.googleSelections.get(selectionId);
    if (selection === undefined) throw new Error('Google Drive import selection is unavailable');
    this.googleSelections.delete(selectionId);
    return this.serialize(async () => {
      const controller = new AbortController();
      this.controller = controller;
      try {
        const { files } = await scanCandidates(
          selection.files,
          { hasContentHash: (hash) => this.repo.hasContentHash(hash) },
          undefined,
          controller.signal,
        );
        const fresh = files
          .filter((file) => file.isNew)
          .map(({ path: filePath, fileName, kind, sidecars }) => ({
            path: filePath,
            fileName,
            kind,
            ...(sidecars.length === 0 ? {} : { sidecars }),
          }));
        const summary = await this.engine.importFiles(fresh, 'copy', 'Google Drive', controller.signal, selection.rootPath ?? undefined);
        if (summary.photoIds.length > 0) this.events.imported(summary.photoIds);
        return summary;
      } finally {
        this.controller = null;
      }
    });
  }

  /** Cancel semantics (#88): the engine finishes the file in flight, keeps
   * everything completed, and finalizes the rest as cancelled. */
  cancel(): void {
    this.controller?.abort();
  }

  busy(): boolean {
    return this.controller !== null || this.scans.size > 0 || this.googlePickScanController !== null;
  }

  /** Permanently stops this library-bound instance. Queued batches observe
   * the flag when their serialized turn arrives and never touch custody. */
  close(): void {
    this.closed = true;
    this.controller?.abort();
    this.googleDrive?.cancelPick();
    for (const controller of this.scanControllers) controller.abort();
    if (this.googleDrive !== undefined) {
      for (const selection of this.googleSelections.values()) {
        const cleanup = this.googleDrive.discard(selection);
        this.selectionCleanups.add(cleanup);
        const remove = (): void => {
          this.selectionCleanups.delete(cleanup);
        };
        void cleanup.then(remove, remove);
      }
      this.googleSelections.clear();
    }
  }

  /** Waits for the serialized import/resume queue to stop touching library
   * state. Lock teardown calls cancel() first, then drains before closing DB
   * and key custody. */
  async drain(): Promise<void> {
    await this.turn.then(
      () => undefined,
      () => undefined,
    );
    while (this.scans.size > 0) {
      await Promise.allSettled([...this.scans]);
    }
    while (this.selectionCleanups.size > 0) {
      await Promise.allSettled([...this.selectionCleanups]);
    }
  }

  /** Completes a journaled batch an earlier run left behind (crash-safety:
   * called once at service bootstrap). */
  async resume(): Promise<ImportSummary | null> {
    return this.serialize(async () => {
      const summary = await this.engine.resume();
      if (summary !== null && summary.photoIds.length > 0) {
        this.events.imported(summary.photoIds);
      }
      return summary;
    });
  }
}
