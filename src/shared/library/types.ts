// Library record shapes shared across processes (#69). Pure types — the
// renderer imports these for grid/list/inspector rendering; the repository
// and (later) the IPC service speak them natively.

import type { MediaInfo } from './media-info.js';
import type { PreviewFailureReason } from './preview.js';
import type { PhotoMetadataFields } from './photo-metadata.js';

// ADR-0026 §1: containers do not get kinds — an MP4, a MOV, a WebM, and an
// MPEG-TS are all `video`; their container × codec facts live in the probed
// MediaInfo record. `audio` covers signature-proven audio elementary streams.
// The three duplicate copies (this type, shared/ipc/channels.ts, and
// main/backup/backup-manifest.ts) plus the interop media-block subset move in
// lockstep — divergence is a defect (§1).
export type FileKind = 'jpeg' | 'raw' | 'png' | 'heic' | 'gif' | 'webp' | 'video' | 'audio' | 'other';

/** The still/animated-image kinds the signature sniffer and sharp derivative
 * chain handle directly. Kept explicit so adding container kinds (video/audio)
 * never silently widens an image-only code path. */
export type ImageFileKind = Extract<FileKind, 'jpeg' | 'png' | 'heic' | 'gif' | 'webp'>;

/** sync_ledger.status vocabulary (ADR-0005; 'error' added by #104). */
export type SyncStatus = 'local' | 'syncing' | 'synced' | 'offloaded' | 'error';

/** Local comparison between embedded metadata and a successful pixel decode. */
export type DimensionStatus = 'legacy' | 'verified' | 'metadata-mismatch' | 'unavailable';

export interface PhotoRecord extends PhotoMetadataFields {
  readonly id: string;
  readonly fileName: string;
  readonly fileKind: FileKind;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly contentHash: string;
  readonly camera: string | null;
  readonly lens: string | null;
  readonly iso: number | null;
  readonly aperture: string | null;
  readonly shutter: string | null;
  readonly focalLength: number | null;
  readonly takenAt: string | null;
  readonly gpsLat: number | null;
  readonly gpsLon: number | null;
  readonly place: string | null;
  readonly importedAt: string;
  readonly importSource: string;
  readonly favorite: boolean;
  /** User-declared preservation class; unrelated to RAW format or custody. */
  readonly isOriginal: boolean;
  readonly keyId: number;
  readonly deletedAt: string | null;
  /** Local derivative/display state; originals and backup manifests remain authoritative. */
  readonly previewFailure: PreviewFailureReason | null;
  /** Local integrity hint; metadata-mismatch means the original may have corrupt metadata. */
  readonly dimensionStatus: DimensionStatus;
  /** Probed container facts (ADR-0026 §1); null for kinds without them. */
  readonly mediaInfo: MediaInfo | null;
  /** From the sync_ledger join; new rows start 'local'. */
  readonly syncState: SyncStatus;
}

export type PhotoInsert = Omit<
  PhotoRecord,
  'favorite' | 'isOriginal' | 'deletedAt' | 'previewFailure' | 'dimensionStatus' | 'syncState' | 'mediaInfo' | keyof PhotoMetadataFields
> & {
  readonly favorite?: boolean;
  /** Optional like favorite: most kinds have no probed facts to record. */
  readonly mediaInfo?: MediaInfo | null | undefined;
  readonly title?: string | null | undefined;
  readonly description?: string | null | undefined;
  readonly userTags?: readonly string[] | undefined;
  readonly importedKeywords?: readonly string[] | undefined;
  readonly suppressedKeywords?: readonly string[] | undefined;
  readonly metadataVersion?: number | undefined;
};

/** The sidebar's library sources (design §Sidebar). */
export type SourceFilter = 'all' | 'favorites' | 'recent' | 'offloaded' | 'deleted';
export type LibraryMembershipChange = 'none' | 'favorite' | 'album' | 'library';

/** The grid's sort orders (#113): date newest-first, name A→Z, size
 * largest-first (decisions recorded on the PR). */
export type SortOrder = 'date' | 'name' | 'size';
export type SearchMode = 'auto' | 'keyword' | 'semantic';
export type AppliedSearchMode = 'keyword' | 'semantic' | 'fused';
export type SearchFallbackReason = 'disabled' | 'unavailable' | 'indexing' | 'busy' | 'error';

export interface PageCursor {
  /** The active ordering's sort expression at the last row of the previous
   * page — an ISO string (date), lowercased name, or byte count (size). */
  readonly sortKey: string | number;
  readonly id: string;
  /** Search continuations pin the projection that produced their rank key so
   * BM25 and reciprocal-rank scores are never interpreted as each other. */
  readonly search?:
    | {
        readonly appliedMode: AppliedSearchMode;
        readonly fallbackReason: SearchFallbackReason | null;
      }
    | undefined;
}

/** Toolbar filter chips (design §Toolbar) — AND-combined. */
export interface ChipFilters {
  readonly favorites?: boolean | undefined;
  readonly raw?: boolean | undefined;
  readonly offloaded?: boolean | undefined;
  readonly localOnly?: boolean | undefined;
}

/** The complete logical collection query shared by paging and Select All. */
export interface LibraryQuery {
  readonly source: SourceFilter;
  /** 'recent' cutoff (ISO); callers own the "recent" window policy. */
  readonly recentSince?: string | undefined;
  /** FTS5-ranked search over name/title/description/tags/place/camera, prefix-matched per token
   * (#390). Falls back to a case-insensitive substring match if the query
   * has no tokenizable content. */
  readonly query?: string | undefined;
  /** Auto fuses keyword and semantic candidates when the semantic index is ready. */
  readonly searchMode?: SearchMode | undefined;
  /** Selection requests pin the projection already shown by the grid. */
  readonly searchProjection?: AppliedSearchMode | undefined;
  readonly chips?: ChipFilters | undefined;
  /** Defaults to 'date' (newest first). */
  readonly order?: SortOrder | undefined;
  /** Restrict to one album's members (#117) — AND-combined with source. */
  readonly albumId?: string | undefined;
}

export interface PageRequest extends LibraryQuery {
  readonly limit: number;
  readonly cursor?: PageCursor | undefined;
}

export interface PageResult {
  readonly photos: readonly PhotoRecord[];
  readonly nextCursor: PageCursor | null;
  readonly search: {
    readonly requestedMode: SearchMode;
    readonly appliedMode: AppliedSearchMode;
    readonly fallbackReason: SearchFallbackReason | null;
    readonly indexed: number;
    readonly total: number;
  };
}

export interface SelectionRangeRequest {
  readonly source: SourceFilter;
  readonly anchorId: string;
  readonly targetId: string;
  readonly recentSince?: string | undefined;
  readonly query?: string | undefined;
  readonly searchMode?: SearchMode | undefined;
  readonly chips?: ChipFilters | undefined;
  readonly order?: SortOrder | undefined;
  readonly albumId?: string | undefined;
}

export interface SelectionRangeResult {
  readonly photoIds: readonly string[];
}

export type SourceCounts = Readonly<Record<SourceFilter, number>>;

/** Sidebar albums list (#80); CRUD arrives with M10. */
export interface AlbumSummary {
  readonly id: string;
  readonly name: string;
  readonly count: number;
}

export interface LibraryStats {
  readonly photos: number;
  readonly bytes: number;
  /** Dirty ledger rows — drives the backup button/status (#79). */
  readonly pending: number;
  /** Latest verified-backup stamp; null before the first backup (#104). */
  readonly lastBackupAt: string | null;
  /** Bytes whose originals live only in the cloud (#107). */
  readonly offloadedBytes: number;
}
