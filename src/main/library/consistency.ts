// Consistency scan + orphan repair (#125): systematic proof the library
// never lies after a crash. scan() only observes; repair() fixes what is
// SAFE and reports the rest:
//   - orphan blobs/thumbs (no row owns the hash)  → removed
//   - staging leftovers (crash mid-put, AGE-GATED) → removed
//   - lying rows (original missing, status not offloaded):
//       remote copy verified present → status 'offloaded' (rehydratable)
//       remote absent                → status 'error' (surfaced in the UI
//         as the red glyph — the honest v1 of the repair prompt; recorded)

/** Anything younger than this is presumed a LIVE write, never reaped —
 * imports publish blobs before inserting rows, and puts stage in tmp/
 * (PR #223 review). */
export const LEFTOVER_MIN_AGE_MS = 60 * 60 * 1000;

export interface LyingRow {
  readonly photoId: string;
  readonly contentHash: string;
  readonly remoteBacked: boolean;
}

export interface ConsistencyReport {
  readonly orphanOriginals: readonly string[];
  readonly orphanThumbs: readonly string[];
  /** Companion blobs owned by no photo_sidecars row (#484), as
   * `photoId:hash` labels. */
  readonly orphanSidecars: readonly string[];
  readonly stagedLeftovers: readonly string[];
  readonly lyingRows: readonly LyingRow[];
}

export interface RepairSummary extends ConsistencyReport {
  readonly repairedToOffloaded: number;
  readonly markedError: number;
}

export interface ConsistencyDeps {
  readonly rows: () => readonly { id: string; contentHash: string; syncState: string }[];
  /** Owned companion custody (#484): `photoId:hash` pairs from
   * photo_sidecars. Absent = no sidecar support (pre-#484 callers). */
  readonly ownedSidecars?: (() => readonly { photoId: string; contentHash: string }[]) | undefined;
  /** Ownership-only references that must prevent orphan cleanup but must not
   * appear in row diagnostics or repair audit output. */
  readonly hiddenOwnedHashes?: (() => readonly string[]) | undefined;
  readonly blobs: {
    readonly listOriginalHashes: () => Promise<{ hash: string; ageMs: number }[]>;
    readonly listThumbHashes: () => Promise<{ hash: string; ageMs: number }[]>;
    readonly listSidecarEntries?: (() => Promise<{ photoId: string; hash: string; ageMs: number }[]>) | undefined;
    readonly deleteSidecars?: ((photoId: string) => Promise<void>) | undefined;
    readonly listStaged: () => Promise<{ name: string; ageMs: number }[]>;
    readonly hasOriginal: (hash: string) => boolean;
    readonly deleteOriginal: (hash: string) => Promise<void>;
    readonly deleteThumbs: (hash: string) => Promise<void>;
    readonly removeStaged: (name: string) => Promise<void>;
  };
  /** Verified remote presence (provider.verify) — never assume. */
  readonly remoteHas: (hash: string) => Promise<boolean>;
  readonly setStatus: (photoId: string, status: 'offloaded' | 'error') => void;
  readonly libraryChanged: (photoIds: readonly string[]) => void;
  readonly audit: (line: string) => void;
}

export class ConsistencyChecker {
  constructor(private readonly deps: ConsistencyDeps) {}

  /** Observe-only: detect DB↔blob↔ledger drift. */
  async scan(): Promise<ConsistencyReport> {
    const rows = this.deps.rows();
    const owned = new Set([...rows.map((row) => row.contentHash), ...(this.deps.hiddenOwnedHashes?.() ?? [])]);
    // Age-gated like staging: a just-published blob whose row hasn't
    // committed yet is a live import, not an orphan (PR #223 review).
    const orphanOriginals = (await this.deps.blobs.listOriginalHashes())
      .filter((entry) => !owned.has(entry.hash) && entry.ageMs > LEFTOVER_MIN_AGE_MS)
      .map((entry) => entry.hash);
    const orphanThumbs = (await this.deps.blobs.listThumbHashes())
      .filter((entry) => !owned.has(entry.hash) && entry.ageMs > LEFTOVER_MIN_AGE_MS)
      .map((entry) => entry.hash);
    // LIVE puts stage in the same directory — only old strands are
    // leftovers (a startup scan once reaped an in-flight seed write).
    // Sidecar custody is per photo (#484): a companion is orphaned when no
    // photo_sidecars row names its exact (photoId, hash) pair — same age
    // gate, because companions publish before the owning row commits.
    const ownedSidecars = new Set((this.deps.ownedSidecars?.() ?? []).map((entry) => `${entry.photoId}:${entry.contentHash}`));
    const orphanSidecars =
      this.deps.blobs.listSidecarEntries === undefined
        ? []
        : (await this.deps.blobs.listSidecarEntries())
            .filter((entry) => !ownedSidecars.has(`${entry.photoId}:${entry.hash}`) && entry.ageMs > LEFTOVER_MIN_AGE_MS)
            .map((entry) => `${entry.photoId}:${entry.hash}`);
    const stagedLeftovers = (await this.deps.blobs.listStaged())
      .filter((entry) => entry.ageMs > LEFTOVER_MIN_AGE_MS)
      .map((entry) => entry.name);
    const lyingRows: LyingRow[] = [];
    for (const row of rows) {
      // Offloaded rows are SUPPOSED to have no local original; anything
      // else claiming one it doesn't have is lying to the grid/lightbox.
      if (row.syncState !== 'offloaded' && row.syncState !== 'error' && !this.deps.blobs.hasOriginal(row.contentHash)) {
        lyingRows.push({ photoId: row.id, contentHash: row.contentHash, remoteBacked: await this.deps.remoteHas(row.contentHash) });
      }
    }
    return { orphanOriginals, orphanThumbs, orphanSidecars, stagedLeftovers, lyingRows };
  }

  /** Fix what is safe; report everything. */
  async repair(): Promise<RepairSummary> {
    const report = await this.scan();
    for (const hash of report.orphanOriginals) {
      await this.deps.blobs.deleteOriginal(hash);
      this.deps.audit(`REPAIR-ORPHAN-BLOB hash=${hash}`);
    }
    for (const hash of report.orphanThumbs) {
      await this.deps.blobs.deleteThumbs(hash);
      this.deps.audit(`REPAIR-ORPHAN-THUMBS hash=${hash}`);
    }
    for (const name of report.stagedLeftovers) {
      await this.deps.blobs.removeStaged(name);
      this.deps.audit(`REPAIR-STAGED name=${name}`);
    }
    // Orphaned companions repair per PHOTO directory: any orphan under a
    // photo with no owning rows at all means the whole set is debris.
    const orphanPhotoIds = new Set(report.orphanSidecars.map((label) => label.split(':')[0] ?? ''));
    const stillOwned = new Set((this.deps.ownedSidecars?.() ?? []).map((entry) => entry.photoId));
    for (const photoId of orphanPhotoIds) {
      if (photoId !== '' && !stillOwned.has(photoId)) {
        await this.deps.blobs.deleteSidecars?.(photoId);
        this.deps.audit(`REPAIR-ORPHAN-SIDECARS photo=${photoId}`);
      }
    }
    let repairedToOffloaded = 0;
    let markedError = 0;
    const changed: string[] = [];
    for (const row of report.lyingRows) {
      if (row.remoteBacked) {
        // The verified remote copy makes this an offload in disguise —
        // rehydrate-on-touch (#107) brings it back on demand.
        this.deps.setStatus(row.photoId, 'offloaded');
        this.deps.audit(`REPAIR-OFFLOADED photo=${row.photoId} hash=${row.contentHash}`);
        repairedToOffloaded += 1;
      } else {
        // No copy anywhere: never pretend. The red glyph surfaces it.
        this.deps.setStatus(row.photoId, 'error');
        this.deps.audit(`REPAIR-LOST photo=${row.photoId} hash=${row.contentHash}`);
        markedError += 1;
      }
      changed.push(row.photoId);
    }
    if (changed.length > 0) {
      this.deps.libraryChanged(changed);
    }
    return { ...report, repairedToOffloaded, markedError };
  }
}
