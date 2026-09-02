import { z } from 'zod';

import { mediaInfoSchema } from '../../shared/library/media-info.js';
import { photoDescriptionSchema, photoTagsSchema, photoTitleSchema } from '../../shared/library/photo-metadata.js';

// The per-photo and per-album manifest records plus the primitive schemas the
// manifest ledger (backup-manifest.ts) composes. Split out so that ledger
// stays a ledger of schema versions; consumers keep importing from it.

export const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u, 'expected a Crockford ULID');
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, 'expected a lowercase SHA-256 digest');
export const isoTimestampSchema = z.iso.datetime({ offset: true });
export const photoTakenAtSchema = z.iso.datetime({ offset: true, local: true });
export const keyIdSchema = z.number().int().positive();

export const legacyPhotoSchema = z.strictObject({
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
  // protected photo read as corrupt). Absent means "not probed";
  // upgradeLegacyManifest normalizes it to null for restore consumers.
  // Device-derived playability is deliberately NOT here (ADR-0026 §3).
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
  title: photoTitleSchema.nullable().optional(),
  description: photoDescriptionSchema.nullable().optional(),
  userTags: photoTagsSchema.readonly().optional(),
  importedKeywords: photoTagsSchema.readonly().optional(),
  suppressedKeywords: photoTagsSchema.readonly().optional(),
  metadataVersion: z.number().int().positive().optional(),
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

// Schema 13 (#496, ADR-0031 §1): where the variant's derivatives live and
// which variant it was duplicated from. Both are omitted when default (the
// content hash; an import), so a root variant's record is byte-identical to
// its schema-12 shape.
export const backupManifestPhotoV13Schema = backupManifestPhotoV2Schema.extend({
  derivativeKey: sha256Schema.optional(),
  variantSourceId: z.string().min(1).nullable().optional(),
  assetOwnerId: z.string().min(1).nullable().optional(),
});
