import { z } from 'zod';
import { activityEventTypes } from '../../shared/activity/types.js';
import type { ActivityEvent } from '../../shared/activity/types.js';

import { mediaInfoSchema } from '../../shared/library/media-info.js';
import { boardSchema } from '../../shared/moodboard/board.js';

export const BACKUP_MANIFEST_SCHEMA_VERSION = 6 as const;

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u, 'expected a Crockford ULID');
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, 'expected a lowercase SHA-256 digest');
const isoTimestampSchema = z.iso.datetime({ offset: true });
const photoTakenAtSchema = z.iso.datetime({ offset: true, local: true });
const keyIdSchema = z.number().int().positive();

const legacyPhotoSchema = z.strictObject({
  id: z.string().min(1),
  contentHash: sha256Schema,
  bytes: z.number().int().nonnegative(),
  fileName: z.string().min(1),
  keyId: keyIdSchema,
});

export const backupManifestV1Schema = z.strictObject({
  schema: z.literal(1),
  rows: z.array(legacyPhotoSchema).readonly(),
});

export const backupManifestPhotoV2Schema = z.strictObject({
  id: z.string().min(1),
  fileName: z.string().min(1),
  fileKind: z.enum(['jpeg', 'raw', 'png', 'heic', 'gif', 'webp', 'video', 'audio', 'other']),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  contentHash: sha256Schema,
  blobPath: z.string().min(1),
  // ADR-0026 §1 probed facts. OPTIONAL, not defaulted: sealed protected
  // metadata is verified by exact re-stringification, so parsing must not
  // insert keys into pre-0026 plaintext (a default would make every legacy
  // protected photo read as corrupt). Absent means "not probed"; consumers
  // normalize to null. Device-derived playability is deliberately NOT here
  // (ADR-0026 §3).
  mediaInfo: mediaInfoSchema.nullable().optional(),
  camera: z.string().nullable(),
  lens: z.string().nullable(),
  iso: z.number().int().positive().nullable(),
  aperture: z.string().nullable(),
  shutter: z.string().nullable(),
  focalLength: z.number().nonnegative().nullable(),
  takenAt: photoTakenAtSchema.nullable(),
  gpsLat: z.number().min(-90).max(90).nullable(),
  gpsLon: z.number().min(-180).max(180).nullable(),
  place: z.string().nullable(),
  importedAt: isoTimestampSchema,
  importSource: z.string().min(1),
  favorite: z.boolean(),
  // #482 adds preservation metadata compatibly to schemas 2–4. Absence in
  // older manifests means false; false remains omitted when rebuilding so
  // legacy restore equality checks stay byte-shape compatible.
  isOriginal: z.boolean().optional(),
  keyId: keyIdSchema,
  deletedAt: isoTimestampSchema.nullable(),
});

export const backupManifestAlbumV2Schema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: isoTimestampSchema,
  position: z.number().int().nonnegative(),
  photoIds: z.array(z.string().min(1)).readonly(),
});

export const backupManifestV2Schema = z
  .strictObject({
    schema: z.literal(2),
    libraryId: ulidSchema,
    databaseSchema: z.number().int().positive(),
    generatedAt: isoTimestampSchema,
    keyIds: z.array(keyIdSchema).readonly(),
    totals: z.strictObject({
      photos: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
      albums: z.number().int().nonnegative(),
    }),
    photos: z.array(backupManifestPhotoV2Schema).readonly(),
    albums: z.array(backupManifestAlbumV2Schema).readonly(),
  })
  .superRefine((manifest, context) => {
    const keyIds = new Set(manifest.keyIds);
    if (keyIds.size !== manifest.keyIds.length) {
      context.addIssue({ code: 'custom', path: ['keyIds'], message: 'key IDs must be unique' });
    }

    const photoIds = new Set<string>();
    let bytes = 0;
    for (const [index, photo] of manifest.photos.entries()) {
      if (photoIds.has(photo.id)) {
        context.addIssue({ code: 'custom', path: ['photos', index, 'id'], message: 'photo IDs must be unique' });
      }
      photoIds.add(photo.id);
      bytes += photo.bytes;
      if (!keyIds.has(photo.keyId)) {
        context.addIssue({ code: 'custom', path: ['photos', index, 'keyId'], message: 'photo key is missing from keyIds' });
      }
      const expectedPath = `blobs/${photo.contentHash.slice(0, 2)}/${photo.contentHash}`;
      if (photo.blobPath !== expectedPath) {
        context.addIssue({ code: 'custom', path: ['photos', index, 'blobPath'], message: 'blob path does not match the content hash' });
      }
    }

    const albumIds = new Set<string>();
    const albumPositions = new Set<number>();
    for (const [albumIndex, album] of manifest.albums.entries()) {
      if (albumIds.has(album.id)) {
        context.addIssue({ code: 'custom', path: ['albums', albumIndex, 'id'], message: 'album IDs must be unique' });
      }
      albumIds.add(album.id);
      if (albumPositions.has(album.position)) {
        context.addIssue({ code: 'custom', path: ['albums', albumIndex, 'position'], message: 'album positions must be unique' });
      }
      albumPositions.add(album.position);
      const members = new Set<string>();
      for (const [memberIndex, photoId] of album.photoIds.entries()) {
        if (!photoIds.has(photoId)) {
          context.addIssue({
            code: 'custom',
            path: ['albums', albumIndex, 'photoIds', memberIndex],
            message: 'album member is missing from photos',
          });
        }
        if (members.has(photoId)) {
          context.addIssue({
            code: 'custom',
            path: ['albums', albumIndex, 'photoIds', memberIndex],
            message: 'album members must be unique',
          });
        }
        members.add(photoId);
      }
    }

    if (manifest.totals.photos !== manifest.photos.length) {
      context.addIssue({ code: 'custom', path: ['totals', 'photos'], message: 'photo total does not match photos' });
    }
    if (manifest.totals.bytes !== bytes) {
      context.addIssue({ code: 'custom', path: ['totals', 'bytes'], message: 'byte total does not match photos' });
    }
    if (manifest.totals.albums !== manifest.albums.length) {
      context.addIssue({ code: 'custom', path: ['totals', 'albums'], message: 'album total does not match albums' });
    }
  });

const sealedRecordSchema = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u, 'expected base64');

export const protectedBackupAlbumV3Schema = z.strictObject({
  id: z.string().min(1),
  credentialGeneration: z.number().int().positive(),
  metadataGeneration: z.number().int().positive(),
  credentialRecord: sealedRecordSchema,
  sealedMetadata: sealedRecordSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export const protectedBackupObjectV3Schema = z.strictObject({
  kind: z.enum(['original', 'thumb', 'mid']),
  path: z.string().min(1),
  sha256: sha256Schema,
  bytes: z.number().int().nonnegative(),
  status: z.enum(['synced', 'offloaded']),
});

export const protectedBackupPhotoV3Schema = z.strictObject({
  id: z.string().min(1),
  albumId: z.string().min(1),
  blobRef: sha256Schema,
  sealedMetadata: sealedRecordSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  objects: z.array(protectedBackupObjectV3Schema).min(1).readonly(),
});

export const backupManifestV3Schema = z
  .strictObject({
    schema: z.literal(3),
    libraryId: ulidSchema,
    databaseSchema: z.number().int().positive(),
    generatedAt: isoTimestampSchema,
    keyIds: z.array(keyIdSchema).readonly(),
    totals: backupManifestV2Schema.shape.totals,
    photos: z.array(backupManifestPhotoV2Schema).readonly(),
    albums: z.array(backupManifestAlbumV2Schema).readonly(),
    protectedAlbums: z.array(protectedBackupAlbumV3Schema).readonly(),
    protectedPhotos: z.array(protectedBackupPhotoV3Schema).readonly(),
  })
  .superRefine((manifest, context) => {
    const ordinary = backupManifestV2Schema.safeParse({
      schema: 2,
      libraryId: manifest.libraryId,
      databaseSchema: manifest.databaseSchema,
      generatedAt: manifest.generatedAt,
      keyIds: manifest.keyIds,
      totals: manifest.totals,
      photos: manifest.photos,
      albums: manifest.albums,
    });
    if (!ordinary.success) {
      context.addIssue({ code: 'custom', message: `ordinary recovery records are inconsistent: ${z.prettifyError(ordinary.error)}` });
    }
    const albumIds = new Set<string>();
    for (const [index, album] of manifest.protectedAlbums.entries()) {
      if (albumIds.has(album.id))
        context.addIssue({ code: 'custom', path: ['protectedAlbums', index, 'id'], message: 'protected album IDs must be unique' });
      albumIds.add(album.id);
    }
    const photoIds = new Set<string>();
    const remotePaths = new Map<string, { readonly sha256: string; readonly bytes: number }>();
    for (const [photoIndex, photo] of manifest.protectedPhotos.entries()) {
      if (photoIds.has(photo.id)) {
        context.addIssue({ code: 'custom', path: ['protectedPhotos', photoIndex, 'id'], message: 'protected photo IDs must be unique' });
      }
      photoIds.add(photo.id);
      if (!albumIds.has(photo.albumId)) {
        context.addIssue({ code: 'custom', path: ['protectedPhotos', photoIndex, 'albumId'], message: 'protected album is missing' });
      }
      const kinds = new Set<string>();
      for (const [objectIndex, object] of photo.objects.entries()) {
        if (kinds.has(object.kind)) {
          context.addIssue({
            code: 'custom',
            path: ['protectedPhotos', photoIndex, 'objects', objectIndex, 'kind'],
            message: 'protected object kinds must be unique per photo',
          });
        }
        kinds.add(object.kind);
        const expectedPath = `protected/${photo.blobRef.slice(0, 2)}/${photo.blobRef}.${object.kind}`;
        if (object.path !== expectedPath) {
          context.addIssue({
            code: 'custom',
            path: ['protectedPhotos', photoIndex, 'objects', objectIndex, 'path'],
            message: 'protected object path does not match its opaque reference',
          });
        }
        const previous = remotePaths.get(object.path);
        if (previous !== undefined && (previous.sha256 !== object.sha256 || previous.bytes !== object.bytes)) {
          context.addIssue({
            code: 'custom',
            path: ['protectedPhotos', photoIndex, 'objects', objectIndex, 'path'],
            message: 'shared protected object claims must agree',
          });
        }
        remotePaths.set(object.path, object);
      }
      if (!kinds.has('original')) {
        context.addIssue({
          code: 'custom',
          path: ['protectedPhotos', photoIndex, 'objects'],
          message: 'protected photo requires an original',
        });
      }
    }
  });

const activityPayloadValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const backupActivityEventV4Schema = z.strictObject({
  sequence: z.number().int().positive(),
  eventId: z.string().min(1),
  operationId: z.string().min(1),
  eventType: z.enum(activityEventTypes),
  schemaVersion: z.literal(1),
  occurredAt: isoTimestampSchema,
  actorClass: z.enum(['local-user', 'system', 'interop-peer', 'recovery']),
  rootCorrelationId: z.string().min(1),
  causationEventId: z.string().nullable(),
  entityIds: z.array(z.string()).readonly(),
  outcome: z.enum(['succeeded', 'partial', 'failed']),
  payload: z.record(z.string(), activityPayloadValueSchema).readonly(),
  supersedesEventId: z.string().nullable(),
});

export const backupManifestV4Schema = z
  .strictObject({
    ...backupManifestV3Schema.shape,
    schema: z.literal(4),
    activity: z.array(backupActivityEventV4Schema).readonly(),
  })
  .superRefine((manifest, context) => {
    const { activity: _activity, ...withoutActivity } = manifest;
    const previous = backupManifestV3Schema.safeParse({ ...withoutActivity, schema: 3 });
    if (!previous.success) {
      context.addIssue({ code: 'custom', message: `schema-3 records are inconsistent: ${z.prettifyError(previous.error)}` });
    }
    let priorSequence = 0;
    const eventIds = new Set<string>();
    for (const [index, event] of manifest.activity.entries()) {
      if (event.sequence <= priorSequence) {
        context.addIssue({ code: 'custom', path: ['activity', index, 'sequence'], message: 'activity sequence must increase' });
      }
      if (eventIds.has(event.eventId)) {
        context.addIssue({ code: 'custom', path: ['activity', index, 'eventId'], message: 'activity event IDs must be unique' });
      }
      priorSequence = event.sequence;
      eventIds.add(event.eventId);
    }
  });

// Moodboard boards (#701): album-class organizational metadata carried in the
// manifest with their ordering/identity, so a restore reproduces the exact
// board layouts (invariant I2 across backup/restore).
export const backupManifestBoardV5Schema = boardSchema.extend({
  position: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
});

export const backupManifestV5Schema = z
  .strictObject({
    ...backupManifestV4Schema.shape,
    schema: z.literal(5),
    boards: z.array(backupManifestBoardV5Schema).readonly(),
  })
  .superRefine((manifest, context) => {
    const { boards, ...withoutBoards } = manifest;
    const previous = backupManifestV4Schema.safeParse({ ...withoutBoards, schema: 4 });
    if (!previous.success) {
      context.addIssue({ code: 'custom', message: `schema-4 records are inconsistent: ${z.prettifyError(previous.error)}` });
    }
    const ids = new Set<string>();
    const positions = new Set<number>();
    for (const [index, board] of boards.entries()) {
      if (ids.has(board.id)) context.addIssue({ code: 'custom', path: ['boards', index, 'id'], message: 'board IDs must be unique' });
      if (positions.has(board.position)) {
        context.addIssue({ code: 'custom', path: ['boards', index, 'position'], message: 'board positions must be unique' });
      }
      ids.add(board.id);
      positions.add(board.position);
    }
  });

// Encrypted sidecar custody (#484, ADR-0031 §7): manifests include every
// companion object so restore rebuilds byte-identical sidecars. Objects live
// at sidecars/<photoId>/<hash>; sha256/bytes describe the CIPHERTEXT (like
// protected objects — verify-after-upload has no plaintext catalog hash for
// the envelope itself; the plaintext hash IS `hash`).
export const backupManifestSidecarV6Schema = z.strictObject({
  photoId: z.string().min(1),
  role: z.enum(['xmp', 'aae']),
  fileName: z.string().min(1),
  hash: z.string().regex(/^[0-9a-f]{64}$/u),
  bytes: z.number().int().nonnegative(),
  keyId: z.number().int().positive(),
  blobPath: z.string().min(1),
  ciphertext: z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/u), bytes: z.number().int().positive() }),
});

export const backupManifestV6Schema = z
  .strictObject({
    ...backupManifestV5Schema.shape,
    schema: z.literal(BACKUP_MANIFEST_SCHEMA_VERSION),
    sidecars: z.array(backupManifestSidecarV6Schema).readonly(),
  })
  .superRefine((manifest, context) => {
    const { sidecars, ...withoutSidecars } = manifest;
    const previous = backupManifestV5Schema.safeParse({ ...withoutSidecars, schema: 5 });
    if (!previous.success) {
      context.addIssue({ code: 'custom', message: `schema-5 records are inconsistent: ${z.prettifyError(previous.error)}` });
    }
    const photoIds = new Set(manifest.photos.map((photo) => photo.id));
    const seen = new Set<string>();
    for (const [index, sidecar] of sidecars.entries()) {
      if (!photoIds.has(sidecar.photoId)) {
        context.addIssue({
          code: 'custom',
          path: ['sidecars', index, 'photoId'],
          message: 'sidecar references a photo not in the manifest',
        });
      }
      const key = `${sidecar.photoId}:${sidecar.hash}`;
      if (seen.has(key)) {
        context.addIssue({ code: 'custom', path: ['sidecars', index], message: 'duplicate sidecar object' });
      }
      seen.add(key);
      if (sidecar.blobPath !== `sidecars/${sidecar.photoId}/${sidecar.hash}`) {
        context.addIssue({
          code: 'custom',
          path: ['sidecars', index, 'blobPath'],
          message: 'sidecar blobPath must derive from photoId and hash',
        });
      }
    }
  });

export type BackupManifestV1 = z.infer<typeof backupManifestV1Schema>;
export type BackupManifestPhotoV2 = z.infer<typeof backupManifestPhotoV2Schema>;
export type BackupManifestAlbumV2 = z.infer<typeof backupManifestAlbumV2Schema>;
export type BackupManifestV2 = z.infer<typeof backupManifestV2Schema>;
export type ProtectedBackupAlbumV3 = z.infer<typeof protectedBackupAlbumV3Schema>;
export type ProtectedBackupObjectV3 = z.infer<typeof protectedBackupObjectV3Schema>;
export type ProtectedBackupPhotoV3 = z.infer<typeof protectedBackupPhotoV3Schema>;
export type BackupManifestV3 = z.infer<typeof backupManifestV3Schema>;
export type BackupManifestV4 = z.infer<typeof backupManifestV4Schema>;
export type BackupManifestBoardV5 = z.infer<typeof backupManifestBoardV5Schema>;
export type BackupManifestV5 = z.infer<typeof backupManifestV5Schema>;
export type BackupManifestSidecarV6 = z.infer<typeof backupManifestSidecarV6Schema>;
export type BackupManifestV6 = z.infer<typeof backupManifestV6Schema>;
export type RestorableBackupManifest = BackupManifestV2 | BackupManifestV3 | BackupManifestV4 | BackupManifestV5 | BackupManifestV6;

export interface BackupManifestSnapshot {
  readonly databaseSchema: number;
  readonly keyIds: readonly number[];
  readonly totals: BackupManifestV2['totals'];
  readonly photos: readonly BackupManifestPhotoV2[];
  readonly albums: readonly BackupManifestAlbumV2[];
}

export interface BackupManifestSnapshotV3 extends BackupManifestSnapshot {
  readonly protectedAlbums: readonly ProtectedBackupAlbumV3[];
  readonly protectedPhotos: readonly ProtectedBackupPhotoV3[];
}

export interface BackupManifestSnapshotV4 extends BackupManifestSnapshotV3 {
  readonly activity: readonly ActivityEvent[];
}

export interface BackupManifestSnapshotV5 extends BackupManifestSnapshotV4 {
  readonly boards: readonly BackupManifestBoardV5[];
}

export interface BackupManifestSnapshotV6 extends BackupManifestSnapshotV5 {
  readonly sidecars: readonly BackupManifestSidecarV6[];
}

export type ParsedBackupManifest =
  | { readonly restorable: false; readonly manifest: BackupManifestV1 }
  | { readonly restorable: true; readonly manifest: RestorableBackupManifest };

export class BackupManifestError extends Error {
  override readonly name = 'BackupManifestError';
}

export function buildBackupManifestV2(input: {
  readonly libraryId: string;
  readonly generatedAt: string;
  readonly snapshot: BackupManifestSnapshot;
}): BackupManifestV2 {
  return backupManifestV2Schema.parse({
    schema: 2,
    libraryId: input.libraryId,
    generatedAt: input.generatedAt,
    ...input.snapshot,
  });
}

export function buildBackupManifestV4(input: {
  readonly libraryId: string;
  readonly generatedAt: string;
  readonly snapshot: BackupManifestSnapshotV4;
}): BackupManifestV4 {
  return backupManifestV4Schema.parse({
    schema: 4,
    libraryId: input.libraryId,
    generatedAt: input.generatedAt,
    ...input.snapshot,
  });
}

export function buildBackupManifestV5(input: {
  readonly libraryId: string;
  readonly generatedAt: string;
  readonly snapshot: BackupManifestSnapshotV5;
}): BackupManifestV5 {
  return backupManifestV5Schema.parse({
    schema: 5,
    libraryId: input.libraryId,
    generatedAt: input.generatedAt,
    ...input.snapshot,
  });
}

export function buildBackupManifestV6(input: {
  readonly libraryId: string;
  readonly generatedAt: string;
  readonly snapshot: BackupManifestSnapshotV6;
}): BackupManifestV6 {
  return backupManifestV6Schema.parse({
    schema: BACKUP_MANIFEST_SCHEMA_VERSION,
    libraryId: input.libraryId,
    generatedAt: input.generatedAt,
    ...input.snapshot,
  });
}

export function parseBackupManifest(input: unknown): ParsedBackupManifest {
  const version = z.object({ schema: z.number().int() }).safeParse(input);
  if (!version.success) {
    throw new BackupManifestError('manifest is missing a numeric schema version');
  }
  if (version.data.schema === 1) {
    const parsed = backupManifestV1Schema.safeParse(input);
    if (!parsed.success) {
      throw new BackupManifestError(`invalid schema-1 manifest: ${z.prettifyError(parsed.error)}`);
    }
    return { restorable: false, manifest: parsed.data };
  }
  if (version.data.schema === 2) {
    const parsed = backupManifestV2Schema.safeParse(input);
    if (!parsed.success) {
      throw new BackupManifestError(`invalid schema-2 manifest: ${z.prettifyError(parsed.error)}`);
    }
    return { restorable: true, manifest: parsed.data };
  }
  if (version.data.schema === 3) {
    const parsed = backupManifestV3Schema.safeParse(input);
    if (!parsed.success) {
      throw new BackupManifestError(`invalid schema-3 manifest: ${z.prettifyError(parsed.error)}`);
    }
    return { restorable: true, manifest: parsed.data };
  }
  if (version.data.schema === 4) {
    const parsed = backupManifestV4Schema.safeParse(input);
    if (!parsed.success) {
      throw new BackupManifestError(`invalid schema-4 manifest: ${z.prettifyError(parsed.error)}`);
    }
    return { restorable: true, manifest: parsed.data };
  }
  if (version.data.schema === 5) {
    const parsed = backupManifestV5Schema.safeParse(input);
    if (!parsed.success) {
      throw new BackupManifestError(`invalid schema-5 manifest: ${z.prettifyError(parsed.error)}`);
    }
    return { restorable: true, manifest: parsed.data };
  }
  if (version.data.schema === BACKUP_MANIFEST_SCHEMA_VERSION) {
    const parsed = backupManifestV6Schema.safeParse(input);
    if (!parsed.success) {
      throw new BackupManifestError(`invalid schema-6 manifest: ${z.prettifyError(parsed.error)}`);
    }
    return { restorable: true, manifest: parsed.data };
  }
  throw new BackupManifestError(`unsupported manifest schema ${String(version.data.schema)}`);
}
