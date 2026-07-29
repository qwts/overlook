import { appendFile, readFile, rename, rm, writeFile } from 'node:fs/promises';

import type { ImportFileStage, ImportManifest, ImportJournalUpdate, ManifestFile } from './import-engine.js';

// Staging-manifest persistence (#87): the journal is the crash-safety
// anchor — every per-file stage transition lands on disk and a completed
// batch removes it. On relaunch, a surviving journal means an interrupted
// import to resume.
//
// Format: JSON Lines. Line 1 is a full manifest snapshot; every later line
// is one file's complete state (`{"i":<index>,"file":{...}}`), APPENDED as
// the batch advances — so persisting a 100k-file batch costs O(1) per
// transition instead of rewriting the whole manifest each time (the O(N²)
// rewrite behind the 2026-07 multi-day import freeze). Torn-write safety is
// preserved in both write paths: snapshots go through write-then-rename, and
// an append torn mid-line leaves every previous line intact — read() replays
// updates in order and stops at the first incomplete line. When the replay
// log outgrows the snapshot the journal compacts (fresh snapshot, empty
// log), keeping total I/O linear in batch size. A pre-append single-line
// journal is exactly a snapshot with no log, so old journals resume as-is.

/** Compaction floor: batches whose whole log stays smaller than this never
 * pay for a snapshot rewrite. */
const MIN_COMPACT_LOG = 256;

const STAGES: ReadonlySet<unknown> = new Set<ImportFileStage>(['pending', 'recorded', 'thumbed', 'done']);

function isManifestFile(value: unknown): value is ManifestFile {
  if (typeof value !== 'object' || value === null) return false;
  const file = value as Partial<ManifestFile>;
  return typeof file.path === 'string' && typeof file.fileName === 'string' && STAGES.has(file.stage);
}

function cloneFile(file: ManifestFile): ManifestFile {
  return { ...file, ...(file.moveLease === undefined ? {} : { moveLease: { ...file.moveLease } }) };
}

function cloneManifest(manifest: ImportManifest): ImportManifest {
  return { ...manifest, files: manifest.files.map(cloneFile) };
}

export class ImportJournal {
  /** In-memory mirror of base-snapshot + appended log; what compaction
   * writes. Kept from begin()/read() and advanced by every update(). */
  private snapshot: ImportManifest | null = null;
  private logEntries = 0;

  constructor(private readonly path: string) {}

  async read(): Promise<ImportManifest | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      return null;
    }
    const lines = raw.split('\n');
    let manifest: ImportManifest;
    try {
      const base = JSON.parse(lines[0] ?? '') as ImportManifest;
      if (!Array.isArray(base.files) || typeof base.batchId !== 'string') return null;
      manifest = base;
    } catch {
      return null; // torn/corrupt snapshot — treat as no pending batch
    }
    let replayed = 0;
    for (const line of lines.slice(1)) {
      if (line === '') continue; // the terminator after the final line
      let entry: ImportJournalUpdate;
      try {
        entry = JSON.parse(line) as ImportJournalUpdate;
      } catch {
        break; // torn tail — everything before it is intact
      }
      if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= manifest.files.length || !isManifestFile(entry.file)) {
        break;
      }
      manifest.files[entry.index] = entry.file;
      replayed += 1;
    }
    this.snapshot = cloneManifest(manifest);
    this.logEntries = replayed;
    return manifest;
  }

  /** Starts (or compacts) the journal: one snapshot line, empty log. */
  async begin(manifest: ImportManifest): Promise<void> {
    this.snapshot = cloneManifest(manifest);
    this.logEntries = 0;
    await this.writeSnapshot();
  }

  /** Appends the given files' current state; compacts once the log would
   * outgrow the snapshot, so total journal I/O stays linear in batch size. */
  async update(updates: readonly ImportJournalUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    const snapshot = this.snapshot;
    if (snapshot === null) throw new Error('import journal updated before begin()');
    for (const { index, file } of updates) {
      snapshot.files[index] = cloneFile(file);
    }
    if (this.logEntries + updates.length >= Math.max(MIN_COMPACT_LOG, snapshot.files.length)) {
      await this.writeSnapshot();
      this.logEntries = 0;
      return;
    }
    this.logEntries += updates.length;
    await appendFile(this.path, updates.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8');
  }

  async clear(): Promise<void> {
    this.snapshot = null;
    this.logEntries = 0;
    await rm(this.path, { force: true });
  }

  private async writeSnapshot(): Promise<void> {
    const stage = `${this.path}.tmp`;
    await writeFile(stage, `${JSON.stringify(this.snapshot)}\n`, 'utf8');
    await rename(stage, this.path);
  }
}
